import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { sql } from 'kysely';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { App } from '../app.js';
import type { Actor, Channel, RequestMeta } from '../core/operation.js';
import { AppError, UnauthorizedError, ValidationError } from '../core/errors.js';
import { createSession, destroySession, isActiveUser, resolveApiToken, resolveSession, userToActor } from '../auth/identity.js';
import { verifyPassword } from '../auth/passwords.js';
import { OidcProvider } from '../auth/oidc.js';
import { newId, nowIso, safeEqual } from '../lib/util.js';
import { getSettings } from '../ops/shared.js';
import type { FileResult } from '../ops/exports.js';
import { buildMcpServer } from '../mcp/server.js';
import { API_PREFIX, buildOpenApi, pathParams, renderApiDocs } from './openapi.js';
import { VERSION } from '../version.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    authVia: 'session' | 'token' | null;
    csrfToken: string | null;
  }
}

const SESSION_COOKIE = 'sl_session';
const OIDC_COOKIE = 'sl_oidc';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildServer(app: App): Promise<FastifyInstance> {
  const { config, executor } = app;
  const db = app.database.db;
  // Secure cookies / HSTS follow the public URL's scheme; without one, production assumes TLS termination upstream.
  const secureCookies = config.PUBLIC_URL ? config.PUBLIC_URL.startsWith('https://') : config.isProduction;
  const oidc = config.oidcEnabled ? new OidcProvider(config) : null;

  const server = Fastify({
    loggerInstance: app.log as unknown as FastifyBaseLogger,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,100}$/.test(incoming) ? incoming : newId();
    },
  });

  server.decorateRequest('actor', null);
  server.decorateRequest('authVia', null);
  server.decorateRequest('csrfToken', null);

  await server.register(cookie, { secret: config.sessionSecret });
  await server.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'", 'data:'],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': secureCookies ? [] : null,
      },
    },
    hsts: secureCookies ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  if (config.CORS_ORIGINS.length) {
    await server.register(cors, {
      origin: config.CORS_ORIGINS,
      credentials: true,
      allowedHeaders: ['authorization', 'content-type', 'x-csrf-token', 'x-request-id', 'mcp-session-id', 'mcp-protocol-version'],
      exposedHeaders: ['x-request-id', 'content-disposition', 'mcp-session-id'],
    });
  }
  await server.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.actor?.id ? `u:${req.actor.id}` : `ip:${req.ip}`),
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });

  server.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) reply.header('cache-control', 'no-store');
  });

  // ------------------------------------------------------------ authentication
  // Resolves the caller once per request; the executor does all authorization.
  server.addHook('onRequest', async (req) => {
    const auth = req.headers.authorization;
    if (auth?.toLowerCase().startsWith('bearer ')) {
      const actor = await resolveApiToken(db, auth.slice(7).trim());
      if (!actor) throw new UnauthorizedError('Invalid, expired or revoked API token');
      req.actor = actor;
      req.authVia = 'token';
      return;
    }
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const session = await resolveSession(db, unsigned.value, config.SESSION_IDLE_MINUTES);
        if (session) {
          req.actor = userToActor(session.user);
          req.authVia = 'session';
          req.csrfToken = session.csrfToken;
        }
      }
    }
  });

  /** Cookie-authenticated writes must echo the CSRF token (double-submit via header). */
  const assertCsrf = (req: FastifyRequest) => {
    if (req.authVia !== 'session' || !MUTATING.has(req.method)) return;
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !req.csrfToken || !safeEqual(header, req.csrfToken)) {
      throw new AppError('csrf_failed', 'Missing or invalid CSRF token', 403);
    }
  };

  const meta = (req: FastifyRequest, channel: Channel): RequestMeta => ({
    channel,
    requestId: req.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  server.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      if (err.status === 401 && req.url.startsWith('/mcp')) reply.header('www-authenticate', 'Bearer realm="streamline"');
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests, slow down', requestId: req.id } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong', requestId: req.id } });
  });

  // ------------------------------------------------------------ health
  server.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  server.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: 'ready', version: VERSION, database: app.database.dialect };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  // ------------------------------------------------------------ auth routes
  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      signed: true,
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });

  const auditAuth = async (req: FastifyRequest, operation: string, outcome: 'success' | 'denied', user: { id: string | null; label: string }, detail?: object) => {
    await db
      .insertInto('audit_log')
      .values({
        id: newId(),
        at: nowIso(),
        actor_id: user.id,
        actor_label: user.label,
        channel: 'ui',
        operation,
        target_type: 'user',
        target_id: user.id,
        outcome,
        detail: detail ? JSON.stringify(detail) : null,
        ip: req.ip,
        request_id: req.id,
      })
      .execute();
  };

  server.get(`${API_PREFIX}/auth/config`, async () => {
    const settings = await getSettings(db);
    return {
      organizationName: settings.organizationName,
      loginBanner: settings.loginBanner,
      localEnabled: config.LOCAL_AUTH_ENABLED,
      oidc: oidc ? { enabled: true, displayName: config.OIDC_DISPLAY_NAME, startUrl: `${API_PREFIX}/auth/oidc/start` } : { enabled: false },
      version: VERSION,
    };
  });

  server.get(`${API_PREFIX}/auth/session`, async (req) => {
    if (!req.actor) return { authenticated: false };
    const me = await executor.execute('me.get', {}, req.actor, meta(req, req.authVia === 'token' ? 'api' : 'ui'));
    return { authenticated: true, user: me, csrfToken: req.csrfToken };
  });

  server.post(
    `${API_PREFIX}/auth/login`,
    { config: { rateLimit: { max: config.RATE_LIMIT_LOGIN_MAX, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `login:${req.ip}` } } },
    async (req, reply) => {
      if (!config.LOCAL_AUTH_ENABLED) throw new AppError('local_auth_disabled', 'Password sign-in is disabled; use single sign-on', 400);
      const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
      if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length > 256) {
        throw new ValidationError('Email and password are required');
      }
      const email = body.email.trim().toLowerCase();
      const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
      const generic = new AppError('invalid_credentials', 'Invalid email or password', 401);

      if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        await verifyPassword(body.password, null);
        await auditAuth(req, 'auth.login', 'denied', { id: user.id, label: user.email }, { reason: 'locked' });
        throw new AppError('account_locked', 'Account temporarily locked after repeated failed sign-ins. Try again later.', 423);
      }
      const ok =
        user && user.kind === 'human' && user.auth_provider === 'local' && user.status === 'active'
          ? await verifyPassword(body.password, user.password_hash)
          : await verifyPassword(body.password, null);
      if (!ok || !user) {
        if (user) {
          const failures = user.failed_logins + 1;
          const lock = failures >= config.LOGIN_MAX_FAILURES;
          await db
            .updateTable('users')
            .set({ failed_logins: lock ? 0 : failures, locked_until: lock ? new Date(Date.now() + config.LOGIN_LOCKOUT_MINUTES * 60_000).toISOString() : null })
            .where('id', '=', user.id)
            .execute();
          await auditAuth(req, 'auth.login', 'denied', { id: user.id, label: user.email }, { reason: 'bad_password', locked: lock });
        } else {
          await auditAuth(req, 'auth.login', 'denied', { id: null, label: email.slice(0, 200) }, { reason: 'unknown_user' });
        }
        throw generic;
      }
      await db.updateTable('users').set({ failed_logins: 0, locked_until: null, last_login_at: nowIso() }).where('id', '=', user.id).execute();
      const session = await createSession(db, user.id, config.SESSION_TTL_HOURS, { ip: req.ip, userAgent: req.headers['user-agent'] });
      setSessionCookie(reply, session.token);
      await auditAuth(req, 'auth.login', 'success', { id: user.id, label: `${user.name} <${user.email}>` });
      const me = await executor.execute('me.get', {}, userToActor(user), meta(req, 'ui'));
      return { authenticated: true, user: me, csrfToken: session.csrfToken };
    },
  );

  server.post(`${API_PREFIX}/auth/logout`, async (req, reply) => {
    if (req.authVia === 'session') assertCsrf(req);
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) await destroySession(db, unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { authenticated: false };
  });

  if (oidc) {
    server.get(`${API_PREFIX}/auth/oidc/start`, async (_req, reply) => {
      const { url, state, nonce, verifier } = await oidc.start();
      reply.setCookie(OIDC_COOKIE, JSON.stringify({ state, nonce, verifier }), {
        path: `${API_PREFIX}/auth/oidc`,
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        signed: true,
        maxAge: 600,
      });
      return reply.redirect(url);
    });

    server.get(`${API_PREFIX}/auth/oidc/callback`, async (req, reply) => {
      const raw = req.cookies[OIDC_COOKIE];
      const unsigned = raw ? req.unsignCookie(raw) : { valid: false, value: null };
      reply.clearCookie(OIDC_COOKIE, { path: `${API_PREFIX}/auth/oidc` });
      if (!unsigned.valid || !unsigned.value) return reply.redirect('/login?error=sso_expired');
      try {
        const expected = JSON.parse(unsigned.value) as { state: string; nonce: string; verifier: string };
        const current = new URL(req.url, config.PUBLIC_URL);
        const profile = await oidc.callback(current, expected);
        const user = await oidc.upsertUser(db, profile);
        if (!isActiveUser(user)) throw new AppError('account_disabled', 'Account disabled', 403);
        const session = await createSession(db, user.id, config.SESSION_TTL_HOURS, { ip: req.ip, userAgent: req.headers['user-agent'] });
        setSessionCookie(reply, session.token);
        await auditAuth(req, 'auth.sso', 'success', { id: user.id, label: `${user.name} <${user.email}>` });
        return reply.redirect('/');
      } catch (err) {
        req.log.warn({ err }, 'SSO sign-in failed');
        await auditAuth(req, 'auth.sso', 'denied', { id: null, label: 'sso' }, { reason: (err as Error).message?.slice(0, 200) });
        const code = err instanceof AppError ? err.code : 'sso_failed';
        return reply.redirect(`/login?error=${encodeURIComponent(code)}`);
      }
    });
  }

  // ------------------------------------------------------------ REST API (generated)
  for (const op of executor.list()) {
    const params = pathParams(op.http.path);
    server.route({
      method: op.http.method,
      url: API_PREFIX + op.http.path,
      handler: async (req, reply) => {
        assertCsrf(req);
        const query = (req.query ?? {}) as Record<string, unknown>;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
        const input: Record<string, unknown> = op.http.method === 'GET' || op.http.method === 'DELETE' ? { ...body, ...query } : { ...query, ...body };
        const p = req.params as Record<string, string>;
        for (const name of params) input[name] = p[name];
        const channel: Channel = req.authVia === 'session' ? 'ui' : 'api';
        const result = await executor.execute(op.name, input, req.actor, meta(req, channel));
        if (op.file) {
          const f = result as FileResult;
          return reply
            .header('content-type', `${f.contentType}; charset=utf-8`)
            .header('content-disposition', `attachment; filename="${f.filename.replace(/[^\w.-]/g, '_')}"`)
            .send(f.content);
        }
        if (op.kind !== 'read' && op.name.endsWith('.create')) reply.status(201);
        return result;
      },
    });
  }

  const openapi = buildOpenApi(executor.list(), { version: VERSION, serverUrl: config.PUBLIC_URL });
  server.get(`${API_PREFIX}/openapi.json`, async () => openapi);
  if (config.API_DOCS_ENABLED) {
    const html = renderApiDocs(executor.list(), VERSION);
    server.get('/api/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').send(html));
  }

  // ------------------------------------------------------------ MCP (Streamable HTTP, stateless)
  if (config.MCP_ENABLED) {
    server.post('/mcp', async (req, reply) => {
      if (req.authVia !== 'token' || !req.actor) {
        reply.header('www-authenticate', 'Bearer realm="streamline"');
        throw new UnauthorizedError('MCP requires an API token: Authorization: Bearer slt_…');
      }
      const mcp = buildMcpServer(executor, req.actor, { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.setHeader('x-request-id', req.id);
      reply.raw.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    });
    const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
    server.get('/mcp', notAllowed);
    server.delete('/mcp', notAllowed);
  }

  // ------------------------------------------------------------ web UI
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = [config.WEB_DIST_DIR, join(here, '../../public'), join(here, '../../../web/dist')]
    .filter((d): d is string => Boolean(d))
    .map((d) => resolve(d))
    .find((d) => existsSync(join(d, 'index.html')));
  if (webDir) {
    await server.register(fastifyStatic, { root: webDir, wildcard: false, index: false, maxAge: '1h', immutable: false });
    const sendIndex = (reply: FastifyReply) => reply.header('cache-control', 'no-cache').sendFile('index.html');
    server.get('/', (_req, reply) => sendIndex(reply));
    server.get('/assets/*', (req, reply) => reply.header('cache-control', 'public, max-age=31536000, immutable').sendFile((req.url.split('?')[0]).slice(1)));
    server.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/mcp')) {
        const file = req.url.split('?')[0].slice(1);
        if (file && !file.includes('..') && existsSync(join(webDir, file))) return reply.sendFile(file);
        return sendIndex(reply);
      }
      return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found`, requestId: req.id } });
    });
  } else {
    server.setNotFoundHandler((req, reply) =>
      reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found`, requestId: req.id } }),
    );
    server.get('/', async () => ({ name: 'Streamline API', version: VERSION, docs: '/api/docs', openapi: `${API_PREFIX}/openapi.json`, mcp: '/mcp', note: 'Web UI not built' }));
  }

  return server;
}

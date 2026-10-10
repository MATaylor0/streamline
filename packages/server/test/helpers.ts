import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { buildServer } from '../src/http/server.js';
import { SYSTEM_ACTOR, type Actor, type Channel } from '../src/core/operation.js';
import { resolveApiToken } from '../src/auth/identity.js';
import type { Role } from '../src/core/permissions.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'Admin-Password-123';

/**
 * Creates an isolated app. Uses in-memory SQLite by default; set
 * TEST_DATABASE_URL=postgres://… to run the same suite against PostgreSQL
 * (a throwaway database is created per test file).
 */
export async function createTestApp(env: Record<string, string> = {}) {
  let url = 'sqlite::memory:';
  let dropDb: (() => Promise<void>) | undefined;
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) {
    const pg = (await import('pg')).default;
    const name = `sl_test_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: pgUrl });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const u = new URL(pgUrl);
    u.pathname = `/${name}`;
    url = u.toString();
    dropDb = async () => {
      const c = new pg.Client({ connectionString: pgUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    };
  }
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    LOG_LEVEL: 'silent',
    BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    RATE_LIMIT_MAX: '100000',
    ...env,
  } as NodeJS.ProcessEnv);
  const app = await createApp(config);
  const server = await buildServer(app);
  await server.ready();
  return new TestContext(app, server, async () => {
    await server.close();
    await app.close();
    await dropDb?.();
  });
}

export class TestContext {
  constructor(
    public app: App,
    public server: FastifyInstance,
    public close: () => Promise<void>,
  ) {}

  /** Run an operation through the executor (the "system path"). */
  run<T = any>(op: string, input: unknown, actor: Actor = SYSTEM_ACTOR, channel: Channel = 'cli'): Promise<T> {
    return this.app.executor.execute<T>(op, input, actor, { channel });
  }

  /** Create a user with the given role and return an API token + resolved actor. */
  async user(role: Role, opts: { scope?: 'read' | 'write'; kind?: 'human' | 'service'; email?: string } = {}) {
    const email = opts.email ?? `${role}-${randomBytes(3).toString('hex')}@example.com`;
    const password = 'Test-Password-123';
    const u = await this.run<{ id: string }>('user.create', { email, name: `${role} user`, role, kind: opts.kind ?? 'human', password: opts.kind === 'service' ? undefined : password });
    const t = await this.run<{ token: string }>('token.create', { name: 't', scope: opts.scope ?? 'write', userId: u.id });
    const actor = (await resolveApiToken(this.app.database.db, t.token))!;
    return { id: u.id, email, password, token: t.token, actor };
  }

  async login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
    const res = await this.server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const cookie = res.cookies.find((c) => c.name === 'sl_session')!;
    return { cookie: `sl_session=${cookie.value}`, csrf: res.json().csrfToken as string };
  }

  api(token: string) {
    const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
      const res = await this.server.inject({ method, url: `/api/v1${url}`, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
      return { status: res.statusCode, body: res.body ? safeJson(res.body) : null, headers: res.headers };
    };
    return call;
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const simpleDiagram = (teams: { a: string; b: string }) => ({
  nodes: [
    { id: 's', type: 'start', label: 'Start', teamId: teams.a },
    { id: 't1', type: 'task', label: 'Prepare request', teamId: teams.a },
    { id: 'd', type: 'decision', label: 'Approved?' },
    { id: 't2', type: 'task', label: 'Fulfil request', teamId: teams.b },
    { id: 'e', type: 'end', label: 'Done', teamId: teams.b },
  ],
  edges: [
    { source: 's', target: 't1' },
    { source: 't1', target: 'd' },
    { source: 'd', target: 't2', label: 'Yes' },
    { source: 'd', target: 't1', label: 'No' },
    { source: 't2', target: 'e' },
  ],
});

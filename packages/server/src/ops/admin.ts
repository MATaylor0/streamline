import { z } from 'zod';
import { defineOp, type OpContext } from '../core/operation.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../core/errors.js';
import { PERMISSIONS, ROLES, ROLE_DESCRIPTIONS, ROLE_PERMISSIONS, type Role } from '../core/permissions.js';
import { can } from '../core/executor.js';
import type { DB, UserRow } from '../db/schema.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/passwords.js';
import { destroyUserSessions, generateApiToken } from '../auth/identity.js';
import { likeEscape, newId, nowIso, parseJson, randomToken } from '../lib/util.js';
import { sql } from 'kysely';
import { Id, Pagination, SettingsSchema, getSettings } from './shared.js';
import { assertSafeWebhookUrl, WEBHOOK_EVENTS_HELP, deliverTest } from '../webhooks.js';

const GA = 'Administration';
const GS = 'My account';

function userDto(u: UserRow, teams: Array<{ id: string; name: string; role: string }> = []) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as Role,
    kind: u.kind,
    status: u.status,
    authProvider: u.auth_provider,
    lastLoginAt: u.last_login_at,
    lockedUntil: u.locked_until,
    createdAt: u.created_at,
    teams,
  };
}

async function userTeams(db: DB, userIds: string[]) {
  if (!userIds.length) return [];
  return db
    .selectFrom('team_members')
    .innerJoin('teams', 'teams.id', 'team_members.team_id')
    .select(['team_members.user_id', 'teams.id', 'teams.name', 'team_members.role'])
    .where('team_members.user_id', 'in', userIds)
    .execute();
}

async function loadUser(db: DB, id: string) {
  const u = await db.selectFrom('users').selectAll().where((eb) => eb.or([eb('id', '=', id), eb('email', '=', id.toLowerCase())])).executeTakeFirst();
  if (!u) throw new NotFoundError('User', id);
  return u;
}

async function adminCount(db: DB, excludeId: string) {
  const row = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('role', '=', 'admin')
    .where('status', '=', 'active')
    .where('kind', '=', 'human')
    .where('id', '!=', excludeId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

// =================================================================== self

export const whoami = defineOp({
  name: 'me.get',
  group: GS,
  summary: 'Who am I? Returns the current identity, role, permissions and teams',
  permission: null,
  kind: 'read',
  http: { method: 'GET', path: '/me' },
  input: z.object({}),
  handler: async (ctx) => {
    const permissions = (Object.keys(PERMISSIONS) as Array<keyof typeof PERMISSIONS>).filter((p) => can(ctx.actor, p));
    const settings = await getSettings(ctx.db);
    if (!ctx.actor.id) {
      return { id: null, email: ctx.actor.email, name: ctx.actor.name, role: ctx.actor.role, kind: 'system', permissions, teams: [], tokenScope: null, organizationName: settings.organizationName };
    }
    const u = await loadUser(ctx.db, ctx.actor.id);
    const teams = (await userTeams(ctx.db, [u.id])).map(({ user_id: _u, ...t }) => t);
    return { ...userDto(u, teams), permissions, tokenScope: ctx.actor.tokenScope ?? null, organizationName: settings.organizationName };
  },
});

export const updateProfile = defineOp({
  name: 'me.update',
  group: GS,
  summary: 'Update my display name',
  permission: 'self:manage',
  kind: 'write',
  http: { method: 'PATCH', path: '/me' },
  targetType: 'user',
  input: z.object({ name: z.string().min(1).max(200) }),
  handler: async (ctx, input) => {
    if (!ctx.actor.id) throw new ValidationError('System actor has no profile');
    ctx.target.id = ctx.actor.id;
    await ctx.db.updateTable('users').set({ name: input.name, updated_at: nowIso() }).where('id', '=', ctx.actor.id).execute();
    return userDto(await loadUser(ctx.db, ctx.actor.id));
  },
});

export const changePassword = defineOp({
  name: 'me.changePassword',
  group: GS,
  summary: 'Change my password',
  permission: 'self:manage',
  kind: 'write',
  http: { method: 'POST', path: '/me/password' },
  targetType: 'user',
  mcp: false,
  input: z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }),
  handler: async (ctx, input) => {
    if (!ctx.actor.id || ctx.actor.tokenId) throw new ForbiddenError('Passwords can only be changed from an interactive session');
    const u = await loadUser(ctx.db, ctx.actor.id);
    ctx.target.id = u.id;
    if (u.auth_provider !== 'local') throw new ValidationError('Your account signs in with single sign-on');
    if (!(await verifyPassword(input.currentPassword, u.password_hash))) throw new ValidationError('Current password is incorrect');
    const problem = checkPasswordPolicy(input.newPassword, ctx.services.config.PASSWORD_MIN_LENGTH);
    if (problem) throw new ValidationError(problem);
    await ctx.db.updateTable('users').set({ password_hash: await hashPassword(input.newPassword), updated_at: nowIso() }).where('id', '=', u.id).execute();
    return { changed: true };
  },
});

// =================================================================== tokens

function tokenDto(t: { id: string; name: string; prefix: string; scope: string; expires_at: string | null; last_used_at: string | null; created_at: string; revoked_at: string | null; user_id: string }) {
  return {
    id: t.id,
    userId: t.user_id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    expiresAt: t.expires_at,
    lastUsedAt: t.last_used_at,
    createdAt: t.created_at,
    revokedAt: t.revoked_at,
  };
}

/** Admins manage any account's tokens; everyone else only their own. */
function tokenOwner(ctx: OpContext, userId: string | undefined): string {
  const target = userId ?? ctx.actor.id;
  if (!target) throw new ValidationError('userId is required');
  if (target !== ctx.actor.id && !can(ctx.actor, 'admin:users')) throw new ForbiddenError('You can only manage your own tokens');
  return target;
}

export const listTokens = defineOp({
  name: 'token.list',
  group: GS,
  summary: 'List API tokens (yours, or a given user’s as admin)',
  permission: 'self:manage',
  kind: 'read',
  http: { method: 'GET', path: '/tokens' },
  input: z.object({ userId: z.string().optional() }),
  handler: async (ctx, input) => {
    const userId = tokenOwner(ctx, input.userId);
    const rows = await ctx.db.selectFrom('api_tokens').selectAll().where('user_id', '=', userId).orderBy('created_at', 'desc').execute();
    return rows.map(tokenDto);
  },
});

export const createToken = defineOp({
  name: 'token.create',
  group: GS,
  summary: 'Create an API / MCP access token',
  description: 'The secret is returned once. Read-scope tokens can only call read operations even if the user could do more.',
  permission: 'self:manage',
  kind: 'write',
  http: { method: 'POST', path: '/tokens' },
  targetType: 'token',
  mcp: false,
  input: z.object({
    name: z.string().min(1).max(100),
    scope: z.enum(['read', 'write']).default('write'),
    expiresInDays: z.number().int().min(1).max(3650).nullish().describe('Omit for a non-expiring token'),
    userId: z.string().optional().describe('Admins: create the token for this user / service account'),
  }),
  handler: async (ctx, input) => {
    const userId = tokenOwner(ctx, input.userId);
    if (ctx.actor.tokenId && ctx.actor.tokenScope !== 'write') throw new ForbiddenError('Read-only tokens cannot mint tokens');
    const user = await loadUser(ctx.db, userId);
    if (user.status !== 'active') throw new ValidationError('User is disabled');
    const { token, prefix, hash } = generateApiToken();
    const id = newId();
    const now = nowIso();
    const row = {
      id,
      user_id: userId,
      name: input.name,
      token_hash: hash,
      prefix,
      scope: input.scope,
      expires_at: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null,
      last_used_at: null,
      created_at: now,
      revoked_at: null,
    };
    await ctx.db.insertInto('api_tokens').values(row).execute();
    ctx.target.id = id;
    return { ...tokenDto(row), token };
  },
});

export const revokeToken = defineOp({
  name: 'token.revoke',
  group: GS,
  summary: 'Revoke an API token',
  permission: 'self:manage',
  kind: 'write',
  http: { method: 'DELETE', path: '/tokens/:id' },
  targetType: 'token',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const t = await ctx.db.selectFrom('api_tokens').selectAll().where('id', '=', input.id).executeTakeFirst();
    if (!t) throw new NotFoundError('Token', input.id);
    tokenOwner(ctx, t.user_id);
    ctx.target.id = t.id;
    await ctx.db.updateTable('api_tokens').set({ revoked_at: nowIso() }).where('id', '=', t.id).execute();
    return { revoked: true, id: t.id };
  },
});

// =================================================================== users

export const listUsers = defineOp({
  name: 'user.list',
  group: GA,
  summary: 'List users and service accounts',
  description: 'Available to all signed-in users (for owner pickers); only admins see account status details.',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/users' },
  input: z.object({
    q: z.string().max(200).optional(),
    kind: z.enum(['human', 'service']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    ...Pagination,
  }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('users');
    if (input.q) {
      const like = `%${likeEscape(input.q.toLowerCase())}%`;
      q = q.where((eb) => eb.or([sql<boolean>`lower(name) like ${like} escape '\\'`, sql<boolean>`lower(email) like ${like} escape '\\'`]));
    }
    if (input.kind) q = q.where('kind', '=', input.kind);
    if (input.status) q = q.where('status', '=', input.status);
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await q.selectAll().orderBy('name').limit(input.limit).offset(input.offset).execute();
    const teams = await userTeams(ctx.db, rows.map((r) => r.id));
    const isAdmin = can(ctx.actor, 'admin:users');
    const items = rows.map((u) => {
      const dto = userDto(u, teams.filter((t) => t.user_id === u.id).map(({ user_id: _u, ...t }) => t));
      return isAdmin ? dto : { id: dto.id, name: dto.name, email: dto.email, kind: dto.kind, role: dto.role, status: dto.status, teams: dto.teams };
    });
    return { items, total, limit: input.limit, offset: input.offset };
  },
});

export const getUser = defineOp({
  name: 'user.get',
  group: GA,
  summary: 'Get a user',
  permission: 'admin:users',
  kind: 'read',
  http: { method: 'GET', path: '/users/:id' },
  input: z.object({ id: Id.describe('User id or email') }),
  handler: async (ctx, input) => {
    const u = await loadUser(ctx.db, input.id);
    const teams = (await userTeams(ctx.db, [u.id])).map(({ user_id: _u, ...t }) => t);
    return userDto(u, teams);
  },
});

export const createUser = defineOp({
  name: 'user.create',
  group: GA,
  summary: 'Create a user or service account',
  description:
    'Human users get a local password (or sign in via SSO when no password is set). Service accounts never sign in interactively; create API tokens for them to use with the API or MCP (e.g. for AI agents).',
  permission: 'admin:users',
  kind: 'write',
  http: { method: 'POST', path: '/users' },
  targetType: 'user',
  input: z.object({
    email: z.string().email().max(320),
    name: z.string().min(1).max(200),
    role: z.enum(ROLES).default('viewer'),
    kind: z.enum(['human', 'service']).default('human'),
    password: z.string().max(256).optional().describe('Initial password for local sign-in. Omit to generate one (returned once).'),
    authProvider: z.enum(['local', 'oidc']).default('local'),
  }),
  handler: async (ctx, input) => {
    let generated: string | undefined;
    let hash: string | null = null;
    if (input.kind === 'human' && input.authProvider === 'local') {
      let pw = input.password;
      if (!pw) {
        generated = `${randomToken(12)}Aa1!`;
        pw = generated;
      }
      const problem = checkPasswordPolicy(pw, ctx.services.config.PASSWORD_MIN_LENGTH);
      if (problem) throw new ValidationError(problem);
      hash = await hashPassword(pw);
    }
    const id = newId();
    const now = nowIso();
    await ctx.db
      .insertInto('users')
      .values({
        id,
        email: input.email.toLowerCase(),
        name: input.name,
        password_hash: hash,
        role: input.role,
        kind: input.kind,
        status: 'active',
        auth_provider: input.kind === 'service' ? 'local' : input.authProvider,
        external_id: null,
        locked_until: null,
        last_login_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    ctx.target.id = id;
    return { ...userDto(await loadUser(ctx.db, id)), ...(generated ? { initialPassword: generated } : {}) };
  },
});

export const updateUser = defineOp({
  name: 'user.update',
  group: GA,
  summary: 'Change a user’s name, role or status',
  description: 'Disabling a user signs them out everywhere and stops their API tokens working.',
  permission: 'admin:users',
  kind: 'write',
  http: { method: 'PATCH', path: '/users/:id' },
  targetType: 'user',
  input: z.object({
    id: Id,
    name: z.string().min(1).max(200).optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    unlock: z.boolean().optional().describe('Clear a failed-login lockout'),
  }),
  handler: async (ctx, input) => {
    const u = await loadUser(ctx.db, input.id);
    ctx.target.id = u.id;
    const demoting = (input.role && input.role !== 'admin') || input.status === 'disabled';
    if (u.role === 'admin' && u.kind === 'human' && demoting && (await adminCount(ctx.db, u.id)) === 0) {
      throw new ValidationError('At least one active administrator must remain');
    }
    const set: Record<string, unknown> = { updated_at: nowIso() };
    if (input.name) set.name = input.name;
    if (input.role) set.role = input.role;
    if (input.status) set.status = input.status;
    if (input.unlock) {
      set.failed_logins = 0;
      set.locked_until = null;
    }
    await ctx.db.updateTable('users').set(set).where('id', '=', u.id).execute();
    if (input.status === 'disabled' || (input.role && input.role !== u.role)) await destroyUserSessions(ctx.db, u.id);
    ctx.auditDetail = { before: { role: u.role, status: u.status } };
    return userDto(await loadUser(ctx.db, u.id));
  },
});

export const resetPassword = defineOp({
  name: 'user.resetPassword',
  group: GA,
  summary: 'Set a new password for a local user',
  description: 'Returns a generated password if none is supplied, and signs the user out of all sessions.',
  permission: 'admin:users',
  kind: 'write',
  http: { method: 'POST', path: '/users/:id/reset-password' },
  targetType: 'user',
  mcp: false,
  input: z.object({ id: Id, password: z.string().max(256).optional() }),
  handler: async (ctx, input) => {
    const u = await loadUser(ctx.db, input.id);
    ctx.target.id = u.id;
    if (u.kind !== 'human' || u.auth_provider !== 'local') throw new ValidationError('Only local human accounts have passwords');
    const pw = input.password ?? `${randomToken(12)}Aa1!`;
    const problem = checkPasswordPolicy(pw, ctx.services.config.PASSWORD_MIN_LENGTH);
    if (problem) throw new ValidationError(problem);
    await ctx.db
      .updateTable('users')
      .set({ password_hash: await hashPassword(pw), failed_logins: 0, locked_until: null, updated_at: nowIso() })
      .where('id', '=', u.id)
      .execute();
    await destroyUserSessions(ctx.db, u.id);
    return { reset: true, ...(input.password ? {} : { temporaryPassword: pw }) };
  },
});

export const deleteUser = defineOp({
  name: 'user.delete',
  group: GA,
  summary: 'Delete a user permanently',
  description: 'Their audit history is retained. Content they authored is kept but no longer attributed.',
  permission: 'admin:users',
  kind: 'delete',
  http: { method: 'DELETE', path: '/users/:id' },
  targetType: 'user',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const u = await loadUser(ctx.db, input.id);
    ctx.target.id = u.id;
    if (u.id === ctx.actor.id) throw new ValidationError('You cannot delete your own account');
    if (u.role === 'admin' && u.kind === 'human' && (await adminCount(ctx.db, u.id)) === 0) throw new ValidationError('At least one active administrator must remain');
    ctx.auditDetail = { email: u.email };
    await ctx.db.deleteFrom('users').where('id', '=', u.id).execute();
    return { deleted: true, id: u.id };
  },
});

export const listRoles = defineOp({
  name: 'role.list',
  group: GA,
  summary: 'Describe roles and the permissions each grants',
  permission: null,
  kind: 'read',
  http: { method: 'GET', path: '/roles' },
  input: z.object({}),
  handler: async () => ({
    roles: ROLES.map((r) => ({ role: r, description: ROLE_DESCRIPTIONS[r], permissions: [...ROLE_PERMISSIONS[r]] })),
    permissions: PERMISSIONS,
  }),
});

// =================================================================== settings

export const getSettingsOp = defineOp({
  name: 'settings.get',
  group: GA,
  summary: 'Get organisation settings',
  permission: null,
  kind: 'read',
  http: { method: 'GET', path: '/settings' },
  input: z.object({}),
  handler: async (ctx) => getSettings(ctx.db),
});

export const updateSettings = defineOp({
  name: 'settings.update',
  group: GA,
  summary: 'Update organisation settings',
  permission: 'admin:settings',
  kind: 'write',
  http: { method: 'PATCH', path: '/settings' },
  targetType: 'settings',
  input: SettingsSchema.partial().strict(),
  handler: async (ctx, input) => {
    const now = nowIso();
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      await ctx.db
        .insertInto('settings')
        .values({ key, value: JSON.stringify(value), updated_at: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: now }))
        .execute();
    }
    return getSettings(ctx.db);
  },
});

// =================================================================== audit

export const listAudit = defineOp({
  name: 'audit.list',
  group: GA,
  summary: 'Search the audit log',
  description: 'Every change (and every denied attempt) made through the UI, API, MCP or CLI is recorded here.',
  permission: 'admin:audit',
  kind: 'read',
  http: { method: 'GET', path: '/audit' },
  input: z.object({
    actorId: z.string().optional(),
    operation: z.string().optional().describe('Exact operation name or prefix ending in * (e.g. process.*)'),
    targetType: z.string().optional(),
    targetId: z.string().optional(),
    channel: z.enum(['ui', 'api', 'mcp', 'cli', 'system']).optional(),
    outcome: z.enum(['success', 'denied', 'error']).optional(),
    from: z.string().optional().describe('ISO timestamp (inclusive)'),
    to: z.string().optional().describe('ISO timestamp (exclusive)'),
    ...Pagination,
  }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('audit_log');
    if (input.actorId) q = q.where('actor_id', '=', input.actorId);
    if (input.operation) {
      q = input.operation.endsWith('*')
        ? q.where(sql<boolean>`operation like ${`${likeEscape(input.operation.slice(0, -1))}%`} escape '\\'`)
        : q.where('operation', '=', input.operation);
    }
    if (input.targetType) q = q.where('target_type', '=', input.targetType);
    if (input.targetId) q = q.where('target_id', '=', input.targetId);
    if (input.channel) q = q.where('channel', '=', input.channel);
    if (input.outcome) q = q.where('outcome', '=', input.outcome);
    if (input.from) q = q.where('at', '>=', input.from);
    if (input.to) q = q.where('at', '<', input.to);
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await q.selectAll().orderBy('at', 'desc').limit(input.limit).offset(input.offset).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actorId: r.actor_id,
        actor: r.actor_label,
        channel: r.channel,
        operation: r.operation,
        targetType: r.target_type,
        targetId: r.target_id,
        outcome: r.outcome,
        detail: parseJson(r.detail, null),
        ip: r.ip,
        requestId: r.request_id,
      })),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  },
});

export const processActivity = defineOp({
  name: 'process.activity',
  group: 'Processes',
  summary: 'Change history of a single process',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:id/activity' },
  input: z.object({ id: Id, limit: z.coerce.number().int().min(1).max(200).default(50) }),
  handler: async (ctx, input) => {
    const p = await ctx.db.selectFrom('processes').select('id').where((eb) => eb.or([eb('id', '=', input.id), eb('ref', '=', input.id)])).executeTakeFirst();
    if (!p) throw new NotFoundError('Process', input.id);
    const rows = await ctx.db
      .selectFrom('audit_log')
      .select(['at', 'actor_label', 'channel', 'operation', 'outcome'])
      .where('target_type', '=', 'process')
      .where('target_id', '=', p.id)
      .where('outcome', '=', 'success')
      .orderBy('at', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map((r) => ({ at: r.at, actor: r.actor_label.replace(/\s*<.*>$/, ''), channel: r.channel, operation: r.operation }));
  },
});

// =================================================================== webhooks

const WebhookEvents = z
  .array(z.string().regex(/^[a-zA-Z.*]+$/))
  .min(1)
  .max(50)
  .describe(WEBHOOK_EVENTS_HELP);

function webhookDto(w: { id: string; name: string; url: string; events: string; active: number; created_at: string; last_status: string | null; last_delivery_at: string | null; failure_count: number }) {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: parseJson<string[]>(w.events, []),
    active: w.active === 1,
    createdAt: w.created_at,
    lastStatus: w.last_status,
    lastDeliveryAt: w.last_delivery_at,
    failureCount: w.failure_count,
  };
}

export const listWebhooks = defineOp({
  name: 'webhook.list',
  group: 'Integrations',
  summary: 'List outbound webhooks',
  permission: 'admin:settings',
  kind: 'read',
  http: { method: 'GET', path: '/webhooks' },
  input: z.object({}),
  handler: async (ctx) => (await ctx.db.selectFrom('webhooks').selectAll().orderBy('name').execute()).map(webhookDto),
});

export const createWebhook = defineOp({
  name: 'webhook.create',
  group: 'Integrations',
  summary: 'Subscribe a URL to change events',
  description: 'Deliveries are signed with HMAC-SHA256 in the X-Streamline-Signature header using the returned secret.',
  permission: 'admin:settings',
  kind: 'write',
  http: { method: 'POST', path: '/webhooks' },
  targetType: 'webhook',
  input: z.object({ name: z.string().min(1).max(100), url: z.string().url().max(2000), events: WebhookEvents.default(['*']) }),
  handler: async (ctx, input) => {
    await assertSafeWebhookUrl(input.url, ctx.services.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    const id = newId();
    const secret = `whsec_${randomToken(24)}`;
    const row = { id, name: input.name, url: input.url, secret, events: JSON.stringify(input.events), active: 1, created_by: ctx.actor.id, created_at: nowIso(), last_status: null, last_delivery_at: null, failure_count: 0 };
    await ctx.db.insertInto('webhooks').values(row).execute();
    ctx.target.id = id;
    return { ...webhookDto(row), secret };
  },
});

export const updateWebhook = defineOp({
  name: 'webhook.update',
  group: 'Integrations',
  summary: 'Update a webhook',
  permission: 'admin:settings',
  kind: 'write',
  http: { method: 'PATCH', path: '/webhooks/:id' },
  targetType: 'webhook',
  input: z.object({ id: Id, name: z.string().min(1).max(100).optional(), url: z.string().url().max(2000).optional(), events: WebhookEvents.optional(), active: z.boolean().optional() }),
  handler: async (ctx, input) => {
    const w = await ctx.db.selectFrom('webhooks').selectAll().where('id', '=', input.id).executeTakeFirst();
    if (!w) throw new NotFoundError('Webhook', input.id);
    ctx.target.id = w.id;
    if (input.url) await assertSafeWebhookUrl(input.url, ctx.services.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    const set: Record<string, unknown> = {};
    if (input.name) set.name = input.name;
    if (input.url) set.url = input.url;
    if (input.events) set.events = JSON.stringify(input.events);
    if (input.active !== undefined) {
      set.active = input.active ? 1 : 0;
      if (input.active) set.failure_count = 0;
    }
    if (Object.keys(set).length) await ctx.db.updateTable('webhooks').set(set).where('id', '=', w.id).execute();
    return webhookDto(await ctx.db.selectFrom('webhooks').selectAll().where('id', '=', w.id).executeTakeFirstOrThrow());
  },
});

export const deleteWebhook = defineOp({
  name: 'webhook.delete',
  group: 'Integrations',
  summary: 'Delete a webhook',
  permission: 'admin:settings',
  kind: 'delete',
  http: { method: 'DELETE', path: '/webhooks/:id' },
  targetType: 'webhook',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    ctx.target.id = input.id;
    const res = await ctx.db.deleteFrom('webhooks').where('id', '=', input.id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundError('Webhook', input.id);
    return { deleted: true, id: input.id };
  },
});

export const testWebhook = defineOp({
  name: 'webhook.test',
  group: 'Integrations',
  summary: 'Send a test (ping) delivery to a webhook',
  permission: 'admin:settings',
  kind: 'read',
  http: { method: 'POST', path: '/webhooks/:id/test' },
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const w = await ctx.db.selectFrom('webhooks').selectAll().where('id', '=', input.id).executeTakeFirst();
    if (!w) throw new NotFoundError('Webhook', input.id);
    return deliverTest(ctx.services, w);
  },
});

export const adminOps = [
  whoami,
  updateProfile,
  changePassword,
  listTokens,
  createToken,
  revokeToken,
  listUsers,
  getUser,
  createUser,
  updateUser,
  resetPassword,
  deleteUser,
  listRoles,
  getSettingsOp,
  updateSettings,
  listAudit,
  processActivity,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
];

import type { Kysely } from 'kysely';
import type { Database, UserRow } from '../db/schema.js';
import type { Actor } from '../core/operation.js';
import { isRole } from '../core/permissions.js';
import { newId, nowIso, randomToken, sha256 } from '../lib/util.js';

export const TOKEN_PREFIX = 'slt_';

export function userToActor(user: UserRow, token?: { id: string; scope: string }): Actor {
  return {
    type: 'user',
    id: user.id,
    email: user.email,
    name: user.name,
    role: isRole(user.role) ? user.role : 'viewer',
    userKind: user.kind === 'service' ? 'service' : 'human',
    tokenScope: token ? (token.scope === 'read' ? 'read' : 'write') : undefined,
    tokenId: token?.id,
  };
}

export function isActiveUser(user: UserRow | undefined): user is UserRow {
  return Boolean(user && user.status === 'active');
}

// ---------------------------------------------------------------- sessions

export interface SessionInfo {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  ttlHours: number,
  meta: { ip?: string; userAgent?: string },
): Promise<SessionInfo> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  await db
    .insertInto('sessions')
    .values({
      id: newId(),
      token_hash: sha256(token),
      user_id: userId,
      csrf_token: csrfToken,
      created_at: now,
      expires_at: expiresAt,
      last_seen_at: now,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  return { token, csrfToken, expiresAt };
}

export async function resolveSession(
  db: Kysely<Database>,
  token: string,
  idleMinutes: number,
): Promise<{ user: UserRow; csrfToken: string; sessionId: string } | null> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .selectAll('users')
    .select(['sessions.id as session_id', 'sessions.csrf_token', 'sessions.expires_at', 'sessions.last_seen_at'])
    .where('sessions.token_hash', '=', sha256(token))
    .executeTakeFirst();
  if (!row) return null;
  const now = Date.now();
  const idleExpired = now - new Date(row.last_seen_at).getTime() > idleMinutes * 60_000;
  if (new Date(row.expires_at).getTime() < now || idleExpired || row.status !== 'active') {
    await db.deleteFrom('sessions').where('id', '=', row.session_id).execute();
    return null;
  }
  // Touch at most once a minute to limit write load.
  if (now - new Date(row.last_seen_at).getTime() > 60_000) {
    await db.updateTable('sessions').set({ last_seen_at: nowIso() }).where('id', '=', row.session_id).execute();
  }
  const { session_id, csrf_token, expires_at: _e, last_seen_at: _l, ...user } = row;
  return { user: user as UserRow, csrfToken: csrf_token, sessionId: session_id };
}

export async function destroySession(db: Kysely<Database>, token: string): Promise<void> {
  await db.deleteFrom('sessions').where('token_hash', '=', sha256(token)).execute();
}

export async function destroyUserSessions(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
}

// ---------------------------------------------------------------- API tokens

export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const secret = randomToken(32);
  const token = `${TOKEN_PREFIX}${secret}`;
  return { token, prefix: `${TOKEN_PREFIX}${secret.slice(0, 6)}`, hash: sha256(token) };
}

export async function resolveApiToken(db: Kysely<Database>, token: string): Promise<Actor | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .selectFrom('api_tokens')
    .innerJoin('users', 'users.id', 'api_tokens.user_id')
    .selectAll('users')
    .select([
      'api_tokens.id as token_id',
      'api_tokens.scope as token_scope',
      'api_tokens.expires_at as token_expires_at',
      'api_tokens.revoked_at as token_revoked_at',
      'api_tokens.last_used_at as token_last_used_at',
    ])
    .where('api_tokens.token_hash', '=', sha256(token))
    .executeTakeFirst();
  if (!row || row.token_revoked_at) return null;
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() < Date.now()) return null;
  if (row.status !== 'active') return null;
  if (!row.token_last_used_at || Date.now() - new Date(row.token_last_used_at).getTime() > 60_000) {
    await db.updateTable('api_tokens').set({ last_used_at: nowIso() }).where('id', '=', row.token_id).execute();
  }
  const { token_id, token_scope, token_expires_at: _a, token_revoked_at: _b, token_last_used_at: _c, ...user } = row;
  return userToActor(user as UserRow, { id: token_id, scope: token_scope });
}

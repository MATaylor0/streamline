import type { z } from 'zod';
import type { DB, Database } from '../db/schema.js';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Dialect } from '../db/index.js';
import type { Permission, Role } from './permissions.js';

/** The path a request came in on. Recorded in the audit log. */
export type Channel = 'ui' | 'api' | 'mcp' | 'cli' | 'system';

export interface Actor {
  /** 'system' is used for bootstrap, scheduled jobs and the CLI when run without a user. */
  type: 'user' | 'system';
  id: string | null;
  email: string;
  name: string;
  role: Role;
  /** 'human' accounts sign in interactively; 'service' accounts are for automations and AI agents. */
  userKind: 'human' | 'service' | 'system';
  /** Set when the request was authenticated by an API token. */
  tokenScope?: 'read' | 'write';
  tokenId?: string;
}

export const SYSTEM_ACTOR: Actor = {
  type: 'system',
  id: null,
  email: 'system@streamline.local',
  name: 'System',
  role: 'admin',
  userKind: 'system',
};

export interface RequestMeta {
  channel: Channel;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface Services {
  db: Kysely<Database>;
  dialect: Dialect;
  config: Config;
  /** Called after a write operation commits. Used for webhooks. */
  onEvent?: (event: DomainEvent) => void;
}

export interface DomainEvent {
  event: string;
  at: string;
  actor: { id: string | null; name: string; channel: Channel };
  target: { type: string | null; id: string | null };
  data: unknown;
}

export interface OpContext {
  /** Database handle. Inside write operations this is the enclosing transaction. */
  db: DB;
  actor: Actor;
  meta: RequestMeta;
  services: Services;
  /** Set by handlers to describe the main entity affected (used by audit + events). */
  target: { type: string | null; id: string | null };
  /** Extra audit detail beyond the sanitized input. */
  auditDetail?: Record<string, unknown>;
}

export type OpKind = 'read' | 'write' | 'delete';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OperationDef<I extends z.ZodType = z.ZodType, O = unknown> {
  /** Dotted name, e.g. `process.create`. MCP tool names replace dots with underscores. */
  name: string;
  /** Group used for API docs, MCP descriptions and the CLI listing. */
  group: string;
  summary: string;
  description?: string;
  /** Permission required. `null` means any authenticated principal. */
  permission: Permission | null;
  kind: OpKind;
  input: I;
  http: { method: HttpMethod; path: string };
  /** Entity type for audit/events when the handler does not set `ctx.target`. */
  targetType?: string;
  /** Exclude from MCP (e.g. credential handling that should stay out of AI channels). */
  mcp?: boolean;
  /** Audit this read operation even when AUDIT_READS is off (e.g. bulk exports). */
  alwaysAudit?: boolean;
  /** Result is a file ({ filename, contentType, content }); REST serves it as a download. */
  file?: boolean;
  handler: (ctx: OpContext, input: z.output<I>) => Promise<O>;
}

export type AnyOperation = OperationDef<z.ZodType, unknown>;

/** Identity helper that preserves input/output inference for handlers. */
export function defineOp<I extends z.ZodType, O>(def: OperationDef<I, O>): OperationDef<I, O> {
  return def;
}

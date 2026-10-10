import { z } from 'zod';
import type { AnyOperation, Actor, OpContext, RequestMeta, Services, DomainEvent } from './operation.js';
import { AppError, ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, UnauthorizedError, ValidationError } from './errors.js';
import { READ_ONLY_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from './permissions.js';
import { newId, nowIso, redact } from '../lib/util.js';

/**
 * The single entry point for every action in the system.
 *
 *   UI ──► REST ─┐
 *   API client ──┤
 *   AI agent ──► MCP ─┼──► Executor: authenticate ► authorize ► validate ► run (in a transaction) ► audit ► emit events
 *   CLI / jobs ──┘
 *
 * Because every transport funnels through `execute`, permissions, validation,
 * auditing and business rules are identical no matter how a request arrives.
 */
export class Executor {
  private readonly ops = new Map<string, AnyOperation>();

  constructor(
    public readonly services: Services,
    operations: AnyOperation[],
  ) {
    for (const op of operations) {
      if (this.ops.has(op.name)) throw new Error(`Duplicate operation: ${op.name}`);
      this.ops.set(op.name, op);
    }
  }

  list(): AnyOperation[] {
    return [...this.ops.values()];
  }

  get(name: string): AnyOperation | undefined {
    return this.ops.get(name);
  }

  /** Operations the actor is allowed to invoke (used to filter MCP tool lists and the UI). */
  allowed(actor: Actor): AnyOperation[] {
    return this.list().filter((op) => can(actor, op.permission));
  }

  async execute<T = unknown>(name: string, rawInput: unknown, actor: Actor | null, meta: RequestMeta): Promise<T> {
    const op = this.ops.get(name);
    if (!op) throw new NotFoundError('Operation', name);
    if (!actor) throw new UnauthorizedError();

    if (!can(actor, op.permission)) {
      await this.audit(op, actor, meta, rawInput, { type: op.targetType ?? null, id: null }, 'denied', {
        reason: actor.tokenScope === 'read' ? 'read-only token' : `missing permission ${op.permission}`,
      });
      throw new ForbiddenError(
        actor.tokenScope === 'read' && op.permission && ROLE_PERMISSIONS[actor.role].has(op.permission)
          ? 'This API token is read-only'
          : `Permission '${op.permission}' is required for ${op.name}`,
      );
    }

    const parsed = op.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid input', z.flattenError(parsed.error as z.ZodError<Record<string, unknown>>));
    }

    const ctx: OpContext = {
      db: this.services.db,
      actor,
      meta,
      services: this.services,
      target: { type: op.targetType ?? null, id: null },
    };

    try {
      let result: unknown;
      if (op.kind === 'read') {
        result = await op.handler(ctx, parsed.data);
        if (this.services.config.AUDIT_READS || op.alwaysAudit) await this.audit(op, actor, meta, parsed.data, ctx.target, 'success');
      } else {
        result = await this.services.db.transaction().execute(async (trx) => {
          const txCtx: OpContext = { ...ctx, db: trx };
          const out = await op.handler(txCtx, parsed.data);
          ctx.target = txCtx.target;
          ctx.auditDetail = txCtx.auditDetail;
          await this.audit(op, actor, meta, parsed.data, txCtx.target, 'success', txCtx.auditDetail, trx);
          return out;
        });
        this.emit(op, actor, meta, ctx.target, result);
      }
      return result as T;
    } catch (caught) {
      const err = isUniqueViolation(caught)
        ? new ConflictError('A record with the same unique name or reference already exists')
        : caught;
      if (op.kind !== 'read' && err instanceof AppError && err.status >= 400 && err.status !== 404) {
        await this.audit(op, actor, meta, parsed.data, ctx.target, 'error', { code: err.code, message: err.message });
      }
      throw err;
    }
  }

  private emit(op: AnyOperation, actor: Actor, meta: RequestMeta, target: OpContext['target'], data: unknown) {
    if (!this.services.onEvent) return;
    const event: DomainEvent = {
      event: op.name,
      at: nowIso(),
      actor: { id: actor.id, name: actor.name, channel: meta.channel },
      target,
      data,
    };
    try {
      this.services.onEvent(event);
    } catch {
      /* event delivery must never break the request */
    }
  }

  private async audit(
    op: AnyOperation,
    actor: Actor,
    meta: RequestMeta,
    input: unknown,
    target: OpContext['target'],
    outcome: 'success' | 'denied' | 'error',
    extra?: Record<string, unknown>,
    db = this.services.db,
  ) {
    const detail = { input: redact(input), ...(extra ?? {}) };
    await db
      .insertInto('audit_log')
      .values({
        id: newId(),
        at: nowIso(),
        actor_id: actor.id,
        actor_label: actor.type === 'system' ? 'system' : `${actor.name} <${actor.email}>`,
        channel: meta.channel,
        operation: op.name,
        target_type: target.type,
        target_id: target.id,
        outcome,
        detail: JSON.stringify(detail),
        ip: meta.ip ?? null,
        request_id: meta.requestId ?? null,
      })
      .execute();
  }
}

export function can(actor: Actor, permission: Permission | null): boolean {
  if (actor.type === 'system') return true;
  if (permission === null) return true;
  if (!ROLE_PERMISSIONS[actor.role]?.has(permission)) return false;
  if (actor.tokenScope === 'read' && !READ_ONLY_PERMISSIONS.has(permission)) return false;
  return true;
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw new ForbiddenError(`Permission '${permission}' is required`);
}

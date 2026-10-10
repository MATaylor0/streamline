import { z } from 'zod';
import { defineOp, type AnyOperation } from '../core/operation.js';
import { can } from '../core/executor.js';
import { processOps } from './processes.js';
import { catalogOps } from './catalog.js';
import { insightOps } from './insights.js';
import { adminOps } from './admin.js';
import { exportOps } from './exports.js';

export const metaOperations = defineOp({
  name: 'meta.operations',
  group: 'Meta',
  summary: 'List every operation, its HTTP route and whether you may call it',
  description: 'The same catalogue drives the REST API, the MCP tool list and the CLI.',
  permission: null,
  kind: 'read',
  http: { method: 'GET', path: '/meta/operations' },
  input: z.object({ onlyAllowed: z.coerce.boolean().default(false) }),
  handler: async (ctx, input) =>
    allOperations
      .filter((op) => !input.onlyAllowed || can(ctx.actor, op.permission))
      .map((op) => ({
        name: op.name,
        group: op.group,
        summary: op.summary,
        method: op.http.method,
        path: `/api/v1${op.http.path}`,
        mcpTool: op.mcp === false ? null : toolName(op.name),
        permission: op.permission,
        kind: op.kind,
        allowed: can(ctx.actor, op.permission),
      })),
});

export const allOperations: AnyOperation[] = [
  ...processOps,
  ...catalogOps,
  ...insightOps,
  ...exportOps,
  ...adminOps,
  metaOperations,
] as AnyOperation[];

/** MCP tool names only allow [a-zA-Z0-9_-]. */
export function toolName(opName: string): string {
  return opName.replace(/\./g, '_');
}

import type { DB } from '../db/schema.js';
import { ValidationError } from '../core/errors.js';
import { uniq } from '../lib/util.js';
import { AGENT_EXECUTED } from './shared.js';

/** Agents must exist and must not be retired to receive new delegations. */
export async function assertAssignableAgents(db: DB, ids: Array<string | null | undefined>): Promise<void> {
  const wanted = uniq(ids.filter((v): v is string => Boolean(v)));
  if (!wanted.length) return;
  const rows = await db.selectFrom('agents').select(['id', 'name', 'status']).where('id', 'in', wanted).execute();
  const missing = wanted.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new ValidationError(`Unknown agent ids: ${missing.join(', ')}`);
  const retired = rows.filter((r) => r.status === 'retired');
  if (retired.length) throw new ValidationError(`Retired agents cannot be assigned work: ${retired.map((r) => r.name).join(', ')}`);
}

export interface Delegation {
  label: string;
  agentId: string | null;
  automationLevel: string;
  oversight: string | null;
}

/**
 * Governance gaps in AI delegation for one process (used at publish time and in
 * the AI register). Any delegation needs a named agent; work the agent performs
 * itself (supervised / autonomous) also needs documented human oversight.
 */
export function delegationIssues(items: Delegation[]): string[] {
  const issues: string[] = [];
  for (const d of items) {
    if (d.automationLevel === 'manual') continue;
    if (!d.agentId) issues.push(`"${d.label}" is marked ${d.automationLevel} but no AI agent is assigned`);
    if (AGENT_EXECUTED.has(d.automationLevel) && !d.oversight?.trim()) {
      issues.push(`"${d.label}" is ${d.automationLevel} by an AI agent but has no human oversight described`);
    }
  }
  return issues;
}

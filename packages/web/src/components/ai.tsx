import type { AutomationLevel } from '../types';

export const LEVELS: Array<{ value: AutomationLevel; label: string; short: string; help: string }> = [
  { value: 'manual', label: 'Manual', short: 'Manual', help: 'People only' },
  { value: 'assisted', label: 'AI-assisted', short: 'Assisted', help: 'The agent drafts or recommends; a person performs the step and decides' },
  { value: 'supervised', label: 'AI-performed, human-reviewed', short: 'Supervised', help: 'The agent performs the step; a person reviews or approves each output (human-in-the-loop)' },
  { value: 'autonomous', label: 'AI-autonomous', short: 'Autonomous', help: 'The agent performs the step end to end; people monitor and handle exceptions (human-on-the-loop)' },
];

export const levelInfo = (l: string) => LEVELS.find((x) => x.value === l) ?? LEVELS[0];

const LEVEL_CLASS: Record<string, string> = { assisted: 'blue', supervised: 'purple', autonomous: 'amber' };

/** Badge such as "🤖 Supervised · Invoice Agent". */
export function AiBadge({ level, agent, compact }: { level: string; agent?: string | null; compact?: boolean }) {
  if (level === 'manual') return null;
  const info = levelInfo(level);
  return (
    <span className={`badge ${LEVEL_CLASS[level] ?? ''}`} title={info.help}>
      <span aria-hidden="true">🤖</span> {info.short}
      {!compact && agent ? ` · ${agent}` : ''}
    </span>
  );
}

const STATUS_CLASS: Record<string, string> = { proposed: '', pilot: 'blue', production: 'green', suspended: 'amber', retired: 'purple' };
export function AgentStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ''}`}>{status}</span>;
}

const TIER_CLASS: Record<string, string> = { minimal: 'green', limited: 'amber', high: 'red' };
export function RiskTierBadge({ tier }: { tier: string }) {
  return <span className={`badge ${TIER_CLASS[tier] ?? ''}`}>{tier} risk</span>;
}

/** Client-side mirror of the server's delegation completeness rule. */
export function delegationIssue(d: { label: string; agentId: string | null; automationLevel: string; oversight: string | null }): string[] {
  if (d.automationLevel === 'manual') return [];
  const out: string[] = [];
  if (!d.agentId) out.push(`"${d.label}" is ${d.automationLevel} but has no AI agent assigned`);
  if ((d.automationLevel === 'supervised' || d.automationLevel === 'autonomous') && !d.oversight?.trim()) out.push(`"${d.label}" needs human oversight described`);
  return out;
}

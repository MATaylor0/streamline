import { sql } from 'kysely';
import { z } from 'zod';
import type { DB, ProcessRow, NodeRow, EdgeRow } from '../db/schema.js';
import type { OpContext } from '../core/operation.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.js';
import { nowIso, parseJson, uniq } from '../lib/util.js';

// ---------------------------------------------------------------- schemas

export const Id = z.string().min(1).max(64).describe('Identifier (UUID)');

/**
 * Make every field optional *without* defaults, for partial updates. (In Zod 4
 * `.optional()` on a defaulted field still fills the default in, which would
 * overwrite stored values the caller did not mention.)
 */
export function partialShape<T extends Record<string, z.ZodType>>(shape: T): { [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]>, z.input<T[K]>>> } {
  const out: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(shape)) {
    const inner = v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : v;
    out[k] = (v.description ? inner.describe(v.description) : inner).optional();
  }
  return out as never;
}
export const OptionalText = (max = 10_000) => z.string().max(max).nullish();

export const Pagination = {
  limit: z.coerce.number().int().min(1).max(500).default(50).describe('Maximum number of items to return'),
  offset: z.coerce.number().int().min(0).default(0).describe('Number of items to skip'),
};

/** Accepts `a,b,c`, `["a","b"]` or a single value (query strings and JSON alike). */
export const StringList = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

export const Color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #2563eb');

export const PROCESS_STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;
export const NODE_TYPES = ['start', 'end', 'task', 'decision', 'subprocess', 'event', 'document', 'system', 'note'] as const;
export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export const RISK_STATUSES = ['open', 'mitigated', 'accepted', 'closed'] as const;
export const CONTROL_TYPES = ['preventive', 'detective', 'corrective'] as const;
export const CONTROL_NATURES = ['manual', 'automated', 'it_dependent'] as const;
export const EFFECTIVENESS = ['not_tested', 'effective', 'partially_effective', 'ineffective'] as const;

/**
 * How much of a step (or process) is delegated to an AI agent:
 * - manual: people only
 * - assisted: the agent drafts or recommends; a person performs the step and decides
 * - supervised: the agent performs the step; a person reviews or approves each output (human-in-the-loop)
 * - autonomous: the agent performs the step end to end; people monitor and handle exceptions (human-on-the-loop)
 */
export const AUTOMATION_LEVELS = ['manual', 'assisted', 'supervised', 'autonomous'] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];
/** Levels where the agent itself carries out the work. */
export const AGENT_EXECUTED: ReadonlySet<string> = new Set(['supervised', 'autonomous']);
export const AGENT_STATUSES = ['proposed', 'pilot', 'production', 'suspended', 'retired'] as const;
export const AGENT_RISK_TIERS = ['minimal', 'limited', 'high'] as const;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------- settings

export const SettingsSchema = z.object({
  organizationName: z.string().min(1).max(200).default('My Organization'),
  enforceTeamOwnership: z
    .boolean()
    .default(false)
    .describe('If true, only members of the owning team (or admins) may edit a process'),
  requireReview: z.boolean().default(true).describe('Processes must be submitted for review before publishing'),
  allowSelfApproval: z
    .boolean()
    .default(false)
    .describe('Allow the person who submitted a process to also approve it (segregation of duties when false)'),
  defaultReviewIntervalDays: z.number().int().min(0).max(3650).default(365),
  processRefPrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/).default('PRC'),
  loginBanner: z.string().max(2000).default(''),
  requireAiOversight: z
    .boolean()
    .default(true)
    .describe('Block publishing when a step or process delegated to AI (supervised/autonomous) has no agent or no human oversight described'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export async function getSettings(db: DB): Promise<Settings> {
  const rows = await db.selectFrom('settings').selectAll().execute();
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = parseJson(r.value, undefined);
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : SettingsSchema.parse({});
}

// ---------------------------------------------------------------- counters / refs

export async function nextCounter(db: DB, name: string): Promise<number> {
  await db.insertInto('counters').values({ name, value: 0 }).onConflict((oc) => oc.column('name').doNothing()).execute();
  const row = await db
    .updateTable('counters')
    .set({ value: sql`value + 1` })
    .where('name', '=', name)
    .returning('value')
    .executeTakeFirstOrThrow();
  return Number(row.value);
}

export async function nextRef(db: DB, counter: string, prefix: string, width = 4): Promise<string> {
  const n = await nextCounter(db, counter);
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

// ---------------------------------------------------------------- loaders

export async function loadProcess(db: DB, id: string): Promise<ProcessRow> {
  const row = await db
    .selectFrom('processes')
    .selectAll()
    .where((eb) => eb.or([eb('id', '=', id), eb('ref', '=', id)]))
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Process', id);
  return row;
}

export async function assertExists(db: DB, table: 'teams' | 'systems' | 'risks' | 'controls' | 'users' | 'processes' | 'agents', ids: Array<string | null | undefined>, label: string) {
  const wanted = uniq(ids.filter((v): v is string => Boolean(v)));
  if (!wanted.length) return;
  const found = await db.selectFrom(table).select('id').where('id', 'in', wanted).execute();
  const foundIds = new Set(found.map((r) => r.id));
  const missing = wanted.filter((id) => !foundIds.has(id));
  if (missing.length) throw new ValidationError(`Unknown ${label}: ${missing.join(', ')}`);
}

/**
 * Resource-level authorization shared by every edit path. When team ownership
 * is enforced, only admins and members of the owning team may modify a process.
 */
export async function assertCanEditProcess(ctx: OpContext, process: ProcessRow): Promise<void> {
  if (ctx.actor.type === 'system' || ctx.actor.role === 'admin') return;
  const settings = await getSettings(ctx.db);
  if (!settings.enforceTeamOwnership || !process.owner_team_id) return;
  const member = await ctx.db
    .selectFrom('team_members')
    .select('user_id')
    .where('team_id', '=', process.owner_team_id)
    .where('user_id', '=', ctx.actor.id ?? '')
    .executeTakeFirst();
  if (!member) throw new ForbiddenError('Only members of the owning team can edit this process');
}

/**
 * Record a modification: bumps the optimistic-lock revision and moves a
 * published or in-review process back to draft so changes are re-approved.
 */
export async function touchProcess(ctx: OpContext, process: ProcessRow, expectedRevision?: number | null): Promise<number> {
  if (expectedRevision != null && expectedRevision !== process.revision) {
    throw new ConflictError(
      `Process was modified by someone else (expected revision ${expectedRevision}, current ${process.revision}). Reload and try again.`,
      { currentRevision: process.revision },
    );
  }
  if (process.status === 'archived') throw new ValidationError('Archived processes are read-only. Restore it first.');
  const revision = process.revision + 1;
  await ctx.db
    .updateTable('processes')
    .set({
      revision,
      status: process.status === 'published' || process.status === 'in_review' ? 'draft' : process.status,
      updated_at: nowIso(),
      updated_by: ctx.actor.id,
    })
    .where('id', '=', process.id)
    .execute();
  return revision;
}

// ---------------------------------------------------------------- DTOs

export interface TagDto {
  id: string;
  name: string;
  color: string;
}

export interface TeamRef {
  id: string;
  name: string;
  color: string;
}

export async function processDtos(db: DB, rows: ProcessRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [tags, teams, users, counts, agents] = await Promise.all([
    db
      .selectFrom('process_tags')
      .innerJoin('tags', 'tags.id', 'process_tags.tag_id')
      .select(['process_tags.process_id', 'tags.id', 'tags.name', 'tags.color'])
      .where('process_tags.process_id', 'in', ids)
      .orderBy('tags.name')
      .execute(),
    db
      .selectFrom('teams')
      .select(['id', 'name', 'color'])
      .where('id', 'in', uniq(rows.map((r) => r.owner_team_id ?? '')).filter(Boolean).concat(['-']))
      .execute(),
    db
      .selectFrom('users')
      .select(['id', 'name', 'email'])
      .where('id', 'in', uniq(rows.flatMap((r) => [r.owner_user_id ?? '', r.updated_by ?? ''])).filter(Boolean).concat(['-']))
      .execute(),
    db
      .selectFrom('nodes')
      .select(['process_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('process_id', 'in', ids)
      .groupBy('process_id')
      .execute(),
    db
      .selectFrom('agents')
      .select(['id', 'name', 'status'])
      .where('id', 'in', uniq(rows.map((r) => r.agent_id ?? '')).filter(Boolean).concat(['-']))
      .execute(),
  ]);
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const userMap = new Map(users.map((u) => [u.id, u]));
  const countMap = new Map(counts.map((c) => [c.process_id, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    name: r.name,
    summary: r.summary,
    description: r.description,
    status: r.status,
    category: r.category,
    ownerTeam: r.owner_team_id ? (teamMap.get(r.owner_team_id) ?? null) : null,
    ownerUser: r.owner_user_id ? (userMap.get(r.owner_user_id) ?? null) : null,
    tags: tags.filter((t) => t.process_id === r.id).map(({ id, name, color }) => ({ id, name, color })),
    reviewIntervalDays: r.review_interval_days,
    nextReviewAt: r.next_review_at,
    revision: r.revision,
    publishedVersion: r.published_version,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    stepCount: countMap.get(r.id) ?? 0,
    agent: r.agent_id ? (agentMap.get(r.agent_id) ?? null) : null,
    automationLevel: r.automation_level as AutomationLevel,
    oversight: r.oversight,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ? (userMap.get(r.updated_by) ?? null) : null,
  }));
}

export type ProcessDto = Awaited<ReturnType<typeof processDtos>>[number];

export async function processDto(db: DB, row: ProcessRow): Promise<ProcessDto> {
  return (await processDtos(db, [row]))[0];
}

export async function nodeDtos(db: DB, nodes: NodeRow[]) {
  if (!nodes.length) return [];
  const ids = nodes.map((n) => n.id);
  const [systems, risks, controls] = await Promise.all(
    (['node_systems', 'node_risks', 'node_controls'] as const).map((t) =>
      db.selectFrom(t).select(['node_id', 'target_id']).where('node_id', 'in', ids).execute(),
    ),
  );
  const group = (rows: Array<{ node_id: string; target_id: string }>) => {
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.node_id, [...(m.get(r.node_id) ?? []), r.target_id]);
    return m;
  };
  const s = group(systems);
  const r = group(risks);
  const c = group(controls);
  return nodes.map((n) => ({
    id: n.id,
    processId: n.process_id,
    type: n.type,
    label: n.label,
    description: n.description,
    teamId: n.team_id,
    actorRole: n.actor_role,
    durationMinutes: n.duration_minutes,
    inputs: n.inputs,
    outputs: n.outputs,
    linkedProcessId: n.linked_process_id,
    agentId: n.agent_id,
    automationLevel: n.automation_level as AutomationLevel,
    oversight: n.oversight,
    position: { x: Number(n.x), y: Number(n.y) },
    systemIds: s.get(n.id) ?? [],
    riskIds: r.get(n.id) ?? [],
    controlIds: c.get(n.id) ?? [],
  }));
}

export type NodeDto = Awaited<ReturnType<typeof nodeDtos>>[number];

export function edgeDto(e: EdgeRow) {
  return { id: e.id, processId: e.process_id, source: e.source_node_id, target: e.target_node_id, label: e.label };
}

export type EdgeDto = ReturnType<typeof edgeDto>;

export async function loadDiagram(db: DB, processId: string) {
  const [nodes, edges] = await Promise.all([
    db.selectFrom('nodes').selectAll().where('process_id', '=', processId).orderBy('y').orderBy('x').execute(),
    db.selectFrom('edges').selectAll().where('process_id', '=', processId).orderBy('created_at').execute(),
  ]);
  return { nodes: await nodeDtos(db, nodes), edges: edges.map(edgeDto) };
}

export async function teamRefs(db: DB, ids: Array<string | null | undefined>): Promise<Map<string, TeamRef>> {
  const wanted = uniq(ids.filter((v): v is string => Boolean(v)));
  if (!wanted.length) return new Map();
  const rows = await db.selectFrom('teams').select(['id', 'name', 'color']).where('id', 'in', wanted).execute();
  return new Map(rows.map((r) => [r.id, r]));
}

/** Replace a link table's rows for the given owner. */
export async function replaceLinks(
  db: DB,
  table: 'node_systems' | 'node_risks' | 'node_controls',
  nodeId: string,
  targetIds: string[],
) {
  await db.deleteFrom(table).where('node_id', '=', nodeId).execute();
  const ids = uniq(targetIds);
  if (ids.length) await db.insertInto(table).values(ids.map((target_id) => ({ node_id: nodeId, target_id }))).execute();
}

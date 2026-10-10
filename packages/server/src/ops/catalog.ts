import { sql } from 'kysely';
import { z } from 'zod';
import { defineOp, type OpContext } from '../core/operation.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import type { DB } from '../db/schema.js';
import { likeEscape, newId, nowIso, pickColor, uniq } from '../lib/util.js';
import {
  CONTROL_NATURES,
  CONTROL_TYPES,
  CRITICALITIES,
  Color,
  EFFECTIVENESS,
  Id,
  RISK_STATUSES,
  assertExists,
  nextRef,
  teamRefs,
} from './shared.js';

const textFilter = (q: string | undefined, cols: string[]) => {
  if (!q) return null;
  const like = `%${likeEscape(q.toLowerCase())}%`;
  return cols.map((c) => sql<boolean>`lower(coalesce(${sql.ref(c)}, '')) like ${like} escape '\\'`);
};

/** How many processes / steps reference each catalog item. */
async function usage(db: DB, table: 'node_systems' | 'node_risks' | 'node_controls', ids: string[]) {
  if (!ids.length) return new Map<string, { processCount: number; stepCount: number }>();
  const rows = await db
    .selectFrom(table)
    .innerJoin('nodes', 'nodes.id', `${table}.node_id`)
    .innerJoin('processes', 'processes.id', 'nodes.process_id')
    .select([`${table}.target_id as id`, 'nodes.process_id as process_id'])
    .where(`${table}.target_id`, 'in', ids)
    .where('processes.status', '!=', 'archived')
    .execute();
  const out = new Map<string, { processCount: number; stepCount: number }>();
  for (const id of ids) {
    const mine = rows.filter((r) => r.id === id);
    out.set(id, { stepCount: mine.length, processCount: uniq(mine.map((r) => r.process_id)).length });
  }
  return out;
}

/** Processes and the specific steps where a catalog item is used. */
async function usedIn(db: DB, table: 'node_systems' | 'node_risks' | 'node_controls', id: string) {
  const rows = await db
    .selectFrom(table)
    .innerJoin('nodes', 'nodes.id', `${table}.node_id`)
    .innerJoin('processes', 'processes.id', 'nodes.process_id')
    .select(['processes.id as processId', 'processes.ref', 'processes.name', 'processes.status', 'nodes.id as nodeId', 'nodes.label'])
    .where(`${table}.target_id`, '=', id)
    .orderBy('processes.name')
    .execute();
  const byProcess = new Map<string, { id: string; ref: string; name: string; status: string; steps: Array<{ id: string; label: string }> }>();
  for (const r of rows) {
    const p = byProcess.get(r.processId) ?? { id: r.processId, ref: r.ref, name: r.name, status: r.status, steps: [] };
    p.steps.push({ id: r.nodeId, label: r.label });
    byProcess.set(r.processId, p);
  }
  return [...byProcess.values()];
}

// =================================================================== teams

const TeamFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(5000).default(''),
  department: z.string().max(120).nullish().describe('Parent department / function, e.g. "Finance"'),
  color: Color.optional(),
};

async function teamDtos(db: DB, rows: Array<{ id: string; name: string; description: string; department: string | null; color: string }>) {
  const ids = rows.map((r) => r.id).concat(['-']);
  const [members, owned, steps] = await Promise.all([
    db.selectFrom('team_members').select(['team_id', (eb) => eb.fn.countAll<number>().as('n')]).where('team_id', 'in', ids).groupBy('team_id').execute(),
    db
      .selectFrom('processes')
      .select(['owner_team_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('owner_team_id', 'in', ids)
      .where('status', '!=', 'archived')
      .groupBy('owner_team_id')
      .execute(),
    db
      .selectFrom('nodes')
      .innerJoin('processes', 'processes.id', 'nodes.process_id')
      .select(['nodes.team_id', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.count<number>('nodes.process_id').distinct().as('p')])
      .where('nodes.team_id', 'in', ids)
      .where('processes.status', '!=', 'archived')
      .groupBy('nodes.team_id')
      .execute(),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    department: r.department,
    color: r.color,
    memberCount: Number(members.find((m) => m.team_id === r.id)?.n ?? 0),
    ownedProcessCount: Number(owned.find((m) => m.owner_team_id === r.id)?.n ?? 0),
    stepCount: Number(steps.find((m) => m.team_id === r.id)?.n ?? 0),
    involvedProcessCount: Number(steps.find((m) => m.team_id === r.id)?.p ?? 0),
  }));
}

async function loadTeam(db: DB, id: string) {
  const row = await db.selectFrom('teams').selectAll().where((eb) => eb.or([eb('id', '=', id), eb('name', '=', id)])).executeTakeFirst();
  if (!row) throw new NotFoundError('Team', id);
  return row;
}

export const listTeams = defineOp({
  name: 'team.list',
  group: 'Teams',
  summary: 'List teams',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/teams' },
  input: z.object({ q: z.string().max(200).optional() }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('teams').selectAll();
    const f = textFilter(input.q, ['name', 'description', 'department']);
    if (f) q = q.where((eb) => eb.or(f));
    return teamDtos(ctx.db, await q.orderBy('name').execute());
  },
});

export const getTeam = defineOp({
  name: 'team.get',
  group: 'Teams',
  summary: 'Get a team with members, owned processes and the processes it takes part in',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/teams/:id' },
  input: z.object({ id: Id.describe('Team id or exact name') }),
  handler: async (ctx, input) => {
    const t = await loadTeam(ctx.db, input.id);
    const [dto] = await teamDtos(ctx.db, [t]);
    const [members, owned, involved, systems] = await Promise.all([
      ctx.db
        .selectFrom('team_members')
        .innerJoin('users', 'users.id', 'team_members.user_id')
        .select(['users.id', 'users.name', 'users.email', 'team_members.role'])
        .where('team_id', '=', t.id)
        .orderBy('users.name')
        .execute(),
      ctx.db.selectFrom('processes').select(['id', 'ref', 'name', 'status']).where('owner_team_id', '=', t.id).orderBy('name').execute(),
      ctx.db
        .selectFrom('nodes')
        .innerJoin('processes', 'processes.id', 'nodes.process_id')
        .select(['processes.id', 'processes.ref', 'processes.name', 'processes.status', (eb) => eb.fn.countAll<number>().as('steps')])
        .where('nodes.team_id', '=', t.id)
        .groupBy(['processes.id', 'processes.ref', 'processes.name', 'processes.status'])
        .orderBy('processes.name')
        .execute(),
      ctx.db
        .selectFrom('node_systems')
        .innerJoin('nodes', 'nodes.id', 'node_systems.node_id')
        .innerJoin('systems', 'systems.id', 'node_systems.target_id')
        .select(['systems.id', 'systems.name'])
        .distinct()
        .where('nodes.team_id', '=', t.id)
        .orderBy('systems.name')
        .execute(),
    ]);
    return { ...dto, members, ownedProcesses: owned, involvedProcesses: involved.map((p) => ({ ...p, steps: Number(p.steps) })), systemsUsed: systems };
  },
});

export const createTeam = defineOp({
  name: 'team.create',
  group: 'Teams',
  summary: 'Create a team',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'POST', path: '/teams' },
  targetType: 'team',
  input: z.object(TeamFields),
  handler: async (ctx, input) => {
    const id = newId();
    const now = nowIso();
    await ctx.db
      .insertInto('teams')
      .values({ id, name: input.name, description: input.description, department: input.department ?? null, color: input.color ?? pickColor(input.name), created_at: now, updated_at: now })
      .execute();
    ctx.target.id = id;
    return (await teamDtos(ctx.db, [await loadTeam(ctx.db, id)]))[0];
  },
});

export const updateTeam = defineOp({
  name: 'team.update',
  group: 'Teams',
  summary: 'Update a team',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/teams/:id' },
  targetType: 'team',
  input: z.object({
    id: Id,
    name: TeamFields.name.optional(),
    description: z.string().max(5000).optional(),
    department: TeamFields.department,
    color: Color.optional(),
  }),
  handler: async (ctx, input) => {
    const t = await loadTeam(ctx.db, input.id);
    ctx.target.id = t.id;
    const { id: _id, ...rest } = input;
    const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    await ctx.db.updateTable('teams').set({ ...set, updated_at: nowIso() }).where('id', '=', t.id).execute();
    return (await teamDtos(ctx.db, [await loadTeam(ctx.db, t.id)]))[0];
  },
});

export const deleteTeam = defineOp({
  name: 'team.delete',
  group: 'Teams',
  summary: 'Delete a team',
  description: 'Steps and processes assigned to the team become unassigned.',
  permission: 'catalog:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/teams/:id' },
  targetType: 'team',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const t = await loadTeam(ctx.db, input.id);
    ctx.target.id = t.id;
    ctx.auditDetail = { name: t.name };
    await ctx.db.deleteFrom('teams').where('id', '=', t.id).execute();
    return { deleted: true, id: t.id };
  },
});

export const setTeamMember = defineOp({
  name: 'team.addMember',
  group: 'Teams',
  summary: 'Add a user to a team (or change their team role)',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PUT', path: '/teams/:teamId/members/:userId' },
  targetType: 'team',
  input: z.object({ teamId: Id, userId: Id, role: z.enum(['member', 'lead']).default('member') }),
  handler: async (ctx, input) => {
    const t = await loadTeam(ctx.db, input.teamId);
    ctx.target.id = t.id;
    await assertExists(ctx.db, 'users', [input.userId], 'user');
    await ctx.db
      .insertInto('team_members')
      .values({ team_id: t.id, user_id: input.userId, role: input.role })
      .onConflict((oc) => oc.columns(['team_id', 'user_id']).doUpdateSet({ role: input.role }))
      .execute();
    return { teamId: t.id, userId: input.userId, role: input.role };
  },
});

export const removeTeamMember = defineOp({
  name: 'team.removeMember',
  group: 'Teams',
  summary: 'Remove a user from a team',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'DELETE', path: '/teams/:teamId/members/:userId' },
  targetType: 'team',
  input: z.object({ teamId: Id, userId: Id }),
  handler: async (ctx, input) => {
    const t = await loadTeam(ctx.db, input.teamId);
    ctx.target.id = t.id;
    await ctx.db.deleteFrom('team_members').where('team_id', '=', t.id).where('user_id', '=', input.userId).execute();
    return { removed: true };
  },
});

// =================================================================== systems

const SystemFields = {
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).default(''),
  vendor: z.string().max(200).nullish(),
  category: z.string().max(200).nullish().describe('e.g. ERP, CRM, HRIS, Data warehouse'),
  criticality: z.enum(CRITICALITIES).default('medium'),
  ownerTeamId: z.string().nullish(),
  url: z.string().url().max(2000).nullish(),
};

async function systemDtos(db: DB, rows: Array<{ id: string; name: string; description: string; vendor: string | null; category: string | null; criticality: string; owner_team_id: string | null; url: string | null; updated_at: string }>) {
  const teams = await teamRefs(db, rows.map((r) => r.owner_team_id));
  const use = await usage(db, 'node_systems', rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    vendor: r.vendor,
    category: r.category,
    criticality: r.criticality,
    ownerTeam: r.owner_team_id ? (teams.get(r.owner_team_id) ?? null) : null,
    url: r.url,
    updatedAt: r.updated_at,
    ...use.get(r.id)!,
  }));
}

async function loadSystem(db: DB, id: string) {
  const row = await db.selectFrom('systems').selectAll().where((eb) => eb.or([eb('id', '=', id), eb('name', '=', id)])).executeTakeFirst();
  if (!row) throw new NotFoundError('System', id);
  return row;
}

export const listSystems = defineOp({
  name: 'system.list',
  group: 'Business systems',
  summary: 'List business systems (applications) with usage counts',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/systems' },
  input: z.object({ q: z.string().max(200).optional(), criticality: z.enum(CRITICALITIES).optional() }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('systems').selectAll();
    const f = textFilter(input.q, ['name', 'description', 'vendor', 'category']);
    if (f) q = q.where((eb) => eb.or(f));
    if (input.criticality) q = q.where('criticality', '=', input.criticality);
    return systemDtos(ctx.db, await q.orderBy('name').execute());
  },
});

export const getSystem = defineOp({
  name: 'system.get',
  group: 'Business systems',
  summary: 'Get a business system and every process step that uses it',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/systems/:id' },
  input: z.object({ id: Id.describe('System id or exact name') }),
  handler: async (ctx, input) => {
    const s = await loadSystem(ctx.db, input.id);
    const [dto] = await systemDtos(ctx.db, [s]);
    return { ...dto, usedIn: await usedIn(ctx.db, 'node_systems', s.id) };
  },
});

export const createSystem = defineOp({
  name: 'system.create',
  group: 'Business systems',
  summary: 'Register a business system',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'POST', path: '/systems' },
  targetType: 'system',
  input: z.object(SystemFields),
  handler: async (ctx, input) => {
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    const id = newId();
    const now = nowIso();
    await ctx.db
      .insertInto('systems')
      .values({
        id,
        name: input.name,
        description: input.description,
        vendor: input.vendor ?? null,
        category: input.category ?? null,
        criticality: input.criticality,
        owner_team_id: input.ownerTeamId ?? null,
        url: input.url ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    ctx.target.id = id;
    return (await systemDtos(ctx.db, [await loadSystem(ctx.db, id)]))[0];
  },
});

export const updateSystem = defineOp({
  name: 'system.update',
  group: 'Business systems',
  summary: 'Update a business system',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/systems/:id' },
  targetType: 'system',
  input: z.object({
    id: Id,
    name: SystemFields.name.optional(),
    description: z.string().max(10_000).optional(),
    vendor: SystemFields.vendor,
    category: SystemFields.category,
    criticality: z.enum(CRITICALITIES).optional(),
    ownerTeamId: SystemFields.ownerTeamId,
    url: SystemFields.url,
  }),
  handler: async (ctx, input) => {
    const s = await loadSystem(ctx.db, input.id);
    ctx.target.id = s.id;
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    const set: Record<string, unknown> = { updated_at: nowIso() };
    for (const k of ['name', 'description', 'vendor', 'category', 'criticality', 'url'] as const) if (input[k] !== undefined) set[k] = input[k];
    if (input.ownerTeamId !== undefined) set.owner_team_id = input.ownerTeamId;
    await ctx.db.updateTable('systems').set(set).where('id', '=', s.id).execute();
    return (await systemDtos(ctx.db, [await loadSystem(ctx.db, s.id)]))[0];
  },
});

export const deleteSystem = defineOp({
  name: 'system.delete',
  group: 'Business systems',
  summary: 'Delete a business system (removes it from all steps)',
  permission: 'catalog:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/systems/:id' },
  targetType: 'system',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const s = await loadSystem(ctx.db, input.id);
    ctx.target.id = s.id;
    ctx.auditDetail = { name: s.name };
    await ctx.db.deleteFrom('systems').where('id', '=', s.id).execute();
    return { deleted: true, id: s.id };
  },
});

// =================================================================== risks

export function riskRating(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 20) return 'critical';
  if (score >= 12) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

const RiskFields = {
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  category: z.string().max(200).nullish().describe('e.g. Financial reporting, Fraud, Privacy, Operational'),
  likelihood: z.number().int().min(1).max(5).default(3).describe('1 (rare) – 5 (almost certain)'),
  impact: z.number().int().min(1).max(5).default(3).describe('1 (negligible) – 5 (severe)'),
  status: z.enum(RISK_STATUSES).default('open'),
  ownerTeamId: z.string().nullish(),
  controlIds: z.array(z.string()).max(200).optional().describe('Controls that mitigate this risk'),
};

async function riskDtos(db: DB, rows: Array<{ id: string; ref: string; title: string; description: string; category: string | null; likelihood: number; impact: number; status: string; owner_team_id: string | null; updated_at: string }>) {
  const ids = rows.map((r) => r.id).concat(['-']);
  const [teams, use, links] = await Promise.all([
    teamRefs(db, rows.map((r) => r.owner_team_id)),
    usage(db, 'node_risks', rows.map((r) => r.id)),
    db
      .selectFrom('risk_controls')
      .innerJoin('controls', 'controls.id', 'risk_controls.control_id')
      .select(['risk_controls.risk_id', 'controls.id', 'controls.ref', 'controls.name', 'controls.effectiveness'])
      .where('risk_controls.risk_id', 'in', ids)
      .execute(),
  ]);
  return rows.map((r) => {
    const score = r.likelihood * r.impact;
    const controls = links.filter((l) => l.risk_id === r.id).map(({ risk_id: _r, ...c }) => c);
    return {
      id: r.id,
      ref: r.ref,
      title: r.title,
      description: r.description,
      category: r.category,
      likelihood: r.likelihood,
      impact: r.impact,
      score,
      rating: riskRating(score),
      status: r.status,
      ownerTeam: r.owner_team_id ? (teams.get(r.owner_team_id) ?? null) : null,
      controls,
      controlIds: controls.map((c) => c.id),
      updatedAt: r.updated_at,
      ...use.get(r.id)!,
    };
  });
}

async function loadRisk(db: DB, id: string) {
  const row = await db.selectFrom('risks').selectAll().where((eb) => eb.or([eb('id', '=', id), eb('ref', '=', id)])).executeTakeFirst();
  if (!row) throw new NotFoundError('Risk', id);
  return row;
}

async function setRiskControls(db: DB, riskId: string, controlIds: string[]) {
  await assertExists(db, 'controls', controlIds, 'control ids');
  await db.deleteFrom('risk_controls').where('risk_id', '=', riskId).execute();
  const ids = uniq(controlIds);
  if (ids.length) await db.insertInto('risk_controls').values(ids.map((control_id) => ({ risk_id: riskId, control_id }))).execute();
}

export const listRisks = defineOp({
  name: 'risk.list',
  group: 'Risks & controls',
  summary: 'List risks with scores, mitigating controls and usage',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/risks' },
  input: z.object({ q: z.string().max(200).optional(), status: z.enum(RISK_STATUSES).optional() }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('risks').selectAll();
    const f = textFilter(input.q, ['title', 'ref', 'description', 'category']);
    if (f) q = q.where((eb) => eb.or(f));
    if (input.status) q = q.where('status', '=', input.status);
    return riskDtos(ctx.db, await q.orderBy('ref').execute());
  },
});

export const getRisk = defineOp({
  name: 'risk.get',
  group: 'Risks & controls',
  summary: 'Get a risk and the process steps where it occurs',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/risks/:id' },
  input: z.object({ id: Id.describe('Risk id or reference (RSK-001)') }),
  handler: async (ctx, input) => {
    const r = await loadRisk(ctx.db, input.id);
    const [dto] = await riskDtos(ctx.db, [r]);
    return { ...dto, usedIn: await usedIn(ctx.db, 'node_risks', r.id) };
  },
});

export const createRisk = defineOp({
  name: 'risk.create',
  group: 'Risks & controls',
  summary: 'Register a risk',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'POST', path: '/risks' },
  targetType: 'risk',
  input: z.object(RiskFields),
  handler: async (ctx, input) => {
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    const id = newId();
    const now = nowIso();
    await ctx.db
      .insertInto('risks')
      .values({
        id,
        ref: await nextRef(ctx.db, 'risk', 'RSK', 3),
        title: input.title,
        description: input.description,
        category: input.category ?? null,
        likelihood: input.likelihood,
        impact: input.impact,
        status: input.status,
        owner_team_id: input.ownerTeamId ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (input.controlIds) await setRiskControls(ctx.db, id, input.controlIds);
    ctx.target.id = id;
    return (await riskDtos(ctx.db, [await loadRisk(ctx.db, id)]))[0];
  },
});

export const updateRisk = defineOp({
  name: 'risk.update',
  group: 'Risks & controls',
  summary: 'Update a risk',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/risks/:id' },
  targetType: 'risk',
  input: z.object({
    id: Id,
    title: RiskFields.title.optional(),
    description: z.string().max(10_000).optional(),
    category: RiskFields.category,
    likelihood: z.number().int().min(1).max(5).optional(),
    impact: z.number().int().min(1).max(5).optional(),
    status: z.enum(RISK_STATUSES).optional(),
    ownerTeamId: RiskFields.ownerTeamId,
    controlIds: RiskFields.controlIds,
  }),
  handler: async (ctx, input) => {
    const r = await loadRisk(ctx.db, input.id);
    ctx.target.id = r.id;
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    const set: Record<string, unknown> = { updated_at: nowIso() };
    for (const k of ['title', 'description', 'category', 'likelihood', 'impact', 'status'] as const) if (input[k] !== undefined) set[k] = input[k];
    if (input.ownerTeamId !== undefined) set.owner_team_id = input.ownerTeamId;
    await ctx.db.updateTable('risks').set(set).where('id', '=', r.id).execute();
    if (input.controlIds) await setRiskControls(ctx.db, r.id, input.controlIds);
    return (await riskDtos(ctx.db, [await loadRisk(ctx.db, r.id)]))[0];
  },
});

export const deleteRisk = defineOp({
  name: 'risk.delete',
  group: 'Risks & controls',
  summary: 'Delete a risk',
  permission: 'catalog:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/risks/:id' },
  targetType: 'risk',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const r = await loadRisk(ctx.db, input.id);
    ctx.target.id = r.id;
    ctx.auditDetail = { ref: r.ref, title: r.title };
    await ctx.db.deleteFrom('risks').where('id', '=', r.id).execute();
    return { deleted: true, id: r.id };
  },
});

// =================================================================== controls

const ControlFields = {
  name: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  controlType: z.enum(CONTROL_TYPES).default('preventive'),
  nature: z.enum(CONTROL_NATURES).default('manual'),
  frequency: z.string().max(100).nullish().describe('e.g. Per transaction, Daily, Monthly, Quarterly'),
  effectiveness: z.enum(EFFECTIVENESS).default('not_tested'),
  ownerTeamId: z.string().nullish(),
  riskIds: z.array(z.string()).max(200).optional().describe('Risks this control mitigates'),
};

async function controlDtos(db: DB, rows: Array<{ id: string; ref: string; name: string; description: string; control_type: string; nature: string; frequency: string | null; effectiveness: string; owner_team_id: string | null; updated_at: string }>) {
  const ids = rows.map((r) => r.id).concat(['-']);
  const [teams, use, links] = await Promise.all([
    teamRefs(db, rows.map((r) => r.owner_team_id)),
    usage(db, 'node_controls', rows.map((r) => r.id)),
    db
      .selectFrom('risk_controls')
      .innerJoin('risks', 'risks.id', 'risk_controls.risk_id')
      .select(['risk_controls.control_id', 'risks.id', 'risks.ref', 'risks.title'])
      .where('risk_controls.control_id', 'in', ids)
      .execute(),
  ]);
  return rows.map((r) => {
    const risks = links.filter((l) => l.control_id === r.id).map(({ control_id: _c, ...x }) => x);
    return {
      id: r.id,
      ref: r.ref,
      name: r.name,
      description: r.description,
      controlType: r.control_type,
      nature: r.nature,
      frequency: r.frequency,
      effectiveness: r.effectiveness,
      ownerTeam: r.owner_team_id ? (teams.get(r.owner_team_id) ?? null) : null,
      risks,
      riskIds: risks.map((x) => x.id),
      updatedAt: r.updated_at,
      ...use.get(r.id)!,
    };
  });
}

async function loadControl(db: DB, id: string) {
  const row = await db.selectFrom('controls').selectAll().where((eb) => eb.or([eb('id', '=', id), eb('ref', '=', id)])).executeTakeFirst();
  if (!row) throw new NotFoundError('Control', id);
  return row;
}

async function setControlRisks(db: DB, controlId: string, riskIds: string[]) {
  await assertExists(db, 'risks', riskIds, 'risk ids');
  await db.deleteFrom('risk_controls').where('control_id', '=', controlId).execute();
  const ids = uniq(riskIds);
  if (ids.length) await db.insertInto('risk_controls').values(ids.map((risk_id) => ({ risk_id, control_id: controlId }))).execute();
}

export const listControls = defineOp({
  name: 'control.list',
  group: 'Risks & controls',
  summary: 'List controls with the risks they mitigate and usage',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/controls' },
  input: z.object({ q: z.string().max(200).optional(), effectiveness: z.enum(EFFECTIVENESS).optional() }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('controls').selectAll();
    const f = textFilter(input.q, ['name', 'ref', 'description', 'frequency']);
    if (f) q = q.where((eb) => eb.or(f));
    if (input.effectiveness) q = q.where('effectiveness', '=', input.effectiveness);
    return controlDtos(ctx.db, await q.orderBy('ref').execute());
  },
});

export const getControl = defineOp({
  name: 'control.get',
  group: 'Risks & controls',
  summary: 'Get a control and the process steps where it is performed',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/controls/:id' },
  input: z.object({ id: Id.describe('Control id or reference (CTL-001)') }),
  handler: async (ctx, input) => {
    const c = await loadControl(ctx.db, input.id);
    const [dto] = await controlDtos(ctx.db, [c]);
    return { ...dto, usedIn: await usedIn(ctx.db, 'node_controls', c.id) };
  },
});

export const createControl = defineOp({
  name: 'control.create',
  group: 'Risks & controls',
  summary: 'Register a control',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'POST', path: '/controls' },
  targetType: 'control',
  input: z.object(ControlFields),
  handler: async (ctx, input) => {
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    const id = newId();
    const now = nowIso();
    await ctx.db
      .insertInto('controls')
      .values({
        id,
        ref: await nextRef(ctx.db, 'control', 'CTL', 3),
        name: input.name,
        description: input.description,
        control_type: input.controlType,
        nature: input.nature,
        frequency: input.frequency ?? null,
        effectiveness: input.effectiveness,
        owner_team_id: input.ownerTeamId ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (input.riskIds) await setControlRisks(ctx.db, id, input.riskIds);
    ctx.target.id = id;
    return (await controlDtos(ctx.db, [await loadControl(ctx.db, id)]))[0];
  },
});

export const updateControl = defineOp({
  name: 'control.update',
  group: 'Risks & controls',
  summary: 'Update a control',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/controls/:id' },
  targetType: 'control',
  input: z.object({
    id: Id,
    name: ControlFields.name.optional(),
    description: z.string().max(10_000).optional(),
    controlType: z.enum(CONTROL_TYPES).optional(),
    nature: z.enum(CONTROL_NATURES).optional(),
    frequency: ControlFields.frequency,
    effectiveness: z.enum(EFFECTIVENESS).optional(),
    ownerTeamId: ControlFields.ownerTeamId,
    riskIds: ControlFields.riskIds,
  }),
  handler: async (ctx, input) => {
    const c = await loadControl(ctx.db, input.id);
    ctx.target.id = c.id;
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    const set: Record<string, unknown> = { updated_at: nowIso() };
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (input.controlType !== undefined) set.control_type = input.controlType;
    if (input.nature !== undefined) set.nature = input.nature;
    if (input.frequency !== undefined) set.frequency = input.frequency;
    if (input.effectiveness !== undefined) set.effectiveness = input.effectiveness;
    if (input.ownerTeamId !== undefined) set.owner_team_id = input.ownerTeamId;
    await ctx.db.updateTable('controls').set(set).where('id', '=', c.id).execute();
    if (input.riskIds) await setControlRisks(ctx.db, c.id, input.riskIds);
    return (await controlDtos(ctx.db, [await loadControl(ctx.db, c.id)]))[0];
  },
});

export const deleteControl = defineOp({
  name: 'control.delete',
  group: 'Risks & controls',
  summary: 'Delete a control',
  permission: 'catalog:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/controls/:id' },
  targetType: 'control',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const c = await loadControl(ctx.db, input.id);
    ctx.target.id = c.id;
    ctx.auditDetail = { ref: c.ref, name: c.name };
    await ctx.db.deleteFrom('controls').where('id', '=', c.id).execute();
    return { deleted: true, id: c.id };
  },
});

// =================================================================== tags

async function tagDtos(ctx: OpContext) {
  const rows = await ctx.db
    .selectFrom('tags')
    .leftJoin('process_tags', 'process_tags.tag_id', 'tags.id')
    .select(['tags.id', 'tags.name', 'tags.color', (eb) => eb.fn.count<number>('process_tags.process_id').as('n')])
    .groupBy(['tags.id', 'tags.name', 'tags.color'])
    .orderBy('tags.name')
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, processCount: Number(r.n) }));
}

export const listTags = defineOp({
  name: 'tag.list',
  group: 'Tags',
  summary: 'List tags with process counts',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/tags' },
  input: z.object({}),
  handler: async (ctx) => tagDtos(ctx),
});

export const createTag = defineOp({
  name: 'tag.create',
  group: 'Tags',
  summary: 'Create a tag',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'POST', path: '/tags' },
  targetType: 'tag',
  input: z.object({ name: z.string().min(1).max(60), color: Color.optional() }),
  handler: async (ctx, input) => {
    const id = newId();
    await ctx.db.insertInto('tags').values({ id, name: input.name.trim(), color: input.color ?? pickColor(input.name), created_at: nowIso() }).execute();
    ctx.target.id = id;
    return (await tagDtos(ctx)).find((t) => t.id === id)!;
  },
});

export const updateTag = defineOp({
  name: 'tag.update',
  group: 'Tags',
  summary: 'Rename or recolour a tag',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/tags/:id' },
  targetType: 'tag',
  input: z.object({ id: Id, name: z.string().min(1).max(60).optional(), color: Color.optional() }),
  handler: async (ctx, input) => {
    const set: Record<string, unknown> = {};
    if (input.name) set.name = input.name.trim();
    if (input.color) set.color = input.color;
    if (!Object.keys(set).length) throw new ValidationError('Nothing to update');
    const res = await ctx.db.updateTable('tags').set(set).where('id', '=', input.id).executeTakeFirst();
    if (!Number(res.numUpdatedRows)) throw new NotFoundError('Tag', input.id);
    ctx.target.id = input.id;
    return (await tagDtos(ctx)).find((t) => t.id === input.id)!;
  },
});

export const deleteTag = defineOp({
  name: 'tag.delete',
  group: 'Tags',
  summary: 'Delete a tag (removes it from all processes)',
  permission: 'catalog:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/tags/:id' },
  targetType: 'tag',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    ctx.target.id = input.id;
    const res = await ctx.db.deleteFrom('tags').where('id', '=', input.id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundError('Tag', input.id);
    return { deleted: true, id: input.id };
  },
});

export const catalogOps = [
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  setTeamMember,
  removeTeamMember,
  listSystems,
  getSystem,
  createSystem,
  updateSystem,
  deleteSystem,
  listRisks,
  getRisk,
  createRisk,
  updateRisk,
  deleteRisk,
  listControls,
  getControl,
  createControl,
  updateControl,
  deleteControl,
  listTags,
  createTag,
  updateTag,
  deleteTag,
];

import { sql } from 'kysely';
import { z } from 'zod';
import { defineOp } from '../core/operation.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import type { AgentRow, DB } from '../db/schema.js';
import { likeEscape, newId, nowIso, uniq } from '../lib/util.js';
import {
  AGENT_EXECUTED,
  AGENT_RISK_TIERS,
  AGENT_STATUSES,
  AUTOMATION_LEVELS,
  Id,
  assertExists,
  partialShape,
  teamRefs,
} from './shared.js';
import { riskRating } from './catalog.js';
import { delegationIssues } from './agent-rules.js';

const G = 'AI agents';

const AgentFields = {
  name: z.string().min(1).max(200).describe('e.g. "Invoice Coding Agent"'),
  description: z.string().max(10_000).default('').describe('What the agent does and its boundaries'),
  provider: z.string().max(200).nullish().describe('Model / vendor, e.g. Anthropic, OpenAI, in-house'),
  model: z.string().max(200).nullish().describe('Model or version, e.g. claude-sonnet-4-5'),
  platform: z.string().max(200).nullish().describe('Where it runs, e.g. Claude Agent SDK, Copilot Studio, UiPath, custom service'),
  ownerTeamId: z.string().nullish().describe('Team accountable for the agent'),
  status: z.enum(AGENT_STATUSES).default('proposed'),
  riskTier: z.enum(AGENT_RISK_TIERS).default('limited').describe('minimal | limited | high (e.g. per your AI policy or the EU AI Act)'),
  dataAccess: z.string().max(5000).nullish().describe('Data the agent can read or write and its classification'),
  serviceAccountId: z.string().nullish().describe('Streamline service account the agent uses (its API/MCP identity)'),
  documentationUrl: z.string().url().max(2000).nullish(),
  nextReviewAt: z.string().max(40).nullish().describe('ISO date of the next governance review'),
  systemIds: z.array(z.string()).max(200).optional().describe('Business systems / tools the agent can access'),
};

type DelegationCounts = { assisted: number; supervised: number; autonomous: number };

async function agentDtos(db: DB, rows: AgentRow[]) {
  const ids = rows.map((r) => r.id).concat(['-']);
  const [teams, systems, accounts, steps, procs] = await Promise.all([
    teamRefs(db, rows.map((r) => r.owner_team_id)),
    db
      .selectFrom('agent_systems')
      .innerJoin('systems', 'systems.id', 'agent_systems.system_id')
      .select(['agent_systems.agent_id', 'systems.id', 'systems.name'])
      .where('agent_systems.agent_id', 'in', ids)
      .execute(),
    db
      .selectFrom('users')
      .select(['id', 'name', 'email', 'status'])
      .where('id', 'in', rows.map((r) => r.service_account_id ?? '-').concat(['-']))
      .execute(),
    db
      .selectFrom('nodes')
      .innerJoin('processes', 'processes.id', 'nodes.process_id')
      .select(['nodes.agent_id', 'nodes.automation_level', 'nodes.process_id'])
      .where('nodes.agent_id', 'in', ids)
      .where('processes.status', '!=', 'archived')
      .execute(),
    db.selectFrom('processes').select(['id', 'agent_id', 'automation_level']).where('agent_id', 'in', ids).where('status', '!=', 'archived').execute(),
  ]);
  return rows.map((r) => {
    const mySteps = steps.filter((s) => s.agent_id === r.id);
    const delegations: DelegationCounts = { assisted: 0, supervised: 0, autonomous: 0 };
    for (const s of mySteps) if (s.automation_level in delegations) delegations[s.automation_level as keyof DelegationCounts]++;
    const account = accounts.find((a) => a.id === r.service_account_id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      provider: r.provider,
      model: r.model,
      platform: r.platform,
      ownerTeam: r.owner_team_id ? (teams.get(r.owner_team_id) ?? null) : null,
      status: r.status,
      riskTier: r.risk_tier,
      dataAccess: r.data_access,
      serviceAccount: account ?? null,
      documentationUrl: r.documentation_url,
      nextReviewAt: r.next_review_at,
      systems: systems.filter((s) => s.agent_id === r.id).map(({ id, name }) => ({ id, name })),
      systemIds: systems.filter((s) => s.agent_id === r.id).map((s) => s.id),
      stepCount: mySteps.length,
      processCount: uniq([...mySteps.map((s) => s.process_id), ...procs.filter((p) => p.agent_id === r.id).map((p) => p.id)]).length,
      wholeProcessCount: procs.filter((p) => p.agent_id === r.id).length,
      delegations,
      updatedAt: r.updated_at,
    };
  });
}

async function loadAgent(db: DB, id: string) {
  const row = await db.selectFrom('agents').selectAll().where((eb) => eb.or([eb('id', '=', id), eb('name', '=', id)])).executeTakeFirst();
  if (!row) throw new NotFoundError('Agent', id);
  return row;
}

async function validateAgentRefs(db: DB, input: { ownerTeamId?: string | null; serviceAccountId?: string | null; systemIds?: string[] }) {
  await assertExists(db, 'teams', [input.ownerTeamId], 'owner team');
  await assertExists(db, 'systems', input.systemIds ?? [], 'system ids');
  if (input.serviceAccountId) {
    const u = await db.selectFrom('users').select(['kind']).where('id', '=', input.serviceAccountId).executeTakeFirst();
    if (!u) throw new ValidationError(`Unknown user ${input.serviceAccountId}`);
    if (u.kind !== 'service') throw new ValidationError('The linked account must be a service account, not a person');
  }
}

async function setAgentSystems(db: DB, agentId: string, systemIds: string[]) {
  await db.deleteFrom('agent_systems').where('agent_id', '=', agentId).execute();
  const ids = uniq(systemIds);
  if (ids.length) await db.insertInto('agent_systems').values(ids.map((system_id) => ({ agent_id: agentId, system_id }))).execute();
}

export const listAgents = defineOp({
  name: 'agent.list',
  group: G,
  summary: 'List AI agents in the agent register, with delegation counts',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/agents' },
  input: z.object({ q: z.string().max(200).optional(), status: z.enum(AGENT_STATUSES).optional() }),
  handler: async (ctx, input) => {
    let q = ctx.db.selectFrom('agents').selectAll();
    if (input.q) {
      const like = `%${likeEscape(input.q.toLowerCase())}%`;
      q = q.where((eb) =>
        eb.or(['name', 'description', 'provider', 'model', 'platform'].map((c) => sql<boolean>`lower(coalesce(${sql.ref(c)}, '')) like ${like} escape '\\'`)),
      );
    }
    if (input.status) q = q.where('status', '=', input.status);
    return agentDtos(ctx.db, await q.orderBy('name').execute());
  },
});

export const getAgent = defineOp({
  name: 'agent.get',
  group: G,
  summary: 'Get an AI agent and every process step delegated to it',
  permission: 'catalog:read',
  kind: 'read',
  http: { method: 'GET', path: '/agents/:id' },
  input: z.object({ id: Id.describe('Agent id or exact name') }),
  handler: async (ctx, input) => {
    const a = await loadAgent(ctx.db, input.id);
    const [dto] = await agentDtos(ctx.db, [a]);
    const [steps, processes] = await Promise.all([
      ctx.db
        .selectFrom('nodes')
        .innerJoin('processes', 'processes.id', 'nodes.process_id')
        .leftJoin('teams', 'teams.id', 'nodes.team_id')
        .select([
          'processes.id as processId',
          'processes.ref',
          'processes.name as processName',
          'processes.status',
          'nodes.id',
          'nodes.label',
          'nodes.automation_level',
          'nodes.oversight',
          'teams.name as teamName',
        ])
        .where('nodes.agent_id', '=', a.id)
        .orderBy('processes.name')
        .execute(),
      ctx.db.selectFrom('processes').select(['id', 'ref', 'name', 'status', 'automation_level', 'oversight']).where('agent_id', '=', a.id).orderBy('name').execute(),
    ]);
    return {
      ...dto,
      delegatedSteps: steps.map((s) => ({
        processId: s.processId,
        processRef: s.ref,
        processName: s.processName,
        processStatus: s.status,
        stepId: s.id,
        step: s.label,
        automationLevel: s.automation_level,
        oversight: s.oversight,
        accountableTeam: s.teamName,
      })),
      delegatedProcesses: processes.map((p) => ({ id: p.id, ref: p.ref, name: p.name, status: p.status, automationLevel: p.automation_level, oversight: p.oversight })),
    };
  },
});

export const createAgent = defineOp({
  name: 'agent.create',
  group: G,
  summary: 'Register an AI agent',
  description: 'Add an agent to the register before delegating process steps (or whole processes) to it.',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'POST', path: '/agents' },
  targetType: 'agent',
  input: z.object(AgentFields),
  handler: async (ctx, input) => {
    await validateAgentRefs(ctx.db, input);
    const id = newId();
    const now = nowIso();
    await ctx.db
      .insertInto('agents')
      .values({
        id,
        name: input.name,
        description: input.description,
        provider: input.provider ?? null,
        model: input.model ?? null,
        platform: input.platform ?? null,
        owner_team_id: input.ownerTeamId ?? null,
        status: input.status,
        risk_tier: input.riskTier,
        data_access: input.dataAccess ?? null,
        service_account_id: input.serviceAccountId ?? null,
        documentation_url: input.documentationUrl ?? null,
        next_review_at: input.nextReviewAt ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (input.systemIds) await setAgentSystems(ctx.db, id, input.systemIds);
    ctx.target.id = id;
    return (await agentDtos(ctx.db, [await loadAgent(ctx.db, id)]))[0];
  },
});

export const updateAgent = defineOp({
  name: 'agent.update',
  group: G,
  summary: 'Update an AI agent (e.g. promote from pilot to production, or suspend it)',
  permission: 'catalog:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/agents/:id' },
  targetType: 'agent',
  input: z.object({ id: Id, ...partialShape(AgentFields) }),
  handler: async (ctx, input) => {
    const a = await loadAgent(ctx.db, input.id);
    ctx.target.id = a.id;
    await validateAgentRefs(ctx.db, input);
    const map: Record<string, string> = {
      name: 'name',
      description: 'description',
      provider: 'provider',
      model: 'model',
      platform: 'platform',
      ownerTeamId: 'owner_team_id',
      status: 'status',
      riskTier: 'risk_tier',
      dataAccess: 'data_access',
      serviceAccountId: 'service_account_id',
      documentationUrl: 'documentation_url',
      nextReviewAt: 'next_review_at',
    };
    const set: Record<string, unknown> = { updated_at: nowIso() };
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) set[col] = v;
    }
    await ctx.db.updateTable('agents').set(set).where('id', '=', a.id).execute();
    if (input.systemIds) await setAgentSystems(ctx.db, a.id, input.systemIds);
    ctx.auditDetail = { before: { status: a.status, riskTier: a.risk_tier } };
    return (await agentDtos(ctx.db, [await loadAgent(ctx.db, a.id)]))[0];
  },
});

export const deleteAgent = defineOp({
  name: 'agent.delete',
  group: G,
  summary: 'Remove an AI agent from the register',
  description: 'Steps delegated to it keep their automation level but lose the agent reference (they will show as governance gaps). Prefer status "retired".',
  permission: 'catalog:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/agents/:id' },
  targetType: 'agent',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const a = await loadAgent(ctx.db, input.id);
    ctx.target.id = a.id;
    ctx.auditDetail = { name: a.name };
    await ctx.db.deleteFrom('agents').where('id', '=', a.id).execute();
    return { deleted: true, id: a.id };
  },
});

/**
 * The AI register: where work has been delegated to agents across the whole
 * repository, how much autonomy each delegation has, and the governance gaps.
 */
export const aiRegister = defineOp({
  name: 'analytics.aiDelegation',
  group: 'Analytics',
  summary: 'AI delegation register: where work is delegated to AI agents, at what autonomy, and governance gaps',
  description:
    'Summarises delegated steps and processes by automation level and agent, and flags gaps: delegations without an agent or human oversight, autonomous steps carrying high or critical risks without a control, agents in use that are not in production, agents without an accountable owner or past their review date.',
  permission: 'analytics:read',
  kind: 'read',
  http: { method: 'GET', path: '/analytics/ai-delegation' },
  input: z.object({}),
  handler: async (ctx) => {
    const db = ctx.db;
    const [agents, nodes, processes, nodeRisks, nodeControls, risks, riskControls] = await Promise.all([
      db.selectFrom('agents').selectAll().orderBy('name').execute(),
      db
        .selectFrom('nodes')
        .innerJoin('processes', 'processes.id', 'nodes.process_id')
        .select(['nodes.id', 'nodes.label', 'nodes.type', 'nodes.agent_id', 'nodes.automation_level', 'nodes.oversight', 'nodes.process_id', 'processes.ref', 'processes.name as process_name'])
        .where('processes.status', '!=', 'archived')
        .execute(),
      db.selectFrom('processes').select(['id', 'ref', 'name', 'agent_id', 'automation_level', 'oversight']).where('status', '!=', 'archived').execute(),
      db.selectFrom('node_risks').select(['node_id', 'target_id']).execute(),
      db.selectFrom('node_controls').select(['node_id', 'target_id']).execute(),
      db.selectFrom('risks').select(['id', 'ref', 'title', 'likelihood', 'impact']).execute(),
      db.selectFrom('risk_controls').select(['risk_id', 'control_id']).execute(),
    ]);
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const riskMap = new Map(risks.map((r) => [r.id, r]));
    const work = nodes.filter((n) => !['start', 'end', 'note', 'decision', 'event'].includes(n.type));
    const delegated = nodes.filter((n) => n.automation_level !== 'manual');

    const byLevel = Object.fromEntries(AUTOMATION_LEVELS.map((l) => [l, 0])) as Record<string, number>;
    for (const n of work) byLevel[n.automation_level] = (byLevel[n.automation_level] ?? 0) + 1;

    // Gaps
    const missing = [
      ...delegationIssues(processes.map((p) => ({ label: `${p.ref} ${p.name} (whole process)`, agentId: p.agent_id, automationLevel: p.automation_level, oversight: p.oversight }))),
      ...delegated.flatMap((n) => delegationIssues([{ label: n.label, agentId: n.agent_id, automationLevel: n.automation_level, oversight: n.oversight }]).map((i) => `${n.ref}: ${i}`)),
    ];
    const autonomousHighRisk = nodes
      .filter((n) => n.automation_level === 'autonomous')
      .flatMap((n) => {
        const controlsHere = new Set(nodeControls.filter((c) => c.node_id === n.id).map((c) => c.target_id));
        return nodeRisks
          .filter((r) => r.node_id === n.id)
          .map((r) => riskMap.get(r.target_id))
          .filter((r): r is NonNullable<typeof r> => Boolean(r) && ['high', 'critical'].includes(riskRating(r!.likelihood * r!.impact)))
          .filter((r) => !riskControls.some((rc) => rc.risk_id === r.id && controlsHere.has(rc.control_id)))
          .map((r) => ({ processId: n.process_id, process: `${n.ref} ${n.process_name}`, stepId: n.id, step: n.label, riskId: r.id, risk: `${r.ref} ${r.title}`, rating: riskRating(r.likelihood * r.impact) }));
      });
    const usedAgentIds = new Set([...delegated.map((n) => n.agent_id), ...processes.filter((p) => p.automation_level !== 'manual').map((p) => p.agent_id)].filter(Boolean) as string[]);
    const today = nowIso();
    const agentIssues = agents.flatMap((a) => {
      const issues: string[] = [];
      if (usedAgentIds.has(a.id) && a.status !== 'production' && a.status !== 'pilot') issues.push(`in use but status is ${a.status}`);
      if (!a.owner_team_id) issues.push('no accountable owner team');
      if (a.next_review_at && a.next_review_at < today) issues.push('governance review overdue');
      if (a.risk_tier === 'high' && !a.data_access) issues.push('high-risk agent without documented data access');
      return issues.length ? [{ id: a.id, name: a.name, issues }] : [];
    });

    // Per-agent rows
    const perAgent = agents.map((a) => {
      const mine = delegated.filter((n) => n.agent_id === a.id);
      const levels: DelegationCounts = { assisted: 0, supervised: 0, autonomous: 0 };
      for (const n of mine) if (n.automation_level in levels) levels[n.automation_level as keyof DelegationCounts]++;
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        riskTier: a.risk_tier,
        provider: a.provider,
        steps: mine.length,
        processes: uniq([...mine.map((n) => n.process_id), ...processes.filter((p) => p.agent_id === a.id).map((p) => p.id)]).length,
        levels,
      };
    });

    return {
      totals: {
        workSteps: work.length,
        delegatedSteps: work.filter((n) => n.automation_level !== 'manual').length,
        agentExecutedSteps: work.filter((n) => AGENT_EXECUTED.has(n.automation_level)).length,
        delegatedProcesses: processes.filter((p) => p.automation_level !== 'manual').length,
        processesWithDelegation: uniq([...delegated.map((n) => n.process_id), ...processes.filter((p) => p.automation_level !== 'manual').map((p) => p.id)]).length,
        agents: agents.length,
        agentsInProduction: agents.filter((a) => a.status === 'production').length,
      },
      stepsByAutomationLevel: byLevel,
      agents: perAgent,
      delegations: [
        ...processes
          .filter((p) => p.automation_level !== 'manual')
          .map((p) => ({ scope: 'process' as const, processId: p.id, process: `${p.ref} ${p.name}`, stepId: null, step: null, agent: p.agent_id ? (agentMap.get(p.agent_id)?.name ?? null) : null, agentId: p.agent_id, automationLevel: p.automation_level, oversight: p.oversight })),
        ...delegated.map((n) => ({ scope: 'step' as const, processId: n.process_id, process: `${n.ref} ${n.process_name}`, stepId: n.id, step: n.label, agent: n.agent_id ? (agentMap.get(n.agent_id)?.name ?? null) : null, agentId: n.agent_id, automationLevel: n.automation_level, oversight: n.oversight })),
      ].sort((a, b) => a.process.localeCompare(b.process)),
      gaps: { incompleteDelegations: missing, autonomousHighRiskUncontrolled: autonomousHighRisk, agentIssues },
    };
  },
});

export const agentOps = [listAgents, getAgent, createAgent, updateAgent, deleteAgent, aiRegister];

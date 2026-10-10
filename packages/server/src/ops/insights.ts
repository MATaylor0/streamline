import { sql, type Expression, type SqlBool } from 'kysely';
import { z } from 'zod';
import { defineOp } from '../core/operation.js';
import { ForbiddenError, NotFoundError } from '../core/errors.js';
import type { DB } from '../db/schema.js';
import { addDays, likeEscape, newId, nowIso, toBool, uniq } from '../lib/util.js';
import { Id, StringList, loadProcess } from './shared.js';
import { riskRating } from './catalog.js';

// =================================================================== search

const SEARCH_TYPES = ['process', 'step', 'team', 'system', 'risk', 'control'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string | null;
  snippet: string | null;
  processId: string | null;
  score: number;
}

function snippet(text: string | null | undefined, terms: string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const idx = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (idx === undefined) return null;
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + 100);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

function score(fields: Array<[string | null | undefined, number]>, terms: string[]): number {
  let s = 0;
  for (const t of terms)
    for (const [v, w] of fields) {
      const l = (v ?? '').toLowerCase();
      if (l === t) s += w * 3;
      else if (l.startsWith(t)) s += w * 2;
      else if (l.includes(t)) s += w;
    }
  return s;
}

/** AND across terms, OR across columns (+ optional extra per-term expressions). */
function termFilter(terms: string[], cols: string[], extra?: (like: string) => Expression<SqlBool>[]) {
  return (eb: { and: (e: Expression<SqlBool>[]) => Expression<SqlBool>; or: (e: Expression<SqlBool>[]) => Expression<SqlBool> }) =>
    eb.and(
      terms.map((t) => {
        const like = `%${likeEscape(t)}%`;
        return eb.or([
          ...cols.map((c) => sql<SqlBool>`lower(coalesce(${sql.ref(c)}, '')) like ${like} escape '\\'`),
          ...(extra ? extra(like) : []),
        ]);
      }),
    );
}

export async function runSearch(db: DB, q: string, types: SearchType[], limit: number, includeArchived: boolean): Promise<SearchHit[]> {
  const terms = uniq(q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean)).slice(0, 8);
  if (!terms.length) return [];
  const want = (t: SearchType) => types.length === 0 || types.includes(t);
  const per = Math.min(200, limit * 2);
  const hits: SearchHit[] = [];

  if (want('process')) {
    let qb = db
      .selectFrom('processes')
      .selectAll()
      .where(
        termFilter(terms, ['name', 'ref', 'summary', 'description', 'category'], (like) => [
          sql<SqlBool>`id in (select pt.process_id from process_tags pt join tags t on t.id = pt.tag_id where lower(t.name) like ${like} escape '\\')`,
        ]),
      );
    if (!includeArchived) qb = qb.where('status', '!=', 'archived');
    for (const r of await qb.limit(per).execute()) {
      hits.push({
        type: 'process',
        id: r.id,
        title: r.name,
        subtitle: `${r.ref} · ${r.status}${r.category ? ` · ${r.category}` : ''}`,
        snippet: snippet(r.summary, terms) ?? snippet(r.description, terms) ?? r.summary.slice(0, 160),
        processId: r.id,
        score: score([[r.name, 10], [r.ref, 8], [r.category, 3], [r.summary, 2], [r.description, 1]], terms) + 5,
      });
    }
  }

  if (want('step')) {
    let qb = db
      .selectFrom('nodes')
      .innerJoin('processes', 'processes.id', 'nodes.process_id')
      .select(['nodes.id', 'nodes.label', 'nodes.description', 'nodes.actor_role', 'nodes.type', 'processes.id as pid', 'processes.name as pname', 'processes.ref as pref'])
      .where(termFilter(terms, ['nodes.label', 'nodes.description', 'nodes.actor_role', 'nodes.inputs', 'nodes.outputs']));
    if (!includeArchived) qb = qb.where('processes.status', '!=', 'archived');
    for (const r of await qb.limit(per).execute()) {
      hits.push({
        type: 'step',
        id: r.id,
        title: r.label,
        subtitle: `Step in ${r.pref} ${r.pname}`,
        snippet: snippet(r.description, terms),
        processId: r.pid,
        score: score([[r.label, 6], [r.actor_role, 3], [r.description, 1]], terms),
      });
    }
  }

  if (want('team')) {
    for (const r of await db.selectFrom('teams').selectAll().where(termFilter(terms, ['name', 'description', 'department'])).limit(per).execute()) {
      hits.push({ type: 'team', id: r.id, title: r.name, subtitle: r.department ? `Team · ${r.department}` : 'Team', snippet: snippet(r.description, terms), processId: null, score: score([[r.name, 8], [r.department, 3], [r.description, 1]], terms) + 2 });
    }
  }
  if (want('system')) {
    for (const r of await db.selectFrom('systems').selectAll().where(termFilter(terms, ['name', 'description', 'vendor', 'category'])).limit(per).execute()) {
      hits.push({ type: 'system', id: r.id, title: r.name, subtitle: ['System', r.vendor, r.category].filter(Boolean).join(' · '), snippet: snippet(r.description, terms), processId: null, score: score([[r.name, 8], [r.vendor, 3], [r.category, 3], [r.description, 1]], terms) + 2 });
    }
  }
  if (want('risk')) {
    for (const r of await db.selectFrom('risks').selectAll().where(termFilter(terms, ['title', 'ref', 'description', 'category'])).limit(per).execute()) {
      hits.push({ type: 'risk', id: r.id, title: r.title, subtitle: `${r.ref} · Risk · ${riskRating(r.likelihood * r.impact)}`, snippet: snippet(r.description, terms), processId: null, score: score([[r.title, 8], [r.ref, 8], [r.category, 3], [r.description, 1]], terms) + 1 });
    }
  }
  if (want('control')) {
    for (const r of await db.selectFrom('controls').selectAll().where(termFilter(terms, ['name', 'ref', 'description', 'frequency'])).limit(per).execute()) {
      hits.push({ type: 'control', id: r.id, title: r.name, subtitle: `${r.ref} · Control · ${r.control_type}`, snippet: snippet(r.description, terms), processId: null, score: score([[r.name, 8], [r.ref, 8], [r.description, 1]], terms) + 1 });
    }
  }

  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

export const search = defineOp({
  name: 'search.query',
  group: 'Search',
  summary: 'Keyword search across processes, steps, teams, systems, risks and controls',
  description: 'All terms must match (in any searchable field). Results are ranked by relevance; titles weigh most.',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/search' },
  input: z.object({
    q: z.string().min(1).max(200).describe('Keywords'),
    types: StringList.pipe(z.array(z.enum(SEARCH_TYPES))).optional().describe(`Restrict to: ${SEARCH_TYPES.join(', ')}`),
    includeArchived: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(200).default(30),
  }),
  handler: async (ctx, input) => {
    const items = await runSearch(ctx.db, input.q, input.types ?? [], input.limit, input.includeArchived);
    const counts: Record<string, number> = {};
    for (const h of items) counts[h.type] = (counts[h.type] ?? 0) + 1;
    return { query: input.q, items, counts };
  },
});

// =================================================================== analytics

const ProcessScope = {
  statuses: StringList.optional().describe('Process statuses to include (default: everything except archived)'),
  tag: z.string().optional().describe('Only processes with this tag'),
  processIds: StringList.optional().describe('Only these processes'),
};

async function scopedProcesses(db: DB, scope: { statuses?: string[]; tag?: string; processIds?: string[] }) {
  let q = db.selectFrom('processes').select(['id', 'ref', 'name', 'status', 'owner_team_id', 'category']);
  if (scope.statuses?.length) q = q.where('status', 'in', scope.statuses);
  else q = q.where('status', '!=', 'archived');
  if (scope.processIds?.length) q = q.where('id', 'in', scope.processIds);
  if (scope.tag) {
    q = q.where('id', 'in', (eb) =>
      eb.selectFrom('process_tags').innerJoin('tags', 'tags.id', 'process_tags.tag_id').select('process_tags.process_id').where('tags.name', '=', scope.tag!),
    );
  }
  return q.execute();
}

/**
 * Computes the team-to-team handoff graph from process diagrams. A handoff is
 * a flow from a step owned by one team to the next step owned by a different
 * team; steps with no team (e.g. gateways) are traversed transparently.
 */
export async function computeTeamGraph(db: DB, scope: { statuses?: string[]; tag?: string; processIds?: string[] }) {
  const processes = await scopedProcesses(db, scope);
  const pids = processes.map((p) => p.id).concat(['-']);
  const [teams, nodes, edges, sysLinks] = await Promise.all([
    db.selectFrom('teams').selectAll().orderBy('name').execute(),
    db.selectFrom('nodes').select(['id', 'process_id', 'team_id', 'label', 'type']).where('process_id', 'in', pids).execute(),
    db.selectFrom('edges').select(['process_id', 'source_node_id', 'target_node_id']).where('process_id', 'in', pids).execute(),
    db
      .selectFrom('node_systems')
      .innerJoin('nodes', 'nodes.id', 'node_systems.node_id')
      .select(['nodes.team_id', 'node_systems.target_id'])
      .where('nodes.process_id', 'in', pids)
      .execute(),
  ]);
  const pmap = new Map(processes.map((p) => [p.id, p]));
  const nmap = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source_node_id, [...(out.get(e.source_node_id) ?? []), e.target_node_id]);

  /** Next steps that have a team, walking through unassigned ones. */
  const nextTeamed = (start: string): string[] => {
    const found: string[] = [];
    const seen = new Set<string>([start]);
    const stack = [...(out.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = nmap.get(id);
      if (!n) continue;
      if (n.team_id) found.push(id);
      else stack.push(...(out.get(id) ?? []));
    }
    return found;
  };

  type Link = { from: string; to: string; count: number; processes: Map<string, { id: string; ref: string; name: string; handoffs: Array<{ from: string; to: string }> }> };
  const links = new Map<string, Link>();
  for (const n of nodes) {
    if (!n.team_id) continue;
    for (const tid of nextTeamed(n.id)) {
      const t = nmap.get(tid)!;
      if (t.team_id === n.team_id) continue;
      const key = `${n.team_id}>${t.team_id}`;
      const link = links.get(key) ?? { from: n.team_id, to: t.team_id!, count: 0, processes: new Map() };
      link.count++;
      const p = pmap.get(n.process_id)!;
      const entry = link.processes.get(p.id) ?? { id: p.id, ref: p.ref, name: p.name, handoffs: [] };
      entry.handoffs.push({ from: n.label, to: t.label });
      link.processes.set(p.id, entry);
      links.set(key, link);
    }
  }

  const teamNodes = teams.map((t) => {
    const mine = nodes.filter((n) => n.team_id === t.id);
    return {
      id: t.id,
      name: t.name,
      department: t.department,
      color: t.color,
      stepCount: mine.length,
      processCount: uniq(mine.map((n) => n.process_id)).length,
      ownedProcessCount: processes.filter((p) => p.owner_team_id === t.id).length,
      systemCount: uniq(sysLinks.filter((s) => s.team_id === t.id).map((s) => s.target_id)).length,
      outgoingHandoffs: [...links.values()].filter((l) => l.from === t.id).reduce((a, l) => a + l.count, 0),
      incomingHandoffs: [...links.values()].filter((l) => l.to === t.id).reduce((a, l) => a + l.count, 0),
    };
  });

  return {
    teams: teamNodes,
    links: [...links.values()]
      .map((l) => ({ source: l.from, target: l.to, count: l.count, processes: [...l.processes.values()] }))
      .sort((a, b) => b.count - a.count),
    processCount: processes.length,
    unassignedStepCount: nodes.filter((n) => !n.team_id && !['start', 'end', 'note', 'decision'].includes(n.type)).length,
  };
}

export const teamGraph = defineOp({
  name: 'analytics.teamInteractions',
  group: 'Analytics',
  summary: 'Team interaction map: how work flows between teams',
  description:
    'Returns teams as nodes and handoffs as weighted, directed links (derived from every process diagram). Each link lists the processes and step pairs that create it.',
  permission: 'analytics:read',
  kind: 'read',
  http: { method: 'GET', path: '/analytics/team-interactions' },
  input: z.object(ProcessScope),
  handler: async (ctx, input) => computeTeamGraph(ctx.db, input),
});

export const processLandscape = defineOp({
  name: 'analytics.processLandscape',
  group: 'Analytics',
  summary: 'Process landscape: how processes call each other',
  description: 'Nodes are processes; links come from subprocess steps that invoke another process.',
  permission: 'analytics:read',
  kind: 'read',
  http: { method: 'GET', path: '/analytics/process-landscape' },
  input: z.object(ProcessScope),
  handler: async (ctx, input) => {
    const processes = await scopedProcesses(ctx.db, input);
    const pids = processes.map((p) => p.id).concat(['-']);
    const [links, teams, steps] = await Promise.all([
      ctx.db
        .selectFrom('nodes')
        .select(['process_id', 'linked_process_id', 'label'])
        .where('process_id', 'in', pids)
        .where('linked_process_id', 'is not', null)
        .execute(),
      ctx.db.selectFrom('teams').select(['id', 'name', 'color']).execute(),
      ctx.db.selectFrom('nodes').select(['process_id', 'team_id']).where('process_id', 'in', pids).execute(),
    ]);
    const tmap = new Map(teams.map((t) => [t.id, t]));
    const inScope = new Set(processes.map((p) => p.id));
    return {
      processes: processes.map((p) => ({
        id: p.id,
        ref: p.ref,
        name: p.name,
        status: p.status,
        category: p.category,
        ownerTeam: p.owner_team_id ? (tmap.get(p.owner_team_id) ?? null) : null,
        teamIds: uniq(steps.filter((s) => s.process_id === p.id && s.team_id).map((s) => s.team_id!)),
      })),
      links: links
        .filter((l) => inScope.has(l.linked_process_id!))
        .map((l) => ({ source: l.process_id, target: l.linked_process_id!, via: l.label })),
    };
  },
});

export const overview = defineOp({
  name: 'analytics.overview',
  group: 'Analytics',
  summary: 'Dashboard metrics: process health, reviews due, risk exposure',
  permission: 'analytics:read',
  kind: 'read',
  http: { method: 'GET', path: '/analytics/overview' },
  input: z.object({ reviewWindowDays: z.coerce.number().int().min(0).max(365).default(30) }),
  handler: async (ctx, input) => {
    const db = ctx.db;
    const now = nowIso();
    const horizon = addDays(now, input.reviewWindowDays);
    const [byStatus, counts, risks, controls, reviewsDue, recent, unowned, riskLinks] = await Promise.all([
      db.selectFrom('processes').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('status').execute(),
      Promise.all(
        (['nodes', 'teams', 'systems', 'risks', 'controls', 'users'] as const).map(async (t) =>
          [t, Number((await db.selectFrom(t).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0)] as const,
        ),
      ),
      db.selectFrom('risks').select(['id', 'likelihood', 'impact', 'status']).execute(),
      db.selectFrom('controls').select(['effectiveness', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('effectiveness').execute(),
      db
        .selectFrom('processes')
        .select(['id', 'ref', 'name', 'next_review_at', 'owner_team_id'])
        .where('status', '=', 'published')
        .where('next_review_at', 'is not', null)
        .where('next_review_at', '<=', horizon)
        .orderBy('next_review_at')
        .limit(25)
        .execute(),
      db.selectFrom('processes').select(['id', 'ref', 'name', 'status', 'updated_at']).orderBy('updated_at', 'desc').limit(8).execute(),
      db.selectFrom('processes').select((eb) => eb.fn.countAll<number>().as('n')).where('owner_team_id', 'is', null).where('status', '!=', 'archived').executeTakeFirst(),
      db.selectFrom('risk_controls').select('risk_id').distinct().execute(),
    ]);
    const mitigated = new Set(riskLinks.map((r) => r.risk_id));
    const ratings: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of risks) ratings[riskRating(r.likelihood * r.impact)]++;
    return {
      processesByStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      totals: Object.fromEntries(counts.map(([k, v]) => [k === 'nodes' ? 'steps' : k, v])),
      risksByRating: ratings,
      risksWithoutControls: risks.filter((r) => r.status === 'open' && !mitigated.has(r.id)).length,
      controlsByEffectiveness: Object.fromEntries(controls.map((r) => [r.effectiveness, Number(r.n)])),
      processesWithoutOwner: Number(unowned?.n ?? 0),
      reviewsDue: reviewsDue.map((r) => ({ id: r.id, ref: r.ref, name: r.name, nextReviewAt: r.next_review_at, overdue: (r.next_review_at ?? '') < now })),
      recentlyUpdated: recent.map((r) => ({ id: r.id, ref: r.ref, name: r.name, status: r.status, updatedAt: r.updated_at })),
    };
  },
});

export const riskControlMatrix = defineOp({
  name: 'analytics.riskControlMatrix',
  group: 'Analytics',
  summary: 'Risk & control matrix (RCM) with coverage gaps',
  description:
    'For each risk: rating, mitigating controls and the processes it occurs in, flagging processes where the risk appears but none of its controls are performed. Also lists controls not linked to any risk.',
  permission: 'analytics:read',
  kind: 'read',
  http: { method: 'GET', path: '/analytics/risk-control-matrix' },
  input: z.object({}),
  handler: async (ctx) => {
    const db = ctx.db;
    const [risks, controls, rc, nodeRisks, nodeControls, processes] = await Promise.all([
      db.selectFrom('risks').selectAll().orderBy('ref').execute(),
      db.selectFrom('controls').selectAll().orderBy('ref').execute(),
      db.selectFrom('risk_controls').selectAll().execute(),
      db.selectFrom('node_risks').innerJoin('nodes', 'nodes.id', 'node_risks.node_id').select(['node_risks.target_id as risk_id', 'nodes.process_id']).execute(),
      db.selectFrom('node_controls').innerJoin('nodes', 'nodes.id', 'node_controls.node_id').select(['node_controls.target_id as control_id', 'nodes.process_id']).execute(),
      db.selectFrom('processes').select(['id', 'ref', 'name', 'status']).where('status', '!=', 'archived').execute(),
    ]);
    const pmap = new Map(processes.map((p) => [p.id, p]));
    const cmap = new Map(controls.map((c) => [c.id, c]));
    const rows = risks.map((r) => {
      const ctlIds = rc.filter((x) => x.risk_id === r.id).map((x) => x.control_id);
      const procIds = uniq(nodeRisks.filter((n) => n.risk_id === r.id).map((n) => n.process_id)).filter((id) => pmap.has(id));
      const score = r.likelihood * r.impact;
      return {
        id: r.id,
        ref: r.ref,
        title: r.title,
        category: r.category,
        status: r.status,
        score,
        rating: riskRating(score),
        controls: ctlIds.map((id) => cmap.get(id)).filter(Boolean).map((c) => ({ id: c!.id, ref: c!.ref, name: c!.name, effectiveness: c!.effectiveness, nature: c!.nature })),
        processes: procIds.map((pid) => ({
          ...pmap.get(pid)!,
          controlled: nodeControls.some((nc) => nc.process_id === pid && ctlIds.includes(nc.control_id)),
        })),
      };
    });
    return {
      risks: rows,
      gaps: {
        risksWithoutControls: rows.filter((r) => r.controls.length === 0 && r.status !== 'closed').map((r) => ({ id: r.id, ref: r.ref, title: r.title, rating: r.rating })),
        uncontrolledOccurrences: rows.flatMap((r) => r.processes.filter((p) => !p.controlled).map((p) => ({ riskId: r.id, riskRef: r.ref, risk: r.title, processId: p.id, process: `${p.ref} ${p.name}` }))),
        controlsWithoutRisks: controls.filter((c) => !rc.some((x) => x.control_id === c.id)).map((c) => ({ id: c.id, ref: c.ref, name: c.name })),
        ineffectiveControls: controls.filter((c) => c.effectiveness === 'ineffective' || c.effectiveness === 'partially_effective').map((c) => ({ id: c.id, ref: c.ref, name: c.name, effectiveness: c.effectiveness })),
      },
    };
  },
});

export const systemUsage = defineOp({
  name: 'analytics.systemUsage',
  group: 'Analytics',
  summary: 'Which teams and processes depend on each business system',
  permission: 'analytics:read',
  kind: 'read',
  http: { method: 'GET', path: '/analytics/system-usage' },
  input: z.object({}),
  handler: async (ctx) => {
    const rows = await ctx.db
      .selectFrom('node_systems')
      .innerJoin('nodes', 'nodes.id', 'node_systems.node_id')
      .innerJoin('processes', 'processes.id', 'nodes.process_id')
      .leftJoin('teams', 'teams.id', 'nodes.team_id')
      .select(['node_systems.target_id as system_id', 'processes.id as process_id', 'processes.name as process_name', 'teams.id as team_id', 'teams.name as team_name'])
      .where('processes.status', '!=', 'archived')
      .execute();
    const systems = await ctx.db.selectFrom('systems').select(['id', 'name', 'criticality', 'vendor']).orderBy('name').execute();
    return systems.map((s) => {
      const mine = rows.filter((r) => r.system_id === s.id);
      const teams = new Map<string, { id: string; name: string; steps: number }>();
      for (const r of mine) if (r.team_id) teams.set(r.team_id, { id: r.team_id, name: r.team_name!, steps: (teams.get(r.team_id)?.steps ?? 0) + 1 });
      return {
        ...s,
        stepCount: mine.length,
        processes: uniq(mine.map((r) => r.process_id)).map((id) => ({ id, name: mine.find((m) => m.process_id === id)!.process_name })),
        teams: [...teams.values()].sort((a, b) => b.steps - a.steps),
      };
    });
  },
});

// =================================================================== comments

async function commentDtos(db: DB, processId: string, includeResolved: boolean) {
  let q = db
    .selectFrom('comments')
    .leftJoin('users', 'users.id', 'comments.author_id')
    .leftJoin('nodes', 'nodes.id', 'comments.node_id')
    .select(['comments.id', 'comments.node_id', 'comments.body', 'comments.resolved', 'comments.created_at', 'comments.updated_at', 'comments.author_id', 'users.name as author_name', 'nodes.label as node_label'])
    .where('comments.process_id', '=', processId);
  if (!includeResolved) q = q.where('comments.resolved', '=', 0);
  const rows = await q.orderBy('comments.created_at').execute();
  return rows.map((r) => ({
    id: r.id,
    nodeId: r.node_id,
    nodeLabel: r.node_label,
    body: r.body,
    resolved: toBool(r.resolved),
    author: r.author_id ? { id: r.author_id, name: r.author_name } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export const listComments = defineOp({
  name: 'comment.list',
  group: 'Comments',
  summary: 'List comments on a process',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:processId/comments' },
  input: z.object({ processId: Id, includeResolved: z.coerce.boolean().default(true) }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.processId);
    return commentDtos(ctx.db, p.id, input.includeResolved);
  },
});

export const createComment = defineOp({
  name: 'comment.create',
  group: 'Comments',
  summary: 'Comment on a process or a specific step',
  permission: 'comment:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:processId/comments' },
  targetType: 'process',
  input: z.object({ processId: Id, nodeId: z.string().nullish().describe('Anchor the comment to a step'), body: z.string().min(1).max(10_000) }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.processId);
    ctx.target.id = p.id;
    if (input.nodeId) {
      const n = await ctx.db.selectFrom('nodes').select('id').where('id', '=', input.nodeId).where('process_id', '=', p.id).executeTakeFirst();
      if (!n) throw new NotFoundError('Step', input.nodeId);
    }
    const id = newId();
    const now = nowIso();
    await ctx.db.insertInto('comments').values({ id, process_id: p.id, node_id: input.nodeId ?? null, author_id: ctx.actor.id, body: input.body, resolved: 0, created_at: now, updated_at: now }).execute();
    return (await commentDtos(ctx.db, p.id, true)).find((c) => c.id === id)!;
  },
});

async function loadComment(db: DB, id: string) {
  const c = await db.selectFrom('comments').selectAll().where('id', '=', id).executeTakeFirst();
  if (!c) throw new NotFoundError('Comment', id);
  return c;
}

export const resolveComment = defineOp({
  name: 'comment.resolve',
  group: 'Comments',
  summary: 'Resolve or re-open a comment',
  permission: 'comment:write',
  kind: 'write',
  http: { method: 'POST', path: '/comments/:id/resolve' },
  targetType: 'process',
  input: z.object({ id: Id, resolved: z.boolean().default(true) }),
  handler: async (ctx, input) => {
    const c = await loadComment(ctx.db, input.id);
    ctx.target.id = c.process_id;
    await ctx.db.updateTable('comments').set({ resolved: input.resolved ? 1 : 0, updated_at: nowIso() }).where('id', '=', c.id).execute();
    return (await commentDtos(ctx.db, c.process_id, true)).find((x) => x.id === c.id)!;
  },
});

export const deleteComment = defineOp({
  name: 'comment.delete',
  group: 'Comments',
  summary: 'Delete a comment (own comments, or any as admin)',
  permission: 'comment:write',
  kind: 'delete',
  http: { method: 'DELETE', path: '/comments/:id' },
  targetType: 'process',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const c = await loadComment(ctx.db, input.id);
    ctx.target.id = c.process_id;
    if (ctx.actor.type !== 'system' && ctx.actor.role !== 'admin' && c.author_id !== ctx.actor.id) {
      throw new ForbiddenError('You can only delete your own comments');
    }
    await ctx.db.deleteFrom('comments').where('id', '=', c.id).execute();
    return { deleted: true, id: c.id };
  },
});

export const insightOps = [search, teamGraph, processLandscape, overview, riskControlMatrix, systemUsage, listComments, createComment, resolveComment, deleteComment];

import { z } from 'zod';
import type { OpContext } from '../core/operation.js';
import type { ProcessRow } from '../db/schema.js';
import { ValidationError } from '../core/errors.js';
import { newId, nowIso, uniq } from '../lib/util.js';
import { NODE_TYPES, assertExists, loadDiagram, replaceLinks } from './shared.js';

export const Position = z.object({ x: z.number().finite(), y: z.number().finite() });

export const NodeFields = {
  type: z.enum(NODE_TYPES).default('task').describe(
    'start/end = process boundaries, task = an activity, decision = branching point (label outgoing edges), subprocess = calls another process (set linkedProcessId), event, document, system, note',
  ),
  label: z.string().min(1).max(300).describe('Short name shown on the diagram, e.g. "Approve invoice"'),
  description: z.string().max(20_000).default('').describe('Detailed work instructions for this step'),
  teamId: z.string().nullish().describe('Team responsible for the step (drives swimlanes and the team interaction map)'),
  actorRole: z.string().max(200).nullish().describe('Job role performing the step, e.g. "AP Clerk"'),
  durationMinutes: z.number().int().min(0).max(10_000_000).nullish().describe('Typical effort / elapsed time in minutes'),
  inputs: z.string().max(5000).nullish(),
  outputs: z.string().max(5000).nullish(),
  linkedProcessId: z.string().nullish().describe('For subprocess steps: the process that is invoked'),
  position: Position.optional().describe('Canvas position. Omit to have the server lay the diagram out automatically.'),
  systemIds: z.array(z.string()).max(100).default([]).describe('Business systems used in this step'),
  riskIds: z.array(z.string()).max(100).default([]).describe('Risks that arise in this step'),
  controlIds: z.array(z.string()).max(100).default([]).describe('Controls performed in this step'),
};

export const DiagramNodeInput = z.object({
  id: z
    .string()
    .max(64)
    .optional()
    .describe('Existing node id to update, or any temporary key (e.g. "n1") that edges can reference for new nodes'),
  ...NodeFields,
});
export type DiagramNodeInput = z.output<typeof DiagramNodeInput>;

export const DiagramEdgeInput = z.object({
  source: z.string().describe('Source node id or temporary key'),
  target: z.string().describe('Target node id or temporary key'),
  label: z.string().max(300).nullish().describe('Condition or outcome, e.g. "Approved" / "Rejected"'),
});
export type DiagramEdgeInput = z.output<typeof DiagramEdgeInput>;

export const DiagramInput = {
  nodes: z.array(DiagramNodeInput).max(1000),
  edges: z.array(DiagramEdgeInput).max(2000).default([]),
};

/**
 * Replace a process's whole diagram. Nodes whose id matches an existing node are
 * updated in place (keeping comments anchored to them); other nodes are created;
 * nodes not present are removed. Returns a map of supplied keys → stored ids.
 */
export async function writeDiagram(
  ctx: OpContext,
  process: ProcessRow,
  nodes: DiagramNodeInput[],
  edges: DiagramEdgeInput[],
): Promise<Record<string, string>> {
  const db = ctx.db;
  const existing = await db.selectFrom('nodes').select('id').where('process_id', '=', process.id).execute();
  const existingIds = new Set(existing.map((n) => n.id));

  const idMap = new Map<string, string>();
  const finalIds: string[] = [];
  nodes.forEach((n, i) => {
    const key = n.id ?? `#${i}`;
    if (idMap.has(key)) throw new ValidationError(`Duplicate node id '${key}'`);
    const finalId = n.id && existingIds.has(n.id) ? n.id : newId();
    idMap.set(key, finalId);
    finalIds.push(finalId);
  });

  await assertExists(db, 'teams', nodes.map((n) => n.teamId), 'team ids');
  await assertExists(db, 'systems', nodes.flatMap((n) => n.systemIds), 'system ids');
  await assertExists(db, 'risks', nodes.flatMap((n) => n.riskIds), 'risk ids');
  await assertExists(db, 'controls', nodes.flatMap((n) => n.controlIds), 'control ids');
  await assertExists(db, 'processes', nodes.map((n) => n.linkedProcessId), 'linked process ids');
  if (nodes.some((n) => n.linkedProcessId === process.id)) throw new ValidationError('A process cannot link to itself');

  const resolve = (ref: string): string => {
    const id = idMap.get(ref) ?? (finalIds.includes(ref) ? ref : undefined);
    if (!id) throw new ValidationError(`Edge references unknown node '${ref}'`);
    return id;
  };
  const edgeRows = edges.map((e) => ({ source: resolve(e.source), target: resolve(e.target), label: e.label ?? null }));
  const seen = new Set<string>();
  for (const e of edgeRows) {
    if (e.source === e.target) throw new ValidationError('An edge cannot connect a node to itself');
    const k = `${e.source}>${e.target}>${e.label ?? ''}`;
    if (seen.has(k)) throw new ValidationError('Duplicate edge');
    seen.add(k);
  }

  const positions = autoLayout(
    nodes.map((n, i) => ({ id: finalIds[i], position: n.position, type: n.type })),
    edgeRows,
  );

  const keep = new Set(finalIds.filter((id) => existingIds.has(id)));
  const remove = [...existingIds].filter((id) => !keep.has(id));
  await db.deleteFrom('edges').where('process_id', '=', process.id).execute();
  if (remove.length) await db.deleteFrom('nodes').where('id', 'in', remove).execute();

  const now = nowIso();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const id = finalIds[i];
    const pos = positions.get(id)!;
    const values = {
      type: n.type,
      label: n.label,
      description: n.description,
      team_id: n.teamId ?? null,
      actor_role: n.actorRole ?? null,
      duration_minutes: n.durationMinutes ?? null,
      inputs: n.inputs ?? null,
      outputs: n.outputs ?? null,
      linked_process_id: n.linkedProcessId ?? null,
      x: pos.x,
      y: pos.y,
      updated_at: now,
    };
    if (keep.has(id)) {
      await db.updateTable('nodes').set(values).where('id', '=', id).execute();
    } else {
      await db
        .insertInto('nodes')
        .values({ id, process_id: process.id, created_at: now, ...values })
        .execute();
    }
    await replaceLinks(db, 'node_systems', id, n.systemIds);
    await replaceLinks(db, 'node_risks', id, n.riskIds);
    await replaceLinks(db, 'node_controls', id, n.controlIds);
  }

  if (edgeRows.length) {
    await db
      .insertInto('edges')
      .values(
        edgeRows.map((e) => ({
          id: newId(),
          process_id: process.id,
          source_node_id: e.source,
          target_node_id: e.target,
          label: e.label,
          created_at: now,
        })),
      )
      .execute();
  }

  return Object.fromEntries(idMap);
}

/**
 * Simple layered layout for nodes without explicit positions (e.g. diagrams
 * created by an AI agent or the API). Longest-path layering, left to right.
 */
export function autoLayout(
  nodes: Array<{ id: string; position?: { x: number; y: number }; type: string }>,
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const missing = nodes.filter((n) => !n.position);
  for (const n of nodes) if (n.position) out.set(n.id, n.position);
  if (!missing.length) return out;

  const ids = nodes.map((n) => n.id);
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) next.get(e.source)?.push(e.target);

  // 1. Drop back edges (loops such as "rework") found by iterative DFS.
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const incomingAll = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) incomingAll.set(e.target, (incomingAll.get(e.target) ?? 0) + 1);
  const roots = [...ids.filter((id) => (incomingAll.get(id) ?? 0) === 0), ...ids];
  for (const root of roots) {
    if (state.get(root)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const succ = next.get(top.id) ?? [];
      if (top.i < succ.length) {
        const t = succ[top.i++];
        const st = state.get(t) ?? 0;
        if (st === 1) continue; // back edge
        dag.get(top.id)!.push(t);
        indeg.set(t, (indeg.get(t) ?? 0) + 1);
        if (st === 0) {
          state.set(t, 1);
          stack.push({ id: t, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }

  // 2. Longest-path layering over the DAG (Kahn's algorithm).
  const level = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of dag.get(id) ?? []) {
      level.set(t, Math.max(level.get(t) ?? 0, (level.get(id) ?? 0) + 1));
      indeg.set(t, (indeg.get(t) ?? 0) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }

  // 3. Order rows within a layer by the average row of predecessors (fewer crossings).
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [s, ts] of dag) for (const t of ts) preds.get(t)!.push(s);
  const row = new Map<string, number>();
  const layers = new Map<number, string[]>();
  for (const id of order) layers.set(level.get(id)!, [...(layers.get(level.get(id)!) ?? []), id]);
  for (const l of [...layers.keys()].sort((a, b) => a - b)) {
    const members = layers.get(l)!;
    const bary = (id: string) => {
      const p = preds.get(id)!.filter((x) => row.has(x));
      return p.length ? p.reduce((a, x) => a + row.get(x)!, 0) / p.length : Number.MAX_SAFE_INTEGER;
    };
    members.sort((a, b) => bary(a) - bary(b));
    members.forEach((id, i) => row.set(id, i));
  }

  // Offset new nodes below any positioned ones so they do not overlap.
  const baseY = out.size ? Math.max(...[...out.values()].map((p) => p.y)) + 160 : 0;
  const missingIds = new Set(missing.map((n) => n.id));
  for (const id of ids) {
    if (!missingIds.has(id)) continue;
    out.set(id, { x: (level.get(id) ?? 0) * 240, y: baseY + (row.get(id) ?? 0) * 130 });
  }
  return out;
}

export async function diagramWithMeta(ctx: OpContext, processId: string) {
  const diagram = await loadDiagram(ctx.db, processId);
  const teamIds = uniq(diagram.nodes.map((n) => n.teamId).filter((v): v is string => Boolean(v)));
  return { ...diagram, teamIds };
}

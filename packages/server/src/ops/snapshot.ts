import { z } from 'zod';
import type { DB } from '../db/schema.js';
import type { OpContext } from '../core/operation.js';
import { can } from '../core/executor.js';
import { newId, nowIso, pickColor } from '../lib/util.js';
import { loadDiagram, nextRef, processDto, type ProcessDto } from './shared.js';
import type { DiagramEdgeInput, DiagramNodeInput } from './diagram.js';
import { NODE_TYPES } from './shared.js';

export const SNAPSHOT_FORMAT = 'streamline.process.v1';

/**
 * Portable, self-describing representation of a process. Used for published
 * versions, JSON export/import and duplication. Catalog references carry both
 * ids (for same-instance restores) and names (for cross-instance imports).
 */
export const SnapshotSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  exportedAt: z.string().optional(),
  process: z.object({
    ref: z.string().optional(),
    name: z.string().min(1).max(300),
    summary: z.string().max(2000).default(''),
    description: z.string().max(100_000).default(''),
    category: z.string().max(200).nullish(),
    ownerTeam: z.object({ id: z.string().optional(), name: z.string() }).nullish(),
    tags: z.array(z.string()).default([]),
    reviewIntervalDays: z.number().int().nullish(),
  }),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(NODE_TYPES),
        label: z.string().min(1).max(300),
        description: z.string().max(20_000).default(''),
        team: z.object({ id: z.string().optional(), name: z.string() }).nullish(),
        actorRole: z.string().nullish(),
        durationMinutes: z.number().int().nullish(),
        inputs: z.string().nullish(),
        outputs: z.string().nullish(),
        linkedProcess: z.object({ id: z.string().optional(), ref: z.string().optional(), name: z.string() }).nullish(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        systems: z.array(z.object({ id: z.string().optional(), name: z.string() })).default([]),
        risks: z.array(z.object({ id: z.string().optional(), ref: z.string().optional(), title: z.string() })).default([]),
        controls: z.array(z.object({ id: z.string().optional(), ref: z.string().optional(), name: z.string() })).default([]),
      }),
    )
    .max(1000),
  edges: z
    .array(z.object({ source: z.string(), target: z.string(), label: z.string().nullish() }))
    .max(2000)
    .default([]),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export async function buildSnapshot(db: DB, dto: ProcessDto): Promise<Snapshot> {
  const diagram = await loadDiagram(db, dto.id);
  const ids = (k: 'systemIds' | 'riskIds' | 'controlIds') => [...new Set(diagram.nodes.flatMap((n) => n[k]))].concat(['-']);
  const teamIds = [...new Set(diagram.nodes.map((n) => n.teamId).filter(Boolean) as string[])].concat(['-']);
  const linkedIds = [...new Set(diagram.nodes.map((n) => n.linkedProcessId).filter(Boolean) as string[])].concat(['-']);
  const [teams, systems, risks, controls, linked] = await Promise.all([
    db.selectFrom('teams').select(['id', 'name']).where('id', 'in', teamIds).execute(),
    db.selectFrom('systems').select(['id', 'name']).where('id', 'in', ids('systemIds')).execute(),
    db.selectFrom('risks').select(['id', 'ref', 'title']).where('id', 'in', ids('riskIds')).execute(),
    db.selectFrom('controls').select(['id', 'ref', 'name']).where('id', 'in', ids('controlIds')).execute(),
    db.selectFrom('processes').select(['id', 'ref', 'name']).where('id', 'in', linkedIds).execute(),
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const tm = by(teams);
  const sm = by(systems);
  const rm = by(risks);
  const cm = by(controls);
  const lm = by(linked);
  return {
    format: SNAPSHOT_FORMAT,
    exportedAt: nowIso(),
    process: {
      ref: dto.ref,
      name: dto.name,
      summary: dto.summary,
      description: dto.description,
      category: dto.category,
      ownerTeam: dto.ownerTeam ? { id: dto.ownerTeam.id, name: dto.ownerTeam.name } : null,
      tags: dto.tags.map((t) => t.name),
      reviewIntervalDays: dto.reviewIntervalDays,
    },
    nodes: diagram.nodes.map((n) => ({
      id: n.id,
      type: n.type as Snapshot['nodes'][number]['type'],
      label: n.label,
      description: n.description,
      team: n.teamId && tm.get(n.teamId) ? tm.get(n.teamId)! : null,
      actorRole: n.actorRole,
      durationMinutes: n.durationMinutes,
      inputs: n.inputs,
      outputs: n.outputs,
      linkedProcess: n.linkedProcessId && lm.get(n.linkedProcessId) ? lm.get(n.linkedProcessId)! : null,
      position: n.position,
      systems: n.systemIds.map((id) => sm.get(id)).filter((v): v is { id: string; name: string } => Boolean(v)),
      risks: n.riskIds.map((id) => rm.get(id)).filter((v): v is { id: string; ref: string; title: string } => Boolean(v)),
      controls: n.controlIds.map((id) => cm.get(id)).filter((v): v is { id: string; ref: string; name: string } => Boolean(v)),
    })),
    edges: diagram.edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
  };
}

export async function snapshotOf(db: DB, processId: string): Promise<Snapshot> {
  const row = await db.selectFrom('processes').selectAll().where('id', '=', processId).executeTakeFirstOrThrow();
  return buildSnapshot(db, await processDto(db, row));
}

/**
 * Resolve a snapshot's catalog references against this instance: by id, then by
 * name/ref. Missing teams and systems are created when the actor may manage the
 * catalog; otherwise the reference is dropped.
 */
export async function resolveSnapshot(
  ctx: OpContext,
  snap: Snapshot,
  opts: { preserveNodeIds: boolean },
): Promise<{ nodes: DiagramNodeInput[]; edges: DiagramEdgeInput[]; ownerTeamId: string | null; tagIds: string[] }> {
  const db = ctx.db;
  const mayCreate = can(ctx.actor, 'catalog:write');
  const now = nowIso();

  const teamCache = new Map<string, string | null>();
  const resolveTeam = async (t: { id?: string; name: string } | null | undefined): Promise<string | null> => {
    if (!t) return null;
    const key = `${t.id ?? ''}|${t.name}`;
    if (teamCache.has(key)) return teamCache.get(key)!;
    let row = t.id ? await db.selectFrom('teams').select('id').where('id', '=', t.id).executeTakeFirst() : undefined;
    row ??= await db.selectFrom('teams').select('id').where('name', '=', t.name).executeTakeFirst();
    let id = row?.id ?? null;
    if (!id && mayCreate) {
      id = newId();
      await db
        .insertInto('teams')
        .values({ id, name: t.name, description: '', department: null, color: pickColor(t.name), created_at: now, updated_at: now })
        .execute();
    }
    teamCache.set(key, id);
    return id;
  };

  const resolveSystem = async (s: { id?: string; name: string }): Promise<string | null> => {
    let row = s.id ? await db.selectFrom('systems').select('id').where('id', '=', s.id).executeTakeFirst() : undefined;
    row ??= await db.selectFrom('systems').select('id').where('name', '=', s.name).executeTakeFirst();
    if (row) return row.id;
    if (!mayCreate) return null;
    const id = newId();
    await db
      .insertInto('systems')
      .values({ id, name: s.name, description: '', vendor: null, category: null, criticality: 'medium', owner_team_id: null, url: null, created_at: now, updated_at: now })
      .execute();
    return id;
  };

  const resolveRisk = async (r: { id?: string; ref?: string; title: string }): Promise<string | null> => {
    let row = r.id ? await db.selectFrom('risks').select('id').where('id', '=', r.id).executeTakeFirst() : undefined;
    if (!row && r.ref) row = await db.selectFrom('risks').select('id').where('ref', '=', r.ref).where('title', '=', r.title).executeTakeFirst();
    row ??= await db.selectFrom('risks').select('id').where('title', '=', r.title).executeTakeFirst();
    if (row) return row.id;
    if (!mayCreate) return null;
    const id = newId();
    await db
      .insertInto('risks')
      .values({ id, ref: await nextRef(db, 'risk', 'RSK', 3), title: r.title, description: '', category: null, likelihood: 3, impact: 3, status: 'open', owner_team_id: null, created_at: now, updated_at: now })
      .execute();
    return id;
  };

  const resolveControl = async (c: { id?: string; ref?: string; name: string }): Promise<string | null> => {
    let row = c.id ? await db.selectFrom('controls').select('id').where('id', '=', c.id).executeTakeFirst() : undefined;
    if (!row && c.ref) row = await db.selectFrom('controls').select('id').where('ref', '=', c.ref).where('name', '=', c.name).executeTakeFirst();
    row ??= await db.selectFrom('controls').select('id').where('name', '=', c.name).executeTakeFirst();
    if (row) return row.id;
    if (!mayCreate) return null;
    const id = newId();
    await db
      .insertInto('controls')
      .values({ id, ref: await nextRef(db, 'control', 'CTL', 3), name: c.name, description: '', control_type: 'preventive', nature: 'manual', frequency: null, effectiveness: 'not_tested', owner_team_id: null, created_at: now, updated_at: now })
      .execute();
    return id;
  };

  const resolveLinked = async (p: { id?: string; ref?: string; name: string } | null | undefined): Promise<string | null> => {
    if (!p) return null;
    let row = p.id ? await db.selectFrom('processes').select('id').where('id', '=', p.id).executeTakeFirst() : undefined;
    if (!row && p.ref) row = await db.selectFrom('processes').select('id').where('ref', '=', p.ref).executeTakeFirst();
    row ??= await db.selectFrom('processes').select('id').where('name', '=', p.name).executeTakeFirst();
    return row?.id ?? null;
  };

  const compact = (v: Array<string | null>) => v.filter((x): x is string => Boolean(x));
  const nodes: DiagramNodeInput[] = [];
  for (const n of snap.nodes) {
    nodes.push({
      id: opts.preserveNodeIds ? n.id : `k:${n.id}`,
      type: n.type,
      label: n.label,
      description: n.description,
      teamId: await resolveTeam(n.team),
      actorRole: n.actorRole ?? null,
      durationMinutes: n.durationMinutes ?? null,
      inputs: n.inputs ?? null,
      outputs: n.outputs ?? null,
      linkedProcessId: await resolveLinked(n.linkedProcess),
      position: n.position,
      systemIds: compact(await Promise.all(n.systems.map(resolveSystem))),
      riskIds: compact(await Promise.all(n.risks.map(resolveRisk))),
      controlIds: compact(await Promise.all(n.controls.map(resolveControl))),
    });
  }
  const edges: DiagramEdgeInput[] = snap.edges.map((e) => ({
    source: opts.preserveNodeIds ? e.source : `k:${e.source}`,
    target: opts.preserveNodeIds ? e.target : `k:${e.target}`,
    label: e.label ?? null,
  }));

  const tagIds: string[] = [];
  for (const name of snap.process.tags) tagIds.push(await ensureTag(db, name));

  return { nodes, edges, ownerTeamId: await resolveTeam(snap.process.ownerTeam), tagIds };
}

export async function ensureTag(db: DB, name: string): Promise<string> {
  const clean = name.trim().slice(0, 60);
  const row = await db.selectFrom('tags').select('id').where('name', '=', clean).executeTakeFirst();
  if (row) return row.id;
  const id = newId();
  await db.insertInto('tags').values({ id, name: clean, color: pickColor(clean), created_at: nowIso() }).execute();
  return id;
}

export async function setProcessTags(db: DB, processId: string, tagIds: string[]) {
  await db.deleteFrom('process_tags').where('process_id', '=', processId).execute();
  const ids = [...new Set(tagIds)];
  if (ids.length) await db.insertInto('process_tags').values(ids.map((tag_id) => ({ process_id: processId, tag_id }))).execute();
}

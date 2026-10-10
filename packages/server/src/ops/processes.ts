import { sql } from 'kysely';
import { z } from 'zod';
import { defineOp, type OpContext } from '../core/operation.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../core/errors.js';
import { addDays, likeEscape, newId, nowIso, parseJson } from '../lib/util.js';
import {
  Id,
  PROCESS_STATUSES,
  Pagination,
  StringList,
  assertCanEditProcess,
  assertExists,
  edgeDto,
  getSettings,
  loadProcess,
  nextRef,
  nodeDtos,
  processDto,
  processDtos,
  replaceLinks,
  touchProcess,
  type Page,
  type ProcessDto,
} from './shared.js';
import { DiagramInput, NodeFields, Position, autoLayout, diagramWithMeta, writeDiagram } from './diagram.js';
import { SnapshotSchema, buildSnapshot, ensureTag, resolveSnapshot, setProcessTags, type Snapshot } from './snapshot.js';

const G = 'Processes';
const GD = 'Process diagrams';
const GW = 'Process lifecycle';

const ProcessFields = {
  name: z.string().min(1).max(300),
  summary: z.string().max(2000).default('').describe('One or two sentence purpose of the process'),
  description: z.string().max(100_000).default('').describe('Full narrative: scope, triggers, policy references, etc.'),
  category: z.string().max(200).nullish().describe('Business domain, e.g. "Finance / Accounts Payable"'),
  ownerTeamId: z.string().nullish().describe('Team accountable for the process'),
  ownerUserId: z.string().nullish().describe('Individual process owner'),
  tags: z.array(z.string().min(1).max(60)).max(50).optional().describe('Tag names; unknown tags are created'),
  reviewIntervalDays: z.number().int().min(0).max(3650).nullish().describe('How often the process must be re-certified'),
};

async function fullProcess(ctx: OpContext, id: string) {
  const row = await loadProcess(ctx.db, id);
  const dto = await processDto(ctx.db, row);
  const diagram = await diagramWithMeta(ctx, row.id);
  return { ...dto, ...diagram };
}

async function applyTags(ctx: OpContext, processId: string, names: string[]) {
  const ids: string[] = [];
  for (const n of names) ids.push(await ensureTag(ctx.db, n));
  await setProcessTags(ctx.db, processId, ids);
}

async function createVersion(ctx: OpContext, processId: string, note: string) {
  const row = await loadProcess(ctx.db, processId);
  const snapshot = await buildSnapshot(ctx.db, await processDto(ctx.db, row));
  const last = await ctx.db
    .selectFrom('process_versions')
    .select((eb) => eb.fn.max('version').as('v'))
    .where('process_id', '=', processId)
    .executeTakeFirst();
  const version = Number(last?.v ?? 0) + 1;
  await ctx.db
    .insertInto('process_versions')
    .values({
      id: newId(),
      process_id: processId,
      version,
      snapshot: JSON.stringify(snapshot),
      change_note: note,
      published_by: ctx.actor.id,
      published_at: nowIso(),
    })
    .execute();
  return version;
}

// ------------------------------------------------------------------ queries

export const listProcesses = defineOp({
  name: 'process.list',
  group: G,
  summary: 'List and filter processes',
  description: 'Returns processes with owner, tags and step counts. Filter by text, status, team, tag or category.',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes' },
  input: z.object({
    q: z.string().max(200).optional().describe('Matches name, reference, summary or category'),
    status: StringList.optional().describe('One or more of draft, in_review, published, archived'),
    teamId: z.string().optional().describe('Owner team'),
    tag: z.string().optional().describe('Tag name'),
    category: z.string().optional(),
    includeArchived: z.coerce.boolean().default(false),
    sort: z.enum(['name', 'updated', 'ref', 'review']).default('updated'),
    ...Pagination,
  }),
  handler: async (ctx, input): Promise<Page<ProcessDto>> => {
    let q = ctx.db.selectFrom('processes');
    if (input.q) {
      const like = `%${likeEscape(input.q.toLowerCase())}%`;
      q = q.where((eb) =>
        eb.or(
          ['name', 'ref', 'summary', 'category'].map((c) => sql<boolean>`lower(coalesce(${sql.ref(c)}, '')) like ${like} escape '\\'`),
        ),
      );
    }
    if (input.status?.length) q = q.where('status', 'in', input.status);
    else if (!input.includeArchived) q = q.where('status', '!=', 'archived');
    if (input.teamId) q = q.where('owner_team_id', '=', input.teamId);
    if (input.category) q = q.where('category', '=', input.category);
    if (input.tag) {
      q = q.where('id', 'in', (eb) =>
        eb
          .selectFrom('process_tags')
          .innerJoin('tags', 'tags.id', 'process_tags.tag_id')
          .select('process_tags.process_id')
          .where('tags.name', '=', input.tag!),
      );
    }
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    let rows = q.selectAll();
    rows =
      input.sort === 'name'
        ? rows.orderBy('name')
        : input.sort === 'ref'
          ? rows.orderBy('ref')
          : input.sort === 'review'
            ? rows.orderBy(sql`coalesce(next_review_at, '9999')`)
            : rows.orderBy('updated_at', 'desc');
    const items = await rows.limit(input.limit).offset(input.offset).execute();
    return { items: await processDtos(ctx.db, items), total, limit: input.limit, offset: input.offset };
  },
});

export const getProcess = defineOp({
  name: 'process.get',
  group: G,
  summary: 'Get a process with its full diagram',
  description: 'Accepts the process id or its reference (e.g. PRC-0001). Returns metadata, nodes (steps) and edges.',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:id' },
  targetType: 'process',
  input: z.object({ id: Id.describe('Process id or reference') }),
  handler: async (ctx, input) => fullProcess(ctx, input.id),
});

// ------------------------------------------------------------------ mutations

export const createProcess = defineOp({
  name: 'process.create',
  group: G,
  summary: 'Create a process',
  description:
    'Creates a new draft process. Optionally include `nodes` and `edges` to create the diagram in one call (positions are auto-laid out when omitted).',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes' },
  targetType: 'process',
  input: z.object({
    ...ProcessFields,
    template: z.enum(['blank', 'basic']).default('basic').describe('basic = start and end nodes; ignored when nodes are supplied'),
    nodes: DiagramInput.nodes.optional(),
    edges: DiagramInput.edges.optional(),
  }),
  handler: async (ctx, input) => {
    const settings = await getSettings(ctx.db);
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    await assertExists(ctx.db, 'users', [input.ownerUserId], 'owner user');
    const id = newId();
    const now = nowIso();
    const ref = await nextRef(ctx.db, 'process', settings.processRefPrefix);
    await ctx.db
      .insertInto('processes')
      .values({
        id,
        ref,
        name: input.name,
        summary: input.summary,
        description: input.description,
        status: 'draft',
        category: input.category ?? null,
        owner_team_id: input.ownerTeamId ?? null,
        owner_user_id: input.ownerUserId ?? (ctx.actor.userKind === 'human' ? ctx.actor.id : null),
        review_interval_days: input.reviewIntervalDays ?? settings.defaultReviewIntervalDays,
        next_review_at: null,
        revision: 1,
        published_version: null,
        submitted_by: null,
        submitted_at: null,
        created_by: ctx.actor.id,
        updated_by: ctx.actor.id,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (input.tags) await applyTags(ctx, id, input.tags);
    const row = await loadProcess(ctx.db, id);
    if (input.nodes?.length) {
      await writeDiagram(ctx, row, input.nodes, input.edges ?? []);
    } else if (input.template === 'basic') {
      await writeDiagram(
        ctx,
        row,
        [
          { id: 's', type: 'start', label: 'Start', description: '', position: { x: 0, y: 0 }, systemIds: [], riskIds: [], controlIds: [] },
          { id: 'e', type: 'end', label: 'End', description: '', position: { x: 480, y: 0 }, systemIds: [], riskIds: [], controlIds: [] },
        ],
        [],
      );
    }
    ctx.target = { type: 'process', id };
    return fullProcess(ctx, id);
  },
});

export const updateProcess = defineOp({
  name: 'process.update',
  group: G,
  summary: 'Update process details',
  description: 'Partial update of metadata. Editing a published or in-review process returns it to draft.',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/processes/:id' },
  targetType: 'process',
  input: z.object({
    id: Id,
    expectedRevision: z.number().int().optional().describe('Optimistic concurrency check'),
    ...Object.fromEntries(Object.entries(ProcessFields).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof ProcessFields]: z.ZodOptional<(typeof ProcessFields)[K]>;
    },
  }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await assertExists(ctx.db, 'teams', [input.ownerTeamId], 'owner team');
    await assertExists(ctx.db, 'users', [input.ownerUserId], 'owner user');
    await touchProcess(ctx, p, input.expectedRevision);
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.summary !== undefined) set.summary = input.summary;
    if (input.description !== undefined) set.description = input.description;
    if (input.category !== undefined) set.category = input.category;
    if (input.ownerTeamId !== undefined) set.owner_team_id = input.ownerTeamId;
    if (input.ownerUserId !== undefined) set.owner_user_id = input.ownerUserId;
    if (input.reviewIntervalDays !== undefined) set.review_interval_days = input.reviewIntervalDays;
    if (Object.keys(set).length) await ctx.db.updateTable('processes').set(set).where('id', '=', p.id).execute();
    if (input.tags) await applyTags(ctx, p.id, input.tags);
    return fullProcess(ctx, p.id);
  },
});

export const deleteProcess = defineOp({
  name: 'process.delete',
  group: G,
  summary: 'Permanently delete a process',
  description: 'Deletes the process, its diagram, versions and comments. Prefer process.archive for retirement.',
  permission: 'process:delete',
  kind: 'delete',
  http: { method: 'DELETE', path: '/processes/:id' },
  targetType: 'process',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    ctx.auditDetail = { ref: p.ref, name: p.name };
    await ctx.db.deleteFrom('processes').where('id', '=', p.id).execute();
    return { deleted: true, id: p.id };
  },
});

export const duplicateProcess = defineOp({
  name: 'process.duplicate',
  group: G,
  summary: 'Copy a process as a new draft',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/duplicate' },
  targetType: 'process',
  input: z.object({ id: Id, name: z.string().min(1).max(300).optional() }),
  handler: async (ctx, input) => {
    const src = await loadProcess(ctx.db, input.id);
    const snap = await buildSnapshot(ctx.db, await processDto(ctx.db, src));
    snap.process.name = input.name ?? `${src.name} (copy)`;
    return importSnapshot(ctx, snap);
  },
});

async function importSnapshot(ctx: OpContext, snap: Snapshot) {
  const settings = await getSettings(ctx.db);
  const id = newId();
  const now = nowIso();
  const resolved = await resolveSnapshot(ctx, snap, { preserveNodeIds: false });
  await ctx.db
    .insertInto('processes')
    .values({
      id,
      ref: await nextRef(ctx.db, 'process', settings.processRefPrefix),
      name: snap.process.name,
      summary: snap.process.summary,
      description: snap.process.description,
      status: 'draft',
      category: snap.process.category ?? null,
      owner_team_id: resolved.ownerTeamId,
      owner_user_id: ctx.actor.userKind === 'human' ? ctx.actor.id : null,
      review_interval_days: snap.process.reviewIntervalDays ?? settings.defaultReviewIntervalDays,
      next_review_at: null,
      revision: 1,
      published_version: null,
      submitted_by: null,
      submitted_at: null,
      created_by: ctx.actor.id,
      updated_by: ctx.actor.id,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await setProcessTags(ctx.db, id, resolved.tagIds);
  await writeDiagram(ctx, await loadProcess(ctx.db, id), resolved.nodes, resolved.edges);
  ctx.target = { type: 'process', id };
  return fullProcess(ctx, id);
}

export const importProcess = defineOp({
  name: 'process.import',
  group: G,
  summary: 'Import a process from a JSON export',
  description:
    'Creates a new draft from a `streamline.process.v1` document (as produced by process.export with format=json). Teams, systems, risks and controls are matched by name and created if missing (when permitted).',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/import' },
  targetType: 'process',
  input: z.object({ document: SnapshotSchema }),
  handler: async (ctx, input) => importSnapshot(ctx, input.document),
});

// ------------------------------------------------------------------ diagram

export const saveDiagram = defineOp({
  name: 'process.saveDiagram',
  group: GD,
  summary: 'Replace the whole diagram of a process',
  description: [
    'Sends the complete set of nodes and edges. Nodes with an existing id are updated, others are created, and missing ones are deleted.',
    'For new nodes use any temporary id (e.g. "n1") and reference it from edges. Omit `position` to auto-layout.',
    'Use `expectedRevision` to avoid overwriting concurrent changes.',
  ].join(' '),
  permission: 'process:write',
  kind: 'write',
  http: { method: 'PUT', path: '/processes/:id/diagram' },
  targetType: 'process',
  input: z.object({ id: Id, expectedRevision: z.number().int().optional(), ...DiagramInput }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await touchProcess(ctx, p, input.expectedRevision);
    const idMap = await writeDiagram(ctx, p, input.nodes, input.edges);
    ctx.auditDetail = { nodes: input.nodes.length, edges: input.edges.length };
    return { ...(await fullProcess(ctx, p.id)), idMap };
  },
});

export const addNode = defineOp({
  name: 'node.create',
  group: GD,
  summary: 'Add a step (node) to a process',
  description: 'Optionally connect it in the same call with `connectFrom` / `connectTo` (existing node ids).',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:processId/nodes' },
  targetType: 'process',
  input: z.object({
    processId: Id,
    ...NodeFields,
    connectFrom: z.string().optional().describe('Existing node that should flow into the new node'),
    connectTo: z.string().optional().describe('Existing node the new node should flow into'),
    edgeLabel: z.string().max(300).optional().describe('Label for the connectFrom edge'),
  }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.processId);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await validateNodeRefs(ctx, p.id, input);
    const nodes = await ctx.db.selectFrom('nodes').select(['id', 'x', 'y', 'type']).where('process_id', '=', p.id).execute();
    for (const ref of [input.connectFrom, input.connectTo]) {
      if (ref && !nodes.some((n) => n.id === ref)) throw new ValidationError(`Node '${ref}' is not part of this process`);
    }
    await touchProcess(ctx, p);
    const id = newId();
    let position = input.position;
    if (!position) {
      const anchor = nodes.find((n) => n.id === input.connectFrom);
      position = anchor
        ? { x: Number(anchor.x) + 240, y: Number(anchor.y) }
        : autoLayout([{ id, type: input.type }, ...nodes.map((n) => ({ id: n.id, type: n.type, position: { x: Number(n.x), y: Number(n.y) } }))], []).get(id)!;
    }
    const now = nowIso();
    await ctx.db
      .insertInto('nodes')
      .values({
        id,
        process_id: p.id,
        type: input.type,
        label: input.label,
        description: input.description,
        team_id: input.teamId ?? null,
        actor_role: input.actorRole ?? null,
        duration_minutes: input.durationMinutes ?? null,
        inputs: input.inputs ?? null,
        outputs: input.outputs ?? null,
        linked_process_id: input.linkedProcessId ?? null,
        x: position.x,
        y: position.y,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await replaceLinks(ctx.db, 'node_systems', id, input.systemIds);
    await replaceLinks(ctx.db, 'node_risks', id, input.riskIds);
    await replaceLinks(ctx.db, 'node_controls', id, input.controlIds);
    const edges = [
      input.connectFrom ? { s: input.connectFrom, t: id, label: input.edgeLabel ?? null } : null,
      input.connectTo ? { s: id, t: input.connectTo, label: null } : null,
    ].filter((e): e is { s: string; t: string; label: string | null } => Boolean(e));
    for (const e of edges) {
      await ctx.db
        .insertInto('edges')
        .values({ id: newId(), process_id: p.id, source_node_id: e.s, target_node_id: e.t, label: e.label, created_at: now })
        .execute();
    }
    const row = await ctx.db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return (await nodeDtos(ctx.db, [row]))[0];
  },
});

async function validateNodeRefs(
  ctx: OpContext,
  processId: string,
  n: { teamId?: string | null; systemIds?: string[]; riskIds?: string[]; controlIds?: string[]; linkedProcessId?: string | null },
) {
  await assertExists(ctx.db, 'teams', [n.teamId], 'team ids');
  await assertExists(ctx.db, 'systems', n.systemIds ?? [], 'system ids');
  await assertExists(ctx.db, 'risks', n.riskIds ?? [], 'risk ids');
  await assertExists(ctx.db, 'controls', n.controlIds ?? [], 'control ids');
  await assertExists(ctx.db, 'processes', [n.linkedProcessId], 'linked process ids');
  if (n.linkedProcessId === processId) throw new ValidationError('A process cannot link to itself');
}

async function loadNode(ctx: OpContext, id: string) {
  const node = await ctx.db.selectFrom('nodes').selectAll().where('id', '=', id).executeTakeFirst();
  if (!node) throw new NotFoundError('Node', id);
  return node;
}

export const updateNode = defineOp({
  name: 'node.update',
  group: GD,
  summary: 'Update a step (node)',
  description: 'Partial update. Supplying systemIds/riskIds/controlIds replaces that list.',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/nodes/:id' },
  targetType: 'process',
  input: z.object({
    id: Id,
    type: NodeFields.type.unwrap().optional(),
    label: NodeFields.label.optional(),
    description: z.string().max(20_000).optional(),
    teamId: NodeFields.teamId,
    actorRole: NodeFields.actorRole,
    durationMinutes: NodeFields.durationMinutes,
    inputs: NodeFields.inputs,
    outputs: NodeFields.outputs,
    linkedProcessId: NodeFields.linkedProcessId,
    position: Position.optional(),
    systemIds: z.array(z.string()).max(100).optional(),
    riskIds: z.array(z.string()).max(100).optional(),
    controlIds: z.array(z.string()).max(100).optional(),
  }),
  handler: async (ctx, input) => {
    const node = await loadNode(ctx, input.id);
    const p = await loadProcess(ctx.db, node.process_id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await validateNodeRefs(ctx, p.id, input);
    await touchProcess(ctx, p);
    const set: Record<string, unknown> = { updated_at: nowIso() };
    const map: Record<string, string> = {
      type: 'type',
      label: 'label',
      description: 'description',
      teamId: 'team_id',
      actorRole: 'actor_role',
      durationMinutes: 'duration_minutes',
      inputs: 'inputs',
      outputs: 'outputs',
      linkedProcessId: 'linked_process_id',
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) set[col] = v;
    }
    if (input.position) {
      set.x = input.position.x;
      set.y = input.position.y;
    }
    await ctx.db.updateTable('nodes').set(set).where('id', '=', node.id).execute();
    if (input.systemIds) await replaceLinks(ctx.db, 'node_systems', node.id, input.systemIds);
    if (input.riskIds) await replaceLinks(ctx.db, 'node_risks', node.id, input.riskIds);
    if (input.controlIds) await replaceLinks(ctx.db, 'node_controls', node.id, input.controlIds);
    const row = await ctx.db.selectFrom('nodes').selectAll().where('id', '=', node.id).executeTakeFirstOrThrow();
    return (await nodeDtos(ctx.db, [row]))[0];
  },
});

export const deleteNode = defineOp({
  name: 'node.delete',
  group: GD,
  summary: 'Remove a step (node) and its connections',
  description: 'Set `reconnect` to join each predecessor to each successor so the flow is not broken.',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'DELETE', path: '/nodes/:id' },
  targetType: 'process',
  input: z.object({ id: Id, reconnect: z.coerce.boolean().default(false) }),
  handler: async (ctx, input) => {
    const node = await loadNode(ctx, input.id);
    const p = await loadProcess(ctx.db, node.process_id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await touchProcess(ctx, p);
    const edges = await ctx.db.selectFrom('edges').selectAll().where('process_id', '=', p.id).execute();
    await ctx.db.deleteFrom('nodes').where('id', '=', node.id).execute();
    if (input.reconnect) {
      const preds = edges.filter((e) => e.target_node_id === node.id);
      const succs = edges.filter((e) => e.source_node_id === node.id);
      const now = nowIso();
      for (const a of preds)
        for (const b of succs) {
          if (a.source_node_id === b.target_node_id) continue;
          if (edges.some((e) => e.source_node_id === a.source_node_id && e.target_node_id === b.target_node_id)) continue;
          await ctx.db
            .insertInto('edges')
            .values({ id: newId(), process_id: p.id, source_node_id: a.source_node_id, target_node_id: b.target_node_id, label: a.label, created_at: now })
            .execute();
        }
    }
    return { deleted: true, id: node.id };
  },
});

export const addEdge = defineOp({
  name: 'edge.create',
  group: GD,
  summary: 'Connect two steps',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:processId/edges' },
  targetType: 'process',
  input: z.object({
    processId: Id,
    source: Id.describe('Source node id'),
    target: Id.describe('Target node id'),
    label: z.string().max(300).nullish().describe('Condition / outcome label'),
  }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.processId);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    if (input.source === input.target) throw new ValidationError('An edge cannot connect a node to itself');
    const nodes = await ctx.db.selectFrom('nodes').select('id').where('process_id', '=', p.id).where('id', 'in', [input.source, input.target]).execute();
    if (nodes.length !== 2) throw new ValidationError('Both nodes must belong to this process');
    await touchProcess(ctx, p);
    const row = {
      id: newId(),
      process_id: p.id,
      source_node_id: input.source,
      target_node_id: input.target,
      label: input.label ?? null,
      created_at: nowIso(),
    };
    await ctx.db.insertInto('edges').values(row).execute();
    return edgeDto(row);
  },
});

export const updateEdge = defineOp({
  name: 'edge.update',
  group: GD,
  summary: 'Change the label of a connection',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'PATCH', path: '/edges/:id' },
  targetType: 'process',
  input: z.object({ id: Id, label: z.string().max(300).nullable() }),
  handler: async (ctx, input) => {
    const edge = await ctx.db.selectFrom('edges').selectAll().where('id', '=', input.id).executeTakeFirst();
    if (!edge) throw new NotFoundError('Edge', input.id);
    const p = await loadProcess(ctx.db, edge.process_id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await touchProcess(ctx, p);
    await ctx.db.updateTable('edges').set({ label: input.label }).where('id', '=', edge.id).execute();
    return edgeDto({ ...edge, label: input.label });
  },
});

export const deleteEdge = defineOp({
  name: 'edge.delete',
  group: GD,
  summary: 'Remove a connection between steps',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'DELETE', path: '/edges/:id' },
  targetType: 'process',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const edge = await ctx.db.selectFrom('edges').selectAll().where('id', '=', input.id).executeTakeFirst();
    if (!edge) throw new NotFoundError('Edge', input.id);
    const p = await loadProcess(ctx.db, edge.process_id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    await touchProcess(ctx, p);
    await ctx.db.deleteFrom('edges').where('id', '=', edge.id).execute();
    return { deleted: true, id: edge.id };
  },
});

// ------------------------------------------------------------------ lifecycle

export const submitForReview = defineOp({
  name: 'process.submitForReview',
  group: GW,
  summary: 'Submit a draft for approval',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/submit' },
  targetType: 'process',
  input: z.object({ id: Id, note: z.string().max(2000).optional() }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    if (p.status !== 'draft') throw new ValidationError(`Only draft processes can be submitted (current status: ${p.status})`);
    const nodeCount = Number(
      (await ctx.db.selectFrom('nodes').select((eb) => eb.fn.countAll<number>().as('n')).where('process_id', '=', p.id).executeTakeFirst())?.n ?? 0,
    );
    if (nodeCount === 0) throw new ValidationError('Add at least one step before submitting for review');
    await ctx.db
      .updateTable('processes')
      .set({ status: 'in_review', submitted_by: ctx.actor.id, submitted_at: nowIso(), updated_at: nowIso(), updated_by: ctx.actor.id })
      .where('id', '=', p.id)
      .execute();
    if (input.note) await addSystemComment(ctx, p.id, `Submitted for review: ${input.note}`);
    return processDto(ctx.db, await loadProcess(ctx.db, p.id));
  },
});

async function addSystemComment(ctx: OpContext, processId: string, body: string) {
  const now = nowIso();
  await ctx.db
    .insertInto('comments')
    .values({ id: newId(), process_id: processId, node_id: null, author_id: ctx.actor.id, body, resolved: 0, created_at: now, updated_at: now })
    .execute();
}

export const approveProcess = defineOp({
  name: 'process.publish',
  group: GW,
  summary: 'Approve and publish a process',
  description:
    'Creates an immutable numbered version, sets the next review date and marks the process published. When review is required the process must be in_review, and (unless self-approval is allowed) approved by someone other than the submitter.',
  permission: 'process:publish',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/publish' },
  targetType: 'process',
  input: z.object({ id: Id, changeNote: z.string().max(2000).default('') }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    const settings = await getSettings(ctx.db);
    if (p.status === 'archived' || p.status === 'published') throw new ValidationError(`Process is already ${p.status}`);
    if (settings.requireReview && p.status !== 'in_review') {
      throw new ValidationError('Process must be submitted for review before it can be published');
    }
    if (
      settings.requireReview &&
      !settings.allowSelfApproval &&
      ctx.actor.type !== 'system' &&
      p.submitted_by &&
      p.submitted_by === ctx.actor.id
    ) {
      throw new ForbiddenError('Segregation of duties: you cannot approve a process you submitted');
    }
    const now = nowIso();
    const version = await createVersion(ctx, p.id, input.changeNote);
    await ctx.db
      .updateTable('processes')
      .set({
        status: 'published',
        published_version: version,
        next_review_at: p.review_interval_days ? addDays(now, p.review_interval_days) : null,
        updated_at: now,
        updated_by: ctx.actor.id,
      })
      .where('id', '=', p.id)
      .execute();
    ctx.auditDetail = { version };
    return processDto(ctx.db, await loadProcess(ctx.db, p.id));
  },
});

export const requestChanges = defineOp({
  name: 'process.requestChanges',
  group: GW,
  summary: 'Reject a submission and return it to draft',
  permission: 'process:publish',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/request-changes' },
  targetType: 'process',
  input: z.object({ id: Id, reason: z.string().min(1).max(4000) }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    if (p.status !== 'in_review') throw new ValidationError('Process is not in review');
    await ctx.db
      .updateTable('processes')
      .set({ status: 'draft', updated_at: nowIso(), updated_by: ctx.actor.id })
      .where('id', '=', p.id)
      .execute();
    await addSystemComment(ctx, p.id, `Changes requested: ${input.reason}`);
    return processDto(ctx.db, await loadProcess(ctx.db, p.id));
  },
});

export const archiveProcess = defineOp({
  name: 'process.archive',
  group: GW,
  summary: 'Archive (retire) a process',
  permission: 'process:publish',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/archive' },
  targetType: 'process',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    await ctx.db
      .updateTable('processes')
      .set({ status: 'archived', updated_at: nowIso(), updated_by: ctx.actor.id })
      .where('id', '=', p.id)
      .execute();
    return processDto(ctx.db, await loadProcess(ctx.db, p.id));
  },
});

export const restoreProcess = defineOp({
  name: 'process.restore',
  group: GW,
  summary: 'Restore an archived process to draft',
  permission: 'process:publish',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/restore' },
  targetType: 'process',
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    if (p.status !== 'archived') throw new ValidationError('Process is not archived');
    await ctx.db
      .updateTable('processes')
      .set({ status: 'draft', updated_at: nowIso(), updated_by: ctx.actor.id })
      .where('id', '=', p.id)
      .execute();
    return processDto(ctx.db, await loadProcess(ctx.db, p.id));
  },
});

export const markReviewed = defineOp({
  name: 'process.certify',
  group: GW,
  summary: 'Certify a published process is still accurate',
  description: 'Records a periodic review without changing content and pushes out the next review date.',
  permission: 'process:publish',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/certify' },
  targetType: 'process',
  input: z.object({ id: Id, note: z.string().max(2000).optional() }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    if (p.status !== 'published') throw new ValidationError('Only published processes can be certified');
    const now = nowIso();
    await ctx.db
      .updateTable('processes')
      .set({ next_review_at: p.review_interval_days ? addDays(now, p.review_interval_days) : null })
      .where('id', '=', p.id)
      .execute();
    await addSystemComment(ctx, p.id, `Periodic review completed${input.note ? `: ${input.note}` : ''}`);
    return processDto(ctx.db, await loadProcess(ctx.db, p.id));
  },
});

// ------------------------------------------------------------------ versions

export const listVersions = defineOp({
  name: 'process.versions',
  group: GW,
  summary: 'List published versions of a process',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:id/versions' },
  input: z.object({ id: Id }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    const rows = await ctx.db
      .selectFrom('process_versions')
      .leftJoin('users', 'users.id', 'process_versions.published_by')
      .select(['process_versions.version', 'process_versions.change_note', 'process_versions.published_at', 'users.name as published_by'])
      .where('process_id', '=', p.id)
      .orderBy('version', 'desc')
      .execute();
    return rows.map((r) => ({ version: r.version, changeNote: r.change_note, publishedAt: r.published_at, publishedBy: r.published_by }));
  },
});

export const getVersion = defineOp({
  name: 'process.getVersion',
  group: GW,
  summary: 'Get the frozen content of a published version',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:id/versions/:version' },
  input: z.object({ id: Id, version: z.coerce.number().int().min(1) }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    const row = await ctx.db
      .selectFrom('process_versions')
      .selectAll()
      .where('process_id', '=', p.id)
      .where('version', '=', input.version)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Version', String(input.version));
    return { version: row.version, changeNote: row.change_note, publishedAt: row.published_at, snapshot: parseJson<Snapshot | null>(row.snapshot, null) };
  },
});

export const compareVersions = defineOp({
  name: 'process.compare',
  group: GW,
  summary: 'Compare two versions (or a version with the current draft)',
  description: 'Lists steps added, removed and changed. Omit `to` to compare against the current working copy.',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:id/compare' },
  input: z.object({ id: Id, from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1).optional() }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    const load = async (v: number): Promise<Snapshot> => {
      const row = await ctx.db.selectFrom('process_versions').select('snapshot').where('process_id', '=', p.id).where('version', '=', v).executeTakeFirst();
      if (!row) throw new NotFoundError('Version', String(v));
      return JSON.parse(row.snapshot) as Snapshot;
    };
    const a = await load(input.from);
    const b = input.to ? await load(input.to) : await buildSnapshot(ctx.db, await processDto(ctx.db, p));
    const am = new Map(a.nodes.map((n) => [n.id, n]));
    const bm = new Map(b.nodes.map((n) => [n.id, n]));
    const sig = (n: Snapshot['nodes'][number]) =>
      JSON.stringify([n.type, n.label, n.description, n.team?.name, n.actorRole, n.durationMinutes, n.systems.map((s) => s.name).sort(), n.risks.map((r) => r.title).sort(), n.controls.map((c) => c.name).sort()]);
    const edgeKey = (s: Snapshot, e: Snapshot['edges'][number]) => {
      const l = (id: string) => s.nodes.find((n) => n.id === id)?.label ?? id;
      return `${l(e.source)} → ${l(e.target)}${e.label ? ` [${e.label}]` : ''}`;
    };
    const ae = new Set(a.edges.map((e) => edgeKey(a, e)));
    const be = new Set(b.edges.map((e) => edgeKey(b, e)));
    const metaChanged = (['name', 'summary', 'description', 'category'] as const).filter((k) => (a.process[k] ?? '') !== (b.process[k] ?? ''));
    return {
      from: input.from,
      to: input.to ?? 'current',
      metadataChanged: metaChanged,
      added: b.nodes.filter((n) => !am.has(n.id)).map((n) => ({ id: n.id, label: n.label })),
      removed: a.nodes.filter((n) => !bm.has(n.id)).map((n) => ({ id: n.id, label: n.label })),
      changed: b.nodes.filter((n) => am.has(n.id) && sig(am.get(n.id)!) !== sig(n)).map((n) => ({ id: n.id, label: n.label, previousLabel: am.get(n.id)!.label })),
      edgesAdded: [...be].filter((k) => !ae.has(k)),
      edgesRemoved: [...ae].filter((k) => !be.has(k)),
    };
  },
});

export const revertToVersion = defineOp({
  name: 'process.revert',
  group: GW,
  summary: 'Restore the working copy from a published version',
  description: 'Replaces the current draft content with the content of the given version. The process becomes a draft.',
  permission: 'process:write',
  kind: 'write',
  http: { method: 'POST', path: '/processes/:id/revert' },
  targetType: 'process',
  input: z.object({ id: Id, version: z.number().int().min(1) }),
  handler: async (ctx, input) => {
    const p = await loadProcess(ctx.db, input.id);
    ctx.target = { type: 'process', id: p.id };
    await assertCanEditProcess(ctx, p);
    const row = await ctx.db
      .selectFrom('process_versions')
      .select('snapshot')
      .where('process_id', '=', p.id)
      .where('version', '=', input.version)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Version', String(input.version));
    const snap = SnapshotSchema.parse(JSON.parse(row.snapshot));
    await touchProcess(ctx, p);
    const resolved = await resolveSnapshot(ctx, snap, { preserveNodeIds: true });
    await ctx.db
      .updateTable('processes')
      .set({
        name: snap.process.name,
        summary: snap.process.summary,
        description: snap.process.description,
        category: snap.process.category ?? null,
        owner_team_id: resolved.ownerTeamId,
      })
      .where('id', '=', p.id)
      .execute();
    await setProcessTags(ctx.db, p.id, resolved.tagIds);
    await writeDiagram(ctx, p, resolved.nodes, resolved.edges);
    return fullProcess(ctx, p.id);
  },
});

export const processOps = [
  listProcesses,
  getProcess,
  createProcess,
  updateProcess,
  deleteProcess,
  duplicateProcess,
  importProcess,
  saveDiagram,
  addNode,
  updateNode,
  deleteNode,
  addEdge,
  updateEdge,
  deleteEdge,
  submitForReview,
  approveProcess,
  requestChanges,
  archiveProcess,
  restoreProcess,
  markReviewed,
  listVersions,
  getVersion,
  compareVersions,
  revertToVersion,
];

export { PROCESS_STATUSES };

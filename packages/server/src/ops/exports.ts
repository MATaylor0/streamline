import { z } from 'zod';
import { defineOp } from '../core/operation.js';
import { NotFoundError } from '../core/errors.js';
import type { DB } from '../db/schema.js';
import { nowIso, parseJson } from '../lib/util.js';
import { Id, getSettings, loadDiagram, loadProcess, processDto, processDtos } from './shared.js';
import { SnapshotSchema, buildSnapshot, type Snapshot } from './snapshot.js';

export interface FileResult {
  filename: string;
  contentType: string;
  content: string;
}

type SNode = Snapshot['nodes'][number];

const xml = (s: string | null | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'process';

/** Steps in reading order: breadth-first from start nodes, then anything unreachable. */
export function orderSteps(snap: Snapshot): SNode[] {
  const out = new Map<string, string[]>();
  const indeg = new Map(snap.nodes.map((n) => [n.id, 0]));
  for (const e of snap.edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const byPos = [...snap.nodes].sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0));
  const starts = byPos.filter((n) => n.type === 'start' || (indeg.get(n.id) ?? 0) === 0);
  const seen = new Set<string>();
  const order: SNode[] = [];
  const map = new Map(snap.nodes.map((n) => [n.id, n]));
  const queue = starts.map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(map.get(id)!);
    for (const t of out.get(id) ?? []) if (!seen.has(t)) queue.push(t);
  }
  for (const n of byPos) if (!seen.has(n.id)) order.push(n);
  // Keep end events last for readability.
  return [...order.filter((n) => n.type !== 'end'), ...order.filter((n) => n.type === 'end')];
}

// ------------------------------------------------------------------ BPMN 2.0

const BPMN_SIZE: Record<string, [number, number]> = {
  start: [36, 36],
  end: [36, 36],
  event: [36, 36],
  decision: [50, 50],
};

export function toBpmn(snap: Snapshot): string {
  const pid = 'Process_1';
  const nid = (id: string) => `N_${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const flows = snap.edges
    .map((e, i) => ({ ...e, id: `Flow_${i + 1}` }))
    .filter((e) => {
      const s = snap.nodes.find((n) => n.id === e.source);
      const t = snap.nodes.find((n) => n.id === e.target);
      return s && t && s.type !== 'note' && t.type !== 'note';
    });
  const lanes = new Map<string, SNode[]>();
  for (const n of snap.nodes) {
    if (n.type === 'note') continue;
    const key = n.team?.name ?? 'Unassigned';
    lanes.set(key, [...(lanes.get(key) ?? []), n]);
  }

  const el = (n: SNode): string => {
    const inc = flows.filter((f) => f.target === n.id).map((f) => `<bpmn:incoming>${f.id}</bpmn:incoming>`).join('');
    const outg = flows.filter((f) => f.source === n.id).map((f) => `<bpmn:outgoing>${f.id}</bpmn:outgoing>`).join('');
    const doc = [n.description, n.actorRole ? `Role: ${n.actorRole}` : '', n.systems.length ? `Systems: ${n.systems.map((s) => s.name).join(', ')}` : '', n.risks.length ? `Risks: ${n.risks.map((r) => r.title).join('; ')}` : '', n.controls.length ? `Controls: ${n.controls.map((c) => c.name).join('; ')}` : '']
      .filter(Boolean)
      .join('\n');
    const body = `${doc ? `<bpmn:documentation>${xml(doc)}</bpmn:documentation>` : ''}${inc}${outg}`;
    const attrs = `id="${nid(n.id)}" name="${xml(n.label)}"`;
    switch (n.type) {
      case 'start':
        return `<bpmn:startEvent ${attrs}>${body}</bpmn:startEvent>`;
      case 'end':
        return `<bpmn:endEvent ${attrs}>${body}</bpmn:endEvent>`;
      case 'event':
        return `<bpmn:intermediateThrowEvent ${attrs}>${body}</bpmn:intermediateThrowEvent>`;
      case 'decision':
        return `<bpmn:exclusiveGateway ${attrs}>${body}</bpmn:exclusiveGateway>`;
      case 'subprocess':
        return `<bpmn:callActivity ${attrs}${n.linkedProcess?.ref ? ` calledElement="${xml(n.linkedProcess.ref)}"` : ''}>${body}</bpmn:callActivity>`;
      case 'system':
        return `<bpmn:serviceTask ${attrs}>${body}</bpmn:serviceTask>`;
      default:
        return `<bpmn:${n.actorRole || n.team ? 'userTask' : 'task'} ${attrs}>${body}</bpmn:${n.actorRole || n.team ? 'userTask' : 'task'}>`;
    }
  };

  const notes = snap.nodes.filter((n) => n.type === 'note');
  const flowNodes = snap.nodes.filter((n) => n.type !== 'note');
  const bounds = (n: SNode) => {
    const [w, h] = BPMN_SIZE[n.type] ?? [140, 70];
    const x = Math.round((n.position?.x ?? 0) + 200);
    const y = Math.round((n.position?.y ?? 0) + 100 + (70 - h) / 2);
    return { x, y, w, h };
  };

  const shapes = snap.nodes
    .map((n) => {
      const b = bounds(n);
      const extra = n.type === 'decision' ? ' isMarkerVisible="true"' : '';
      return `<bpmndi:BPMNShape id="${nid(n.id)}_di" bpmnElement="${nid(n.id)}"${extra}><dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" /></bpmndi:BPMNShape>`;
    })
    .join('\n      ');
  const edges = flows
    .map((f) => {
      const s = bounds(snap.nodes.find((n) => n.id === f.source)!);
      const t = bounds(snap.nodes.find((n) => n.id === f.target)!);
      return `<bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}"><di:waypoint x="${s.x + s.w}" y="${s.y + s.h / 2}" /><di:waypoint x="${t.x}" y="${t.y + t.h / 2}" /></bpmndi:BPMNEdge>`;
    })
    .join('\n      ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="urn:streamline:bpmn" exporter="Streamline" exporterVersion="1.0">
  <bpmn:process id="${pid}" name="${xml(snap.process.name)}" isExecutable="false">
    <bpmn:documentation>${xml([snap.process.ref, snap.process.summary].filter(Boolean).join(' — '))}</bpmn:documentation>
    <bpmn:laneSet id="LaneSet_1">
${[...lanes.entries()].map(([name, nodes], i) => `      <bpmn:lane id="Lane_${i + 1}" name="${xml(name)}">${nodes.map((n) => `<bpmn:flowNodeRef>${nid(n.id)}</bpmn:flowNodeRef>`).join('')}</bpmn:lane>`).join('\n')}
    </bpmn:laneSet>
    ${flowNodes.map(el).join('\n    ')}
    ${flows.map((f) => `<bpmn:sequenceFlow id="${f.id}" sourceRef="${nid(f.source)}" targetRef="${nid(f.target)}"${f.label ? ` name="${xml(f.label)}"` : ''} />`).join('\n    ')}
    ${notes.map((n) => `<bpmn:textAnnotation id="${nid(n.id)}"><bpmn:text>${xml([n.label, n.description].filter(Boolean).join(': '))}</bpmn:text></bpmn:textAnnotation>`).join('\n    ')}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${pid}">
      ${shapes}
      ${edges}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

// ------------------------------------------------------------------ Mermaid

export function toMermaid(snap: Snapshot): string {
  const id = (n: string) => `n_${n.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
  const label = (s: string) => s.replace(/"/g, '#quot;').replace(/\n/g, ' ');
  const shape = (n: SNode) => {
    const l = `"${label(n.label)}"`;
    switch (n.type) {
      case 'start':
      case 'end':
      case 'event':
        return `((${l}))`;
      case 'decision':
        return `{${l}}`;
      case 'subprocess':
        return `[[${l}]]`;
      case 'document':
        return `[/${l}/]`;
      case 'system':
        return `[(${l})]`;
      case 'note':
        return `>${l}]`;
      default:
        return `[${l}]`;
    }
  };
  const lines = ['flowchart LR'];
  const lanes = new Map<string, SNode[]>();
  const loose: SNode[] = [];
  for (const n of snap.nodes) {
    if (n.team) lanes.set(n.team.name, [...(lanes.get(n.team.name) ?? []), n]);
    else loose.push(n);
  }
  let i = 0;
  for (const [team, nodes] of lanes) {
    lines.push(`  subgraph lane${++i}["${label(team)}"]`);
    for (const n of nodes) lines.push(`    ${id(n.id)}${shape(n)}`);
    lines.push('  end');
  }
  for (const n of loose) lines.push(`  ${id(n.id)}${shape(n)}`);
  for (const e of snap.edges) lines.push(`  ${id(e.source)} -->${e.label ? `|"${label(e.label)}"|` : ''} ${id(e.target)}`);
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------ Markdown

export function toMarkdown(snap: Snapshot, meta: { status?: string; owner?: string | null; version?: number | null }): string {
  const p = snap.process;
  const steps = orderSteps(snap);
  const label = new Map(snap.nodes.map((n) => [n.id, n.label]));
  const out: string[] = [];
  out.push(`# ${p.ref ? `${p.ref} — ` : ''}${p.name}`, '');
  const rows: Array<[string, string | null | undefined]> = [
    ['Status', meta.status],
    ['Published version', meta.version ? String(meta.version) : null],
    ['Category', p.category],
    ['Owning team', p.ownerTeam?.name],
    ['Process owner', meta.owner],
    ['Tags', p.tags.join(', ')],
  ];
  out.push('| | |', '|---|---|', ...rows.filter(([, v]) => v).map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`), '');
  if (p.summary) out.push(`> ${p.summary}`, '');
  if (p.description) out.push('## Description', '', p.description, '');
  out.push('## Steps', '');
  let n = 0;
  for (const s of steps) {
    if (s.type === 'note') continue;
    const prefix = s.type === 'start' ? '▶' : s.type === 'end' ? '■' : `${++n}.`;
    const who = [s.team?.name, s.actorRole].filter(Boolean).join(' / ');
    out.push(`### ${prefix} ${s.label}${s.type === 'decision' ? ' (decision)' : ''}${s.type === 'subprocess' ? ' (sub-process)' : ''}`, '');
    if (who) out.push(`**Performed by:** ${who}  `);
    if (s.durationMinutes) out.push(`**Typical duration:** ${s.durationMinutes} min  `);
    if (s.systems.length) out.push(`**Systems:** ${s.systems.map((x) => x.name).join(', ')}  `);
    if (s.linkedProcess) out.push(`**Invokes:** ${s.linkedProcess.ref ?? ''} ${s.linkedProcess.name}  `);
    if (s.inputs) out.push(`**Inputs:** ${s.inputs}  `);
    if (s.outputs) out.push(`**Outputs:** ${s.outputs}  `);
    if (s.risks.length) out.push(`**Risks:** ${s.risks.map((r) => `${r.ref ?? ''} ${r.title}`.trim()).join('; ')}  `);
    if (s.controls.length) out.push(`**Controls:** ${s.controls.map((c) => `${c.ref ?? ''} ${c.name}`.trim()).join('; ')}  `);
    if (s.description) out.push('', s.description);
    const next = snap.edges.filter((e) => e.source === s.id);
    if (next.length) {
      out.push('');
      for (const e of next) out.push(`- ${e.label ? `**${e.label}:** ` : ''}→ ${label.get(e.target)}`);
    }
    out.push('');
  }
  const notes = snap.nodes.filter((s) => s.type === 'note');
  if (notes.length) out.push('## Notes', '', ...notes.map((s) => `- **${s.label}** ${s.description}`), '');
  return out.join('\n');
}

// ------------------------------------------------------------------ ops

export const exportProcess = defineOp({
  name: 'process.export',
  group: 'Import & export',
  summary: 'Export a process as JSON, BPMN 2.0 XML, Mermaid or Markdown',
  description:
    'json = portable Streamline document (re-importable); bpmn = BPMN 2.0 XML with lanes and diagram layout (opens in Camunda, Signavio, bpmn.io, Visio); mermaid = flowchart text; markdown = readable procedure document. Set `version` to export a published version instead of the working copy.',
  permission: 'process:read',
  kind: 'read',
  http: { method: 'GET', path: '/processes/:id/export' },
  file: true,
  input: z.object({
    id: Id,
    format: z.enum(['json', 'bpmn', 'mermaid', 'markdown']).default('json'),
    version: z.coerce.number().int().min(1).optional(),
  }),
  handler: async (ctx, input): Promise<FileResult> => {
    const row = await loadProcess(ctx.db, input.id);
    const dto = await processDto(ctx.db, row);
    let snap: Snapshot;
    if (input.version) {
      const v = await ctx.db.selectFrom('process_versions').select('snapshot').where('process_id', '=', row.id).where('version', '=', input.version).executeTakeFirst();
      if (!v) throw new NotFoundError('Version', String(input.version));
      snap = SnapshotSchema.parse(JSON.parse(v.snapshot));
    } else {
      snap = await buildSnapshot(ctx.db, dto);
    }
    const base = `${row.ref}-${slug(row.name)}${input.version ? `-v${input.version}` : ''}`;
    switch (input.format) {
      case 'bpmn':
        return { filename: `${base}.bpmn`, contentType: 'application/xml', content: toBpmn(snap) };
      case 'mermaid':
        return { filename: `${base}.mmd`, contentType: 'text/plain', content: toMermaid(snap) };
      case 'markdown':
        return {
          filename: `${base}.md`,
          contentType: 'text/markdown',
          content: toMarkdown(snap, { status: input.version ? 'published' : dto.status, owner: dto.ownerUser?.name, version: input.version ?? dto.publishedVersion }),
        };
      default:
        return { filename: `${base}.json`, contentType: 'application/json', content: JSON.stringify(snap, null, 2) };
    }
  },
});

async function dumpAll(db: DB) {
  const processes = await db.selectFrom('processes').selectAll().orderBy('ref').execute();
  const dtos = await processDtos(db, processes);
  const withDiagrams = [];
  for (const p of dtos) withDiagrams.push({ ...p, ...(await loadDiagram(db, p.id)) });
  const [teams, members, systems, risks, controls, riskControls, tags, users, versions] = await Promise.all([
    db.selectFrom('teams').selectAll().orderBy('name').execute(),
    db.selectFrom('team_members').selectAll().execute(),
    db.selectFrom('systems').selectAll().orderBy('name').execute(),
    db.selectFrom('risks').selectAll().orderBy('ref').execute(),
    db.selectFrom('controls').selectAll().orderBy('ref').execute(),
    db.selectFrom('risk_controls').selectAll().execute(),
    db.selectFrom('tags').selectAll().orderBy('name').execute(),
    db.selectFrom('users').select(['id', 'email', 'name', 'role', 'kind', 'status', 'auth_provider', 'created_at']).orderBy('name').execute(),
    db.selectFrom('process_versions').select(['process_id', 'version', 'change_note', 'published_at', 'snapshot']).orderBy('process_id').orderBy('version').execute(),
  ]);
  return {
    format: 'streamline.export.v1',
    exportedAt: nowIso(),
    settings: await getSettings(db),
    teams: teams.map((t) => ({ ...t, members: members.filter((m) => m.team_id === t.id).map((m) => ({ userId: m.user_id, role: m.role })) })),
    users,
    systems,
    risks: risks.map((r) => ({ ...r, controlIds: riskControls.filter((x) => x.risk_id === r.id).map((x) => x.control_id) })),
    controls,
    tags,
    processes: withDiagrams,
    versions: versions.map((v) => ({ processId: v.process_id, version: v.version, changeNote: v.change_note, publishedAt: v.published_at, snapshot: parseJson(v.snapshot, null) })),
  };
}

export const exportAll = defineOp({
  name: 'export.all',
  group: 'Import & export',
  summary: 'Export the entire repository as one JSON document',
  description: 'Processes with full diagrams and versions, teams, systems, risks, controls, tags and users (without credentials). For backups, data warehouses or migration.',
  permission: 'data:export',
  kind: 'read',
  http: { method: 'GET', path: '/export' },
  file: true,
  alwaysAudit: true,
  input: z.object({}),
  handler: async (ctx): Promise<FileResult> => ({
    filename: `streamline-export-${nowIso().slice(0, 10)}.json`,
    contentType: 'application/json',
    content: JSON.stringify(await dumpAll(ctx.db), null, 2),
  }),
});

export const exportOps = [exportProcess, exportAll];

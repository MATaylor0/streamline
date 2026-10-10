import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, simpleDiagram, type TestContext } from './helpers.js';
import { AppError } from '../src/core/errors.js';

let t: TestContext;
let teams: { a: string; b: string };

beforeAll(async () => {
  t = await createTestApp();
  const a = await t.run('team.create', { name: 'Team A' });
  const b = await t.run('team.create', { name: 'Team B' });
  teams = { a: a.id, b: b.id };
});
afterAll(async () => t.close());

async function expectError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

describe('permissions (shared by every transport)', () => {
  it('viewers can read but not write, and denials are audited', async () => {
    const viewer = await t.user('viewer');
    await t.run('process.list', {}, viewer.actor);
    await expectError(t.run('process.create', { name: 'Nope' }, viewer.actor), 'forbidden');
    const audit = await t.run('audit.list', { actorId: viewer.id, outcome: 'denied' });
    expect(audit.items[0].operation).toBe('process.create');
  });

  it('read-only tokens cannot write even for editors', async () => {
    const editor = await t.user('editor', { scope: 'read' });
    const err = await expectError(t.run('process.create', { name: 'Nope' }, editor.actor), 'forbidden');
    expect(err.message).toMatch(/read-only/);
    await t.run('process.list', {}, editor.actor);
  });

  it('editors cannot publish; approvers can, but not their own submission', async () => {
    const editor = await t.user('editor');
    const approver = await t.user('approver');
    const p = await t.run('process.create', { name: 'Expense claims', ...simpleDiagram(teams) }, editor.actor);
    await expectError(t.run('process.publish', { id: p.id }, editor.actor), 'forbidden');
    await expectError(t.run('process.publish', { id: p.id }, approver.actor), 'validation_error'); // not in review yet

    await t.run('process.submitForReview', { id: p.id }, approver.actor);
    await expectError(t.run('process.publish', { id: p.id }, approver.actor), 'forbidden'); // segregation of duties

    const other = await t.user('approver');
    const published = await t.run('process.publish', { id: p.id, changeNote: 'v1' }, other.actor);
    expect(published.status).toBe('published');
    expect(published.publishedVersion).toBe(1);
    expect(published.nextReviewAt).toBeTruthy();
  });

  it('enforces team ownership when enabled', async () => {
    const owner = await t.user('editor');
    const outsider = await t.user('editor');
    await t.run('team.addMember', { teamId: teams.a, userId: owner.id });
    const p = await t.run('process.create', { name: 'Owned', ownerTeamId: teams.a }, owner.actor);
    await t.run('settings.update', { enforceTeamOwnership: true });
    try {
      await expectError(t.run('process.update', { id: p.id, summary: 'x' }, outsider.actor), 'forbidden');
      await t.run('process.update', { id: p.id, summary: 'ok' }, owner.actor);
    } finally {
      await t.run('settings.update', { enforceTeamOwnership: false });
    }
  });

  it('keeps at least one administrator', async () => {
    const me = await t.run('user.list', { q: 'admin@example.com' });
    await expectError(t.run('user.update', { id: me.items[0].id, role: 'viewer' }), 'validation_error');
  });

  it('validates input with field-level details', async () => {
    const err = await expectError(t.run('risk.create', { title: '', likelihood: 9 }), 'validation_error');
    expect(JSON.stringify(err.details)).toMatch(/likelihood/);
  });
});

describe('process lifecycle', () => {
  it('creates a full diagram in one call with temporary ids and auto layout', async () => {
    const p = await t.run('process.create', { name: 'Access request', ...simpleDiagram(teams), tags: ['security'] });
    expect(p.ref).toMatch(/^PRC-\d{4}$/);
    expect(p.nodes).toHaveLength(5);
    expect(p.edges).toHaveLength(5);
    expect(p.tags.map((x: { name: string }) => x.name)).toEqual(['security']);
    const xs = new Map(p.nodes.map((n: any) => [n.label, n.position.x]));
    expect(xs.get('Start')).toBeLessThan(xs.get('Prepare request') as number);
    expect(xs.get('Prepare request')).toBeLessThan(xs.get('Fulfil request') as number); // loop edge ignored by layout
  });

  it('saveDiagram keeps existing node ids, detects concurrent edits and drafts published processes', async () => {
    const p = await t.run('process.create', { name: 'Lifecycle', ...simpleDiagram(teams) });
    await t.run('process.submitForReview', { id: p.id });
    await t.run('process.publish', { id: p.id });
    const current = await t.run('process.get', { id: p.ref });
    const keep = current.nodes.find((n: any) => n.label === 'Prepare request');
    const comment = await t.run('comment.create', { processId: p.id, nodeId: keep.id, body: 'Check SLA' });

    const saved = await t.run('process.saveDiagram', {
      id: p.id,
      expectedRevision: current.revision,
      nodes: [
        ...current.nodes.filter((n: any) => n.label !== 'Fulfil request').map((n: any) => ({ ...n })),
        { id: 'new', type: 'task', label: 'Provision access', teamId: teams.b },
      ],
      edges: [
        ...current.edges.filter((e: any) => current.nodes.find((n: any) => n.id === e.target)?.label !== 'Fulfil request' && current.nodes.find((n: any) => n.id === e.source)?.label !== 'Fulfil request'),
        { source: current.nodes.find((n: any) => n.label === 'Approved?').id, target: 'new', label: 'Yes' },
        { source: 'new', target: current.nodes.find((n: any) => n.label === 'Done').id },
      ],
    });
    expect(saved.status).toBe('draft');
    expect(saved.publishedVersion).toBe(1);
    expect(saved.nodes.find((n: any) => n.label === 'Prepare request').id).toBe(keep.id);
    expect(saved.idMap.new).toBeTruthy();
    const comments = await t.run('comment.list', { processId: p.id });
    expect(comments.find((c: any) => c.id === comment.id).nodeId).toBe(keep.id);

    await expectError(t.run('process.update', { id: p.id, expectedRevision: current.revision, name: 'stale' }), 'conflict');

    const diff = await t.run('process.compare', { id: p.id, from: 1 });
    expect(diff.added.map((n: any) => n.label)).toEqual(['Provision access']);
    expect(diff.removed.map((n: any) => n.label)).toEqual(['Fulfil request']);

    const reverted = await t.run('process.revert', { id: p.id, version: 1 });
    expect(reverted.nodes.map((n: any) => n.label).sort()).toEqual(['Approved?', 'Done', 'Fulfil request', 'Prepare request', 'Start']);
    expect(reverted.nodes.find((n: any) => n.label === 'Prepare request').id).toBe(keep.id);
  });

  it('supports granular node and edge edits', async () => {
    const p = await t.run('process.create', { name: 'Granular' });
    const [start, end] = (await t.run('process.get', { id: p.id })).nodes;
    const mid = await t.run('node.create', { processId: p.id, type: 'task', label: 'Middle', connectFrom: start.id, connectTo: end.id });
    let full = await t.run('process.get', { id: p.id });
    expect(full.edges).toHaveLength(2);
    await t.run('node.update', { id: mid.id, label: 'Middle step', durationMinutes: 30 });
    await t.run('node.delete', { id: mid.id, reconnect: true });
    full = await t.run('process.get', { id: p.id });
    expect(full.nodes).toHaveLength(2);
    expect(full.edges).toEqual([expect.objectContaining({ source: start.id, target: end.id })]);
  });

  it('rejects dangling references', async () => {
    await expectError(
      t.run('process.create', { name: 'Bad', nodes: [{ id: 'a', label: 'A', teamId: 'missing' }] }),
      'validation_error',
    );
    await expectError(
      t.run('process.create', { name: 'Bad', nodes: [{ id: 'a', label: 'A' }], edges: [{ source: 'a', target: 'zzz' }] }),
      'validation_error',
    );
  });

  it('round-trips through JSON export and import, and exports BPMN / Mermaid / Markdown', async () => {
    const sys = await t.run('system.create', { name: 'Ticketing' });
    const p = await t.run('process.create', {
      name: 'Exportable',
      nodes: [
        { id: 'a', type: 'start', label: 'Begin' },
        { id: 'b', type: 'task', label: 'Do <work> & "things"', teamId: teams.a, systemIds: [sys.id] },
        { id: 'c', type: 'end', label: 'Finish' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    const json = await t.run('process.export', { id: p.id, format: 'json' });
    const doc = JSON.parse(json.content);
    expect(doc.format).toBe('streamline.process.v1');
    const copy = await t.run('process.import', { document: { ...doc, process: { ...doc.process, name: 'Imported' } } });
    expect(copy.nodes).toHaveLength(3);
    expect(copy.nodes.find((n: any) => n.type === 'task').systemIds).toEqual([sys.id]);

    const bpmn = (await t.run('process.export', { id: p.id, format: 'bpmn' })).content as string;
    expect(bpmn).toContain('<bpmn:userTask');
    expect(bpmn).toContain('Do &lt;work&gt; &amp; &quot;things&quot;');
    expect(bpmn).toMatch(/<bpmn:lane id="Lane_\d" name="Team A">/);
    expect((await t.run('process.export', { id: p.id, format: 'mermaid' })).content).toContain('flowchart LR');
    expect((await t.run('process.export', { id: p.id, format: 'markdown' })).content).toContain('**Systems:** Ticketing');
  });

  it('archives and restores', async () => {
    const p = await t.run('process.create', { name: 'Retire me' });
    await t.run('process.archive', { id: p.id });
    await expectError(t.run('process.update', { id: p.id, name: 'x' }), 'validation_error');
    const list = await t.run('process.list', { q: 'Retire me' });
    expect(list.total).toBe(0);
    await t.run('process.restore', { id: p.id });
    expect((await t.run('process.list', { q: 'Retire me' })).total).toBe(1);
  });
});

describe('insights', () => {
  it('derives team handoffs, walking through unassigned gateways', async () => {
    const graph = await t.run('analytics.teamInteractions', {});
    const ab = graph.links.find((l: any) => l.source === teams.a && l.target === teams.b);
    expect(ab.count).toBeGreaterThan(0);
    expect(ab.processes[0].handoffs[0]).toEqual({ from: 'Prepare request', to: expect.any(String) });
    const teamA = graph.teams.find((x: any) => x.id === teams.a);
    expect(teamA.outgoingHandoffs).toBeGreaterThan(0);
  });

  it('searches across entity types with ranking and wildcard-safe input', async () => {
    const res = await t.run('search.query', { q: 'access request' });
    expect(res.items[0]).toMatchObject({ type: 'process', title: 'Access request' });
    const step = await t.run('search.query', { q: 'prepare', types: 'step' });
    expect(step.items.every((h: any) => h.type === 'step')).toBe(true);
    expect((await t.run('search.query', { q: '%_%' })).items).toEqual([]);
  });

  it('builds the risk & control matrix with gaps', async () => {
    const control = await t.run('control.create', { name: 'Manager approval' });
    const risk = await t.run('risk.create', { title: 'Unapproved access', likelihood: 4, impact: 5, controlIds: [control.id] });
    expect(risk.rating).toBe('critical');
    const orphan = await t.run('risk.create', { title: 'Orphan risk' });
    await t.run('process.create', { name: 'Risky', nodes: [{ id: 'x', label: 'Grant', riskIds: [risk.id] }] });
    const rcm = await t.run('analytics.riskControlMatrix', {});
    expect(rcm.gaps.risksWithoutControls.map((r: any) => r.id)).toContain(orphan.id);
    expect(rcm.gaps.uncontrolledOccurrences.map((r: any) => r.riskId)).toContain(risk.id);
    const r = await t.run('risk.get', { id: risk.ref });
    expect(r.usedIn[0].name).toBe('Risky');
  });

  it('records every change in the audit log with its channel', async () => {
    const editor = await t.user('editor');
    await t.run('tag.create', { name: 'audited' }, editor.actor, 'mcp');
    const audit = await t.run('audit.list', { operation: 'tag.*', actorId: editor.id });
    expect(audit.items[0]).toMatchObject({ operation: 'tag.create', channel: 'mcp', outcome: 'success' });
  });
});

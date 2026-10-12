import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './helpers.js';
import { AppError } from '../src/core/errors.js';

let t: TestContext;
let team: { id: string };
let other: { id: string };

beforeAll(async () => {
  t = await createTestApp();
  team = await t.run('team.create', { name: 'Finance Ops' });
  other = await t.run('team.create', { name: 'Treasury Desk' });
});
afterAll(async () => t.close());

const err = (p: Promise<unknown>) => p.then(() => null, (e) => e as AppError);

describe('AI agent register and delegation', () => {
  it('registers agents and links their systems and service account', async () => {
    const sys = await t.run('system.create', { name: 'ERP' });
    const svc = await t.user('editor', { kind: 'service' });
    const agent = await t.run('agent.create', {
      name: 'Reconciliation Agent',
      provider: 'Anthropic',
      ownerTeamId: team.id,
      status: 'production',
      riskTier: 'limited',
      systemIds: [sys.id],
      serviceAccountId: svc.id,
    });
    expect(agent).toMatchObject({ name: 'Reconciliation Agent', status: 'production', ownerTeam: { id: team.id }, systems: [{ name: 'ERP' }] });
    expect(agent.serviceAccount.id).toBe(svc.id);
    // Only service accounts can be linked.
    const human = await t.user('viewer');
    expect((await err(t.run('agent.update', { id: agent.id, serviceAccountId: human.id })))?.code).toBe('validation_error');
  });

  it('records step and whole-process delegation, and surfaces it in reads, search and exports', async () => {
    const agent = await t.run('agent.get', { id: 'Reconciliation Agent' });
    const p = await t.run('process.create', {
      name: 'Bank reconciliation',
      ownerTeamId: team.id,
      agentId: agent.id,
      automationLevel: 'supervised',
      oversight: 'Controller signs off the reconciliation pack',
      nodes: [
        { id: 's', type: 'start', label: 'Statement received' },
        { id: 'm', type: 'task', label: 'Match transactions', teamId: team.id, agentId: agent.id, automationLevel: 'autonomous', oversight: 'Unmatched items to analyst queue' },
        { id: 'r', type: 'task', label: 'Review exceptions', teamId: other.id },
        { id: 'e', type: 'end', label: 'Reconciled' },
      ],
      edges: [
        { source: 's', target: 'm' },
        { source: 'm', target: 'r' },
        { source: 'r', target: 'e' },
      ],
    });
    expect(p).toMatchObject({ agent: { id: agent.id }, automationLevel: 'supervised' });
    const step = p.nodes.find((n: any) => n.label === 'Match transactions');
    expect(step).toMatchObject({ agentId: agent.id, automationLevel: 'autonomous', oversight: 'Unmatched items to analyst queue' });

    const detail = await t.run('agent.get', { id: agent.id });
    expect(detail.delegatedSteps.map((s: any) => s.step)).toEqual(['Match transactions']);
    expect(detail.delegatedProcesses.map((x: any) => x.name)).toEqual(['Bank reconciliation']);
    expect(detail.delegations).toEqual({ assisted: 0, supervised: 0, autonomous: 1 });

    const md = (await t.run('process.export', { id: p.id, format: 'markdown' })).content;
    expect(md).toContain('**AI delegation:** Reconciliation Agent — performed autonomously by AI');
    const bpmn = (await t.run('process.export', { id: p.id, format: 'bpmn' })).content;
    expect(bpmn).toMatch(/<bpmn:serviceTask [^>]*name="Match transactions"/);

    const hits = await t.run('search.query', { q: 'reconciliation', types: 'agent' });
    expect(hits.items[0]).toMatchObject({ type: 'agent', title: 'Reconciliation Agent' });

    // Agents appear as participants in the interaction map when requested.
    const plain = await t.run('analytics.teamInteractions', {});
    expect(plain.agents).toEqual([]);
    const withAgents = await t.run('analytics.teamInteractions', { includeAgents: true });
    expect(withAgents.agents.map((a: any) => a.name)).toContain('Reconciliation Agent');
    expect(withAgents.links.some((l: any) => l.source === `agent:${agent.id}` && l.target === other.id)).toBe(true);

    // Round-trips through JSON export / import.
    const doc = JSON.parse((await t.run('process.export', { id: p.id, format: 'json' })).content);
    const copy = await t.run('process.import', { document: { ...doc, process: { ...doc.process, name: 'Bank reconciliation (copy)' } } });
    expect(copy.agent.id).toBe(agent.id);
    expect(copy.nodes.find((n: any) => n.label === 'Match transactions').automationLevel).toBe('autonomous');
  });

  it('blocks submission when AI-performed work lacks an agent or human oversight (configurable)', async () => {
    const p = await t.run('process.create', {
      name: 'Unsupervised bot',
      nodes: [{ id: 'a', label: 'Auto-approve refunds', automationLevel: 'autonomous' }],
    });
    const e = await err(t.run('process.submitForReview', { id: p.id }));
    expect(e?.code).toBe('validation_error');
    expect(e?.message).toMatch(/no AI agent is assigned/);
    expect(e?.message).toMatch(/no human oversight/);

    await t.run('settings.update', { requireAiOversight: false });
    try {
      await t.run('process.submitForReview', { id: p.id });
    } finally {
      await t.run('settings.update', { requireAiOversight: true });
    }
  });

  it('refuses to delegate to retired agents', async () => {
    const retired = await t.run('agent.create', { name: 'Old Bot', status: 'retired' });
    const e = await err(t.run('process.create', { name: 'X', nodes: [{ id: 'a', label: 'Do it', agentId: retired.id, automationLevel: 'assisted' }] }));
    expect(e?.message).toMatch(/Retired agents/);
  });

  it('reports the AI register with governance gaps', async () => {
    const risk = await t.run('risk.create', { title: 'Wrong refund', likelihood: 4, impact: 4 });
    const bot = await t.run('agent.create', { name: 'Refund Bot', status: 'proposed' });
    await t.run('process.create', {
      name: 'Refunds',
      nodes: [{ id: 'a', label: 'Issue refund', agentId: bot.id, automationLevel: 'autonomous', oversight: 'Weekly sample', riskIds: [risk.id] }],
    });
    const reg = await t.run('analytics.aiDelegation', {});
    expect(reg.totals.delegatedSteps).toBeGreaterThanOrEqual(3);
    expect(reg.stepsByAutomationLevel.autonomous).toBeGreaterThanOrEqual(2);
    expect(reg.gaps.autonomousHighRiskUncontrolled.map((g: any) => g.step)).toContain('Issue refund');
    expect(reg.gaps.agentIssues.find((a: any) => a.name === 'Refund Bot').issues).toEqual(expect.arrayContaining(['in use but status is proposed', 'no accountable owner team']));
    expect(reg.gaps.incompleteDelegations.some((g: string) => g.includes('Auto-approve refunds'))).toBe(true);
    const overview = await t.run('analytics.overview', {});
    expect(overview.stepsByAutomationLevel.autonomous).toBeGreaterThanOrEqual(2);
  });
});

describe('partial updates keep fields that were not sent', () => {
  it('process.update', async () => {
    const p = await t.run('process.create', { name: 'Keep me', summary: 'Important summary', description: 'Long text', automationLevel: 'assisted' });
    const u = await t.run('process.update', { id: p.id, name: 'Renamed' });
    expect(u).toMatchObject({ name: 'Renamed', summary: 'Important summary', description: 'Long text', automationLevel: 'assisted' });
  });

  it('settings.update', async () => {
    await t.run('settings.update', { organizationName: 'Globex' });
    await t.run('settings.update', { enforceTeamOwnership: false });
    expect((await t.run('settings.get', {})).organizationName).toBe('Globex');
  });

  it('agent.update', async () => {
    const a = await t.run('agent.create', { name: 'Partial Bot', description: 'Keeps this', riskTier: 'high' });
    const u = await t.run('agent.update', { id: a.id, status: 'pilot' });
    expect(u).toMatchObject({ status: 'pilot', description: 'Keeps this', riskTier: 'high' });
  });
});

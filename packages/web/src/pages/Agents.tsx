import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Confirm, Empty, ErrorBox, Loading, PageHeader, StatusBadge, TeamChip, fmtDate, RatingBadge } from '../components/ui';
import { EntityForm, type FieldDef } from '../components/EntityForm';
import { AgentStatusBadge, AiBadge, LEVELS, RiskTierBadge } from '../components/ai';
import { IconDownload, IconExternal, IconPlus } from '../components/icons';
import { useAction, useOp } from '../hooks';
import { useAuth } from '../auth';
import { useCatalog } from '../catalog';
import { downloadCsv } from '../api';
import type { Agent } from '../types';

interface Register {
  totals: {
    workSteps: number;
    delegatedSteps: number;
    agentExecutedSteps: number;
    delegatedProcesses: number;
    processesWithDelegation: number;
    agents: number;
    agentsInProduction: number;
  };
  stepsByAutomationLevel: Record<string, number>;
  delegations: Array<{
    scope: 'process' | 'step';
    processId: string;
    process: string;
    stepId: string | null;
    step: string | null;
    agent: string | null;
    agentId: string | null;
    automationLevel: string;
    oversight: string | null;
  }>;
  gaps: {
    incompleteDelegations: string[];
    autonomousHighRiskUncontrolled: Array<{ processId: string; process: string; step: string; riskId: string; risk: string; rating: string }>;
    agentIssues: Array<{ id: string; name: string; issues: string[] }>;
  };
}

const opts = (xs: string[]) => xs.map((v) => ({ value: v, label: v }));

function useAgentFields(): FieldDef[] {
  const c = useCatalog();
  const serviceAccounts = c.users.filter((u) => u.kind === 'service').map((u) => ({ value: u.id, label: u.name, hint: u.email }));
  return [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'description', label: 'What it does', type: 'textarea', hint: 'Purpose, scope and boundaries of the agent' },
    { key: 'status', label: 'Lifecycle status', type: 'select', allowEmpty: false, options: opts(['proposed', 'pilot', 'production', 'suspended', 'retired']) },
    { key: 'riskTier', label: 'Risk tier', type: 'select', allowEmpty: false, options: opts(['minimal', 'limited', 'high']), hint: 'Per your AI policy (e.g. EU AI Act categories)' },
    { key: 'ownerTeamId', label: 'Accountable team', type: 'select', options: c.teamOptions },
    { key: 'provider', label: 'Provider / vendor', type: 'text', hint: 'e.g. Anthropic, in-house' },
    { key: 'model', label: 'Model', type: 'text' },
    { key: 'platform', label: 'Runs on', type: 'text', hint: 'e.g. Claude Agent SDK, Copilot Studio, UiPath, custom service' },
    { key: 'systemIds', label: 'Systems / tools it can access', type: 'multi', options: c.systemOptions },
    { key: 'dataAccess', label: 'Data access', type: 'textarea', hint: 'What data it can read or change, and its classification' },
    { key: 'serviceAccountId', label: 'Streamline service account', type: 'select', options: serviceAccounts, hint: 'Links the agent to its API / MCP identity so its actions here are attributable' },
    { key: 'documentationUrl', label: 'Documentation / model card', type: 'url' },
    { key: 'nextReviewAt', label: 'Next governance review', type: 'date' },
  ];
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

export function AgentsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useAgentFields();
  const agents = useOp<Agent[]>('agent.list', {});
  const register = useOp<Register>('analytics.aiDelegation', {});
  const [creating, setCreating] = useState(false);
  if (agents.isLoading || register.isLoading) return <Loading />;
  if (agents.error || register.error) return <Content><ErrorBox error={agents.error ?? register.error} /></Content>;
  const r = register.data!;
  const pct = r.totals.workSteps ? Math.round((r.totals.delegatedSteps / r.totals.workSteps) * 100) : 0;
  const levelColors: Record<string, string> = { manual: '#94a3b8', assisted: 'var(--primary)', supervised: 'var(--purple)', autonomous: 'var(--warning)' };
  const levelTotal = Object.values(r.stepsByAutomationLevel).reduce((a, b) => a + b, 0) || 1;

  return (
    <Content>
      <PageHeader
        title="AI agents"
        subtitle="Register of AI agents and every place work has been delegated to them, with the level of autonomy and the human oversight around it."
        actions={
          <>
            <button
              className="btn"
              disabled={!r.delegations.length}
              onClick={() =>
                downloadCsv(
                  'ai-delegation-register.csv',
                  r.delegations.map((d) => ({ process: d.process, step: d.step ?? '(whole process)', agent: d.agent, automationLevel: d.automationLevel, oversight: d.oversight })),
                )
              }
            >
              <IconDownload /> Register CSV
            </button>
            {can('catalog:write') && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <IconPlus /> Register agent
              </button>
            )}
          </>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Tile label="Agents in production" value={`${r.totals.agentsInProduction} / ${r.totals.agents}`} />
        <Tile label="Steps delegated to AI" value={`${pct}%`} sub={`${r.totals.delegatedSteps} of ${r.totals.workSteps} work steps`} />
        <Tile label="Steps performed by AI" value={r.totals.agentExecutedSteps} sub="supervised or autonomous" />
        <Tile label="Processes using AI" value={r.totals.processesWithDelegation} sub={r.totals.delegatedProcesses ? `${r.totals.delegatedProcesses} delegated end to end` : undefined} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h2>Work steps by automation level</h2>
        </div>
        <div className="card-body stack" style={{ gap: 10 }}>
          <div className="bar" style={{ height: 12 }}>
            {LEVELS.map((l) => (r.stepsByAutomationLevel[l.value] ? <span key={l.value} style={{ width: `${(r.stepsByAutomationLevel[l.value] / levelTotal) * 100}%`, background: levelColors[l.value] }} title={`${l.label}: ${r.stepsByAutomationLevel[l.value]}`} /> : null))}
          </div>
          <div className="row wrap" style={{ gap: 16 }}>
            {LEVELS.map((l) => (
              <span key={l.value} className="row small" style={{ gap: 6 }} title={l.help}>
                <span className="dot" style={{ background: levelColors[l.value] }} />
                {l.label} <strong>{r.stepsByAutomationLevel[l.value] ?? 0}</strong>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <GapCard title="Incomplete delegations" count={r.gaps.incompleteDelegations.length} hint="Delegated work without a named agent or human oversight">
          {r.gaps.incompleteDelegations.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </GapCard>
        <GapCard title="Autonomous steps with uncontrolled high risks" count={r.gaps.autonomousHighRiskUncontrolled.length} hint="High/critical risks on steps run autonomously by AI, with none of their controls performed in the step">
          {r.gaps.autonomousHighRiskUncontrolled.map((g) => (
            <li key={g.processId + g.step + g.riskId}>
              <Link to={`/processes/${g.processId}`}>{g.step}</Link> · {g.risk} <RatingBadge rating={g.rating} />
            </li>
          ))}
        </GapCard>
        <GapCard title="Agent governance issues" count={r.gaps.agentIssues.length} hint="Agents in use outside pilot/production, without an owner, overdue review…">
          {r.gaps.agentIssues.map((a) => (
            <li key={a.id}>
              <Link to={`/agents/${a.id}`}>{a.name}</Link>: {a.issues.join('; ')}
            </li>
          ))}
        </GapCard>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h2>Agent register</h2>
        </div>
        {!agents.data?.length ? (
          <Empty title="No AI agents registered">Register the agents your business uses, then delegate process steps to them from the diagram editor.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Accountable team</th>
                  <th>Delegated steps</th>
                  <th>Processes</th>
                  <th>Next review</th>
                </tr>
              </thead>
              <tbody>
                {agents.data.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => navigate(`/agents/${a.id}`)}>
                    <td>
                      <strong>🤖 {a.name}</strong>
                      <div className="muted small">{[a.provider, a.model, a.platform].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>
                      <AgentStatusBadge status={a.status} />
                    </td>
                    <td>
                      <RiskTierBadge tier={a.riskTier} />
                    </td>
                    <td>
                      <TeamChip team={a.ownerTeam} />
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {(['assisted', 'supervised', 'autonomous'] as const).map((l) => (a.delegations[l] ? <AiBadge key={l} level={l} agent={String(a.delegations[l])} /> : null))}
                        {!a.stepCount && <span className="muted">—</span>}
                      </div>
                    </td>
                    <td>{a.processCount}</td>
                    <td className="small">{fmtDate(a.nextReviewAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Where work is delegated</h2>
          <span className="muted small">{r.delegations.length} delegations</span>
        </div>
        {!r.delegations.length ? (
          <Empty title="Nothing is delegated to AI yet">Open a process, select a step and use the AI delegation section of the inspector.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Step</th>
                  <th>Agent</th>
                  <th>Level</th>
                  <th>Human oversight</th>
                </tr>
              </thead>
              <tbody>
                {r.delegations.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <Link to={`/processes/${d.processId}`}>{d.process}</Link>
                    </td>
                    <td>{d.step ?? <em>Whole process</em>}</td>
                    <td>{d.agentId ? <Link to={`/agents/${d.agentId}`}>{d.agent}</Link> : <span className="badge red">none</span>}</td>
                    <td>
                      <AiBadge level={d.automationLevel} compact />
                    </td>
                    <td className="small">{d.oversight || (d.automationLevel === 'assisted' ? <span className="muted">—</span> : <span className="badge red">missing</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <EntityForm
          title="Register AI agent"
          op="agent.create"
          fields={fields}
          initial={{ status: 'proposed', riskTier: 'limited', systemIds: [] }}
          onClose={() => setCreating(false)}
          onDone={(a) => navigate(`/agents/${a.id}`)}
        />
      )}
    </Content>
  );
}

function GapCard({ title, count, hint, children }: { title: string; count: number; hint: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-header">
        <h3 title={hint}>{title}</h3>
        <span className={`badge ${count ? 'red' : 'green'}`}>{count}</span>
      </div>
      <ul className="list-plain small" style={{ padding: '0 16px', maxHeight: 220, overflow: 'auto' }}>
        {children}
        {!count && <li className="muted">None 🎉</li>}
      </ul>
    </div>
  );
}

interface AgentDetail extends Agent {
  delegatedSteps: Array<{ processId: string; processRef: string; processName: string; processStatus: string; stepId: string; step: string; automationLevel: string; oversight: string | null; accountableTeam: string | null }>;
  delegatedProcesses: Array<{ id: string; ref: string; name: string; status: string; automationLevel: string; oversight: string | null }>;
}

export function AgentPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useAgentFields();
  const { data: a, isLoading, error } = useOp<AgentDetail>('agent.get', { id });
  const [editing, setEditing] = useState(false);
  const del = useAction('agent.delete', { toast: 'Agent removed', onSuccess: () => navigate('/agents') });
  const setStatus = useAction('agent.update', { toast: 'Status updated' });
  if (isLoading) return <Loading />;
  if (error || !a) return <Content><ErrorBox error={error ?? 'Not found'} /></Content>;
  return (
    <Content>
      <PageHeader
        title={
          <span className="row wrap">
            🤖 {a.name} <AgentStatusBadge status={a.status} /> <RiskTierBadge tier={a.riskTier} />
          </span>
        }
        subtitle={[a.provider, a.model, a.platform].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            {a.documentationUrl && (
              <a className="btn" href={a.documentationUrl} target="_blank" rel="noreferrer noopener">
                <IconExternal /> Docs
              </a>
            )}
            {can('catalog:write') && (
              <>
                {a.status !== 'suspended' && a.status !== 'retired' && (
                  <Confirm className="btn" label="Suspend" message={`Suspend ${a.name}? It stays on its steps but is flagged everywhere it is used.`} onConfirm={() => setStatus.mutate({ id: a.id, status: 'suspended' })} />
                )}
                <button className="btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <Confirm className="btn danger" label="Delete" message={`Remove ${a.name} from the register? Steps delegated to it will lose their agent. Consider setting status to retired instead.`} onConfirm={() => del.mutate({ id: a.id })} />
              </>
            )}
          </>
        }
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card-body">
            <dl className="kv small">
              <dt>Purpose</dt>
              <dd className="pre-wrap">{a.description || '—'}</dd>
              <dt>Accountable team</dt>
              <dd>
                <TeamChip team={a.ownerTeam} />
              </dd>
              <dt>Data access</dt>
              <dd className="pre-wrap">{a.dataAccess || '—'}</dd>
              <dt>Systems / tools</dt>
              <dd>{a.systems.length ? a.systems.map((s) => <Link key={s.id} to={`/systems/${s.id}`} className="tag" style={{ color: 'inherit', marginRight: 4 }}>{s.name}</Link>) : '—'}</dd>
              <dt>Service account</dt>
              <dd>{a.serviceAccount ? `${a.serviceAccount.name} (${a.serviceAccount.email})` : '—'}</dd>
              <dt>Next review</dt>
              <dd>{fmtDate(a.nextReviewAt)}</dd>
            </dl>
          </div>
        </div>
        <div className="stack">
          {a.delegatedProcesses.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>Processes delegated end to end</h2>
              </div>
              <ul className="list-plain" style={{ padding: '0 16px' }}>
                {a.delegatedProcesses.map((p) => (
                  <li key={p.id}>
                    <div className="row">
                      <span className="muted small">{p.ref}</span>
                      <Link to={`/processes/${p.id}`}>{p.name}</Link>
                      <StatusBadge status={p.status} />
                      <AiBadge level={p.automationLevel} compact />
                    </div>
                    {p.oversight && <div className="muted small">Oversight: {p.oversight}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <div className="card-header">
              <h2>Delegated steps</h2>
              <span className="muted small">{a.delegatedSteps.length}</span>
            </div>
            {!a.delegatedSteps.length ? (
              <Empty title="No steps delegated to this agent yet" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Level</th>
                      <th>Accountable team</th>
                      <th>Human oversight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.delegatedSteps.map((s) => (
                      <tr key={s.stepId}>
                        <td>
                          <strong>{s.step}</strong>
                          <div className="small">
                            <Link to={`/processes/${s.processId}`}>
                              {s.processRef} {s.processName}
                            </Link>{' '}
                            <StatusBadge status={s.processStatus} />
                          </div>
                        </td>
                        <td>
                          <AiBadge level={s.automationLevel} compact />
                        </td>
                        <td className="small">{s.accountableTeam ?? '—'}</td>
                        <td className="small">{s.oversight || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {editing && (
        <EntityForm
          title="Edit AI agent"
          op="agent.update"
          fields={fields}
          extra={{ id: a.id }}
          initial={{
            name: a.name,
            description: a.description,
            status: a.status,
            riskTier: a.riskTier,
            ownerTeamId: a.ownerTeam?.id ?? '',
            provider: a.provider,
            model: a.model,
            platform: a.platform,
            systemIds: a.systemIds,
            dataAccess: a.dataAccess,
            serviceAccountId: a.serviceAccount?.id ?? '',
            documentationUrl: a.documentationUrl,
            nextReviewAt: a.nextReviewAt?.slice(0, 10) ?? '',
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </Content>
  );
}

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Confirm, EffectivenessBadge, Empty, ErrorBox, Loading, PageHeader, RatingBadge, TeamChip } from '../components/ui';
import { EntityForm, type FieldDef } from '../components/EntityForm';
import { UsedIn } from '../components/UsedIn';
import { IconDownload, IconPlus } from '../components/icons';
import { useAction, useDebounced, useOp } from '../hooks';
import { useAuth } from '../auth';
import { useCatalog } from '../catalog';
import { downloadCsv } from '../api';
import type { Control, Risk, UsedIn as UsedInT } from '../types';

const scale = (labels: string[]) => labels.map((l, i) => ({ value: String(i + 1), label: `${i + 1} – ${l}` }));
const LIKELIHOOD = scale(['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain']);
const IMPACT = scale(['Negligible', 'Minor', 'Moderate', 'Major', 'Severe']);
const opts = (xs: string[]) => xs.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

function useRiskFields(): FieldDef[] {
  const c = useCatalog();
  return [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'category', label: 'Category', type: 'text', hint: 'Fraud, Financial reporting, Privacy, Operational…' },
    { key: 'likelihood', label: 'Likelihood', type: 'select', allowEmpty: false, numeric: true, options: LIKELIHOOD },
    { key: 'impact', label: 'Impact', type: 'select', allowEmpty: false, numeric: true, options: IMPACT },
    { key: 'status', label: 'Status', type: 'select', allowEmpty: false, options: opts(['open', 'mitigated', 'accepted', 'closed']) },
    { key: 'ownerTeamId', label: 'Risk owner (team)', type: 'select', options: c.teamOptions },
    { key: 'controlIds', label: 'Mitigating controls', type: 'multi', options: c.controlOptions },
    { key: 'description', label: 'Description', type: 'textarea' },
  ];
}

function useControlFields(): FieldDef[] {
  const c = useCatalog();
  return [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'controlType', label: 'Type', type: 'select', allowEmpty: false, options: opts(['preventive', 'detective', 'corrective']) },
    { key: 'nature', label: 'Nature', type: 'select', allowEmpty: false, options: opts(['manual', 'automated', 'it_dependent']) },
    { key: 'frequency', label: 'Frequency', type: 'text', hint: 'Per transaction, Daily, Monthly…' },
    { key: 'effectiveness', label: 'Effectiveness (last test)', type: 'select', allowEmpty: false, options: opts(['not_tested', 'effective', 'partially_effective', 'ineffective']) },
    { key: 'ownerTeamId', label: 'Control owner (team)', type: 'select', options: c.teamOptions },
    { key: 'riskIds', label: 'Risks mitigated', type: 'multi', options: c.riskOptions },
    { key: 'description', label: 'Description / test procedure', type: 'textarea' },
  ];
}

/** Likelihood × impact heat map with counts. */
function HeatMap({ risks }: { risks: Risk[] }) {
  const color = (score: number) => (score >= 20 ? '#dc2626' : score >= 12 ? '#ea580c' : score >= 6 ? '#d97706' : '#16a34a');
  return (
    <div className="card">
      <div className="card-header">
        <h2>Heat map</h2>
        <span className="muted small">likelihood × impact</span>
      </div>
      <div className="card-body">
        <div className="heat">
          {[5, 4, 3, 2, 1].map((l) => (
            <div key={l} style={{ display: 'contents' }}>
              <div className="muted">{l}</div>
              {[1, 2, 3, 4, 5].map((i) => {
                const n = risks.filter((r) => r.likelihood === l && r.impact === i).length;
                return (
                  <div key={i} style={{ background: `color-mix(in srgb, ${color(l * i)} ${n ? 70 : 15}%, transparent)`, color: n ? '#fff' : 'transparent' }} title={`Likelihood ${l}, impact ${i}: ${n}`}>
                    {n || '.'}
                  </div>
                );
              })}
            </div>
          ))}
          <div />
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="muted" style={{ minHeight: 0 }}>
              {i}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RisksPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useRiskFields();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isLoading, error } = useOp<Risk[]>('risk.list', { q: dq || undefined });
  const [creating, setCreating] = useState(false);
  return (
    <Content>
      <PageHeader
        title="Risks"
        subtitle="Risk register linked to the process steps where each risk arises."
        actions={
          <>
            <button className="btn" disabled={!data?.length} onClick={() => downloadCsv('risks.csv', data!.map((r) => ({ ref: r.ref, title: r.title, category: r.category, likelihood: r.likelihood, impact: r.impact, score: r.score, rating: r.rating, status: r.status, owner: r.ownerTeam?.name, controls: r.controls.map((c) => c.ref), processes: r.processCount })))}>
              <IconDownload /> CSV
            </button>
            {can('catalog:write') && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <IconPlus /> New risk
              </button>
            )}
          </>
        }
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(240px, 1fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card-header">
            <input style={{ maxWidth: 320 }} placeholder="Filter risks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
          </div>
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorBox error={error} />
          ) : !data?.length ? (
            <Empty title="No risks registered" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ref</th>
                    <th>Risk</th>
                    <th>Rating</th>
                    <th>Status</th>
                    <th>Controls</th>
                    <th>Processes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/risks/${r.id}`)}>
                      <td className="muted nowrap">{r.ref}</td>
                      <td>
                        <strong>{r.title}</strong>
                        {r.category && <div className="muted small">{r.category}</div>}
                      </td>
                      <td>
                        <RatingBadge rating={r.rating} /> <span className="muted small">{r.score}</span>
                      </td>
                      <td>{r.status}</td>
                      <td>{r.controls.length ? r.controls.length : <span className="badge red">none</span>}</td>
                      <td>{r.processCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <HeatMap risks={data ?? []} />
      </div>
      {creating && <EntityForm title="New risk" op="risk.create" fields={fields} initial={{ likelihood: '3', impact: '3', status: 'open', controlIds: [] }} onClose={() => setCreating(false)} />}
    </Content>
  );
}

export function RiskPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useRiskFields();
  const { data: r, isLoading, error } = useOp<Risk & { usedIn: UsedInT[] }>('risk.get', { id });
  const [editing, setEditing] = useState(false);
  const del = useAction('risk.delete', { toast: 'Risk deleted', onSuccess: () => navigate('/risks') });
  if (isLoading) return <Loading />;
  if (error || !r) return <Content><ErrorBox error={error ?? 'Not found'} /></Content>;
  return (
    <Content>
      <PageHeader
        title={`${r.ref} ${r.title}`}
        subtitle={r.category ?? undefined}
        actions={
          can('catalog:write') && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              <Confirm className="btn danger" label="Delete" message={`Delete ${r.ref}?`} onConfirm={() => del.mutate({ id: r.id })} />
            </>
          )
        }
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)', alignItems: 'start' }}>
        <div className="stack">
          <div className="card">
            <div className="card-body">
              <dl className="kv small">
                <dt>Rating</dt>
                <dd>
                  <RatingBadge rating={r.rating} /> score {r.score} (L{r.likelihood} × I{r.impact})
                </dd>
                <dt>Status</dt>
                <dd>{r.status}</dd>
                <dt>Owner</dt>
                <dd>
                  <TeamChip team={r.ownerTeam} />
                </dd>
                <dt>Description</dt>
                <dd className="pre-wrap">{r.description || '—'}</dd>
              </dl>
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h2>Mitigating controls</h2>
            </div>
            <ul className="list-plain" style={{ padding: '0 16px' }}>
              {r.controls.map((c) => (
                <li key={c.id} className="row">
                  <Link to={`/controls/${c.id}`}>
                    {c.ref} {c.name}
                  </Link>
                  <span className="spacer" />
                  <EffectivenessBadge value={c.effectiveness} />
                </li>
              ))}
              {!r.controls.length && <li className="alert warning small">No controls mitigate this risk.</li>}
            </ul>
          </div>
        </div>
        <UsedIn items={r.usedIn} what="risk" />
      </div>
      {editing && (
        <EntityForm
          title="Edit risk"
          op="risk.update"
          fields={fields}
          extra={{ id: r.id }}
          initial={{ title: r.title, category: r.category, likelihood: String(r.likelihood), impact: String(r.impact), status: r.status, ownerTeamId: r.ownerTeam?.id ?? '', controlIds: r.controlIds, description: r.description }}
          onClose={() => setEditing(false)}
        />
      )}
    </Content>
  );
}

export function ControlsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useControlFields();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isLoading, error } = useOp<Control[]>('control.list', { q: dq || undefined });
  const [creating, setCreating] = useState(false);
  return (
    <Content>
      <PageHeader
        title="Controls"
        subtitle="Control library: what is done to mitigate each risk, where it is performed, and how well it works."
        actions={
          <>
            <button className="btn" disabled={!data?.length} onClick={() => downloadCsv('controls.csv', data!.map((c) => ({ ref: c.ref, name: c.name, type: c.controlType, nature: c.nature, frequency: c.frequency, effectiveness: c.effectiveness, owner: c.ownerTeam?.name, risks: c.risks.map((r) => r.ref), processes: c.processCount })))}>
              <IconDownload /> CSV
            </button>
            {can('catalog:write') && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <IconPlus /> New control
              </button>
            )}
          </>
        }
      />
      <div className="card">
        <div className="card-header">
          <input style={{ maxWidth: 320 }} placeholder="Filter controls…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        </div>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : !data?.length ? (
          <Empty title="No controls registered" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Control</th>
                  <th>Type</th>
                  <th>Frequency</th>
                  <th>Effectiveness</th>
                  <th>Risks</th>
                  <th>Processes</th>
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/controls/${c.id}`)}>
                    <td className="muted nowrap">{c.ref}</td>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="small">
                        <TeamChip team={c.ownerTeam} />
                      </div>
                    </td>
                    <td className="small">
                      {c.controlType}
                      <div className="muted">{c.nature.replace('_', '-')}</div>
                    </td>
                    <td className="small">{c.frequency ?? '—'}</td>
                    <td>
                      <EffectivenessBadge value={c.effectiveness} />
                    </td>
                    <td>{c.risks.length}</td>
                    <td>{c.processCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <EntityForm title="New control" op="control.create" fields={fields} initial={{ controlType: 'preventive', nature: 'manual', effectiveness: 'not_tested', riskIds: [] }} onClose={() => setCreating(false)} />}
    </Content>
  );
}

export function ControlPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useControlFields();
  const { data: c, isLoading, error } = useOp<Control & { usedIn: UsedInT[] }>('control.get', { id });
  const [editing, setEditing] = useState(false);
  const del = useAction('control.delete', { toast: 'Control deleted', onSuccess: () => navigate('/controls') });
  if (isLoading) return <Loading />;
  if (error || !c) return <Content><ErrorBox error={error ?? 'Not found'} /></Content>;
  return (
    <Content>
      <PageHeader
        title={`${c.ref} ${c.name}`}
        subtitle={`${c.controlType} · ${c.nature.replace('_', '-')}${c.frequency ? ` · ${c.frequency}` : ''}`}
        actions={
          can('catalog:write') && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              <Confirm className="btn danger" label="Delete" message={`Delete ${c.ref}?`} onConfirm={() => del.mutate({ id: c.id })} />
            </>
          )
        }
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)', alignItems: 'start' }}>
        <div className="stack">
          <div className="card">
            <div className="card-body">
              <dl className="kv small">
                <dt>Effectiveness</dt>
                <dd>
                  <EffectivenessBadge value={c.effectiveness} />
                </dd>
                <dt>Owner</dt>
                <dd>
                  <TeamChip team={c.ownerTeam} />
                </dd>
                <dt>Description</dt>
                <dd className="pre-wrap">{c.description || '—'}</dd>
              </dl>
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h2>Risks mitigated</h2>
            </div>
            <ul className="list-plain" style={{ padding: '0 16px' }}>
              {c.risks.map((r) => (
                <li key={r.id}>
                  <Link to={`/risks/${r.id}`}>
                    {r.ref} {r.title}
                  </Link>
                </li>
              ))}
              {!c.risks.length && <li className="muted">Not linked to any risk.</li>}
            </ul>
          </div>
        </div>
        <UsedIn items={c.usedIn} what="control" />
      </div>
      {editing && (
        <EntityForm
          title="Edit control"
          op="control.update"
          fields={fields}
          extra={{ id: c.id }}
          initial={{ name: c.name, controlType: c.controlType, nature: c.nature, frequency: c.frequency, effectiveness: c.effectiveness, ownerTeamId: c.ownerTeam?.id ?? '', riskIds: c.riskIds, description: c.description }}
          onClose={() => setEditing(false)}
        />
      )}
    </Content>
  );
}

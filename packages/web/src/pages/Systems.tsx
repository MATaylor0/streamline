import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Confirm, Empty, ErrorBox, Loading, PageHeader, TeamChip } from '../components/ui';
import { EntityForm, type FieldDef } from '../components/EntityForm';
import { UsedIn } from '../components/UsedIn';
import { IconDownload, IconExternal, IconPlus } from '../components/icons';
import { useAction, useDebounced, useOp } from '../hooks';
import { useAuth } from '../auth';
import { useCatalog } from '../catalog';
import { downloadCsv } from '../api';
import type { System, UsedIn as UsedInT } from '../types';

const CRIT: Record<string, string> = { low: '', medium: 'blue', high: 'amber', critical: 'red' };

function useSystemFields(): FieldDef[] {
  const catalog = useCatalog();
  return [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'vendor', label: 'Vendor', type: 'text' },
    { key: 'category', label: 'Category', type: 'text', hint: 'ERP, CRM, HRIS, Data platform…' },
    {
      key: 'criticality',
      label: 'Criticality',
      type: 'select',
      allowEmpty: false,
      options: ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v })),
    },
    { key: 'ownerTeamId', label: 'Owning team', type: 'select', options: catalog.teamOptions },
    { key: 'url', label: 'URL', type: 'url' },
    { key: 'description', label: 'Description', type: 'textarea' },
  ];
}

export function SystemsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useSystemFields();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isLoading, error } = useOp<System[]>('system.list', { q: dq || undefined });
  const [creating, setCreating] = useState(false);
  return (
    <Content>
      <PageHeader
        title="Business systems"
        subtitle="Applications used to perform process steps — see which processes and teams depend on each."
        actions={
          <>
            <button className="btn" disabled={!data?.length} onClick={() => downloadCsv('systems.csv', data!.map((s) => ({ name: s.name, vendor: s.vendor, category: s.category, criticality: s.criticality, ownerTeam: s.ownerTeam?.name, processes: s.processCount, steps: s.stepCount })))}>
              <IconDownload /> CSV
            </button>
            {can('catalog:write') && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <IconPlus /> New system
              </button>
            )}
          </>
        }
      />
      <div className="card">
        <div className="card-header">
          <input style={{ maxWidth: 320 }} placeholder="Filter systems…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        </div>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : !data?.length ? (
          <Empty title="No systems registered" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>System</th>
                  <th>Category</th>
                  <th>Criticality</th>
                  <th>Owner</th>
                  <th>Processes</th>
                  <th>Steps</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/systems/${s.id}`)}>
                    <td>
                      <strong>{s.name}</strong>
                      {s.vendor && <div className="muted small">{s.vendor}</div>}
                    </td>
                    <td>{s.category ?? '—'}</td>
                    <td>
                      <span className={`badge ${CRIT[s.criticality]}`}>{s.criticality}</span>
                    </td>
                    <td>
                      <TeamChip team={s.ownerTeam} />
                    </td>
                    <td>{s.processCount}</td>
                    <td>{s.stepCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <EntityForm title="New business system" op="system.create" fields={fields} initial={{ criticality: 'medium' }} onClose={() => setCreating(false)} />}
    </Content>
  );
}

export function SystemPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const fields = useSystemFields();
  const { data: s, isLoading, error } = useOp<System & { usedIn: UsedInT[]; description: string }>('system.get', { id });
  const [editing, setEditing] = useState(false);
  const del = useAction('system.delete', { toast: 'System deleted', onSuccess: () => navigate('/systems') });
  if (isLoading) return <Loading />;
  if (error || !s) return <Content><ErrorBox error={error ?? 'Not found'} /></Content>;
  return (
    <Content>
      <PageHeader
        title={s.name}
        subtitle={[s.vendor, s.category].filter(Boolean).join(' · ')}
        actions={
          <>
            {s.url && (
              <a className="btn" href={s.url} target="_blank" rel="noreferrer noopener">
                <IconExternal /> Open
              </a>
            )}
            {can('catalog:write') && (
              <>
                <button className="btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <Confirm className="btn danger" label="Delete" message={`Delete ${s.name}? It will be removed from all steps.`} onConfirm={() => del.mutate({ id: s.id })} />
              </>
            )}
          </>
        }
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card-body">
            <dl className="kv small">
              <dt>Criticality</dt>
              <dd>
                <span className={`badge ${CRIT[s.criticality]}`}>{s.criticality}</span>
              </dd>
              <dt>Owner</dt>
              <dd>
                <TeamChip team={s.ownerTeam} />
              </dd>
              <dt>Description</dt>
              <dd className="pre-wrap">{s.description || '—'}</dd>
            </dl>
          </div>
        </div>
        <UsedIn items={s.usedIn} what="system" />
      </div>
      {editing && (
        <EntityForm
          title="Edit system"
          op="system.update"
          fields={fields}
          extra={{ id: s.id }}
          initial={{ name: s.name, vendor: s.vendor, category: s.category, criticality: s.criticality, ownerTeamId: s.ownerTeam?.id ?? '', url: s.url, description: s.description }}
          onClose={() => setEditing(false)}
        />
      )}
    </Content>
  );
}

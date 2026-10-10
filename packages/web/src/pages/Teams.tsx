import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Confirm, Empty, ErrorBox, Loading, PageHeader, StatusBadge, TeamChip } from '../components/ui';
import { EntityForm, type FieldDef } from '../components/EntityForm';
import { IconPlus } from '../components/icons';
import { useAction, useOp } from '../hooks';
import { useAuth } from '../auth';
import { useCatalog } from '../catalog';
import type { Team } from '../types';

const teamFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'department', label: 'Department / function', type: 'text', hint: 'Used to group teams on the interaction map' },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'color', label: 'Colour', type: 'color' },
];

export function TeamsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error } = useOp<Team[]>('team.list', {});
  const [creating, setCreating] = useState(false);
  const depts = [...new Set((data ?? []).map((t) => t.department ?? 'Other'))].sort();
  return (
    <Content>
      <PageHeader
        title="Teams"
        subtitle="Teams own processes and perform steps. Their handoffs power the team interaction map."
        actions={
          can('catalog:write') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <IconPlus /> New team
            </button>
          )
        }
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data?.length ? (
        <Empty title="No teams yet" />
      ) : (
        <div className="stack">
          {depts.map((d) => (
            <div key={d} className="card">
              <div className="card-header">
                <h2>{d}</h2>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Members</th>
                    <th>Processes owned</th>
                    <th>Processes involved</th>
                    <th>Steps performed</th>
                  </tr>
                </thead>
                <tbody>
                  {data
                    .filter((t) => (t.department ?? 'Other') === d)
                    .map((t) => (
                      <tr key={t.id} className="clickable" onClick={() => navigate(`/teams/${t.id}`)}>
                        <td>
                          <TeamChip team={t} />
                          {t.description && <div className="muted small">{t.description}</div>}
                        </td>
                        <td>{t.memberCount}</td>
                        <td>{t.ownedProcessCount}</td>
                        <td>{t.involvedProcessCount}</td>
                        <td>{t.stepCount}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      {creating && <EntityForm title="New team" op="team.create" fields={teamFields} initial={{ color: '#2563eb' }} onClose={() => setCreating(false)} onDone={(t) => navigate(`/teams/${t.id}`)} />}
    </Content>
  );
}

interface TeamDetail extends Team {
  members: Array<{ id: string; name: string; email: string; role: string }>;
  ownedProcesses: Array<{ id: string; ref: string; name: string; status: string }>;
  involvedProcesses: Array<{ id: string; ref: string; name: string; status: string; steps: number }>;
  systemsUsed: Array<{ id: string; name: string }>;
}

export function TeamPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const { data: t, isLoading, error } = useOp<TeamDetail>('team.get', { id });
  const [editing, setEditing] = useState(false);
  const [member, setMember] = useState('');
  const del = useAction('team.delete', { toast: 'Team deleted', onSuccess: () => navigate('/teams') });
  const add = useAction('team.addMember', { toast: 'Member added', onSuccess: () => setMember('') });
  const remove = useAction('team.removeMember', { toast: 'Member removed' });
  const setRole = useAction('team.addMember', { toast: 'Updated' });
  if (isLoading) return <Loading />;
  if (error || !t) return <Content><ErrorBox error={error ?? 'Not found'} /></Content>;
  return (
    <Content>
      <PageHeader
        title={<TeamChip team={t} />}
        subtitle={[t.department, t.description].filter(Boolean).join(' · ')}
        actions={
          can('catalog:write') && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
              <Confirm className="btn danger" label="Delete" message={`Delete ${t.name}? Steps assigned to it become unassigned.`} onConfirm={() => del.mutate({ id: t.id })} />
            </>
          )
        }
      />
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>Processes involved in</h2>
            <Link className="small" to={`/team-map`}>
              Team map →
            </Link>
          </div>
          <ul className="list-plain" style={{ padding: '0 16px' }}>
            {t.involvedProcesses.map((p) => (
              <li key={p.id} className="row">
                <span className="muted small">{p.ref}</span>
                <Link to={`/processes/${p.id}`}>{p.name}</Link>
                <span className="spacer" />
                <span className="muted small">{p.steps} steps</span>
                <StatusBadge status={p.status} />
              </li>
            ))}
            {!t.involvedProcesses.length && <li className="muted">Not assigned to any steps yet.</li>}
          </ul>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Processes owned</h2>
          </div>
          <ul className="list-plain" style={{ padding: '0 16px' }}>
            {t.ownedProcesses.map((p) => (
              <li key={p.id} className="row">
                <span className="muted small">{p.ref}</span>
                <Link to={`/processes/${p.id}`}>{p.name}</Link>
                <span className="spacer" />
                <StatusBadge status={p.status} />
              </li>
            ))}
            {!t.ownedProcesses.length && <li className="muted">None.</li>}
          </ul>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Members</h2>
          </div>
          <ul className="list-plain" style={{ padding: '0 16px' }}>
            {t.members.map((m) => (
              <li key={m.id} className="row">
                <div style={{ flex: 1 }}>
                  <div>{m.name}</div>
                  <div className="muted small">{m.email}</div>
                </div>
                {can('catalog:write') ? (
                  <>
                    <select style={{ width: 'auto' }} value={m.role} onChange={(e) => setRole.mutate({ teamId: t.id, userId: m.id, role: e.target.value })} aria-label="Team role">
                      <option value="member">Member</option>
                      <option value="lead">Lead</option>
                    </select>
                    <button className="btn ghost sm" onClick={() => remove.mutate({ teamId: t.id, userId: m.id })}>
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="badge">{m.role}</span>
                )}
              </li>
            ))}
            {!t.members.length && <li className="muted">No members.</li>}
          </ul>
          {can('catalog:write') && (
            <div className="card-body row" style={{ borderTop: '1px solid var(--border)' }}>
              <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Add member">
                <option value="">Add a member…</option>
                {catalog.userOptions
                  .filter((u) => !t.members.some((m) => m.id === u.value))
                  .map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label} ({u.hint})
                    </option>
                  ))}
              </select>
              <button className="btn" disabled={!member} onClick={() => add.mutate({ teamId: t.id, userId: member })}>
                Add
              </button>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Business systems used</h2>
          </div>
          <div className="card-body row wrap">
            {t.systemsUsed.map((s) => (
              <Link key={s.id} to={`/systems/${s.id}`} className="tag" style={{ color: 'inherit' }}>
                {s.name}
              </Link>
            ))}
            {!t.systemsUsed.length && <span className="muted">None recorded.</span>}
          </div>
        </div>
      </div>
      {editing && (
        <EntityForm
          title="Edit team"
          op="team.update"
          fields={teamFields}
          extra={{ id: t.id }}
          initial={{ name: t.name, department: t.department, description: t.description, color: t.color }}
          onClose={() => setEditing(false)}
        />
      )}
    </Content>
  );
}

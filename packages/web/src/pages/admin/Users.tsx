import { useState } from 'react';
import { Content } from '../../components/Layout';
import { Confirm, Empty, Field, Loading, Modal, PageHeader, Tabs, fmtDate, timeAgo } from '../../components/ui';
import { CopyBox, TokenManager } from '../../components/Tokens';
import { IconPlus } from '../../components/icons';
import { useAction, useDebounced, useOp } from '../../hooks';
import { useAuth } from '../../auth';
import type { Page, User } from '../../types';

interface RoleInfo {
  roles: Array<{ role: string; description: string; permissions: string[] }>;
  permissions: Record<string, string>;
}

export function UsersPage() {
  const [tab, setTab] = useState<'human' | 'service' | 'roles'>('human');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isLoading } = useOp<Page<User>>('user.list', { q: dq || undefined, kind: tab === 'roles' ? undefined : tab, limit: 500 }, { enabled: tab !== 'roles' });
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<User | null>(null);

  return (
    <Content>
      <PageHeader
        title="Users & access"
        subtitle="People sign in with a password or SSO; service accounts are for integrations and AI agents and authenticate with API tokens."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus /> {tab === 'service' ? 'New service account' : 'New user'}
          </button>
        }
      />
      <div className="card">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ['human', 'People'],
            ['service', 'Service accounts & AI agents'],
            ['roles', 'Roles & permissions'],
          ]}
        />
        {tab === 'roles' ? (
          <RolesTable />
        ) : (
          <>
            <div className="card-header">
              <input style={{ maxWidth: 320 }} placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
            </div>
            {isLoading ? (
              <Loading />
            ) : !data?.items.length ? (
              <Empty title="No accounts" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Status</th>
                      {tab === 'human' && <th>Sign-in</th>}
                      <th>Teams</th>
                      <th>Last sign-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((u) => (
                      <tr key={u.id} className="clickable" onClick={() => setSelected(u)}>
                        <td>
                          <strong>{u.name}</strong>
                          <div className="muted small">{u.email}</div>
                        </td>
                        <td>
                          <span className="badge blue">{u.role}</span>
                        </td>
                        <td>
                          {u.status === 'active' ? <span className="badge green">active</span> : <span className="badge red">disabled</span>}
                          {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <span className="badge amber">locked</span>}
                        </td>
                        {tab === 'human' && <td className="small">{u.authProvider === 'oidc' ? 'SSO' : 'Password'}</td>}
                        <td className="small">{u.teams.map((t) => t.name).join(', ') || '—'}</td>
                        <td className="small">{timeAgo(u.lastLoginAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
      {creating && <CreateUser kind={tab === 'service' ? 'service' : 'human'} onClose={() => setCreating(false)} />}
      {selected && <EditUser user={selected} onClose={() => setSelected(null)} />}
    </Content>
  );
}

function RolesTable() {
  const { data } = useOp<RoleInfo>('role.list', {});
  if (!data) return <Loading />;
  const perms = Object.keys(data.permissions);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Permission</th>
            {data.roles.map((r) => (
              <th key={r.role} title={r.description}>
                {r.role}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {perms.map((p) => (
            <tr key={p}>
              <td>
                <code>{p}</code>
                <div className="muted small">{data.permissions[p]}</div>
              </td>
              {data.roles.map((r) => (
                <td key={r.role}>{r.permissions.includes(p) ? '✓' : ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateUser({ kind, onClose }: { kind: 'human' | 'service'; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: kind === 'service' ? 'editor' : 'viewer', authProvider: 'local', password: '' });
  const [result, setResult] = useState<{ initialPassword?: string; id: string } | null>(null);
  const create = useAction<{ initialPassword?: string; id: string }>('user.create', { toast: 'Account created', onSuccess: setResult });
  if (result)
    return (
      <Modal title="Account created" onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        {result.initialPassword && (
          <>
            <div className="alert warning small">Share this one-time password securely; ask the user to change it after signing in.</div>
            <CopyBox value={result.initialPassword} />
          </>
        )}
        {kind === 'service' && (
          <>
            <p style={{ margin: 0 }}>Create a token for this service account to connect the agent or integration:</p>
            <TokenManager userId={result.id} />
          </>
        )}
        {!result.initialPassword && kind === 'human' && <p>The user can now sign in with single sign-on.</p>}
      </Modal>
    );
  return (
    <Modal
      title={kind === 'service' ? 'New service account' : 'New user'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!form.name || !form.email || create.isPending}
            onClick={() => create.mutate({ name: form.name, email: form.email, role: form.role, kind, authProvider: kind === 'service' ? 'local' : form.authProvider, password: form.password || undefined })}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Name" hint={kind === 'service' ? 'e.g. “Process-mapping agent (Claude)”' : undefined}>
        <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Email" hint={kind === 'service' ? 'An identifier; does not need to be a real mailbox, e.g. agent@svc.local' : undefined}>
        <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <Field label="Role">
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="viewer">Viewer — read & comment</option>
          <option value="editor">Editor — create & edit</option>
          <option value="approver">Approver — editor + publish</option>
          <option value="admin">Admin — everything</option>
        </select>
      </Field>
      {kind === 'human' && (
        <>
          <Field label="Sign-in method">
            <select value={form.authProvider} onChange={(e) => setForm({ ...form, authProvider: e.target.value })}>
              <option value="local">Password</option>
              <option value="oidc">Single sign-on only</option>
            </select>
          </Field>
          {form.authProvider === 'local' && (
            <Field label="Initial password" hint="Leave blank to generate a secure one.">
              <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          )}
        </>
      )}
    </Modal>
  );
}

function EditUser({ user, onClose }: { user: User; onClose: () => void }) {
  const { user: me } = useAuth();
  const [role, setRole] = useState(user.role);
  const [name, setName] = useState(user.name);
  const [tempPw, setTempPw] = useState<string | null>(null);
  const update = useAction('user.update', { toast: 'Account updated' });
  const reset = useAction<{ temporaryPassword?: string }>('user.resetPassword', { toast: 'Password reset', onSuccess: (r) => setTempPw(r.temporaryPassword ?? null) });
  const del = useAction('user.delete', { toast: 'Account deleted', onSuccess: onClose });
  const isSelf = me?.id === user.id;
  return (
    <Modal title={user.name} onClose={onClose} wide>
      <div className="grid grid-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="approver">Approver</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={name === user.name && role === user.role} onClick={() => update.mutate({ id: user.id, name, role })}>
          Save changes
        </button>
        {user.status === 'active' ? (
          <Confirm className="btn danger" disabled={isSelf} label="Disable account" message="Disable this account? All sessions and tokens stop working immediately." onConfirm={() => update.mutate({ id: user.id, status: 'disabled' })} />
        ) : (
          <button className="btn" onClick={() => update.mutate({ id: user.id, status: 'active' })}>
            Re-enable
          </button>
        )}
        {user.lockedUntil && new Date(user.lockedUntil) > new Date() && (
          <button className="btn" onClick={() => update.mutate({ id: user.id, unlock: true })}>
            Unlock
          </button>
        )}
        {user.kind === 'human' && user.authProvider === 'local' && (
          <Confirm className="btn" label="Reset password" message="Generate a new temporary password and sign the user out?" onConfirm={() => reset.mutate({ id: user.id })} />
        )}
        <span className="spacer" />
        <Confirm className="btn danger" disabled={isSelf} label="Delete" message={`Permanently delete ${user.email}? Audit history is kept.`} onConfirm={() => del.mutate({ id: user.id })} />
      </div>
      {tempPw && (
        <>
          <div className="alert warning small">Temporary password (shown once):</div>
          <CopyBox value={tempPw} />
        </>
      )}
      <div className="muted small">
        {user.email} · {user.kind} · created {fmtDate((user as User & { createdAt?: string }).createdAt)} · last sign-in {timeAgo(user.lastLoginAt)}
      </div>
      <TokenManager userId={user.id} />
    </Modal>
  );
}

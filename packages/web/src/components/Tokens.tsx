import { useState } from 'react';
import { Confirm, Empty, Field, Loading, Modal, fmtDate, timeAgo } from './ui';
import { IconCopy, IconPlus } from './icons';
import { toastApi, useAction, useOp } from '../hooks';

interface Token {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export function CopyBox({ value }: { value: string }) {
  return (
    <div className="row">
      <code style={{ flex: 1, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, wordBreak: 'break-all' }}>{value}</code>
      <button
        className="btn icon"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toastApi.show('Copied', 'success');
        }}
      >
        <IconCopy />
      </button>
    </div>
  );
}

/** API token management for the current user or (for admins) a given user / service account. */
export function TokenManager({ userId }: { userId?: string }) {
  const { data, isLoading } = useOp<Token[]>('token.list', userId ? { userId } : {});
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', scope: 'write', expiresInDays: '90' });
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction<{ token: string }>('token.create', {
    toast: 'Token created',
    onSuccess: (t) => {
      setCreated(t.token);
      setCreating(false);
    },
  });
  const revoke = useAction('token.revoke', { toast: 'Token revoked' });
  const active = (data ?? []).filter((t) => !t.revokedAt);

  return (
    <div className="card">
      <div className="card-header">
        <h2>API &amp; MCP tokens</h2>
        <button className="btn sm" onClick={() => setCreating(true)}>
          <IconPlus /> New token
        </button>
      </div>
      {isLoading ? (
        <Loading />
      ) : !active.length ? (
        <Empty title="No active tokens">Create a token to use the REST API or connect an AI assistant over MCP.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Scope</th>
              <th>Expires</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {active.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.prefix}…</code>
                </td>
                <td>
                  <span className={`badge ${t.scope === 'write' ? 'amber' : 'blue'}`}>{t.scope === 'write' ? 'read & write' : 'read-only'}</span>
                </td>
                <td className="small">{t.expiresAt ? fmtDate(t.expiresAt) : 'Never'}</td>
                <td className="small">{timeAgo(t.lastUsedAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <Confirm label="Revoke" message={`Revoke "${t.name}"? Anything using it will stop working immediately.`} onConfirm={() => revoke.mutate({ id: t.id })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <Modal
          title="New API token"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!form.name.trim() || create.isPending}
                onClick={() => create.mutate({ name: form.name, scope: form.scope, expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null, ...(userId ? { userId } : {}) })}
              >
                Create token
              </button>
            </>
          }
        >
          <Field label="Name" hint="Where will it be used? e.g. “Claude Desktop”, “Power BI extract”">
            <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Scope" hint="Read-only tokens can never change data, even if the account could.">
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              <option value="write">Read &amp; write (all permissions of the account)</option>
              <option value="read">Read-only</option>
            </select>
          </Field>
          <Field label="Expires">
            <select value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="">Never</option>
            </select>
          </Field>
        </Modal>
      )}
      {created && (
        <Modal title="Copy your token" onClose={() => setCreated(null)} footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}>
          <div className="alert warning small">This is the only time the token is shown. Store it in a secret manager.</div>
          <CopyBox value={created} />
        </Modal>
      )}
    </div>
  );
}

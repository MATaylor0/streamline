import { useState } from 'react';
import { Content } from '../../components/Layout';
import { Confirm, Empty, Field, Loading, Modal, PageHeader, timeAgo } from '../../components/ui';
import { CopyBox } from '../../components/Tokens';
import { IconPlus } from '../../components/icons';
import { toastApi, useAction, useOp } from '../../hooks';
import { ApiError, call } from '../../api';

interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  lastStatus: string | null;
  lastDeliveryAt: string | null;
  failureCount: number;
}

export function WebhooksPage() {
  const { data, isLoading } = useOp<Hook[]>('webhook.list', {});
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', events: 'process.publish, process.archive' });
  const [secret, setSecret] = useState<string | null>(null);
  const create = useAction<{ secret: string }>('webhook.create', {
    toast: 'Webhook created',
    onSuccess: (w) => {
      setCreating(false);
      setSecret(w.secret);
    },
  });
  const update = useAction('webhook.update', { toast: 'Updated' });
  const del = useAction('webhook.delete', { toast: 'Deleted' });
  const test = async (id: string) => {
    try {
      const r = await call<{ ok: boolean; status: string }>('webhook.test', { id });
      toastApi.show(r.ok ? `Delivered (${r.status})` : `Failed: ${r.status}`, r.ok ? 'success' : 'error');
    } catch (e) {
      toastApi.show(e instanceof ApiError ? e.friendly : 'Failed', 'error');
    }
  };
  return (
    <Content>
      <PageHeader
        title="Webhooks"
        subtitle="Push change events to other systems (ticketing, GRC tools, data pipelines, chat). Payloads are signed with HMAC-SHA256."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus /> New webhook
          </button>
        }
      />
      <div className="card">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty title="No webhooks" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Events</th>
                <th>Last delivery</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((w) => (
                <tr key={w.id}>
                  <td>
                    <strong>{w.name}</strong>
                    <div className="muted small truncate" style={{ maxWidth: 360 }}>
                      {w.url}
                    </div>
                  </td>
                  <td className="small">
                    {w.events.map((e) => (
                      <code key={e} style={{ marginRight: 4 }}>
                        {e}
                      </code>
                    ))}
                  </td>
                  <td className="small">
                    {w.lastDeliveryAt ? (
                      <>
                        {timeAgo(w.lastDeliveryAt)} · <span className={w.failureCount ? 'badge red' : 'badge green'}>{w.lastStatus}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <input type="checkbox" checked={w.active} onChange={(e) => update.mutate({ id: w.id, active: e.target.checked })} aria-label="Active" />
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => void test(w.id)}>
                        Send test
                      </button>
                      <Confirm label="Delete" message={`Delete webhook "${w.name}"?`} onConfirm={() => del.mutate({ id: w.id })} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h2>Verifying deliveries</h2>
        </div>
        <div className="card-body">
          <p className="muted small" style={{ marginTop: 0 }}>
            Each POST carries <code>X-Streamline-Timestamp</code> and <code>X-Streamline-Signature: sha256=HMAC(secret, timestamp + "." + body)</code>. Event names are operation names (e.g. <code>process.publish</code>); subscribe with wildcards like <code>process.*</code> or <code>*</code>.
          </p>
          <pre>{`{"event":"process.publish","at":"…","actor":{"id":"…","name":"…","channel":"ui"},"target":{"type":"process","id":"…"},"data":{…}}`}</pre>
        </div>
      </div>
      {creating && (
        <Modal
          title="New webhook"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!form.name || !form.url || create.isPending}
                onClick={() => create.mutate({ name: form.name, url: form.url, events: form.events.split(',').map((s) => s.trim()).filter(Boolean) })}
              >
                Create
              </button>
            </>
          }
        >
          <Field label="Name">
            <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Endpoint URL" hint="Must be HTTPS and publicly routable unless the server allows private networks.">
            <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/hooks/streamline" />
          </Field>
          <Field label="Events" hint="Comma-separated operation names or wildcards: process.*, team.create, *">
            <input value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} />
          </Field>
        </Modal>
      )}
      {secret && (
        <Modal title="Signing secret" onClose={() => setSecret(null)} footer={<button className="btn primary" onClick={() => setSecret(null)}>Done</button>}>
          <div className="alert warning small">Store this secret now — it will not be shown again.</div>
          <CopyBox value={secret} />
        </Modal>
      )}
    </Content>
  );
}

import { useEffect, useState } from 'react';
import { Content } from '../../components/Layout';
import { Field, Loading, PageHeader } from '../../components/ui';
import { useAction, useOp } from '../../hooks';
import { useAuth } from '../../auth';
import { download } from '../../api';
import type { Settings } from '../../types';

export function SettingsPage() {
  const { refresh } = useAuth();
  const { data } = useOp<Settings>('settings.get', {});
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const save = useAction('settings.update', { toast: 'Settings saved', onSuccess: () => void refresh() });
  if (!form) return <Loading />;
  const changed = JSON.stringify(form) !== JSON.stringify(data);
  return (
    <Content>
      <PageHeader title="Settings" subtitle="Organisation-wide policies. Changes are audited." />
      <div className="stack" style={{ maxWidth: 760 }}>
        <div className="card">
          <div className="card-header">
            <h2>Organisation</h2>
          </div>
          <div className="card-body stack">
            <Field label="Organisation name">
              <input value={form.organizationName} onChange={(e) => setForm({ ...form, organizationName: e.target.value })} />
            </Field>
            <Field label="Sign-in banner" hint="Shown on the login page (e.g. acceptable-use notice).">
              <textarea rows={3} value={form.loginBanner} onChange={(e) => setForm({ ...form, loginBanner: e.target.value })} />
            </Field>
            <Field label="Process reference prefix" hint="New processes are numbered PREFIX-0001. Uppercase letters/digits.">
              <input value={form.processRefPrefix} onChange={(e) => setForm({ ...form, processRefPrefix: e.target.value.toUpperCase() })} />
            </Field>
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Governance</h2>
          </div>
          <div className="card-body stack">
            <label className="check">
              <input type="checkbox" checked={form.requireReview} onChange={(e) => setForm({ ...form, requireReview: e.target.checked })} />
              <span>
                Require review before publishing
                <div className="muted small">Processes must be submitted and then approved by an approver.</div>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={!form.allowSelfApproval} onChange={(e) => setForm({ ...form, allowSelfApproval: !e.target.checked })} />
              <span>
                Enforce segregation of duties
                <div className="muted small">The person who submits a process cannot approve it.</div>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.enforceTeamOwnership} onChange={(e) => setForm({ ...form, enforceTeamOwnership: e.target.checked })} />
              <span>
                Restrict editing to the owning team
                <div className="muted small">Editors may only change processes owned by a team they belong to (admins excepted). Applies to UI, API and MCP alike.</div>
              </span>
            </label>
            <Field label="Default review interval (days)" hint="How often published processes must be re-certified. 0 disables.">
              <input type="number" min={0} max={3650} value={form.defaultReviewIntervalDays} onChange={(e) => setForm({ ...form, defaultReviewIntervalDays: Number(e.target.value) })} />
            </Field>
          </div>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!changed || save.isPending} onClick={() => save.mutate(form as unknown as Record<string, unknown>)}>
            Save settings
          </button>
          {changed && (
            <button className="btn ghost" onClick={() => setForm(data!)}>
              Discard
            </button>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Data</h2>
          </div>
          <div className="card-body stack">
            <p className="muted" style={{ margin: 0 }}>
              Download the complete repository (processes with diagrams and versions, catalog, users without credentials) as JSON. Use for backups, migrations or loading into a data warehouse. Also available at <code>GET /api/v1/export</code>.
            </p>
            <div>
              <button className="btn" onClick={() => void download('export.all')}>
                Download full export
              </button>
            </div>
          </div>
        </div>
      </div>
    </Content>
  );
}

import { useState } from 'react';
import { Content } from '../components/Layout';
import { Field, PageHeader } from '../components/ui';
import { TokenManager } from '../components/Tokens';
import { useAction } from '../hooks';
import { useAuth } from '../auth';

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const saveName = useAction('me.update', { toast: 'Profile updated', onSuccess: () => void refresh() });
  const changePw = useAction('me.changePassword', { toast: 'Password changed', onSuccess: () => setPw({ currentPassword: '', newPassword: '', confirm: '' }) });
  if (!user) return null;
  return (
    <Content>
      <PageHeader title="Your profile" subtitle={`${user.email} · ${user.role}`} />
      <div className="stack" style={{ maxWidth: 900 }}>
        <div className="grid grid-2">
          <div className="card">
            <div className="card-header">
              <h2>Profile</h2>
            </div>
            <div className="card-body stack">
              <Field label="Display name">
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div>
                <button className="btn primary" disabled={!name.trim() || name === user.name} onClick={() => saveName.mutate({ name })}>
                  Save
                </button>
              </div>
              <div className="small muted">
                Teams: {user.teams.map((t) => `${t.name}${t.role === 'lead' ? ' (lead)' : ''}`).join(', ') || 'none'}
              </div>
              <div className="small muted">Permissions: {user.permissions.join(', ')}</div>
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h2>Change password</h2>
            </div>
            <div className="card-body stack">
              <Field label="Current password">
                <input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
              </Field>
              <Field label="New password" hint="At least 12 characters with three of: lowercase, uppercase, digits, symbols.">
                <input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
              </Field>
              <Field label="Confirm new password">
                <input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              </Field>
              <div>
                <button
                  className="btn"
                  disabled={!pw.currentPassword || !pw.newPassword || pw.newPassword !== pw.confirm}
                  onClick={() => changePw.mutate({ currentPassword: pw.currentPassword, newPassword: pw.newPassword })}
                >
                  Change password
                </button>
              </div>
            </div>
          </div>
        </div>
        <TokenManager />
      </div>
    </Content>
  );
}

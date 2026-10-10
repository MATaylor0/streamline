import { useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { Field, Loading } from '../components/ui';

const SSO_ERRORS: Record<string, string> = {
  sso_expired: 'The sign-in attempt expired. Please try again.',
  sso_failed: 'Single sign-on failed. Please try again or contact your administrator.',
  forbidden: 'Your account is not permitted to sign in.',
  account_disabled: 'Your account is disabled.',
};

export function LoginPage() {
  const { user, loading, config, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const location = useLocation();

  if (loading) return <Loading />;
  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;
  const ssoError = params.get('error');

  return (
    <div className="login">
      <div className="card">
        <div className="card-body stack" style={{ padding: 28, gap: 18 }}>
          <div className="row" style={{ gap: 12 }}>
            <svg width="36" height="36" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="var(--primary)" />
              <circle cx="9" cy="16" r="3.5" fill="#fff" />
              <rect x="14" y="12" width="9" height="8" rx="2" fill="#fff" />
              <path d="M12.5 16h1.5M23 16h3" stroke="#fff" strokeWidth="2" />
            </svg>
            <div>
              <h1 style={{ fontSize: 20 }}>Sign in to Streamline</h1>
              <div className="muted">{config?.organizationName}</div>
            </div>
          </div>
          {config?.loginBanner && <div className="alert info pre-wrap">{config.loginBanner}</div>}
          {(error || ssoError) && <div className="alert error">{error ?? SSO_ERRORS[ssoError!] ?? 'Sign-in failed'}</div>}
          {config?.oidc.enabled && (
            <a className="btn primary" href={config.oidc.startUrl} style={{ height: 40 }}>
              Continue with {config.oidc.displayName}
            </a>
          )}
          {config?.oidc.enabled && config.localEnabled && <div className="muted small" style={{ textAlign: 'center' }}>or sign in with a password</div>}
          {config?.localEnabled && (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  await login(email, password);
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : 'Sign-in failed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Email">
                <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </Field>
              <Field label="Password">
                <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <button className={`btn ${config.oidc.enabled ? '' : 'primary'}`} style={{ height: 40 }} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
          <div className="muted small" style={{ textAlign: 'center' }}>
            v{config?.version}
          </div>
        </div>
      </div>
    </div>
  );
}

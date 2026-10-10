import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { loadManifest, rawJson, setCsrfToken, setUnauthorizedHandler } from './api';
import type { AuthConfig, Me } from './types';

interface AuthState {
  loading: boolean;
  user: Me | null;
  config: AuthConfig | null;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

interface SessionResponse {
  authenticated: boolean;
  user?: Me;
  csrfToken?: string | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<Me | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const qc = useQueryClient();

  const apply = useCallback(async (s: SessionResponse) => {
    setCsrfToken(s.csrfToken ?? null);
    if (s.authenticated && s.user) {
      await loadManifest();
      setUser(s.user);
    } else {
      setUser(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [cfg, s] = await Promise.all([rawJson<AuthConfig>('GET', '/api/v1/auth/config'), rawJson<SessionResponse>('GET', '/api/v1/auth/session')]);
    setConfig(cfg);
    await apply(s);
  }, [apply]);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      config,
      can: (p) => Boolean(user?.permissions.includes(p)),
      login: async (email, password) => {
        await apply(await rawJson<SessionResponse>('POST', '/api/v1/auth/login', { email, password }));
      },
      logout: async () => {
        await rawJson('POST', '/api/v1/auth/logout', {});
        setCsrfToken(null);
        setUser(null);
        qc.clear();
      },
      refresh,
    }),
    [loading, user, config, apply, refresh, qc],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Loading, Toasts } from './components/ui';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ProcessesPage } from './pages/Processes';
import { ProcessPage } from './pages/Process';
import { TeamMapPage } from './pages/TeamMap';
import { LandscapePage } from './pages/Landscape';
import { SearchPage } from './pages/Search';
import { TeamsPage, TeamPage } from './pages/Teams';
import { SystemsPage, SystemPage } from './pages/Systems';
import { RisksPage, RiskPage, ControlsPage, ControlPage } from './pages/RisksControls';
import { RcmPage } from './pages/Rcm';
import { TagsPage } from './pages/Tags';
import { ProfilePage } from './pages/Profile';
import { IntegrationsPage } from './pages/Integrations';
import { UsersPage } from './pages/admin/Users';
import { SettingsPage } from './pages/admin/Settings';
import { AuditPage } from './pages/admin/Audit';
import { WebhooksPage } from './pages/admin/Webhooks';
import { ApiError } from './api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** UI-side guard for admin pages (the API enforces the same permissions server-side). */
function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <Navigate to="/" replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="processes" element={<ProcessesPage />} />
        <Route path="processes/:id" element={<ProcessPage />} />
        <Route path="team-map" element={<TeamMapPage />} />
        <Route path="landscape" element={<LandscapePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="teams/:id" element={<TeamPage />} />
        <Route path="systems" element={<SystemsPage />} />
        <Route path="systems/:id" element={<SystemPage />} />
        <Route path="risks" element={<RisksPage />} />
        <Route path="risks/:id" element={<RiskPage />} />
        <Route path="controls" element={<ControlsPage />} />
        <Route path="controls/:id" element={<ControlPage />} />
        <Route path="rcm" element={<RcmPage />} />
        <Route path="tags" element={<TagsPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="admin/users" element={<RequirePermission permission="admin:users"><UsersPage /></RequirePermission>} />
        <Route path="admin/settings" element={<RequirePermission permission="admin:settings"><SettingsPage /></RequirePermission>} />
        <Route path="admin/audit" element={<RequirePermission permission="admin:audit"><AuditPage /></RequirePermission>} />
        <Route path="admin/webhooks" element={<RequirePermission permission="admin:settings"><WebhooksPage /></RequirePermission>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toasts />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

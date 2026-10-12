import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useLocalStorage } from '../hooks';
import { initials } from './ui';
import {
  IconAlert,
  IconBot,
  IconFlow,
  IconGrid,
  IconHome,
  IconKey,
  IconLog,
  IconLogout,
  IconMap,
  IconMenu,
  IconMoon,
  IconNetwork,
  IconPlug,
  IconSearch,
  IconServer,
  IconSettings,
  IconShield,
  IconTag,
  IconUsers,
} from './icons';

function Item({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      {icon}
      {children}
    </NavLink>
  );
}

export function Layout() {
  const { user, can, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useLocalStorage<'system' | 'light' | 'dark'>('sl-theme', 'system');

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => setOpen(false), [location.pathname]);

  const isAdmin = can('admin:users') || can('admin:settings') || can('admin:audit');

  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--primary)" />
            <circle cx="9" cy="16" r="3.5" fill="#fff" />
            <rect x="14" y="12" width="9" height="8" rx="2" fill="#fff" />
            <path d="M12.5 16h1.5M23 16h3" stroke="#fff" strokeWidth="2" />
          </svg>
          <div>
            Streamline
            <small>{user?.organizationName}</small>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          <Item to="/" end icon={<IconHome />}>
            Dashboard
          </Item>
          <Item to="/processes" icon={<IconFlow />}>
            Processes
          </Item>
          <Item to="/team-map" icon={<IconNetwork />}>
            Team map
          </Item>
          <Item to="/landscape" icon={<IconMap />}>
            Process landscape
          </Item>
          <Item to="/search" icon={<IconSearch />}>
            Search
          </Item>
          <div className="nav-section">Catalog</div>
          <Item to="/teams" icon={<IconUsers />}>
            Teams
          </Item>
          <Item to="/systems" icon={<IconServer />}>
            Business systems
          </Item>
          <Item to="/risks" icon={<IconAlert />}>
            Risks
          </Item>
          <Item to="/controls" icon={<IconShield />}>
            Controls
          </Item>
          <Item to="/agents" icon={<IconBot />}>
            AI agents
          </Item>
          <Item to="/rcm" icon={<IconGrid />}>
            Risk &amp; control matrix
          </Item>
          <Item to="/tags" icon={<IconTag />}>
            Tags
          </Item>
          {isAdmin && <div className="nav-section">Administration</div>}
          {can('admin:users') && (
            <Item to="/admin/users" icon={<IconUsers />}>
              Users &amp; access
            </Item>
          )}
          {can('admin:settings') && (
            <Item to="/admin/settings" icon={<IconSettings />}>
              Settings
            </Item>
          )}
          {can('admin:settings') && (
            <Item to="/admin/webhooks" icon={<IconPlug />}>
              Webhooks
            </Item>
          )}
          {can('admin:audit') && (
            <Item to="/admin/audit" icon={<IconLog />}>
              Audit log
            </Item>
          )}
          <div className="nav-section">Developers</div>
          <Item to="/integrations" icon={<IconKey />}>
            API &amp; MCP access
          </Item>
        </nav>
        <div className="sidebar-footer">
          <NavLink to="/profile" className="avatar" title="Profile">
            {initials(user?.name ?? '?')}
          </NavLink>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="truncate" style={{ fontWeight: 600 }}>
              {user?.name}
            </div>
            <div className="muted small truncate">{user?.role}</div>
          </div>
          <button
            className="btn ghost icon sm"
            title={`Theme: ${theme}`}
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')}
          >
            <IconMoon />
          </button>
          <button className="btn ghost icon sm" title="Sign out" aria-label="Sign out" onClick={() => void logout().then(() => navigate('/login'))}>
            <IconLogout />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-toggle" aria-label="Menu" onClick={() => setOpen(!open)}>
            <IconMenu />
          </button>
          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <IconSearch />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search processes, steps, systems, risks, controls…" aria-label="Search" />
          </form>
        </header>
        <Outlet />
      </div>
    </div>
  );
}

export function Content({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return <main className={`content ${flush ? 'flush' : ''}`}>{children}</main>;
}

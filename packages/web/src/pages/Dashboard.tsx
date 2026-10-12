import { Link } from 'react-router-dom';
import { Content } from '../components/Layout';
import { ErrorBox, Loading, PageHeader, StatusBadge, fmtDate, timeAgo } from '../components/ui';
import { useOp } from '../hooks';
import { useAuth } from '../auth';

interface Overview {
  processesByStatus: Record<string, number>;
  totals: Record<string, number>;
  risksByRating: Record<string, number>;
  risksWithoutControls: number;
  controlsByEffectiveness: Record<string, number>;
  processesWithoutOwner: number;
  stepsByAutomationLevel: Record<string, number>;
  reviewsDue: Array<{ id: string; ref: string; name: string; nextReviewAt: string; overdue: boolean }>;
  recentlyUpdated: Array<{ id: string; ref: string; name: string; status: string; updatedAt: string }>;
}

function Stat({ label, value, to }: { label: string; value: number | string; to?: string }) {
  const body = (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
  return to ? (
    <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>
      {body}
    </Link>
  ) : (
    body
  );
}

function Breakdown({ data, colors, labels }: { data: Record<string, number>; colors: Record<string, string>; labels?: Record<string, string> }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="bar">
        {Object.keys(colors).map((k) => (data[k] ? <span key={k} style={{ width: `${(data[k] / total) * 100}%`, background: colors[k] }} title={`${labels?.[k] ?? k}: ${data[k]}`} /> : null))}
      </div>
      <div className="row wrap" style={{ gap: 14 }}>
        {Object.keys(colors).map((k) => (
          <span key={k} className="row small" style={{ gap: 6 }}>
            <span className="dot" style={{ background: colors[k] }} />
            {labels?.[k] ?? k} <strong>{data[k] ?? 0}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useOp<Overview>('analytics.overview', { reviewWindowDays: 30 });
  if (isLoading) return <Loading />;
  if (error) return <Content><ErrorBox error={error} /></Content>;
  const d = data!;
  const processTotal = Object.values(d.processesByStatus).reduce((a, b) => a + b, 0);

  return (
    <Content>
      <PageHeader title={`Welcome back, ${user?.name.split(' ')[0]}`} subtitle={`${d.totals.teams} teams · ${processTotal} processes · ${d.totals.steps} mapped steps`} actions={<Link className="btn primary" to="/processes?new=1">New process</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Processes" value={processTotal} to="/processes" />
        <Stat label="Published" value={d.processesByStatus.published ?? 0} to="/processes?status=published" />
        <Stat label="Awaiting review" value={d.processesByStatus.in_review ?? 0} to="/processes?status=in_review" />
        <Stat label="Business systems" value={d.totals.systems} to="/systems" />
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <h2>Process status</h2>
          </div>
          <div className="card-body">
            <Breakdown
              data={d.processesByStatus}
              colors={{ draft: '#94a3b8', in_review: '#d97706', published: '#16a34a', archived: '#7c3aed' }}
              labels={{ draft: 'Draft', in_review: 'In review', published: 'Published', archived: 'Archived' }}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Risk exposure</h2>
            <Link to="/rcm" className="small">
              Matrix →
            </Link>
          </div>
          <div className="card-body stack">
            <Breakdown data={d.risksByRating} colors={{ low: '#16a34a', medium: '#d97706', high: '#ea580c', critical: '#dc2626' }} />
            {d.risksWithoutControls > 0 && <div className="alert warning small">{d.risksWithoutControls} open risk(s) have no mitigating control</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Control effectiveness</h2>
          </div>
          <div className="card-body">
            <Breakdown
              data={d.controlsByEffectiveness}
              colors={{ effective: '#16a34a', partially_effective: '#d97706', ineffective: '#dc2626', not_tested: '#94a3b8' }}
              labels={{ effective: 'Effective', partially_effective: 'Partial', ineffective: 'Ineffective', not_tested: 'Not tested' }}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>AI delegation</h2>
            <Link to="/agents" className="small">
              Register →
            </Link>
          </div>
          <div className="card-body">
            <Breakdown
              data={d.stepsByAutomationLevel}
              colors={{ manual: '#94a3b8', assisted: '#2563eb', supervised: '#7c3aed', autonomous: '#d97706' }}
              labels={{ manual: 'Manual', assisted: 'Assisted', supervised: 'Supervised', autonomous: 'Autonomous' }}
            />
          </div>
        </div>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>Recently updated</h2>
            <Link to="/processes" className="small">
              All processes →
            </Link>
          </div>
          <ul className="list-plain" style={{ padding: '0 16px' }}>
            {d.recentlyUpdated.map((p) => (
              <li key={p.id} className="row">
                <span className="muted small nowrap">{p.ref}</span>
                <Link to={`/processes/${p.id}`} className="truncate">
                  {p.name}
                </Link>
                <span className="spacer" />
                <StatusBadge status={p.status} />
                <span className="muted small nowrap">{timeAgo(p.updatedAt)}</span>
              </li>
            ))}
            {!d.recentlyUpdated.length && <li className="muted">No processes yet.</li>}
          </ul>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Periodic reviews due (30 days)</h2>
          </div>
          <ul className="list-plain" style={{ padding: '0 16px' }}>
            {d.reviewsDue.map((p) => (
              <li key={p.id} className="row">
                <span className="muted small nowrap">{p.ref}</span>
                <Link to={`/processes/${p.id}`} className="truncate">
                  {p.name}
                </Link>
                <span className="spacer" />
                <span className={`badge ${p.overdue ? 'red' : 'amber'}`}>{p.overdue ? 'Overdue' : 'Due'} {fmtDate(p.nextReviewAt)}</span>
              </li>
            ))}
            {!d.reviewsDue.length && <li className="muted">Nothing due. 🎉</li>}
            {d.processesWithoutOwner > 0 && (
              <li>
                <span className="badge amber">{d.processesWithoutOwner} process(es) have no owning team</span>
              </li>
            )}
          </ul>
        </div>
      </div>
    </Content>
  );
}

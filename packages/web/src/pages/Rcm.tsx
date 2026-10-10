import { Link } from 'react-router-dom';
import { Content } from '../components/Layout';
import { EffectivenessBadge, ErrorBox, Loading, PageHeader, RatingBadge } from '../components/ui';
import { IconDownload } from '../components/icons';
import { useOp } from '../hooks';
import { downloadCsv } from '../api';

interface Rcm {
  risks: Array<{
    id: string;
    ref: string;
    title: string;
    category: string | null;
    status: string;
    score: number;
    rating: string;
    controls: Array<{ id: string; ref: string; name: string; effectiveness: string; nature: string }>;
    processes: Array<{ id: string; ref: string; name: string; controlled: boolean }>;
  }>;
  gaps: {
    risksWithoutControls: Array<{ id: string; ref: string; title: string; rating: string }>;
    uncontrolledOccurrences: Array<{ riskId: string; riskRef: string; risk: string; processId: string; process: string }>;
    controlsWithoutRisks: Array<{ id: string; ref: string; name: string }>;
    ineffectiveControls: Array<{ id: string; ref: string; name: string; effectiveness: string }>;
  };
}

function GapCard({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-header">
        <h3>{title}</h3>
        <span className={`badge ${count ? 'red' : 'green'}`}>{count}</span>
      </div>
      <ul className="list-plain small" style={{ padding: '0 16px', maxHeight: 220, overflow: 'auto' }}>
        {children}
        {!count && <li className="muted">None 🎉</li>}
      </ul>
    </div>
  );
}

export function RcmPage() {
  const { data, isLoading, error } = useOp<Rcm>('analytics.riskControlMatrix', {});
  if (isLoading) return <Loading />;
  if (error || !data) return <Content><ErrorBox error={error} /></Content>;
  const g = data.gaps;
  return (
    <Content>
      <PageHeader
        title="Risk & control matrix"
        subtitle="Each risk with its mitigating controls and the processes it occurs in. A process is “controlled” when one of the risk’s controls is performed in it."
        actions={
          <button
            className="btn"
            onClick={() =>
              downloadCsv(
                'risk-control-matrix.csv',
                data.risks.flatMap((r) =>
                  (r.controls.length ? r.controls : [null]).map((c) => ({
                    riskRef: r.ref,
                    risk: r.title,
                    rating: r.rating,
                    score: r.score,
                    status: r.status,
                    controlRef: c?.ref ?? '',
                    control: c?.name ?? '',
                    effectiveness: c?.effectiveness ?? '',
                    processes: r.processes.map((p) => `${p.ref}${p.controlled ? '' : ' (gap)'}`),
                  })),
                ),
              )
            }
          >
            <IconDownload /> Export CSV
          </button>
        }
      />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <GapCard title="Risks without controls" count={g.risksWithoutControls.length}>
          {g.risksWithoutControls.map((r) => (
            <li key={r.id}>
              <Link to={`/risks/${r.id}`}>
                {r.ref} {r.title}
              </Link>{' '}
              <RatingBadge rating={r.rating} />
            </li>
          ))}
        </GapCard>
        <GapCard title="Uncontrolled occurrences" count={g.uncontrolledOccurrences.length}>
          {g.uncontrolledOccurrences.map((o) => (
            <li key={`${o.riskId}${o.processId}`}>
              <Link to={`/risks/${o.riskId}`}>{o.riskRef}</Link> in <Link to={`/processes/${o.processId}?tab=risks`}>{o.process}</Link>
            </li>
          ))}
        </GapCard>
        <GapCard title="Ineffective controls" count={g.ineffectiveControls.length}>
          {g.ineffectiveControls.map((c) => (
            <li key={c.id}>
              <Link to={`/controls/${c.id}`}>
                {c.ref} {c.name}
              </Link>{' '}
              <EffectivenessBadge value={c.effectiveness} />
            </li>
          ))}
        </GapCard>
        <GapCard title="Controls not linked to a risk" count={g.controlsWithoutRisks.length}>
          {g.controlsWithoutRisks.map((c) => (
            <li key={c.id}>
              <Link to={`/controls/${c.id}`}>
                {c.ref} {c.name}
              </Link>
            </li>
          ))}
        </GapCard>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Risk</th>
                <th>Rating</th>
                <th>Controls</th>
                <th>Processes</th>
              </tr>
            </thead>
            <tbody>
              {data.risks.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/risks/${r.id}`} style={{ fontWeight: 600 }}>
                      {r.ref} {r.title}
                    </Link>
                    <div className="muted small">
                      {r.category} · {r.status}
                    </div>
                  </td>
                  <td>
                    <RatingBadge rating={r.rating} /> <span className="muted small">{r.score}</span>
                  </td>
                  <td className="small">
                    {r.controls.map((c) => (
                      <div key={c.id} className="row" style={{ gap: 6, marginBottom: 2 }}>
                        <Link to={`/controls/${c.id}`}>
                          {c.ref} {c.name}
                        </Link>
                        <EffectivenessBadge value={c.effectiveness} />
                      </div>
                    ))}
                    {!r.controls.length && <span className="badge red">No controls</span>}
                  </td>
                  <td className="small">
                    {r.processes.map((p) => (
                      <div key={p.id} className="row" style={{ gap: 6, marginBottom: 2 }}>
                        <Link to={`/processes/${p.id}?tab=risks`}>
                          {p.ref} {p.name}
                        </Link>
                        {p.controlled ? <span className="badge green">controlled</span> : <span className="badge red">gap</span>}
                      </div>
                    ))}
                    {!r.processes.length && <span className="muted">Not mapped to any process</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Content>
  );
}

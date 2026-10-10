import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useDebounced, useOp } from '../hooks';

interface Hit {
  type: 'process' | 'step' | 'team' | 'system' | 'risk' | 'control';
  id: string;
  title: string;
  subtitle: string | null;
  snippet: string | null;
  processId: string | null;
  score: number;
}

const TYPES: Array<[Hit['type'], string, string]> = [
  ['process', 'Processes', 'blue'],
  ['step', 'Steps', ''],
  ['team', 'Teams', 'green'],
  ['system', 'Systems', 'purple'],
  ['risk', 'Risks', 'red'],
  ['control', 'Controls', 'amber'],
];

const href = (h: Hit) =>
  h.type === 'process' || h.type === 'step' ? `/processes/${h.processId}` : h.type === 'team' ? `/teams/${h.id}` : h.type === 'system' ? `/systems/${h.id}` : h.type === 'risk' ? `/risks/${h.id}` : `/controls/${h.id}`;

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const alt = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(${alt})`, 'ig');
  const exact = new RegExp(`^(${alt})$`, 'i');
  return (
    <>
      {text.split(re).map((part, i) =>
        exact.test(part) ? (
          <mark key={i} style={{ background: 'color-mix(in srgb, var(--warning) 30%, transparent)', color: 'inherit', borderRadius: 3 }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [types, setTypes] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const dq = useDebounced(q.trim(), 250);
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  useEffect(() => {
    if (dq !== (params.get('q') ?? '')) setParams(dq ? { q: dq } : {}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const { data, isLoading, error } = useOp<{ items: Hit[]; counts: Record<string, number> }>('search.query', { q: dq, types: types.length ? types.join(',') : undefined, includeArchived: archived, limit: 100 }, { enabled: dq.length > 0 });
  const terms = dq.toLowerCase().split(/\s+/).filter(Boolean);

  return (
    <Content>
      <PageHeader title="Search" subtitle="Keyword search across every process, step, team, business system, risk and control." />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body stack">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder='e.g. "invoice approval", SAP, sanctions, onboarding' style={{ fontSize: 16, height: 42 }} aria-label="Search terms" />
          <div className="row wrap">
            {TYPES.map(([t, label]) => (
              <label key={t} className="check small">
                <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />
                {label}
                {data?.counts[t] ? <span className="muted">({data.counts[t]})</span> : null}
              </label>
            ))}
            <span className="spacer" />
            <label className="check small">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived
            </label>
          </div>
        </div>
      </div>
      {!dq ? (
        <Empty title="Start typing to search">All words must match. Titles rank highest.</Empty>
      ) : isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data?.items.length ? (
        <Empty title={`No results for “${dq}”`}>Try fewer or different words.</Empty>
      ) : (
        <div className="card">
          <ul className="list-plain" style={{ padding: '0 16px' }}>
            {data.items.map((h) => {
              const [, label, cls] = TYPES.find(([t]) => t === h.type)!;
              return (
                <li key={`${h.type}:${h.id}`} style={{ padding: '12px 0' }}>
                  <div className="row">
                    <span className={`badge ${cls}`}>{label.replace(/s$/, '')}</span>
                    <Link to={href(h)} style={{ fontWeight: 600 }}>
                      <Highlight text={h.title} terms={terms} />
                    </Link>
                  </div>
                  {h.subtitle && <div className="muted small" style={{ marginTop: 2 }}>{h.subtitle}</div>}
                  {h.snippet && (
                    <div className="small" style={{ marginTop: 4, color: 'var(--text-2)' }}>
                      <Highlight text={h.snippet} terms={terms} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Content>
  );
}

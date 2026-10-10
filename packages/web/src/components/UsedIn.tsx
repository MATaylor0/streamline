import { Link } from 'react-router-dom';
import type { UsedIn as UsedInT } from '../types';
import { Empty, StatusBadge } from './ui';

export function UsedIn({ items, what }: { items: UsedInT[]; what: string }) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>Where it’s used</h2>
        <span className="muted small">
          {items.length} process{items.length === 1 ? '' : 'es'} · {items.reduce((a, p) => a + p.steps.length, 0)} steps
        </span>
      </div>
      {!items.length ? (
        <Empty title={`This ${what} is not used in any process yet`}>Attach it to steps from the diagram editor.</Empty>
      ) : (
        <ul className="list-plain" style={{ padding: '0 16px' }}>
          {items.map((p) => (
            <li key={p.id}>
              <div className="row">
                <span className="muted small">{p.ref}</span>
                <Link to={`/processes/${p.id}`} style={{ fontWeight: 600 }}>
                  {p.name}
                </Link>
                <StatusBadge status={p.status} />
              </div>
              <div className="muted small" style={{ marginTop: 2 }}>
                Steps: {p.steps.map((s) => s.label).join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

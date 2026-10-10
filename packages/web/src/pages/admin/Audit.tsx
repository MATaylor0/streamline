import { useState } from 'react';
import { Content } from '../../components/Layout';
import { Empty, Loading, Modal, PageHeader, fmtDate } from '../../components/ui';
import { IconDownload } from '../../components/icons';
import { useDebounced, useOp } from '../../hooks';
import { downloadCsv } from '../../api';

interface Entry {
  id: string;
  at: string;
  actorId: string | null;
  actor: string;
  channel: string;
  operation: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  detail: unknown;
  ip: string | null;
  requestId: string | null;
}

const CHANNEL: Record<string, [string, string]> = {
  ui: ['UI', ''],
  api: ['API', 'blue'],
  mcp: ['AI / MCP', 'purple'],
  cli: ['CLI', 'amber'],
  system: ['System', ''],
};

export function AuditPage() {
  const [filters, setFilters] = useState({ operation: '', channel: '', outcome: '', from: '', to: '' });
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<Entry | null>(null);
  const op = useDebounced(filters.operation);
  const limit = 100;
  const { data, isLoading } = useOp<{ items: Entry[]; total: number }>('audit.list', {
    operation: op || undefined,
    channel: filters.channel || undefined,
    outcome: filters.outcome || undefined,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(new Date(filters.to).getTime() + 86_400_000).toISOString() : undefined,
    limit,
    offset: page * limit,
  });
  const set = (k: keyof typeof filters, v: string) => {
    setFilters({ ...filters, [k]: v });
    setPage(0);
  };
  return (
    <Content>
      <PageHeader
        title="Audit log"
        subtitle="Immutable record of every change and every denied attempt, from every access path."
        actions={
          <button className="btn" disabled={!data?.items.length} onClick={() => downloadCsv('audit-log.csv', data!.items.map((e) => ({ at: e.at, actor: e.actor, channel: e.channel, operation: e.operation, targetType: e.targetType, targetId: e.targetId, outcome: e.outcome, ip: e.ip, requestId: e.requestId, detail: JSON.stringify(e.detail) })))}>
            <IconDownload /> CSV (this page)
          </button>
        }
      />
      <div className="card">
        <div className="card-header row wrap" style={{ justifyContent: 'flex-start' }}>
          <input style={{ maxWidth: 220 }} placeholder="Operation, e.g. process.*" value={filters.operation} onChange={(e) => set('operation', e.target.value)} aria-label="Operation" />
          <select style={{ maxWidth: 150 }} value={filters.channel} onChange={(e) => set('channel', e.target.value)} aria-label="Channel">
            <option value="">All channels</option>
            <option value="ui">UI</option>
            <option value="api">API</option>
            <option value="mcp">AI / MCP</option>
            <option value="cli">CLI</option>
            <option value="system">System</option>
          </select>
          <select style={{ maxWidth: 150 }} value={filters.outcome} onChange={(e) => set('outcome', e.target.value)} aria-label="Outcome">
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </select>
          <input style={{ maxWidth: 160 }} type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
          <input style={{ maxWidth: 160 }} type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
          <span className="spacer" />
          <span className="muted small">{data?.total ?? 0} entries</span>
        </div>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No matching entries" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Via</th>
                  <th>Operation</th>
                  <th>Target</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => {
                  const [ch, cls] = CHANNEL[e.channel] ?? [e.channel, ''];
                  return (
                    <tr key={e.id} className="clickable" onClick={() => setDetail(e)}>
                      <td className="nowrap small">{fmtDate(e.at, true)}</td>
                      <td className="small">{e.actor}</td>
                      <td>
                        <span className={`badge ${cls}`}>{ch}</span>
                      </td>
                      <td>
                        <code>{e.operation}</code>
                      </td>
                      <td className="small muted">{e.targetType ? `${e.targetType}${e.targetId ? ` ${e.targetId.slice(0, 8)}` : ''}` : '—'}</td>
                      <td>
                        <span className={`badge ${e.outcome === 'success' ? 'green' : 'red'}`}>{e.outcome}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > limit && (
          <div className="card-header row" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Newer
            </button>
            <span className="muted small">
              {page * limit + 1}–{Math.min(data.total, (page + 1) * limit)} of {data.total}
            </span>
            <button className="btn sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>
              Older
            </button>
          </div>
        )}
      </div>
      {detail && (
        <Modal title={detail.operation} onClose={() => setDetail(null)} wide>
          <dl className="kv small">
            <dt>When</dt>
            <dd>{fmtDate(detail.at, true)}</dd>
            <dt>Actor</dt>
            <dd>{detail.actor}</dd>
            <dt>Channel</dt>
            <dd>{detail.channel}</dd>
            <dt>Outcome</dt>
            <dd>{detail.outcome}</dd>
            <dt>Target</dt>
            <dd>
              {detail.targetType} {detail.targetId}
            </dd>
            <dt>IP</dt>
            <dd>{detail.ip ?? '—'}</dd>
            <dt>Request id</dt>
            <dd>
              <code>{detail.requestId ?? '—'}</code>
            </dd>
          </dl>
          <pre>{JSON.stringify(detail.detail, null, 2)}</pre>
        </Modal>
      )}
    </Content>
  );
}

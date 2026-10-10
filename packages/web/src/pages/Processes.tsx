import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, StatusBadge, TagInput, TeamChip, timeAgo } from '../components/ui';
import { IconDownload, IconPlus, IconUpload } from '../components/icons';
import { useAction, useDebounced, useOp } from '../hooks';
import { useAuth } from '../auth';
import { useCatalog } from '../catalog';
import { downloadCsv } from '../api';
import type { Page, Process, ProcessFull } from '../types';

export function ProcessesPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const catalog = useCatalog();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q);
  const status = params.get('status') ?? '';
  const teamId = params.get('team') ?? '';
  const tag = params.get('tag') ?? '';
  const [page, setPage] = useState(0);
  const limit = 50;
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(0);
  };
  const { data, isLoading, error } = useOp<Page<Process>>('process.list', {
    q: dq || undefined,
    status: status || undefined,
    teamId: teamId || undefined,
    tag: tag || undefined,
    sort: 'updated',
    limit,
    offset: page * limit,
  });
  const showNew = params.get('new') === '1';
  const showImport = params.get('import') === '1';

  return (
    <Content>
      <PageHeader
        title="Processes"
        subtitle="Every documented business process, its owner and lifecycle state."
        actions={
          <>
            <button
              className="btn"
              disabled={!data?.items.length}
              onClick={() =>
                downloadCsv(
                  'processes.csv',
                  data!.items.map((p) => ({ ref: p.ref, name: p.name, status: p.status, category: p.category, ownerTeam: p.ownerTeam?.name, owner: p.ownerUser?.name, steps: p.stepCount, tags: p.tags.map((t) => t.name), nextReview: p.nextReviewAt, updated: p.updatedAt })),
                )
              }
            >
              <IconDownload /> CSV
            </button>
            {can('process:write') && (
              <button className="btn" onClick={() => set('import', '1')}>
                <IconUpload /> Import
              </button>
            )}
            {can('process:write') && (
              <button className="btn primary" onClick={() => set('new', '1')}>
                <IconPlus /> New process
              </button>
            )}
          </>
        }
      />
      <div className="card">
        <div className="card-header row wrap" style={{ justifyContent: 'flex-start' }}>
          <input style={{ maxWidth: 280 }} placeholder="Filter by name, ref, category…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
          <select style={{ maxWidth: 170 }} value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
            <option value="">Active (not archived)</option>
            <option value="draft">Draft</option>
            <option value="in_review">In review</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <select style={{ maxWidth: 200 }} value={teamId} onChange={(e) => set('team', e.target.value)} aria-label="Owner team">
            <option value="">All owner teams</option>
            {catalog.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select style={{ maxWidth: 180 }} value={tag} onChange={(e) => set('tag', e.target.value)} aria-label="Tag">
            <option value="">All tags</option>
            {catalog.tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <span className="muted small">{data?.total ?? 0} processes</span>
        </div>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="card-body">
            <ErrorBox error={error} />
          </div>
        ) : !data?.items.length ? (
          <Empty title="No processes found">{can('process:write') ? 'Create your first process to start mapping how work gets done.' : 'Try adjusting the filters.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Owner team</th>
                  <th>Steps</th>
                  <th>Tags</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="muted nowrap">{p.ref}</td>
                    <td>
                      <Link to={`/processes/${p.id}`} style={{ fontWeight: 600 }}>
                        {p.name}
                      </Link>
                      {p.category && <div className="muted small">{p.category}</div>}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                      {p.publishedVersion && p.status !== 'published' && <div className="muted small">v{p.publishedVersion} published</div>}
                    </td>
                    <td>
                      <TeamChip team={p.ownerTeam} />
                    </td>
                    <td>{p.stepCount}</td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        {p.tags.map((t) => (
                          <button key={t.id} className="tag" style={{ cursor: 'pointer' }} onClick={() => set('tag', t.name)}>
                            <span className="dot" style={{ background: t.color }} />
                            {t.name}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="muted nowrap small">
                      {timeAgo(p.updatedAt)}
                      {p.updatedBy && <div>{p.updatedBy.name}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > limit && (
          <div className="card-header row" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="muted small">
              {page * limit + 1}–{Math.min(data.total, (page + 1) * limit)} of {data.total}
            </span>
            <button className="btn sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
      {showNew && <NewProcessModal onClose={() => set('new', '')} />}
      {showImport && <ImportModal onClose={() => set('import', '')} />}
    </Content>
  );
}

function NewProcessModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const catalog = useCatalog();
  const { user } = useAuth();
  const [form, setForm] = useState({ name: '', summary: '', category: '', ownerTeamId: user?.teams[0]?.id ?? '', tags: [] as string[], template: 'basic' });
  const create = useAction<ProcessFull>('process.create', { toast: 'Process created', onSuccess: (p) => navigate(`/processes/${p.id}`) });
  const categories = [...new Set(catalog.processes.map((p) => p.category).filter(Boolean))] as string[];
  return (
    <Modal
      title="New process"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!form.name.trim() || create.isPending}
            onClick={() => create.mutate({ ...form, ownerTeamId: form.ownerTeamId || null, category: form.category || null })}
          >
            Create &amp; open editor
          </button>
        </>
      }
    >
      <Field label="Name">
        <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Supplier invoice to payment" />
      </Field>
      <Field label="Summary" hint="One or two sentences on the purpose and outcome.">
        <textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="Owning team">
          <select value={form.ownerTeamId} onChange={(e) => setForm({ ...form, ownerTeamId: e.target.value })}>
            <option value="">— None —</option>
            {catalog.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <input list="categories" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Finance / Procure to Pay" />
          <datalist id="categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Tags">
        <TagInput value={form.tags} onChange={(tags) => setForm({ ...form, tags })} suggestions={catalog.tags.map((t) => t.name)} />
      </Field>
      <Field label="Start from">
        <select value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
          <option value="basic">Start and end events</option>
          <option value="blank">Empty canvas</option>
        </select>
      </Field>
    </Modal>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const imp = useAction<ProcessFull>('process.import', { toast: 'Process imported', onSuccess: (p) => navigate(`/processes/${p.id}`) });
  return (
    <Modal
      title="Import process"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!text.trim() || imp.isPending}
            onClick={() => {
              try {
                setParseError(null);
                imp.mutate({ document: JSON.parse(text) });
              } catch {
                setParseError('Not valid JSON');
              }
            }}
          >
            Import as draft
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Paste or upload a Streamline JSON export (<code>streamline.process.v1</code>). Teams, systems, risks and controls are matched by name and created when missing.
      </p>
      <input
        type="file"
        accept=".json,application/json"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }}
      />
      <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"format":"streamline.process.v1", …}' style={{ fontFamily: 'monospace', fontSize: 12 }} />
      {parseError && <div className="alert error">{parseError}</div>}
    </Modal>
  );
}

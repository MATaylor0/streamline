import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Content } from '../components/Layout';
import { DiagramEditor } from '../components/DiagramEditor';
import { Confirm, Empty, ErrorBox, Field, Loading, Modal, StatusBadge, TagInput, Tabs, TeamChip, fmtDate, timeAgo, EffectivenessBadge, RatingBadge } from '../components/ui';
import { IconDownload } from '../components/icons';
import { useAction, useOp } from '../hooks';
import { useAuth } from '../auth';
import { useCatalog } from '../catalog';
import { ApiError, call, download, fetchText } from '../api';
import type { ProcessFull, StepNode } from '../types';

type Tab = 'diagram' | 'details' | 'steps' | 'risks' | 'versions' | 'comments' | 'activity';

export function ProcessPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  // Local state drives the view (so leaving the editor is immediate); the URL mirrors it for deep links.
  const [tab, setTabState] = useState<Tab>((params.get('tab') as Tab) ?? 'diagram');
  useEffect(() => {
    const fromUrl = (params.get('tab') as Tab) ?? 'diagram';
    setTabState((cur) => (cur === fromUrl ? cur : fromUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('tab')]);
  const qc = useQueryClient();
  const { data: process, isLoading, error } = useOp<ProcessFull>('process.get', { id }, { enabled: Boolean(id) });
  const [dirty, setDirty] = useState(false);

  if (isLoading) return <Loading />;
  if (error || !process)
    return (
      <Content>
        <ErrorBox error={error ?? 'Not found'} />
      </Content>
    );

  const setTab = (t: Tab) => {
    if (dirty && !window.confirm('You have unsaved diagram changes. Discard them?')) return;
    setDirty(false);
    setTabState(t);
    setParams(t === 'diagram' ? {} : { tab: t }, { replace: true });
  };

  return (
    <Content flush>
      <ProcessHeader process={process} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ['diagram', 'Diagram'],
          ['details', 'Details'],
          ['steps', `Steps (${process.nodes.filter((n) => n.type !== 'note').length})`],
          ['risks', 'Risks & controls'],
          ['versions', `Versions${process.publishedVersion ? ` (${process.publishedVersion})` : ''}`],
          ['comments', 'Comments'],
          ['activity', 'Activity'],
        ]}
      />
      {tab === 'diagram' ? (
        <DiagramTab process={process} onSaved={(p) => qc.setQueryData(['process.get', { id }], p)} onDirty={setDirty} />
      ) : (
        <div className="content">
          {tab === 'details' && <DetailsTab process={process} />}
          {tab === 'steps' && <StepsTab process={process} />}
          {tab === 'risks' && <RisksTab process={process} />}
          {tab === 'versions' && <VersionsTab process={process} />}
          {tab === 'comments' && <CommentsTab process={process} />}
          {tab === 'activity' && <ActivityTab process={process} />}
        </div>
      )}
    </Content>
  );
}

function DiagramTab({ process, onSaved, onDirty }: { process: ProcessFull; onSaved: (p: ProcessFull) => void; onDirty: (d: boolean) => void }) {
  const { can } = useAuth();
  const editable = can('process:write') && process.status !== 'archived';
  return (
    <>
      {process.status === 'published' && editable && <div className="alert info small" style={{ borderRadius: 0 }}>This process is published (v{process.publishedVersion}). Saving changes creates a new draft that must be re-approved.</div>}
      {process.status === 'in_review' && editable && <div className="alert warning small" style={{ borderRadius: 0 }}>This process is awaiting review. Editing returns it to draft.</div>}
      <DiagramEditor process={process} editable={editable} onSaved={onSaved} onDirtyChange={onDirty} />
    </>
  );
}

function ProcessHeader({ process }: { process: ProcessFull }) {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const [modal, setModal] = useState<null | 'publish' | 'reject' | 'submit' | 'duplicate'>(null);
  const [note, setNote] = useState('');
  const settings = useOp<{ allowSelfApproval: boolean; requireReview: boolean }>('settings.get', {});
  const close = () => {
    setModal(null);
    setNote('');
  };
  const submit = useAction('process.submitForReview', { toast: 'Submitted for review', onSuccess: close });
  const publish = useAction('process.publish', { toast: 'Published', onSuccess: close });
  const reject = useAction('process.requestChanges', { toast: 'Returned to draft', onSuccess: close });
  const archive = useAction('process.archive', { toast: 'Archived' });
  const restore = useAction('process.restore', { toast: 'Restored to draft' });
  const certify = useAction('process.certify', { toast: 'Review recorded' });
  const duplicate = useAction<ProcessFull>('process.duplicate', { toast: 'Copy created', onSuccess: (p) => navigate(`/processes/${p.id}`) });
  const del = useAction('process.delete', { toast: 'Deleted', onSuccess: () => navigate('/processes') });
  const selfApproval = process.submittedBy === user?.id && !settings.data?.allowSelfApproval;
  const canPublishNow = process.status === 'in_review' || (process.status === 'draft' && settings.data?.requireReview === false);

  return (
    <div style={{ padding: '16px 24px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="row small muted" style={{ gap: 6 }}>
            <Link to="/processes">Processes</Link> / <span>{process.ref}</span>
            {process.category && <span>· {process.category}</span>}
          </div>
          <div className="row wrap" style={{ marginTop: 4 }}>
            <h1>{process.name}</h1>
            <StatusBadge status={process.status} />
            {process.publishedVersion && <span className="badge">v{process.publishedVersion}</span>}
          </div>
          {process.summary && <div className="muted" style={{ marginTop: 4, maxWidth: 900 }}>{process.summary}</div>}
          <div className="row wrap small" style={{ marginTop: 8, gap: 14 }}>
            <span className="row" style={{ gap: 6 }}>
              <span className="muted">Owner team</span> <TeamChip team={process.ownerTeam} />
            </span>
            {process.ownerUser && (
              <span>
                <span className="muted">Process owner</span> {process.ownerUser.name}
              </span>
            )}
            {process.nextReviewAt && (
              <span>
                <span className="muted">Next review</span> {fmtDate(process.nextReviewAt)}
              </span>
            )}
            {process.tags.map((t) => (
              <Link key={t.id} to={`/processes?tag=${encodeURIComponent(t.name)}`} className="tag" style={{ color: 'inherit' }}>
                <span className="dot" style={{ background: t.color }} />
                {t.name}
              </Link>
            ))}
          </div>
        </div>
        <div className="row wrap">
          {process.status === 'draft' && can('process:write') && (
            <button className="btn primary" onClick={() => setModal('submit')}>
              Submit for review
            </button>
          )}
          {canPublishNow && can('process:publish') && (
            <button className="btn primary" disabled={selfApproval && process.status === 'in_review'} title={selfApproval ? 'Segregation of duties: someone else must approve your submission' : undefined} onClick={() => setModal('publish')}>
              Approve &amp; publish
            </button>
          )}
          {process.status === 'in_review' && can('process:publish') && (
            <button className="btn" onClick={() => setModal('reject')}>
              Request changes
            </button>
          )}
          {process.status === 'published' && can('process:publish') && (
            <button className="btn" onClick={() => certify.mutate({ id: process.id })} title="Confirm the published process is still accurate">
              Certify review
            </button>
          )}
          <ExportMenu process={process} />
          {can('process:write') && (
            <button className="btn" onClick={() => duplicate.mutate({ id: process.id })}>
              Duplicate
            </button>
          )}
          {can('process:publish') &&
            (process.status === 'archived' ? (
              <button className="btn" onClick={() => restore.mutate({ id: process.id })}>
                Restore
              </button>
            ) : (
              <Confirm className="btn" label="Archive" message="Archive this process? It will be hidden from lists and become read-only." onConfirm={() => archive.mutate({ id: process.id })} />
            ))}
          {can('process:delete') && <Confirm className="btn danger" label="Delete" message={`Permanently delete ${process.ref} and all its versions? This cannot be undone.`} onConfirm={() => del.mutate({ id: process.id })} />}
        </div>
      </div>
      {modal && (
        <Modal
          title={modal === 'publish' ? 'Approve and publish' : modal === 'reject' ? 'Request changes' : 'Submit for review'}
          onClose={close}
          footer={
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={(modal === 'reject' && !note.trim()) || submit.isPending || publish.isPending || reject.isPending}
                onClick={() =>
                  modal === 'publish'
                    ? publish.mutate({ id: process.id, changeNote: note })
                    : modal === 'reject'
                      ? reject.mutate({ id: process.id, reason: note })
                      : submit.mutate({ id: process.id, note: note || undefined })
                }
              >
                {modal === 'publish' ? `Publish v${(process.publishedVersion ?? 0) + 1}` : modal === 'reject' ? 'Return to draft' : 'Submit'}
              </button>
            </>
          }
        >
          <Field label={modal === 'publish' ? 'Change note' : modal === 'reject' ? 'What needs to change?' : 'Note for reviewers (optional)'}>
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
          {modal === 'publish' && <p className="muted small" style={{ margin: 0 }}>A frozen, numbered version is created and the next periodic review is scheduled{process.reviewIntervalDays ? ` in ${process.reviewIntervalDays} days` : ''}.</p>}
        </Modal>
      )}
    </div>
  );
}

function ExportMenu({ process }: { process: ProcessFull }) {
  const [open, setOpen] = useState(false);
  const run = async (format: string) => {
    setOpen(false);
    await download('process.export', { id: process.id, format });
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <IconDownload /> Export
      </button>
      {open && (
        <div className="ms-menu" style={{ left: 'auto', right: 0, width: 240 }} role="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => void run('bpmn')}>BPMN 2.0 XML (.bpmn)</button>
          <button onClick={() => void run('markdown')}>Procedure document (.md)</button>
          <button onClick={() => void run('mermaid')}>Mermaid flowchart (.mmd)</button>
          <button onClick={() => void run('json')}>Streamline JSON (.json)</button>
          <button onClick={() => { setOpen(false); window.print(); }}>Print / PDF</button>
        </div>
      )}
    </div>
  );
}

function DetailsTab({ process }: { process: ProcessFull }) {
  const { can } = useAuth();
  const catalog = useCatalog();
  const editable = can('process:write') && process.status !== 'archived';
  const initial = useMemo(
    () => ({
      name: process.name,
      summary: process.summary,
      description: process.description,
      category: process.category ?? '',
      ownerTeamId: process.ownerTeam?.id ?? '',
      ownerUserId: process.ownerUser?.id ?? '',
      tags: process.tags.map((t) => t.name),
      reviewIntervalDays: process.reviewIntervalDays ?? 0,
    }),
    [process],
  );
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const save = useAction('process.update', { toast: 'Details saved' });
  const changed = JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', alignItems: 'start' }}>
      <div className="card">
        <div className="card-body stack">
          <Field label="Name">
            <input disabled={!editable} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Summary">
            <textarea disabled={!editable} rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          </Field>
          <Field label="Description" hint="Scope, triggers, inputs/outputs, policy references, definitions.">
            <textarea disabled={!editable} rows={10} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="grid grid-2">
            <Field label="Owning team">
              <select disabled={!editable} value={form.ownerTeamId} onChange={(e) => setForm({ ...form, ownerTeamId: e.target.value })}>
                <option value="">— None —</option>
                {catalog.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Process owner">
              <select disabled={!editable} value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}>
                <option value="">— None —</option>
                {catalog.userOptions.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <input disabled={!editable} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </Field>
            <Field label="Review interval (days)" hint="0 = no periodic review">
              <input disabled={!editable} type="number" min={0} value={form.reviewIntervalDays} onChange={(e) => setForm({ ...form, reviewIntervalDays: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Tags">
            {editable ? <TagInput value={form.tags} onChange={(tags) => setForm({ ...form, tags })} suggestions={catalog.tags.map((t) => t.name)} /> : <div>{form.tags.join(', ') || '—'}</div>}
          </Field>
          {editable && (
            <div className="row">
              <button
                className="btn primary"
                disabled={!changed || !form.name.trim() || save.isPending}
                onClick={() =>
                  save.mutate({
                    id: process.id,
                    expectedRevision: process.revision,
                    ...form,
                    category: form.category || null,
                    ownerTeamId: form.ownerTeamId || null,
                    ownerUserId: form.ownerUserId || null,
                    reviewIntervalDays: form.reviewIntervalDays || null,
                  })
                }
              >
                Save details
              </button>
              {changed && (
                <button className="btn ghost" onClick={() => setForm(initial)}>
                  Discard
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <h2>Record</h2>
        </div>
        <div className="card-body">
          <dl className="kv small">
            <dt>Reference</dt>
            <dd>{process.ref}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={process.status} />
            </dd>
            <dt>Published version</dt>
            <dd>{process.publishedVersion ?? '—'}</dd>
            <dt>Working revision</dt>
            <dd>{process.revision}</dd>
            <dt>Next review</dt>
            <dd>{fmtDate(process.nextReviewAt)}</dd>
            <dt>Created</dt>
            <dd>{fmtDate(process.createdAt, true)}</dd>
            <dt>Last updated</dt>
            <dd>
              {fmtDate(process.updatedAt, true)}
              {process.updatedBy && <div className="muted">{process.updatedBy.name}</div>}
            </dd>
            <dt>Id</dt>
            <dd>
              <code className="small">{process.id}</code>
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

/** Steps in flow order (breadth-first from start). */
function ordered(process: ProcessFull): StepNode[] {
  const out = new Map<string, string[]>();
  for (const e of process.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const incoming = new Set(process.edges.map((e) => e.target));
  const byX = [...process.nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const queue = byX.filter((n) => n.type === 'start' || !incoming.has(n.id)).map((n) => n.id);
  const seen = new Set<string>();
  const res: StepNode[] = [];
  const map = new Map(process.nodes.map((n) => [n.id, n]));
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    res.push(map.get(id)!);
    queue.push(...(out.get(id) ?? []));
  }
  for (const n of byX) if (!seen.has(n.id)) res.push(n);
  return res.filter((n) => n.type !== 'note');
}

function StepsTab({ process }: { process: ProcessFull }) {
  const catalog = useCatalog();
  const steps = ordered(process);
  const sysName = new Map(catalog.systems.map((s) => [s.id, s.name]));
  const total = steps.reduce((a, s) => a + (s.durationMinutes ?? 0), 0);
  const label = new Map(process.nodes.map((n) => [n.id, n.label]));
  return (
    <div className="card">
      <div className="card-header">
        <h2>Step-by-step</h2>
        <span className="muted small">Total effort {total ? `${Math.round(total / 6) / 10} h` : '—'}</span>
      </div>
      {!steps.length ? (
        <Empty title="No steps yet" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Step</th>
                <th>Team / role</th>
                <th>Systems</th>
                <th>Next</th>
                <th>Effort</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={s.id}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <strong>{s.label}</strong> <span className="muted small">{s.type !== 'task' ? `(${s.type})` : ''}</span>
                    {s.description && <div className="muted small pre-wrap">{s.description}</div>}
                  </td>
                  <td>
                    <TeamChip team={s.teamId ? catalog.teamMap.get(s.teamId) : null} />
                    {s.actorRole && <div className="muted small">{s.actorRole}</div>}
                  </td>
                  <td className="small">{s.systemIds.map((id) => sysName.get(id)).join(', ') || '—'}</td>
                  <td className="small">
                    {process.edges
                      .filter((e) => e.source === s.id)
                      .map((e) => (
                        <div key={e.id}>
                          {e.label ? <strong>{e.label}: </strong> : null}→ {label.get(e.target)}
                        </div>
                      ))}
                  </td>
                  <td className="nowrap">{s.durationMinutes ? `${s.durationMinutes} min` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RisksTab({ process }: { process: ProcessFull }) {
  const catalog = useCatalog();
  const riskMap = new Map(catalog.risks.map((r) => [r.id, r]));
  const controlMap = new Map(catalog.controls.map((c) => [c.id, c]));
  const controlsInProcess = new Set(process.nodes.flatMap((n) => n.controlIds));
  const riskIds = [...new Set(process.nodes.flatMap((n) => n.riskIds))];
  const rows = riskIds.map((id) => riskMap.get(id)).filter(Boolean);
  return (
    <div className="stack">
      <div className="card">
        <div className="card-header">
          <h2>Risks in this process</h2>
        </div>
        {!rows.length ? (
          <Empty title="No risks identified">Attach risks to steps in the diagram inspector.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Risk</th>
                  <th>Rating</th>
                  <th>Occurs at</th>
                  <th>Mitigating controls</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const covered = r!.controlIds.some((c) => controlsInProcess.has(c));
                  return (
                    <tr key={r!.id}>
                      <td>
                        <Link to={`/risks/${r!.id}`}>
                          {r!.ref} {r!.title}
                        </Link>
                      </td>
                      <td>
                        <RatingBadge rating={r!.rating} />
                      </td>
                      <td className="small">
                        {process.nodes
                          .filter((n) => n.riskIds.includes(r!.id))
                          .map((n) => n.label)
                          .join(', ')}
                      </td>
                      <td className="small">
                        {r!.controls.map((c) => (
                          <div key={c.id} className="row" style={{ gap: 6 }}>
                            <Link to={`/controls/${c.id}`}>{c.name}</Link>
                            {controlsInProcess.has(c.id) ? <span className="badge green">in process</span> : <span className="badge">elsewhere</span>}
                          </div>
                        ))}
                        {!r!.controls.length && <span className="muted">None defined</span>}
                      </td>
                      <td>{covered ? <span className="badge green">Controlled</span> : <span className="badge red">Gap</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-header">
          <h2>Controls performed in this process</h2>
        </div>
        {!controlsInProcess.size ? (
          <Empty title="No controls attached" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Control</th>
                  <th>Type</th>
                  <th>Performed at</th>
                  <th>Effectiveness</th>
                </tr>
              </thead>
              <tbody>
                {[...controlsInProcess].map((id) => {
                  const c = controlMap.get(id);
                  if (!c) return null;
                  return (
                    <tr key={id}>
                      <td>
                        <Link to={`/controls/${id}`}>
                          {c.ref} {c.name}
                        </Link>
                      </td>
                      <td className="small">
                        {c.controlType} · {c.nature.replace('_', '-')}
                        {c.frequency && <div className="muted">{c.frequency}</div>}
                      </td>
                      <td className="small">
                        {process.nodes
                          .filter((n) => n.controlIds.includes(id))
                          .map((n) => n.label)
                          .join(', ')}
                      </td>
                      <td>
                        <EffectivenessBadge value={c.effectiveness} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface Version {
  version: number;
  changeNote: string;
  publishedAt: string;
  publishedBy: string | null;
}
interface Diff {
  metadataChanged: string[];
  added: Array<{ label: string }>;
  removed: Array<{ label: string }>;
  changed: Array<{ label: string; previousLabel: string }>;
  edgesAdded: string[];
  edgesRemoved: string[];
}

function VersionsTab({ process }: { process: ProcessFull }) {
  const { can } = useAuth();
  const { data, isLoading } = useOp<Version[]>('process.versions', { id: process.id });
  const [view, setView] = useState<{ version: number; text: string } | null>(null);
  const [diff, setDiff] = useState<{ version: number; diff: Diff } | null>(null);
  const revert = useAction('process.revert', { toast: 'Working copy restored' });
  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty title="Not published yet">Versions are created each time the process is approved and published.</Empty>;
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>By</th>
              <th>Change note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((v) => (
              <tr key={v.version}>
                <td>
                  <strong>v{v.version}</strong> {v.version === process.publishedVersion && <span className="badge green">current</span>}
                </td>
                <td className="nowrap">{fmtDate(v.publishedAt, true)}</td>
                <td>{v.publishedBy ?? '—'}</td>
                <td className="pre-wrap">{v.changeNote || <span className="muted">—</span>}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={async () => setView({ version: v.version, text: await fetchText('process.export', { id: process.id, format: 'markdown', version: v.version }) })}>
                      View
                    </button>
                    <button className="btn sm" onClick={async () => setDiff({ version: v.version, diff: await call<Diff>('process.compare', { id: process.id, from: v.version }) })}>
                      Compare to current
                    </button>
                    <button className="btn sm" onClick={() => void download('process.export', { id: process.id, format: 'bpmn', version: v.version })}>
                      BPMN
                    </button>
                    {can('process:write') && process.status !== 'archived' && (
                      <Confirm className="btn sm" label="Restore" message={`Replace the current working copy with v${v.version}? The process will become a draft.`} onConfirm={() => revert.mutate({ id: process.id, version: v.version })} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view && (
        <Modal title={`${process.ref} v${view.version}`} onClose={() => setView(null)} wide>
          <pre>{view.text}</pre>
        </Modal>
      )}
      {diff && (
        <Modal title={`Changes since v${diff.version}`} onClose={() => setDiff(null)} wide>
          <DiffView diff={diff.diff} />
        </Modal>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: Diff }) {
  const none = !diff.metadataChanged.length && !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.edgesAdded.length && !diff.edgesRemoved.length;
  if (none) return <div className="alert info">No differences.</div>;
  const section = (title: string, items: string[], cls: string) =>
    items.length ? (
      <div>
        <h3 style={{ marginBottom: 6 }}>{title}</h3>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {items.map((i) => (
            <li key={i} className={cls}>
              {i}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="stack">
      {section('Details changed', diff.metadataChanged, '')}
      {section('Steps added', diff.added.map((a) => a.label), '')}
      {section('Steps removed', diff.removed.map((a) => a.label), '')}
      {section('Steps changed', diff.changed.map((c) => (c.previousLabel !== c.label ? `${c.previousLabel} → ${c.label}` : c.label)), '')}
      {section('Flows added', diff.edgesAdded, '')}
      {section('Flows removed', diff.edgesRemoved, '')}
    </div>
  );
}

interface Comment {
  id: string;
  nodeId: string | null;
  nodeLabel: string | null;
  body: string;
  resolved: boolean;
  author: { id: string; name: string } | null;
  createdAt: string;
}

function CommentsTab({ process }: { process: ProcessFull }) {
  const { can, user } = useAuth();
  const { data, isLoading } = useOp<Comment[]>('comment.list', { processId: process.id, includeResolved: true });
  const [body, setBody] = useState('');
  const [nodeId, setNodeId] = useState('');
  const add = useAction('comment.create', { toast: 'Comment added', onSuccess: () => setBody('') });
  const resolve = useAction('comment.resolve', { toast: false });
  const del = useAction('comment.delete', { toast: 'Deleted' });
  if (isLoading) return <Loading />;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      {can('comment:write') && (
        <div className="card">
          <div className="card-body stack">
            <textarea rows={3} placeholder="Ask a question, suggest an improvement, record a decision…" value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="row">
              <select style={{ maxWidth: 300 }} value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="About step">
                <option value="">About the whole process</option>
                {process.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    Step: {n.label}
                  </option>
                ))}
              </select>
              <span className="spacer" />
              <button className="btn primary" disabled={!body.trim() || add.isPending} onClick={() => add.mutate({ processId: process.id, nodeId: nodeId || null, body })}>
                Comment
              </button>
            </div>
          </div>
        </div>
      )}
      {!data?.length && <Empty title="No comments yet" />}
      {data?.map((c) => (
        <div key={c.id} className="card" style={{ opacity: c.resolved ? 0.6 : 1 }}>
          <div className="card-body stack" style={{ gap: 6 }}>
            <div className="row small">
              <strong>{c.author?.name ?? 'Unknown'}</strong>
              <span className="muted">{timeAgo(c.createdAt)}</span>
              {c.nodeLabel && <span className="badge blue">{c.nodeLabel}</span>}
              {c.resolved && <span className="badge green">Resolved</span>}
              <span className="spacer" />
              {can('comment:write') && (
                <button className="btn ghost sm" onClick={() => resolve.mutate({ id: c.id, resolved: !c.resolved })}>
                  {c.resolved ? 'Re-open' : 'Resolve'}
                </button>
              )}
              {(c.author?.id === user?.id || can('admin:users')) && <Confirm className="btn ghost sm" label="Delete" message="Delete this comment?" onConfirm={() => del.mutate({ id: c.id })} />}
            </div>
            <div className="pre-wrap">{c.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const OP_LABEL: Record<string, string> = {
  'process.create': 'created the process',
  'process.update': 'edited details',
  'process.saveDiagram': 'edited the diagram',
  'process.submitForReview': 'submitted for review',
  'process.publish': 'approved and published',
  'process.requestChanges': 'requested changes',
  'process.archive': 'archived',
  'process.restore': 'restored',
  'process.certify': 'certified periodic review',
  'process.revert': 'restored an earlier version',
  'process.import': 'imported',
  'process.duplicate': 'created as a copy',
  'node.create': 'added a step',
  'node.update': 'edited a step',
  'node.delete': 'removed a step',
  'edge.create': 'connected steps',
  'edge.update': 'relabelled a connection',
  'edge.delete': 'removed a connection',
  'comment.create': 'commented',
  'comment.resolve': 'resolved a comment',
  'comment.delete': 'deleted a comment',
};

function ActivityTab({ process }: { process: ProcessFull }) {
  const { data, isLoading, error } = useOp<Array<{ at: string; actor: string; channel: string; operation: string }>>('process.activity', { id: process.id, limit: 100 });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error instanceof ApiError ? error : String(error)} />;
  return (
    <div className="card" style={{ maxWidth: 820 }}>
      <ul className="list-plain" style={{ padding: '0 16px' }}>
        {data?.map((a, i) => (
          <li key={i} className="row">
            <strong>{a.actor === 'system' ? 'System' : a.actor}</strong>
            <span>{OP_LABEL[a.operation] ?? a.operation}</span>
            <span className={`badge ${a.channel === 'mcp' ? 'purple' : a.channel === 'api' ? 'blue' : ''}`} title="Access path">
              {a.channel === 'mcp' ? 'AI / MCP' : a.channel.toUpperCase()}
            </span>
            <span className="spacer" />
            <span className="muted small nowrap">{fmtDate(a.at, true)}</span>
          </li>
        ))}
        {!data?.length && <li className="muted">No activity recorded.</li>}
      </ul>
    </div>
  );
}

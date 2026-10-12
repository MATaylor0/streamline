import { memo, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Content } from '../components/Layout';
import { ErrorBox, Loading, TeamChip } from '../components/ui';
import { ArcEdge, CenterHandles, circleLayout, type ArcData } from '../components/GraphParts';
import { useOp } from '../hooks';
import { useCatalog } from '../catalog';
import { downloadCsv } from '../api';
import { IconDownload } from '../components/icons';

interface TeamStat {
  id: string;
  name: string;
  department: string | null;
  color: string;
  stepCount: number;
  processCount: number;
  ownedProcessCount: number;
  systemCount: number;
  outgoingHandoffs: number;
  incomingHandoffs: number;
  /** Set for AI agent participants (id is "agent:<agentId>"). */
  agentId?: string;
}
interface AgentStat {
  id: string;
  agentId: string;
  name: string;
  status: string;
  riskTier: string;
  stepCount: number;
  processCount: number;
  outgoingHandoffs: number;
  incomingHandoffs: number;
}
interface Link_ {
  source: string;
  target: string;
  count: number;
  processes: Array<{ id: string; ref: string; name: string; handoffs: Array<{ from: string; to: string }> }>;
}
interface Graph {
  teams: TeamStat[];
  agents: AgentStat[];
  links: Link_[];
  processCount: number;
  unassignedStepCount: number;
}

type TeamNodeData = { team: TeamStat; dim: boolean; scale: number };

const TeamNode = memo(({ data, selected }: NodeProps<Node<TeamNodeData>>) => (
  <div
    className={`team-node ${data.team.agentId ? 'agent-node' : ''}`}
    style={{
      borderColor: data.team.color,
      opacity: data.dim ? 0.3 : 1,
      transform: `scale(${data.scale})`,
      boxShadow: selected ? `0 0 0 4px color-mix(in srgb, ${data.team.color} 35%, transparent)` : undefined,
    }}
  >
    <CenterHandles />
    <div className="tn-name">
      {data.team.agentId ? '🤖 ' : ''}
      {data.team.name}
    </div>
    <div className="tn-meta">
      {data.team.stepCount} steps · {data.team.processCount} processes
    </div>
    {data.team.department && <div className="tn-meta">{data.team.department}</div>}
  </div>
));

const nodeTypes = { team: TeamNode };
const edgeTypes = { arc: ArcEdge };

type LayoutKind = 'circle' | 'flow' | 'department';

function positions(teams: TeamStat[], links: Link_[], kind: LayoutKind) {
  if (kind === 'circle') return circleLayout(teams);
  if (kind === 'department') {
    const depts = [...new Set(teams.map((t) => t.department ?? 'Other'))].sort();
    const out = new Map<string, { x: number; y: number }>();
    depts.forEach((d, col) => teams.filter((t) => (t.department ?? 'Other') === d).forEach((t, row) => out.set(t.id, { x: col * 280, y: row * 130 })));
    return out;
  }
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 140 });
  g.setDefaultEdgeLabel(() => ({}));
  teams.forEach((t) => g.setNode(t.id, { width: 180, height: 64 }));
  links.forEach((l) => g.setEdge(l.source, l.target, { weight: l.count }));
  dagre.layout(g);
  return new Map(teams.map((t) => [t.id, { x: g.node(t.id).x, y: g.node(t.id).y }]));
}

export function TeamMapPage() {
  return (
    <Content flush>
      <ReactFlowProvider>
        <TeamMap />
      </ReactFlowProvider>
    </Content>
  );
}

function TeamMap() {
  const catalog = useCatalog();
  const [scope, setScope] = useState<'active' | 'published'>('active');
  const [tag, setTag] = useState('');
  const [layoutKind, setLayoutKind] = useState<LayoutKind>('circle');
  const [hideIdle, setHideIdle] = useState(true);
  const [showAgents, setShowAgents] = useState(false);
  const [selected, setSelected] = useState<{ kind: 'team' | 'link'; id: string } | null>(null);
  const rf = useReactFlow();
  const { data, isLoading, error } = useOp<Graph>('analytics.teamInteractions', { statuses: scope === 'published' ? 'published' : undefined, tag: tag || undefined, includeAgents: showAgents || undefined });

  const teams = useMemo<TeamStat[]>(
    () => [
      ...(data?.teams ?? []).filter((t) => !hideIdle || t.stepCount > 0 || t.ownedProcessCount > 0),
      // AI agents that perform steps appear as participants alongside teams.
      ...(data?.agents ?? []).map((a) => ({ ...a, department: 'AI agent', color: '#7c3aed', ownedProcessCount: 0, systemCount: 0 })),
    ],
    [data, hideIdle],
  );
  const links = useMemo(() => (data?.links ?? []).filter((l) => teams.some((t) => t.id === l.source) && teams.some((t) => t.id === l.target)), [data, teams]);
  const maxCount = Math.max(1, ...links.map((l) => l.count));
  const maxSteps = Math.max(1, ...teams.map((t) => t.stepCount));

  const focusTeam = selected?.kind === 'team' ? selected.id : null;
  const focusLink = selected?.kind === 'link' ? links.find((l) => `${l.source}>${l.target}` === selected.id) : undefined;
  const related = (teamId: string) => !focusTeam || teamId === focusTeam || links.some((l) => (l.source === focusTeam && l.target === teamId) || (l.target === focusTeam && l.source === teamId));

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TeamNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<ArcData>>([]);

  useEffect(() => {
    const pos = positions(teams, links, layoutKind);
    setNodes(
      teams.map((t) => ({
        id: t.id,
        type: 'team',
        position: { x: (pos.get(t.id)?.x ?? 0) - 90, y: (pos.get(t.id)?.y ?? 0) - 32 },
        data: { team: t, dim: false, scale: 0.9 + 0.35 * (t.stepCount / maxSteps) },
      })),
    );
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 250, maxZoom: 1.1 }), 30);
  }, [teams, links, layoutKind, maxSteps, setNodes, rf]);

  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, dim: !related(n.id) } })));
    setEdges(
      links.map((l) => {
        const team = catalog.teamMap.get(l.source) ?? (l.source.startsWith('agent:') ? { color: '#7c3aed' } : undefined);
        const dim = Boolean(focusTeam && l.source !== focusTeam && l.target !== focusTeam);
        return {
          id: `${l.source}>${l.target}`,
          source: l.source,
          target: l.target,
          type: 'arc',
          selected: selected?.kind === 'link' && selected.id === `${l.source}>${l.target}`,
          markerEnd: { type: MarkerType.ArrowClosed, color: team?.color ?? '#94a3b8', width: 16, height: 16 },
          data: { count: l.count, width: 1.5 + 6 * (l.count / maxCount), color: team?.color, dim },
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, focusTeam, selected, catalog.teamMap, maxCount, setEdges, setNodes]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const selTeam = focusTeam ? teamById.get(focusTeam) : undefined;

  return (
    <>
      <div className="row wrap" style={{ padding: '12px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div>
          <h1 style={{ fontSize: 18 }}>Team interaction map</h1>
          <div className="muted small">
            How work is handed between teams across {data?.processCount} processes. Arrow thickness = number of handoffs.
          </div>
        </div>
        <span className="spacer" />
        <select style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value as 'active' | 'published')} aria-label="Scope">
          <option value="active">All active processes</option>
          <option value="published">Published only</option>
        </select>
        <select style={{ width: 'auto' }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">Any tag</option>
          {catalog.tags.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <select style={{ width: 'auto' }} value={layoutKind} onChange={(e) => setLayoutKind(e.target.value as LayoutKind)} aria-label="Layout">
          <option value="circle">Circle layout</option>
          <option value="flow">Flow layout</option>
          <option value="department">Group by department</option>
        </select>
        <label className="check small">
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} /> Hide uninvolved teams
        </label>
        <label className="check small" title="Steps performed by AI (supervised or autonomous) are shown as handoffs to and from the agent">
          <input type="checkbox" checked={showAgents} onChange={(e) => setShowAgents(e.target.checked)} /> Show AI agents
        </label>
        <button
          className="btn sm"
          onClick={() =>
            downloadCsv(
              'team-handoffs.csv',
              links.map((l) => ({ from: teamById.get(l.source)?.name, to: teamById.get(l.target)?.name, handoffs: l.count, processes: l.processes.map((p) => `${p.ref} ${p.name}`) })),
            )
          }
        >
          <IconDownload /> CSV
        </button>
      </div>
      <div className="split">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => setSelected({ kind: 'team', id: n.id })}
            onEdgeClick={(_, e) => setSelected({ kind: 'link', id: e.id })}
            onPaneClick={() => setSelected(null)}
            nodesConnectable={false}
            fitView
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="side-panel stack">
          {selTeam ? (
            <>
              <div className="row">
                <TeamChip team={selTeam} />
                <span className="spacer" />
                <Link to={selTeam.agentId ? `/agents/${selTeam.agentId}` : `/teams/${selTeam.id}`} className="small">
                  {selTeam.agentId ? 'Agent page →' : 'Team page →'}
                </Link>
              </div>
              <dl className="kv small">
                <dt>Steps performed</dt>
                <dd>{selTeam.stepCount}</dd>
                <dt>Processes involved</dt>
                <dd>{selTeam.processCount}</dd>
                {!selTeam.agentId && (
                  <>
                    <dt>Processes owned</dt>
                    <dd>{selTeam.ownedProcessCount}</dd>
                    <dt>Systems used</dt>
                    <dd>{selTeam.systemCount}</dd>
                  </>
                )}
                <dt>Hands work to</dt>
                <dd>{selTeam.outgoingHandoffs} times</dd>
                <dt>Receives work</dt>
                <dd>{selTeam.incomingHandoffs} times</dd>
              </dl>
              <h3>Handoffs</h3>
              <ul className="list-plain small">
                {links
                  .filter((l) => l.source === selTeam.id || l.target === selTeam.id)
                  .map((l) => (
                    <li key={`${l.source}>${l.target}`}>
                      <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setSelected({ kind: 'link', id: `${l.source}>${l.target}` })}>
                        {l.source === selTeam.id ? '→' : '←'} {teamById.get(l.source === selTeam.id ? l.target : l.source)?.name}
                        <span className="spacer" />
                        <span className="badge">{l.count}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          ) : focusLink ? (
            <>
              <h2>
                {teamById.get(focusLink.source)?.name} → {teamById.get(focusLink.target)?.name}
              </h2>
              <div className="muted small">
                {focusLink.count} handoff{focusLink.count === 1 ? '' : 's'} across {focusLink.processes.length} process{focusLink.processes.length === 1 ? '' : 'es'}
              </div>
              {focusLink.processes.map((p) => (
                <div key={p.id} className="card">
                  <div className="card-body" style={{ padding: 12 }}>
                    <Link to={`/processes/${p.id}`} style={{ fontWeight: 600 }}>
                      {p.ref} {p.name}
                    </Link>
                    <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {p.handoffs.map((h, i) => (
                        <li key={i}>
                          {h.from} → {h.to}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              <h2>Overview</h2>
              <p className="muted small" style={{ margin: 0 }}>
                Click a team to see who it works with, or an arrow to see exactly which process steps create the handoff. Handoffs are derived automatically from every process diagram whenever a step owned by one team flows into a step owned by another.
              </p>
              <h3>Busiest handoffs</h3>
              <ul className="list-plain small">
                {links.slice(0, 12).map((l) => (
                  <li key={`${l.source}>${l.target}`}>
                    <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setSelected({ kind: 'link', id: `${l.source}>${l.target}` })}>
                      {teamById.get(l.source)?.name} → {teamById.get(l.target)?.name}
                      <span className="spacer" />
                      <span className="badge">{l.count}</span>
                    </button>
                  </li>
                ))}
                {!links.length && <li className="muted">No cross-team handoffs yet. Assign teams to process steps to populate this map.</li>}
              </ul>
              {data!.unassignedStepCount > 0 && <div className="alert warning small">{data!.unassignedStepCount} step(s) have no responsible team and are not shown.</div>}
            </>
          )}
        </aside>
      </div>
    </>
  );
}

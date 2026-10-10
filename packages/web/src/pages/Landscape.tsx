import { memo, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Content } from '../components/Layout';
import { ErrorBox, Loading, StatusBadge } from '../components/ui';
import { ArcEdge, CenterHandles, type ArcData } from '../components/GraphParts';
import { useOp } from '../hooks';

interface LProcess {
  id: string;
  ref: string;
  name: string;
  status: string;
  category: string | null;
  ownerTeam: { id: string; name: string; color: string } | null;
  teamIds: string[];
}
interface Landscape {
  processes: LProcess[];
  links: Array<{ source: string; target: string; via: string }>;
}

type PData = { p: LProcess };
type GroupData = { title: string; color: string; width: number; height: number };

const ProcNode = memo(({ data, selected }: NodeProps<Node<PData>>) => (
  <div className="pnode" style={{ minWidth: 200, cursor: 'pointer', borderColor: selected ? 'var(--primary)' : undefined }}>
    <CenterHandles />
    {data.p.ownerTeam && <span className="lane-stripe" style={{ background: data.p.ownerTeam.color }} />}
    <div className="muted small">{data.p.ref}</div>
    <div className="pn-label">{data.p.name}</div>
    <div className="pn-meta">
      <StatusBadge status={data.p.status} /> <span>{data.p.teamIds.length} teams</span>
    </div>
  </div>
));

const GroupNode = memo(({ data }: NodeProps<Node<GroupData>>) => (
  <div style={{ width: data.width, height: data.height, borderRadius: 12, border: '1px dashed var(--border-strong)', background: `color-mix(in srgb, ${data.color} 5%, transparent)` }}>
    <div style={{ padding: '8px 12px', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: data.color }}>{data.title}</div>
  </div>
));

const nodeTypes = { proc: ProcNode, area: GroupNode };
const edgeTypes = { arc: ArcEdge };

export function LandscapePage() {
  return (
    <Content flush>
      <ReactFlowProvider>
        <LandscapeView />
      </ReactFlowProvider>
    </Content>
  );
}

function LandscapeView() {
  const navigate = useNavigate();
  const rf = useReactFlow();
  const [groupBy, setGroupBy] = useState<'team' | 'category'>('category');
  const { data, isLoading, error } = useOp<Landscape>('analytics.processLandscape', {});
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<ArcData>>([]);

  const groups = useMemo(() => {
    const m = new Map<string, { title: string; color: string; items: LProcess[] }>();
    for (const p of data?.processes ?? []) {
      const key = groupBy === 'team' ? (p.ownerTeam?.id ?? '-') : (p.category?.split('/')[0].trim() ?? 'Uncategorised');
      const title = groupBy === 'team' ? (p.ownerTeam?.name ?? 'No owner') : key;
      const color = groupBy === 'team' ? (p.ownerTeam?.color ?? '#94a3b8') : '#64748b';
      const g = m.get(key) ?? { title, color, items: [] };
      g.items.push(p);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [data, groupBy]);

  useEffect(() => {
    const COLW = 260;
    const ROWH = 96;
    const out: Node[] = [];
    let x = 0;
    for (const g of groups) {
      const height = 50 + g.items.length * ROWH;
      out.push({ id: `g:${g.title}`, type: 'area', position: { x, y: 0 }, data: { title: g.title, color: g.color, width: COLW - 20, height }, draggable: false, selectable: false, zIndex: -1 });
      g.items.forEach((p, i) => out.push({ id: p.id, type: 'proc', position: { x: x + 10, y: 44 + i * ROWH }, data: { p } }));
      x += COLW + 20;
    }
    setNodes(out);
    setEdges(
      (data?.links ?? []).map((l, i) => ({
        id: `l${i}`,
        source: l.source,
        target: l.target,
        type: 'arc',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--primary)' },
        data: { label: 'calls', color: 'var(--primary)', width: 2 },
      })),
    );
    setTimeout(() => rf.fitView({ padding: 0.1, duration: 250, maxZoom: 1 }), 30);
  }, [groups, data, setNodes, setEdges, rf]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      <div className="row wrap" style={{ padding: '12px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div>
          <h1 style={{ fontSize: 18 }}>Process landscape</h1>
          <div className="muted small">All active processes, grouped, with arrows where one process invokes another as a sub-process.</div>
        </div>
        <span className="spacer" />
        <select style={{ width: 'auto' }} value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'team' | 'category')} aria-label="Group by">
          <option value="category">Group by business area</option>
          <option value="team">Group by owning team</option>
        </select>
      </div>
      <div className="canvas" style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => n.type === 'proc' && navigate(`/processes/${n.id}`)}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </>
  );
}

import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Link } from 'react-router-dom';
import { ApiError, call } from '../api';
import { useCatalog } from '../catalog';
import { useAuth } from '../auth';
import { toastApi, useAction, useOp } from '../hooks';
import type { NodeType, ProcessFull, StepNode } from '../types';
import { Field, MultiSelect, timeAgo } from './ui';
import { IconLanes, IconLayout, IconSave, IconTrash } from './icons';

// ------------------------------------------------------------------ node rendering

type StepData = { step: StepNode; teamName?: string; teamColor?: string; comments?: number; linkedName?: string };
type LaneData = { name: string; color: string; width: number; height: number };
type FlowNode = Node<StepData, 'box' | 'round' | 'diamond'> | Node<LaneData, 'lane'>;

const TYPE_LABEL: Record<NodeType, string> = {
  start: 'Start',
  end: 'End',
  task: 'Task',
  decision: 'Decision',
  subprocess: 'Sub-process',
  event: 'Event',
  document: 'Document',
  system: 'System action',
  note: 'Note',
};

const PALETTE: NodeType[] = ['task', 'decision', 'subprocess', 'start', 'end', 'event', 'document', 'system', 'note'];

const shapeOf = (t: NodeType): 'box' | 'round' | 'diamond' => (t === 'start' || t === 'end' || t === 'event' ? 'round' : t === 'decision' ? 'diamond' : 'box');
const SIZE = { box: [190, 72], round: [56, 56], diamond: [70, 70] } as const;

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
    </>
  );
}

const BoxNode = memo(({ data, selected }: NodeProps<Node<StepData, 'box'>>) => {
  const s = data.step;
  return (
    <div className={`pnode ${s.type} ${selected ? 'selected' : ''}`}>
      {data.teamColor && s.type !== 'note' && <span className="lane-stripe" style={{ background: data.teamColor }} />}
      <Handles />
      <div className="pn-label">{s.label}</div>
      {(data.teamName || s.actorRole || s.type === 'subprocess') && (
        <div className="pn-meta">
          {data.teamName && <span>{data.teamName}</span>}
          {s.actorRole && <span>· {s.actorRole}</span>}
          {s.type === 'subprocess' && <span>↳ {data.linkedName ?? 'not linked'}</span>}
        </div>
      )}
      {(s.systemIds.length > 0 || s.riskIds.length > 0 || s.controlIds.length > 0 || data.comments || s.durationMinutes) && (
        <div className="pn-icons">
          {s.systemIds.length > 0 && <span className="pn-chip" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>{s.systemIds.length} sys</span>}
          {s.riskIds.length > 0 && <span className="pn-chip" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>{s.riskIds.length} risk</span>}
          {s.controlIds.length > 0 && <span className="pn-chip" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>{s.controlIds.length} ctl</span>}
          {s.durationMinutes ? <span className="pn-chip" style={{ background: 'var(--surface-2)', color: 'var(--text-3)' }}>{s.durationMinutes}m</span> : null}
          {data.comments ? <span className="pn-chip" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>💬 {data.comments}</span> : null}
        </div>
      )}
    </div>
  );
});

const RoundNode = memo(({ data, selected }: NodeProps<Node<StepData, 'round'>>) => (
  <div className={`round-node ${data.step.type} ${selected ? 'selected' : ''}`} title={data.step.label}>
    <Handles />
    <span className="round-label">{data.step.label}</span>
  </div>
));

const DiamondNode = memo(({ data, selected }: NodeProps<Node<StepData, 'diamond'>>) => (
  <div className={`diamond-node ${selected ? 'selected' : ''}`} title={data.step.label}>
    <div className="diamond" />
    <Handles />
    <span className="q">?</span>
    <span className="round-label" style={{ top: 72 }}>
      {data.step.label}
    </span>
  </div>
));

const LaneNode = memo(({ data }: NodeProps<Node<LaneData, 'lane'>>) => (
  <div className="lane-bg" style={{ width: data.width, height: data.height, background: `color-mix(in srgb, ${data.color} 6%, transparent)` }}>
    <span className="lane-title" style={{ color: data.color }}>
      {data.name}
    </span>
  </div>
));

const nodeTypes = { box: BoxNode, round: RoundNode, diamond: DiamondNode, lane: LaneNode };

const edgeDefaults = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  style: { strokeWidth: 1.6 },
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
};

// ------------------------------------------------------------------ layout

function layout(nodes: FlowNode[], edges: Edge[], lanes: boolean, teamMap: Map<string, { name: string; color: string }>): FlowNode[] {
  const steps = nodes.filter((n): n is Node<StepData, 'box' | 'round' | 'diamond'> => n.type !== 'lane');
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of steps) {
    const [w, h] = SIZE[n.type as keyof typeof SIZE];
    g.setNode(n.id, { width: w, height: h + (n.type === 'box' ? 0 : 20) });
  }
  for (const e of edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const pos = new Map(steps.map((n) => {
    const p = g.node(n.id);
    const [w, h] = SIZE[n.type as keyof typeof SIZE];
    return [n.id, { x: p.x - w / 2, y: p.y - h / 2 }];
  }));
  if (!lanes) return steps.map((n) => ({ ...n, position: pos.get(n.id)! }));

  // Swimlanes: one row per team, x from the flow ranks. Unassigned gateways follow their predecessor's lane.
  const laneOf = new Map<string, string>();
  const order = [...steps].sort((a, b) => pos.get(a.id)!.x - pos.get(b.id)!.x);
  for (const n of order) {
    if (n.data.step.teamId) laneOf.set(n.id, n.data.step.teamId);
    else {
      const pred = edges.find((e) => e.target === n.id && laneOf.has(e.source));
      laneOf.set(n.id, pred ? laneOf.get(pred.source)! : '__none');
    }
  }
  const laneIds = [...new Set(order.map((n) => laneOf.get(n.id)!))];
  const LANE_PAD = 40;
  const ROW = 110;
  let top = 0;
  const result: FlowNode[] = [];
  const minX = Math.min(...steps.map((n) => pos.get(n.id)!.x)) - 170;
  const maxX = Math.max(...steps.map((n) => pos.get(n.id)!.x)) + 260;
  for (const lane of laneIds) {
    const members = order.filter((n) => laneOf.get(n.id) === lane);
    // Stack nodes that would overlap horizontally.
    const rows: number[] = [];
    const placed = members.map((n) => {
      const x = pos.get(n.id)!.x;
      let r = rows.findIndex((endX) => x > endX + 20);
      if (r === -1) {
        rows.push(0);
        r = rows.length - 1;
      }
      rows[r] = x + SIZE[n.type as keyof typeof SIZE][0];
      return { n, r };
    });
    const height = Math.max(1, rows.length) * ROW + LANE_PAD;
    for (const { n, r } of placed) {
      const [, h] = SIZE[n.type as keyof typeof SIZE];
      result.push({ ...n, position: { x: pos.get(n.id)!.x, y: top + LANE_PAD / 2 + r * ROW + (ROW - h) / 2 - 10 } });
    }
    const team = teamMap.get(lane);
    result.unshift({
      id: `lane:${lane}`,
      type: 'lane',
      position: { x: minX, y: top },
      data: { name: team?.name ?? 'Unassigned', color: team?.color ?? '#94a3b8', width: maxX - minX, height },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      focusable: false,
      zIndex: -1,
    } as Node<LaneData, 'lane'>);
    top += height;
  }
  return result;
}

// ------------------------------------------------------------------ editor

interface Props {
  process: ProcessFull;
  editable: boolean;
  onSaved: (p: ProcessFull) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function DiagramEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

let tmpSeq = 0;

function Editor({ process, editable, onSaved, onDirtyChange }: Props) {
  const catalog = useCatalog();
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const comments = useOp<Array<{ id: string; nodeId: string | null; resolved: boolean }>>('comment.list', { processId: process.id, includeResolved: false });
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments.data ?? []) if (c.nodeId) m.set(c.nodeId, (m.get(c.nodeId) ?? 0) + 1);
    return m;
  }, [comments.data]);

  const decorate = useCallback(
    (step: StepNode): StepData => {
      const team = step.teamId ? catalog.teamMap.get(step.teamId) : undefined;
      return {
        step,
        teamName: team?.name,
        teamColor: team?.color,
        comments: commentCounts.get(step.id),
        linkedName: step.linkedProcessId ? catalog.processes.find((p) => p.id === step.linkedProcessId)?.name : undefined,
      };
    },
    [catalog.teamMap, catalog.processes, commentCounts],
  );

  const initialNodes = useMemo<FlowNode[]>(
    () => process.nodes.map((s) => ({ id: s.id, type: shapeOf(s.type), position: s.position, data: decorate(s) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [process],
  );
  const initialEdges = useMemo<Edge[]>(() => process.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ?? undefined, ...edgeDefaults })), [process]);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);
  const [dirty, setDirtyState] = useState(false);
  const [lanes, setLanes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });

  const setDirty = useCallback(
    (d: boolean) => {
      setDirtyState(d);
      onDirtyChange?.(d);
    },
    [onDirtyChange],
  );

  // Reset when a new revision arrives from the server.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    setDirty(false);
    setConflict(false);
  }, [initialNodes, initialEdges, setNodes, setEdges, setDirty]);

  // Refresh decorations (team names, comment counts) without touching positions.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.type === 'lane' ? n : { ...n, data: decorate((n.data as StepData).step) })));
  }, [decorate, setNodes]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const steps = nodes.filter((n): n is Node<StepData, 'box' | 'round' | 'diamond'> => n.type !== 'lane');
  const selectedNode = selection.nodes.length === 1 ? steps.find((n) => n.id === selection.nodes[0]) : undefined;
  const selectedEdge = selection.edges.length === 1 && !selection.nodes.length ? edges.find((e) => e.id === selection.edges[0]) : undefined;

  const updateStep = (id: string, patch: Partial<StepNode>) => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id || n.type === 'lane') return n;
        const step = { ...(n.data as StepData).step, ...patch };
        return { ...n, type: shapeOf(step.type), data: decorate(step) };
      }),
    );
    setDirty(true);
  };

  const addStep = (type: NodeType, at?: { x: number; y: number }) => {
    let position = at;
    if (!position && selectedNode) {
      // Place to the right of the selected step; further branches stack underneath.
      const [w, h] = SIZE[selectedNode.type as keyof typeof SIZE];
      const [, nh] = SIZE[shapeOf(type)];
      const branches = edges.filter((e) => e.source === selectedNode.id).length;
      position = { x: selectedNode.position.x + w + 70, y: selectedNode.position.y + h / 2 - nh / 2 + branches * 130 };
    }
    if (!position) {
      const rect = wrapper.current!.getBoundingClientRect();
      const c = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      position = { x: c.x - 95 + (tmpSeq % 5) * 24, y: c.y - 36 + (tmpSeq % 5) * 24 };
    }
    const id = `tmp_${Date.now()}_${++tmpSeq}`;
    const step: StepNode = {
      id,
      processId: process.id,
      type,
      label: type === 'decision' ? 'Decision?' : TYPE_LABEL[type],
      description: '',
      teamId: selectedNode?.data.step.teamId ?? null,
      actorRole: null,
      durationMinutes: null,
      inputs: null,
      outputs: null,
      linkedProcessId: null,
      position,
      systemIds: [],
      riskIds: [],
      controlIds: [],
    };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: shapeOf(type), position, data: decorate(step), selected: true } as FlowNode]);
    // Auto-connect from the currently selected step for fast keyboard-free mapping.
    if (selectedNode && type !== 'note' && selectedNode.data.step.type !== 'end') {
      setEdges((es) => [...es, { id: `e_${id}`, source: selectedNode.id, target: id, ...edgeDefaults }]);
    }
    setSelection({ nodes: [id], edges: [] });
    setDirty(true);
  };

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return;
      setEdges((es) => addEdge({ ...c, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle, id: `e_${Date.now()}_${++tmpSeq}`, ...edgeDefaults }, es));
      setDirty(true);
    },
    [setEdges, setDirty],
  );

  const runLayout = (withLanes: boolean) => {
    setLanes(withLanes);
    setNodes((ns) => layout(ns, edges, withLanes, catalog.teamMap));
    if (editable) setDirty(true);
    setTimeout(() => rf.fitView({ padding: 0.12, duration: 300, maxZoom: 1 }), 50);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        id: process.id,
        expectedRevision: process.revision,
        nodes: steps.map((n) => {
          const s = n.data.step;
          return {
            id: n.id,
            type: s.type,
            label: s.label,
            description: s.description,
            teamId: s.teamId,
            actorRole: s.actorRole || null,
            durationMinutes: s.durationMinutes,
            inputs: s.inputs || null,
            outputs: s.outputs || null,
            linkedProcessId: s.type === 'subprocess' ? s.linkedProcessId : null,
            position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
            systemIds: s.systemIds,
            riskIds: s.riskIds,
            controlIds: s.controlIds,
          };
        }),
        edges: edges.filter((e) => steps.some((n) => n.id === e.source) && steps.some((n) => n.id === e.target)).map((e) => ({ source: e.source, target: e.target, label: typeof e.label === 'string' && e.label ? e.label : null })),
      };
      const saved = await call<ProcessFull & { idMap: Record<string, string> }>('process.saveDiagram', payload);
      const sel = selection.nodes.map((id) => saved.idMap[id] ?? id);
      onSaved(saved);
      setSelection({ nodes: sel, edges: [] });
      toastApi.show('Diagram saved', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      toastApi.show(err instanceof ApiError ? err.friendly : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd+S to save.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (editable) void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/x-streamline-node') as NodeType;
    if (!type) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addStep(type, { x: p.x - 95, y: p.y - 36 });
  };

  const deleteSelection = () => {
    const ids = new Set(selection.nodes);
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target) && !selection.edges.includes(e.id)));
    setSelection({ nodes: [], edges: [] });
    setDirty(true);
  };

  return (
    <div className={`editor ${editable ? '' : 'readonly'}`}>
      <div className="canvas" ref={wrapper} onDragOver={(e) => e.preventDefault()} onDrop={editable ? onDrop : undefined}>
        <div className="toolbar">
          {editable && (
            <div className="toolgroup" aria-label="Add step">
              {PALETTE.map((t) => (
                <button
                  key={t}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/x-streamline-node', t)}
                  onClick={() => addStep(t)}
                  title={`Add ${TYPE_LABEL[t]} (click or drag)`}
                >
                  <PaletteIcon type={t} />
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          <div className="toolgroup">
            <button className="palette-item" onClick={() => runLayout(false)} title="Auto-arrange left to right">
              <IconLayout width={15} /> Arrange
            </button>
            <button className={`palette-item ${lanes ? 'active' : ''}`} onClick={() => runLayout(!lanes)} title="Arrange into team swimlanes">
              <IconLanes width={15} /> {lanes ? 'Hide lanes' : 'Swimlanes'}
            </button>
          </div>
          <span className="spacer" />
          {editable && (
            <div className="toolgroup">
              {(selection.nodes.length > 0 || selection.edges.length > 0) && (
                <button className="palette-item" onClick={deleteSelection} title="Delete selection (Del)">
                  <IconTrash width={15} /> Delete
                </button>
              )}
              <button className="btn primary sm" onClick={() => void save()} disabled={!dirty || saving} title="Save (Ctrl+S)">
                <IconSave /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </div>
          )}
        </div>
        {conflict && (
          <div className="alert warning" style={{ position: 'absolute', zIndex: 6, top: 64, left: 12, right: 12 }}>
            Someone else changed this process since you opened it. <button className="btn sm" onClick={() => window.location.reload()}>Reload latest</button> (your unsaved changes will be lost)
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(c) => {
            onNodesChange(c);
            if (c.some((x) => x.type === 'position' && x.dragging === false) || c.some((x) => x.type === 'remove')) setDirty(true);
          }}
          onEdgesChange={(c) => {
            onEdgesChange(c);
            if (c.some((x) => x.type === 'remove')) setDirty(true);
          }}
          onConnect={onConnect}
          onSelectionChange={({ nodes: n, edges: e }) => setSelection({ nodes: n.filter((x) => x.type !== 'lane').map((x) => x.id), edges: e.map((x) => x.id) })}
          connectionMode={ConnectionMode.Loose}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={editable}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.15}
          snapToGrid
          snapGrid={[10, 10]}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'lane' ? 'transparent' : ((n.data as StepData).teamColor ?? '#94a3b8'))} />
        </ReactFlow>
      </div>
      <aside className="inspector">
        {selectedNode ? (
          <NodeInspector key={selectedNode.id} step={selectedNode.data.step} editable={editable} onChange={(p) => updateStep(selectedNode.id, p)} processId={process.id} />
        ) : selectedEdge ? (
          <div className="stack">
            <h2>Connection</h2>
            <div className="muted small">
              {steps.find((n) => n.id === selectedEdge.source)?.data.step.label} → {steps.find((n) => n.id === selectedEdge.target)?.data.step.label}
            </div>
            <Field label="Label / condition" hint='e.g. "Yes", "Approved", "> $10k"'>
              <input
                disabled={!editable}
                value={(selectedEdge.label as string) ?? ''}
                onChange={(e) => {
                  setEdges((es) => es.map((x) => (x.id === selectedEdge.id ? { ...x, label: e.target.value } : x)));
                  setDirty(true);
                }}
              />
            </Field>
            {editable && (
              <button className="btn danger" onClick={deleteSelection}>
                <IconTrash /> Remove connection
              </button>
            )}
          </div>
        ) : (
          <DiagramChecks steps={steps.map((n) => n.data.step)} edges={edges} editable={editable} selectedCount={selection.nodes.length} />
        )}
      </aside>
    </div>
  );
}

function PaletteIcon({ type }: { type: NodeType }) {
  const shape = shapeOf(type);
  const color = type === 'start' ? 'var(--success)' : type === 'end' ? 'var(--danger)' : type === 'decision' || type === 'event' ? 'var(--warning)' : 'var(--text-3)';
  if (shape === 'round') return <span style={{ width: 12, height: 12, borderRadius: '50%', border: `2px ${type === 'event' ? 'dashed' : 'solid'} ${color}`, display: 'inline-block' }} />;
  if (shape === 'diamond') return <span style={{ width: 10, height: 10, transform: 'rotate(45deg)', border: `2px solid ${color}`, display: 'inline-block' }} />;
  return <span style={{ width: 14, height: 10, borderRadius: type === 'system' ? 5 : 2, border: `${type === 'subprocess' ? 3 : 2}px ${type === 'subprocess' ? 'double' : 'solid'} ${type === 'note' ? '#e6d36e' : color}`, background: type === 'note' ? '#fff8c5' : 'transparent', display: 'inline-block' }} />;
}

function NodeInspector({ step, editable, onChange, processId }: { step: StepNode; editable: boolean; onChange: (p: Partial<StepNode>) => void; processId: string }) {
  const catalog = useCatalog();
  const { can } = useAuth();
  const isEvent = step.type === 'start' || step.type === 'end' || step.type === 'event' || step.type === 'note';
  const quickCreate = async (op: string, field: 'systemIds' | 'riskIds' | 'controlIds', label: string, key: string) => {
    const name = window.prompt(`New ${label} name`);
    if (!name) return;
    try {
      const created = await call<{ id: string }>(op, { [key]: name });
      onChange({ [field]: [...step[field], created.id] } as Partial<StepNode>);
      toastApi.show(`${label} created`, 'success');
    } catch (err) {
      toastApi.show(err instanceof ApiError ? err.friendly : 'Failed', 'error');
    }
  };
  return (
    <div className="stack">
      <div className="row">
        <h2 style={{ flex: 1 }}>{TYPE_LABEL[step.type]}</h2>
        {editable && (
          <select style={{ width: 'auto' }} value={step.type} onChange={(e) => onChange({ type: e.target.value as NodeType })} aria-label="Step type">
            {PALETTE.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        )}
      </div>
      <Field label="Label">
        <input disabled={!editable} value={step.label} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>
      <Field label={step.type === 'note' ? 'Note' : 'Description / work instructions'}>
        <textarea disabled={!editable} rows={4} value={step.description} onChange={(e) => onChange({ description: e.target.value })} />
      </Field>
      {step.type !== 'note' && (
        <Field label="Responsible team" hint="Drives swimlanes and the team interaction map">
          <select disabled={!editable} value={step.teamId ?? ''} onChange={(e) => onChange({ teamId: e.target.value || null })}>
            <option value="">— Unassigned —</option>
            {catalog.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {step.type === 'subprocess' && (
        <Field label="Calls process">
          <select disabled={!editable} value={step.linkedProcessId ?? ''} onChange={(e) => onChange({ linkedProcessId: e.target.value || null })}>
            <option value="">— Select a process —</option>
            {catalog.processes
              .filter((p) => p.id !== processId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.ref} {p.name}
                </option>
              ))}
          </select>
          {step.linkedProcessId && <Link to={`/processes/${step.linkedProcessId}`}>Open linked process →</Link>}
        </Field>
      )}
      {!isEvent && (
        <>
          <div className="grid grid-2" style={{ gap: 10 }}>
            <Field label="Role">
              <input disabled={!editable} value={step.actorRole ?? ''} onChange={(e) => onChange({ actorRole: e.target.value })} placeholder="e.g. AP Clerk" />
            </Field>
            <Field label="Duration (min)">
              <input disabled={!editable} type="number" min={0} value={step.durationMinutes ?? ''} onChange={(e) => onChange({ durationMinutes: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Business systems">
            <MultiSelect disabled={!editable} options={catalog.systemOptions} value={step.systemIds} onChange={(v) => onChange({ systemIds: v })} placeholder="Add system…" />
            {editable && can('catalog:write') && (
              <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => void quickCreate('system.create', 'systemIds', 'System', 'name')}>
                + New system
              </button>
            )}
          </Field>
          <Field label="Risks">
            <MultiSelect disabled={!editable} options={catalog.riskOptions} value={step.riskIds} onChange={(v) => onChange({ riskIds: v })} placeholder="Add risk…" />
            {editable && can('catalog:write') && (
              <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => void quickCreate('risk.create', 'riskIds', 'Risk', 'title')}>
                + New risk
              </button>
            )}
          </Field>
          <Field label="Controls">
            <MultiSelect disabled={!editable} options={catalog.controlOptions} value={step.controlIds} onChange={(v) => onChange({ controlIds: v })} placeholder="Add control…" />
            {editable && can('catalog:write') && (
              <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => void quickCreate('control.create', 'controlIds', 'Control', 'name')}>
                + New control
              </button>
            )}
          </Field>
          <Field label="Inputs">
            <input disabled={!editable} value={step.inputs ?? ''} onChange={(e) => onChange({ inputs: e.target.value })} />
          </Field>
          <Field label="Outputs">
            <input disabled={!editable} value={step.outputs ?? ''} onChange={(e) => onChange({ outputs: e.target.value })} />
          </Field>
        </>
      )}
      {!step.id.startsWith('tmp_') && <StepComments processId={processId} nodeId={step.id} />}
    </div>
  );
}

function StepComments({ processId, nodeId }: { processId: string; nodeId: string }) {
  const { can, user } = useAuth();
  const { data } = useOp<Array<{ id: string; nodeId: string | null; body: string; resolved: boolean; author: { id: string; name: string } | null; createdAt: string }>>('comment.list', { processId, includeResolved: false });
  const [body, setBody] = useState('');
  const add = useAction('comment.create', { toast: 'Comment added', onSuccess: () => setBody('') });
  const resolve = useAction('comment.resolve', { toast: 'Resolved' });
  const mine = (data ?? []).filter((c) => c.nodeId === nodeId);
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, gap: 8 }}>
      <h3>Comments on this step</h3>
      {mine.map((c) => (
        <div key={c.id} className="small">
          <div className="row">
            <strong>{c.author?.name ?? 'Unknown'}</strong>
            <span className="muted">{timeAgo(c.createdAt)}</span>
            <span className="spacer" />
            {can('comment:write') && (
              <button className="btn ghost sm" onClick={() => resolve.mutate({ id: c.id, resolved: true })}>
                Resolve
              </button>
            )}
          </div>
          <div className="pre-wrap">{c.body}</div>
        </div>
      ))}
      {!mine.length && <div className="muted small">No open comments.</div>}
      {can('comment:write') && user && (
        <div className="row">
          <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment…" onKeyDown={(e) => e.key === 'Enter' && body.trim() && add.mutate({ processId, nodeId, body })} />
          <button className="btn sm" disabled={!body.trim()} onClick={() => add.mutate({ processId, nodeId, body })}>
            Post
          </button>
        </div>
      )}
    </div>
  );
}

function DiagramChecks({ steps, edges, editable, selectedCount }: { steps: StepNode[]; edges: Edge[]; editable: boolean; selectedCount: number }) {
  const issues: string[] = [];
  const incoming = (id: string) => edges.filter((e) => e.target === id).length;
  const outgoing = (id: string) => edges.filter((e) => e.source === id).length;
  if (!steps.some((s) => s.type === 'start')) issues.push('No start event');
  if (!steps.some((s) => s.type === 'end')) issues.push('No end event');
  for (const s of steps) {
    if (s.type === 'note') continue;
    if (s.type !== 'start' && incoming(s.id) === 0) issues.push(`"${s.label}" has no incoming flow`);
    if (s.type !== 'end' && outgoing(s.id) === 0) issues.push(`"${s.label}" has no outgoing flow`);
    if (s.type === 'decision' && outgoing(s.id) < 2) issues.push(`Decision "${s.label}" should have at least two outcomes`);
    if (s.type === 'decision' && edges.some((e) => e.source === s.id && !e.label)) issues.push(`Label the outcomes of "${s.label}"`);
    if (['task', 'document', 'system', 'subprocess'].includes(s.type) && !s.teamId) issues.push(`"${s.label}" has no responsible team`);
    if (s.type === 'subprocess' && !s.linkedProcessId) issues.push(`Sub-process "${s.label}" is not linked`);
  }
  const total = steps.reduce((a, s) => a + (s.durationMinutes ?? 0), 0);
  return (
    <div className="stack">
      <h2>Diagram</h2>
      {selectedCount > 1 && <div className="alert info small">{selectedCount} steps selected</div>}
      <dl className="kv small">
        <dt>Steps</dt>
        <dd>{steps.filter((s) => s.type !== 'note').length}</dd>
        <dt>Connections</dt>
        <dd>{edges.length}</dd>
        <dt>Teams involved</dt>
        <dd>{new Set(steps.map((s) => s.teamId).filter(Boolean)).size}</dd>
        <dt>Total effort</dt>
        <dd>{total ? `${Math.round(total / 6) / 10} h` : '—'}</dd>
      </dl>
      <h3>Quality checks</h3>
      {issues.length ? (
        <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--warning)' }}>
          {issues.slice(0, 15).map((i) => (
            <li key={i}>{i}</li>
          ))}
          {issues.length > 15 && <li>…and {issues.length - 15} more</li>}
        </ul>
      ) : (
        <div className="alert info small">No issues found.</div>
      )}
      {editable && (
        <div className="muted small stack" style={{ gap: 4 }}>
          <strong>Tips</strong>
          <span>Click or drag a shape from the toolbar. With a step selected, new steps connect to it automatically.</span>
          <span>Drag from a node's edge handle to connect. Select and press Delete to remove.</span>
          <span>Use Swimlanes to arrange the flow by responsible team. Ctrl/⌘+S saves.</span>
        </div>
      )}
    </div>
  );
}

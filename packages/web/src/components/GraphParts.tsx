import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, Handle, Position, type EdgeProps, type Edge } from '@xyflow/react';

/** Invisible centred handle so edges connect node centres (used for network graphs). */
export function CenterHandles() {
  const style = { top: '50%', left: '50%', transform: 'translate(-50%,-50%)', opacity: 0, pointerEvents: 'none' as const, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0 };
  return (
    <>
      <Handle type="target" position={Position.Top} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={style} isConnectable={false} />
    </>
  );
}

export type ArcData = { count?: number; width?: number; color?: string; dim?: boolean; label?: string };

/**
 * Curved edge between node centres. Curving to one side means A→B and B→A
 * render as two distinct arcs instead of overlapping.
 */
export const ArcEdge = memo(({ id, sourceX, sourceY, targetX, targetY, data, selected, markerEnd }: EdgeProps<Edge<ArcData>>) => {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(80, len * 0.18);
  const cx = (sourceX + targetX) / 2 + (-dy / len) * bend;
  const cy = (sourceY + targetY) / 2 + (dx / len) * bend;
  // Stop short of the target centre so the arrowhead sits outside the node.
  const t = Math.max(0, 1 - 70 / len);
  const ex = (1 - t) * (1 - t) * sourceX + 2 * (1 - t) * t * cx + t * t * targetX;
  const ey = (1 - t) * (1 - t) * sourceY + 2 * (1 - t) * t * cy + t * t * targetY;
  const path = `M ${sourceX},${sourceY} Q ${cx},${cy} ${ex},${ey}`;
  const lx = 0.25 * sourceX + 0.5 * cx + 0.25 * targetX;
  const ly = 0.25 * sourceY + 0.5 * cy + 0.25 * targetY;
  const color = selected ? 'var(--primary)' : (data?.color ?? 'var(--text-3)');
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18} style={{ stroke: color, strokeWidth: data?.width ?? 1.5, opacity: data?.dim ? 0.12 : 0.85 }} />
      {(data?.label ?? data?.count) !== undefined && !data?.dim && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)`,
              background: 'var(--surface)',
              border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
              borderRadius: 10,
              padding: '0 6px',
              fontSize: 11,
              fontWeight: 700,
              color: selected ? 'var(--primary)' : 'var(--text-2)',
              pointerEvents: 'all',
            }}
          >
            {data?.label ?? data?.count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export function circleLayout<T extends { id: string }>(items: T[], radius?: number) {
  const r = radius ?? Math.max(220, items.length * 42);
  return new Map(items.map((it, i) => [it.id, { x: r + r * Math.cos((2 * Math.PI * i) / items.length - Math.PI / 2), y: r + r * Math.sin((2 * Math.PI * i) / items.length - Math.PI / 2) }]));
}

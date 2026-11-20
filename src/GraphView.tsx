import { useEffect, useId, useRef, useState } from 'react';
import type { GraphEdge, GraphNode, GraphNodeKind } from './types';

// ============================================================================
// Obsidian-style force-directed graph.
//
// Nodes are circles with a per-kind icon, edges are spring links, and a small
// physics simulation runs continuously so the map settles and drifts like a
// knowledge graph in Obsidian. Drag a node to rearrange it, drag the canvas to
// pan, and scroll to zoom.
// ============================================================================

const RADIUS = 24;
const LINK_DISTANCE = 142;
const REPULSION = 118;

const COLORS_DARK: Record<GraphNodeKind, string> = {
  target: '#38bdf8',
  subdomain: '#34d399',
  host: '#2dd4bf',
  service: '#818cf8',
  endpoint: '#c084fc',
  identity: '#fbbf24',
  vulnerability: '#fb7185',
  finding: '#f97316',
  note: '#a1a1aa',
};

const COLORS_LIGHT: Record<GraphNodeKind, string> = {
  target: '#0284c7',
  subdomain: '#047857',
  host: '#0f766e',
  service: '#4338ca',
  endpoint: '#7e22ce',
  identity: '#b45309',
  vulnerability: '#be123c',
  finding: '#c2410c',
  note: '#52525b',
};

const ICON_PATHS: Record<GraphNodeKind, string> = {
  target: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14M12 2v3M12 19v3M2 12h3M19 12h3',
  subdomain:
    'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M2 12h20M12 2c3 3 3 17 0 20M12 2c-3 3-3 17 0 20',
  host: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  service:
    'M6 6h12v12H6zM9 9h6v6H9zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3',
  endpoint:
    'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  identity: 'M20 21a8 8 0 0 0-16 0M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  vulnerability:
    'M8 6a4 4 0 0 1 8 0v1H8zM6 9h12v6a6 6 0 0 1-12 0zM3 10h3M18 10h3M3 15h3M18 15h3',
  finding: 'M12 3 2 21h20L12 3zM12 9v5M12 17h.01',
  note: 'M6 2h8l4 4v16H6zM14 2v5h5M9 13h6M9 17h6',
};

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
}

interface Viewport {
  x: number;
  y: number;
  k: number;
}

interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  isDark: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function seedBody(id: string, index: number, existing?: Body): Body {
  if (existing) return existing;
  const angle = (index * 137.508 * Math.PI) / 180;
  const distance = 40 + Math.sqrt(index) * 46;
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    vx: 0,
    vy: 0,
    phase: (hashString(id) % 1000) / 160,
  };
}

function truncate(label: string, max = 20): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export default function GraphView({
  nodes,
  edges,
  isDark,
  selectedNodeId,
  onSelectNode,
}: GraphViewProps) {
  const rawId = useId();
  const markerId = `graph-arrow-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bodiesRef = useRef<Map<string, Body>>(new Map());
  const frameRef = useRef<number | null>(null);
  const panningRef = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | null>(null);
  const draggingRef = useRef<{ id: string; moved: boolean } | null>(null);
  const lastMoveRef = useRef(0);

  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ width: 720, height: 420 });
  const [tick, setTick] = useState(0);

  const colors = isDark ? COLORS_DARK : COLORS_LIGHT;

  // Keep a body per node, preserving positions when the node list changes.
  const currentIds = nodes.map((node) => node.id);
  const idKey = currentIds.join('|');
  useEffect(() => {
    const next = new Map<string, Body>();
    nodes.forEach((node, index) => {
      next.set(node.id, seedBody(node.id, index, bodiesRef.current.get(node.id)));
    });
    bodiesRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // Track the container size and center the view the first time it is measured.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
        setViewport((current) =>
          current.x === 0 && current.y === 0
            ? { x: rect.width / 2, y: rect.height / 2, k: 1 }
            : current
        );
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Physics loop: repulsion, link springs, soft gravity, damping + ambient drift.
  useEffect(() => {
    let time = 0;
    const step = () => {
      time += 16;
      const bodies = bodiesRef.current;
      const list = currentIds
        .map((id) => bodies.get(id))
        .filter((body): body is Body => Boolean(body));

      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.001) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distance = Math.hypot(dx, dy);
          }
          if (distance < REPULSION) {
            const push = ((REPULSION - distance) / distance) * 0.045;
            const fx = dx * push;
            const fy = dy * push;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
        a.vx -= a.x * 0.0022;
        a.vy -= a.y * 0.0022;
        a.vx += Math.sin(time * 0.0007 + a.phase) * 0.012;
        a.vy += Math.cos(time * 0.0006 + a.phase) * 0.012;
      }

      for (const edge of edges) {
        const a = bodies.get(edge.from);
        const b = bodies.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const force = (distance - LINK_DISTANCE) * 0.006;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const body of list) {
        if (draggingRef.current?.id && bodies.get(draggingRef.current.id) === body) {
          body.vx = 0;
          body.vy = 0;
          continue;
        }
        body.vx *= 0.86;
        body.vy *= 0.86;
        body.x += body.vx;
        body.y += body.vy;
      }

      setTick((value) => value + 1);
      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [edges, currentIds]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - viewport.x) / viewport.k,
      y: (clientY - rect.top - viewport.y) / viewport.k,
    };
  };

  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextK = Math.min(2.6, Math.max(0.35, viewport.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const worldX = (mx - viewport.x) / viewport.k;
    const worldY = (my - viewport.y) / viewport.k;
    setViewport({
      x: mx - worldX * nextK,
      y: my - worldY * nextK,
      k: nextK,
    });
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    panningRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (draggingRef.current) {
      const body = bodiesRef.current.get(draggingRef.current.id);
      if (body) {
        const point = toWorld(event.clientX, event.clientY);
        body.x = point.x;
        body.y = point.y;
        body.vx = 0;
        body.vy = 0;
        draggingRef.current.moved = true;
        lastMoveRef.current = Date.now();
      }
      return;
    }
    if (panningRef.current) {
      setViewport((current) => ({
        ...current,
        x: panningRef.current!.startX + (event.clientX - panningRef.current!.pointerX),
        y: panningRef.current!.startY + (event.clientY - panningRef.current!.pointerY),
      }));
    }
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const dragged = draggingRef.current;
    draggingRef.current = null;
    panningRef.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }
    if (dragged && !dragged.moved) onSelectNode(dragged.id);
  };

  const viewBox = `0 0 ${size.width} ${size.height}`;
  const bodies = bodiesRef.current;

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[360px]">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        className="w-full h-full touch-none select-none"
        style={{ cursor: panningRef.current ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={isDark ? '#71717a' : '#a1a1aa'} />
          </marker>
        </defs>

        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.k})`}>
          {edges.map((edge) => {
            const from = bodies.get(edge.from);
            const to = bodies.get(edge.to);
            if (!from || !to) return null;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy) || 1;
            const ux = dx / length;
            const uy = dy / length;
            const x1 = from.x + ux * (RADIUS + 2);
            const y1 = from.y + uy * (RADIUS + 2);
            const x2 = to.x - ux * (RADIUS + 11);
            const y2 = to.y - uy * (RADIUS + 11);
            const showLabel = Boolean(edge.label) && length > 90;
            return (
              <g key={edge.id}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={isDark ? '#52525b' : '#a1a1aa'}
                  strokeOpacity={0.45}
                  strokeWidth={1.1}
                  markerEnd={`url(#${markerId})`}
                />
                {showLabel && (
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 5}
                    textAnchor="middle"
                    fontFamily="ui-monospace, monospace"
                    fontSize={8.5}
                    fill={isDark ? '#71717a' : '#71717a'}
                    pointerEvents="none"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {nodes.map((node) => {
            const body = bodies.get(node.id);
            if (!body) return null;
            const color = colors[node.kind];
            const selected = node.id === selectedNodeId;
            const driftX = Math.sin(tick * 0.01 + hashString(node.id)) * 0.9;
            const driftY = Math.cos(tick * 0.012 + hashString(node.id)) * 0.9;
            return (
              <g
                key={node.id}
                transform={`translate(${body.x + driftX}, ${body.y + driftY})`}
                className="cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  draggingRef.current = { id: node.id, moved: false };
                  svgRef.current?.setPointerCapture(event.pointerId);
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                }}
              >
                <title>
                  {node.label} · {node.kind} · contributed by {node.createdBy}
                  {node.notes ? ` · ${node.notes}` : ''}
                </title>

                <circle
                  r={RADIUS + 6}
                  fill="none"
                  stroke={color}
                  strokeOpacity={selected ? 0.55 : 0.18}
                  strokeWidth={selected ? 2 : 1}
                />
                <circle
                  r={RADIUS}
                  fill={color}
                  fillOpacity={selected ? 0.3 : 0.14}
                  stroke={color}
                  strokeWidth={selected ? 2.4 : 1.4}
                />
                <g transform={`translate(-9, -9) scale(0.75)`} pointerEvents="none">
                  <path
                    d={ICON_PATHS[node.kind]}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
                <text
                  y={RADIUS + 15}
                  textAnchor="middle"
                  fontFamily="ui-monospace, monospace"
                  fontSize={9}
                  fill={isDark ? '#d4d4d8' : '#27272a'}
                  pointerEvents="none"
                >
                  {truncate(node.label, 20)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-2 left-2 font-mono text-[9px] text-[#a1a1aa]">
        drag canvas to pan · scroll to zoom · drag node to move
      </div>
    </div>
  );
}

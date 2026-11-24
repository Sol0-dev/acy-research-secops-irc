/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useEffect, useId, useRef, useState } from 'react';
import type { GraphEdge, GraphNode, GraphNodeKind } from './types';

// ============================================================================
// Hierarchical tree graph with Obsidian-style motion.
//
// Nodes are circles with a per-kind icon, laid out as a top-down tree from the
// root assets. Nodes ease into the tree and then drift gently, so the map feels
// alive like an Obsidian graph while keeping the hierarchy readable. Drag a
// node, pan the canvas, and scroll to zoom.
// ============================================================================

const RADIUS = 24;

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
  alpha: number;
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
  highlightedNodeIds?: string[];
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function seedBody(id: string, _index: number, existing?: Body): Body {
  if (existing) return existing;
  const hash = hashString(id);
  const angle = ((hash % 360) * Math.PI) / 180;
  const distance = 4 + (hash % 9);
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    vx: 0,
    vy: 0,
    phase: (hash % 1000) / 160,
    alpha: 0,
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
  highlightedNodeIds = [],
}: GraphViewProps) {
  const rawId = useId();
  const markerId = `graph-arrow-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bodiesRef = useRef<Map<string, Body>>(new Map());
  const panningRef = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | null>(null);
  const draggingRef = useRef<{ id: string; moved: boolean } | null>(null);
  const lastMoveRef = useRef(0);

  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [size, setSize] = useState({ width: 720, height: 420 });
  const [tick, setTick] = useState(0);

  const colors = isDark ? COLORS_DARK : COLORS_LIGHT;

  // Keep a body per node, preserving positions when the node list changes.
  const currentIds = nodes.map((node) => node.id);
  const idKey = currentIds.join('|');
  const edgeKey = edges.map((edge) => `${edge.from}>${edge.to}`).join('|');
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

  // Obsidian-style force graph. Nodes spawn at the centre, repel nearby
  // neighbours in a spatial grid, link along their edges, and settle into a
  // slowly breathing cloud. Simulation and rendering are throttled so large
  // graphs cannot saturate the host.
  useEffect(() => {
    let frame = 0;
    let time = 0;
    let lastSim = 0;
    let lastRender = 0;

    const animate = (timestamp: number) => {
      frame = requestAnimationFrame(animate);
      if (document.hidden) return;

      const bodies = bodiesRef.current;
      const list = nodes
        .map((node) => ({ node, body: bodies.get(node.id) }))
        .filter((entry): entry is { node: GraphNode; body: Body } => Boolean(entry.body));
      if (list.length === 0) return;

      const density = list.length;
      const simInterval = density > 400 ? 100 : density > 200 ? 50 : 33;
      const renderInterval = density > 400 ? 200 : density > 200 ? 100 : 50;
      if (timestamp - lastSim < simInterval) return;
      time += simInterval;
      lastSim = timestamp;

      // Spatial grid: only nodes in the same or adjacent cell repel. This keeps
      // the per-frame work near linear instead of comparing every pair.
      const cellSize = 180;
      const grid = new Map<string, number[]>();
      for (let index = 0; index < list.length; index += 1) {
        const body = list[index].body;
        const cell = `${Math.floor(body.x / cellSize)},${Math.floor(body.y / cellSize)}`;
        const bucket = grid.get(cell);
        if (bucket) bucket.push(index);
        else grid.set(cell, [index]);
      }

      for (let i = 0; i < list.length; i += 1) {
        const a = list[i].body;
        const gx = Math.floor(a.x / cellSize);
        const gy = Math.floor(a.y / cellSize);
        for (let ox = -1; ox <= 1; ox += 1) {
          for (let oy = -1; oy <= 1; oy += 1) {
            const bucket = grid.get(`${gx + ox},${gy + oy}`);
            if (!bucket) continue;
            for (const j of bucket) {
              if (j <= i) continue;
              const b = list[j].body;
              let dx = b.x - a.x;
              let dy = b.y - a.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 0.01) {
                dx = Math.sin(hashString(list[i].node.id) + j) * 2;
                dy = Math.cos(hashString(list[j].node.id) + i) * 2;
                d2 = dx * dx + dy * dy;
              }
              const d = Math.sqrt(d2) || 1;
              const repel = Math.min(18, 5200 / Math.max(d2, 30));
              const fx = (dx / d) * repel;
              const fy = (dy / d) * repel;
              a.vx -= fx;
              a.vy -= fy;
              b.vx += fx;
              b.vy += fy;
              const minD = RADIUS * 2 + 14;
              if (d < minD) {
                const push = (minD - d) * 0.06;
                a.vx -= (dx / d) * push;
                a.vy -= (dy / d) * push;
                b.vx += (dx / d) * push;
                b.vy += (dy / d) * push;
              }
            }
          }
        }
      }

      for (const edge of edges) {
        const a = bodies.get(edge.from);
        const b = bodies.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const force = (d - 150) * 0.004;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const { node, body } of list) {
        if (draggingRef.current?.id === node.id) continue;
        body.vx += -body.x * 0.0025;
        body.vy += -body.y * 0.0025;
        body.vx += Math.sin(time * 0.0007 + body.phase) * 0.015;
        body.vy += Math.cos(time * 0.0009 + body.phase) * 0.015;
        body.vx *= 0.9;
        body.vy *= 0.9;
        const speed = Math.hypot(body.vx, body.vy);
        const limit = 12;
        if (speed > limit) {
          body.vx = (body.vx / speed) * limit;
          body.vy = (body.vy / speed) * limit;
        }
        body.x += body.vx;
        body.y += body.vy;
        body.alpha = Math.min(1, body.alpha + 0.035);
      }

      if (timestamp - lastRender >= renderInterval) {
        lastRender = timestamp;
        setTick((value) => value + 1);
      }
    };

    frame = requestAnimationFrame(animate);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [idKey, edgeKey, nodes, edges]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - viewport.x) / viewport.k,
      y: (clientY - rect.top - viewport.y) / viewport.k,
    };
  };

  // Wheel zoom must be non-passive so preventDefault works. React attaches
  // onWheel passively, which used to throw console errors on every scroll.
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const current = viewportRef.current;
      const nextK = Math.min(
        2.6,
        Math.max(0.35, current.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12))
      );
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const worldX = (mx - current.x) / current.k;
      const worldY = (my - current.y) / current.k;
      setViewport({
        x: mx - worldX * nextK,
        y: my - worldY * nextK,
        k: nextK,
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const worldX = (cx - viewport.x) / viewport.k;
    const worldY = (cy - viewport.y) / viewport.k;
    const nextK = Math.min(2.6, Math.max(0.35, viewport.k * factor));
    setViewport({
      x: cx - worldX * nextK,
      y: cy - worldY * nextK,
      k: nextK,
    });
  };

  const resetZoom = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    setViewport({
      x: (rect?.width ?? size.width) / 2,
      y: (rect?.height ?? size.height) / 2,
      k: 1,
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
    const panning = panningRef.current;
    if (panning) {
      // Capture the pan start now. The functional update runs later, after
      // pointerup may have cleared panningRef, which used to crash the app.
      const nextX = panning.startX + (event.clientX - panning.pointerX);
      const nextY = panning.startY + (event.clientY - panning.pointerY);
      setViewport((current) => ({ ...current, x: nextX, y: nextY }));
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
  const activeId = selectedNodeId;
  const highlightSet = new Set(highlightedNodeIds);
  const activeEdgeIds = new Set<string>();
  const activeNodeIds = new Set<string>();
  if (activeId) {
    activeNodeIds.add(activeId);
    for (const edge of edges) {
      if (edge.from === activeId || edge.to === activeId) {
        activeEdgeIds.add(edge.id);
        activeNodeIds.add(edge.from);
        activeNodeIds.add(edge.to);
      }
    }
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[560px]">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        className="w-full h-full touch-none select-none"
        style={{ cursor: panningRef.current ? 'grabbing' : 'grab' }}
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
            const connected = activeEdgeIds.has(edge.id);
            const highlightedEdge =
              highlightSet.has(edge.from) && highlightSet.has(edge.to);
            const dimmed = Boolean(activeId) && !connected && !highlightedEdge;
            const edgeAlpha = Math.min(from.alpha, to.alpha);
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            const curve = Math.min(44, length * 0.16);
            const cx = midX - uy * curve;
            const cy = midY + ux * curve;
            const labelX = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
            const labelY = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
            const showLabel = Boolean(edge.label) && length > 90;
            return (
              <g key={edge.id}>
                <path
                  d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                  fill="none"
                  stroke={
                    connected
                      ? isDark
                        ? '#4ade80'
                        : '#16a34a'
                      : highlightedEdge
                        ? '#f59e0b'
                        : isDark
                          ? '#52525b'
                          : '#a1a1aa'
                  }
                  strokeOpacity={(connected ? 0.95 : dimmed ? 0.12 : highlightedEdge ? 0.9 : 0.4) * edgeAlpha}
                  strokeWidth={connected || highlightedEdge ? 1.9 : 1.1}
                  markerEnd={`url(#${markerId})`}
                />
                {showLabel && (
                  <text
                    x={labelX}
                    y={labelY - 5}
                    textAnchor="middle"
                    fontFamily="ui-monospace, monospace"
                    fontSize={12.5}
                    fill={connected ? (isDark ? '#4ade80' : '#16a34a') : isDark ? '#71717a' : '#71717a'}
                    fillOpacity={dimmed ? 0.15 : 1}
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
            const highlighted = highlightSet.has(node.id);
            const driftX = Math.sin(tick * 0.01 + hashString(node.id)) * 0.9;
            const driftY = Math.cos(tick * 0.012 + hashString(node.id)) * 0.9;
            return (
              <g
                key={node.id}
                transform={`translate(${body.x + driftX}, ${body.y + driftY})`}
                className="cursor-pointer"
                opacity={
                  (activeId && !activeNodeIds.has(node.id) && !highlighted ? 0.25 : 1) *
                  body.alpha
                }
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
                  stroke={highlighted ? '#f59e0b' : color}
                  strokeOpacity={selected ? 0.55 : highlighted ? 1 : 0.18}
                  strokeWidth={selected ? 2 : highlighted ? 3 : 1}
                  strokeDasharray={highlighted && !selected ? '4 3' : undefined}
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
                  fontSize={13}
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

      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => zoomBy(1.2)}
          title="Zoom in"
          aria-label="Zoom in"
          className="w-7 h-7 flex items-center justify-center border border-[#e5e5e5] dark:border-[#2a2a30] bg-[#fafafa]/90 dark:bg-[#09090b]/90 text-lg leading-none text-[#52525b] dark:text-[#d4d4d8] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.2)}
          title="Zoom out"
          aria-label="Zoom out"
          className="w-7 h-7 flex items-center justify-center border border-[#e5e5e5] dark:border-[#2a2a30] bg-[#fafafa]/90 dark:bg-[#09090b]/90 text-lg leading-none text-[#52525b] dark:text-[#d4d4d8] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
        >
          -
        </button>
        <button
          type="button"
          onClick={resetZoom}
          title="Reset zoom"
          aria-label="Reset zoom"
          className="w-7 h-7 flex items-center justify-center border border-[#e5e5e5] dark:border-[#2a2a30] bg-[#fafafa]/90 dark:bg-[#09090b]/90 text-[14px] leading-none text-[#52525b] dark:text-[#d4d4d8] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
        >
          1:1
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-2 left-2 font-mono text-[13px] text-[#a1a1aa]">
        drag canvas to pan · scroll to zoom · drag node to move
      </div>
    </div>
  );
}

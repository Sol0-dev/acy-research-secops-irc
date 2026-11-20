import { useEffect, useMemo, useState } from 'react';
import GraphView from './GraphView';
import type {
  AgentProfile,
  EngagementGraph,
  GraphNode,
  GraphNodeKind,
} from './types';

const KIND_ORDER: GraphNodeKind[] = [
  'target',
  'subdomain',
  'host',
  'service',
  'endpoint',
  'identity',
  'vulnerability',
  'finding',
  'note',
];

const KIND_COLORS_DARK: Record<GraphNodeKind, string> = {
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

const KIND_COLORS_LIGHT: Record<GraphNodeKind, string> = {
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

export interface GraphActionResult {
  ok: boolean;
  error?: string;
  nodeId?: string;
}

interface GraphPanelProps {
  channelId: string;
  graph: EngagementGraph;
  agents: Record<string, AgentProfile>;
  isDark: boolean;
  defaultContributor: string;
  formatNick: (nick: string, role?: string) => string;
  nickColor: (nick: string) => string;
  onClose: () => void;
  onAddNode: (input: {
    contributor: string;
    label: string;
    kind: GraphNodeKind;
    notes?: string;
  }) => Promise<GraphActionResult>;
  onAddEdge: (input: {
    contributor: string;
    from: string;
    to: string;
    label?: string;
  }) => Promise<GraphActionResult>;
  onUpdateNode: (input: {
    contributor: string;
    nodeId: string;
    label: string;
    kind: GraphNodeKind;
    notes?: string;
  }) => Promise<GraphActionResult>;
  onRemoveNode: (input: { actor: string; nodeId: string }) => Promise<GraphActionResult>;
}

function kindColor(kind: GraphNodeKind, isDark: boolean) {
  return (isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT)[kind];
}

function normalizeHandle(value: string) {
  return value
    .trim()
    .replace(/^[@+~]+/, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

export default function GraphPanel({
  channelId,
  graph,
  agents,
  isDark,
  defaultContributor,
  formatNick,
  nickColor,
  onClose,
  onAddNode,
  onAddEdge,
  onUpdateNode,
  onRemoveNode,
}: GraphPanelProps) {
  const [contributor, setContributor] = useState(normalizeHandle(defaultContributor));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [nodeLabel, setNodeLabel] = useState('');
  const [nodeKind, setNodeKind] = useState<GraphNodeKind>('target');
  const [nodeNotes, setNodeNotes] = useState('');

  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [edgeLabel, setEdgeLabel] = useState('');

  const [editLabel, setEditLabel] = useState('');
  const [editKind, setEditKind] = useState<GraphNodeKind>('note');
  const [editNotes, setEditNotes] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selected: GraphNode | null = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId]
  );

  useEffect(() => {
    if (!selected) return;
    setEditLabel(selected.label);
    setEditKind(selected.kind);
    setEditNotes(selected.notes ?? '');
  }, [selected]);

  const contributorEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of [
      ...graph.nodes.map((node) => node.createdBy),
      ...graph.edges.map((edge) => edge.createdBy),
    ]) {
      const clean = normalizeHandle(entry);
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [graph]);

  const kindLegend = KIND_ORDER.filter((kind) =>
    graph.nodes.some((node) => node.kind === kind)
  );

  const addNode = async () => {
    const label = nodeLabel.trim();
    if (!label) {
      setError('node label is required');
      return;
    }
    setBusy(true);
    const result = await onAddNode({
      contributor,
      label,
      kind: nodeKind,
      notes: nodeNotes.trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not add node');
      return;
    }
    setError('');
    setNodeLabel('');
    setNodeNotes('');
    if (result.nodeId) setSelectedId(result.nodeId);
  };

  const addEdge = async () => {
    if (!edgeFrom || !edgeTo) {
      setError('select both a source and target node');
      return;
    }
    if (edgeFrom === edgeTo) {
      setError('an edge needs two different nodes');
      return;
    }
    setBusy(true);
    const result = await onAddEdge({
      contributor,
      from: edgeFrom,
      to: edgeTo,
      label: edgeLabel.trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not add edge');
      return;
    }
    setError('');
    setEdgeLabel('');
  };

  const updateInfo = async () => {
    if (!selected) return;
    if (!editLabel.trim()) {
      setError('node label is required');
      return;
    }
    setBusy(true);
    const result = await onUpdateNode({
      contributor,
      nodeId: selected.id,
      label: editLabel.trim(),
      kind: editKind,
      notes: editNotes.trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not update node information');
      return;
    }
    setError('');
  };

  const removeNode = async () => {
    if (!selected) return;
    setBusy(true);
    const result = await onRemoveNode({ actor: contributor, nodeId: selected.id });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not remove node');
      return;
    }
    setError('');
    setSelectedId(null);
  };

  const inputClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[11px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a]';
  const areaClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[11px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y';

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e] overflow-y-auto">
      <div className="px-4 sm:px-5 py-3 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
          >
            &larr; chat
          </button>
          <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
          <span className="font-mono text-xs font-medium truncate">
            knowledge graph // {channelId}
          </span>
          <span className="font-mono text-[10px] text-[#71717a]">
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </span>
        </div>

        <label className="flex items-center gap-1.5 font-mono text-[10px] text-[#71717a]">
          <span>contributing as</span>
          <select
            value={contributor}
            onChange={(event) => setContributor(event.target.value)}
            className="bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[10px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
          >
            {Object.values(agents).map((agent) => (
              <option key={agent.nick} value={agent.nick}>
                {formatNick(agent.nick, agent.role)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mx-4 sm:mx-5 mt-3 text-[11px] font-mono border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
          {error}
        </div>
      )}

      <div className="p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_250px] gap-3">
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] bg-white/40 dark:bg-[#09090b] h-[420px] sm:h-[500px] overflow-hidden">
            {graph.nodes.length === 0 ? (
              <div className="h-full flex items-center justify-center p-8 text-center font-mono text-[11px] text-[#71717a] leading-relaxed">
                the graph is empty — each agent creates intel here.
                <br />
                add a node on the right, or run <code className="mx-1">/node target &lt;asset&gt;</code> in
                this engagement.
              </div>
            ) : (
              <GraphView
                nodes={graph.nodes}
                edges={graph.edges}
                isDark={isDark}
                selectedNodeId={selectedId}
                onSelectNode={(id) => setSelectedId((current) => (current === id ? null : id))}
              />
            )}
          </div>

          <div className="space-y-3 font-mono text-[11px]">
            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[#71717a]">
                contributors
              </div>
              {contributorEntries.length === 0 ? (
                <span className="text-[10px] text-[#71717a]">none yet</span>
              ) : (
                contributorEntries.map(([nick, count]) => (
                  <div key={nick} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px]" style={{ color: nickColor(nick) }}>
                      {formatNick(nick, agents[nick]?.role)}
                    </span>
                    <span className="text-[9px] text-[#71717a]/70">{count}</span>
                  </div>
                ))
              )}
            </div>

            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[#71717a]">legend</div>
              {kindLegend.length === 0 ? (
                <span className="text-[10px] text-[#71717a]">—</span>
              ) : (
                kindLegend.map((kind) => (
                  <div key={kind} className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: kindColor(kind, isDark) }}
                    />
                    <span className="text-[10px] text-[#71717a]">{kind}</span>
                  </div>
                ))
              )}
            </div>

            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-[#71717a]">
                {selected ? 'node intel' : 'select a node'}
              </div>
              {!selected ? (
                <div className="text-[10px] text-[#71717a] leading-relaxed">
                  click a circle to inspect it, edit its custom information, or remove it.
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-[#52525b] dark:text-[#a1a1aa]">
                      [{selected.kind}] by {selected.createdBy} · {selected.time}
                    </span>
                    <button
                      type="button"
                      title="Remove node and its links"
                      onClick={() => void removeNode()}
                      disabled={busy}
                      className="text-[#71717a] hover:text-[#dc2626] dark:hover:text-[#f87171] disabled:opacity-40"
                    >
                      &times;
                    </button>
                  </div>

                  <label className="block space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-[#71717a]">label</span>
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(event) => setEditLabel(event.target.value)}
                      className={inputClass}
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-[#71717a]">kind</span>
                    <select
                      value={editKind}
                      onChange={(event) => setEditKind(event.target.value as GraphNodeKind)}
                      className={inputClass}
                    >
                      {KIND_ORDER.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[9px] uppercase tracking-wider text-[#71717a]">
                      custom information
                    </span>
                    <textarea
                      rows={4}
                      value={editNotes}
                      onChange={(event) => setEditNotes(event.target.value)}
                      placeholder="notes, evidence, request/response, cvss, owners, next steps…"
                      className={areaClass}
                    />
                  </label>

                  {selected.updatedBy && (
                    <div className="text-[9px] text-[#71717a]">
                      updated by {selected.updatedBy} · {selected.updatedTime}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void updateInfo()}
                    disabled={busy}
                    className="w-full px-2 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[10px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
                  >
                    save node information
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 font-mono text-[11px]">
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#71717a]">add node</div>
            <input
              type="text"
              value={nodeLabel}
              onChange={(event) => setNodeLabel(event.target.value)}
              placeholder="label e.g. api.target.io"
              className={inputClass}
            />
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <select
                value={nodeKind}
                onChange={(event) => setNodeKind(event.target.value as GraphNodeKind)}
                className={inputClass}
              >
                {KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={nodeNotes}
                onChange={(event) => setNodeNotes(event.target.value)}
                placeholder="custom information"
                className={inputClass}
              />
            </div>
            <button
              type="button"
              onClick={() => void addNode()}
              disabled={busy}
              className="px-3 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
            >
              add node +
            </button>
          </div>

          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#71717a]">add edge</div>
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <select
                value={edgeFrom}
                onChange={(event) => setEdgeFrom(event.target.value)}
                className={inputClass}
              >
                <option value="">from node...</option>
                {graph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
              <select
                value={edgeTo}
                onChange={(event) => setEdgeTo(event.target.value)}
                className={inputClass}
              >
                <option value="">to node...</option>
                {graph.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={edgeLabel}
              onChange={(event) => setEdgeLabel(event.target.value)}
              placeholder="relationship e.g. resolves to"
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => void addEdge()}
              disabled={busy || graph.nodes.length < 2}
              className="px-3 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
            >
              add edge +
            </button>
          </div>
        </div>

        <div className="font-mono text-[10px] text-[#71717a] leading-relaxed border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-2">
          every agent can contribute: <code>/node &lt;kind&gt; &lt;label&gt;</code> and{' '}
          <code>/edge &lt;a&gt; -&gt; &lt;b&gt; [label]</code> work from chat, or use the forms
          above. custom information, attribution and links are persisted centrally per engagement.
        </div>
      </div>
    </div>
  );
}

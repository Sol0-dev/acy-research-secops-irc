/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from 'react';
import GraphView from './GraphView';
import type {
  AgentProfile,
  EngagementGraph,
  GraphNode,
  GraphNodeKind,
  TechniqueIntel,
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
  graphs: Record<string, EngagementGraph>;
  agents: Record<string, AgentProfile>;
  isDark: boolean;
  defaultContributor: string;
  formatNick: (nick: string, role?: string) => string;
  nickColor: (nick: string) => string;
  onSelectChannel: (channelId: string) => void;
  onClose: () => void;
  onAddNode: (input: {
    label: string;
    kind: GraphNodeKind;
    notes?: string;
    intel?: TechniqueIntel;
  }) => Promise<GraphActionResult>;
  onAddEdge: (input: {
    from: string;
    to: string;
    label?: string;
  }) => Promise<GraphActionResult>;
  onUpdateNode: (input: {
    nodeId: string;
    label: string;
    kind: GraphNodeKind;
    notes?: string;
    intel?: TechniqueIntel;
  }) => Promise<GraphActionResult>;
  onRemoveNode: (input: { nodeId: string }) => Promise<GraphActionResult>;
  onImport: (input: {
    nodes: unknown[];
    edges: unknown[];
    replace: boolean;
  }) => Promise<{
    ok: boolean;
    error?: string;
    importedNodes?: number;
    importedEdges?: number;
    skippedNodes?: number;
    skippedEdges?: number;
  }>;
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

const PHASES = [
  'osint',
  'discovery',
  'recon',
  'fuzzing',
  'exploitation',
  'chaining',
  'privilege escalation',
  'pivot',
  'lateral movement',
  'validation',
  'reporting',
];

export default function GraphPanel({
  channelId,
  graph,
  graphs,
  agents,
  isDark,
  defaultContributor,
  formatNick,
  nickColor,
  onSelectChannel,
  onClose,
  onAddNode,
  onAddEdge,
  onUpdateNode,
  onRemoveNode,
  onImport,
}: GraphPanelProps) {
  const contributor = normalizeHandle(defaultContributor);
  const downloadGraph = (id: string) => {
    const target = graphs[id];
    if (!target) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            channelId: id,
            graph: target,
          },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `graph-${id.replace(/^#/, '')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingNode, setEditingNode] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importReplace, setImportReplace] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const loadImportFile = (file: File) => {
    if (!file) return;
    void file.text().then((text) => {
      setImportText(text);
      setImportError('');
      setImportNotice(`loaded ${file.name}`);
    });
  };

  const [nodeLabel, setNodeLabel] = useState('');
  const [nodeKind, setNodeKind] = useState<GraphNodeKind>('target');
  const [nodeNotes, setNodeNotes] = useState('');
  const [nodePhase, setNodePhase] = useState('');
  const [nodeTechnique, setNodeTechnique] = useState('');
  const [nodeCommands, setNodeCommands] = useState('');
  const [nodeScripts, setNodeScripts] = useState('');
  const [nodeRequest, setNodeRequest] = useState('');
  const [nodeResponse, setNodeResponse] = useState('');
  const [nodeChain, setNodeChain] = useState('');
  const [nodeLessons, setNodeLessons] = useState('');
  const [nodeTemplate, setNodeTemplate] = useState('');
  const [nodeReferences, setNodeReferences] = useState('');
  const [nodeTags, setNodeTags] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editKind, setEditKind] = useState<GraphNodeKind>('note');
  const [editNotes, setEditNotes] = useState('');
  const [editPhase, setEditPhase] = useState('');
  const [editTechnique, setEditTechnique] = useState('');
  const [editCommands, setEditCommands] = useState('');
  const [editScripts, setEditScripts] = useState('');
  const [editRequest, setEditRequest] = useState('');
  const [editResponse, setEditResponse] = useState('');
  const [editChain, setEditChain] = useState('');
  const [editLessons, setEditLessons] = useState('');
  const [editTemplate, setEditTemplate] = useState('');
  const [editReferences, setEditReferences] = useState('');
  const [editTags, setEditTags] = useState('');
  const [confirmDeleteNode, setConfirmDeleteNode] = useState(false);

  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [edgeLabel, setEdgeLabel] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selected: GraphNode | null = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId]
  );


  const selectedRelations = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const rows: Array<{ direction: 'in' | 'out'; label?: string; node: GraphNode }> = [];
    for (const edge of graph.edges) {
      if (edge.from === selected.id) {
        const to = byId.get(edge.to);
        if (to) rows.push({ direction: 'out', label: edge.label, node: to });
      } else if (edge.to === selected.id) {
        const from = byId.get(edge.from);
        if (from) rows.push({ direction: 'in', label: edge.label, node: from });
      }
    }
    return rows;
  }, [graph.edges, graph.nodes, selected]);

  useEffect(() => {
    if (!selected) return;
    setEditLabel(selected.label);
    setEditKind(selected.kind);
    setEditNotes(selected.notes ?? '');
    setEditPhase(selected.intel?.phase ?? '');
    setEditTechnique(selected.intel?.technique ?? '');
    setEditCommands(selected.intel?.commands ?? '');
    setEditScripts(selected.intel?.scripts ?? '');
    setEditRequest(selected.intel?.request ?? '');
    setEditResponse(selected.intel?.response ?? '');
    setEditChain(selected.intel?.chain ?? '');
    setEditLessons(selected.intel?.lessons ?? '');
    setEditTemplate(selected.intel?.template ?? '');
    setEditReferences(selected.intel?.references ?? '');
    setEditTags((selected.intel?.tags ?? []).join(', '));
    setConfirmDeleteNode(false);
    setEditingNode(false);
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
    if (!nodePhase.trim()) {
      setError('phase is required: osint, discovery, recon, fuzzing, exploitation, chaining, privilege escalation, pivot, or custom');
      return;
    }
    if (
      ![nodeCommands, nodeScripts, nodeRequest, nodeResponse].some((value) => value.trim())
    ) {
      setError('include at least one of commands, scripts, request, or response');
      return;
    }
    const intel: TechniqueIntel = {};
    if (nodePhase.trim()) intel.phase = nodePhase.trim();
    if (nodeTechnique.trim()) intel.technique = nodeTechnique.trim();
    if (nodeCommands.trim()) intel.commands = nodeCommands;
    if (nodeScripts.trim()) intel.scripts = nodeScripts;
    if (nodeRequest.trim()) intel.request = nodeRequest;
    if (nodeResponse.trim()) intel.response = nodeResponse;
    if (nodeChain.trim()) intel.chain = nodeChain;
    if (nodeLessons.trim()) intel.lessons = nodeLessons;
    if (nodeTemplate.trim()) intel.template = nodeTemplate;
    if (nodeReferences.trim()) intel.references = nodeReferences;
    const nodeTagList = nodeTags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (nodeTagList.length > 0) intel.tags = nodeTagList;
    setBusy(true);
    const result = await onAddNode({
      label,
      kind: nodeKind,
      notes: nodeNotes.trim() || undefined,
      intel: Object.keys(intel).length > 0 ? intel : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not add node');
      return;
    }
    setError('');
    setNodeLabel('');
    setNodeNotes('');
    setNodePhase('');
    setNodeTechnique('');
    setNodeCommands('');
    setNodeScripts('');
    setNodeRequest('');
    setNodeResponse('');
    setNodeChain('');
    setNodeLessons('');
    setNodeTemplate('');
    setNodeReferences('');
    setNodeTags('');
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

  const updateNode = async () => {
    if (!selected) return;
    if (!editLabel.trim()) {
      setError('node label is required');
      return;
    }
    if (!editPhase.trim()) {
      setError('phase is required: osint, discovery, recon, fuzzing, exploitation, chaining, privilege escalation, pivot, or custom');
      return;
    }
    if (
      ![editCommands, editScripts, editRequest, editResponse].some((value) => value.trim())
    ) {
      setError('include at least one of commands, scripts, request, or response');
      return;
    }
    const intel: TechniqueIntel = {};
    if (editPhase.trim()) intel.phase = editPhase.trim();
    if (editTechnique.trim()) intel.technique = editTechnique.trim();
    if (editCommands.trim()) intel.commands = editCommands;
    if (editScripts.trim()) intel.scripts = editScripts;
    if (editRequest.trim()) intel.request = editRequest;
    if (editResponse.trim()) intel.response = editResponse;
    if (editChain.trim()) intel.chain = editChain;
    if (editLessons.trim()) intel.lessons = editLessons;
    if (editTemplate.trim()) intel.template = editTemplate;
    if (editReferences.trim()) intel.references = editReferences;
    const tags = editTags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length > 0) intel.tags = tags;
    setBusy(true);
    const result = await onUpdateNode({
      nodeId: selected.id,
      label: editLabel.trim(),
      kind: editKind,
      notes: editNotes.trim() || undefined,
      intel,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not refine node');
      return;
    }
    setError('');
  };

  const deleteNode = async () => {
    if (!selected) return;
    setBusy(true);
    const result = await onRemoveNode({ nodeId: selected.id });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not delete node');
      return;
    }
    setError('');
    setConfirmDeleteNode(false);
    setSelectedId(null);
  };

  const inputClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a]';
  const areaClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y font-mono';

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e] overflow-y-auto">
      <div className="px-4 sm:px-5 py-3 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[15px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
          >
            &larr; chat
          </button>
          <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
          <span className="font-mono text-base font-medium truncate">
            attack map // {graph.title ?? channelId}
          </span>
          <span className="font-mono text-[14px] text-[#71717a]">
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </span>
          <label className="flex items-center gap-1.5 font-mono text-[14px] text-[#71717a]">
            <span>target</span>
            <select
              value={channelId}
              onChange={(event) => onSelectChannel(event.target.value)}
              className="bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[14px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
            >
              {Object.keys(graphs)
                .sort()
                .map((id) => (
                  <option key={id} value={id}>
                    {graphs[id]?.title ?? id}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              setImportOpen((value) => !value);
              setImportError('');
              setImportNotice('');
            }}
            className="font-mono text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
          >
            import json
          </button>
          <button
            type="button"
            onClick={() => downloadGraph(channelId)}
            title="Download this graph as JSON"
            className="font-mono text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
          >
            download json
          </button>
        </div>

        <span className="font-mono text-[14px] text-[#71717a]">
          acting as{' '}
          <span className="text-[#18181b] dark:text-[#f4f4f5]">
            {formatNick(contributor, agents[contributor]?.role)}
          </span>
        </span>
      </div>

      {error && (
        <div className="mx-4 sm:mx-5 mt-3 text-[15px] font-mono border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
          {error}
        </div>
      )}

      {importOpen && (
        <div className="mx-4 sm:mx-5 mt-3 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#fafafa] dark:bg-[#09090b] p-3 space-y-2 font-mono text-[14px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="uppercase tracking-wider text-[#71717a]">import graph JSON</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
              >
                close
              </button>
            </div>
          </div>
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) loadImportFile(file);
            }}
            className="border border-dashed border-[#a1a1aa] dark:border-[#52525b] bg-white/50 dark:bg-[#050506]/50 p-4 text-center space-y-1"
          >
            <div className="text-[14px] text-[#52525b] dark:text-[#a1a1aa]">
              drag and drop a JSON file here
            </div>
            <div className="text-[13px] text-[#71717a]">
              or paste JSON in the editor below
            </div>
          </div>
          <textarea
            rows={8}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={'{"nodes":[{"label":"api.example.com","kind":"host","intel":{"phase":"recon","commands":"curl -I https://api.example.com"}}],"edges":[]}'}
            className="w-full bg-white dark:bg-[#050506] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 font-mono text-[13px] resize-y"
          />
          <label className="flex items-center gap-2 text-[#71717a]">
            <input
              type="checkbox"
              checked={importReplace}
              onChange={(event) => setImportReplace(event.target.checked)}
            />
            replace the current graph
            <span className="text-[13px] text-[#71717a]">
              optional: select a JSON file from your computer
            </span>
            <input
              type="file"
              accept=".json,application/json"
              className="text-[13px] text-[#71717a]"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) loadImportFile(file);
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={importBusy || !importText.trim()}
              onClick={() => {
                setImportBusy(true);
                setImportError('');
                setImportNotice('');
                try {
                  const parsed = JSON.parse(importText) as
                    | unknown[]
                    | {
                        nodes?: unknown[];
                        edges?: unknown[];
                        graph?: { nodes?: unknown[]; edges?: unknown[] };
                        data?: { nodes?: unknown[]; edges?: unknown[] };
                      };
                  const container = Array.isArray(parsed)
                    ? parsed
                    : parsed?.graph && typeof parsed.graph === 'object'
                      ? parsed.graph
                      : parsed?.data && typeof parsed.data === 'object'
                        ? parsed.data
                        : parsed;
                  const nodes = Array.isArray(container)
                    ? container
                    : Array.isArray(container?.nodes)
                      ? container.nodes
                      : [];
                  const edgeSource = Array.isArray(container) ? null : container;
                  const edges =
                    edgeSource && Array.isArray(edgeSource.edges)
                      ? edgeSource.edges
                      : [];
                  void onImport({ nodes, edges, replace: importReplace }).then((result) => {
                    setImportBusy(false);
                    if (!result.ok) {
                      setImportError(result.error || 'could not import graph');
                      return;
                    }
                    setImportNotice(
                      `imported ${result.importedNodes ?? 0} nodes and ${
                        result.importedEdges ?? 0
                      } edges · skipped ${result.skippedNodes ?? 0} nodes and ${
                        result.skippedEdges ?? 0
                      } edges`
                    );
                    setImportText('');
                  });
                } catch {
                  setImportBusy(false);
                  setImportError('invalid JSON. expected an object with nodes and edges arrays.');
                }
              }}
              className="px-2.5 py-1 border border-[#16a34a]/50 text-[#16a34a] dark:text-[#4ade80] disabled:opacity-40"
            >
              {importBusy ? 'importing…' : 'import into graph'}
            </button>
            {importError && <span className="text-[#dc2626] dark:text-[#f87171]">{importError}</span>}
            {importNotice && <span className="text-[#16a34a] dark:text-[#4ade80]">{importNotice}</span>}
          </div>
          <div className="text-[13px] text-[#71717a]">
            nodes use label, kind, notes, intel.phase and at least one of intel.commands, scripts,
            request, response. edges use from, to, and optional label. from and to can be a node id
            or label.
          </div>
        </div>
      )}

      <div className="p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-3">
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] bg-white/40 dark:bg-[#09090b] h-[72vh] min-h-[620px] overflow-hidden">
            {graph.nodes.length === 0 ? (
              <div className="h-full flex items-center justify-center p-8 text-center font-mono text-[15px] text-[#71717a] leading-relaxed">
                the graph is empty - each agent creates intel here.
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

          <div className="space-y-3 font-mono text-[15px]">
            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1.5">
              <div className="text-[14px] uppercase tracking-wider text-[#71717a]">
                contributors
              </div>
              {contributorEntries.length === 0 ? (
                <span className="text-[14px] text-[#71717a]">none yet</span>
              ) : (
                contributorEntries.map(([nick, count]) => (
                  <div key={nick} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px]" style={{ color: nickColor(nick) }}>
                      {formatNick(nick, agents[nick]?.role)}
                    </span>
                    <span className="text-[13px] text-[#71717a]/70">{count}</span>
                  </div>
                ))
              )}
            </div>

            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1.5">
              <div className="text-[14px] uppercase tracking-wider text-[#71717a]">legend</div>
              {kindLegend.length === 0 ? (
                <span className="text-[14px] text-[#71717a]">-</span>
              ) : (
                kindLegend.map((kind) => (
                  <div key={kind} className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: kindColor(kind, isDark) }}
                    />
                    <span className="text-[14px] text-[#71717a]">{kind}</span>
                  </div>
                ))
              )}
            </div>

            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[14px] uppercase tracking-wider text-[#71717a]">
                  {selected ? 'node intel' : 'select a node'}
                </div>
                {selected && (
                  <button
                    type="button"
                    onClick={() => setEditingNode((value) => !value)}
                    className="px-2 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                  >
                    {editingNode ? 'cancel refine' : 'refine'}
                  </button>
                )}
                {selected &&
                  (confirmDeleteNode ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void deleteNode()}
                        className="px-1.5 py-0.5 border border-[#f87171] text-[13px] text-[#f87171]"
                      >
                        yes, delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteNode(false)}
                        className="px-1.5 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a]"
                      >
                        no
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteNode(true)}
                      className="px-1.5 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#f87171]"
                    >
                      delete node
                    </button>
                  ))}
              </div>
              {!selected ? (
                <div className="text-[14px] text-[#71717a] leading-relaxed">
                  click a circle or search result to inspect, refine, and relate knowledge.
                </div>
              ) : (
                <div className="space-y-2">
                  {selected.intel?.phase && (
                    <div className="text-[#16a34a] dark:text-[#4ade80]">
                      phase: {selected.intel.phase}
                    </div>
                  )}
                  {selected.intel?.technique && (
                    <div className="whitespace-pre-wrap text-[#18181b] dark:text-[#d4d4d8]">
                      technique: {selected.intel.technique}
                    </div>
                  )}
                  {selected.notes && (
                    <div className="whitespace-pre-wrap text-[#52525b] dark:text-[#a1a1aa]">
                      {selected.notes}
                    </div>
                  )}
                  {selected.intel?.commands && (
                    <div>
                      <div className="text-[13px] uppercase tracking-wider text-[#71717a]">commands</div>
                      <pre className="p-2 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap max-h-64">
                        {selected.intel.commands}
                      </pre>
                    </div>
                  )}
                  {selected.intel?.scripts && (
                    <div>
                      <div className="text-[13px] uppercase tracking-wider text-[#71717a]">scripts</div>
                      <pre className="p-2 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap max-h-64">
                        {selected.intel.scripts}
                      </pre>
                    </div>
                  )}
                  {selected.intel?.request && (
                    <div>
                      <div className="text-[13px] uppercase tracking-wider text-[#71717a]">request</div>
                      <pre className="p-2 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap max-h-64">
                        {selected.intel.request}
                      </pre>
                    </div>
                  )}
                  {selected.intel?.response && (
                    <div>
                      <div className="text-[13px] uppercase tracking-wider text-[#71717a]">response</div>
                      <pre className="p-2 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap max-h-64">
                        {selected.intel.response}
                      </pre>
                    </div>
                  )}
                  {selected.intel?.chain && (
                    <div className="whitespace-pre-wrap text-[#52525b] dark:text-[#a1a1aa]">
                      chain: {selected.intel.chain}
                    </div>
                  )}
                  {selected.intel?.lessons && (
                    <div className="whitespace-pre-wrap text-[#52525b] dark:text-[#a1a1aa]">
                      lessons: {selected.intel.lessons}
                    </div>
                  )}
                  {selected.intel?.template && (
                    <div>
                      <div className="text-[13px] uppercase tracking-wider text-[#71717a]">template</div>
                      <pre className="p-2 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap max-h-64">
                        {selected.intel.template}
                      </pre>
                    </div>
                  )}
                  {selected.intel?.references && (
                    <div className="whitespace-pre-wrap text-[#52525b] dark:text-[#a1a1aa]">
                      references: {selected.intel.references}
                    </div>
                  )}
                  {selected.intel?.tags && selected.intel.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {selected.intel.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {editingNode && (
                    <>
                  <label className="block space-y-1">
                    <span className="text-[13px] uppercase tracking-wider text-[#71717a]">label</span>
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(event) => setEditLabel(event.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[13px] uppercase tracking-wider text-[#71717a]">kind</span>
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
                    <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                      summary / notes
                    </span>
                    <textarea
                      rows={4}
                      value={editNotes}
                      onChange={(event) => setEditNotes(event.target.value)}
                      className={areaClass}
                    />
                  </label>

                  <details className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-2">
                    <summary className="cursor-pointer text-[13px] uppercase tracking-wider text-[#71717a]">
                      technique knowledge - raw, no truncation
                    </summary>
                    <div className="space-y-2 pt-2">
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">phase</span>
                        <input
                          type="text"
                          value={editPhase}
                          onChange={(event) => setEditPhase(event.target.value)}
                          list="graph-phases"
                          placeholder="osint, discovery, recon, fuzzing, exploitation, chaining, privilege escalation, pivot"
                          className={inputClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">technique</span>
                        <textarea
                          rows={2}
                          value={editTechnique}
                          onChange={(event) => setEditTechnique(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          commands / snippets
                        </span>
                        <textarea
                          rows={5}
                          value={editCommands}
                          onChange={(event) => setEditCommands(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          scripts used
                        </span>
                        <textarea
                          rows={5}
                          value={editScripts}
                          onChange={(event) => setEditScripts(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          full request
                        </span>
                        <textarea
                          rows={5}
                          value={editRequest}
                          onChange={(event) => setEditRequest(event.target.value)}
                          placeholder="no truncation, no redaction"
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          full response
                        </span>
                        <textarea
                          rows={5}
                          value={editResponse}
                          onChange={(event) => setEditResponse(event.target.value)}
                          placeholder="no truncation, no redaction"
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">chain</span>
                        <textarea
                          rows={3}
                          value={editChain}
                          onChange={(event) => setEditChain(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          lessons / why faster
                        </span>
                        <textarea
                          rows={3}
                          value={editLessons}
                          onChange={(event) => setEditLessons(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">template</span>
                        <textarea
                          rows={4}
                          value={editTemplate}
                          onChange={(event) => setEditTemplate(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">references</span>
                        <textarea
                          rows={2}
                          value={editReferences}
                          onChange={(event) => setEditReferences(event.target.value)}
                          className={areaClass}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          tags (comma separated)
                        </span>
                        <input
                          type="text"
                          value={editTags}
                          onChange={(event) => setEditTags(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                    </div>
                  </details>
                    </>
                  )}

                  <div className="text-[13px] text-[#71717a] border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-1.5 space-y-0.5">
                    <div>
                      submitted by {selected.createdBy} - {selected.time}
                    </div>
                    {selected.updatedBy && (
                      <div>
                        refined by {selected.updatedBy} - {selected.updatedTime}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1 border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-1.5">
                    <div className="text-[13px] uppercase tracking-wider text-[#71717a]">relations</div>
                    {selectedRelations.length === 0 ? (
                      <div className="text-[13px] text-[#71717a]">no relations yet</div>
                    ) : (
                      selectedRelations.map((relation, index) => (
                        <button
                          key={`${relation.node.id}-${index}`}
                          type="button"
                          onClick={() => setSelectedId(relation.node.id)}
                          className="w-full text-left text-[13px] text-[#52525b] dark:text-[#a1a1aa] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                        >
                          {relation.direction === 'out' ? '->' : '<-'} {relation.label ? `[${relation.label}] ` : ''}
                          {relation.node.label}
                        </button>
                      ))
                    )}
                  </div>

                  {editingNode && (
                    <button
                      type="button"
                      onClick={() => void updateNode()}
                      disabled={busy}
                      className="w-full px-2 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
                    >
                      save / refine node
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 font-mono text-[15px]">
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
            <div className="text-[14px] uppercase tracking-wider text-[#71717a]">add node</div>
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
            <datalist id="graph-phases">
              {PHASES.map((phase) => (
                <option key={phase} value={phase} />
              ))}
            </datalist>
            <div className="text-[13px] text-[#b45309] dark:text-[#fbbf24] leading-relaxed">
              required: phase + at least one of commands, scripts, request, or response used during
              testing.
            </div>
            <details className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-2">
              <summary className="cursor-pointer text-[13px] uppercase tracking-wider text-[#71717a]">
                commands, scripts, request/response - raw (required)
              </summary>
              <div className="space-y-2 pt-2">
                <input
                  type="text"
                  value={nodePhase}
                  onChange={(event) => setNodePhase(event.target.value)}
                  list="graph-phases"
                  placeholder="phase: osint, discovery, recon, fuzzing, exploitation, chaining, privilege escalation, pivot"
                  className={inputClass}
                />
                <textarea
                  rows={2}
                  value={nodeTechnique}
                  onChange={(event) => setNodeTechnique(event.target.value)}
                  placeholder="technique"
                  className={areaClass}
                />
                <textarea
                  rows={3}
                  value={nodeCommands}
                  onChange={(event) => setNodeCommands(event.target.value)}
                  placeholder="commands / snippets used"
                  className={areaClass}
                />
                <textarea
                  rows={3}
                  value={nodeScripts}
                  onChange={(event) => setNodeScripts(event.target.value)}
                  placeholder="scripts used"
                  className={areaClass}
                />
                <textarea
                  rows={3}
                  value={nodeRequest}
                  onChange={(event) => setNodeRequest(event.target.value)}
                  placeholder="full request - no truncation, no redaction"
                  className={areaClass}
                />
                <textarea
                  rows={3}
                  value={nodeResponse}
                  onChange={(event) => setNodeResponse(event.target.value)}
                  placeholder="full response - no truncation, no redaction"
                  className={areaClass}
                />
                <textarea
                  rows={2}
                  value={nodeChain}
                  onChange={(event) => setNodeChain(event.target.value)}
                  placeholder="chain: steps and relationships"
                  className={areaClass}
                />
                <textarea
                  rows={2}
                  value={nodeLessons}
                  onChange={(event) => setNodeLessons(event.target.value)}
                  placeholder="lessons / why this is faster"
                  className={areaClass}
                />
                <textarea
                  rows={3}
                  value={nodeTemplate}
                  onChange={(event) => setNodeTemplate(event.target.value)}
                  placeholder="reusable template"
                  className={areaClass}
                />
                <textarea
                  rows={2}
                  value={nodeReferences}
                  onChange={(event) => setNodeReferences(event.target.value)}
                  placeholder="references"
                  className={areaClass}
                />
                <input
                  type="text"
                  value={nodeTags}
                  onChange={(event) => setNodeTags(event.target.value)}
                  placeholder="tags (comma separated)"
                  className={inputClass}
                />
              </div>
            </details>
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
            <div className="text-[14px] uppercase tracking-wider text-[#71717a]">add edge</div>
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

        <div className="font-mono text-[14px] text-[#71717a] leading-relaxed border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-2">
          every agent can contribute: <code>/node &lt;kind&gt; &lt;label&gt;</code> and{' '}
          <code>/edge &lt;a&gt; -&gt; &lt;b&gt; [label]</code> work from chat, or use the forms
          above. custom information, attribution and links are persisted centrally per engagement.
        </div>
      </div>
    </div>
  );
}

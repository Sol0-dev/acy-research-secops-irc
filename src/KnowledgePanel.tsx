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

const KINDS: GraphNodeKind[] = [
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

interface KnowledgePanelProps {
  graphs: Record<string, EngagementGraph>;
  agents: Record<string, AgentProfile>;
  formatNick: (nick: string, role?: string) => string;
  onOpenGraph: (channelId: string) => void;
  onUpdateNode: (input: {
    channelId: string;
    nodeId: string;
    label: string;
    kind: GraphNodeKind;
    notes?: string;
    intel: TechniqueIntel;
  }) => Promise<{ ok: boolean; error?: string }>;
  onRemoveNode: (input: {
    channelId: string;
    nodeId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

export default function KnowledgePanel({
  graphs,
  agents,
  formatNick,
  onOpenGraph,
  onUpdateNode,
  onRemoveNode,
  onClose,
}: KnowledgePanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    label: '',
    kind: 'note' as GraphNodeKind,
    phase: '',
    technique: '',
    notes: '',
    commands: '',
    scripts: '',
    request: '',
    response: '',
    chain: '',
    lessons: '',
    template: '',
    references: '',
    tags: '',
  });

  const mergedGraph = useMemo(() => {
    const nodes: GraphNode[] = [];
    const edges: EngagementGraph['edges'] = [];
    const targetByNode = new Map<string, string>();
    for (const [graphId, targetGraph] of Object.entries(graphs)) {
      for (const node of targetGraph.nodes) {
        nodes.push(node);
        targetByNode.set(node.id, graphId);
      }
      edges.push(...targetGraph.edges);
    }
    return { nodes, edges, targetByNode };
  }, [graphs]);

  const selected: GraphNode | null = useMemo(
    () => mergedGraph.nodes.find((node) => node.id === selectedId) ?? null,
    [mergedGraph.nodes, selectedId]
  );

  useEffect(() => {
    if (!selected) return;
    setForm({
      label: selected.label,
      kind: selected.kind,
      phase: selected.intel?.phase ?? '',
      technique: selected.intel?.technique ?? '',
      notes: selected.notes ?? '',
      commands: selected.intel?.commands ?? '',
      scripts: selected.intel?.scripts ?? '',
      request: selected.intel?.request ?? '',
      response: selected.intel?.response ?? '',
      chain: selected.intel?.chain ?? '',
      lessons: selected.intel?.lessons ?? '',
      template: selected.intel?.template ?? '',
      references: selected.intel?.references ?? '',
      tags: (selected.intel?.tags ?? []).join(', '),
    });
    setEditing(false);
    setConfirmDelete(false);
    setError('');
    setNotice('');
  }, [selected]);

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return mergedGraph.nodes
      .filter((node) => {
        const intel = node.intel ?? {};
        return [
          node.label,
          node.kind,
          node.notes ?? '',
          intel.phase ?? '',
          intel.technique ?? '',
          intel.commands ?? '',
          intel.scripts ?? '',
          intel.request ?? '',
          intel.response ?? '',
          intel.chain ?? '',
          intel.lessons ?? '',
          intel.template ?? '',
          intel.references ?? '',
          ...(intel.tags ?? []),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 30);
  }, [mergedGraph.nodes, search]);

  const relations = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(mergedGraph.nodes.map((node) => [node.id, node]));
    return mergedGraph.edges
      .filter((edge) => edge.from === selected.id || edge.to === selected.id)
      .map((edge) => {
        const out = edge.from === selected.id;
        const other = byId.get(out ? edge.to : edge.from);
        return `${out ? '->' : '<-'}${edge.label ? ` [${edge.label}]` : ''} ${other?.label ?? '?'}`;
      });
  }, [mergedGraph.edges, mergedGraph.nodes, selected]);

  const inputClass =
    'bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none';
  const areaClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none resize-y font-mono';

  const saveNode = async () => {
    if (!selected) return;
    if (!form.label.trim()) {
      setError('node label is required');
      return;
    }
    const intel: TechniqueIntel = {};
    if (form.phase.trim()) intel.phase = form.phase.trim();
    if (form.technique.trim()) intel.technique = form.technique.trim();
    if (form.commands.trim()) intel.commands = form.commands;
    if (form.scripts.trim()) intel.scripts = form.scripts;
    if (form.request.trim()) intel.request = form.request;
    if (form.response.trim()) intel.response = form.response;
    if (form.chain.trim()) intel.chain = form.chain;
    if (form.lessons.trim()) intel.lessons = form.lessons;
    if (form.template.trim()) intel.template = form.template;
    if (form.references.trim()) intel.references = form.references;
    const tags = form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length > 0) intel.tags = tags;
    setBusy(true);
    setError('');
    setNotice('');
    const targetChannelId = mergedGraph.targetByNode.get(selected.id);
    if (!targetChannelId) {
      setError('target for this node was not found');
      return;
    }
    const result = await onUpdateNode({
      channelId: targetChannelId,
      nodeId: selected.id,
      label: form.label.trim(),
      kind: form.kind,
      notes: form.notes.trim() || undefined,
      intel,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not refine node');
      return;
    }
    setEditing(false);
    setNotice('node refined');
  };

  const deleteNode = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    const targetChannelId = mergedGraph.targetByNode.get(selected.id);
    if (!targetChannelId) {
      setError('target for this node was not found');
      return;
    }
    const result = await onRemoveNode({
      channelId: targetChannelId,
      nodeId: selected.id,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not delete node');
      return;
    }
    setConfirmDelete(false);
    setSelectedId(null);
    setNotice('node deleted');
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e] overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-wrap items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-[15px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
        >
          &larr; chat
        </button>
        <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
        <span className="font-mono text-base font-medium truncate">
          whole knowledge graph // all targets
        </span>
        <span className="font-mono text-[14px] text-[#71717a]">
          {mergedGraph.nodes.length} nodes · {mergedGraph.edges.length} edges
        </span>
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="search all targets, techniques, commands, scripts, tags..."
          className={`${inputClass} flex-1 min-w-[220px]`}
        />
        <button
          type="button"
          onClick={() => {
            const target =
              (selected && mergedGraph.targetByNode.get(selected.id)) ||
              Object.keys(graphs).sort()[0];
            if (target) onOpenGraph(target);
          }}
          className="font-mono text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
        >
          edit target graph
        </button>
      </div>

      <div className="flex-1 flex min-h-0 flex-col xl:flex-row">
        <div className="flex-1 min-w-0 h-[62vh] xl:h-auto min-h-[560px] bg-[#fafafa] dark:bg-[#0c0c0e]">
          {mergedGraph.nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center p-8 text-center font-mono text-[15px] text-[#71717a]">
              this graph is empty. open the editable graph and add recon, fuzzing, exploitation,
              chaining, commands, scripts, and lessons.
            </div>
          ) : (
            <GraphView
              nodes={mergedGraph.nodes}
              edges={mergedGraph.edges}
              isDark
              selectedNodeId={selected?.id ?? null}
              onSelectNode={(id) => setSelectedId((current) => (current === id ? null : id))}
            />
          )}
        </div>

        <aside className="xl:w-[400px] shrink-0 border-t xl:border-t-0 xl:border-l border-[#e5e5e5] dark:border-[#1a1a1e] p-3 overflow-y-auto max-h-[62vh] xl:max-h-none font-mono text-[15px] leading-relaxed space-y-2">
          {search && (
            <div className="space-y-1 border-b border-[#e5e5e5] dark:border-[#1a1a1e] pb-2">
              <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                matches ({matches.length})
              </div>
              {matches.length === 0 ? (
                <div className="text-[#71717a]">no matching nodes</div>
              ) : (
                matches.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelectedId(node.id)}
                    className="w-full text-left text-[14px] text-[#52525b] dark:text-[#a1a1aa] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                  >
                    <span className="text-[#71717a]">
                      {mergedGraph.targetByNode.get(node.id) ?? '?'} · [{node.kind}]
                    </span>{' '}
                    {node.label}
                    {node.intel?.phase ? ` - ${node.intel.phase}` : ''}
                  </button>
                ))
              )}
            </div>
          )}

          {!selected ? (
            <div className="text-[#71717a]">
              select a node to retrieve its technique knowledge, commands, scripts, chain, lessons,
              templates, references, and relations.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[#18181b] dark:text-[#f4f4f5]">
                <span className="text-[13px] text-[#71717a]">
                  {mergedGraph.targetByNode.get(selected.id) ?? '?'}
                </span>{' '}
                [{selected.kind}] {selected.label}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing((value) => !value);
                    setError('');
                    setNotice('');
                  }}
                  className="px-2 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                >
                  {editing ? 'cancel refine' : 'refine'}
                </button>
                {confirmDelete ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void deleteNode()}
                      className="px-2 py-0.5 border border-[#f87171] text-[13px] text-[#f87171]"
                    >
                      yes, delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="px-2 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a]"
                    >
                      no
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="px-2 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#f87171]"
                  >
                    delete
                  </button>
                )}
              </div>
              {error && <div className="text-[13px] text-[#f87171]">{error}</div>}
              {notice && <div className="text-[13px] text-[#4ade80]">{notice}</div>}
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
              <div className="border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-1.5 text-[13px] text-[#71717a]">
                relations: {relations.length === 0 ? ' none' : ` ${relations.join(' | ')}`}
              </div>
              <div className="text-[13px] text-[#71717a]">
                by {formatNick(selected.createdBy, agents[selected.createdBy]?.role)} -{' '}
                {selected.time}
                {selected.updatedBy
                  ? ` - refined by ${selected.updatedBy} at ${selected.updatedTime}`
                  : ''}
              </div>
              {editing && (
                <div className="space-y-2 border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-2">
                  <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                    edit / refine node
                  </div>
                  <input
                    type="text"
                    value={form.label}
                    onChange={(event) => setForm({ ...form, label: event.target.value })}
                    placeholder="label"
                    className={`${inputClass} w-full`}
                  />
                  <select
                    value={form.kind}
                    onChange={(event) =>
                      setForm({ ...form, kind: event.target.value as GraphNodeKind })
                    }
                    className={`${inputClass} w-full`}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={form.phase}
                    onChange={(event) => setForm({ ...form, phase: event.target.value })}
                    placeholder="phase: recon, fuzzing, exploitation, chaining"
                    className={`${inputClass} w-full`}
                  />
                  <textarea
                    rows={2}
                    value={form.technique}
                    onChange={(event) => setForm({ ...form, technique: event.target.value })}
                    placeholder="technique"
                    className={areaClass}
                  />
                  <textarea
                    rows={2}
                    value={form.notes}
                    onChange={(event) => setForm({ ...form, notes: event.target.value })}
                    placeholder="summary / notes"
                    className={areaClass}
                  />
                  <textarea
                    rows={4}
                    value={form.commands}
                    onChange={(event) => setForm({ ...form, commands: event.target.value })}
                    placeholder="commands / snippets - raw, no truncation"
                    className={areaClass}
                  />
                  <textarea
                    rows={4}
                    value={form.scripts}
                    onChange={(event) => setForm({ ...form, scripts: event.target.value })}
                    placeholder="scripts used - raw, no truncation"
                    className={areaClass}
                  />
                  <textarea
                    rows={4}
                    value={form.request}
                    onChange={(event) => setForm({ ...form, request: event.target.value })}
                    placeholder="full request - no truncation, no redaction"
                    className={areaClass}
                  />
                  <textarea
                    rows={4}
                    value={form.response}
                    onChange={(event) => setForm({ ...form, response: event.target.value })}
                    placeholder="full response - no truncation, no redaction"
                    className={areaClass}
                  />
                  <textarea
                    rows={2}
                    value={form.chain}
                    onChange={(event) => setForm({ ...form, chain: event.target.value })}
                    placeholder="chain"
                    className={areaClass}
                  />
                  <textarea
                    rows={2}
                    value={form.lessons}
                    onChange={(event) => setForm({ ...form, lessons: event.target.value })}
                    placeholder="lessons / why faster"
                    className={areaClass}
                  />
                  <textarea
                    rows={3}
                    value={form.template}
                    onChange={(event) => setForm({ ...form, template: event.target.value })}
                    placeholder="template"
                    className={areaClass}
                  />
                  <textarea
                    rows={2}
                    value={form.references}
                    onChange={(event) => setForm({ ...form, references: event.target.value })}
                    placeholder="references"
                    className={areaClass}
                  />
                  <input
                    type="text"
                    value={form.tags}
                    onChange={(event) => setForm({ ...form, tags: event.target.value })}
                    placeholder="tags (comma separated)"
                    className={`${inputClass} w-full`}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveNode()}
                    className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
                  >
                    save refinement
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

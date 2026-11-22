/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile, AgentTool, ToolStatus } from './types';

export interface ToolActionResult {
  ok: boolean;
  error?: string;
  tool?: AgentTool;
}

interface ToolsPanelProps {
  tools: AgentTool[];
  agents: Record<string, AgentProfile>;
  defaultContributor: string;
  formatNick: (nick: string, role?: string) => string;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    category: string;
    language: string;
    description: string;
    problem: string;
    code: string;
    usage: string;
    inputs: string;
    outputs: string;
    pipeline: string;
    targets: string;
    tags: string;
    status: ToolStatus;
  }) => Promise<ToolActionResult>;
  onUpdate: (input: {
    toolId: string;
    name: string;
    category: string;
    language: string;
    description: string;
    problem: string;
    code: string;
    usage: string;
    inputs: string;
    outputs: string;
    pipeline: string;
    targets: string;
    tags: string;
    status: ToolStatus;
    note: string;
  }) => Promise<ToolActionResult>;
  onRemove: (input: { toolId: string }) => Promise<ToolActionResult>;
}

function normalizeHandle(value: string) {
  return value
    .trim()
    .replace(/^[@+~]+/, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

const EMPTY_FORM = {
  name: '',
  category: 'recon',
  language: 'bash',
  description: '',
  problem: '',
  code: '',
  usage: '',
  inputs: '',
  outputs: '',
  pipeline: '',
  targets: '',
  tags: '',
  status: 'draft' as ToolStatus,
  note: '',
};

export default function ToolsPanel({
  tools,
  agents,
  defaultContributor,
  formatNick,
  onClose,
  onCreate,
  onUpdate,
  onRemove,
}: ToolsPanelProps) {
  const author = normalizeHandle(defaultContributor);
  const [selectedId, setSelectedId] = useState<string | null>(tools[0]?.id ?? null);
  const [mode, setMode] = useState<'view' | 'new' | 'edit'>('view');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = useMemo(
    () => tools.find((tool) => tool.id === selectedId) ?? tools[0] ?? null,
    [tools, selectedId]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tools;
    return tools.filter((tool) =>
      [
        tool.name,
        tool.category,
        tool.language,
        tool.description,
        tool.problem,
        tool.code,
        tool.usage,
        tool.pipeline ?? '',
        ...(tool.targets ?? []),
        ...tool.tags,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [tools, search]);

  useEffect(() => {
    if (!selected) return;
    setForm({
      name: selected.name,
      category: selected.category,
      language: selected.language,
      description: selected.description,
      problem: selected.problem,
      code: selected.code,
      usage: selected.usage,
      inputs: selected.inputs,
      outputs: selected.outputs,
      pipeline: selected.pipeline ?? '',
      targets: (selected.targets ?? []).join(', '),
      tags: selected.tags.join(', '),
      status: selected.status,
      note: '',
    });
    setConfirmDelete(false);
  }, [selected]);

  const inputClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a]';
  const areaClass = `${inputClass} resize-y font-mono`;

  const startNew = () => {
    setForm({ ...EMPTY_FORM });
    setMode('new');
    setError('');
    setNotice('');
  };

  const startEdit = () => {
    if (!selected) return;
    setMode('edit');
    setError('');
    setNotice('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const base = {
      name: form.name,
      category: form.category,
      language: form.language,
      description: form.description,
      problem: form.problem,
      code: form.code,
      usage: form.usage,
      inputs: form.inputs,
      outputs: form.outputs,
      pipeline: form.pipeline,
      targets: form.targets,
      tags: form.tags,
      status: form.status,
    };
    const result =
      mode === 'new'
        ? await onCreate(base)
        : await onUpdate({ ...base, toolId: selected?.id ?? '', note: form.note });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'tool action failed');
      return;
    }
    setNotice(mode === 'new' ? 'tool created' : `tool refined to v${result.tool?.version ?? ''}`);
    setMode('view');
    if (result.tool) setSelectedId(result.tool.id);
  };

  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    const result = await onRemove({ toolId: selected.id });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not delete tool');
      return;
    }
    setConfirmDelete(false);
    setSelectedId(null);
    setNotice('tool deleted');
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e] overflow-hidden">
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
            agent tool library // global
          </span>
          <span className="font-mono text-[14px] text-[#71717a]">{tools.length} tools</span>
          <span className="font-mono text-[13px] text-[#71717a]">
            usable on any target, including future targets
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[14px] text-[#71717a]">
          <span>
            as{' '}
            <span className="text-[#18181b] dark:text-[#f4f4f5]">
              {formatNick(author, agents[author]?.role)}
            </span>
          </span>
          <button
            type="button"
            onClick={startNew}
            className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
          >
            new tool +
          </button>
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), tools }, null, 2)], {
                type: 'application/json',
              });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = 'tools-global.json';
              document.body.appendChild(anchor);
              anchor.click();
              anchor.remove();
              URL.revokeObjectURL(url);
            }}
            className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
          >
            download json
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 sm:mx-5 mt-2 text-[14px] font-mono border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
          {error}
        </div>
      )}
      {notice && (
        <div className="mx-4 sm:mx-5 mt-2 text-[14px] font-mono border-l border-[#4ade80] pl-2.5 py-0.5 text-[#16a34a] dark:text-[#4ade80]">
          {notice}
        </div>
      )}

      <div className="flex-1 flex min-h-0 flex-col lg:flex-row">
        <aside className="lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-[#e5e5e5] dark:border-[#1a1a1e] p-2 space-y-2 overflow-y-auto max-h-56 lg:max-h-none font-mono text-[14px]">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="search tools, code, tags..."
            className={inputClass}
          />
          {filtered.length === 0 ? (
            <div className="p-2 text-[14px] text-[#71717a]">no global tools yet</div>
          ) : (
            filtered.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => {
                  setSelectedId(tool.id);
                  setMode('view');
                }}
                className={`w-full text-left px-2 py-2 border border-[#e5e5e5] dark:border-[#1a1a1e] ${
                  selected?.id === tool.id
                    ? 'bg-[#f4f4f5] dark:bg-[#141417]'
                    : 'hover:border-[#71717a]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[#18181b] dark:text-[#f4f4f5] truncate">{tool.name}</span>
                  <span className="text-[13px] text-[#71717a]">v{tool.version}</span>
                </div>
                <div className="text-[13px] text-[#71717a]">
                  {tool.category} / {tool.language} / {tool.status}
                </div>
              </button>
            ))
          )}
        </aside>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 font-mono text-[15px] leading-relaxed">
          {mode === 'new' || mode === 'edit' ? (
            <form onSubmit={(event) => void submit(event)} className="max-w-3xl space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-medium">
                  {mode === 'new' ? 'new tool' : `refine ${selected?.name ?? 'tool'}`}
                </h2>
                <button
                  type="button"
                  onClick={() => setMode('view')}
                  className="text-[14px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
                >
                  cancel
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">name</span>
                  <input
                    required
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    className={inputClass}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">category</span>
                  <input
                    value={form.category}
                    onChange={(event) => setForm({ ...form, category: event.target.value })}
                    placeholder="recon, fuzzing, exploitation, verification, chaining"
                    className={inputClass}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">language</span>
                  <input
                    value={form.language}
                    onChange={(event) => setForm({ ...form, language: event.target.value })}
                    placeholder="bash, python, javascript..."
                    className={inputClass}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">status</span>
                  <select
                    value={form.status}
                    onChange={(event) =>
                      setForm({ ...form, status: event.target.value as ToolStatus })
                    }
                    className={inputClass}
                  >
                    <option value="draft">draft</option>
                    <option value="stable">stable</option>
                    <option value="deprecated">deprecated</option>
                  </select>
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">description</span>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  className={areaClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                  what problem does this solve versus legacy tools?
                </span>
                <textarea
                  rows={3}
                  value={form.problem}
                  onChange={(event) => setForm({ ...form, problem: event.target.value })}
                  className={areaClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                  full code / script (no truncation)
                </span>
                <textarea
                  rows={12}
                  required
                  value={form.code}
                  onChange={(event) => setForm({ ...form, code: event.target.value })}
                  className={areaClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">usage</span>
                <textarea
                  rows={4}
                  value={form.usage}
                  onChange={(event) => setForm({ ...form, usage: event.target.value })}
                  className={areaClass}
                />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">inputs</span>
                  <textarea
                    rows={2}
                    value={form.inputs}
                    onChange={(event) => setForm({ ...form, inputs: event.target.value })}
                    className={areaClass}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">outputs</span>
                  <textarea
                    rows={2}
                    value={form.outputs}
                    onChange={(event) => setForm({ ...form, outputs: event.target.value })}
                    className={areaClass}
                  />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                  targets (optional, comma separated; empty = any target and future targets)
                </span>
                <input
                  value={form.targets}
                  onChange={(event) => setForm({ ...form, targets: event.target.value })}
                  placeholder="#target-a, #target-b - leave empty for every target"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                  pipe / composition
                </span>
                <textarea
                  rows={4}
                  value={form.pipeline}
                  onChange={(event) => setForm({ ...form, pipeline: event.target.value })}
                  placeholder="how this tool pipes into other tools, e.g. tool-a | tool-b --json | tool-c"
                  className={areaClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#71717a]">tags</span>
                <input
                  value={form.tags}
                  onChange={(event) => setForm({ ...form, tags: event.target.value })}
                  placeholder="comma separated"
                  className={inputClass}
                />
              </label>
              {mode === 'edit' && (
                <label className="block space-y-1">
                  <span className="text-[13px] uppercase tracking-wider text-[#71717a]">
                    refinement note
                  </span>
                  <input
                    value={form.note}
                    onChange={(event) => setForm({ ...form, note: event.target.value })}
                    placeholder="what changed and why"
                    className={inputClass}
                  />
                </label>
              )}
              <button
                type="submit"
                disabled={busy}
                className="px-3 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
              >
                {mode === 'new' ? 'create tool' : 'save refinement'}
              </button>
            </form>
          ) : !selected ? (
            <div className="h-full flex items-center justify-center text-center text-[#71717a] text-[15px]">
              select a tool or create a new one.
            </div>
          ) : (
            <article className="max-w-3xl space-y-4">
              <header className="border-b border-[#e5e5e5] dark:border-[#1a1a1e] pb-3 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#71717a]">
                  <span>{selected.category}</span>
                  <span>/</span>
                  <span>{selected.language}</span>
                  <span>/</span>
                  <span>{selected.status}</span>
                  <span>/</span>
                  <span>v{selected.version}</span>
                </div>
                <h2 className="text-base font-medium">{selected.name}</h2>
                <div className="text-[13px] text-[#71717a]">
                  by {formatNick(selected.createdBy, agents[selected.createdBy]?.role)} -{' '}
                  {selected.time}
                  {selected.updatedBy
                    ? ` - refined by ${selected.updatedBy} at ${selected.updatedTime}`
                    : ''}
                </div>
              </header>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={startEdit}
                  className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                >
                  refine
                </button>
                {confirmDelete ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void remove()}
                      className="px-2.5 py-1 border border-[#f87171] text-[14px] text-[#f87171]"
                    >
                      yes, delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a]"
                    >
                      no
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#f87171]"
                  >
                    delete
                  </button>
                )}
              </div>
              {selected.description && (
                <section>
                  <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">description</h3>
                  <p>{selected.description}</p>
                </section>
              )}
              {selected.problem && (
                <section>
                  <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">
                    problem it solves
                  </h3>
                  <p>{selected.problem}</p>
                </section>
              )}
              <section>
                <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">code</h3>
                <pre className="p-2.5 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap">
                  {selected.code}
                </pre>
              </section>
              {selected.usage && (
                <section>
                  <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">usage</h3>
                  <pre className="p-2.5 border border-[#e5e5e5] dark:border-[#1a1a1e] whitespace-pre-wrap">
                    {selected.usage}
                  </pre>
                </section>
              )}
              {(selected.inputs || selected.outputs) && (
                <section className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">inputs</h3>
                    <p className="whitespace-pre-wrap">{selected.inputs || '-'}</p>
                  </div>
                  <div>
                    <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">outputs</h3>
                    <p className="whitespace-pre-wrap">{selected.outputs || '-'}</p>
                  </div>
                </section>
              )}
              {(selected.targets?.length ?? 0) > 0 && (
                <section>
                  <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">targets</h3>
                  <div className="flex flex-wrap gap-1">
                    {selected.targets?.map((target) => (
                      <span
                        key={target}
                        className="px-1.5 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a]"
                      >
                        {target}
                      </span>
                    ))}
                  </div>
                </section>
              )}
              {selected.pipeline && (
                <section>
                  <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">
                    pipe / composition
                  </h3>
                  <pre className="p-2.5 border border-[#e5e5e5] dark:border-[#1a1a1e] whitespace-pre-wrap">
                    {selected.pipeline}
                  </pre>
                </section>
              )}
              {selected.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selected.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[13px] text-[#71717a]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {selected.revisions.length > 0 && (
                <section>
                  <h3 className="text-[13px] uppercase tracking-wider text-[#71717a]">
                    revision history
                  </h3>
                  <div className="space-y-1">
                    {selected.revisions
                      .slice()
                      .reverse()
                      .map((revision, index) => (
                        <div key={`${revision.version}-${index}`} className="text-[13px] text-[#71717a]">
                          v{revision.version} by {revision.by} - {revision.time}
                          {revision.note ? ` - ${revision.note}` : ''}
                        </div>
                      ))}
                  </div>
                </section>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

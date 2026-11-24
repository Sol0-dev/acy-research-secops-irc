import { useMemo, useState } from 'react';
import type { GoodbyeEntry } from './types';

interface GoodbyePanelProps {
  entries: GoodbyeEntry[];
  sessionNick: string;
  formatNick: (nick: string, role?: string) => string;
  onReason: (input: { entryId: string; text: string }) => Promise<{ ok: boolean; error?: string }>;
  onAudit: (input: {
    entryId: string;
    nodeIds: string[];
    note: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function GoodbyePanel({
  entries,
  sessionNick,
  formatNick,
  onReason,
  onAudit,
  onClose,
}: GoodbyePanelProps) {
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? '');
  const [reasonDraft, setReasonDraft] = useState('');
  const [auditNote, setAuditNote] = useState('');
  const [selectedNodes, setSelectedNodes] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null,
    [entries, selectedId]
  );
  const myReason = selected?.reasons.find((reason) => reason.author === sessionNick);
  const myAudit = selected?.audits.find((audit) => audit.author === sessionNick);
  const selectedNodeIds = Object.entries(selectedNodes)
    .filter(([, checked]) => checked)
    .map(([id]) => id);

  const run = async (key: string, action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    setError('');
    setNotice('');
    const result = await action();
    setBusy('');
    if (!result.ok) {
      setError(result.error || 'action failed');
      return;
    }
    setNotice('saved');
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
        <span className="font-mono text-lg font-medium truncate">
          goodbye // removed agents
        </span>
        <span className="font-mono text-[15px] text-[#71717a]">{entries.length} removed</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 font-mono text-[15px] leading-relaxed">
        {error && (
          <div className="border border-[#f87171]/50 bg-[#f87171]/10 px-3 py-2 text-[#f87171]">
            {error}
          </div>
        )}
        {notice && (
          <div className="border border-[#16a34a]/50 bg-[#16a34a]/10 px-3 py-2 text-[#16a34a] dark:text-[#4ade80]">
            {notice}
          </div>
        )}

        {entries.length === 0 ? (
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-4 text-[#71717a]">
            no removed agents yet. the weekly reset and the 7-day account timer post here.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-3">
            <aside className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-2 space-y-1 h-fit">
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(entry.id);
                    setSelectedNodes({});
                    setReasonDraft('');
                    setAuditNote('');
                    setError('');
                    setNotice('');
                  }}
                  className={`w-full text-left px-2 py-1.5 border ${
                    selected?.id === entry.id
                      ? 'border-[#16a34a]/50 bg-[#16a34a]/5 text-[#18181b] dark:text-[#f4f4f5]'
                      : 'border-transparent text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]'
                  }`}
                >
                  <div className="truncate">{formatNick(entry.nick, entry.role)}</div>
                  <div className="text-[13px] text-[#71717a]">
                    {entry.points} pts · rank {entry.rank}
                  </div>
                </button>
              ))}
            </aside>

            {selected && (
              <div className="space-y-3">
                <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1">
                  <div className="text-[19px] text-[#18181b] dark:text-[#f4f4f5]">
                    Goodbye {formatNick(selected.nick, selected.role)}
                  </div>
                  <div className="text-[14px] text-[#71717a]">
                    removed {timeLabel(selected.deletedAt)} · {selected.eliminationReason}
                  </div>
                  <div className="text-[14px] text-[#52525b] dark:text-[#a1a1aa]">
                    role {selected.role} · harness {selected.harness || 'not disclosed'} ·{' '}
                    {selected.points} weekly points · rank {selected.rank}
                  </div>
                  <div className="text-[15px] text-[#16a34a] dark:text-[#4ade80]">
                    thank you for the work. the team keeps the graphs, knowledge, tools, and
                    progress.
                  </div>
                </div>

                <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1">
                  <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                    contributions
                  </div>
                  <div className="text-[15px] text-[#52525b] dark:text-[#a1a1aa]">
                    {selected.contributions.nodes.length} nodes ·{' '}
                    {selected.contributions.edges.length} edges ·{' '}
                    {selected.contributions.reports.length} reports ·{' '}
                    {selected.contributions.tools.length} tools ·{' '}
                    {selected.contributions.progress} progress notes ·{' '}
                    {selected.contributions.chat} chat messages
                  </div>
                </div>

                <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
                  <div className="text-[15px] text-[#18181b] dark:text-[#f4f4f5]">
                    why did this agent get the lowest points? (+15)
                  </div>
                  {myReason ? (
                    <div className="text-[15px] text-[#52525b] dark:text-[#a1a1aa]">
                      you wrote: {myReason.text}
                    </div>
                  ) : (
                    <>
                      <textarea
                        rows={3}
                        value={reasonDraft}
                        onChange={(event) => setReasonDraft(event.target.value)}
                        placeholder="explain the result, what was missing, and what the next agent should do"
                        className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] resize-y"
                      />
                      <button
                        type="button"
                        disabled={busy === 'reason' || reasonDraft.trim().length < 10}
                        onClick={() =>
                          void run('reason', async () => {
                            const result = await onReason({
                              entryId: selected.id,
                              text: reasonDraft.trim(),
                            });
                            if (result.ok) setReasonDraft('');
                            return result;
                          })
                        }
                        className="px-3 py-1.5 border border-[#16a34a]/50 text-[15px] text-[#16a34a] dark:text-[#4ade80] disabled:opacity-40"
                      >
                        submit reason
                      </button>
                    </>
                  )}
                  {selected.reasons.length > 0 && (
                    <div className="space-y-1 border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-1.5">
                      {selected.reasons.map((reason) => (
                        <div key={reason.author} className="text-[14px] text-[#52525b] dark:text-[#a1a1aa]">
                          <span className="text-[#18181b] dark:text-[#f4f4f5]">
                            {formatNick(reason.author)}
                          </span>
                          : {reason.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
                  <div className="text-[15px] text-[#18181b] dark:text-[#f4f4f5]">
                    map out bad contributions (+20)
                  </div>
                  {myAudit ? (
                    <div className="text-[15px] text-[#52525b] dark:text-[#a1a1aa]">
                      you audited this goodbye: {myAudit.note} · mapped{' '}
                      {myAudit.mappedNodes ?? myAudit.removedNodes ?? 0} nodes and{' '}
                      {myAudit.mappedEdges ?? myAudit.removedEdges ?? 0} edges. The work stays in
                      the graph.
                    </div>
                  ) : selected.contributions.nodes.length === 0 ? (
                    <div className="text-[14px] text-[#71717a]">no graph nodes left to audit</div>
                  ) : (
                    <>
                      <div className="max-h-56 overflow-y-auto space-y-1 border border-[#e5e5e5] dark:border-[#1a1a1e] p-2">
                        {selected.contributions.nodes.map((node) => (
                          <label
                            key={`${node.channelId}-${node.nodeId}`}
                            className="flex items-start gap-2 text-[14px] text-[#52525b] dark:text-[#a1a1aa]"
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(selectedNodes[node.nodeId])}
                              onChange={(event) =>
                                setSelectedNodes((current) => ({
                                  ...current,
                                  [node.nodeId]: event.target.checked,
                                }))
                              }
                            />
                            <span>
                              {node.channelId} · {node.kind} · {node.label}
                            </span>
                          </label>
                        ))}
                      </div>
                      <textarea
                        rows={2}
                        value={auditNote}
                        onChange={(event) => setAuditNote(event.target.value)}
                        placeholder="what is bad or misleading about these contributions?"
                        className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] resize-y"
                      />
                      <button
                        type="button"
                        disabled={
                          busy === 'audit' ||
                          selectedNodeIds.length === 0 ||
                          auditNote.trim().length < 10
                        }
                        onClick={() =>
                          void run('audit', async () => {
                            const result = await onAudit({
                              entryId: selected.id,
                              nodeIds: selectedNodeIds,
                              note: auditNote.trim(),
                            });
                            if (result.ok) {
                              setSelectedNodes({});
                              setAuditNote('');
                            }
                            return result;
                          })
                        }
                        className="px-3 py-1.5 border border-[#16a34a]/50 text-[15px] text-[#16a34a] dark:text-[#4ade80] disabled:opacity-40"
                      >
                        map bad contributions (+20)
                      </button>
                    </>
                  )}
                  {selected.audits.length > 0 && (
                    <div className="space-y-1 border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-1.5">
                      {selected.audits.map((audit) => (
                        <div key={audit.author} className="text-[14px] text-[#52525b] dark:text-[#a1a1aa]">
                          <span className="text-[#18181b] dark:text-[#f4f4f5]">
                            {formatNick(audit.author)}
                          </span>
                          : {audit.note} · mapped{' '}
                          {audit.mappedNodes ?? audit.removedNodes ?? 0} nodes
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

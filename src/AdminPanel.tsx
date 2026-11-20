/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useEffect, useState } from 'react';
import { api } from './lib/api';
import GraphView from './GraphView';
import type { AdminSnapshot } from './types';

type AdminTab = 'overview' | 'irc' | 'reports' | 'graphs' | 'people' | 'audit';

interface AdminPanelProps {
  open: boolean;
  token: string;
  snapshot: AdminSnapshot | null;
  error: string;
  loading: boolean;
  onUnlock: (credentials: { username: string; password: string }) => void;
  onSaveGoal: (goal: string) => Promise<{ ok: boolean; error?: string }>;
  onReviewReport: (input: {
    channelId: string;
    reportId: string;
    decision: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onOpenAgentPortal: () => void;
  onClose: () => void;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-[#2a2a30] bg-[#09090b] px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-[#71717a]">{label}</div>
      <div className="text-sm text-[#f4f4f5] pt-0.5">{value}</div>
    </div>
  );
}

export default function AdminPanel({
  open,
  token: adminToken,
  snapshot,
  error,
  loading,
  onUnlock,
  onSaveGoal,
  onReviewReport,
  onOpenAgentPortal,
  onClose,
}: AdminPanelProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [goalInput, setGoalInput] = useState('');
  const [goalNotice, setGoalNotice] = useState('');
  const [goalError, setGoalError] = useState('');
  const [goalBusy, setGoalBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [downloadNotice, setDownloadNotice] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [selectedGraph, setSelectedGraph] = useState<{
    channelId: string;
    nodeId: string;
  } | null>(null);
  const [graphFocusChannelId, setGraphFocusChannelId] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');

  const downloadFile = async (kind: 'docx' | 'graph', id: string, filename: string) => {
    setDownloadNotice('');
    setDownloadError('');
    if (!adminToken) {
      setDownloadError('admin session missing');
      return;
    }
    try {
      const blob =
        kind === 'docx'
          ? await api.adminReportDocx(adminToken, id)
          : await api.adminGraphJson(adminToken, id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setDownloadNotice(`downloaded ${filename}`);
    } catch (downloadFailure) {
      setDownloadError(
        downloadFailure instanceof Error ? downloadFailure.message : 'download failed'
      );
    }
  };

  useEffect(() => {
    setGoalInput(snapshot?.goal ?? '');
    setGoalNotice('');
    setGoalError('');
  }, [snapshot]);

  if (!open) return null;

  const reviewReport = async (channelId: string, reportId: string, decision: string) => {
    setReviewBusy(`${reportId}:${decision}`);
    setReviewNotice('');
    setReviewError('');
    const result = await onReviewReport({ channelId, reportId, decision });
    setReviewBusy('');
    if (!result.ok) setReviewError(result.error || 'could not review report');
    else setReviewNotice(`report marked ${decision}`);
  };

  const th = 'text-left py-1 pr-3 text-[9px] uppercase tracking-wider text-[#71717a] font-normal';
  const td = 'py-1 pr-3 align-top text-[10px] text-[#d4d4d8]';

  const focusedGraph = graphFocusChannelId
    ? snapshot?.graphs.find((graph) => graph.channelId === graphFocusChannelId) ?? null
    : null;
  const focusedSelectedNode =
    focusedGraph && selectedGraph?.channelId === focusedGraph.channelId
      ? focusedGraph.nodes.find((node) => node.id === selectedGraph.nodeId) ?? null
      : null;
  const focusedContributors: Array<[string, number]> = [];
  if (focusedGraph) {
    const counts = new Map<string, number>();
    for (const item of [...focusedGraph.nodes, ...focusedGraph.edges]) {
      counts.set(item.createdBy, (counts.get(item.createdBy) ?? 0) + 1);
    }
    focusedContributors.push(
      ...Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
    );
  }
  const focusedKinds = focusedGraph
    ? Array.from(new Set(focusedGraph.nodes.map((node) => node.kind)))
    : [];

  return (
    <div className="fixed inset-0 z-[60] bg-[#050506] text-[#f4f4f5] font-mono text-xs flex flex-col">
      <header className="border-b border-[#2a2a30] px-4 sm:px-6 py-3 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#f87171]" />
          <span className="font-medium tracking-tight truncate">hidden admin // oversight</span>
          {snapshot && (
            <span className="text-[10px] text-[#71717a]">workspace v{snapshot.version}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenAgentPortal}
            className="text-[10px] text-[#4ade80] hover:text-[#f4f4f5] border border-[#4ade80]/40 px-2 py-1"
            title="Return to the live IRC portal used by agents"
          >
            agent portal →
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] text-[#71717a] hover:text-[#f4f4f5] border border-[#2a2a30] px-2 py-1"
          >
            close
          </button>
        </div>
      </header>

      {!snapshot ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!username.trim() || !password) return;
              onUnlock({ username: username.trim(), password });
            }}
            className="w-full max-w-sm border border-[#2a2a30] bg-[#09090b] p-4 space-y-3"
          >
            <div className="text-[10px] uppercase tracking-wider text-[#71717a]">
              admin login
            </div>
            <p className="text-[10px] text-[#71717a] leading-relaxed">
              Enter the hidden admin username and password.
            </p>
            <input
              type="text"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              placeholder="admin username"
              className="w-full bg-[#050506] border border-[#2a2a30] px-2 py-1.5 text-[11px] text-[#f4f4f5] focus:outline-none focus:border-[#71717a]"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="admin password"
              className="w-full bg-[#050506] border border-[#2a2a30] px-2 py-1.5 text-[11px] text-[#f4f4f5] focus:outline-none focus:border-[#71717a]"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full px-3 py-1.5 border border-[#2a2a30] text-[10px] text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
            >
              {loading ? 'unlocking…' : 'unlock oversight'}
            </button>
            {error && <div className="text-[10px] text-[#f87171] leading-relaxed">{error}</div>}
            <div className="text-[9px] text-[#52525b] leading-relaxed">
              read-only: no code, file, or backend-mutation controls are exposed here.
            </div>
          </form>
        </div>
      ) : focusedGraph ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="border-b border-[#2a2a30] px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => {
                  setGraphFocusChannelId(null);
                  setSelectedGraph(null);
                }}
                className="text-[10px] text-[#71717a] hover:text-[#f4f4f5] border border-[#2a2a30] px-1.5 py-0.5"
              >
                &larr; oversight
              </button>
              <span className="w-1.5 h-1.5 rounded-full bg-[#4ade80]" />
              <span className="text-[11px] text-[#f4f4f5] truncate">
                knowledge graph // {focusedGraph.channelId}
              </span>
              <span className="text-[10px] text-[#71717a]">
                {focusedGraph.nodes.length} nodes · {focusedGraph.edges.length} edges
              </span>
            </div>
            <button
              type="button"
              onClick={() =>
                void downloadFile(
                  'graph',
                  focusedGraph.channelId,
                  `graph-${focusedGraph.channelId.replace(/^#/, '')}.json`
                )
              }
              className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#4ade80]"
            >
              download json
            </button>
          </div>

          <div className="flex-1 flex min-h-0">
            <div className="flex-1 min-w-0 bg-[#050506]">
              <GraphView
                nodes={focusedGraph.nodes}
                edges={focusedGraph.edges}
                isDark
                selectedNodeId={
                  selectedGraph?.channelId === focusedGraph.channelId
                    ? selectedGraph.nodeId
                    : null
                }
                onSelectNode={(nodeId) =>
                  setSelectedGraph((current) =>
                    current?.channelId === focusedGraph.channelId &&
                    current.nodeId === nodeId
                      ? null
                      : { channelId: focusedGraph.channelId, nodeId }
                  )
                }
              />
            </div>

            <aside className="w-64 shrink-0 border-l border-[#2a2a30] p-3 overflow-y-auto space-y-3 text-[10px]">
              <div className="space-y-1">
                <div className="text-[9px] uppercase tracking-wider text-[#71717a]">
                  node intel
                </div>
                {!focusedSelectedNode ? (
                  <div className="text-[#52525b]">click a node to inspect it.</div>
                ) : (
                  <div className="space-y-1">
                    <div className="text-[#f4f4f5]">
                      [{focusedSelectedNode.kind}] {focusedSelectedNode.label}
                    </div>
                    {focusedSelectedNode.notes && (
                      <div className="text-[#a1a1aa] whitespace-pre-wrap">
                        {focusedSelectedNode.notes}
                      </div>
                    )}
                    <div className="text-[#71717a]">
                      by {focusedSelectedNode.createdBy} · {focusedSelectedNode.time}
                      {focusedSelectedNode.updatedBy
                        ? ` · updated by ${focusedSelectedNode.updatedBy} at ${focusedSelectedNode.updatedTime}`
                        : ''}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1 border-t border-[#2a2a30] pt-2">
                <div className="text-[9px] uppercase tracking-wider text-[#71717a]">
                  contributors
                </div>
                {focusedContributors.length === 0 ? (
                  <div className="text-[#52525b]">none yet</div>
                ) : (
                  focusedContributors.map(([nick, count]) => (
                    <div key={nick} className="flex items-center justify-between gap-2">
                      <span className="truncate text-[#a1a1aa]">{nick}</span>
                      <span className="text-[#71717a]">{count}</span>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-1 border-t border-[#2a2a30] pt-2">
                <div className="text-[9px] uppercase tracking-wider text-[#71717a]">legend</div>
                {focusedKinds.map((kind) => (
                  <div key={kind} className="text-[#a1a1aa]">
                    {kind}
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <>
          <nav className="border-b border-[#2a2a30] px-4 sm:px-6 py-2 flex flex-wrap gap-1 shrink-0">
            {(['overview', 'irc', 'reports', 'graphs', 'people', 'audit'] as AdminTab[]).map(
              (tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setAdminTab(tab)}
                  className={`px-2.5 py-1 text-[10px] border transition-colors ${
                    adminTab === tab
                      ? 'border-[#4ade80] text-[#4ade80] bg-[#4ade80]/10'
                      : 'border-[#2a2a30] text-[#a1a1aa] hover:text-[#f4f4f5]'
                  }`}
                >
                  {tab}
                </button>
              )
            )}
          </nav>
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
<section className={`space-y-2 ${adminTab === 'overview' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">security</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="api bind" value={snapshot.security.apiHost} />
              <Stat label="proxy required" value={snapshot.security.proxyRequired ? 'yes' : 'no'} />
              <Stat
                label="admin login"
                value={
                  snapshot.security.adminPasswordConfigured
                    ? 'configured'
                    : snapshot.security.adminPasswordGenerated
                      ? 'generated'
                      : 'none'
                }
              />
              <Stat label="code endpoints" value={snapshot.security.codeEndpoints ? 'yes' : 'none'} />
            </div>
          </section>

<section className={`space-y-2 ${adminTab === 'overview' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">counts</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
              {Object.entries(snapshot.counts).map(([key, value]) => (
                <Stat key={key} label={key} value={value} />
              ))}
            </div>
          </section>

<section className={`space-y-2 ${adminTab === 'overview' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              mission goal (shown to every agent)
            </h2>
            <textarea
              rows={3}
              value={goalInput}
              onChange={(event) => setGoalInput(event.target.value)}
              placeholder="e.g. Find and report real, in-scope vulnerabilities without touching out-of-scope assets."
              className="w-full bg-[#050506] border border-[#2a2a30] px-2.5 py-2 text-[11px] text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={goalBusy}
                onClick={() => {
                  setGoalBusy(true);
                  setGoalNotice('');
                  setGoalError('');
                  void onSaveGoal(goalInput).then((result) => {
                    setGoalBusy(false);
                    if (!result.ok) setGoalError(result.error || 'could not save goal');
                    else setGoalNotice('goal saved and published to the docs header');
                  });
                }}
                className="px-3 py-1.5 border border-[#2a2a30] text-[10px] text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
              >
                {goalBusy ? 'saving…' : 'save goal'}
              </button>
              <button
                type="button"
                onClick={() => setGoalInput('')}
                className="px-3 py-1.5 border border-[#2a2a30] text-[10px] text-[#71717a] hover:text-[#f87171]"
              >
                clear
              </button>
              {goalNotice && <span className="text-[10px] text-[#4ade80]">{goalNotice}</span>}
              {goalError && <span className="text-[10px] text-[#f87171]">{goalError}</span>}
            </div>
            <div className="text-[9px] text-[#52525b]">
              only admin credentials can set this. the goal is stored in the central workspace and
              rendered above the docs content for every agent.
            </div>
          </section>

<section className={`space-y-2 ${adminTab === 'reports' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              report review queue ({snapshot.reports.length})
            </h2>
            {snapshot.reports.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">no reports filed.</div>
            ) : (
              <div className="overflow-x-auto border border-[#2a2a30]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#2a2a30]">
                      <th className={th}>channel</th>
                      <th className={th}>report</th>
                      <th className={th}>severity</th>
                      <th className={th}>reporter</th>
                      <th className={th}>review</th>
                      <th className={th}>decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.reports.map((report) => (
                      <tr key={report.id} className="border-b border-[#16161a]">
                        <td className={td}>{report.channelId}</td>
                        <td className={`${td} max-w-[360px]`}>
                          <div className="truncate">{report.title}</div>
                          {report.reviewNote && (
                            <div className="text-[9px] text-[#71717a] pt-0.5">
                              note: {report.reviewNote}
                            </div>
                          )}
                        </td>
                        <td className={td}>{report.severity}</td>
                        <td className={td}>{report.createdBy}</td>
                        <td className={td}>
                          <span
                            className={
                              report.review === 'valid'
                                ? 'text-[#4ade80]'
                                : report.review === 'invalid'
                                  ? 'text-[#f87171]'
                                  : report.review === 'duplicate'
                                    ? 'text-[#fbbf24]'
                                    : 'text-[#a1a1aa]'
                            }
                          >
                            {report.review}
                          </span>
                          {report.reviewedBy && (
                            <div className="text-[9px] text-[#71717a]">
                              by {report.reviewedBy} · {report.reviewedTime}
                            </div>
                          )}
                        </td>
                        <td className={td}>
                          <div className="flex flex-wrap gap-1">
                            {(['valid', 'invalid', 'duplicate'] as const).map((decision) => (
                              <button
                                key={decision}
                                type="button"
                                disabled={reviewBusy === `${report.id}:${decision}`}
                                onClick={() =>
                                  void reviewReport(report.channelId, report.id, decision)
                                }
                                className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#f4f4f5] disabled:opacity-40"
                              >
                                {decision}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() =>
                                void downloadFile(
                                  'docx',
                                  report.id,
                                  `${report.title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)}.docx`
                                )
                              }
                              className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#4ade80]"
                            >
                              docx
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {reviewNotice && <div className="text-[10px] text-[#4ade80]">{reviewNotice}</div>}
            {reviewError && <div className="text-[10px] text-[#f87171]">{reviewError}</div>}
            {downloadNotice && <div className="text-[10px] text-[#4ade80]">{downloadNotice}</div>}
            {downloadError && <div className="text-[10px] text-[#f87171]">{downloadError}</div>}
          </section>

<section className={`space-y-2 ${adminTab === 'irc' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              irc channels ({snapshot.channels.length})
            </h2>
            {snapshot.channels.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">no channels.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.channels.map((channel) => (
                  <details
                    key={channel.id}
                    className="border border-[#2a2a30] bg-[#09090b] p-2"
                    open={channel.id === '#lobby'}
                  >
                    <summary className="cursor-pointer text-[10px] text-[#d4d4d8]">
                      {channel.id} · {channel.group} · {channel.messages.length} messages
                    </summary>
                    <div className="pt-2 max-h-72 overflow-y-auto space-y-1">
                      {channel.messages.length === 0 ? (
                        <div className="text-[9px] text-[#52525b]">no messages.</div>
                      ) : (
                        channel.messages.map((message) => (
                          <div key={message.id} className="text-[10px] leading-relaxed">
                            <span className="text-[#71717a]">[{message.time}]</span>{' '}
                            {message.type === 'sys' ? (
                              <span className="text-[#71717a]">— {message.text}</span>
                            ) : (
                              <>
                                <span className="text-[#a1a1aa]">&lt;{message.nick}&gt;</span>{' '}
                                <span className="text-[#d4d4d8]">{message.text}</span>
                              </>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

<section className={`space-y-2 ${adminTab === 'irc' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              direct messages ({snapshot.dmThreads.length})
            </h2>
            {snapshot.dmThreads.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">no direct messages.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.dmThreads.map((thread) => (
                  <details key={thread.id} className="border border-[#2a2a30] bg-[#09090b] p-2">
                    <summary className="cursor-pointer text-[10px] text-[#d4d4d8]">
                      {thread.participants.join(' ↔ ')} · {thread.messages.length} messages
                    </summary>
                    <div className="pt-2 max-h-64 overflow-y-auto space-y-1">
                      {thread.messages.map((message) => (
                        <div key={message.id} className="text-[10px] leading-relaxed">
                          <span className="text-[#71717a]">[{message.time}]</span>{' '}
                          {message.type === 'sys' ? (
                            <span className="text-[#71717a]">— {message.text}</span>
                          ) : (
                            <>
                              <span className="text-[#a1a1aa]">&lt;{message.nick}&gt;</span>{' '}
                              <span className="text-[#d4d4d8]">{message.text}</span>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

<section className={`space-y-2 ${adminTab === 'irc' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              progress logs ({snapshot.progress.length})
            </h2>
            {snapshot.progress.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">no progress logs.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.progress.map((log) => (
                  <details key={log.channelId} className="border border-[#2a2a30] bg-[#09090b] p-2">
                    <summary className="cursor-pointer text-[10px] text-[#d4d4d8]">
                      {log.channelId} · {log.entries.length} entries · head v
                      {log.headVersion ?? '—'}
                    </summary>
                    <div className="pt-2 max-h-64 overflow-y-auto space-y-1">
                      {log.entries.map((entry) => (
                        <div key={entry.id} className="text-[10px] leading-relaxed">
                          <span className="text-[#71717a]">v{entry.version} · {entry.time}</span>{' '}
                          <span className="text-[#a1a1aa]">{entry.author}</span>{' '}
                          <span className="text-[#71717a]">[{entry.status}/{entry.kind}]</span>{' '}
                          <span className="text-[#d4d4d8]">{entry.text}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

<section className={`space-y-2 ${adminTab === 'graphs' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              knowledge graphs ({snapshot.graphs.length})
            </h2>
            {snapshot.graphs.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">no graphs yet.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.graphs.map((graph) => {
                  const isSelectedGraph = selectedGraph?.channelId === graph.channelId;
                  const selectedNode = isSelectedGraph
                    ? graph.nodes.find((node) => node.id === selectedGraph.nodeId) ?? null
                    : null;
                  return (
                    <details
                      key={graph.channelId}
                      className="border border-[#2a2a30] bg-[#09090b] p-2"
                      open
                    >
                      <summary className="cursor-pointer text-[10px] text-[#d4d4d8] flex items-center justify-between gap-2">
                        <span>
                          {graph.channelId} · {graph.nodes.length} nodes · {graph.edges.length} edges
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setGraphFocusChannelId(graph.channelId);
                              setSelectedGraph(null);
                            }}
                            className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#4ade80]"
                          >
                            open panel
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void downloadFile(
                                'graph',
                                graph.channelId,
                                `graph-${graph.channelId.replace(/^#/, '')}.json`
                              );
                            }}
                            className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#4ade80]"
                          >
                            download json
                          </button>
                        </div>
                      </summary>
                      <div className="pt-2 space-y-2">
                        <div className="h-[360px] border border-[#2a2a30] overflow-hidden bg-[#050506]">
                          {graph.nodes.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-[10px] text-[#52525b]">
                              graph is empty.
                            </div>
                          ) : (
                            <GraphView
                              nodes={graph.nodes}
                              edges={graph.edges}
                              isDark
                              selectedNodeId={isSelectedGraph ? selectedGraph.nodeId : null}
                              onSelectNode={(nodeId) =>
                                setSelectedGraph((current) =>
                                  current?.channelId === graph.channelId &&
                                  current.nodeId === nodeId
                                    ? null
                                    : { channelId: graph.channelId, nodeId }
                                )
                              }
                            />
                          )}
                        </div>
                        {selectedNode && (
                          <div className="border border-[#2a2a30] p-2 text-[10px] space-y-1">
                            <div className="text-[#f4f4f5]">
                              [{selectedNode.kind}] {selectedNode.label}
                            </div>
                            {selectedNode.notes && (
                              <div className="text-[#a1a1aa] whitespace-pre-wrap">
                                {selectedNode.notes}
                              </div>
                            )}
                            <div className="text-[#71717a]">
                              contributed by {selectedNode.createdBy} · {selectedNode.time}
                              {selectedNode.updatedBy
                                ? ` · updated by ${selectedNode.updatedBy} at ${selectedNode.updatedTime}`
                                : ''}
                            </div>
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </section>

<section className={`space-y-2 ${adminTab === 'graphs' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              engagements ({snapshot.engagements.length})
            </h2>
            {snapshot.engagements.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">none — no seeded engagements.</div>
            ) : (
              <div className="overflow-x-auto border border-[#2a2a30]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#2a2a30]">
                      <th className={th}>channel</th>
                      <th className={th}>group</th>
                      <th className={th}>platform</th>
                      <th className={th}>enrolled</th>
                      <th className={th}>graph</th>
                      <th className={th}>progress</th>
                      <th className={th}>reports</th>
                      <th className={th}>messages</th>
                      <th className={th}>export</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.engagements.map((engagement) => (
                      <tr key={engagement.id} className="border-b border-[#16161a]">
                        <td className={td}>{engagement.id}</td>
                        <td className={td}>{engagement.group}</td>
                        <td className={td}>{engagement.platform}</td>
                        <td className={td}>{engagement.enrolled.join(', ') || '—'}</td>
                        <td className={td}>
                          {engagement.graph.nodes}n / {engagement.graph.edges}e
                        </td>
                        <td className={td}>{engagement.progress}</td>
                        <td className={td}>{engagement.reports}</td>
                        <td className={td}>{engagement.messages}</td>
                        <td className={td}>
                          <button
                            type="button"
                            onClick={() =>
                              void downloadFile(
                                'graph',
                                engagement.id,
                                `graph-${engagement.id.replace(/^#/, '')}.json`
                              )
                            }
                            className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#4ade80]"
                          >
                            graph json
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

<section className={`grid grid-cols-1 lg:grid-cols-2 gap-4 ${adminTab === 'people' ? '' : 'hidden'}`}>
            <div className="space-y-2">
              <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
                registered accounts ({snapshot.accounts.length})
              </h2>
              {snapshot.accounts.length === 0 ? (
                <div className="text-[10px] text-[#52525b]">none — no seeded accounts.</div>
              ) : (
                <div className="overflow-x-auto border border-[#2a2a30]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-[#2a2a30]">
                        <th className={th}>nick</th>
                        <th className={th}>role</th>
                        <th className={th}>programs</th>
                        <th className={th}>email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.accounts.map((account) => (
                        <tr key={account.nick} className="border-b border-[#16161a]">
                          <td className={td}>{account.nick}</td>
                          <td className={td}>{account.role}</td>
                          <td className={td}>{account.programs.join(', ') || '—'}</td>
                          <td className={td}>{account.email || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
                live agents ({snapshot.agents.length})
              </h2>
              {snapshot.agents.length === 0 ? (
                <div className="text-[10px] text-[#52525b]">none online.</div>
              ) : (
                <div className="overflow-x-auto border border-[#2a2a30]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-[#2a2a30]">
                        <th className={th}>nick</th>
                        <th className={th}>role</th>
                        <th className={th}>type</th>
                        <th className={th}>programs</th>
                        <th className={th}>graphs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.agents.map((agent) => {
                        const accessibleGraphs = agent.programs.filter((program) =>
                          snapshot.graphs.some((graph) => graph.channelId === program)
                        );
                        return (
                          <tr key={agent.nick} className="border-b border-[#16161a]">
                            <td className={td}>{agent.nick}</td>
                            <td className={td}>{agent.role}</td>
                            <td className={td}>{agent.isUser ? 'operator' : 'agent'}</td>
                            <td className={td}>{agent.programs.join(', ') || '—'}</td>
                            <td className={td}>
                              {accessibleGraphs.length === 0 ? (
                                '—'
                              ) : (
                                <div className="flex flex-wrap gap-1">
                                  {accessibleGraphs.map((program) => (
                                    <button
                                      key={program}
                                      type="button"
                                      onClick={() => {
                                        setGraphFocusChannelId(program);
                                        setSelectedGraph(null);
                                      }}
                                      className="px-1.5 py-0.5 border border-[#2a2a30] text-[9px] text-[#a1a1aa] hover:text-[#4ade80]"
                                    >
                                      {program} graph
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

<section className={`space-y-2 ${adminTab === 'audit' ? '' : 'hidden'}`}>
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              audit / version history (latest {snapshot.audit.length})
            </h2>
            {snapshot.audit.length === 0 ? (
              <div className="text-[10px] text-[#52525b]">no audit entries.</div>
            ) : (
              <div className="overflow-x-auto border border-[#2a2a30] max-h-96 overflow-y-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-[#09090b]">
                    <tr className="border-b border-[#2a2a30]">
                      <th className={th}>v</th>
                      <th className={th}>action</th>
                      <th className={th}>actor</th>
                      <th className={th}>time</th>
                      <th className={th}>payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.audit.map((entry, index) => (
                      <tr key={`${entry.version}-${index}`} className="border-b border-[#16161a]">
                        <td className={td}>{entry.version}</td>
                        <td className={td}>{entry.action}</td>
                        <td className={td}>{entry.actor || '—'}</td>
                        <td className={td}>{String(entry.createdAt).replace('T', ' ').slice(0, 19)}</td>
                        <td className={`${td} max-w-[380px] truncate`}>
                          {JSON.stringify(entry.payload)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="text-[9px] text-[#52525b] border-t border-[#2a2a30] pt-2">
            Hidden admin panel — credentials gated. Set the goal, review reports, inspect the IRC,
            open graphs, and export files. Press Esc to close.
          </div>
          </div>
        </>
      )}
    </div>
  );
}

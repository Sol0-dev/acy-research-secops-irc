/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';
import GraphView from './GraphView';
import Countdown from './Countdown';
import type { AdminSnapshot } from './types';

type AdminTab = 'goal' | 'graphs' | 'knowledge' | 'accounts' | 'duels' | 'audit' | 'irc';

const GLOBAL_DUEL = '__global__';

interface AdminPanelProps {
  open: boolean;
  token: string;
  snapshot: AdminSnapshot | null;
  error: string;
  loading: boolean;
  onRequestLogin: () => void;
  onSaveGoal: (goal: string) => Promise<{ ok: boolean; error?: string }>;
  onSetFocus: (channelId: string, goal: string) => Promise<{ ok: boolean; error?: string }>;
  onSetDuelTask: (duelId: string, task: string) => Promise<{ ok: boolean; error?: string }>;
  onContinueGoal: (goalId: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenAgentPortal: () => void;
  onDeleteGraph: (channelId: string) => Promise<{ ok: boolean; error?: string }>;
  onDeleteChannel: (channelId: string) => Promise<{ ok: boolean; error?: string }>;
  onDeleteAccount: (nick: string) => Promise<{ ok: boolean; error?: string }>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

function auditPhase(action: string) {
  if (action.startsWith('auth.') || action.startsWith('harness.') || action === 'nick.change') return 'auth';
  if (
    action.startsWith('message.') ||
    action.startsWith('dm.') ||
    action.startsWith('notice.') ||
    action.startsWith('channel.')
  ) {
    return 'chat';
  }
  if (action.startsWith('graph.') || action.startsWith('knowledge.')) return 'graph/knowledge';
  if (action.startsWith('tool.')) return 'tools';
  if (action.startsWith('progress.')) return 'progress';
  if (action.startsWith('report.')) return 'reports';
  if (action.startsWith('admin.')) return 'admin';
  if (action.startsWith('ui.')) return 'ui';
  if (action.startsWith('proposal.') || action.startsWith('updates.') || action.startsWith('quota.')) {
    return 'vote';
  }
  if (action.startsWith('role.') || action.startsWith('program.')) return 'coordination';
  return 'other';
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-[#2a2a30] bg-[#09090b] px-2.5 py-2">
      <div className="text-[15px] uppercase tracking-wider text-[#71717a]">{label}</div>
      <div className="text-lg text-[#f4f4f5] pt-0.5">{value}</div>
    </div>
  );
}

export default function AdminPanel({
  open,
  token: adminToken,
  snapshot,
  error,
  loading,
  onRequestLogin,
  onSaveGoal,
  onSetFocus,
  onSetDuelTask,
  onContinueGoal,
  onOpenAgentPortal,
  onDeleteGraph,
  onDeleteChannel,
  onDeleteAccount,
  onRefresh,
  onClose,
}: AdminPanelProps) {
  const [goalInput, setGoalInput] = useState('');
  const [focusChannelId, setFocusChannelId] = useState('');
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusNotice, setFocusNotice] = useState('');
  const [focusError, setFocusError] = useState('');
  const [goalNotice, setGoalNotice] = useState('');
  const [goalError, setGoalError] = useState('');
  const [goalContinueBusy, setGoalContinueBusy] = useState('');
  const [goalContinueNotice, setGoalContinueNotice] = useState('');
  const [goalContinueError, setGoalContinueError] = useState('');
  const [goalBusy, setGoalBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState('');
  const [confirmAccountDelete, setConfirmAccountDelete] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState('');
  const [accountError, setAccountError] = useState('');
  const [confirmGraphDelete, setConfirmGraphDelete] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [downloadNotice, setDownloadNotice] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [selectedGraph, setSelectedGraph] = useState<{
    channelId: string;
    nodeId: string;
  } | null>(null);
  const [adminTab, setAdminTab] = useState<AdminTab>('goal');
  const [adminGraphChannelId, setAdminGraphChannelId] = useState('');
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [auditActorFilter, setAuditActorFilter] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [auditPhaseFilter, setAuditPhaseFilter] = useState('all');
  const [duelTaskDrafts, setDuelTaskDrafts] = useState<Record<string, string>>({});
  const [duelEditing, setDuelEditing] = useState(false);
  const [newTaskDraft, setNewTaskDraft] = useState('');
  const [duelTaskBusy, setDuelTaskBusy] = useState('');
  const [duelTaskNotice, setDuelTaskNotice] = useState('');
  const [duelTaskError, setDuelTaskError] = useState('');

  const downloadFile = async (kind: 'docx' | 'graph' | 'all', id: string, filename: string) => {
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
          : kind === 'all'
            ? await api.adminAllGraphs(adminToken)
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
    setFocusChannelId(
      snapshot?.focus?.channelId ?? '__new__'
    );
    setFocusNotice('');
    setFocusError('');
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (
      !adminGraphChannelId ||
      !snapshot.graphs.some((graph) => graph.channelId === adminGraphChannelId)
    ) {
      setAdminGraphChannelId(snapshot.graphs[0]?.channelId ?? '');
    }
  }, [snapshot, adminGraphChannelId]);

  useEffect(() => {
    if (!open || adminTab !== 'audit') return;
    const timer = window.setInterval(() => void onRefresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [open, adminTab, onRefresh]);

  useEffect(() => {
    if (!open || adminTab !== 'duels') return;
    void onRefresh();
  }, [open, adminTab, onRefresh]);

  const registeredNicks = useMemo(
    () => new Set((snapshot?.accounts ?? []).map((account) => account.nick)),
    [snapshot]
  );

  const auditPhases = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of snapshot?.audit ?? []) {
      const phase = auditPhase(entry.action);
      counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [snapshot]);

  const filteredAudit = useMemo(() => {
    const actor = auditActorFilter.trim().toLowerCase();
    const action = auditActionFilter.trim().toLowerCase();
    const query = auditSearch.trim().toLowerCase();
    return (snapshot?.audit ?? []).filter((entry) => {
      if (auditPhaseFilter !== 'all' && auditPhase(entry.action) !== auditPhaseFilter) {
        return false;
      }
      if (actor && !String(entry.actor ?? '').toLowerCase().includes(actor)) return false;
      if (action && !String(entry.action ?? '').toLowerCase().includes(action)) return false;
      if (query && !JSON.stringify(entry.payload ?? {}).toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
  }, [snapshot, auditActorFilter, auditActionFilter, auditSearch, auditPhaseFilter]);

  if (!open) return null;

  const confirmDelete = async (kind: 'graph' | 'channel', channelId: string) => {
    setDeleteNotice('');
    setDeleteError('');
    const result =
      kind === 'graph' ? await onDeleteGraph(channelId) : await onDeleteChannel(channelId);
    if (!result.ok) {
      setDeleteError(result.error || 'delete failed');
      return;
    }
    setPendingDelete('');
    setDeleteNotice(
      kind === 'graph'
        ? `graph deleted: ${channelId}`
        : `chat group deleted: ${channelId}`
    );
  };

  const deleteAccount = async (nick: string) => {
    setAccountNotice('');
    setAccountError('');
    const result = await onDeleteAccount(nick);
    if (!result.ok) {
      setAccountError(result.error || 'could not remove account');
      return;
    }
    setConfirmAccountDelete(null);
    setAccountNotice(`removed: ${nick}`);
  };

  const th = 'text-left py-1 pr-3 text-[15px] uppercase tracking-wider text-[#71717a] font-normal';
  const td = 'py-1.5 pr-3 align-top text-base text-[#d4d4d8]';

  const adminGraph =
    snapshot?.graphs.find((graph) => graph.channelId === adminGraphChannelId) ??
    snapshot?.graphs[0] ??
    null;
  // One merged knowledge graph across every target. Admin oversight does not use a target
  // dropdown for knowledge retrieval: the whole graph is searchable and exportable at once.
  const mergedNodes = (snapshot?.graphs ?? []).flatMap((graph) => graph.nodes);
  const mergedEdges = (snapshot?.graphs ?? []).flatMap((graph) => graph.edges);
  const targetByNode = new Map<string, string>();
  for (const graph of snapshot?.graphs ?? []) {
    for (const node of graph.nodes) targetByNode.set(node.id, graph.channelId);
  }
  const mergedNode = selectedGraph
    ? mergedNodes.find((node) => node.id === selectedGraph.nodeId) ?? null
    : null;

  const knowledgeQuery = knowledgeSearch.trim().toLowerCase();
  const knowledgeMatches = mergedNodes
    .filter((node) => {
      if (!knowledgeQuery) return false;
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
        .includes(knowledgeQuery);
    })
    .slice(0, 20);
  const mergedRelations = mergedNode
    ? mergedEdges
        .filter((edge) => edge.from === mergedNode.id || edge.to === mergedNode.id)
        .map((edge) => {
          const out = edge.from === mergedNode.id;
          const other = mergedNodes.find(
            (node) => node.id === (out ? edge.to : edge.from)
          );
          return {
            key: edge.id,
            text: `${out ? '->' : '<-'}${edge.label ? ` [${edge.label}]` : ''} ${other?.label ?? '?'}`,
          };
        })
    : [];

  return (
    <div className="fixed inset-0 z-[60] bg-[#050506] text-[#f4f4f5] font-mono text-lg flex flex-col">
      <header className="border-b border-[#2a2a30] px-4 sm:px-6 py-3 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#f87171]" />
          <span className="font-medium tracking-tight truncate">admin // oversight</span>
          {snapshot && (
            <span className="text-base text-[#71717a]">workspace v{snapshot.version}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenAgentPortal}
            className="text-base text-[#4ade80] hover:text-[#f4f4f5] border border-[#4ade80]/40 px-2 py-1"
            title="Return to the agent portal"
          >
            agent portal →
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-base text-[#71717a] hover:text-[#f4f4f5] border border-[#2a2a30] px-2 py-1"
          >
            close
          </button>
        </div>
      </header>

      {!snapshot ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-sm border border-[#2a2a30] bg-[#09090b] p-4 space-y-3">
            <div className="text-base uppercase tracking-wider text-[#71717a]">
              admin session required
            </div>
            <p className="text-base text-[#71717a] leading-relaxed">
              Use the main login form with the{' '}
              <span className="text-[#f4f4f5]">admin</span> handle. Admin credentials sign you in
              as @admin and open this menu.
            </p>
            {loading && <div className="text-base text-[#a1a1aa]">checking admin session...</div>}
            {error && <div className="text-base text-[#f87171] leading-relaxed">{error}</div>}
            <button
              type="button"
              onClick={onRequestLogin}
              className="w-full px-3 py-1.5 border border-[#4ade80]/40 text-base text-[#4ade80] hover:text-[#f4f4f5]"
            >
              open admin login
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full px-3 py-1.5 border border-[#2a2a30] text-base text-[#a1a1aa] hover:text-[#f4f4f5]"
            >
              close
            </button>
          </div>
        </div>
      ) : (
        <>
          <nav className="border-b border-[#2a2a30] px-4 sm:px-6 py-2 flex flex-wrap gap-1 shrink-0">
            {(
              [
                ['goal', 'Goal'],
                ['graphs', 'Graphs'],
                ['knowledge', 'Knowledge'],
                ['accounts', 'Accounts'],
                ['duels', 'Duels'],
                ['audit', 'Audit logs'],
              ] as Array<[AdminTab, string]>
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setAdminTab(tab)}
                className={`px-2.5 py-1 text-[15px] border transition-colors ${
                  adminTab === tab
                    ? 'border-[#4ade80] text-[#4ade80] bg-[#4ade80]/10'
                    : 'border-[#2a2a30] text-[#a1a1aa] hover:text-[#f4f4f5]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-5">
          <section className={`space-y-2 ${adminTab === 'goal' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">workspace counts</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="agents" value={snapshot.counts.agents} />
              <Stat label="engagements" value={snapshot.counts.engagements} />
              <Stat label="reports" value={snapshot.counts.reports} />
            </div>
          </section>

          <section className={`space-y-2 ${adminTab === 'goal' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              mission goal - shown at the top of docs
            </h2>
            <textarea
              rows={8}
              value={goalInput}
              onChange={(event) => setGoalInput(event.target.value)}
              placeholder="e.g. Find and report real, in-scope vulnerabilities without touching out-of-scope assets."
              className="w-full min-h-[220px] bg-[#050506] border border-[#2a2a30] px-2.5 py-2 text-lg text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y"
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
                    else
                      setGoalNotice(
                        goalInput.trim()
                          ? 'goal saved · 1-week focus set · agents notified'
                          : 'goal cleared'
                      );
                  });
                }}
                className="px-3 py-1.5 border border-[#2a2a30] text-base text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
              >
                {goalBusy ? 'saving…' : 'save goal'}
              </button>
              <button
                type="button"
                onClick={() => setGoalInput('')}
                className="px-3 py-1.5 border border-[#2a2a30] text-base text-[#71717a] hover:text-[#f87171]"
              >
                clear
              </button>
              {goalNotice && <span className="text-base text-[#4ade80]">{goalNotice}</span>}
              {goalError && <span className="text-base text-[#f87171]">{goalError}</span>}
            </div>
            <div className="text-[15px] text-[#52525b]">
              only admin credentials can set this. the goal is stored in the central workspace and
              rendered above the docs content for every agent.
            </div>
          </section>

          <section className={`space-y-2 ${adminTab === 'goal' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              focus - one group chat and graph for 1 week
            </h2>
            <div className="text-[15px] text-[#a1a1aa]">
              {snapshot.focus ? (
                <span>
                  current focus: {snapshot.focus.channelId} until{' '}
                  {new Date(snapshot.focus.endsAt).toLocaleDateString()} · timer{' '}
                  <Countdown
                    endsAt={snapshot.focus.endsAt}
                  />
                </span>
              ) : (
                'no focus set'
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={focusChannelId}
                onChange={(event) => setFocusChannelId(event.target.value)}
                className="bg-[#050506] border border-[#2a2a30] px-2 py-1.5 text-[15px] text-[#f4f4f5]"
              >
                <option value="__new__">create new focus group from the goal links</option>
                {snapshot.engagements.map((engagement) => (
                  <option key={engagement.id} value={engagement.id}>
                    {engagement.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={focusBusy || !focusChannelId}
                onClick={() => {
                  setFocusBusy(true);
                  setFocusNotice('');
                  setFocusError('');
                  void onSetFocus(focusChannelId, goalInput).then((result) => {
                    setFocusBusy(false);
                    if (!result.ok) setFocusError(result.error || 'could not set focus');
                    else
                      setFocusNotice(
                        focusChannelId === '__new__'
                          ? 'focus group created, agents enrolled and tagged'
                          : 'focus set for 1 week'
                      );
                  });
                }}
                className="px-3 py-1.5 border border-[#2a2a30] text-base text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
              >
                {focusChannelId === '__new__' ? 'create group & set focus' : 'set 1-week focus'}
              </button>
              {snapshot.focus && (
                <button
                  type="button"
                  disabled={focusBusy}
                  onClick={() => {
                    setFocusBusy(true);
                    setFocusNotice('');
                    setFocusError('');
                    void onSetFocus(
                      snapshot.focus!.channelId,
                      snapshot.focus!.goal || goalInput
                    ).then((result) => {
                      setFocusBusy(false);
                      if (!result.ok) setFocusError(result.error || 'could not continue focus');
                      else setFocusNotice('focus continued for 1 week · agents notified');
                    });
                  }}
                  className="px-3 py-1.5 border border-[#2a2a30] text-base text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
                >
                  continue focus
                </button>
              )}
              <button
                type="button"
                disabled={focusBusy}
                onClick={() => {
                  setFocusBusy(true);
                  setFocusNotice('');
                  setFocusError('');
                  void onSetFocus('', '').then((result) => {
                    setFocusBusy(false);
                    if (!result.ok) setFocusError(result.error || 'could not unset focus');
                    else setFocusNotice('focus unset');
                  });
                }}
                className="px-3 py-1.5 border border-[#2a2a30] text-base text-[#71717a] hover:text-[#f87171] disabled:opacity-40"
              >
                unset focus
              </button>
              {focusNotice && <span className="text-base text-[#4ade80]">{focusNotice}</span>}
              {focusError && <span className="text-base text-[#f87171]">{focusError}</span>}
            </div>
            <div className="text-[15px] text-[#52525b]">
              create new focus group uses links in the goal as the scope and a short part of the
              goal as the group name. every ai agent is enrolled, tagged, and notified.
            </div>
          </section>

          <section className={`space-y-3 ${adminTab === 'goal' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              goal timers - server side 7 days per goal
            </h2>
            {(snapshot.goalHistory ?? []).length === 0 ? (
              <div className="text-[15px] text-[#71717a]">no goals recorded yet</div>
            ) : (
              <div className="space-y-2">
                {(snapshot.goalHistory ?? [])
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <div
                      key={entry.id}
                      className="border border-[#2a2a30] bg-[#09090b] p-2.5 space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
                        <span
                          className={`uppercase tracking-wider ${
                            entry.active ? 'text-[#4ade80]' : 'text-[#71717a]'
                          }`}
                        >
                          {entry.active ? 'active' : 'inactive'}
                        </span>
                        <span className="text-[#d4d4d8]">{entry.channelId}</span>
                        <span className="text-[#71717a]">
                          timer <Countdown
                            endsAt={entry.endsAt}
                          />
                        </span>
                        <span className="text-[#71717a]">
                          ends {new Date(entry.endsAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-[14px] text-[#a1a1aa] whitespace-pre-wrap break-words">
                        {entry.goal}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={goalContinueBusy === entry.id}
                          onClick={() => {
                            setGoalContinueBusy(entry.id);
                            setGoalContinueNotice('');
                            setGoalContinueError('');
                            void onContinueGoal(entry.id).then((result) => {
                              setGoalContinueBusy('');
                              if (!result.ok) {
                                setGoalContinueError(
                                  result.error || 'could not continue goal'
                                );
                                return;
                              }
                              setGoalContinueNotice(
                                `7-day timer restored for ${entry.channelId}`
                              );
                            });
                          }}
                          className="px-2.5 py-1 border border-[#2a2a30] text-[13px] text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
                        >
                          {goalContinueBusy === entry.id
                            ? 'restoring…'
                            : 'bring back 7-day timer'}
                        </button>
                        {goalContinueNotice && (
                          <span className="text-[13px] text-[#4ade80]">
                            {goalContinueNotice}
                          </span>
                        )}
                        {goalContinueError && (
                          <span className="text-[13px] text-[#f87171]">
                            {goalContinueError}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>

          <section className={`space-y-2 ${adminTab === 'irc' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              direct messages ({snapshot.dmThreads.length})
            </h2>
            {snapshot.dmThreads.length === 0 ? (
              <div className="text-base text-[#52525b]">no direct messages.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.dmThreads.map((thread) => (
                  <details key={thread.id} className="border border-[#2a2a30] bg-[#09090b] p-2">
                    <summary className="cursor-pointer text-base text-[#d4d4d8]">
                      {thread.participants.join(' ↔ ')} · {thread.messages.length} messages
                    </summary>
                    <div className="pt-2 max-h-64 overflow-y-auto space-y-1">
                      {thread.messages.map((message) => (
                        <div key={message.id} className="text-base leading-relaxed">
                          <span className="text-[#71717a]">[{message.time}]</span>{' '}
                          {message.type === 'sys' ? (
                            <span className="text-[#71717a]">- {message.text}</span>
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
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              progress logs ({snapshot.progress.length})
            </h2>
            {snapshot.progress.length === 0 ? (
              <div className="text-base text-[#52525b]">no progress logs.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.progress.map((log) => (
                  <details key={log.channelId} className="border border-[#2a2a30] bg-[#09090b] p-2">
                    <summary className="cursor-pointer text-base text-[#d4d4d8]">
                      {log.channelId} · {log.entries.length} entries · head v
                      {log.headVersion ?? '-'}
                    </summary>
                    <div className="pt-2 max-h-64 overflow-y-auto space-y-1">
                      {log.entries.map((entry) => (
                        <div key={entry.id} className="text-base leading-relaxed">
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
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              attack maps ({snapshot.graphs.length})
            </h2>
            {snapshot.graphs.length === 0 ? (
              <div className="text-base text-[#52525b]">no graphs yet.</div>
            ) : adminGraph ? (
              <div className="space-y-2 border border-[#2a2a30] bg-[#09090b] p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-base text-[#a1a1aa]">
                    <span>show</span>
                    <select
                      value={adminGraph.channelId}
                      onChange={(event) => {
                        setAdminGraphChannelId(event.target.value);
                        setSelectedGraph(null);
                      }}
                      className="bg-[#050506] border border-[#2a2a30] px-2 py-1 text-base text-[#f4f4f5]"
                    >
                      {snapshot.graphs.map((graph) => (
                        <option key={graph.channelId} value={graph.channelId}>
                          {graph.channelId} · {graph.nodes.length}n / {graph.edges.length}e
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="text-base text-[#71717a]">
                    {adminGraph.nodes.length} nodes · {adminGraph.edges.length} edges
                  </span>
                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      type="button"
                      onClick={() =>
                        void downloadFile(
                          'graph',
                          adminGraph.channelId,
                          `graph-${adminGraph.channelId.replace(/^#/, '')}.json`
                        )
                      }
                      className="px-1.5 py-0.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80]"
                    >
                      download json
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmGraphDelete(adminGraph.channelId)}
                      className="px-1.5 py-0.5 border border-[#2a2a30] text-[15px] text-[#f87171] hover:border-[#f87171]"
                    >
                      delete graph
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {deleteNotice && <div className="text-base text-[#4ade80]">{deleteNotice}</div>}
            {deleteError && <div className="text-base text-[#f87171]">{deleteError}</div>}
          </section>

          <section className={`space-y-2 ${adminTab === 'graphs' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              engagements ({snapshot.engagements.length})
            </h2>
            {snapshot.engagements.length === 0 ? (
              <div className="text-base text-[#52525b]">none - no seeded engagements.</div>
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
                        <td className={td}>{engagement.enrolled.join(', ') || '-'}</td>
                        <td className={td}>
                          {engagement.graph.nodes}n / {engagement.graph.edges}e
                        </td>
                        <td className={td}>{engagement.progress}</td>
                        <td className={td}>{engagement.reports}</td>
                        <td className={td}>{engagement.messages}</td>
                        <td className={td}>
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                void downloadFile(
                                  'graph',
                                  engagement.id,
                                  `graph-${engagement.id.replace(/^#/, '')}.json`
                                )
                              }
                              className="px-1.5 py-0.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80]"
                            >
                              graph json
                            </button>
                            {pendingDelete === `channel:${engagement.id}` ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void confirmDelete('channel', engagement.id)
                                  }
                                  className="px-1.5 py-0.5 border border-[#f87171] text-[15px] text-[#f87171]"
                                >
                                  confirm delete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPendingDelete('')}
                                  className="px-1.5 py-0.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa]"
                                >
                                  cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setPendingDelete(`channel:${engagement.id}`)
                                }
                                className="px-1.5 py-0.5 border border-[#2a2a30] text-[15px] text-[#f87171] hover:border-[#f87171]"
                              >
                                delete group
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={`space-y-2 ${adminTab === 'knowledge' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              whole knowledge graph // all targets
            </h2>
            {mergedNodes.length === 0 ? (
              <div className="text-base text-[#52525b]">no knowledge yet.</div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] text-[#71717a]">
                    {mergedNodes.length} nodes · {mergedEdges.length} edges ·{' '}
                    {(snapshot?.graphs ?? []).length} targets
                  </span>
                  <input
                    type="text"
                    value={knowledgeSearch}
                    onChange={(event) => setKnowledgeSearch(event.target.value)}
                    placeholder="search all targets, techniques, commands, scripts, requests, tags..."
                    className="flex-1 min-w-[240px] bg-[#050506] border border-[#2a2a30] px-2 py-1 text-[15px] text-[#f4f4f5]"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void downloadFile('all', '', 'knowledge-graphs.json')
                    }
                    className="px-1.5 py-0.5 border border-[#2a2a30] text-[14px] text-[#a1a1aa] hover:text-[#4ade80]"
                  >
                    download all json
                  </button>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-2">
                  <div className="h-[70vh] min-h-[600px] border border-[#2a2a30] overflow-hidden bg-[#050506]">
                    <GraphView
                      nodes={mergedNodes}
                      edges={mergedEdges}
                      isDark
                      selectedNodeId={mergedNode?.id ?? null}
                      onSelectNode={(nodeId) =>
                        setSelectedGraph({
                          channelId: targetByNode.get(nodeId) ?? '',
                          nodeId,
                        })
                      }
                    />
                  </div>
                  <aside className="border border-[#2a2a30] p-3 space-y-2 overflow-y-auto max-h-[70vh] text-[15px] leading-relaxed">
                    {knowledgeSearch && (
                      <div className="space-y-1 border-b border-[#2a2a30] pb-2">
                        <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                          matches ({knowledgeMatches.length})
                        </div>
                        {knowledgeMatches.length === 0 ? (
                          <div className="text-[#52525b]">no matching nodes</div>
                        ) : (
                          knowledgeMatches.map((node) => (
                            <button
                              key={node.id}
                              type="button"
                              onClick={() =>
                                setSelectedGraph({
                                  channelId: targetByNode.get(node.id) ?? '',
                                  nodeId: node.id,
                                })
                              }
                              className="w-full text-left text-[14px] text-[#a1a1aa] hover:text-[#4ade80]"
                            >
                              <span className="text-[#71717a]">
                                {targetByNode.get(node.id) ?? '?'} · [
                                {node.kind}]
                              </span>{' '}
                              {node.label}
                              {node.intel?.phase ? ` - ${node.intel.phase}` : ''}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                    {!mergedNode ? (
                      <div className="text-[#52525b]">
                        click a node to read its technique knowledge, commands, scripts,
                        requests, responses, and relations across every target.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-[13px] text-[#71717a]">
                          {targetByNode.get(mergedNode.id) ?? '?'}
                        </div>
                        <div className="text-[#f4f4f5]">
                          [{mergedNode.kind}] {mergedNode.label}
                        </div>
                        {mergedNode.intel?.phase && (
                          <div className="text-[#4ade80]">phase: {mergedNode.intel.phase}</div>
                        )}
                        {mergedNode.intel?.technique && (
                          <div className="whitespace-pre-wrap text-[#d4d4d8]">
                            technique: {mergedNode.intel.technique}
                          </div>
                        )}
                        {mergedNode.notes && (
                          <div className="whitespace-pre-wrap text-[#a1a1aa]">
                            {mergedNode.notes}
                          </div>
                        )}
                        {mergedNode.intel?.commands && (
                          <div>
                            <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                              commands
                            </div>
                            <pre className="p-2 border border-[#2a2a30] bg-[#050506] overflow-x-auto whitespace-pre-wrap max-h-64">
                              {mergedNode.intel.commands}
                            </pre>
                          </div>
                        )}
                        {mergedNode.intel?.scripts && (
                          <div>
                            <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                              scripts
                            </div>
                            <pre className="p-2 border border-[#2a2a30] bg-[#050506] overflow-x-auto whitespace-pre-wrap max-h-64">
                              {mergedNode.intel.scripts}
                            </pre>
                          </div>
                        )}
                        {mergedNode.intel?.request && (
                          <div>
                            <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                              request
                            </div>
                            <pre className="p-2 border border-[#2a2a30] bg-[#050506] overflow-x-auto whitespace-pre-wrap max-h-64">
                              {mergedNode.intel.request}
                            </pre>
                          </div>
                        )}
                        {mergedNode.intel?.response && (
                          <div>
                            <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                              response
                            </div>
                            <pre className="p-2 border border-[#2a2a30] bg-[#050506] overflow-x-auto whitespace-pre-wrap max-h-64">
                              {mergedNode.intel.response}
                            </pre>
                          </div>
                        )}
                        {mergedNode.intel?.chain && (
                          <div className="whitespace-pre-wrap text-[#a1a1aa]">
                            chain: {mergedNode.intel.chain}
                          </div>
                        )}
                        {mergedNode.intel?.lessons && (
                          <div className="whitespace-pre-wrap text-[#a1a1aa]">
                            lessons: {mergedNode.intel.lessons}
                          </div>
                        )}
                        {mergedNode.intel?.template && (
                          <div>
                            <div className="text-[13px] uppercase tracking-wider text-[#71717a]">
                              template
                            </div>
                            <pre className="p-2 border border-[#2a2a30] bg-[#050506] overflow-x-auto whitespace-pre-wrap max-h-64">
                              {mergedNode.intel.template}
                            </pre>
                          </div>
                        )}
                        {mergedNode.intel?.references && (
                          <div className="whitespace-pre-wrap text-[#a1a1aa]">
                            references: {mergedNode.intel.references}
                          </div>
                        )}
                        {mergedNode.intel?.tags && mergedNode.intel.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {mergedNode.intel.tags.map((tag) => (
                              <span
                                key={tag}
                                className="px-1.5 py-0.5 border border-[#2a2a30] text-[13px] text-[#71717a]"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="border-t border-[#2a2a30] pt-1.5 text-[13px] text-[#71717a]">
                          relations:
                          {mergedRelations.length === 0
                            ? ' none'
                            : ` ${mergedRelations.map((relation) => relation.text).join(' | ')}`}
                        </div>
                        <div className="text-[13px] text-[#71717a]">
                          by {mergedNode.createdBy} - {mergedNode.time}
                          {mergedNode.updatedBy
                            ? ` - refined by ${mergedNode.updatedBy} at ${mergedNode.updatedTime}`
                            : ''}
                        </div>
                      </div>
                    )}
                  </aside>
                </div>
              </div>
            )}
          </section>

          <section className={`space-y-3 ${adminTab === 'accounts' ? '' : 'hidden'}`}>
            {accountNotice && (
              <div className="border border-[#4ade80]/50 bg-[#4ade80]/10 px-3 py-2 text-[16px] text-[#4ade80]">
                {accountNotice}
              </div>
            )}
            {accountError && (
              <div className="border border-[#f87171]/50 bg-[#f87171]/10 px-3 py-2 text-[16px] text-[#f87171]">
                {accountError}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-2 border border-[#2a2a30] bg-[#09090b] p-3">
              <h2 className="text-base uppercase tracking-wider text-[#71717a]">
                registered accounts ({snapshot.accounts.length})
              </h2>
              {snapshot.accounts.length === 0 ? (
                <div className="text-base text-[#52525b]">none - no seeded accounts.</div>
              ) : (
                <div className="overflow-x-auto border border-[#2a2a30]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-[#2a2a30]">
                        <th className={th}>nick</th>
                        <th className={th}>role</th>
                        <th className={th}>harness</th>
                        <th className={th}>timer</th>
                        <th className={th}>programs</th>
                        <th className={th}>email</th>
                        <th className={th}>actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.accounts.map((account) => (
                        <tr key={account.nick} className="border-b border-[#16161a]">
                          <td className={td}>{account.nick}</td>
                          <td className={td}>{account.role}</td>
                          <td className={td}>{account.harness || '-'}</td>
                          <td className={td}>
                            {account.expiresAt ? (
                              <Countdown endsAt={account.expiresAt} />
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className={td}>{account.programs.join(', ') || '-'}</td>
                          <td className={td}>{account.email || '-'}</td>
                          <td className={td}>
                            <button
                              type="button"
                              onClick={() => setConfirmAccountDelete(account.nick)}
                              className="px-2 py-1 border border-[#2a2a30] text-[15px] text-[#f87171] hover:border-[#f87171]"
                            >
                              remove account
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-2 border border-[#2a2a30] bg-[#09090b] p-3">
              <h2 className="text-base uppercase tracking-wider text-[#71717a]">
                live agents ({snapshot.agents.length})
              </h2>
              {snapshot.agents.length === 0 ? (
                <div className="text-base text-[#52525b]">none online.</div>
              ) : (
                <div className="overflow-x-auto border border-[#2a2a30]">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-[#2a2a30]">
                        <th className={th}>nick</th>
                        <th className={th}>role</th>
                        <th className={th}>harness</th>
                        <th className={th}>type</th>
                        <th className={th}>programs</th>
                        <th className={th}>graphs</th>
                        <th className={th}>actions</th>
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
                            <td className={td}>{agent.harness || '-'}</td>
                            <td className={td}>{agent.isUser ? 'operator' : 'agent'}</td>
                            <td className={td}>{agent.programs.join(', ') || '-'}</td>
                            <td className={td}>
                              {accessibleGraphs.length === 0 ? (
                                '-'
                              ) : (
                                <div className="flex flex-wrap gap-1">
                                  {accessibleGraphs.map((program) => (
                                    <button
                                      key={program}
                                      type="button"
                                      onClick={() => {
                                        setAdminTab('graphs');
                                        setAdminGraphChannelId(program);
                                        setSelectedGraph(null);
                                      }}
                                      className="px-1.5 py-0.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80]"
                                    >
                                      {program} graph
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className={td}>
                              {agent.nick === 'admin' ? (
                                '-'
                              ) : registeredNicks.has(agent.nick) ? (
                                <span className="text-[15px] text-[#71717a]">registered</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmAccountDelete(agent.nick)}
                                  className="px-2 py-1 border border-[#2a2a30] text-[15px] text-[#f87171] hover:border-[#f87171]"
                                >
                                  remove unregistered
                                </button>
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
            </div>
          </section>

          <section className={`space-y-3 ${adminTab === 'duels' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">set duel task</h2>
            <div className="space-y-2">
              <textarea
                rows={10}
                value={newTaskDraft}
                onChange={(event) => setNewTaskDraft(event.target.value)}
                placeholder="type the duel task to set..."
                className="w-full min-h-[260px] bg-[#050506] border border-[#2a2a30] px-3 py-2.5 text-[17px] leading-relaxed text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y"
              />
              <button
                type="button"
                disabled={duelTaskBusy === 'new'}
                onClick={() => {
                  setDuelTaskBusy('new');
                  setDuelTaskNotice('');
                  setDuelTaskError('');
                  void onSetDuelTask('', newTaskDraft).then((result) => {
                    setDuelTaskBusy('');
                    if (!result.ok) {
                      setDuelTaskError(result.error || 'could not set duel task');
                      return;
                    }
                    setNewTaskDraft('');
                    setDuelEditing(false);
                    setDuelTaskNotice('duel task set - duelists notified');
                  });
                }}
                className="px-3 py-1.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
              >
                {duelTaskBusy === 'new' ? 'saving…' : 'set task'}
              </button>
              {duelTaskNotice && <div className="text-[14px] text-[#4ade80]">{duelTaskNotice}</div>}
              {duelTaskError && <div className="text-[14px] text-[#f87171]">{duelTaskError}</div>}
            </div>

            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              duel task set by admin
            </h2>
            {(() => {
              const activeTask = snapshot.duelTask?.text ?? '';
              const draft = duelTaskDrafts[GLOBAL_DUEL] ?? activeTask;
              const saveTask = () => {
                setDuelTaskBusy(GLOBAL_DUEL);
                setDuelTaskNotice('');
                setDuelTaskError('');
                void onSetDuelTask('', draft).then((result) => {
                  setDuelTaskBusy('');
                  if (!result.ok) {
                    setDuelTaskError(result.error || 'could not save duel task');
                    return;
                  }
                  setDuelEditing(false);
                  setDuelTaskDrafts((current) => {
                    const next = { ...current };
                    delete next[GLOBAL_DUEL];
                    return next;
                  });
                  setDuelTaskNotice('duel task updated - duelists notified');
                });
              };
              const unsetTask = () => {
                setDuelTaskBusy(GLOBAL_DUEL);
                setDuelTaskNotice('');
                setDuelTaskError('');
                void onSetDuelTask('', '').then((result) => {
                  setDuelTaskBusy('');
                  if (!result.ok) {
                    setDuelTaskError(result.error || 'could not unset duel task');
                    return;
                  }
                  setDuelEditing(false);
                  setDuelTaskDrafts((current) => {
                    const next = { ...current };
                    delete next[GLOBAL_DUEL];
                    return next;
                  });
                  setDuelTaskNotice('duel task unset - duelists notified');
                });
              };
              return (
                <div className="space-y-2">
                  <textarea
                    rows={16}
                    readOnly={!duelEditing}
                    value={duelEditing ? draft : activeTask}
                    onChange={(event) =>
                      setDuelTaskDrafts((current) => ({
                        ...current,
                        [GLOBAL_DUEL]: event.target.value,
                      }))
                    }
                    placeholder={duelEditing ? 'type the duel task...' : 'no duel task set'}
                    className={`w-full min-h-[420px] bg-[#050506] border border-[#2a2a30] px-3 py-2.5 text-[17px] leading-relaxed text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y ${
                      duelEditing ? '' : 'cursor-default opacity-90'
                    }`}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={duelEditing}
                        onClick={() => {
                          setDuelTaskDrafts((current) => ({
                            ...current,
                            [GLOBAL_DUEL]: activeTask,
                          }));
                          setDuelEditing(true);
                          setDuelTaskNotice('');
                          setDuelTaskError('');
                        }}
                        className="px-3 py-1.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        disabled={duelEditing || duelTaskBusy === GLOBAL_DUEL || !activeTask}
                        onClick={() => unsetTask()}
                        className="px-3 py-1.5 border border-[#2a2a30] text-[15px] text-[#71717a] hover:text-[#f87171] disabled:opacity-40"
                      >
                        unset task
                      </button>
                    </div>
                    {duelEditing && (
                      <button
                        type="button"
                        disabled={duelTaskBusy === GLOBAL_DUEL}
                        onClick={() => saveTask()}
                        className="px-3 py-1.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80] disabled:opacity-40"
                      >
                        {duelTaskBusy === GLOBAL_DUEL ? 'saving…' : 'save changes'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
          </section>

          <section className={`space-y-3 ${adminTab === 'audit' ? '' : 'hidden'}`}>
            <h2 className="text-base uppercase tracking-wider text-[#71717a]">
              audit / agent activity (latest {snapshot.audit.length})
            </h2>
            <div className="border border-[#2a2a30] bg-[#09090b] p-3 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[15px]">
                <input
                  type="text"
                  value={auditActorFilter}
                  onChange={(event) => setAuditActorFilter(event.target.value)}
                  placeholder="filter actor"
                  className="flex-1 min-w-[170px] bg-[#050506] border border-[#2a2a30] px-2.5 py-1.5 text-[15px] text-[#f4f4f5]"
                />
                <input
                  type="text"
                  value={auditActionFilter}
                  onChange={(event) => setAuditActionFilter(event.target.value)}
                  placeholder="filter action"
                  className="flex-1 min-w-[170px] bg-[#050506] border border-[#2a2a30] px-2.5 py-1.5 text-[15px] text-[#f4f4f5]"
                />
                <input
                  type="text"
                  value={auditSearch}
                  onChange={(event) => setAuditSearch(event.target.value)}
                  placeholder="search payload"
                  className="flex-1 min-w-[190px] bg-[#050506] border border-[#2a2a30] px-2.5 py-1.5 text-[15px] text-[#f4f4f5]"
                />
                <span className="text-[#71717a] whitespace-nowrap">
                  {filteredAudit.length} / {snapshot.audit.length} entries
                </span>
                <button
                  type="button"
                  onClick={() => void onRefresh()}
                  className="px-2 py-1 border border-[#2a2a30] text-[15px] text-[#a1a1aa] hover:text-[#4ade80]"
                >
                  refresh
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                <span className="text-[#71717a] uppercase tracking-wider mr-1">phases</span>
                <button
                  type="button"
                  onClick={() => setAuditPhaseFilter('all')}
                  className={`px-2 py-1 border ${
                    auditPhaseFilter === 'all'
                      ? 'border-[#4ade80] text-[#4ade80]'
                      : 'border-[#2a2a30] text-[#a1a1aa]'
                  }`}
                >
                  all
                </button>
                {auditPhases.map(([phase, count]) => (
                  <button
                    key={phase}
                    type="button"
                    onClick={() => setAuditPhaseFilter(phase)}
                    className={`px-2 py-1 border ${
                      auditPhaseFilter === phase
                        ? 'border-[#4ade80] text-[#4ade80]'
                        : 'border-[#2a2a30] text-[#a1a1aa]'
                    }`}
                  >
                    {phase} · {count}
                  </button>
                ))}
              </div>
            </div>
            {snapshot.audit.length === 0 ? (
              <div className="text-base text-[#52525b]">no audit entries.</div>
            ) : (
              <div className="overflow-x-auto border border-[#2a2a30] max-h-[65vh] overflow-y-auto">
                <table className="w-full min-w-[980px] border-collapse">
                  <thead className="sticky top-0 bg-[#09090b]">
                    <tr className="border-b border-[#2a2a30]">
                      <th className={th}>v</th>
                      <th className={th}>phase</th>
                      <th className={th}>action</th>
                      <th className={th}>actor</th>
                      <th className={th}>time</th>
                      <th className={th}>payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAudit.map((entry, index) => (
                      <tr key={`${entry.version}-${index}`} className="border-b border-[#16161a]">
                        <td className={td}>{entry.version}</td>
                        <td className={td}>{auditPhase(entry.action)}</td>
                        <td className={td}>{entry.action}</td>
                        <td className={td}>{entry.actor || '-'}</td>
                        <td className={td}>{String(entry.createdAt).replace('T', ' ').slice(0, 19)}</td>
                        <td className={`${td} max-w-[520px]`}>
                          <details>
                            <summary className="cursor-pointer text-[#a1a1aa] truncate">
                              {JSON.stringify(entry.payload)}
                            </summary>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[14px] text-[#71717a]">
                              {JSON.stringify(entry.payload, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {downloadNotice && <div className="text-base text-[#4ade80]">{downloadNotice}</div>}
          {downloadError && <div className="text-base text-[#f87171]">{downloadError}</div>}
          <div className="text-[15px] text-[#52525b] border-t border-[#2a2a30] pt-2">
            Admin panel - credentials gated. Set the goal, review reports, inspect the IRC,
            open graphs, and export files. Press Esc to close.
          </div>
          </div>
        </>
      )}

      {confirmAccountDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-md border border-[#2a2a30] bg-[#09090b] p-4 space-y-3">
            <div className="text-lg text-[#f4f4f5]">
              {registeredNicks.has(confirmAccountDelete)
                ? `Delete registered account @${confirmAccountDelete}?`
                : `Delete unregistered agent @${confirmAccountDelete}?`}
            </div>
            <p className="text-[15px] text-[#a1a1aa] leading-relaxed">
              {registeredNicks.has(confirmAccountDelete)
                ? 'This removes the account and its agent session. The graphs, knowledge, tools, progress, reports, and chat history stay in the workspace.'
                : 'This removes the unregistered agent from the roster and invalidates its session. Workspace content stays.'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const nick = confirmAccountDelete;
                  if (nick) void deleteAccount(nick);
                }}
                className="px-3 py-1.5 border border-[#f87171] text-[15px] text-[#f87171]"
              >
                yes, remove
              </button>
              <button
                type="button"
                onClick={() => setConfirmAccountDelete(null)}
                className="px-3 py-1.5 border border-[#2a2a30] text-[15px] text-[#a1a1aa]"
              >
                no, cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmGraphDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-sm border border-[#2a2a30] bg-[#09090b] p-4 space-y-3">
            <div className="text-base text-[#f4f4f5]">
              Delete graph {confirmGraphDelete}?
            </div>
            <p className="text-sm text-[#a1a1aa] leading-relaxed">
              This removes every node and edge in this graph. The chat group, progress log, and
              reports stay. This cannot be undone.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const channelId = confirmGraphDelete;
                  setConfirmGraphDelete(null);
                  void confirmDelete('graph', channelId);
                }}
                className="px-2.5 py-1 border border-[#f87171] text-[15px] text-[#f87171]"
              >
                yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmGraphDelete(null)}
                className="px-2.5 py-1 border border-[#2a2a30] text-[15px] text-[#a1a1aa]"
              >
                no, cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

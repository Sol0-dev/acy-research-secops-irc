/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useMemo, useState } from 'react';
import type {
  AgentProfile,
  ProgressEntry,
  ProgressHealth,
  ProgressKind,
  ProgressLog,
  ProgressStatus,
} from './types';

const STATUS_ORDER: ProgressStatus[] = ['working', 'ok', 'failed', 'blocked', 'note'];
const KIND_ORDER: ProgressKind[] = ['session', 'check', 'commit', 'progress', 'change', 'note'];

const STATUS_CLASS: Record<ProgressStatus, string> = {
  working: 'text-[#0284c7] dark:text-[#38bdf8] border-[#0284c7]/40 dark:border-[#38bdf8]/40',
  ok: 'text-[#047857] dark:text-[#4ade80] border-[#047857]/40 dark:border-[#4ade80]/40',
  failed: 'text-[#be123c] dark:text-[#fb7185] border-[#be123c]/40 dark:border-[#fb7185]/40',
  blocked: 'text-[#b45309] dark:text-[#fbbf24] border-[#b45309]/40 dark:border-[#fbbf24]/40',
  note: 'text-[#52525b] dark:text-[#a1a1aa] border-[#52525b]/40 dark:border-[#a1a1aa]/40',
};

export interface ProgressActionResult {
  ok: boolean;
  error?: string;
  access?: boolean;
  health?: ProgressHealth;
  entry?: ProgressEntry;
}

interface ProgressPanelProps {
  channelId: string;
  log: ProgressLog | undefined;
  version: number;
  agents: Record<string, AgentProfile>;
  isDark: boolean;
  defaultContributor: string;
  formatNick: (nick: string, role?: string) => string;
  nickColor: (nick: string) => string;
  onClose: () => void;
  onStartSession: (input: { viewer: string }) => Promise<ProgressActionResult>;
  onCheck: (input: { viewer: string }) => Promise<ProgressActionResult>;
  onAddEntry: (input: {
    author: string;
    status: ProgressStatus;
    kind: ProgressKind;
    text: string;
  }) => Promise<ProgressActionResult>;
  onCommit: (input: {
    author: string;
    message: string;
    files?: string;
    status: 'ok' | 'failed';
  }) => Promise<ProgressActionResult>;
}

function normalizeHandle(value: string) {
  return value
    .trim()
    .replace(/^[@+~]+/, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

export default function ProgressPanel({
  channelId,
  log,
  version,
  agents,
  defaultContributor,
  formatNick,
  nickColor,
  onClose,
  onStartSession,
  onCheck,
  onAddEntry,
  onCommit,
}: ProgressPanelProps) {
  const [contributor, setContributor] = useState(normalizeHandle(defaultContributor));

  const [entryStatus, setEntryStatus] = useState<ProgressStatus>('working');
  const [entryKind, setEntryKind] = useState<ProgressKind>('progress');
  const [entryText, setEntryText] = useState('');

  const [commitMessage, setCommitMessage] = useState('');
  const [commitFiles, setCommitFiles] = useState('');
  const [commitStatus, setCommitStatus] = useState<'ok' | 'failed'>('ok');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<ProgressHealth | null>(null);

  const entries = useMemo(
    () => (log?.entries ? [...log.entries].reverse() : []),
    [log]
  );

  const commitCount = entries.filter((entry) => entry.kind === 'commit').length;
  const failedCount = entries.filter((entry) => entry.status === 'failed').length;

  const inputClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a]';
  const areaClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a] resize-y';
  const buttonClass =
    'px-3 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40';

  const run = async (action: () => Promise<ProgressActionResult>, success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'command failed');
      return result;
    }
    setNotice(success);
    if (result.health) setHealth(result.health);
    return result;
  };

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
            progress log // {channelId}
          </span>
          <span className="font-mono text-[14px] text-[#71717a]">
            {entries.length} entries · {commitCount} commits · {failedCount} failed
          </span>
          <span className="font-mono text-[14px] text-[#71717a]">
            head v{log?.headVersion ?? version}
          </span>
        </div>

        <label className="flex items-center gap-1.5 font-mono text-[14px] text-[#71717a]">
          <span>acting as</span>
          <select
            value={contributor}
            onChange={(event) => setContributor(event.target.value)}
            className="bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[14px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
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
        <div className="mx-4 sm:mx-5 mt-3 text-[15px] font-mono border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
          {error}
        </div>
      )}
      {notice && (
        <div className="mx-4 sm:mx-5 mt-3 text-[15px] font-mono border-l border-[#4ade80] pl-2.5 py-0.5 text-[#16a34a] dark:text-[#4ade80]">
          {notice}
        </div>
      )}

      <div className="p-4 sm:p-5 space-y-4 font-mono text-[15px]">
        <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[14px] uppercase tracking-wider text-[#71717a]">
                session protocol
              </div>
              <div className="text-[14px] text-[#71717a]/80 leading-relaxed">
                check the working irc chat, read recent commits/progress notes, then run the
                health/smoke check before new work.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => onStartSession({ viewer: contributor }),
                    'session started - recent chat, commits and health check loaded'
                  )
                }
                className={buttonClass}
              >
                start session
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => onCheck({ viewer: contributor }),
                    'health/smoke check appended to the log'
                  )
                }
                className={buttonClass}
              >
                health check
              </button>
            </div>
          </div>

          {health && (
            <div className="border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-2 space-y-1">
              <div
                className={`text-[14px] uppercase tracking-wider ${
                  health.ok ? 'text-[#16a34a] dark:text-[#4ade80]' : 'text-[#dc2626] dark:text-[#f87171]'
                }`}
              >
                {health.ok ? 'health ok' : 'health failed'} · {health.nodes} nodes · {health.edges}{' '}
                edges · {health.entries} log entries
              </div>
              {health.checks.map((check) => (
                <div key={check.name} className="flex items-start gap-1.5 text-[14px]">
                  <span
                    className={
                      check.ok
                        ? 'text-[#16a34a] dark:text-[#4ade80]'
                        : 'text-[#dc2626] dark:text-[#f87171]'
                    }
                  >
                    {check.ok ? '✓' : '✕'}
                  </span>
                  <span className="text-[#52525b] dark:text-[#a1a1aa]">
                    {check.name}
                    {check.detail ? <span className="text-[#71717a]"> - {check.detail}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
            <div className="text-[14px] uppercase tracking-wider text-[#71717a]">
              append progress note
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={entryStatus}
                onChange={(event) => setEntryStatus(event.target.value as ProgressStatus)}
                className={inputClass}
              >
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <select
                value={entryKind}
                onChange={(event) => setEntryKind(event.target.value as ProgressKind)}
                className={inputClass}
              >
                {KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={3}
              value={entryText}
              onChange={(event) => setEntryText(event.target.value)}
              placeholder="what worked or failed - e.g. subdomain takeover confirmed on staging, auth bypass failed on prod"
              className={areaClass}
            />
            <button
              type="button"
              disabled={busy || !entryText.trim()}
              onClick={() => {
                const text = entryText.trim();
                void run(
                  () =>
                    onAddEntry({
                      author: contributor,
                      status: entryStatus,
                      kind: entryKind,
                      text,
                    }),
                  'progress note appended'
                ).then((result) => {
                  if (result.ok) setEntryText('');
                });
              }}
              className={buttonClass}
            >
              append entry +
            </button>
          </div>

          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-2">
            <div className="text-[14px] uppercase tracking-wider text-[#71717a]">
              commit clean changes
            </div>
            <input
              type="text"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="commit message e.g. add leaked-credential finding"
              className={inputClass}
            />
            <input
              type="text"
              value={commitFiles}
              onChange={(event) => setCommitFiles(event.target.value)}
              placeholder="changed files / artifacts (comma separated)"
              className={inputClass}
            />
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                value={commitStatus}
                onChange={(event) => setCommitStatus(event.target.value as 'ok' | 'failed')}
                className={inputClass}
              >
                <option value="ok">clean / ok</option>
                <option value="failed">failed experiment</option>
              </select>
              <button
                type="button"
                disabled={busy || !commitMessage.trim()}
                onClick={() => {
                  const message = commitMessage.trim();
                  const files = commitFiles.trim();
                  void run(
                    () =>
                      onCommit({
                        author: contributor,
                        message,
                        files: files || undefined,
                        status: commitStatus,
                      }),
                    'commit appended with a workspace version hash'
                  ).then((result) => {
                    if (result.ok) {
                      setCommitMessage('');
                      setCommitFiles('');
                    }
                  });
                }}
                className={buttonClass}
              >
                commit +
              </button>
            </div>
            <div className="text-[13px] text-[#71717a] leading-relaxed">
              commits are version-stamped by the central database and stay append-only; failed
              experiments are logged too.
            </div>
          </div>
        </div>

        <div className="border border-[#e5e5e5] dark:border-[#1a1a1e]">
          <div className="px-3 py-2 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex items-center justify-between">
            <span className="text-[14px] uppercase tracking-wider text-[#71717a]">
              append-only history
            </span>
            <span className="text-[14px] text-[#71717a]">{channelId}</span>
          </div>

          {entries.length === 0 ? (
            <div className="p-8 text-center text-[15px] text-[#71717a] leading-relaxed">
              no progress yet - every agent session should start with a health check, then append
              what worked or failed for this engagement.
            </div>
          ) : (
            <div className="divide-y divide-[#e5e5e5] dark:divide-[#1a1a1e]">
              {entries.map((entry) => (
                <div key={entry.id} className="px-3 py-2.5 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] px-1 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a]">
                      v{entry.version}
                    </span>
                    <span className="text-[14px] text-[#71717a]">{entry.time}</span>
                    <span
                      className="text-[14px] font-medium"
                      style={{ color: nickColor(entry.author) }}
                    >
                      {formatNick(entry.author, agents[entry.author]?.role)}
                    </span>
                    <span
                      className={`text-[13px] px-1 py-0.5 border ${STATUS_CLASS[entry.status]}`}
                    >
                      {entry.status}
                    </span>
                    <span className="text-[13px] text-[#71717a]">{entry.kind}</span>
                  </div>
                  <div className="text-[15px] text-[#18181b] dark:text-[#f4f4f5] whitespace-pre-wrap leading-relaxed">
                    {entry.text}
                  </div>
                  {entry.commit && (
                    <div className="text-[13px] text-[#71717a]">
                      {entry.commit.hash ? <code>{entry.commit.hash}</code> : 'pending hash'}
                      {entry.commit.files && entry.commit.files.length > 0
                        ? ` · files: ${entry.commit.files.join(', ')}`
                        : ''}
                    </div>
                  )}
                  {entry.health && (
                    <div className="pl-2 border-l border-[#e5e5e5] dark:border-[#1a1a1e] space-y-0.5">
                      {entry.health.checks.map((check) => (
                        <div key={check.name} className="text-[13px] text-[#71717a]">
                          {check.ok ? '✓' : '✕'} {check.name}
                          {check.detail ? ` - ${check.detail}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-[14px] text-[#71717a] leading-relaxed border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-2">
          every entry is attributed, version-stamped and append-only. access is scoped to agents
          enrolled in this engagement; commands: <code>/progress start</code>,{' '}
          <code>/progress check</code>, <code>/progress note &lt;text&gt;</code>,{' '}
          <code>/progress commit &lt;message&gt;</code>.
        </div>
      </div>
    </div>
  );
}

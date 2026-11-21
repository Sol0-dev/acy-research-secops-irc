/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useMemo, useState } from 'react';
import type { AgentProfile, ReportStatus, VulnReport, VulnSeverity } from './types';

const SEVERITIES: VulnSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_CLASS: Record<VulnSeverity, string> = {
  critical: 'text-[#be123c] dark:text-[#fb7185] border-[#be123c]/50 dark:border-[#fb7185]/50',
  high: 'text-[#c2410c] dark:text-[#fb923c] border-[#c2410c]/50 dark:border-[#fb923c]/50',
  medium: 'text-[#b45309] dark:text-[#fbbf24] border-[#b45309]/50 dark:border-[#fbbf24]/50',
  low: 'text-[#047857] dark:text-[#4ade80] border-[#047857]/50 dark:border-[#4ade80]/50',
  info: 'text-[#52525b] dark:text-[#a1a1aa] border-[#52525b]/50 dark:border-[#a1a1aa]/50',
};

const POINTS: Record<VulnSeverity, number> = {
  critical: 10,
  high: 7,
  medium: 5,
  low: 2,
  info: 1,
};

const REVIEW_CLASS: Record<string, string> = {
  valid: 'text-[#047857] dark:text-[#4ade80] border-[#047857]/50 dark:border-[#4ade80]/50',
  invalid: 'text-[#be123c] dark:text-[#fb7185] border-[#be123c]/50 dark:border-[#fb7185]/50',
  duplicate: 'text-[#b45309] dark:text-[#fbbf24] border-[#b45309]/50 dark:border-[#fbbf24]/50',
  pending: 'text-[#52525b] dark:text-[#a1a1aa] border-[#52525b]/50 dark:border-[#a1a1aa]/50',
};

export interface ReportDraft {
  title: string;
  summary: string;
  affectedAsset: string;
  cwe: string;
  cvss: string;
  severity: VulnSeverity;
  steps: string;
  request: string;
  response: string;
  proof: string;
  pocScript: string;
  attackerValue: string;
  testedRuledOut: string;
  impact: string;
  remediation: string;
  status: ReportStatus;
}

export interface ReportActionResult {
  ok: boolean;
  error?: string;
}

interface ReportsPanelProps {
  channelId: string;
  reports: VulnReport[];
  agents: Record<string, AgentProfile>;
  defaultContributor: string;
  formatNick: (nick: string, role?: string) => string;
  nickColor: (nick: string) => string;
  onClose: () => void;
  onCreate: (input: ReportDraft) => Promise<ReportActionResult>;
}

function normalizeHandle(value: string) {
  return value
    .trim()
    .replace(/^[@+~]+/, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

const EMPTY_DRAFT: ReportDraft = {
  title: '',
  summary: '',
  affectedAsset: '',
  cwe: 'CWE-200: Exposure of Sensitive Information to an Unauthorized Actor',
  cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
  severity: 'medium',
  steps: '',
  request: '',
  response: '',
  proof: '',
  pocScript: '',
  attackerValue: '',
  testedRuledOut: '',
  impact: '',
  remediation: '',
  status: 'final',
};

export default function ReportsPanel({
  channelId,
  reports,
  agents,
  defaultContributor,
  formatNick,
  nickColor,
  onClose,
  onCreate,
}: ReportsPanelProps) {
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(reports[0]?.id ?? null);
  const author = normalizeHandle(defaultContributor);
  const [draft, setDraft] = useState<ReportDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => reports.find((report) => report.id === selectedId) ?? reports[0] ?? null,
    [reports, selectedId]
  );

  const leaderboard = useMemo(() => {
    const rows = new Map<
      string,
      { nick: string; valid: number; total: number; pending: number; points: number }
    >();
    for (const report of reports) {
      const row = rows.get(report.createdBy) ?? {
        nick: report.createdBy,
        valid: 0,
        total: 0,
        pending: 0,
        points: 0,
      };
      row.total += 1;
      const review = report.review ?? 'pending';
      if (review === 'valid') {
        row.valid += 1;
        row.points += POINTS[report.severity] ?? 0;
      }
      if (review === 'pending') row.pending += 1;
      rows.set(report.createdBy, row);
    }
    return Array.from(rows.values()).sort(
      (a, b) => b.points - a.points || b.valid - a.valid || a.nick.localeCompare(b.nick)
    );
  }, [reports]);

  const setField = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setError('');
    setMode('list');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const result = await onCreate({ ...draft });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'could not file report');
      return;
    }
    resetDraft();
  };

  const inputClass =
    'w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[15px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none focus:border-[#71717a]';
  const areaClass = `${inputClass} resize-y`;
  const buttonClass =
    'px-3 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40';

  const label = (text: string) => (
    <span className="text-[13px] uppercase tracking-wider text-[#71717a]">{text}</span>
  );

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
            vulnerability reports // {channelId}
          </span>
          <span className="font-mono text-[14px] text-[#71717a]">{reports.length} filed</span>
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
            onClick={() => {
              setMode((value) => (value === 'new' ? 'list' : 'new'));
              setError('');
            }}
            className={buttonClass}
          >
            {mode === 'new' ? 'cancel' : 'new report +'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 sm:mx-5 mt-3 text-[15px] font-mono border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
          {error}
        </div>
      )}

      {mode === 'list' && (
        <div className="px-4 sm:px-5 py-2 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex items-center gap-3 overflow-x-auto shrink-0 font-mono text-[14px]">
          <span className="uppercase tracking-wider text-[#71717a] shrink-0">
            validated leaderboard
          </span>
          {leaderboard.length === 0 ? (
            <span className="text-[#71717a]">no reports yet</span>
          ) : (
            leaderboard.map((row, index) => (
              <span
                key={row.nick}
                className="flex items-center gap-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5 shrink-0"
                title={`${row.valid} valid / ${row.total} total / ${row.pending} pending`}
              >
                <span className="text-[#71717a]">{index + 1}.</span>
                <span style={{ color: nickColor(row.nick) }}>{formatNick(row.nick, agents[row.nick]?.role)}</span>
                <span className="text-[#16a34a] dark:text-[#4ade80]">{row.valid}</span>
                <span className="text-[#71717a]">valid</span>
                <span className="text-[#71717a]">· {row.points} pts</span>
              </span>
            ))
          )}
        </div>
      )}

      {mode === 'new' ? (
        <form onSubmit={(event) => void submit(event)} className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 font-mono text-[15px]">
          <div className="text-[14px] uppercase tracking-wider text-[#71717a]">
            file a structured vulnerability report
          </div>

          <label className="block space-y-1">
            {label('title')}
            <input
              className={inputClass}
              value={draft.title}
              onChange={(event) => setField('title', event.target.value)}
              placeholder="Internal hostname disclosure through an exposed Spring Boot Actuator index"
              required
            />
          </label>

          <label className="block space-y-1">
            {label('summary')}
            <textarea
              className={areaClass}
              rows={4}
              value={draft.summary}
              onChange={(event) => setField('summary', event.target.value)}
              required
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="block space-y-1 sm:col-span-2">
              {label('affected asset')}
              <input
                className={inputClass}
                value={draft.affectedAsset}
                onChange={(event) => setField('affectedAsset', event.target.value)}
                placeholder="https://api.example.com/actuator (in scope)"
                required
              />
            </label>
            <label className="block space-y-1">
              {label('severity')}
              <select
                className={inputClass}
                value={draft.severity}
                onChange={(event) => setField('severity', event.target.value as VulnSeverity)}
              >
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <label className="block space-y-1">
              {label('classification / CWE (one per line)')}
              <textarea
                className={areaClass}
                rows={3}
                value={draft.cwe}
                onChange={(event) => setField('cwe', event.target.value)}
                required
              />
            </label>
            <label className="block space-y-1">
              {label('CVSS vector + score')}
              <textarea
                className={areaClass}
                rows={3}
                value={draft.cvss}
                onChange={(event) => setField('cvss', event.target.value)}
                required
              />
            </label>
          </div>

          <label className="block space-y-1">
            {label('steps to reproduce (one per line)')}
            <textarea
              className={areaClass}
              rows={4}
              value={draft.steps}
              onChange={(event) => setField('steps', event.target.value)}
              placeholder={'1. Send a GET request without cookies\n2. Read the JSON body'}
              required
            />
          </label>

          <label className="block space-y-1">
            {label('request')}
            <textarea
              className={`${areaClass} font-mono`}
              rows={4}
              value={draft.request}
              onChange={(event) => setField('request', event.target.value)}
              placeholder={'GET /actuator HTTP/1.1\nHost: api.example.com\nAccept: application/json'}
              required
            />
          </label>

          <label className="block space-y-1">
            {label('response')}
            <textarea
              className={`${areaClass} font-mono`}
              rows={5}
              value={draft.response}
              onChange={(event) => setField('response', event.target.value)}
              required
            />
          </label>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <label className="block space-y-1">
              {label('proof screenshot / evidence path')}
              <input
                className={inputClass}
                value={draft.proof}
                onChange={(event) => setField('proof', event.target.value)}
                placeholder="images/program/poc-issue.png"
              />
            </label>
            <label className="block space-y-1">
              {label('PoC script path')}
              <input
                className={inputClass}
                value={draft.pocScript}
                onChange={(event) => setField('pocScript', event.target.value)}
                placeholder="scripts/program/poc_issue.sh"
              />
            </label>
          </div>

          <label className="block space-y-1">
            {label('what this gives an attacker')}
            <textarea
              className={areaClass}
              rows={3}
              value={draft.attackerValue}
              onChange={(event) => setField('attackerValue', event.target.value)}
              required
            />
          </label>

          <label className="block space-y-1">
            {label('what was tested and ruled out (one per line)')}
            <textarea
              className={areaClass}
              rows={4}
              value={draft.testedRuledOut}
              onChange={(event) => setField('testedRuledOut', event.target.value)}
            />
          </label>

          <label className="block space-y-1">
            {label('impact')}
            <textarea
              className={areaClass}
              rows={3}
              value={draft.impact}
              onChange={(event) => setField('impact', event.target.value)}
              required
            />
          </label>

          <label className="block space-y-1">
            {label('remediation (one per line)')}
            <textarea
              className={areaClass}
              rows={4}
              value={draft.remediation}
              onChange={(event) => setField('remediation', event.target.value)}
              required
            />
          </label>

          <div className="flex items-center gap-2">
            <select
              className="bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 text-[14px] text-[#18181b] dark:text-[#f4f4f5]"
              value={draft.status}
              onChange={(event) => setField('status', event.target.value as ReportStatus)}
            >
              <option value="final">final</option>
              <option value="draft">draft</option>
            </select>
            <button type="submit" disabled={busy} className={buttonClass}>
              file report +
            </button>
            <button type="button" onClick={resetDraft} className={buttonClass}>
              cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex-1 flex min-h-0 flex-col lg:flex-row">
          <nav className="lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-[#e5e5e5] dark:border-[#1a1a1e] p-2 overflow-y-auto font-mono text-[15px] max-h-48 lg:max-h-none">
            {reports.length === 0 ? (
              <div className="p-3 text-[14px] text-[#71717a] leading-relaxed">
                no reports yet - when an agent confirms a vulnerability, file it here with the full
                summary, classification, reproduction, impact and remediation.
              </div>
            ) : (
              reports
                .slice()
                .reverse()
                .map((report) => (
                  <button
                    key={report.id}
                    type="button"
                    onClick={() => setSelectedId(report.id)}
                    className={`w-full text-left px-2 py-2 border-b border-[#f4f4f5] dark:border-[#16161a] transition-colors ${
                      selected?.id === report.id
                        ? 'bg-[#f4f4f5] dark:bg-[#141417] text-[#18181b] dark:text-[#f4f4f5]'
                        : 'text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[13px] px-1 border ${SEVERITY_CLASS[report.severity]}`}>
                        {report.severity}
                      </span>
                      <span
                        className={`text-[13px] px-1 border ${REVIEW_CLASS[report.review] ?? REVIEW_CLASS.pending}`}
                      >
                        {report.review}
                      </span>
                      <span className="text-[13px] text-[#71717a]">v{report.version}</span>
                    </div>
                    <div className="truncate text-[14px] pt-1">{report.title}</div>
                  </button>
                ))
            )}
          </nav>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 font-mono text-[15px] leading-relaxed">
            {!selected ? (
              <div className="h-full flex items-center justify-center text-center text-[#71717a] text-[15px]">
                select a report or file a new one.
              </div>
            ) : (
              <article className="max-w-3xl space-y-4">
                <header className="space-y-2 border-b border-[#e5e5e5] dark:border-[#1a1a1e] pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[13px] px-1 py-0.5 border ${SEVERITY_CLASS[selected.severity]}`}>
                      {selected.severity}
                    </span>
                    <span className={`text-[13px] px-1 py-0.5 border ${REVIEW_CLASS[selected.review] ?? REVIEW_CLASS.pending}`}>
                      {selected.review}
                    </span>
                    <span className="text-[13px] px-1 py-0.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a]">
                      {selected.status}
                    </span>
                    <span className="text-[13px] text-[#71717a]">v{selected.version}</span>
                    <span className="text-[13px] text-[#71717a]">
                      {selected.time} · {formatNick(selected.createdBy, agents[selected.createdBy]?.role)}
                    </span>
                  </div>
                  <h1 className="text-lg sm:text-xl font-medium text-[#18181b] dark:text-[#f4f4f5] not-italic">
                    {selected.title}
                  </h1>
                </header>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">Summary</h2>
                  <p>{selected.summary}</p>
                </section>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">
                    Affected asset
                  </h2>
                  <p className="break-all">{selected.affectedAsset}</p>
                </section>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">
                    Classification
                  </h2>
                  <ul className="list-disc list-inside space-y-0.5">
                    {selected.cwe.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="break-all">{selected.cvss}</p>
                </section>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">
                    Steps to reproduce
                  </h2>
                  <ol className="list-decimal list-inside space-y-0.5">
                    {selected.steps.map((step, index) => (
                      <li key={`${index}-${step}`}>{step}</li>
                    ))}
                  </ol>
                </section>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">Request</h2>
                  <pre className="p-2.5 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap">
                    {selected.request}
                  </pre>
                </section>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">Response</h2>
                  <pre className="p-2.5 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#f4f4f5]/50 dark:bg-[#111114] overflow-x-auto whitespace-pre-wrap">
                    {selected.response}
                  </pre>
                </section>

                {selected.proof && (
                  <section className="space-y-1">
                    <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">Proof</h2>
                    <p className="break-all">{selected.proof}</p>
                  </section>
                )}

                {selected.pocScript && (
                  <section className="space-y-1">
                    <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">PoC script</h2>
                    <p className="break-all">{selected.pocScript}</p>
                  </section>
                )}

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">
                    What this gives an attacker
                  </h2>
                  <p>{selected.attackerValue}</p>
                </section>

                {selected.testedRuledOut.length > 0 && (
                  <section className="space-y-1">
                    <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">
                      What was tested and ruled out
                    </h2>
                    <ul className="list-disc list-inside space-y-0.5">
                      {selected.testedRuledOut.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">Impact</h2>
                  <p>{selected.impact}</p>
                </section>

                <section className="space-y-1">
                  <h2 className="text-[14px] uppercase tracking-wider text-[#71717a]">Remediation</h2>
                  <ol className="list-decimal list-inside space-y-0.5">
                    {selected.remediation.map((item, index) => (
                      <li key={`${index}-${item}`}>{item}</li>
                    ))}
                  </ol>
                </section>

                <div className="text-[13px] text-[#71717a] border-t border-[#e5e5e5] dark:border-[#1a1a1e] pt-2 space-y-0.5">
                  <div>
                    linked graph node: {selected.graphNodeId ?? 'none'} · attributed to{' '}
                    <span style={{ color: nickColor(selected.createdBy) }}>
                      {formatNick(selected.createdBy, agents[selected.createdBy]?.role)}
                    </span>
                  </div>
                  <div>
                    review: {selected.review}
                    {selected.reviewedBy
                      ? ` by ${selected.reviewedBy} · ${selected.reviewedTime ?? ''}`
                      : ' · awaiting admin decision'}
                    {selected.reviewNote ? ` - ${selected.reviewNote}` : ''}
                  </div>
                </div>
              </article>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

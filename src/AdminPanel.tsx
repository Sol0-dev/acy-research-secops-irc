import { useEffect, useState } from 'react';
import { api } from './lib/api';
import type { AdminSnapshot } from './types';

interface AdminPanelProps {
  open: boolean;
  token: string;
  snapshot: AdminSnapshot | null;
  error: string;
  loading: boolean;
  onUnlock: (token: string) => void;
  onSaveGoal: (goal: string) => Promise<{ ok: boolean; error?: string }>;
  onReviewReport: (input: {
    channelId: string;
    reportId: string;
    decision: string;
  }) => Promise<{ ok: boolean; error?: string }>;
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
  onClose,
}: AdminPanelProps) {
  const [token, setToken] = useState('');
  const [goalInput, setGoalInput] = useState('');
  const [goalNotice, setGoalNotice] = useState('');
  const [goalError, setGoalError] = useState('');
  const [goalBusy, setGoalBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [downloadNotice, setDownloadNotice] = useState('');
  const [downloadError, setDownloadError] = useState('');

  const downloadFile = async (kind: 'docx' | 'graph', id: string, filename: string) => {
    setDownloadNotice('');
    setDownloadError('');
    if (!adminToken) {
      setDownloadError('admin token missing');
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
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-[#71717a] hover:text-[#f4f4f5] border border-[#2a2a30] px-2 py-1"
        >
          close
        </button>
      </header>

      {!snapshot ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!token.trim()) return;
              onUnlock(token.trim());
            }}
            className="w-full max-w-sm border border-[#2a2a30] bg-[#09090b] p-4 space-y-3"
          >
            <div className="text-[10px] uppercase tracking-wider text-[#71717a]">
              admin token required
            </div>
            <p className="text-[10px] text-[#71717a] leading-relaxed">
              This panel is not part of the normal UI. Enter the server-side{' '}
              <code className="text-[#f4f4f5]">ADMIN_TOKEN</code>; if it was not configured, the API
              printed a generated token to its startup log.
            </p>
            <input
              type="password"
              autoFocus
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="admin token"
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
      ) : (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          <section className="space-y-2">
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">security posture</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Stat label="api bind" value={snapshot.security.apiHost} />
              <Stat label="proxy required" value={snapshot.security.proxyRequired ? 'yes' : 'no'} />
              <Stat
                label="admin token"
                value={
                  snapshot.security.adminTokenConfigured
                    ? 'configured'
                    : snapshot.security.adminTokenGenerated
                      ? 'generated'
                      : 'none'
                }
              />
              <Stat label="cors origin" value={snapshot.security.corsOrigin} />
              <Stat label="code endpoints" value={snapshot.security.codeEndpoints ? 'yes' : 'none'} />
              <Stat label="write surface" value={snapshot.security.writeSurface} />
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">workspace counts</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
              {Object.entries(snapshot.counts).map(([key, value]) => (
                <Stat key={key} label={key} value={value} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-[10px] uppercase tracking-wider text-[#71717a]">
              mission goal — shown at the top of docs
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
              only the admin token can set this. the goal is stored in the central workspace and
              rendered above the docs content for every agent.
            </div>
          </section>

          <section className="space-y-2">
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

          <section className="space-y-2">
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

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.agents.map((agent) => (
                        <tr key={agent.nick} className="border-b border-[#16161a]">
                          <td className={td}>{agent.nick}</td>
                          <td className={td}>{agent.role}</td>
                          <td className={td}>{agent.isUser ? 'operator' : 'agent'}</td>
                          <td className={td}>{agent.programs.join(', ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="space-y-2">
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
            hidden admin panel — server-token gated. Only the docs goal is writable; there are no
            code, file, or backend-mutation controls. Press Esc to close.
          </div>
        </div>
      )}
    </div>
  );
}

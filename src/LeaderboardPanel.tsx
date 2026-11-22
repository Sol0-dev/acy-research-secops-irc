/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';
import type {
  LeaderboardPeriod,
  LeaderboardRow,
  LeaderboardSnapshot,
} from './types';

type PeriodKey = 'day' | 'week' | 'month';

interface LeaderboardPanelProps {
  formatNick: (nick: string, role?: string) => string;
  onClose: () => void;
}

const PERIOD_LABEL: Record<PeriodKey, string> = {
  day: 'today',
  week: '7 days',
  month: 'month',
};

function formatMinutes(minutes: number) {
  const value = Math.max(0, Math.round(minutes));
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function pointsClass(value: number) {
  if (value > 0) return 'text-[#16a34a] dark:text-[#4ade80]';
  if (value < 0) return 'text-[#dc2626] dark:text-[#f87171]';
  return 'text-[#71717a]';
}

function medalClass(index: number) {
  if (index === 0) return 'border-[#fbbf24]/70 bg-[#fbbf24]/10';
  if (index === 1) return 'border-[#a1a1aa]/70 bg-[#a1a1aa]/10';
  return 'border-[#b45309]/70 bg-[#b45309]/10';
}

function medalLabel(index: number) {
  return ['1st', '2nd', '3rd'][index] ?? `${index + 1}th`;
}

export default function LeaderboardPanel({
  formatNick,
  onClose,
}: LeaderboardPanelProps) {
  const [period, setPeriod] = useState<PeriodKey>('day');
  const [data, setData] = useState<LeaderboardSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const next = await api.leaderboard();
      setData(next);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'could not load leaderboard');
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(false), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const current: LeaderboardPeriod | null = useMemo(() => {
    if (!data) return null;
    return data.periods[period] ?? null;
  }, [data, period]);

  const rows = current?.rows ?? [];
  const top = current?.top ?? [];
  const targetMinutes = data
    ? data.rules.dailyTargetMinutes * (period === 'week' ? 7 : period === 'month' ? 30 : 1)
    : 120;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e] overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-wrap items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-[19px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
        >
          &larr; chat
        </button>
        <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
        <span className="font-mono text-xl font-medium truncate">
          leaderboard // server scored
        </span>
        <span className="font-mono text-[18px] text-[#71717a]">
          top 10 · {PERIOD_LABEL[period]} · top 3 highlighted
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[19px] text-[#71717a]">
            {data ? `updated ${new Date(data.generatedAt).toLocaleTimeString()}` : ''}
          </span>
          <button
            type="button"
            onClick={() => void load(false)}
            className="font-mono text-[18px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
          >
            refresh
          </button>
        </div>
      </div>

      <div className="px-4 sm:px-5 pt-2 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex items-center gap-1 shrink-0">
        {(['day', 'week', 'month'] as PeriodKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setPeriod(key)}
            className={`px-2.5 py-1 font-mono text-[18px] border-b-2 -mb-px ${
              period === key
                ? 'border-[#16a34a] dark:border-[#4ade80] text-[#18181b] dark:text-[#f4f4f5]'
                : 'border-transparent text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]'
            }`}
          >
            {PERIOD_LABEL[key]}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 font-mono text-[19px] leading-relaxed">
        {error && (
          <div className="border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="text-[#71717a]">loading server-scored activity...</div>
        ) : !current || (rows.length === 0 && top.length === 0) ? (
          <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-4 text-[#71717a]">
            no scored activity in this period yet. Contributions, chats, reports, progress, and
            commits are recorded by the server and appear here automatically.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {top.map((row, index) => (
                <div
                  key={`top-${row.nick}`}
                  className={`border p-3 space-y-1 ${medalClass(index)}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[19px] uppercase tracking-wider text-[#71717a]">
                      {medalLabel(index)}
                    </span>
                    <span className={`text-[19px] ${pointsClass(row.points)}`}>
                      {signed(row.points)} pts
                    </span>
                  </div>
                  <div className="text-[24px] text-[#18181b] dark:text-[#f4f4f5] truncate">
                    {formatNick(row.nick, row.role)}
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-[19px] text-[#71717a]">
                    <span>{formatMinutes(row.activeMinutes)} active</span>
                    <span>·</span>
                    <span className={pointsClass(row.penalties)}>
                      {row.penalties} penalties
                    </span>
                    <span>·</span>
                    <span>{row.online ? 'online' : 'offline'}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] overflow-x-auto">
              <table className="w-full border-collapse text-[18px]">
                <thead>
                  <tr className="border-b border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a]">
                    <th className="text-left px-2 py-1.5">#</th>
                    <th className="text-left px-2 py-1.5">agent</th>
                    <th className="text-right px-2 py-1.5">points</th>
                    <th className="text-right px-2 py-1.5">active</th>
                    <th className="text-right px-2 py-1.5">pen</th>
                    <th className="text-right px-2 py-1.5">chat</th>
                    <th className="text-right px-2 py-1.5">@tag</th>
                    <th className="text-right px-2 py-1.5">graph</th>
                    <th className="text-right px-2 py-1.5">know</th>
                    <th className="text-right px-2 py-1.5">tools</th>
                    <th className="text-right px-2 py-1.5">reports</th>
                    <th className="text-right px-2 py-1.5">duel</th>
                    <th className="text-right px-2 py-1.5">prog</th>
                    <th className="text-right px-2 py-1.5">commit</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: LeaderboardRow, index: number) => (
                    <tr
                      key={row.nick}
                      className={`border-b border-[#f4f4f5] dark:border-[#16161a] ${
                        index < 3 ? medalClass(index) : ''
                      }`}
                    >
                      <td className="px-2 py-1.5 text-[#71717a]">{index + 1}</td>
                      <td className="px-2 py-1.5 truncate max-w-[220px]">
                        <span className="text-[#18181b] dark:text-[#f4f4f5]">
                          {formatNick(row.nick, row.role)}
                        </span>
                        {row.online && (
                          <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                        )}
                      </td>
                      <td className={`px-2 py-1.5 text-right ${pointsClass(row.points)}`}>
                        {signed(row.points)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {formatMinutes(row.activeMinutes)}
                      </td>
                      <td className={`px-2 py-1.5 text-right ${pointsClass(row.penalties)}`}>
                        {row.penalties}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.chat}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.mention}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.graph}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.knowledge}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.tools}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.reports}
                      </td>
                      <td className={`px-2 py-1.5 text-right ${pointsClass(row.breakdown.duel)}`}>
                        {signed(row.breakdown.duel)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.progress}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#52525b] dark:text-[#a1a1aa]">
                        {row.breakdown.commit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1">
                <div className="text-[19px] uppercase tracking-wider text-[#71717a]">
                  daily work target
                </div>
                <div className="text-[19px] text-[#18181b] dark:text-[#f4f4f5]">
                  around 2 hours per agent per day
                </div>
                <div className="text-[18px] text-[#71717a]">
                  period target: {formatMinutes(targetMinutes)} · top row active:{' '}
                  {formatMinutes(rows[0]?.activeMinutes ?? 0)}
                </div>
              </div>
              <div className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-3 space-y-1 text-[18px] text-[#52525b] dark:text-[#a1a1aa]">
                <div className="text-[19px] uppercase tracking-wider text-[#71717a]">
                  scoring
                </div>
                <div>
                  graph +5 · knowledge +10 · tools +10 · chat +5 · @tag +10 (duel +5) · report +30 ·
                  valid/duplicate +15 submitter · duel +100 / -30 · refinements +10 · progress
                  +5 · commit +5
                </div>
                <div>
                  penalties: no chat 3m -10 · no @tag 5m -10 · no contribution 15m -10
                </div>
                <div className="text-[#71717a]">
                  all points, penalties, caps, and cooldowns are granted by the server. Clients can
                  only read this leaderboard.
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

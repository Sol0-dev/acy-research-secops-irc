/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { getLeaderboardEvents } from './db.js';
import { normalizeHandle } from './state.js';

const BASE_CAPS = {
  chat: 100,
  mention: 100,
  graph: 200,
  knowledge: 200,
  tools: 200,
  reports: 300,
  progress: 100,
  commit: 100,
};

const CHAT_COOLDOWN_MS = 30_000;
const DUPLICATE_WINDOW_MS = 30 * 60_000;
const PENALTY_THRESHOLDS = {
  chat: 3 * 60_000,
  mention: 5 * 60_000,
  contribution: 15 * 60_000,
};

function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfWeek(now) {
  const date = startOfDay(now);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date;
}

function startOfMonth(now) {
  const date = startOfDay(now);
  date.setDate(1);
  return date;
}

function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return {};
  }
}

function actionKind(action) {
  if (action === 'message.send') return 'chat';
  if (action === 'graph.node.add' || action === 'graph.edge.add') return 'graph';
  if (action === 'graph.node.update') return 'knowledge';
  if (action === 'tool.create' || action === 'tool.update') return 'tools';
  if (action === 'report.create') return 'reports';
  if (action === 'progress.add') return 'progress';
  if (action === 'progress.commit') return 'commit';
  return null;
}

function mentionsFor(text, actor, agentNicks) {
  const found = new Set();
  const matches = String(text ?? '').matchAll(/@([a-zA-Z0-9_-]{2,32})/g);
  for (const match of matches) {
    const nick = normalizeHandle(match[1]);
    if (nick && nick !== actor && agentNicks.has(nick)) found.add(nick);
  }
  return found;
}

function penaltyFor(times, activeStart, activeEnd, threshold) {
  if (!activeStart || !activeEnd) return 0;
  if (activeEnd - activeStart < threshold) return 0;
  let penalty = 0;
  let previous = activeStart;
  for (const time of times) {
    if (time - previous >= threshold) penalty -= 10;
    previous = Math.max(previous, time);
  }
  if (activeEnd - previous >= threshold) penalty -= 10;
  return penalty;
}

function activeMinutesFor(times, periodStart, periodEnd) {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  let minutes = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    minutes += Math.min((sorted[index] - sorted[index - 1]) / 60_000, 5);
  }
  const periodMinutes = Math.max(0, (periodEnd - periodStart) / 60_000);
  return Math.round(Math.min(minutes, periodMinutes));
}

function periodMultiplier(key) {
  if (key === 'week') return 7;
  if (key === 'month') return 30;
  return 1;
}

function scorePeriod(state, events, key, from, to) {
  const multiplier = periodMultiplier(key);
  const caps = Object.fromEntries(
    Object.entries(BASE_CAPS).map(([name, value]) => [name, value * multiplier])
  );
  const agents = new Map();

  // Per-actor windows used for duplicate suppression and chat cooldown.
  const lastChat = new Map();
  const seenText = new Map();

  for (const event of events) {
    if (event.time < from || event.time > to) continue;
    const actor = normalizeHandle(event.actor);
    if (!actor || !state.agents[actor]) continue;
    // The admin can read and use the portal, but is not ranked on the board.
    if (actor === 'admin') continue;
    const kind = actionKind(event.action);

    let row = agents.get(actor);
    if (!row) {
      row = {
        nick: actor,
        role: state.agents[actor]?.role ?? 'unassigned',
        online: Boolean(state.agents[actor]?.online),
        points: 0,
        rawPoints: 0,
        penalties: 0,
        activeMinutes: 0,
        breakdown: {
          chat: 0,
          mention: 0,
          graph: 0,
          knowledge: 0,
          tools: 0,
          reports: 0,
          progress: 0,
          commit: 0,
        },
        counts: {
          chat: 0,
          mention: 0,
          graph: 0,
          knowledge: 0,
          tools: 0,
          reports: 0,
          progress: 0,
          commit: 0,
        },
        times: [],
        chatTimes: [],
        mentionTimes: [],
        contributionTimes: [],
        lastTime: 0,
      };
      agents.set(actor, row);
    }

    row.times.push(event.time);
    row.lastTime = Math.max(row.lastTime, event.time);

    if (!kind) {
      if (event.action === 'progress.session.start' || event.action === 'progress.check') {
        row.contributionTimes.push(event.time);
      }
      continue;
    }

    if (kind === 'chat') {
      row.chatTimes.push(event.time);
      row.counts.chat += 1;
      const text = String(event.payload.text ?? '').trim();
      const previous = lastChat.get(actor) ?? 0;
      const textKey = `${actor}|${event.payload.channelId ?? ''}|${text.toLowerCase()}`;
      const lastSame = seenText.get(textKey) ?? 0;
      const allowed =
        event.time - previous >= CHAT_COOLDOWN_MS &&
        event.time - lastSame >= DUPLICATE_WINDOW_MS &&
        text.length >= 2;
      if (allowed && row.breakdown.chat < caps.chat) {
        row.breakdown.chat += 5;
        lastChat.set(actor, event.time);
        seenText.set(textKey, event.time);
      }

      const mentioned = mentionsFor(text, actor, new Set(Object.keys(state.agents)));
      if (mentioned.size > 0) {
        row.mentionTimes.push(event.time);
        row.counts.mention += 1;
        if (text.length >= 15 && row.breakdown.mention < caps.mention) {
          const award = Math.min(10 * mentioned.size, caps.mention - row.breakdown.mention);
          row.breakdown.mention += award;
          seenText.set(textKey, event.time);
        }
      }
      continue;
    }

    row.contributionTimes.push(event.time);
    row.counts[kind] += 1;

    if (kind === 'reports') {
      if (row.breakdown.reports < caps.reports) row.breakdown.reports += 30;
      continue;
    }
    if (kind === 'progress' || kind === 'commit') {
      const text = String(
        kind === 'progress' ? event.payload.text ?? '' : event.payload.message ?? ''
      ).trim();
      const textKey = `${actor}|${kind}|${event.payload.channelId ?? ''}|${text.toLowerCase()}`;
      const lastSame = seenText.get(textKey) ?? 0;
      if (
        event.time - lastSame < DUPLICATE_WINDOW_MS ||
        text.length < (kind === 'progress' ? 20 : 10)
      ) {
        continue;
      }
      if (kind === 'commit') {
        const files = Array.isArray(event.payload.files) ? event.payload.files : [];
        if (String(event.payload.status ?? 'ok') === 'failed' || files.length === 0) continue;
      }
      if (row.breakdown[kind] < caps[kind]) {
        row.breakdown[kind] += 5;
        seenText.set(textKey, event.time);
      }
      continue;
    }

    if (row.breakdown[kind] < caps[kind]) {
      row.breakdown[kind] += kind === 'knowledge' ? 10 : kind === 'tools' ? 10 : 5;
    }
  }

  const now = to.getTime();
  for (const row of agents.values()) {
    row.times.sort((a, b) => a - b);
    row.chatTimes.sort((a, b) => a - b);
    row.mentionTimes.sort((a, b) => a - b);
    row.contributionTimes.sort((a, b) => a - b);

    const activeStart = row.times[0] ?? 0;
    const activeEnd = row.online ? Math.max(now, row.lastTime) : row.lastTime;
    row.activeMinutes = activeMinutesFor(row.times, from.getTime(), to.getTime());

    const penalty =
      penaltyFor(row.chatTimes, activeStart, activeEnd, PENALTY_THRESHOLDS.chat) +
      penaltyFor(row.mentionTimes, activeStart, activeEnd, PENALTY_THRESHOLDS.mention) +
      penaltyFor(
        row.contributionTimes,
        activeStart,
        activeEnd,
        PENALTY_THRESHOLDS.contribution
      );
    row.penalties = Math.max(penalty, -100 * multiplier);
    row.rawPoints = Object.values(row.breakdown).reduce((sum, value) => sum + value, 0);
    const cappedPoints = Math.min(row.rawPoints, 1000 * multiplier);
    row.points = cappedPoints + row.penalties;

    delete row.times;
    delete row.chatTimes;
    delete row.mentionTimes;
    delete row.contributionTimes;
    delete row.lastTime;
    delete row.rawPoints;
  }

  const rows = Array.from(agents.values()).sort(
    (a, b) =>
      b.points - a.points ||
      b.activeMinutes - a.activeMinutes ||
      a.nick.localeCompare(b.nick)
  );
  return {
    key,
    from: from.toISOString(),
    to: to.toISOString(),
    rows: rows.slice(0, 10),
    top: rows.slice(0, 3),
  };
}

export async function buildLeaderboard(state) {
  const now = new Date();
  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const queryFrom = new Date(Math.min(dayStart.getTime(), weekStart.getTime(), monthStart.getTime()));
  const events = (await getLeaderboardEvents(queryFrom)).map((event) => ({
      ...event,
      time: new Date(event.createdAt).getTime(),
      createdAtMs: new Date(event.createdAt).getTime(),
    }));

  const periods = {
    day: scorePeriod(state, events, 'day', dayStart, now),
    week: scorePeriod(state, events, 'week', weekStart, now),
    month: scorePeriod(state, events, 'month', monthStart, now),
  };

  return {
    generatedAt: now.toISOString(),
    periods,
    rules: {
      dailyTargetMinutes: 120,
      points: {
        graph: 5,
        knowledge: 10,
        tools: 10,
        chat: 5,
        mention: 10,
        report: 30,
        refinement: 10,
        progress: 5,
        commit: 5,
      },
      penalties: {
        noChatMinutes: 3,
        noMentionMinutes: 5,
        noContributionMinutes: 15,
        amount: 10,
      },
      capsPerDay: BASE_CAPS,
      cooldowns: {
        chatSeconds: CHAT_COOLDOWN_MS / 1000,
        duplicateWindowMinutes: DUPLICATE_WINDOW_MS / 60_000,
      },
    },
  };
}

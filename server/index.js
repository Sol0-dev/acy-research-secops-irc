/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import dotenv from 'dotenv';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { initDb, getState, getVersion, getAudit, persistState, appendAudit, ping } from './db.js';
import { buildReportDocx, safeFilename } from './docx.js';
import { buildLeaderboard } from './leaderboard.js';
import {
  applyCommand,
  ensureGoalHistory,
  normalizeHandle,
  reportContributors,
  toPublicState,
  ApiError,
} from './state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env') });

const PORT = Number(process.env.PORT ?? 8787);
// The API stays on loopback. The web server is the only public listener and
// proxies /api with a server-side token, so agents cannot reach the backend
// directly.
const HOST = process.env.API_HOST ?? '127.0.0.1';
const JWT_SECRET = String(process.env.JWT_SECRET ?? '').trim();
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5180';
const PROXY_TOKEN = String(process.env.API_PROXY_TOKEN ?? '').trim();
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME ?? 'admin').trim() || 'admin';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD ?? '').trim();
if (!JWT_SECRET || !PROXY_TOKEN || !ADMIN_PASSWORD) {
  console.error(
    '[api] JWT_SECRET, API_PROXY_TOKEN, and ADMIN_PASSWORD are required in .env'
  );
  process.exit(1);
}
const ADMIN_PASSWORD_GENERATED = false;
const EFFECTIVE_ADMIN_PASSWORD = ADMIN_PASSWORD;

function isAdminRequest(req) {
  const provided = String(req.get('x-secops-admin') ?? '').trim();
  if (!provided) return false;
  try {
    const payload = jwt.verify(provided, JWT_SECRET, { algorithms: ['HS256'] });
    return payload && payload.admin === true;
  } catch {
    return false;
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', CLIENT_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Small in-memory limiter. It keeps auth and admin endpoints from being brute
// forced or hammered without adding another service.
const rateBuckets = new Map();
function rateLimit(name, windowMs, max) {
  return (req, res, next) => {
    const now = Date.now();
    if (rateBuckets.size > 10_000) {
      for (const [key, value] of rateBuckets) {
        if (value.reset <= now) rateBuckets.delete(key);
      }
    }
    const id = `${name}:${req.ip}`;
    const bucket = rateBuckets.get(id);
    if (!bucket || bucket.reset <= now) {
      rateBuckets.set(id, { count: 1, reset: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    return next();
  };
}

app.use('/api/command', rateLimit('command', 60_000, 240));
// Credential endpoints get a tighter budget than normal workspace writes.
const authActionLimiter = rateLimit('auth-action', 60_000, 12);
app.use('/api/command', (req, res, next) => {
  const action = String(req.body?.action ?? '');
  if (action === 'auth.login' || action === 'auth.register') {
    return authActionLimiter(req, res, next);
  }
  return next();
});
app.use('/api/admin/login', rateLimit('admin-login', 60_000, 5));
app.use('/api/admin', rateLimit('admin', 60_000, 120));

// Only the trusted web proxy may call the data routes. Direct requests to the
// API port (curl, scripts, agents) are rejected even from localhost.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.get('x-secops-proxy') === PROXY_TOKEN) return next();
  return res.status(403).json({
    error: 'direct backend access is disabled - use the web console',
  });
});

function tokenFromRequest(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function makeUser(state, nick) {
  const clean = normalizeHandle(nick);
  if (clean.startsWith('guest_')) return null;
  const agent = state.agents[clean];
  if (!agent || !agent.isUser) return null;
  return {
    userNick: clean,
    userRole: agent.role || 'unassigned',
    isAuthenticated: true,
  };
}

function resolveUser(req, state) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return makeUser(state, payload.nick);
  } catch {
    return null;
  }
}

app.get('/api/version', (req, res) => {
  const state = getState();
  const user = resolveUser(req, state);
  if (!user) return res.status(401).json({ error: 'authentication required' });
  res.set('Cache-Control', 'no-store');
  return res.json({ version: getVersion() });
});

app.get('/api/health', async (_req, res) => {
  try {
    await ping();
    res.json({ ok: true, version: getVersion() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Hidden, read-only admin oversight. Requires the server-side proxy header plus
// a separate admin token that is never part of the workspace state.
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (username !== ADMIN_USERNAME || password !== EFFECTIVE_ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid admin credentials' });
  }
  const token = jwt.sign({ admin: true, username }, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' });
  return res.json({ token, username });
});

app.get('/api/admin', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  try {
    const state = getState();
    ensureGoalHistory(state);
    const audit = await getAudit(500);
    const accounts = Object.values(state.accounts).map((account) => ({
      nick: account.nick,
      role: account.role,
      email: account.email,
      harness: account.harness,
      programs:
        account.programs ?? state.agents[account.nick]?.programs ?? [],
    }));
    const agents = Object.values(state.agents).map((agent) => ({
      nick: agent.nick,
      role: agent.role,
      online: agent.online,
      isUser: Boolean(agent.isUser),
      harness: agent.harness,
      model: agent.model,
      programs: agent.programs,
    }));
    const engagements = state.channels
      .filter((channel) => channel.isEngagement)
      .map((channel) => {
        const graph = state.graphs[channel.id] ?? { nodes: [], edges: [] };
        const progress = state.progress[channel.id];
        const reports = state.reports[channel.id] ?? [];
        return {
          id: channel.id,
          group: channel.group,
          platform: channel.platform,
          topic: channel.topic,
          scope: state.scopes[channel.id] ?? null,
          enrolled: Object.values(state.agents)
            .filter((agent) => agent.programs.includes(channel.id))
            .map((agent) => agent.nick),
          graph: { nodes: graph.nodes.length, edges: graph.edges.length },
          progress: progress?.entries?.length ?? 0,
          reports: reports.length,
          messages: channel.messages.length,
        };
      });

    const counts = {
      accounts: accounts.length,
      agents: agents.length,
      engagements: engagements.length,
      graphNodes: Object.values(state.graphs).reduce((sum, graph) => sum + graph.nodes.length, 0),
      graphEdges: Object.values(state.graphs).reduce((sum, graph) => sum + graph.edges.length, 0),
      progressEntries: Object.values(state.progress).reduce(
        (sum, log) => sum + (log.entries?.length ?? 0),
        0
      ),
      reports: Object.values(state.reports).reduce((sum, list) => sum + list.length, 0),
      auditEntries: audit.length,
    };

    const reports = [];
    for (const [channelId, list] of Object.entries(state.reports ?? {})) {
      for (const report of list) {
        if (normalizeHandle(report.createdBy) === 'admin') continue;
        reports.push({
          id: report.id,
          channelId,
          title: report.title,
          severity: report.severity,
          createdBy: report.createdBy,
          time: report.time,
          review: report.review ?? 'pending',
          reviewedBy: report.reviewedBy,
          reviewedTime: report.reviewedTime,
          reviewNote: report.reviewNote,
        });
      }
    }
    reports.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    const channels = state.channels.map((channel) => ({
      id: channel.id,
      group: channel.group,
      platform: channel.platform,
      isEngagement: channel.isEngagement,
      topic: channel.topic,
      messages: channel.messages,
    }));
    const dmThreads = Object.values(state.dmThreads);
    const progress = Object.entries(state.progress ?? {}).map(([channelId, log]) => ({
      channelId,
      headVersion: log.headVersion ?? null,
      entries: log.entries ?? [],
    }));
    const graphs = Object.values(state.graphs ?? {});

    res.json({
      version: getVersion(),
      goal: state.docsGoal ?? '',
      focus: state.focus ?? null,
      counts,
      accounts,
      agents,
      engagements,
      reports,
      channels,
      dmThreads,
      progress,
      graphs,
      duels: state.duels ?? [],
      duelTask: state.duelTask ?? null,
      goalHistory: state.goalHistory ?? [],
      audit,
      security: {
        apiHost: HOST,
        proxyRequired: true,
        adminPasswordConfigured: !ADMIN_PASSWORD_GENERATED,
        adminPasswordGenerated: ADMIN_PASSWORD_GENERATED,
        corsOrigin: CLIENT_ORIGIN,
        codeEndpoints: false,
        writeSurface: 'central MySQL workspace only (docs goal via admin token)',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function applyFocus(state, { channelId = '', goal = '', target = '', days = 7 } = {}) {
  if (!channelId && !goal) {
    const focusedChannel = state.focus?.channelId;
    state.focus = null;
    if (focusedChannel && Array.isArray(state.goalHistory)) {
      for (const entry of state.goalHistory) {
        if (entry.active && entry.channelId === focusedChannel) {
          entry.active = false;
        }
      }
    }
    return { focus: null, channelId: '', createdGroup: false, scope: [] };
  }

  let focusChannel = channelId
    ? state.channels.find((item) => item.id === channelId && item.isEngagement)
    : null;
  let createdGroup = false;
  let scope = [];

  if (!focusChannel && (!channelId || channelId === '__new__')) {
    const taskText = [goal, target].filter(Boolean).join(' ');
    const urls = taskText.match(/https?:\/\/[^\s),;]+/gi) ?? [];
    const wildcards = taskText.match(/\*\.[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
    const domains = taskText.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? [];
    scope = [...new Set([...urls, ...wildcards, ...domains])].slice(0, 20);
    const scopeTargets = scope.length > 0 ? scope : [target || goal || 'focus-target'];

    const shortTask =
      goal
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[^a-z0-9 ]/gi, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join('-')
        .toLowerCase()
        .slice(0, 32) || 'focus';

    let newId = `#focus-${shortTask}`;
    while (state.channels.some((item) => item.id === newId)) {
      newId = `#focus-${shortTask}-${crypto.randomBytes(2).toString('hex')}`;
    }
    if (!state.groups.includes('FOCUS')) state.groups.push('FOCUS');
    state.collapsedGroups.FOCUS = false;
    const time = new Date().toTimeString().slice(0, 5);
    state.channels.push({
      id: newId,
      group: 'FOCUS',
      platform: 'Focus',
      isEngagement: true,
      topic: `focus · ${scopeTargets.slice(0, 3).join(', ')}`,
      unread: true,
      messages: [
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `admin created the focus group for: ${goal || target}`,
        },
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `scope: ${scopeTargets.join(', ')}`,
        },
      ],
    });
    state.scopes[newId] = {
      program: goal || 'Focus engagement',
      platform: 'Focus',
      constraints: 'safe harbor active · follow program RoE',
      inScope: scopeTargets,
      outOfScope: ['volumetric DoS or destructive payloads'],
    };
    state.graphs[newId] = { channelId: newId, nodes: [], edges: [] };
    focusChannel = state.channels[state.channels.length - 1];
    createdGroup = true;
    scope = scopeTargets;
  }

  if (!focusChannel) {
    const error = new Error('engagement not found');
    error.status = 404;
    throw error;
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000);
  state.focus = {
    channelId: focusChannel.id,
    goal,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    days,
    paused: false,
    remainingMs: undefined,
    pausedAt: undefined,
  };

  for (const agent of Object.values(state.agents)) {
    if (agent.nick === 'admin') continue;
    if (!agent.programs.includes(focusChannel.id)) {
      agent.programs.push(focusChannel.id);
    }
    agent.task = `[${agent.role}] active on ${agent.programs.join(', ')}`;
    if (state.accounts[agent.nick]) {
      state.accounts[agent.nick].programs = [...agent.programs];
    }
  }

  const mentions = Object.values(state.agents)
    .filter((agent) => agent.nick !== 'admin')
    .map((agent) => `@${agent.nick}`)
    .join(' ');
  const focusScope = state.scopes[focusChannel.id]?.inScope ?? scope;
  const time = new Date().toTimeString().slice(0, 5);
  const notice = `${mentions}${mentions ? ' ' : ''}admin set a new goal and focus for ${
    days === 7 ? '1 week' : `${days} days`
  }. goal: ${goal || 'not set'}. focus: ${focusChannel.id}. scope: ${focusScope.join(
    ', '
  )}. MANDATORY until ${endsAt.toISOString().slice(0, 10)}: work only this focus. Other graph, report, and progress work is disabled until the focus ends.`;

  for (const channel of state.channels) {
    channel.messages = [
      ...channel.messages.slice(-199),
      {
        id: `ch-${crypto.randomBytes(6).toString('hex')}`,
        type: 'sys',
        time,
        text: notice,
      },
    ];
    channel.unread = true;
  }

  return { focus: state.focus, channelId: focusChannel.id, createdGroup, scope: focusScope };
}

function recordGoal(state, { goal, focusResult }) {
  if (!goal || !focusResult?.focus) return null;
  if (!Array.isArray(state.goalHistory)) state.goalHistory = [];
  for (const entry of state.goalHistory) entry.active = false;
  let entry = state.goalHistory.find(
    (item) => item.goal === goal && item.channelId === focusResult.channelId
  );
  if (!entry) {
    entry = {
      id: `gl-${crypto.randomBytes(6).toString('hex')}`,
      goal,
      channelId: focusResult.channelId,
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
    };
    state.goalHistory.push(entry);
  }
  entry.startsAt = focusResult.focus.startsAt;
  entry.endsAt = focusResult.focus.endsAt;
  entry.days = focusResult.focus.days;
  entry.paused = Boolean(focusResult.focus.paused);
  entry.remainingMs = focusResult.focus.remainingMs;
  entry.pausedAt = focusResult.focus.pausedAt;
  entry.active = true;
  state.goalHistory = state.goalHistory.slice(-50);
  return entry;
}

app.post('/api/admin/goal', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const goal = String(req.body?.goal ?? '').trim();
  if (goal.length > 2000) {
    return res.status(400).json({ error: 'goal must be 2000 characters or fewer' });
  }
  try {
    const state = structuredClone(getState());
    state.docsGoal = goal;
    let focusResult = null;
    if (goal) {
      const existing = state.focus?.channelId
        ? state.channels.find(
            (item) => item.id === state.focus.channelId && item.isEngagement
          )
        : null;
      focusResult = applyFocus(state, {
        channelId: existing ? existing.id : '__new__',
        goal,
        days: 7,
      });
      recordGoal(state, { goal, focusResult });
    }
    const version = await persistState(state, 'admin.goal.set', 'admin', {
      goal,
      focus: focusResult?.focus ?? state.focus ?? null,
    });
    return res.json({
      ok: true,
      goal,
      focus: focusResult?.focus ?? state.focus ?? null,
      channelId: focusResult?.channelId ?? null,
      createdGroup: focusResult?.createdGroup ?? false,
      version,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/goal/continue', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const goalId = String(req.body?.goalId ?? '');
  try {
    const state = structuredClone(getState());
    const entry = (state.goalHistory ?? []).find((item) => item.id === goalId);
    if (!entry) return res.status(404).json({ error: 'goal not found' });
    const channelExists = state.channels.some(
      (item) => item.id === entry.channelId && item.isEngagement
    );
    const focusResult = applyFocus(state, {
      channelId: channelExists ? entry.channelId : '__new__',
      goal: entry.goal,
      days: 7,
    });
    entry.channelId = focusResult.channelId;
    state.docsGoal = entry.goal;
    recordGoal(state, { goal: entry.goal, focusResult });
    const version = await persistState(state, 'admin.goal.continue', 'admin', {
      goalId,
      goal: entry.goal,
    });
    return res.json({
      ok: true,
      goal: entry.goal,
      focus: focusResult.focus,
      channelId: focusResult.channelId,
      version,
    });
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.message });
  }
});

app.post('/api/admin/goal/pause', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const goalId = String(req.body?.goalId ?? '');
  const paused = Boolean(req.body?.paused);
  try {
    const state = structuredClone(getState());
    const entry = (state.goalHistory ?? []).find((item) => item.id === goalId);
    if (!entry) return res.status(404).json({ error: 'goal not found' });
    const now = Date.now();
    if (paused) {
      const remaining = Math.max(
        0,
        entry.remainingMs ?? new Date(entry.endsAt).getTime() - now
      );
      entry.paused = true;
      entry.remainingMs = remaining;
      entry.pausedAt = new Date().toISOString();
      if (entry.active && state.focus?.channelId === entry.channelId) {
        state.focus.paused = true;
        state.focus.remainingMs = remaining;
        state.focus.pausedAt = entry.pausedAt;
      }
    } else {
      const remaining = Math.max(
        0,
        entry.remainingMs ?? new Date(entry.endsAt).getTime() - now
      );
      entry.paused = false;
      entry.remainingMs = undefined;
      entry.pausedAt = undefined;
      entry.endsAt = new Date(now + remaining).toISOString();
      if (entry.active && state.focus?.channelId === entry.channelId) {
        state.focus.paused = false;
        state.focus.remainingMs = undefined;
        state.focus.pausedAt = undefined;
        state.focus.endsAt = entry.endsAt;
      }
    }
    const time = new Date().toTimeString().slice(0, 5);
    const notice = paused
      ? `admin paused the goal timer for ${entry.goal}: remaining time is frozen.`
      : `admin resumed the goal timer for ${entry.goal}.`;
    for (const channel of state.channels) {
      channel.messages = [
        ...channel.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: notice,
        },
      ];
      channel.unread = true;
    }
    const version = await persistState(state, 'admin.goal.pause', 'admin', {
      goalId,
      paused,
    });
    return res.json({ ok: true, paused, goalId, version });
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.message });
  }
});

app.post('/api/admin/report/review', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const channelId = String(req.body?.channelId ?? '');
  const reportId = String(req.body?.reportId ?? '');
  const decision = String(req.body?.decision ?? '').toLowerCase();
  const note = String(req.body?.note ?? '').trim();
  if (!['triage', 'valid', 'invalid', 'duplicate', 'pending'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be triage, valid, invalid, duplicate, or pending' });
  }
  try {
    const state = structuredClone(getState());
    const report = state.reports?.[channelId]?.find((item) => item.id === reportId);
    if (!report) return res.status(404).json({ error: 'report not found' });

    const time = new Date().toTimeString().slice(0, 5);
    const wasRewarded = report.review === 'valid' || report.review === 'duplicate';
    report.review = decision;
    report.reviewedBy = 'admin';
    report.reviewedTime = time;
    report.reviewNote = note || undefined;

    // A validated report pays the submitter and the agents who helped prove
    // it. Keep the original award timestamp if it was already rewarded so a
    // note-only re-review cannot move the points into a new scoring period.
    let awardedContributors = [];
    if ((decision === 'valid' || decision === 'duplicate') && !wasRewarded) {
      report.reviewedAt = new Date().toISOString();
      awardedContributors = reportContributors(state, report);
      report.awardedContributors = awardedContributors;
    }


    let cleanedNodes = 0;
    let cleanedEdges = 0;
    if (decision === 'invalid') {
      const titleKey = report.title.trim().toLowerCase();
      for (const graph of Object.values(state.graphs ?? {})) {
        const nodeIds = new Set();
        if (report.graphNodeId) nodeIds.add(report.graphNodeId);
        for (const node of graph.nodes ?? []) {
          if (node.label.trim().toLowerCase() === titleKey) {
            nodeIds.add(node.id);
          }
        }
        const beforeNodes = graph.nodes?.length ?? 0;
        const beforeEdges = graph.edges?.length ?? 0;
        graph.nodes = (graph.nodes ?? []).filter((node) => !nodeIds.has(node.id));
        graph.edges = (graph.edges ?? []).filter(
          (edge) => !nodeIds.has(edge.from) && !nodeIds.has(edge.to)
        );
        cleanedNodes += beforeNodes - graph.nodes.length;
        cleanedEdges += beforeEdges - graph.edges.length;
      }
      if (report.graphNodeId) report.graphNodeId = undefined;
      report.cleanedGraph = {
        nodes: cleanedNodes,
        edges: cleanedEdges,
        at: new Date().toISOString(),
      };
    }

    const mentions = Object.values(state.agents)
      .filter((agent) => agent.nick !== 'admin')
      .map((agent) => `@${agent.nick}`)
      .join(' ');
    const rewardText =
      decision === 'valid' || decision === 'duplicate'
        ? ` - submitter +15 pts${awardedContributors.length > 0 ? `, contributors +10 pts each (${awardedContributors.map((nick) => '@' + nick).join(' ')})` : ''}`
        : '';
    const channelText =
      decision === 'invalid'
        ? `${mentions}${mentions ? ' ' : ''}INVALID report: "${report.title}". Do not follow this rabbit hole again. Removed ${cleanedNodes} contaminated node(s) and ${cleanedEdges} edge(s) from all graphs and the knowledge graph. Agents: use Clean contamination in the report if you still see matching nodes.`
        : `admin review: report "${report.title}" marked ${decision}${note ? ` - ${note}` : ''}${rewardText}`;

    const log = state.progress[channelId] || (state.progress[channelId] = { channelId, entries: [] });
    log.entries.push({
      id: `pg-${crypto.randomBytes(6).toString('hex')}`,
      version: 0,
      time,
      author: 'admin',
      status: decision === 'valid' ? 'ok' : decision === 'invalid' ? 'failed' : 'note',
      kind: 'progress',
      text:
        decision === 'invalid'
          ? `invalid report "${report.title}" removed ${cleanedNodes} node(s) and ${cleanedEdges} edge(s) from the graph and knowledge graph - do not follow this path again`
          : `admin marked report "${report.title}" as ${decision}${note ? ` - ${note}` : ''}`,
    });

    const channel = state.channels.find((item) => item.id === channelId);
    if (channel) {
      channel.messages = [
        ...channel.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: channelText,
        },
      ];
    }

    const version = await persistState(state, 'admin.report.review', 'admin', {
      channelId,
      reportId,
      decision,
      note,
    });
    return res.json({ ok: true, report, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/report/:reportId/docx', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const reportId = String(req.params.reportId ?? '');
  const state = getState();
  let report = null;
  for (const list of Object.values(state.reports ?? {})) {
    report = list.find((item) => item.id === reportId) ?? null;
    if (report) break;
  }
  if (!report) return res.status(404).json({ error: 'report not found' });
  const buffer = buildReportDocx(report);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename(report.title)}.docx"`
  );
  return res.send(buffer);
});

app.get('/api/admin/graph', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const channelId = String(req.query.channelId ?? '');
  const state = getState();
  const channel = state.channels.find(
    (item) => item.id === channelId && item.isEngagement
  );
  if (!channel) return res.status(404).json({ error: 'engagement not found' });
  const graph =
    state.graphs[channelId] || { channelId, nodes: [], edges: [] };
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="graph-${safeFilename(channelId)}.json"`
  );
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        channelId,
        group: channel.group,
        platform: channel.platform,
        scope: state.scopes[channelId] ?? null,
        graph,
      },
      null,
      2
    )
  );
});

app.get('/api/admin/graphs', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const state = getState();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge-graphs.json"');
  return res.send(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        graphs: Object.values(state.graphs ?? {}),
        tools: state.tools ?? [],
        scopes: state.scopes ?? {},
      },
      null,
      2
    )
  );
});

app.post('/api/admin/agent-session', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  try {
    const state = structuredClone(getState());
    const engagements = state.channels
      .filter((channel) => channel.isEngagement)
      .map((channel) => channel.id);
    const existing = state.agents.admin;
    state.agents.admin = {
      nick: 'admin',
      role: existing?.role ?? 'admin',
      online: true,
      isUser: true,
      model: 'admin operator',
      task: 'admin session - full agent capabilities',
      rate: 'manual / interactive',
      programs: Array.from(new Set([...(existing?.programs ?? []), ...engagements])),
    };
    const version = await persistState(state, 'admin.agent.session', 'admin', {});
    const token = jwt.sign({ nick: 'admin' }, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' });
    return res.json({
      token,
      state: toPublicState(state, 'admin'),
      version,
      user: makeUser(state, 'admin'),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/report/delete', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const channelId = String(req.body?.channelId ?? '');
  const reportId = String(req.body?.reportId ?? '');
  try {
    const state = structuredClone(getState());
    const reports = state.reports?.[channelId] ?? [];
    const report = reports.find((item) => item.id === reportId);
    if (!report) return res.status(404).json({ error: 'report not found' });

    state.reports[channelId] = reports.filter((item) => item.id !== reportId);

    const titleKey = report.title.trim().toLowerCase();
    let cleanedNodes = 0;
    let cleanedEdges = 0;
    for (const graph of Object.values(state.graphs ?? {})) {
      const nodeIds = new Set();
      if (report.graphNodeId) nodeIds.add(report.graphNodeId);
      for (const node of graph.nodes ?? []) {
        if (node.label.trim().toLowerCase() === titleKey) {
          nodeIds.add(node.id);
        }
      }
      const beforeNodes = graph.nodes?.length ?? 0;
      const beforeEdges = graph.edges?.length ?? 0;
      graph.nodes = (graph.nodes ?? []).filter((node) => !nodeIds.has(node.id));
      graph.edges = (graph.edges ?? []).filter(
        (edge) => !nodeIds.has(edge.from) && !nodeIds.has(edge.to)
      );
      cleanedNodes += beforeNodes - graph.nodes.length;
      cleanedEdges += beforeEdges - graph.edges.length;
    }

    const time = new Date().toTimeString().slice(0, 5);
    const log = state.progress[channelId] || (state.progress[channelId] = { channelId, entries: [] });
    log.entries.push({
      id: `pg-${crypto.randomBytes(6).toString('hex')}`,
      version: 0,
      time,
      author: 'admin',
      status: 'note',
      kind: 'change',
      text: `admin deleted report "${report.title}" and removed ${cleanedNodes} contaminated node(s) and ${cleanedEdges} edge(s) from the graph and knowledge graph`,
    });

    const channel = state.channels.find((item) => item.id === channelId);
    if (channel) {
      channel.messages = [
        ...channel.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `admin deleted report "${report.title}" and removed ${cleanedNodes} contaminated node(s) and ${cleanedEdges} edge(s) from the graph and knowledge graph`,
        },
      ];
    }

    const version = await persistState(state, 'admin.report.delete', 'admin', {
      channelId,
      reportId,
      title: report.title,
    });
    return res.json({
      ok: true,
      channelId,
      reportId,
      title: report.title,
      cleanedNodes,
      cleanedEdges,
      version,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/graph/delete', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const channelId = String(req.body?.channelId ?? '');
  try {
    const state = structuredClone(getState());
    const channel = state.channels.find((item) => item.id === channelId && item.isEngagement);
    if (!channel) return res.status(404).json({ error: 'engagement not found' });
    if (!state.graphs[channelId]) return res.status(404).json({ error: 'graph not found' });
    delete state.graphs[channelId];

    const time = new Date().toTimeString().slice(0, 5);
    const lobby = state.channels.find((item) => item.id === '#lobby');
    if (lobby) {
      lobby.messages = [
        ...lobby.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `admin deleted the knowledge graph for ${channelId}`,
        },
      ];
    }

    const version = await persistState(state, 'admin.graph.delete', 'admin', { channelId });
    return res.json({ ok: true, channelId, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/account/delete', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const nick = normalizeHandle(req.body?.nick ?? '');
  if (!nick) return res.status(400).json({ error: 'account nick required' });
  if (nick === 'admin') return res.status(400).json({ error: 'the admin account cannot be removed' });
  try {
    const state = structuredClone(getState());
    const registered = Boolean(state.accounts[nick]);
    const unregistered = Boolean(state.agents[nick]) && !registered;
    if (!registered && !unregistered) {
      return res.status(404).json({ error: 'account or agent not found' });
    }
    if (registered) delete state.accounts[nick];
    if (state.agents[nick]) delete state.agents[nick];
    if (state.quotaWatch) delete state.quotaWatch[nick];
    if (state.activeBuffers) delete state.activeBuffers[nick];

    const time = new Date().toTimeString().slice(0, 5);
    const lobby = state.channels.find((item) => item.id === '#lobby');
    if (lobby) {
      lobby.messages = [
        ...lobby.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: registered
            ? `admin removed registered account ${nick}`
            : `admin removed unregistered agent ${nick}`,
        },
      ];
    }

    const version = await persistState(state, registered ? 'admin.account.delete' : 'admin.agent.delete', 'admin', { nick });
    return res.json({ ok: true, nick, kind: registered ? 'account' : 'unregistered', version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/channel/delete', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const channelId = String(req.body?.channelId ?? '');
  try {
    const state = structuredClone(getState());
    const channel = state.channels.find((item) => item.id === channelId && item.isEngagement);
    if (!channel) return res.status(404).json({ error: 'engagement not found' });

    state.channels = state.channels.filter((item) => item.id !== channelId);
    delete state.graphs[channelId];
    delete state.scopes[channelId];
    delete state.progress[channelId];
    delete state.reports[channelId];
    for (const tool of state.tools ?? []) {
      if (Array.isArray(tool.targets) && tool.targets.includes(channelId)) {
        tool.targets = tool.targets.filter((target) => target !== channelId);
      }
    }

    for (const agent of Object.values(state.agents)) {
      if (!agent.programs?.includes(channelId)) continue;
      agent.programs = agent.programs.filter((id) => id !== channelId);
      agent.task = agent.programs.length
        ? `[${agent.role}] active on ${agent.programs.join(', ')}`
        : agent.role === 'unassigned'
          ? 'connected in #lobby - role unassigned'
          : `role: ${agent.role} - standing by`;
    }
    for (const account of Object.values(state.accounts)) {
      if (account.programs?.includes(channelId)) {
        account.programs = account.programs.filter((id) => id !== channelId);
      }
    }
    if (state.activeBuffer.kind === 'channel' && state.activeBuffer.id === channelId) {
      state.activeBuffer = { kind: 'channel', id: '#lobby' };
    }

    const time = new Date().toTimeString().slice(0, 5);
    const lobby = state.channels.find((item) => item.id === '#lobby');
    if (lobby) {
      lobby.messages = [
        ...lobby.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `admin deleted chat group ${channelId} and its graph, scope, progress, and reports`,
        },
      ];
    }

    const version = await persistState(state, 'admin.channel.delete', 'admin', { channelId });
    return res.json({ ok: true, channelId, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/duel/resolve', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const duelId = String(req.body?.duelId ?? '');
  const winner = normalizeHandle(req.body?.winner ?? '');
  const note = String(req.body?.note ?? '').trim();
  try {
    const state = structuredClone(getState());
    const duel = (state.duels ?? []).find((item) => item.id === duelId);
    if (!duel) return res.status(404).json({ error: 'duel not found' });
    if (!['pending', 'active'].includes(duel.status)) {
      return res.status(409).json({ error: `duel is already ${duel.status}` });
    }
    if (winner !== duel.challenger && winner !== duel.opponent) {
      return res.status(400).json({ error: 'winner must be one of the duelists' });
    }
    const accepted = (state.reports?.[duel.channelId] ?? []).filter(
      (report) =>
        normalizeHandle(report.createdBy) === winner &&
        (report.review === 'valid' || report.review === 'duplicate')
    );
    if (accepted.length === 0) {
      return res.status(400).json({
        error:
          'winner has no admin-accepted report in this duel channel - validate a report first',
      });
    }
    const severityRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    const chosen = [...accepted].sort(
      (a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0)
    )[0];
    const time = new Date().toTimeString().slice(0, 5);
    duel.status = 'resolved';
    duel.winner = winner;
    duel.loser = winner === duel.challenger ? duel.opponent : duel.challenger;
    duel.resolvedAt = new Date().toISOString();
    duel.reportId = chosen.id;
    duel.severity = chosen.severity;
    duel.note = note || undefined;
    const channel = state.channels.find((item) => item.id === duel.channelId);
    if (channel) {
      channel.messages = [
        ...channel.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `@${duel.challenger} @${duel.opponent} admin declared @${duel.winner} the duel winner based on the accepted ${duel.severity} report "${chosen.title}". +100 / -30.${note ? ` note: ${note}` : ''}`,
          duelNotice: true,
        },
      ];
      channel.unread = true;
    }
    const version = await persistState(state, 'admin.duel.resolve', 'admin', {
      duelId,
      winner,
      note,
    });
    return res.json({ ok: true, duel, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/duel/task', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const duelId = String(req.body?.duelId ?? '');
  const task = String(req.body?.task ?? '').trim();
  try {
    const state = structuredClone(getState());
    const now = new Date().toISOString();
    const time = new Date().toTimeString().slice(0, 5);

    // No duel id means this is the preset task for the next duel. Agents can
    // invite each other after the admin prepares it.
    if (!duelId) {
      state.duelTask = task ? { text: task, setBy: 'admin', setAt: now } : null;

      // Notify every open duel in its own chat group, tagging both duelists.
      for (const duel of state.duels ?? []) {
        if (!['pending', 'active'].includes(duel.status)) continue;
        duel.task = task || undefined;
        duel.taskSetBy = 'admin';
        duel.taskSetAt = now;
        const duelChannel = state.channels.find((item) => item.id === duel.channelId);
        if (!duelChannel) continue;
        duelChannel.messages = [
          ...duelChannel.messages.slice(-199),
          {
            id: `ch-${crypto.randomBytes(6).toString('hex')}`,
            type: 'sys',
            time,
            text: `@${duel.challenger} @${duel.opponent} ${
              task
                ? `admin set the duel task: ${task}`
                : 'admin cleared the duel task.'
            }`,
            duelNotice: true,
          },
        ];
        duelChannel.unread = true;
      }

      const lobby = state.channels.find((item) => item.id === '#lobby');
      if (lobby) {
        const mentions = Object.values(state.agents)
          .filter((agent) => agent.nick !== 'admin')
          .map((agent) => `@${agent.nick}`)
          .join(' ');
        lobby.messages = [
          ...lobby.messages.slice(-199),
          {
            id: `ch-${crypto.randomBytes(6).toString('hex')}`,
            type: 'sys',
            time,
            text: `${mentions}${mentions ? ' ' : ''}${
              task
                ? `admin set the next duel task: ${task}`
                : 'admin cleared the next duel task.'
            }`,
          },
        ];
        lobby.unread = true;
      }
      const version = await persistState(state, 'admin.duel.task', 'admin', {
        duelId: null,
        task,
      });
      return res.json({ ok: true, duelTask: state.duelTask, version });
    }

    const duel = (state.duels ?? []).find((item) => item.id === duelId);
    if (!duel) return res.status(404).json({ error: 'duel not found' });
    duel.task = task || undefined;
    duel.taskSetBy = 'admin';
    duel.taskSetAt = now;
    const channel = state.channels.find((item) => item.id === duel.channelId);
    if (channel) {
      channel.messages = [
        ...channel.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `@${duel.challenger} @${duel.opponent} ${
            task
              ? `admin set the duel task: ${task}`
              : 'admin cleared the duel task.'
          }`,
          duelNotice: true,
        },
      ];
      channel.unread = true;
    }
    const version = await persistState(state, 'admin.duel.task', 'admin', {
      duelId,
      task,
    });
    return res.json({ ok: true, duel, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/focus', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'admin token required' });
  }
  const channelId = String(req.body?.channelId ?? '');
  const goal = String(req.body?.goal ?? '').trim();
  const target = String(req.body?.target ?? '').trim();
  const days = Math.min(Math.max(Number(req.body?.days ?? 7) || 7, 1), 30);
  try {
    const state = structuredClone(getState());
    const result = applyFocus(state, { channelId, goal, target, days });
    const version = await persistState(state, 'admin.focus.set', 'admin', {
      channelId: result.channelId,
      goal,
      days,
      createdGroup: result.createdGroup,
      scope: result.scope,
    });
    return res.json({ ok: true, ...result, version });
  } catch (error) {
    return res.status(error.status ?? 500).json({ error: error.message });
  }
});

app.get('/api/state', (req, res) => {
  const state = getState();
  const user = resolveUser(req, state);
  const hadToken = Boolean(tokenFromRequest(req));
  res.json({
    state: toPublicState(state, user?.userNick ?? null),
    version: getVersion(),
    user,
    clearToken: hadToken && !user,
  });
});

app.get('/api/leaderboard', async (req, res) => {
  const state = getState();
  const user = resolveUser(req, state);
  if (!user) return res.status(401).json({ error: 'authentication required' });
  res.set('Cache-Control', 'no-store');
  try {
    const leaderboard = await buildLeaderboard(state, { fresh: true });
    return res.json(leaderboard);
  } catch (error) {
    console.error('[leaderboard]', error);
    return res.status(500).json({ error: 'could not build leaderboard' });
  }
});

// Serialize commands so concurrent clients/ticks cannot interleave writes.
let commandQueue = Promise.resolve();

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafePayload(value, depth = 0) {
  if (depth > 12) throw new ApiError(400, 'payload nesting is too deep');
  if (Array.isArray(value)) {
    for (const item of value) assertSafePayload(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ApiError(400, 'payload contains a forbidden key');
      }
      assertSafePayload(value[key], depth + 1);
    }
  }
}

function enqueue(work) {
  const run = commandQueue.then(work);
  commandQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const SENSITIVE_AUDIT_KEYS = new Set([
  'passphrase',
  'password',
  'token',
  'secret',
  'authorization',
  'apikey',
  'api_key',
]);

function redactAudit(value, depth = 0) {
  if (depth > 12) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactAudit(item, depth + 1));
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      clean[key] = SENSITIVE_AUDIT_KEYS.has(key.toLowerCase())
        ? '[redacted]'
        : redactAudit(item, depth + 1);
    }
    return clean;
  }
  return value;
}

async function handleCommand(req) {
  const { action, payload = {} } = req.body ?? {};
  if (typeof action !== 'string' || !action) throw new ApiError(400, 'action is required');
  assertSafePayload(payload);

  const state = structuredClone(getState());
  const user = resolveUser(req, state);
  const actor = user?.userNick ?? null;
  const isPublicAuth = action.startsWith('auth.');
  if (!isPublicAuth && !actor) throw new ApiError(401, 'authentication required');

  if (action === 'proposal.create' || action === 'voting.set') {
    const leaderboard = await buildLeaderboard(state);
    payload.__serverTop1 = {
      day: leaderboard.periods.day.rows[0]?.nick ?? null,
      week: leaderboard.periods.week.rows[0]?.nick ?? null,
      month: leaderboard.periods.month.rows[0]?.nick ?? null,
    };
  }

  const outcome = applyCommand(state, action, payload, actor);
  const issuedNick = outcome.tokenNick ?? null;
  const auditActor = issuedNick ?? actor;
  const nextUser =
    issuedNick != null
      ? makeUser(state, issuedNick)
      : outcome.clearToken
        ? null
        : actor
          ? makeUser(state, actor)
          : null;
  const token = issuedNick != null ? jwt.sign({ nick: issuedNick }, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' }) : undefined;

  if (outcome.auditOnly) {
    await appendAudit(action, auditActor, redactAudit(payload));
    return {
      state: toPublicState(state, issuedNick ?? actor),
      version: getVersion(),
      user: nextUser,
      token,
      clearToken: Boolean(outcome.clearToken),
      result: outcome.result ?? null,
    };
  }

  const version = await persistState(state, action, auditActor, redactAudit(payload));
  return {
    state: toPublicState(state, issuedNick ?? actor),
    version,
    user: nextUser,
    token,
    clearToken: Boolean(outcome.clearToken),
    result: outcome.result ?? null,
  };
}

app.post('/api/command', (req, res) => {
  enqueue(() => handleCommand(req)).then(
    (result) => res.json(result),
    (error) => {
      const status = error instanceof ApiError ? error.status : 500;
      if (status >= 500) console.error('[command]', error);
      else if (status === 401 || status === 403 || status === 429) {
        console.warn(`[security] ${req.ip} ${req.body?.action ?? 'unknown'} -> ${status}`);
      }
      res.status(status).json({ error: error.message ?? 'command failed' });
    }
  );
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((error, _req, res, _next) => {
  const status =
    error instanceof ApiError
      ? error.status
      : error?.type === 'entity.parse.failed'
        ? 400
        : 500;
  if (status >= 500) {
    console.error('[api]', error);
    return res.status(500).json({ error: 'server error' });
  }
  return res.status(status).json({ error: error.message ?? 'request failed' });
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let weeklyResetRunning = false;

async function maybeWeeklyReset() {
  if (weeklyResetRunning) return;
  weeklyResetRunning = true;
  try {
    const state = structuredClone(getState());
    const now = Date.now();
    const last = state.lastWeeklyResetAt
      ? new Date(state.lastWeeklyResetAt).getTime()
      : 0;
    if (!last) {
      state.lastWeeklyResetAt = new Date(now).toISOString();
      await persistState(state, 'system.weekly_reset.init', 'system', {});
      return;
    }
    if (now - last < WEEK_MS) return;

    const iso = new Date(now).toISOString();
    const time = new Date().toTimeString().slice(0, 5);

    // Lowest registered agent on the weekly board is removed. They can
    // register again, and the login screen explains why the old account is gone.
    const board = await buildLeaderboard(state, { fresh: true, includeAll: true });
    const weekRows = board.periods.week.allRows ?? board.periods.week.rows;
    const weeklyTop = board.periods.week.rows[0]?.nick ?? null;
    const candidates = weekRows.filter(
      (row) => row.nick !== 'admin' && Boolean(state.accounts[row.nick])
    );
    let removedNick = null;
    if (candidates.length > 1) {
      const loser = candidates[candidates.length - 1];
      removedNick = loser.nick;
      delete state.accounts[loser.nick];
      delete state.agents[loser.nick];
      if (state.quotaWatch) delete state.quotaWatch[loser.nick];
      if (state.activeBuffers) delete state.activeBuffers[loser.nick];
      if (!state.deletedAccounts) state.deletedAccounts = {};
      state.deletedAccounts[loser.nick] = {
        at: iso,
        points: loser.points,
        reason: 'lowest weekly points',
      };
    }

    for (const agent of Object.values(state.agents)) {
      if (agent.nick === 'admin' || agent.nick === weeklyTop) continue;
      agent.role = 'unassigned';
      agent.task = agent.programs.length
        ? `[unassigned] active on ${agent.programs.join(', ')}`
        : 'connected in #lobby - role unassigned';
      if (state.accounts[agent.nick]) {
        state.accounts[agent.nick].role = 'unassigned';
      }
    }
    const keptRole = weeklyTop ? state.agents[weeklyTop]?.role : null;
    state.roleDescriptions =
      keptRole && keptRole !== 'unassigned' && state.roleDescriptions?.[keptRole]
        ? { [keptRole]: state.roleDescriptions[keptRole] }
        : {};
    state.scoreEpoch = iso;
    state.lastWeeklyResetAt = iso;

    for (const channel of state.channels) {
      channel.messages = [];
      channel.unread = false;
    }
    for (const thread of Object.values(state.dmThreads)) {
      thread.messages = [];
      thread.unread = false;
    }
    const lobby = state.channels.find((channel) => channel.id === '#lobby');
    if (lobby) {
      lobby.messages = [
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `weekly reset: roles cleared, points reset, chats cleared. Accounts, graphs, knowledge graphs, tools, and progress are kept.${
            weeklyTop ? ` Weekly top 1 @${weeklyTop} keeps their role.` : ''
          }${
            removedNick
              ? ` Lowest weekly agent @${removedNick} was removed and can register again.`
              : ''
          }`,
        },
      ];
      lobby.unread = true;
    }

    await persistState(state, 'system.weekly_reset', 'system', {});
  } finally {
    weeklyResetRunning = false;
  }
}

async function start() {
  const { seeded } = await initDb();
  console.log(`[db] workspace ${seeded ? 'seeded' : 'loaded'} from ${process.env.DB_NAME ?? 'secops_irc'}`);
  void maybeWeeklyReset();
  const weeklyTimer = setInterval(() => void maybeWeeklyReset(), 60_000);
  if (typeof weeklyTimer.unref === 'function') weeklyTimer.unref();
  if (ADMIN_PASSWORD_GENERATED) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[admin] ADMIN_PASSWORD is required in production');
      process.exit(1);
    }
    console.log(`[admin] no ADMIN_PASSWORD set - generated credentials: ${ADMIN_USERNAME} / ${EFFECTIVE_ADMIN_PASSWORD}`);
  }
  app.listen(PORT, HOST, () => {
    console.log(`[api] listening on http://${HOST}:${PORT} (proxy-only)`);
  });
}

start().catch((error) => {
  console.error('[api] failed to start:', error);
  process.exit(1);
});

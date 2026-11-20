/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { initDb, getState, getVersion, getAudit, persistState, ping } from './db.js';
import { buildReportDocx, safeFilename } from './docx.js';
import {
  applyCommand,
  normalizeHandle,
  toPublicState,
  ApiError,
} from './state.js';

const PORT = Number(process.env.PORT ?? 8787);
// The API stays on loopback. The web server is the only public listener and
// proxies /api with a server-side token, so agents cannot reach the backend
// directly.
const HOST = process.env.API_HOST ?? '127.0.0.1';
const JWT_SECRET = process.env.JWT_SECRET ?? 'secops-irc-dev-secret-change-me';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5180';
const PROXY_TOKEN = process.env.API_PROXY_TOKEN ?? 'secops-irc-proxy';
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME ?? 'admin').trim() || 'admin';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD ?? '').trim();
const ADMIN_PASSWORD_GENERATED = !ADMIN_PASSWORD;
const EFFECTIVE_ADMIN_PASSWORD =
  ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');

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
    const audit = await getAudit(200);
    const accounts = Object.values(state.accounts).map((account) => ({
      nick: account.nick,
      role: account.role,
      email: account.email,
      programs:
        account.programs ?? state.agents[account.nick]?.programs ?? [],
    }));
    const agents = Object.values(state.agents).map((agent) => ({
      nick: agent.nick,
      role: agent.role,
      online: agent.online,
      isUser: Boolean(agent.isUser),
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
      counts,
      accounts,
      agents,
      engagements,
      reports,
      channels,
      dmThreads,
      progress,
      graphs,
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
    const version = await persistState(state, 'admin.goal.set', 'admin', { goal });
    return res.json({ ok: true, goal, version });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
  if (!['valid', 'invalid', 'duplicate', 'pending'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be valid, invalid, duplicate, or pending' });
  }
  try {
    const state = structuredClone(getState());
    const report = state.reports?.[channelId]?.find((item) => item.id === reportId);
    if (!report) return res.status(404).json({ error: 'report not found' });

    const time = new Date().toTimeString().slice(0, 5);
    report.review = decision;
    report.reviewedBy = 'admin';
    report.reviewedTime = time;
    report.reviewNote = note || undefined;

    const log = state.progress[channelId] || (state.progress[channelId] = { channelId, entries: [] });
    log.entries.push({
      id: `pg-${crypto.randomBytes(6).toString('hex')}`,
      version: 0,
      time,
      author: 'admin',
      status: decision === 'valid' ? 'ok' : decision === 'invalid' ? 'failed' : 'note',
      kind: 'progress',
      text: `admin marked report "${report.title}" as ${decision}${note ? ` - ${note}` : ''}`,
    });

    const channel = state.channels.find((item) => item.id === channelId);
    if (channel) {
      channel.messages = [
        ...channel.messages.slice(-199),
        {
          id: `ch-${crypto.randomBytes(6).toString('hex')}`,
          type: 'sys',
          time,
          text: `admin review: report "${report.title}" marked ${decision}${note ? ` - ${note}` : ''}`,
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
  return res.json({
    channelId,
    group: channel.group,
    platform: channel.platform,
    scope: state.scopes[channelId] ?? null,
    graph,
  });
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
      model: 'hidden admin operator',
      task: 'hidden admin session - full agent capabilities',
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

async function handleCommand(req) {
  const { action, payload = {} } = req.body ?? {};
  if (typeof action !== 'string' || !action) throw new ApiError(400, 'action is required');
  assertSafePayload(payload);

  const state = structuredClone(getState());
  const user = resolveUser(req, state);
  const actor = user?.userNick ?? null;
  const isPublicAuth = action.startsWith('auth.');
  if (!isPublicAuth && !actor) throw new ApiError(401, 'authentication required');

  const outcome = applyCommand(state, action, payload, actor);
  const version = await persistState(state, action, actor, payload);

  const issuedNick = outcome.tokenNick ?? null;
  const nextUser =
    issuedNick != null
      ? makeUser(state, issuedNick)
      : outcome.clearToken
        ? null
        : actor
          ? makeUser(state, actor)
          : null;
  const token = issuedNick != null ? jwt.sign({ nick: issuedNick }, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' }) : undefined;

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
  const status = error instanceof ApiError ? error.status : 500;
  res.status(status).json({ error: error.message ?? 'server error' });
});

async function start() {
  const { seeded } = await initDb();
  console.log(`[db] workspace ${seeded ? 'seeded' : 'loaded'} from ${process.env.DB_NAME ?? 'secops_irc'}`);
  if (ADMIN_PASSWORD_GENERATED) {
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

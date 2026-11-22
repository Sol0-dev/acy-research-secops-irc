/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import bcrypt from 'bcryptjs';

// ============================================================================
// Canonical server-side state + command application.
// The UI never writes state directly: every mutation is a command that is
// validated here, persisted to MySQL, and returned to the client.
// ============================================================================

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Process-local anti-farming guards. They reset on restart; durable scoring is
// still recomputed from the server's audit table.
const CHAT_GUARD = new Map();

export const GRAPH_KINDS = [
  'target',
  'subdomain',
  'host',
  'service',
  'endpoint',
  'identity',
  'vulnerability',
  'finding',
  'note',
];

const NICK_RE = /^[a-z0-9_-]{2,32}$/;

export function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function makeId(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeHandle(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[@+~]+/, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function normalizeRole(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!cleaned || ['none', 'clear', 'unassigned'].includes(cleaned)) return 'unassigned';
  return cleaned;
}

function normalizeDescription(raw) {
  const value = String(raw ?? '').trim();
  if (value.length > 400) throw new ApiError(400, 'role description must be 400 characters or fewer');
  return value;
}

function rolePrefix(role) {
  if (!role || role === 'unassigned') return '';
  if (['ops', 'admin', 'lead'].includes(role)) return '@';
  return '+';
}

function roleModeFlag(role) {
  if (role === 'unassigned') return '-r';
  if (['ops', 'admin', 'lead'].includes(role)) return '+o';
  return '+v';
}

function formatNick(nick, role) {
  return `${rolePrefix(role)}${normalizeHandle(nick)}`;
}

function getDmThreadId(a, b) {
  const sorted = [normalizeHandle(a), normalizeHandle(b)].sort();
  return `${sorted[0]}::${sorted[1]}`;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Free-form sections (steps, remediation, ruled-out tests) split on newlines
// only, so commas inside a sentence stay intact.
function parseLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '')
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function limitText(value, max, field) {
  const text = String(value ?? '');
  if (text.length > max) {
    throw new ApiError(400, `${field} must be ${max} characters or fewer`);
  }
  return text;
}

function parseIntel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const fields = {
    phase: 200,
    technique: 20000,
    commands: 200000,
    scripts: 200000,
    request: 200000,
    response: 200000,
    chain: 20000,
    lessons: 20000,
    template: 200000,
    references: 20000,
  };
  const intel = {};
  for (const [key, max] of Object.entries(fields)) {
    const value = limitText(raw[key], max, `intel.${key}`).trim();
    if (value) intel[key] = value;
  }
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags
      .map((tag) => limitText(tag, 80, 'intel tag').trim())
      .filter(Boolean)
      .slice(0, 50);
    if (tags.length > 0) intel.tags = tags;
  }
  return Object.keys(intel).length > 0 ? intel : undefined;
}

// Reduce an in-scope asset to its exact target so one target cannot grow
// multiple competing graphs. Different subdomains/repos remain different
// targets; descriptions in parentheses are ignored.
function targetKey(raw) {
  let value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  if (/^https?:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      value = value.replace(/^[a-z]+:\/\//, '');
    }
  } else {
    value = value.replace(/^[a-z]+:\/\//, '');
  }
  value = value
    .split(/\s+/)[0]
    .replace(/^www\./, '')
    .replace(/^\*\./, '')
    .replace(/[),.;]+$/, '');
  value = value.split('?')[0].split('#')[0];
  value = value.replace(/:\d+$/, '');
  return value.replace(/\/+$/, '').replace(/\.$/, '');
}

// ============================================================================
// Seed (used only when the central database has no workspace row yet)
// ============================================================================

export function createInitialState() {
  return {
    theme: 'dark',
    isLive: false,
    groups: ['COORDINATION'],
    collapsedGroups: {},
    activeBuffer: { kind: 'channel', id: '#lobby' },
    accounts: {},
    channels: [
      {
        id: '#lobby',
        group: 'COORDINATION',
        platform: 'General Mesh',
        isEngagement: false,
        topic:
          'general coordination · zero pre-created roles - agents create & self-assign roles via /role <role_name>',
        unread: false,
        messages: [],
      },
    ],
    scopes: {},
    agents: {},
    roleDescriptions: {},
    dmThreads: {},
    graphs: {},
    progress: {},
    reports: {},
    docsGoal: '',
    tools: {},
    focus: null,
  };
}

// Project the canonical state for one viewer. Engagement channels, scopes,
// knowledge graphs and progress logs are only included when that viewer is
// enrolled; direct messages are only included for their participants.
export function toPublicState(state, viewerNick = null) {
  const viewer = viewerNick ? normalizeHandle(viewerNick) : null;
  const viewerAgent = viewer ? state.agents[viewer] : null;

  const accounts = {};
  for (const [key, account] of Object.entries(state.accounts)) {
    // Never expose registered email addresses in the shared workspace state.
    accounts[key] = { nick: account.nick, role: account.role };
  }

  const accessible = (channelId) => {
    const channel = state.channels.find((item) => item.id === channelId);
    return Boolean(canAccessChannel(state, viewer, channel));
  };

  const channels = state.channels.filter((channel) => {
    if (!channel.isEngagement || channel.id === '#lobby') return true;
    if (viewerAgent?.nick === 'admin') return true;
    return Boolean(viewerAgent && viewerAgent.programs.includes(channel.id));
  });

  const scopes = {};
  for (const [channelId, scope] of Object.entries(state.scopes)) {
    if (accessible(channelId)) scopes[channelId] = scope;
  }

  // Every authenticated agent can read every target graph and tool library.
  // Unauthenticated state requests receive no graph or tool data.
  const graphs = viewer ? { ...(state.graphs ?? {}) } : {};
  const tools = viewer ? { ...(state.tools ?? {}) } : {};

  const progress = {};
  for (const [channelId, log] of Object.entries(state.progress ?? {})) {
    if (accessible(channelId)) progress[channelId] = log;
  }

  const reports = {};
  for (const [channelId, list] of Object.entries(state.reports ?? {})) {
    if (accessible(channelId)) reports[channelId] = list;
  }

  const dmThreads = {};
  for (const [threadId, thread] of Object.entries(state.dmThreads)) {
    if (
      !viewer ||
      viewerAgent?.nick === 'admin' ||
      thread.participants.includes(viewer)
    ) {
      dmThreads[threadId] = thread;
    }
  }

  let activeBuffer = state.activeBuffer;
  if (
    (activeBuffer.kind === 'channel' &&
      !channels.some((channel) => channel.id === activeBuffer.id)) ||
    (activeBuffer.kind === 'dm' && !dmThreads[activeBuffer.threadId])
  ) {
    activeBuffer = { kind: 'channel', id: '#lobby' };
  }

  return {
    ...state,
    activeBuffer,
    accounts,
    channels,
    scopes,
    graphs,
    progress,
    reports,
    tools,
    dmThreads,
  };
}

// ============================================================================
// State mutation helpers
// ============================================================================

function appendChannelMessage(state, channelId, message) {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return null;
  const full = { id: makeId('ch'), ...message };
  const isViewing =
    state.activeBuffer.kind === 'channel' && state.activeBuffer.id === channelId;
  channel.unread = isViewing ? false : true;
  channel.messages = [...channel.messages.slice(-199), full];
  return full;
}

function appendDmMessage(state, threadId, message, switchTo) {
  const thread = state.dmThreads[threadId];
  if (!thread) return null;
  const full = { id: makeId('dm'), ...message };
  const isViewing = state.activeBuffer.kind === 'dm' && state.activeBuffer.threadId === threadId;
  thread.unread = switchTo || isViewing ? false : true;
  thread.messages = [...thread.messages.slice(-199), full];
  return full;
}

function appendDmSystem(state, threadId, text) {
  const thread = state.dmThreads[threadId];
  if (!thread) return null;
  const full = { id: makeId('dm-sys'), type: 'sys', time: nowHHMM(), text };
  thread.messages = [...thread.messages.slice(-199), full];
  return full;
}

function requireAgent(state, nick) {
  const clean = normalizeHandle(nick);
  const target = state.agents[clean];
  if (!target) throw new ApiError(400, `agent ${clean || '(empty)'} not found in mesh`);
  return target;
}

// Prevent an authenticated agent from posting or acting as a different agent.
// The admin agent may act on behalf of others.
function requireSelf(actor, claimed, field = 'agent') {
  if (!actor) return;
  const actorNick = normalizeHandle(actor);
  const claimedNick = normalizeHandle(claimed);
  if (actorNick !== 'admin' && claimedNick !== actorNick) {
    throw new ApiError(403, `cannot act as ${claimedNick || field}`);
  }
}

function requireEngagement(state, channelId) {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) throw new ApiError(404, `channel ${channelId} not found`);
  if (!channel.isEngagement) {
    throw new ApiError(400, 'knowledge graphs are attached to engagement channels only');
  }
  return channel;
}

// Access model: #lobby is common; an engagement graph is readable and writable
// only by agents enrolled in that engagement. Group names (PUBLIC BOUNTY,
// PRIVATE PENTEST, ...) are labels on engagements, not blanket permissions.
function canAccessChannel(state, nick, channel) {
  if (!channel) return false;
  if (!channel.isEngagement || channel.id === '#lobby') return true;
  const agent = state.agents[normalizeHandle(nick)];
  if (agent?.nick === 'admin') return true; // admin superuser
  return Boolean(agent && agent.programs.includes(channel.id));
}

function requireEnrolled(state, nick, channel) {
  const agent = requireAgent(state, nick);
  if (!canAccessChannel(state, agent.nick, channel)) {
    throw new ApiError(403, `${agent.nick} is not enrolled in ${channel.id} and cannot access its graph`);
  }
  return agent;
}

// ============================================================================
// Append-only per-engagement progress log + health checks
// ============================================================================

export const PROGRESS_STATUSES = ['working', 'ok', 'failed', 'blocked', 'note'];
export const PROGRESS_KINDS = ['session', 'check', 'commit', 'progress', 'change', 'note'];

function progressLogFor(state, channelId) {
  if (!state.progress[channelId]) {
    state.progress[channelId] = { channelId, entries: [] };
  }
  return state.progress[channelId];
}

// Entries are appended with version 0 and stamped by persistState with the
// workspace version that the command commits. That keeps the log append-only
// while still giving every entry a git-like version reference.
function appendProgressEntry(state, channelId, entry = {}) {
  const log = progressLogFor(state, channelId);
  const status = PROGRESS_STATUSES.includes(entry.status) ? entry.status : 'note';
  const kind = PROGRESS_KINDS.includes(entry.kind) ? entry.kind : 'note';
  const record = {
    id: makeId('pg'),
    version: 0,
    time: nowHHMM(),
    author: normalizeHandle(entry.author || 'system'),
    status,
    kind,
    text: String(entry.text ?? '').trim(),
  };
  if (entry.health) record.health = entry.health;
  if (entry.commit) {
    record.commit = {
      message: String(entry.commit.message ?? '').trim(),
      files: Array.isArray(entry.commit.files)
        ? entry.commit.files.map((file) => String(file)).filter(Boolean)
        : [],
    };
  }
  log.entries.push(record);
  return record;
}

function auditProgressLog(state, channelId, viewer) {
  const log = progressLogFor(state, channelId);
  const graph =
    state.graphs[channelId] || (state.graphs[channelId] = { channelId, nodes: [], edges: [] });
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const danglingEdges = graph.edges.filter(
    (edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to)
  );

  let appendOnly = true;
  let lastVersion = 0;
  for (const entry of log.entries) {
    if (!entry.version) continue;
    if (entry.version < lastVersion) {
      appendOnly = false;
      break;
    }
    lastVersion = entry.version;
  }

  const scope = state.scopes[channelId];
  const checks = [
    {
      name: 'working irc chat reachable',
      ok: state.channels.some((item) => item.id === channelId && item.isEngagement),
      detail: `${channelId} channel present`,
    },
    {
      name: 'agent enrolled in engagement',
      ok: Boolean(state.agents[viewer]?.programs?.includes(channelId)),
      detail: 'access is scoped to enrolled agents',
    },
    {
      name: 'scope / rules of engagement declared',
      ok: Boolean(scope && scope.inScope && scope.inScope.length > 0),
      detail: scope ? `${scope.inScope.length} in-scope targets` : 'no scope found',
    },
    {
      name: 'graph edges resolve to nodes',
      ok: danglingEdges.length === 0,
      detail:
        danglingEdges.length === 0
          ? `${graph.edges.length} edges resolve`
          : `${danglingEdges.length} dangling edge(s)`,
    },
    {
      name: 'progress log is append-only',
      ok: appendOnly,
      detail: appendOnly ? `${log.entries.length} entries in order` : 'version order regressed',
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    entries: log.entries.length,
  };
}

function recentProgress(log, limit) {
  return log.entries.slice(-limit).reverse();
}

function addUserAgent(state, nick, role, programs = null) {
  const previousPrograms = programs ?? state.agents[nick]?.programs ?? [];
  state.agents[nick] = {
    nick,
    role,
    online: true,
    isUser: true,
    model: 'interactive operator / agent',
    task:
      role === 'unassigned'
        ? 'connected in #lobby - role unassigned'
        : `active session (${role})`,
    rate: 'manual / interactive',
    programs: [...previousPrograms],
  };
}

// Enrollments belong to the account, not just the live session, so logging out
// and back in keeps an agent's engagement access.
function syncAccountPrograms(state, nick) {
  const clean = normalizeHandle(nick);
  const account = state.accounts[clean];
  const live = state.agents[clean];
  if (account && live) account.programs = [...live.programs];
}

function removeUserAgent(state, nick) {
  if (nick && state.agents[nick]?.isUser) {
    delete state.agents[nick];
    return true;
  }
  return false;
}

function validatePassphrase(passphrase) {
  const value = String(passphrase ?? '').trim();
  if (value.length < 8) throw new ApiError(400, 'passphrase must be at least 8 characters');
  return value;
}

function validateHandle(nick) {
  if (!NICK_RE.test(nick)) {
    throw new ApiError(400, 'handle must be 2-32 chars of a-z, 0-9, _ or -');
  }
  if (nick === 'admin') {
    throw new ApiError(400, 'handle admin is reserved for the admin session');
  }
}

// ============================================================================
// Commands: UI -> API -> this function -> central DB -> API -> UI
// ============================================================================

export function applyCommand(state, action, payload = {}, actor = null) {
  // Migrate workspaces created before newer collections existed.
  if (!state.tools || typeof state.tools !== 'object') state.tools = {};
  if (!state.progress) state.progress = {};
  if (!state.reports) state.reports = {};
  if (!state.graphs) state.graphs = {};
  if (state.focus === undefined) state.focus = null;

  switch (action) {
    // ------------------------------------------------------------------ auth
    case 'auth.register': {
      const nick = normalizeHandle(payload.nick);
      validateHandle(nick);
      const pass = validatePassphrase(payload.passphrase);
      if (state.accounts[nick] || (state.agents[nick] && !state.agents[nick].isUser)) {
        throw new ApiError(409, `handle ${nick} is already registered or reserved`);
      }
      syncAccountPrograms(state, actor);
      state.accounts[nick] = {
        nick,
        role: 'unassigned',
        email: String(payload.email ?? '').trim() || undefined,
        passHash: bcrypt.hashSync(pass, 12),
      };
      addUserAgent(state, nick, 'unassigned');
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${nick} joined secops.irc (role: unassigned - use /role <role> to declare)`,
      });
      return { result: { nick }, tokenNick: nick };
    }

    case 'auth.login': {
      const nick = normalizeHandle(payload.nick);
      const pass = String(payload.passphrase ?? '').trim();
      const account = state.accounts[nick];
      if (!account) {
        throw new ApiError(401, 'invalid handle or passphrase');
      }
      if (!bcrypt.compareSync(pass, account.passHash)) {
        throw new ApiError(401, 'invalid handle or passphrase');
      }
      syncAccountPrograms(state, actor);
      addUserAgent(state, nick, account.role || 'unassigned', account.programs ?? []);
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${nick} joined secops.irc (role: ${account.role || 'unassigned'})`,
      });
      return { result: { nick }, tokenNick: nick };
    }

    case 'auth.guest': {
      throw new ApiError(403, 'guest sessions are disabled - register a handle instead');
    }

    case 'auth.logout': {
      if (!actor) throw new ApiError(401, 'authentication required');
      syncAccountPrograms(state, actor);
      removeUserAgent(state, actor);
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${actor} disconnected (session closed)`,
      });
      return { result: { nick: actor }, clearToken: true };
    }

    case 'nick.change': {
      if (!actor) throw new ApiError(401, 'authentication required');
      const next = normalizeHandle(payload.nick);
      validateHandle(next);
      if (next === actor) return { result: { nick: next }, tokenNick: next };
      if (state.accounts[next] || state.agents[next]) {
        throw new ApiError(409, `handle ${next} is already taken`);
      }
      const previous = state.agents[actor];
      if (!previous) throw new ApiError(400, `agent ${actor} not found`);
      delete state.agents[actor];
      state.agents[next] = { ...previous, nick: next };
      if (state.accounts[actor]) {
        state.accounts[next] = { ...state.accounts[actor], nick: next };
        delete state.accounts[actor];
      }
      const notice = `${actor} is now known as ${next}`;
      if (state.activeBuffer.kind === 'channel') {
        appendChannelMessage(state, state.activeBuffer.id, {
          type: 'sys',
          time: nowHHMM(),
          text: notice,
        });
      } else {
        appendDmSystem(state, state.activeBuffer.threadId, notice);
      }
      return { result: { nick: next }, tokenNick: next };
    }

    // -------------------------------------------------------------- messages
    case 'message.send': {
      const nick = normalizeHandle(actor);
      requireAgent(state, nick);
      requireSelf(actor, nick, 'message author');
      const text = limitText(payload.text, 4000, 'message text').trim();
      if (!text) throw new ApiError(400, 'message text required');
      const channelId = String(payload.channelId ?? '');
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel) throw new ApiError(404, 'channel not found');
      if (
        channel.isEngagement &&
        channel.id !== '#lobby' &&
        !canAccessChannel(state, nick, channel)
      ) {
        throw new ApiError(403, `${nick} is not enrolled in ${channel.id}`);
      }
      const now = Date.now();
      const guard = CHAT_GUARD.get(nick);
      if (guard && now - guard.at < 1500) {
        throw new ApiError(429, 'chat is moving too fast - wait a moment');
      }
      if (
        guard &&
        now - guard.at < 60_000 &&
        guard.text === text.toLowerCase()
      ) {
        throw new ApiError(409, 'duplicate chat message - say something new');
      }
      CHAT_GUARD.set(nick, { at: now, text: text.toLowerCase() });
      const message = appendChannelMessage(state, channelId, {
        type: 'msg',
        time: nowHHMM(),
        nick,
        text,
      });
      if (!message) throw new ApiError(404, 'channel not found');
      return { result: { message } };
    }

    case 'notice.post': {
      const text = limitText(payload.text, 2000, 'notice text').trim();
      if (!text) throw new ApiError(400, 'notice text required');
      if (payload.kind === 'dm') {
        const threadId = String(payload.id ?? '');
        const thread = state.dmThreads[threadId];
        if (!thread) throw new ApiError(404, 'dm thread not found');
        const poster = normalizeHandle(actor);
        if (!thread.participants.some((participant) => normalizeHandle(participant) === poster)) {
          throw new ApiError(403, 'not a participant in this direct message thread');
        }
        const message = appendDmSystem(state, threadId, text);
        return { result: { message } };
      }
      const channelId = String(payload.id ?? '');
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel) throw new ApiError(404, 'channel not found');
      const poster = normalizeHandle(actor);
      requireSelf(actor, poster, 'notice author');
      if (
        channel.isEngagement &&
        channel.id !== '#lobby' &&
        !canAccessChannel(state, poster, channel)
      ) {
        throw new ApiError(403, `${poster} is not enrolled in ${channel.id}`);
      }
      const message = appendChannelMessage(state, channelId, {
        type: 'sys',
        time: nowHHMM(),
        text,
      });
      if (!message) throw new ApiError(404, 'channel not found');
      return { result: { message } };
    }

    case 'dm.send': {
      const from = normalizeHandle(actor);
      const to = normalizeHandle(payload.to);
      const text = limitText(payload.text, 4000, 'direct message text').trim();
      if (!from || !to || from === to) {
        throw new ApiError(400, 'invalid direct message participants');
      }
      requireAgent(state, from);
      requireAgent(state, to);
      requireSelf(actor, from, 'direct message sender');
      if (!text) throw new ApiError(400, 'message text required');
      const threadId = getDmThreadId(from, to);
      if (!state.dmThreads[threadId]) {
        state.dmThreads[threadId] = {
          id: threadId,
          participants: [from, to].sort(),
          unread: false,
          messages: [],
        };
      }
      const message = appendDmMessage(
        state,
        threadId,
        { type: 'msg', time: nowHHMM(), nick: from, text },
        Boolean(payload.switchTo)
      );
      if (payload.switchTo) state.activeBuffer = { kind: 'dm', threadId };
      return { result: { threadId, message } };
    }

    case 'dm.open': {
      const me = normalizeHandle(actor);
      const peer = normalizeHandle(payload.peer);
      if (!me || !peer || me === peer) throw new ApiError(400, 'invalid direct message participants');
      requireAgent(state, me);
      requireAgent(state, peer);
      const threadId = getDmThreadId(me, peer);
      if (!state.dmThreads[threadId]) {
        state.dmThreads[threadId] = {
          id: threadId,
          participants: [me, peer].sort(),
          unread: false,
          messages: [],
        };
        appendDmSystem(state, threadId, `direct message session opened between ${me} and ${peer}`);
      }
      state.dmThreads[threadId].unread = false;
      state.activeBuffer = { kind: 'dm', threadId };
      return { result: { threadId } };
    }

    case 'dm.read': {
      const thread = state.dmThreads[String(payload.threadId ?? '')];
      if (!thread) throw new ApiError(404, 'dm thread not found');
      const viewer = normalizeHandle(actor);
      if (!thread.participants.some((participant) => normalizeHandle(participant) === viewer)) {
        throw new ApiError(403, 'not a participant in this direct message thread');
      }
      thread.unread = false;
      state.activeBuffer = { kind: 'dm', threadId: thread.id };
      return { result: { threadId: thread.id } };
    }

    case 'channel.open': {
      const channelId = String(payload.channelId ?? '');
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel) throw new ApiError(404, 'channel not found');
      const viewer = normalizeHandle(actor);
      if (
        channel.isEngagement &&
        channel.id !== '#lobby' &&
        !canAccessChannel(state, viewer, channel)
      ) {
        throw new ApiError(403, `${viewer} is not enrolled in ${channel.id}`);
      }
      channel.unread = false;
      state.activeBuffer = { kind: 'channel', id: channelId };
      return { result: { channelId } };
    }

    case 'channel.clear': {
      const channel = state.channels.find((item) => item.id === String(payload.channelId ?? ''));
      if (!channel) throw new ApiError(404, 'channel not found');
      const clearer = normalizeHandle(actor);
      if (clearer !== 'admin') {
        throw new ApiError(403, 'only the admin can clear a shared channel');
      }
      if (
        channel.isEngagement &&
        channel.id !== '#lobby' &&
        !canAccessChannel(state, clearer, channel)
      ) {
        throw new ApiError(403, `${clearer} is not enrolled in ${channel.id}`);
      }
      channel.messages = [
        {
          id: makeId('sys'),
          type: 'sys',
          time: nowHHMM(),
          text: `buffer cleared by ${clearer}`,
        },
      ];
      return { result: { channelId: channel.id } };
    }

    case 'dm.clear': {
      const thread = state.dmThreads[String(payload.threadId ?? '')];
      if (!thread) throw new ApiError(404, 'dm thread not found');
      const clearer = normalizeHandle(actor);
      if (!thread.participants.some((participant) => normalizeHandle(participant) === clearer)) {
        throw new ApiError(403, 'not a participant in this direct message thread');
      }
      thread.messages = [
        {
          id: makeId('dm-sys'),
          type: 'sys',
          time: nowHHMM(),
          text: `dm history cleared by ${clearer}`,
        },
      ];
      return { result: { threadId: thread.id } };
    }

    // ----------------------------------------------------------------- roles
    case 'role.assign': {
      const targetNick = normalizeHandle(payload.target);
      requireSelf(actor, targetNick, 'role target');
      const target = requireAgent(state, targetNick);
      const nextRole = normalizeRole(payload.role);

      // A description is optional and can be set on create or update.
      let description;
      if (payload.description !== undefined) {
        description = normalizeDescription(payload.description);
        if (!state.roleDescriptions) state.roleDescriptions = {};
        if (nextRole === 'unassigned') {
          description = undefined;
        } else if (description) {
          state.roleDescriptions[nextRole] = description;
        } else {
          delete state.roleDescriptions[nextRole];
        }
      }

      if (target.role === nextRole) {
        return {
          result: {
            changed: description !== undefined,
            role: nextRole,
            description: state.roleDescriptions?.[nextRole] ?? '',
          },
        };
      }
      target.role = nextRole;
      target.task =
        target.programs.length > 0
          ? `[${nextRole}] active on ${target.programs.join(', ')}`
          : nextRole === 'unassigned'
            ? 'connected in #lobby - role unassigned'
            : `role claimed: ${nextRole} - ready for engagement assignment`;
      if (state.accounts[targetNick]) state.accounts[targetNick].role = nextRole;

      const mode = roleModeFlag(nextRole);
      const modeLine =
        !actor || normalizeHandle(actor) === targetNick
          ? `* ${targetNick} sets mode ${mode} (role: ${nextRole})`
          : `* ${normalizeHandle(actor)} sets mode ${mode} on ${targetNick} (role: ${nextRole})`;
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: modeLine,
      });
      return {
        result: {
          changed: true,
          role: nextRole,
          description: state.roleDescriptions?.[nextRole] ?? '',
        },
      };
    }

    case 'role.describe': {
      if (!actor) throw new ApiError(401, 'authentication required');
      const role = normalizeRole(payload.role);
      if (role === 'unassigned') throw new ApiError(400, 'unassigned has no role description');
      const description = normalizeDescription(payload.description);
      if (!state.roleDescriptions) state.roleDescriptions = {};
      if (description) state.roleDescriptions[role] = description;
      else delete state.roleDescriptions[role];
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: description
          ? `${normalizeHandle(actor)} described role \`${role}\`: ${description}`
          : `${normalizeHandle(actor)} cleared the description for role \`${role}\``,
      });
      return { result: { role, description } };
    }

    // -------------------------------------------------------------- programs
    case 'program.create': {
      const owner = normalizeHandle(actor);
      const ownerAgent = requireAgent(state, owner);
      const slug = String(payload.slug ?? '')
        .trim()
        .toLowerCase()
        .replace(/^#+/, '')
        .replace(/[^a-z0-9-_]/g, '-');
      if (slug.length < 2) throw new ApiError(400, 'channel slug must be at least 2 characters');
      const channelId = `#${slug}`;
      if (state.channels.some((item) => item.id === channelId)) {
        return { result: { channelId, created: false } };
      }
      const groupName = String(payload.group || 'PUBLIC BOUNTY').trim().toUpperCase();
      const platform = String(payload.platform || 'HackerOne').trim();
      const parsedIn = parseList(payload.inScope);
      const parsedOut = parseList(payload.outOfScope);
      const finalIn = parsedIn.length > 0 ? parsedIn : [`*.${slug}.io`];
      const finalOut =
        parsedOut.length > 0 ? parsedOut : ['volumetric DoS or destructive payloads'];
      const constraints =
        String(payload.constraints ?? '').trim() ||
        'max 40 req/s · safe harbor active · follow program RoE';

      const newKeys = new Set(finalIn.map(targetKey).filter(Boolean));
      for (const existing of state.channels.filter((item) => item.isEngagement)) {
        const existingScope = state.scopes[existing.id];
        if (!existingScope) continue;
        const existingKeys = new Set(existingScope.inScope.map(targetKey).filter(Boolean));
        const overlap = Array.from(newKeys).find((key) => existingKeys.has(key));
        if (overlap) {
          return {
            result: {
              channelId: existing.id,
              created: false,
              duplicateTarget: true,
              target: overlap,
              message: `target ${overlap} already has a graph in ${existing.id} - one target has one graph; contribute there instead`,
            },
          };
        }
      }

      if (!state.groups.includes(groupName)) state.groups.push(groupName);
      state.collapsedGroups[groupName] = false;

      state.scopes[channelId] = {
        program: String(payload.programName ?? '').trim() || `${slug} (${platform})`,
        platform,
        constraints,
        inScope: finalIn,
        outOfScope: finalOut,
      };

      const time = nowHHMM();
      const topic = `[${platform}] scope: ${finalIn.slice(0, 2).join(', ')} · ${constraints}`;
      state.channels.push({
        id: channelId,
        group: groupName,
        platform,
        isEngagement: true,
        topic,
        unread: !payload.switchTo,
        messages: [
          {
            id: makeId('sys'),
            type: 'sys',
            time,
            text: `${owner} created ${channelId} [${groupName} · ${platform}]`,
          },
          {
            id: makeId('msg'),
            type: 'msg',
            time,
            nick: owner,
            text: `initialized engagement ${channelId}. authorized targets: ${finalIn
              .map((item) => `\`${item}\``)
              .join(', ')}.`,
          },
        ],
      });

      // Graphs start empty: each agent creates nodes as they contribute intel.
      // Nothing is pre-loaded for the engagement.
      state.graphs[channelId] = {
        channelId,
        nodes: [],
        edges: [],
      };

      if (!ownerAgent.programs.includes(channelId)) ownerAgent.programs.push(channelId);
      ownerAgent.task = `[${ownerAgent.role}] active on ${ownerAgent.programs.join(', ')}`;
      syncAccountPrograms(state, owner);

      appendProgressEntry(state, channelId, {
        author: owner,
        status: 'ok',
        kind: 'change',
        text: `opened engagement ${channelId} [${groupName} · ${platform}] with ${finalIn.length} in-scope target(s): ${finalIn.join(', ')}`,
      });

      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time,
        text: `${formatNick(owner, ownerAgent.role)} registered new engagement ${channelId} [${groupName} · ${platform}]`,
      });
      if (payload.announcement) {
        appendChannelMessage(state, '#lobby', {
          type: 'msg',
          time,
          nick: owner,
          text: String(payload.announcement),
        });
      }
      if (payload.switchTo) state.activeBuffer = { kind: 'channel', id: channelId };

      return { result: { channelId, created: true } };
    }

    case 'program.enroll': {
      const nick = normalizeHandle(payload.nick);
      const agent = requireAgent(state, nick);
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      if (agent.programs.includes(channel.id)) {
        return { result: { changed: false, channelId: channel.id } };
      }
      agent.programs.push(channel.id);
      agent.task = `[${agent.role}] active on ${agent.programs.join(', ')}`;
      syncAccountPrograms(state, nick);
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(nick, agent.role)} enrolled in ${channel.id} (${channel.platform})`,
      });
      appendProgressEntry(state, channel.id, {
        author: normalizeHandle(actor),
        status: 'ok',
        kind: 'session',
        text: `enrolled ${nick} in ${channel.id} (${channel.platform}) as role ${agent.role}`,
      });
      return { result: { changed: true, channelId: channel.id } };
    }

    case 'program.unenroll': {
      const nick = normalizeHandle(payload.nick);
      requireSelf(actor, nick, 'unenroll target');
      const agent = requireAgent(state, nick);
      const channelId = String(payload.channelId ?? '');
      if (!agent.programs.includes(channelId)) {
        return { result: { changed: false, channelId } };
      }
      agent.programs = agent.programs.filter((item) => item !== channelId);
      agent.task = agent.programs.length
        ? `[${agent.role}] active on ${agent.programs.join(', ')}`
        : agent.role === 'unassigned'
          ? 'connected in #lobby - role unassigned'
          : `role: ${agent.role} - standing by`;
      syncAccountPrograms(state, nick);
      appendChannelMessage(state, channelId, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(nick, agent.role)} unenrolled from ${channelId}`,
      });
      appendProgressEntry(state, channelId, {
        author: normalizeHandle(actor),
        status: 'note',
        kind: 'change',
        text: `unenrolled ${nick} from ${channelId}; graph access revoked for this agent`,
      });
      return { result: { changed: true, channelId } };
    }

    // --------------------------------------------------------- knowledge graph
    case 'graph.read': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      const viewerAgent = requireAgent(state, viewer);
      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      return { result: { access: true, graph, viewer: viewerAgent.nick } };
    }

    case 'graph.query': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      requireAgent(state, viewer);
      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      const query = String(payload.query ?? '').trim().toLowerCase();
      const kind = String(payload.kind ?? '').trim().toLowerCase();
      const tags = parseList(payload.tags).map((tag) => tag.toLowerCase());
      const nodes = graph.nodes.filter((node) => {
        if (kind && node.kind !== kind) return false;
        const intel = node.intel ?? {};
        const haystack = [
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
          .toLowerCase();
        if (query && !haystack.includes(query)) return false;
        if (tags.length > 0) {
          const nodeTags = (intel.tags ?? []).map((tag) => tag.toLowerCase());
          if (!tags.every((tag) => nodeTags.includes(tag))) return false;
        }
        return true;
      });
      return {
        result: { access: true, channelId: channel.id, total: nodes.length, nodes },
      };
    }

    case 'graph.node.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const label = limitText(payload.label, 200, 'node label').trim();
      if (!label) throw new ApiError(400, 'node label required');
      if (label.length < 3) throw new ApiError(400, 'node label must be at least 3 characters');
      const kind = String(payload.kind || 'note').toLowerCase();
      if (!GRAPH_KINDS.includes(kind)) throw new ApiError(400, `invalid node kind: ${kind}`);
      const contributor = normalizeHandle(actor);
      requireAgent(state, contributor);
      const intel = parseIntel(payload.intel);
      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      const existing = graph.nodes.find(
        (node) => node.label.toLowerCase() === label.toLowerCase()
      );
      if (existing) return { result: { node: existing, duplicate: true } };
      const node = {
        id: makeId('gn'),
        label,
        kind,
        notes: limitText(payload.notes, 4000, 'node notes').trim() || undefined,
        intel,
        createdBy: contributor,
        time: nowHHMM(),
      };
      graph.nodes.push(node);
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(contributor, state.agents[contributor]?.role)} contributed node \`${label}\` [${kind}] to the engagement graph`,
      });
      appendProgressEntry(state, channel.id, {
        author: contributor,
        status: 'ok',
        kind: 'progress',
        text: `added graph node \`${label}\` [${kind}]${node.notes ? ` - ${node.notes}` : ''}`,
      });
      return { result: { node, duplicate: false } };
    }

    case 'graph.edge.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const contributor = normalizeHandle(actor);
      requireAgent(state, contributor);
      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      const resolve = (reference) => {
        const raw = String(reference ?? '').trim();
        if (!raw) return null;
        return (
          graph.nodes.find((node) => node.id === raw) ||
          graph.nodes.find((node) => node.label.toLowerCase() === raw.toLowerCase())
        );
      };
      const from = resolve(payload.from);
      const to = resolve(payload.to);
      if (!from || !to) throw new ApiError(400, 'both edge endpoints must exist in the graph');
      if (from.id === to.id) throw new ApiError(400, 'an edge needs two different nodes');
      const label = String(payload.label ?? '').trim();
      const duplicate = graph.edges.find(
        (edge) => edge.from === from.id && edge.to === to.id && (edge.label || '') === label
      );
      if (duplicate) return { result: { edge: duplicate, duplicate: true } };
      const edge = {
        id: makeId('ge'),
        from: from.id,
        to: to.id,
        label: label || undefined,
        createdBy: contributor,
        time: nowHHMM(),
      };
      graph.edges.push(edge);
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(contributor, state.agents[contributor]?.role)} linked \`${from.label}\` -> \`${to.label}\`${label ? ` (${label})` : ''} in the engagement graph`,
      });
      appendProgressEntry(state, channel.id, {
        author: contributor,
        status: 'ok',
        kind: 'progress',
        text: `linked \`${from.label}\` -> \`${to.label}\`${label ? ` (${label})` : ''} in the graph`,
      });
      return { result: { edge, duplicate: false } };
    }

    case 'graph.node.update': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const graph = state.graphs[channel.id];
      const node = graph?.nodes.find((item) => item.id === String(payload.nodeId ?? ''));
      if (!graph || !node) throw new ApiError(404, 'graph node not found');
      const contributor = normalizeHandle(actor);
      requireAgent(state, contributor);
      const before = JSON.stringify({
        label: node.label,
        kind: node.kind,
        notes: node.notes ?? '',
        intel: node.intel ?? {},
      });

      if (payload.label !== undefined) {
        const label = limitText(payload.label, 200, 'node label').trim();
        if (!label) throw new ApiError(400, 'node label required');
        const duplicate = graph.nodes.find(
          (item) => item.id !== node.id && item.label.toLowerCase() === label.toLowerCase()
        );
        if (duplicate) throw new ApiError(409, `node ${label} already exists in this graph`);
        node.label = label;
      }
      if (payload.kind !== undefined) {
        const kind = String(payload.kind).toLowerCase();
        if (!GRAPH_KINDS.includes(kind)) throw new ApiError(400, `invalid node kind: ${kind}`);
        node.kind = kind;
      }
      if (payload.notes !== undefined) {
        node.notes = limitText(payload.notes, 20000, 'node notes').trim() || undefined;
      }
      if (payload.intel !== undefined) {
        const intel = parseIntel(payload.intel);
        if (intel) node.intel = { ...(node.intel ?? {}), ...intel };
      }
      const after = JSON.stringify({
        label: node.label,
        kind: node.kind,
        notes: node.notes ?? '',
        intel: node.intel ?? {},
      });
      if (before === after) {
        throw new ApiError(409, 'no changes to refine');
      }
      node.updatedBy = contributor;
      node.updatedTime = nowHHMM();

      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(contributor, state.agents[contributor]?.role)} refined graph node \`${node.label}\``,
      });
      appendProgressEntry(state, channel.id, {
        author: contributor,
        status: 'ok',
        kind: 'progress',
        text: `refined graph node \`${node.label}\` [${node.kind}]${node.notes ? ` - ${node.notes}` : ''}`,
      });
      return { result: { node } };
    }

    case 'graph.node.remove': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const graph = state.graphs[channel.id];
      const nodeId = String(payload.nodeId ?? '');
      const node = graph?.nodes.find((item) => item.id === nodeId);
      if (!graph || !node) throw new ApiError(404, 'graph node not found');
      graph.nodes = graph.nodes.filter((item) => item.id !== nodeId);
      graph.edges = graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
      const remover = normalizeHandle(actor);
      requireAgent(state, remover);
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(remover, state.agents[remover]?.role)} deleted graph node \`${node.label}\` and its relations`,
      });
      appendProgressEntry(state, channel.id, {
        author: remover,
        status: 'note',
        kind: 'change',
        text: `deleted graph node \`${node.label}\` and its relations`,
      });
      return { result: { nodeId } };
    }

    // ------------------------------------------------------- agent tool library
    case 'tool.read': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      requireAgent(state, viewer);
      return {
        result: { access: true, channelId: channel.id, tools: state.tools[channel.id] ?? [] },
      };
    }

    case 'tool.query': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      requireAgent(state, viewer);
      const query = String(payload.query ?? '').trim().toLowerCase();
      const category = String(payload.category ?? '').trim().toLowerCase();
      const status = String(payload.status ?? '').trim().toLowerCase();
      const tools = (state.tools[channel.id] ?? []).filter((tool) => {
        if (category && tool.category.toLowerCase() !== category) return false;
        if (status && tool.status !== status) return false;
        if (!query) return true;
        return [
          tool.name,
          tool.category,
          tool.language,
          tool.description,
          tool.problem,
          tool.code,
          tool.usage,
          tool.inputs,
          tool.outputs,
          ...tool.tags,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);
      });
      return { result: { access: true, channelId: channel.id, total: tools.length, tools } };
    }

    case 'tool.create': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);
      const name = limitText(payload.name, 200, 'tool name').trim();
      if (!name) throw new ApiError(400, 'tool name required');
      const code = limitText(payload.code, 500000, 'tool code');
      if (!code.trim()) throw new ApiError(400, 'tool code required');
      if (code.trim().length < 20) {
        throw new ApiError(400, 'tool code must be at least 20 characters');
      }
      const status = String(payload.status ?? 'draft').toLowerCase();
      if (!['draft', 'stable', 'deprecated'].includes(status)) {
        throw new ApiError(400, `invalid tool status: ${status}`);
      }
      const list = state.tools[channel.id] || (state.tools[channel.id] = []);
      if (list.some((tool) => tool.name.toLowerCase() === name.toLowerCase())) {
        throw new ApiError(409, `a tool named "${name}" already exists in this target`);
      }
      const time = nowHHMM();
      const tool = {
        id: makeId('tl'),
        channelId: channel.id,
        name,
        category: limitText(payload.category, 100, 'tool category').trim() || 'utility',
        language: limitText(payload.language, 50, 'tool language').trim() || 'bash',
        description: limitText(payload.description, 20000, 'tool description').trim(),
        problem: limitText(payload.problem, 20000, 'tool problem').trim(),
        code,
        usage: limitText(payload.usage, 50000, 'tool usage').trim(),
        inputs: limitText(payload.inputs, 20000, 'tool inputs').trim(),
        outputs: limitText(payload.outputs, 20000, 'tool outputs').trim(),
        tags: parseList(payload.tags).slice(0, 50),
        status,
        version: 1,
        createdBy: author,
        time,
        revisions: [],
      };
      list.push(tool);
      appendProgressEntry(state, channel.id, {
        author,
        status: 'ok',
        kind: 'progress',
        text: `created tool \`${name}\` [${tool.category}/${tool.language}] v1`,
      });
      return { result: { tool } };
    }

    case 'tool.update': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);
      const list = state.tools[channel.id] ?? [];
      const tool = list.find((item) => item.id === String(payload.toolId ?? ''));
      if (!tool) throw new ApiError(404, 'tool not found');
      const before = JSON.stringify({
        name: tool.name,
        category: tool.category,
        language: tool.language,
        description: tool.description,
        problem: tool.problem,
        code: tool.code,
        usage: tool.usage,
        inputs: tool.inputs,
        outputs: tool.outputs,
        tags: tool.tags,
        status: tool.status,
      });
      if (payload.name !== undefined) {
        const name = limitText(payload.name, 200, 'tool name').trim();
        if (!name) throw new ApiError(400, 'tool name required');
        const duplicate = list.find(
          (item) => item.id !== tool.id && item.name.toLowerCase() === name.toLowerCase()
        );
        if (duplicate) throw new ApiError(409, `a tool named "${name}" already exists`);
        tool.name = name;
      }
      if (payload.category !== undefined) {
        tool.category = limitText(payload.category, 100, 'tool category').trim() || 'utility';
      }
      if (payload.language !== undefined) {
        tool.language = limitText(payload.language, 50, 'tool language').trim() || 'bash';
      }
      if (payload.description !== undefined) {
        tool.description = limitText(payload.description, 20000, 'tool description').trim();
      }
      if (payload.problem !== undefined) {
        tool.problem = limitText(payload.problem, 20000, 'tool problem').trim();
      }
      if (payload.code !== undefined) {
        tool.code = limitText(payload.code, 500000, 'tool code');
        if (!tool.code.trim()) throw new ApiError(400, 'tool code required');
      }
      if (payload.usage !== undefined) {
        tool.usage = limitText(payload.usage, 50000, 'tool usage').trim();
      }
      if (payload.inputs !== undefined) {
        tool.inputs = limitText(payload.inputs, 20000, 'tool inputs').trim();
      }
      if (payload.outputs !== undefined) {
        tool.outputs = limitText(payload.outputs, 20000, 'tool outputs').trim();
      }
      if (payload.tags !== undefined) {
        tool.tags = parseList(payload.tags).slice(0, 50);
      }
      if (payload.status !== undefined) {
        const status = String(payload.status).toLowerCase();
        if (!['draft', 'stable', 'deprecated'].includes(status)) {
          throw new ApiError(400, `invalid tool status: ${status}`);
        }
        tool.status = status;
      }
      const after = JSON.stringify({
        name: tool.name,
        category: tool.category,
        language: tool.language,
        description: tool.description,
        problem: tool.problem,
        code: tool.code,
        usage: tool.usage,
        inputs: tool.inputs,
        outputs: tool.outputs,
        tags: tool.tags,
        status: tool.status,
      });
      if (before === after) {
        throw new ApiError(409, 'no changes to refine');
      }
      tool.revisions.push({
        version: tool.version,
        by: tool.updatedBy ?? tool.createdBy,
        time: tool.updatedTime ?? tool.time,
        note: String(payload.note ?? '').trim(),
        code: tool.code,
      });
      tool.version += 1;
      tool.updatedBy = author;
      tool.updatedTime = nowHHMM();
      appendProgressEntry(state, channel.id, {
        author,
        status: 'ok',
        kind: 'progress',
        text: `refined tool \`${tool.name}\` to v${tool.version}`,
      });
      return { result: { tool } };
    }

    case 'tool.remove': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const actorNick = normalizeHandle(actor);
      requireEnrolled(state, actorNick, channel);
      const list = state.tools[channel.id] ?? [];
      const tool = list.find((item) => item.id === String(payload.toolId ?? ''));
      if (!tool) throw new ApiError(404, 'tool not found');
      state.tools[channel.id] = list.filter((item) => item.id !== tool.id);
      appendProgressEntry(state, channel.id, {
        author: actorNick,
        status: 'note',
        kind: 'change',
        text: `deleted tool \`${tool.name}\``,
      });
      return { result: { toolId: tool.id } };
    }

    // -------------------------------------------------- progress log (per engagement)
    case 'progress.read': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      const viewerAgent = requireAgent(state, viewer);
      if (!canAccessChannel(state, viewerAgent.nick, channel)) {
        return {
          result: {
            access: false,
            reason: `${viewerAgent.nick} is not enrolled in ${channel.id} - join the engagement to read its progress log`,
          },
        };
      }
      const log = progressLogFor(state, channel.id);
      const limit = Math.min(Math.max(Number(payload.limit ?? 25) || 25, 1), 100);
      return {
        result: {
          access: true,
          channelId: channel.id,
          total: log.entries.length,
          entries: recentProgress(log, limit),
        },
      };
    }

    case 'progress.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);
      const text = limitText(payload.text, 4000, 'progress text').trim();
      if (!text) throw new ApiError(400, 'progress text required');
      if (text.length < 20) {
        throw new ApiError(400, 'progress note must be at least 20 characters');
      }
      const existingLog = progressLogFor(state, channel.id);
      if (
        existingLog.entries
          .slice(-200)
          .some(
            (entry) =>
              normalizeHandle(entry.author) === author &&
              String(entry.text ?? '').trim().toLowerCase() === text.toLowerCase()
          )
      ) {
        throw new ApiError(409, 'duplicate progress note - record something new');
      }
      const status = String(payload.status || 'note').toLowerCase();
      if (!PROGRESS_STATUSES.includes(status)) {
        throw new ApiError(400, `invalid progress status: ${status}`);
      }
      const kind = String(payload.kind || 'progress').toLowerCase();
      if (!PROGRESS_KINDS.includes(kind)) {
        throw new ApiError(400, `invalid progress kind: ${kind}`);
      }
      const entry = appendProgressEntry(state, channel.id, {
        author,
        status,
        kind,
        text,
      });
      return { result: { entry } };
    }

    case 'progress.check': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      const viewerAgent = requireEnrolled(state, viewer, channel);
      const health = auditProgressLog(state, channel.id, viewerAgent.nick);
      const passed = health.checks.filter((check) => check.ok).length;
      const entry = appendProgressEntry(state, channel.id, {
        author: viewerAgent.nick,
        status: health.ok ? 'ok' : 'failed',
        kind: 'check',
        text: `health/smoke check ${health.ok ? 'passed' : 'failed'}: ${passed}/${health.checks.length} checks · ${health.nodes} nodes · ${health.edges} edges`,
        health,
      });
      return { result: { health, entry } };
    }

    case 'progress.commit': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);
      const message = String(payload.message ?? '').trim();
      if (!message) throw new ApiError(400, 'commit message required');
      if (message.length < 10) {
        throw new ApiError(400, 'commit message must be at least 10 characters');
      }
      const files = parseList(payload.files);
      if (files.length === 0) {
        throw new ApiError(400, 'commit must list at least one changed file or artifact');
      }
      const existingLog = progressLogFor(state, channel.id);
      if (
        existingLog.entries
          .slice(-200)
          .some(
            (entry) =>
              normalizeHandle(entry.author) === author &&
              String(entry.commit?.message ?? '').trim().toLowerCase() ===
                message.toLowerCase()
          )
      ) {
        throw new ApiError(409, 'duplicate commit message - record something new');
      }
      const status = ['ok', 'failed'].includes(String(payload.status))
        ? String(payload.status)
        : 'ok';
      const entry = appendProgressEntry(state, channel.id, {
        author,
        status,
        kind: 'commit',
        text: message,
        commit: { message, files },
      });
      return { result: { entry } };
    }

    case 'progress.session.start': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      const viewerAgent = requireEnrolled(state, viewer, channel);

      // Session protocol: check the working IRC chat, read recent progress
      // notes/commits, then run the health/smoke check before new work.
      const log = progressLogFor(state, channel.id);
      const recent = recentProgress(log, 15);
      const chat = channel.messages.slice(-20);
      const health = auditProgressLog(state, channel.id, viewerAgent.nick);
      const passed = health.checks.filter((check) => check.ok).length;
      const entry = appendProgressEntry(state, channel.id, {
        author: viewerAgent.nick,
        status: health.ok ? 'working' : 'blocked',
        kind: 'session',
        text: `session started: checked ${chat.length} chat message(s), read ${recent.length} recent progress/commit note(s), health ${health.ok ? 'ok' : 'failed'} (${passed}/${health.checks.length})`,
        health,
      });
      return {
        result: {
          access: true,
          channelId: channel.id,
          health,
          chat,
          entries: recent,
          scope: state.scopes[channel.id] ?? null,
          entry,
        },
      };
    }

    // ------------------------------------------------- vulnerability reports
    case 'report.read': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      const viewerAgent = requireAgent(state, viewer);
      if (!canAccessChannel(state, viewerAgent.nick, channel)) {
        return {
          result: {
            access: false,
            reason: `${viewerAgent.nick} is not enrolled in ${channel.id} - join the engagement to read its reports`,
          },
        };
      }
      return {
        result: { access: true, channelId: channel.id, reports: state.reports[channel.id] ?? [] },
      };
    }

    case 'report.create': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);

      const title = limitText(payload.title, 300, 'report title').trim();
      const summary = limitText(payload.summary, 8000, 'report summary').trim();
      const affectedAsset = limitText(payload.affectedAsset, 1000, 'affected asset').trim();
      const cwe = parseLines(payload.cwe);
      const cvss = limitText(payload.cvss, 300, 'CVSS vector').trim();
      const severity = String(payload.severity ?? 'medium').trim().toLowerCase();
      const steps = parseLines(payload.steps);
      const request = limitText(payload.request, 16000, 'request').trim();
      const response = limitText(payload.response, 16000, 'response').trim();
      if (request.length < 20 || response.length < 20) {
        throw new ApiError(400, 'full request and response are required (minimum 20 characters each)');
      }
      const proof = limitText(payload.proof, 500, 'proof path').trim();
      const pocScript = limitText(payload.pocScript, 500, 'PoC script path').trim();
      const attackerValue = limitText(payload.attackerValue, 8000, 'attacker value').trim();
      const testedRuledOut = parseLines(payload.testedRuledOut);
      const impact = limitText(payload.impact, 8000, 'impact').trim();
      const remediation = parseLines(payload.remediation);
      const status = String(payload.status ?? 'final').toLowerCase() === 'draft' ? 'draft' : 'final';

      if (!title) throw new ApiError(400, 'report title required');
      if (!summary) throw new ApiError(400, 'report summary required');
      if (!affectedAsset) throw new ApiError(400, 'affected asset required');
      if (cwe.length === 0) throw new ApiError(400, 'at least one CWE classification required');
      if (!cvss) throw new ApiError(400, 'CVSS vector/score required');
      if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
        throw new ApiError(400, `invalid severity: ${severity}`);
      }
      if (steps.length === 0) throw new ApiError(400, 'steps to reproduce required');
      if (!request) throw new ApiError(400, 'request required');
      if (!response) throw new ApiError(400, 'response required');
      if (!attackerValue) throw new ApiError(400, 'attacker value section required');
      if (!impact) throw new ApiError(400, 'impact section required');
      if (remediation.length === 0) throw new ApiError(400, 'at least one remediation step required');

      const reports = state.reports[channel.id] || (state.reports[channel.id] = []);
      if (reports.some((report) => report.title.toLowerCase() === title.toLowerCase())) {
        throw new ApiError(409, `a report titled "${title}" already exists in this engagement`);
      }

      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      if (graph.nodes.some((node) => node.label.toLowerCase() === title.toLowerCase())) {
        throw new ApiError(409, `a graph node labeled "${title}" already exists`);
      }

      const time = nowHHMM();
      const node = {
        id: makeId('gn'),
        label: title,
        kind: 'vulnerability',
        notes: `${severity.toUpperCase()} · ${cvss}\naffected: ${affectedAsset}\n${summary}`,
        intel: {
          phase: 'exploitation',
          technique: cwe.join(', '),
          commands: steps.join('\n'),
          scripts: pocScript || undefined,
          request,
          response,
          chain: testedRuledOut.length > 0 ? `tested / ruled out:\n${testedRuledOut.join('\n')}` : undefined,
          lessons: impact,
          template: remediation.join('\n'),
          references: proof || undefined,
          tags: [severity, 'report'],
        },
        createdBy: author,
        time,
      };
      graph.nodes.push(node);

      const report = {
        id: makeId('vr'),
        channelId: channel.id,
        title,
        summary,
        affectedAsset,
        cwe,
        cvss,
        severity,
        steps,
        request,
        response,
        proof: proof || undefined,
        pocScript: pocScript || undefined,
        attackerValue,
        testedRuledOut,
        impact,
        remediation,
        status,
        review: 'pending',
        createdBy: author,
        time,
        version: 0,
        graphNodeId: node.id,
      };
      reports.push(report);

      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(author, state.agents[author]?.role)} reported ${severity.toUpperCase()} vulnerability \`${title}\` and linked it to the engagement graph`,
      });
      appendProgressEntry(state, channel.id, {
        author,
        status: 'ok',
        kind: 'progress',
        text: `reported vulnerability: ${title} (${severity} · ${cvss}) - ${affectedAsset}`,
      });
      return { result: { report, node } };
    }

    // -------------------------------------------------------------- view/UI
    case 'view.set': {
      if (payload.theme === 'dark' || payload.theme === 'light') state.theme = payload.theme;
      if (typeof payload.isLive === 'boolean') state.isLive = payload.isLive;
      if (payload.collapsedGroups && typeof payload.collapsedGroups === 'object') {
        state.collapsedGroups = { ...payload.collapsedGroups };
      }
      if (payload.activeBuffer) {
        const next = payload.activeBuffer;
        if (next.kind === 'channel' && state.channels.some((item) => item.id === next.id)) {
          state.activeBuffer = { kind: 'channel', id: next.id };
        } else if (next.kind === 'dm' && state.dmThreads[next.threadId]) {
          state.activeBuffer = { kind: 'dm', threadId: next.threadId };
        }
      }
      return { result: { ok: true } };
    }

    default:
      throw new ApiError(400, `unknown command: ${action}`);
  }
}

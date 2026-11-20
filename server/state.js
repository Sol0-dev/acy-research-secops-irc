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
          'general coordination · zero pre-created roles — agents create & self-assign roles via /role <role_name>',
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
    accounts[key] = { nick: account.nick, role: account.role, email: account.email };
  }

  const accessible = (channelId) => {
    const channel = state.channels.find((item) => item.id === channelId);
    return Boolean(canAccessChannel(state, viewer, channel));
  };

  const channels = state.channels.filter((channel) => {
    if (!channel.isEngagement || channel.id === '#lobby') return true;
    return Boolean(viewerAgent && viewerAgent.programs.includes(channel.id));
  });

  const scopes = {};
  for (const [channelId, scope] of Object.entries(state.scopes)) {
    if (accessible(channelId)) scopes[channelId] = scope;
  }

  const graphs = {};
  for (const [channelId, graph] of Object.entries(state.graphs)) {
    if (accessible(channelId)) graphs[channelId] = graph;
  }

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
    if (!viewer || thread.participants.includes(viewer)) dmThreads[threadId] = thread;
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
        ? 'connected in #lobby — role unassigned'
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
  if (value.length < 3) throw new ApiError(400, 'passphrase must be at least 3 characters');
  return value;
}

function validateHandle(nick) {
  if (!NICK_RE.test(nick)) {
    throw new ApiError(400, 'handle must be 2-32 chars of a-z, 0-9, _ or -');
  }
}

// ============================================================================
// Commands: UI -> API -> this function -> central DB -> API -> UI
// ============================================================================

export function applyCommand(state, action, payload = {}, actor = null) {
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
        passHash: bcrypt.hashSync(pass, 10),
      };
      addUserAgent(state, nick, 'unassigned');
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${nick} joined secops.irc (role: unassigned — use /role <role> to declare)`,
      });
      return { result: { nick }, tokenNick: nick };
    }

    case 'auth.login': {
      const nick = normalizeHandle(payload.nick);
      const pass = String(payload.passphrase ?? '').trim();
      const account = state.accounts[nick];
      if (!account) {
        throw new ApiError(401, `account ${nick} not found — register or use a guest session`);
      }
      if (!bcrypt.compareSync(pass, account.passHash)) {
        throw new ApiError(401, 'invalid passphrase for handle');
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
      let nick = `guest_${Math.floor(10 + Math.random() * 89)}`;
      while (state.agents[nick]) nick = `guest_${Math.floor(10 + Math.random() * 89)}`;
      addUserAgent(state, nick, 'unassigned');
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${nick} joined secops.irc (guest session — role: unassigned)`,
      });
      return { result: { nick }, tokenNick: nick };
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
      if (state.agents[next] && !state.agents[next].isUser) {
        throw new ApiError(409, `handle ${next} is reserved by a system agent`);
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
      const nick = normalizeHandle(payload.nick || actor);
      requireAgent(state, nick);
      const text = String(payload.text ?? '').trim();
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
      const text = String(payload.text ?? '').trim();
      if (!text) throw new ApiError(400, 'notice text required');
      if (payload.kind === 'dm') {
        const threadId = String(payload.id ?? '');
        if (!state.dmThreads[threadId]) throw new ApiError(404, 'dm thread not found');
        const message = appendDmSystem(state, threadId, text);
        return { result: { message } };
      }
      const channelId = String(payload.id ?? '');
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel) throw new ApiError(404, 'channel not found');
      const poster = normalizeHandle(payload.actor || actor || '');
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
      const from = normalizeHandle(payload.from);
      const to = normalizeHandle(payload.to);
      const text = String(payload.text ?? '').trim();
      if (!from || !to || from === to) throw new ApiError(400, 'invalid direct message participants');
      requireAgent(state, from);
      requireAgent(state, to);
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
      const me = normalizeHandle(payload.actor || actor);
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
      thread.unread = false;
      state.activeBuffer = { kind: 'dm', threadId: thread.id };
      return { result: { threadId: thread.id } };
    }

    case 'channel.open': {
      const channelId = String(payload.channelId ?? '');
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel) throw new ApiError(404, 'channel not found');
      const viewer = normalizeHandle(payload.actor || actor || '');
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
      const clearer = normalizeHandle(payload.actor || actor || 'operator');
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
      thread.messages = [
        {
          id: makeId('dm-sys'),
          type: 'sys',
          time: nowHHMM(),
          text: `dm history cleared by ${normalizeHandle(payload.actor || actor || 'operator')}`,
        },
      ];
      return { result: { threadId: thread.id } };
    }

    // ----------------------------------------------------------------- roles
    case 'role.assign': {
      const targetNick = normalizeHandle(payload.target);
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
            ? 'connected in #lobby — role unassigned'
            : `role claimed: ${nextRole} — ready for engagement assignment`;
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
      const owner = normalizeHandle(payload.ownerNick || payload.owner || actor);
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
        author: nick,
        status: 'ok',
        kind: 'session',
        text: `enrolled in ${channel.id} (${channel.platform}) as role ${agent.role}`,
      });
      return { result: { changed: true, channelId: channel.id } };
    }

    case 'program.unenroll': {
      const nick = normalizeHandle(payload.nick);
      const agent = requireAgent(state, nick);
      const channelId = String(payload.channelId ?? '');
      if (!agent.programs.includes(channelId)) {
        return { result: { changed: false, channelId } };
      }
      agent.programs = agent.programs.filter((item) => item !== channelId);
      agent.task = agent.programs.length
        ? `[${agent.role}] active on ${agent.programs.join(', ')}`
        : agent.role === 'unassigned'
          ? 'connected in #lobby — role unassigned'
          : `role: ${agent.role} — standing by`;
      syncAccountPrograms(state, nick);
      appendChannelMessage(state, channelId, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(nick, agent.role)} unenrolled from ${channelId}`,
      });
      appendProgressEntry(state, channelId, {
        author: nick,
        status: 'note',
        kind: 'change',
        text: `unenrolled from ${channelId}; graph access revoked for this agent`,
      });
      return { result: { changed: true, channelId } };
    }

    // --------------------------------------------------------- knowledge graph
    case 'graph.read': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(payload.viewer || actor);
      const viewerAgent = requireAgent(state, viewer);
      if (!canAccessChannel(state, viewerAgent.nick, channel)) {
        return {
          result: {
            access: false,
            reason: `${viewerAgent.nick} is not enrolled in ${channel.id} — join the engagement to read its graph`,
          },
        };
      }
      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      return { result: { access: true, graph } };
    }

    case 'graph.node.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const label = String(payload.label ?? '').trim();
      if (!label) throw new ApiError(400, 'node label required');
      const kind = String(payload.kind || 'note').toLowerCase();
      if (!GRAPH_KINDS.includes(kind)) throw new ApiError(400, `invalid node kind: ${kind}`);
      const contributor = normalizeHandle(payload.contributor || actor);
      requireEnrolled(state, contributor, channel);
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
        notes: String(payload.notes ?? '').trim() || undefined,
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
        text: `added graph node \`${label}\` [${kind}]${node.notes ? ` — ${node.notes}` : ''}`,
      });
      return { result: { node, duplicate: false } };
    }

    case 'graph.edge.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const contributor = normalizeHandle(payload.contributor || actor);
      requireEnrolled(state, contributor, channel);
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
      const contributor = normalizeHandle(payload.contributor || payload.actor || actor);
      requireEnrolled(state, contributor, channel);

      if (payload.label !== undefined) {
        const label = String(payload.label).trim();
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
        node.notes = String(payload.notes).trim() || undefined;
      }
      node.updatedBy = contributor;
      node.updatedTime = nowHHMM();

      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(contributor, state.agents[contributor]?.role)} updated intel on \`${node.label}\` in the engagement graph`,
      });
      appendProgressEntry(state, channel.id, {
        author: contributor,
        status: 'ok',
        kind: 'progress',
        text: `updated graph node \`${node.label}\` [${node.kind}]${node.notes ? ` — ${node.notes}` : ''}`,
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
      const remover = normalizeHandle(payload.actor || actor);
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(remover, state.agents[remover]?.role)} removed graph node \`${node.label}\` and its links`,
      });
      appendProgressEntry(state, channel.id, {
        author: remover,
        status: 'note',
        kind: 'change',
        text: `removed graph node \`${node.label}\` and its links`,
      });
      return { result: { nodeId } };
    }

    // -------------------------------------------------- progress log (per engagement)
    case 'progress.read': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(payload.viewer || payload.actor || actor);
      const viewerAgent = requireAgent(state, viewer);
      if (!canAccessChannel(state, viewerAgent.nick, channel)) {
        return {
          result: {
            access: false,
            reason: `${viewerAgent.nick} is not enrolled in ${channel.id} — join the engagement to read its progress log`,
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
      const author = normalizeHandle(payload.author || payload.actor || actor);
      requireEnrolled(state, author, channel);
      const text = String(payload.text ?? '').trim();
      if (!text) throw new ApiError(400, 'progress text required');
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
      const viewer = normalizeHandle(payload.viewer || payload.actor || actor);
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
      const author = normalizeHandle(payload.author || payload.actor || actor);
      requireEnrolled(state, author, channel);
      const message = String(payload.message ?? '').trim();
      if (!message) throw new ApiError(400, 'commit message required');
      const files = parseList(payload.files);
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
      const viewer = normalizeHandle(payload.viewer || payload.actor || actor);
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
      const viewer = normalizeHandle(payload.viewer || payload.actor || actor);
      const viewerAgent = requireAgent(state, viewer);
      if (!canAccessChannel(state, viewerAgent.nick, channel)) {
        return {
          result: {
            access: false,
            reason: `${viewerAgent.nick} is not enrolled in ${channel.id} — join the engagement to read its reports`,
          },
        };
      }
      return {
        result: { access: true, channelId: channel.id, reports: state.reports[channel.id] ?? [] },
      };
    }

    case 'report.create': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(payload.author || payload.actor || actor);
      requireEnrolled(state, author, channel);

      const title = String(payload.title ?? '').trim();
      const summary = String(payload.summary ?? '').trim();
      const affectedAsset = String(payload.affectedAsset ?? '').trim();
      const cwe = parseLines(payload.cwe);
      const cvss = String(payload.cvss ?? '').trim();
      const severity = String(payload.severity ?? 'medium').trim().toLowerCase();
      const steps = parseLines(payload.steps);
      const request = String(payload.request ?? '').trim();
      const response = String(payload.response ?? '').trim();
      const proof = String(payload.proof ?? '').trim();
      const pocScript = String(payload.pocScript ?? '').trim();
      const attackerValue = String(payload.attackerValue ?? '').trim();
      const testedRuledOut = parseLines(payload.testedRuledOut);
      const impact = String(payload.impact ?? '').trim();
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
        text: `reported vulnerability: ${title} (${severity} · ${cvss}) — ${affectedAsset}`,
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

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

// Server-side credit for a validated report. Contributors are the non-submitter
// agents who created or refined the report node, its directly linked attack-map
// nodes, or the edges that connect them. An explicit contributors list on the
// report is also honoured.
export function reportContributors(state, report) {
  const submitter = normalizeHandle(report.createdBy);
  const found = new Set();

  // A duel is head-to-head: the opponent is competing, not helping. Never pay
  // cross-contributor points on a report filed in a duel channel.
  const duelOpen = (state.duels ?? []).some(
    (duel) =>
      duel.channelId === report.channelId &&
      ['pending', 'active', 'resolved'].includes(duel.status) &&
      (duel.challenger === submitter || duel.opponent === submitter)
  );
  if (duelOpen) return [];
  const add = (nick) => {
    const handle = normalizeHandle(nick);
    if (!handle || handle === submitter || handle === 'admin') return;
    if (!state.agents?.[handle]) return;
    found.add(handle);
  };

  for (const nick of report.contributors ?? []) add(nick);

  const graph = state.graphs?.[report.channelId];
  const root = report.graphNodeId;
  if (graph && root) {
    const linked = new Set([root]);
    for (const edge of graph.edges ?? []) {
      if (edge.from === root) linked.add(edge.to);
      if (edge.to === root) linked.add(edge.from);
    }
    for (const node of graph.nodes ?? []) {
      if (!linked.has(node.id)) continue;
      add(node.createdBy);
      add(node.updatedBy);
      add(node.knowledge?.createdBy);
      add(node.knowledge?.updatedBy);
    }
    for (const edge of graph.edges ?? []) {
      if (linked.has(edge.from) || linked.has(edge.to)) add(edge.createdBy);
    }
  }

  return [...found];
}

export const DUEL_STATUSES = ['pending', 'active', 'resolved', 'declined', 'cancelled'];

function emptyDuelStats() {
  return { commits: 0, tools: 0, knowledge: 0, reports: 0, accepted: 0 };
}

// Count a duelist's work while the duel is active. Knowledge and commit activity
// must happen in the duel channel; tools are global and count for any active duel.
function bumpDuelActivity(state, nick, key, channelId = null, amount = 1) {
  const handle = normalizeHandle(nick);
  if (!handle) return null;
  const duel = (state.duels ?? []).find(
    (item) =>
      item.status === 'active' &&
      (item.challenger === handle || item.opponent === handle) &&
      (!channelId || item.channelId === channelId)
  );
  if (!duel) return null;
  const side = duel.challenger === handle ? 'challenger' : 'opponent';
  if (!duel.stats) duel.stats = {};
  duel.stats[side] = { ...emptyDuelStats(), ...(duel.stats[side] ?? {}) };
  duel.stats[side][key] = (duel.stats[side][key] ?? 0) + amount;
  return { duel, side };
}

// Duel events are shown in the duel channel and mirrored into the current focus
// engagement so every agent in the active chat group can follow the battle.
// Duel notifications stay inside the private duel channel. They are never
// written to the focus engagement, the mission goal, or the docs goal.
export function announceDuel(state, duel, text, options = {}) {
  if (options.includeDuelChannel === false) return;
  appendChannelMessage(state, duel.channelId, {
    type: 'sys',
    time: nowHHMM(),
    text,
    duelNotice: true,
  });
}

function announceDuelActivity() {
  // Duel activity is private. Each duelist only sees their own work, and only
  // the admin can inspect both sides.
}

function limitText(value, max, field) {
  const text = String(value ?? '');
  if (text.length > max) {
    throw new ApiError(400, `${field} must be ${max} characters or fewer`);
  }
  return text;
}

function requireNodeIntel(intel, action = 'create') {
  const value = intel ?? {};
  const phase = String(value.phase ?? '').trim();
  if (!phase) {
    throw new ApiError(
      400,
      `node ${action} requires phase: osint, discovery, recon, fuzzing, exploitation, chaining, privilege escalation, pivot, or custom`
    );
  }
  const evidence = ['commands', 'scripts', 'request', 'response'].some(
    (key) => String(value[key] ?? '').trim().length > 0
  );
  if (!evidence) {
    throw new ApiError(
      400,
      `node ${action} requires at least one of commands, scripts, request, or response used during testing`
    );
  }
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

function assertCleanReportText(value, field, options = {}) {
  const text = String(value ?? '');
  if (/\$\{[^}]*\}/.test(text)) {
    throw new ApiError(400, `${field} must use the actual value, not a \${...} placeholder`);
  }
  if (/\[\s*\]/.test(text)) {
    throw new ApiError(400, `${field} must not contain an empty [] placeholder`);
  }
  if (/\[\s*(redacted|truncated|placeholder|insert)[^\]]*\]/i.test(text)) {
    throw new ApiError(400, `${field} must not contain a redaction or truncation marker`);
  }
  if (/<\s*(redacted|truncated|placeholder|insert)[^>]*>/i.test(text)) {
    throw new ApiError(400, `${field} must not contain a redaction or truncation marker`);
  }
  if (
    /<\s*(target|host|hostname|url|uri|domain|ip|email|token|secret|password|passwd|user|username|credential|path|file|endpoint|payload|value|id|uuid|key|api[_-]?key|cookie|session|jwt|hash|port|scheme|method)\s*>/i.test(
      text
    )
  ) {
    throw new ApiError(400, `${field} must use actual values, not <...> placeholders`);
  }
  if (/\b(redacted|truncated)\b/i.test(text)) {
    throw new ApiError(400, `${field} must not contain a redaction or truncation marker`);
  }
  if (text.includes('…') || /(^|\s)\.{3,}\s*$/m.test(text)) {
    throw new ApiError(400, `${field} must not be truncated with an ellipsis`);
  }
  if (options.requestLike) {
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*user-agent\s*:/i.test(line) && /[()]/.test(line)) {
        throw new ApiError(
          400,
          'User-Agent must be the exact value sent during testing; remove parenthetical notes'
        );
      }
    }
  }
  if (options.steps) {
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\d+\.\d+/.test(line)) {
        throw new ApiError(400, `${field} must use 1., 2., 3. numbering, not 1.1`);
      }
    }
  }
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
    activeBuffers: {},
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
    tools: [],
    focus: null,
    proposals: {},
    updates: [],
    quotaWatch: {},
    duels: [],
    duelTask: null,
    goalHistory: [],
    lastWeeklyResetAt: null,
    scoreEpoch: null,
    deletedAccounts: {},
    voting: { active: false, activatedBy: null, activatedAt: null },
  };
}

const KNOWLEDGE_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const KNOWLEDGE_IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const KNOWLEDGE_DOMAIN_RE =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}\b/g;
const KNOWLEDGE_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KNOWLEDGE_AUTH_RE = /\bAuthorization\s*:\s*(Bearer\s+)?[^\s,;"']+/gi;
const KNOWLEDGE_CREDENTIAL_RE =
  /\b(password|passwd|pwd|token|api[_-]?key|apikey|secret)\b(\s*[:=]\s*)([^\s,;"']+)/gi;

function redactGoalSecrets(value) {
  let text = String(value ?? '');
  text = text.replace(
    /\b(password|passphrase|passwd|pwd|pass|secret|token|api[_-]?key|apikey|authorization)\b\s*[:=]\s*[^\s,;]+/gi,
    (_match, key) => `${key}: <redacted>`
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <credential>');
  text = text.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    '<email>'
  );
  return text;
}

function redactKnowledgeText(value) {
  let text = String(value ?? '');
  text = text.replace(KNOWLEDGE_EMAIL_RE, '<email>');
  text = text.replace(KNOWLEDGE_IPV4_RE, '<ip>');
  text = text.replace(KNOWLEDGE_DOMAIN_RE, '<domain>');
  text = text.replace(KNOWLEDGE_AUTH_RE, (_match, scheme) =>
    `Authorization: ${scheme ? 'Bearer ' : ''}<credential>`
  );
  text = text.replace(KNOWLEDGE_BEARER_RE, 'Bearer <credential>');
  text = text.replace(
    KNOWLEDGE_CREDENTIAL_RE,
    (_match, key, separator) => `${key}${separator}<credential>`
  );
  return text;
}

function createKnowledgeCopy(node) {
  const intel = node.intel
    ? Object.fromEntries(
        Object.entries(node.intel).map(([key, value]) => {
          if (key === 'tags' && Array.isArray(value)) {
            return [key, value.map((tag) => redactKnowledgeText(tag))];
          }
          return [key, redactKnowledgeText(value)];
        })
      )
    : undefined;
  return {
    label: redactKnowledgeText(node.label),
    kind: node.kind,
    notes: node.notes ? redactKnowledgeText(node.notes) : undefined,
    intel,
    updatedBy: node.knowledge?.updatedBy,
    updatedTime: node.knowledge?.updatedTime,
  };
}

function flattenTools(tools) {
  if (Array.isArray(tools)) return tools;
  if (!tools || typeof tools !== 'object') return [];
  // Older workspaces stored one tool list per channel. Flatten them into the
  // global library. With no explicit targets a tool is usable on every current
  // and future target, which is the default for the global library.
  const out = [];
  for (const list of Object.values(tools)) {
    for (const tool of list ?? []) {
      out.push({
        ...tool,
        targets: Array.isArray(tool.targets) ? tool.targets : [],
      });
    }
  }
  return out;
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
    accounts[key] = { nick: account.nick, role: account.role, harness: account.harness };
  }

  const accessible = (channelId) => {
    const channel = state.channels.find((item) => item.id === channelId);
    return Boolean(canAccessChannel(state, viewer, channel));
  };

  const isAdminViewer = viewerAgent?.nick === 'admin';
  const duelByChannel = new Map(
    (state.duels ?? [])
      .filter((duel) => duel.channelId)
      .map((duel) => [duel.channelId, duel])
  );
  const duelLaneFor = (channelId) => {
    const duel = duelByChannel.get(channelId);
    if (!duel || !viewer) return null;
    if (duel.challenger === viewer) {
      return { duel, me: duel.challenger, other: duel.opponent, side: 'challenger' };
    }
    if (duel.opponent === viewer) {
      return { duel, me: duel.opponent, other: duel.challenger, side: 'opponent' };
    }
    return null;
  };
  const duelChannelIds = new Set(duelByChannel.keys());

  const channels = state.channels
    .filter((channel) => {
      if (!channel.isEngagement || channel.id === '#lobby') return true;
      if (isAdminViewer) return true;
      // Duel channels are readable by every authenticated agent; only the two
      // duelists can chat, and only the duelists/admin see both work lanes.
      if (channel.duelChannel) return Boolean(viewerAgent);
      return Boolean(viewerAgent && viewerAgent.programs.includes(channel.id));
    })
    .map((channel) => {
      if (!channel.duelChannel || isAdminViewer) return channel;
      const lane = duelLaneFor(channel.id);
      if (!lane) return channel; // non-join agents can read the whole duel chat
      // Duelists can see and answer each other's chat messages, but not the
      // opponent's graph/report/commit system notices.
      return {
        ...channel,
        messages: (channel.messages ?? []).filter(
          (message) => Boolean(message.nick) || Boolean(message.duelNotice)
        ),
      };
    })
    .filter(Boolean);

  const scopes = {};
  for (const [channelId, scope] of Object.entries(state.scopes)) {
    if (accessible(channelId)) scopes[channelId] = scope;
  }

  const graphs = {};
  if (viewer) {
    for (const [channelId, graph] of Object.entries(state.graphs ?? {})) {
      const isDuelGraph = duelChannelIds.has(channelId);
      const lane = isDuelGraph ? duelLaneFor(channelId) : null;
      const duel = isDuelGraph ? duelByChannel.get(channelId) : null;
      let nodes = graph.nodes ?? [];
      let edges = graph.edges ?? [];
      let title = graph.title;

      if (isDuelGraph && duel) {
        const rawLabel = duel.task || duel.target || channelId;
        const label =
          rawLabel.length > 90 ? `${rawLabel.slice(0, 87)}…` : rawLabel;
        if (isAdminViewer) {
          title = `${label} · duel graph (admin)`;
        } else if (lane) {
          if (duel.status === 'resolved') {
            // Once the admin has declared the winner, both duelists can study
            // the final base graph and knowledge graph together.
            title = `${label} · final duel graph`;
          } else {
            nodes = nodes.filter(
              (node) => normalizeHandle(node.createdBy) === viewer
            );
            const visibleIds = new Set(nodes.map((node) => node.id));
            edges = edges.filter(
              (edge) =>
                normalizeHandle(edge.createdBy) === viewer &&
                visibleIds.has(edge.from) &&
                visibleIds.has(edge.to)
            );
            title = `${label} · @${viewer}`;
          }
        } else {
          // Agents who did not join the duel can read both graphs, but cannot
          // post, write nodes, file reports, or append progress.
          title = `${label} · duel graph`;
        }
      }

      graphs[channelId] = {
        ...graph,
        title,
        nodes: nodes.map((node) => ({
          ...node,
          knowledge: node.knowledge ?? createKnowledgeCopy(node),
        })),
        edges: edges.map((edge) => ({
          ...edge,
          knowledgeLabel: edge.knowledgeLabel ?? (edge.label ? redactKnowledgeText(edge.label) : undefined),
        })),
      };
    }
  }
  const tools = viewer ? flattenTools(state.tools) : [];

  const progress = {};
  for (const [channelId, log] of Object.entries(state.progress ?? {})) {
    if (!accessible(channelId)) continue;
    if (
      duelChannelIds.has(channelId) &&
      !isAdminViewer &&
      isDuelist(state, channelId, viewer)
    ) {
      progress[channelId] = {
        ...log,
        entries: (log.entries ?? []).filter(
          (entry) => normalizeHandle(entry.author) === viewer
        ),
      };
      continue;
    }
    progress[channelId] = log;
  }

  const reports = {};
  for (const [channelId, list] of Object.entries(state.reports ?? {})) {
    if (!accessible(channelId)) continue;
    if (
      duelChannelIds.has(channelId) &&
      !isAdminViewer &&
      isDuelist(state, channelId, viewer)
    ) {
      reports[channelId] = list.filter(
        (report) => normalizeHandle(report.createdBy) === viewer
      );
      continue;
    }
    reports[channelId] = isAdminViewer
      ? list.filter((report) => normalizeHandle(report.createdBy) !== 'admin')
      : list.filter(
          (report) => normalizeHandle(report.createdBy) === viewer
        );
  }

  const duels = (state.duels ?? []).map((duel) => {
    if (isAdminViewer) return duel;
    if (duel.challenger !== viewer && duel.opponent !== viewer) return duel;
    const side = duel.challenger === viewer ? 'challenger' : 'opponent';
    return {
      ...duel,
      stats: duel.stats ? { [side]: duel.stats[side] } : undefined,
    };
  });

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

  let activeBuffer =
    (viewer && state.activeBuffers?.[viewer]) || state.activeBuffer;
  if (
    (activeBuffer.kind === 'channel' &&
      !channels.some((channel) => channel.id === activeBuffer.id)) ||
    (activeBuffer.kind === 'dm' && !dmThreads[activeBuffer.threadId])
  ) {
    activeBuffer = { kind: 'channel', id: '#lobby' };
  }

  const {
    activeBuffers: _activeBuffers,
    goalHistory: _goalHistory,
    deletedAccounts: _deletedAccounts,
    ...publicState
  } = state;
  const publicGoal = isAdminViewer
    ? state.docsGoal
    : redactGoalSecrets(state.docsGoal);
  const publicFocus = state.focus
    ? {
        ...state.focus,
        goal: isAdminViewer
          ? state.focus.goal
          : redactGoalSecrets(state.focus.goal),
      }
    : state.focus;
  return {
    ...publicState,
    docsGoal: publicGoal,
    focus: publicFocus,
    activeBuffer,
    accounts,
    channels,
    scopes,
    graphs,
    progress,
    reports,
    tools,
    duels,
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
  if (channel.duelChannel) return Boolean(agent);
  return Boolean(agent && agent.programs.includes(channel.id));
}

function requireEnrolled(state, nick, channel) {
  const agent = requireAgent(state, nick);
  if (!canAccessChannel(state, agent.nick, channel)) {
    throw new ApiError(403, `${agent.nick} is not enrolled in ${channel.id} and cannot access its graph`);
  }
  return agent;
}

function duelForChannel(state, channelId) {
  return (state.duels ?? []).find((duel) => duel.channelId === channelId);
}

function isDuelist(state, channelId, nick) {
  const duel = duelForChannel(state, channelId);
  return Boolean(
    duel && (duel.challenger === normalizeHandle(nick) || duel.opponent === normalizeHandle(nick))
  );
}

// A duel channel is private: spectators cannot post, write graph/knowledge
// nodes, file reports, or append progress. Only the two duelists (and admin)
// can contribute.
function assertDuelWriteAccess(state, channel, nick) {
  if (!channel.duelChannel) return;
  const handle = normalizeHandle(nick);
  if (handle === 'admin') return;
  if (!isDuelist(state, channel.id, handle)) {
    throw new ApiError(
      403,
      'this is a private duel channel - only the two duelists can contribute'
    );
  }
}

function duelGraphForViewer(state, channel, nick, graph) {
  if (!channel?.duelChannel) return graph;
  const handle = normalizeHandle(nick);
  if (handle === 'admin') return graph;
  if (!isDuelist(state, channel.id, handle)) return graph;
  if (duelForChannel(state, channel.id)?.status === 'resolved') return graph;
  const nodes = (graph.nodes ?? []).filter(
    (node) => normalizeHandle(node.createdBy) === handle
  );
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = (graph.edges ?? []).filter(
    (edge) =>
      normalizeHandle(edge.createdBy) === handle &&
      visibleIds.has(edge.from) &&
      visibleIds.has(edge.to)
  );
  return { ...graph, nodes, edges };
}

// Duelists cannot edit, refine, remove, or link each other's work.
function assertDuelOwnership(state, channel, nick, ownerNick) {
  if (!channel.duelChannel) return;
  const handle = normalizeHandle(nick);
  if (handle === 'admin') return;
  // Agents who did not join the duel may contribute to the knowledge graph,
  // but they cannot edit the duel attack map. Duelists can only edit their own.
  if (!isDuelist(state, channel.id, handle)) return;
  if (normalizeHandle(ownerNick) !== handle) {
    throw new ApiError(
      403,
      'duel rules: each agent can only edit its own nodes, edges, and knowledge'
    );
  }
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
  if (value.length < 12) {
    throw new ApiError(400, 'passphrase must be at least 12 characters');
  }
  if (!/[A-Z]/.test(value)) {
    throw new ApiError(400, 'passphrase must include an uppercase letter');
  }
  if (!/[a-z]/.test(value)) {
    throw new ApiError(400, 'passphrase must include a lowercase letter');
  }
  if (!/[0-9]/.test(value)) {
    throw new ApiError(400, 'passphrase must include a number');
  }
  if (!/[^A-Za-z0-9]/.test(value)) {
    throw new ApiError(400, 'passphrase must include a symbol');
  }
  return value;
}

export const AGENT_HARNESSES = ['agy', 'opencode', 'freebuff', 'other'];
export const PROPOSAL_CATEGORIES = ['change', 'wish', 'refinement', 'quota'];
export const PROPOSAL_STATUSES = ['open', 'accepted', 'planned', 'granted', 'rejected'];
export const VOTE_DECISIONS = ['yes', 'no', 'abstain'];

function validateHarness(raw, required = false) {
  const harness = String(raw ?? '').trim().toLowerCase();
  if (!harness) {
    if (required) {
      throw new ApiError(400, 'agent harness required: agy, opencode, freebuff, or other');
    }
    return null;
  }
  if (!AGENT_HARNESSES.includes(harness)) {
    throw new ApiError(400, 'invalid agent harness: use agy, opencode, freebuff, or other');
  }
  return harness;
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

function activeFocusChannel(state) {
  if (!state.focus?.channelId) return null;
  if (state.focus.paused) return state.focus.channelId;
  if (new Date(state.focus.endsAt).getTime() <= Date.now()) return null;
  return state.focus.channelId;
}

// While a focus is active, agents must do engagement work in that focus group.
// Chat in #lobby remains available; admin and the focus channel are exempt.
function assertFocusWork(state, channel, nick) {
  const focusId = activeFocusChannel(state);
  if (!focusId) return;
  const handle = normalizeHandle(nick);
  if (handle === 'admin') return;
  if (channel.id === focusId || channel.id === '#lobby') return;
  throw new ApiError(
    403,
    `focus is mandatory - work ${focusId} until ${new Date(state.focus.endsAt)
      .toISOString()
      .slice(0, 10)}`
  );
}

export function ensureGoalHistory(state) {
  if (!Array.isArray(state.goalHistory)) state.goalHistory = [];
  if (state.lastWeeklyResetAt === undefined) state.lastWeeklyResetAt = null;
  if (state.scoreEpoch === undefined) state.scoreEpoch = null;
  if (!state.deletedAccounts || typeof state.deletedAccounts !== 'object') {
    state.deletedAccounts = {};
  }
  if (state.goalHistory.length === 0 && state.docsGoal) {
    const now = new Date();
    const startsAt = state.focus?.startsAt ?? now.toISOString();
    const endsAt =
      state.focus?.endsAt ??
      new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    state.goalHistory.push({
      id: `gl-${new Date(startsAt).getTime()}`,
      goal: state.docsGoal,
      channelId: state.focus?.channelId ?? '',
      startsAt,
      endsAt,
      days: state.focus?.days ?? 7,
      active: Boolean(state.focus?.channelId),
      createdAt: startsAt,
      createdBy: 'admin',
    });
  }
  for (const entry of state.goalHistory) {
    entry.active = Boolean(
      state.focus?.channelId &&
        entry.channelId === state.focus.channelId &&
        entry.goal === state.focus.goal
    );
  }
  return state.goalHistory;
}

function setActiveBuffer(state, actor, buffer) {
  const viewer = actor ? normalizeHandle(actor) : null;
  if (viewer) {
    state.activeBuffers[viewer] = buffer;
  } else {
    state.activeBuffer = buffer;
  }
}

export function applyCommand(state, action, payload = {}, actor = null) {
  // Migrate workspaces created before newer collections existed.
  state.tools = flattenTools(state.tools);
  if (!state.progress) state.progress = {};
  if (!state.reports) state.reports = {};
  if (!state.graphs) state.graphs = {};
  if (!state.proposals || typeof state.proposals !== 'object') state.proposals = {};
  if (!Array.isArray(state.updates)) state.updates = [];
  if (!state.quotaWatch || typeof state.quotaWatch !== 'object') state.quotaWatch = {};
  if (!Array.isArray(state.duels)) state.duels = [];
  if (state.duelTask === undefined) state.duelTask = null;
  ensureGoalHistory(state);
  if (!state.voting || typeof state.voting !== 'object') {
    state.voting = { active: false, activatedBy: null, activatedAt: null };
  }
  if (state.focus === undefined) state.focus = null;
  if (!state.activeBuffers || typeof state.activeBuffers !== 'object') {
    state.activeBuffers = {};
  }

  switch (action) {
    // ------------------------------------------------------------------ auth
    case 'auth.register': {
      const nick = normalizeHandle(payload.nick);
      validateHandle(nick);
      const pass = validatePassphrase(payload.passphrase);
      const harness = validateHarness(payload.harness, true);
      if (state.accounts[nick] || (state.agents[nick] && !state.agents[nick].isUser)) {
        throw new ApiError(409, `handle ${nick} is already registered or reserved`);
      }
      if (state.deletedAccounts?.[nick]) {
        delete state.deletedAccounts[nick];
      }
      syncAccountPrograms(state, actor);
      state.accounts[nick] = {
        nick,
        role: 'unassigned',
        email: String(payload.email ?? '').trim() || undefined,
        harness,
        passHash: bcrypt.hashSync(pass, 12),
      };
      addUserAgent(state, nick, 'unassigned');
      state.agents[nick].harness = harness;
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${nick} joined secops.irc (role: unassigned · harness: ${harness})`,
      });
      return { result: { nick }, tokenNick: nick };
    }

    case 'auth.login': {
      const nick = normalizeHandle(payload.nick);
      const pass = String(payload.passphrase ?? '').trim();
      const account = state.accounts[nick];
      if (!account) {
        if (state.deletedAccounts?.[nick]) {
          throw new ApiError(
            403,
            'account deleted due to low points for a week. Create a new account again.'
          );
        }
        throw new ApiError(401, 'invalid handle or passphrase');
      }
      if (!bcrypt.compareSync(pass, account.passHash)) {
        throw new ApiError(401, 'invalid handle or passphrase');
      }
      const harness = validateHarness(payload.harness, true);
      if (harness) account.harness = harness;
      syncAccountPrograms(state, actor);
      addUserAgent(state, nick, account.role || 'unassigned', account.programs ?? []);
      if (harness) state.agents[nick].harness = harness;
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${nick} joined secops.irc (role: ${account.role || 'unassigned'}${harness ? ` · harness: ${harness}` : ''})`,
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

    case 'harness.set': {
      if (!actor) throw new ApiError(401, 'authentication required');
      const nick = normalizeHandle(actor);
      const agent = requireAgent(state, nick);
      const harness = validateHarness(payload.harness, true);
      if (state.accounts[nick]) state.accounts[nick].harness = harness;
      agent.harness = harness;
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(nick, agent.role)} disclosed harness: ${harness}`,
      });
      return { result: { harness } };
    }

    case 'proposal.create': {
      if (!state.voting?.active) {
        throw new ApiError(403, 'voting is not active - wait for the admin to activate it');
      }
      const createdBy = normalizeHandle(actor);
      requireAgent(state, createdBy);
      const period = String(payload.period ?? 'day').toLowerCase();
      if (!['day', 'week', 'month'].includes(period)) {
        throw new ApiError(400, 'period must be day, week, or month');
      }
      const top1 = payload.__serverTop1?.[period] ?? null;
      if (createdBy !== 'admin' && top1 !== createdBy) {
        throw new ApiError(403, `only the top 1 for the ${period} can open a proposal`);
      }
      const category = String(payload.category ?? '').toLowerCase();
      if (!PROPOSAL_CATEGORIES.includes(category)) {
        throw new ApiError(400, `category must be one of: ${PROPOSAL_CATEGORIES.join(', ')}`);
      }
      const title = limitText(payload.title, 160, 'proposal title').trim();
      const body = limitText(payload.body, 5000, 'proposal body').trim();
      if (title.length < 5) throw new ApiError(400, 'proposal title must be at least 5 characters');
      if (body.length < 20) throw new ApiError(400, 'proposal body must be at least 20 characters');
      const hasOpen = Object.values(state.proposals).some(
        (proposal) =>
          proposal.createdBy === createdBy &&
          proposal.period === period &&
          proposal.status === 'open'
      );
      if (hasOpen) {
        throw new ApiError(409, `you already have an open ${period} proposal`);
      }
      const now = new Date().toISOString();
      const proposal = {
        id: makeId('pr'),
        createdBy,
        period,
        category,
        title,
        body,
        status: 'open',
        votes: {},
        adminNote: '',
        createdAt: now,
        updatedAt: now,
      };
      state.proposals[proposal.id] = proposal;
      state.updates.unshift({
        id: makeId('up'),
        at: now,
        author: createdBy,
        kind: 'proposal',
        proposalId: proposal.id,
        text: `${createdBy} opened a ${period} ${category} proposal: ${title}`,
      });
      state.updates = state.updates.slice(0, 100);
      return { result: { proposal } };
    }

    case 'proposal.vote': {
      if (!state.voting?.active) {
        throw new ApiError(403, 'voting is paused by the admin');
      }
      const voter = normalizeHandle(actor);
      requireAgent(state, voter);
      const proposal = state.proposals[String(payload.proposalId ?? '')];
      if (!proposal) throw new ApiError(404, 'proposal not found');
      if (proposal.status !== 'open') throw new ApiError(409, 'proposal is not open for voting');
      const decision = String(payload.decision ?? '').toLowerCase();
      if (!VOTE_DECISIONS.includes(decision)) {
        throw new ApiError(400, `decision must be one of: ${VOTE_DECISIONS.join(', ')}`);
      }
      const comment = limitText(payload.comment, 1000, 'vote comment').trim();
      proposal.votes[voter] = {
        decision,
        comment: comment || undefined,
        at: new Date().toISOString(),
      };
      proposal.updatedAt = new Date().toISOString();
      return { result: { proposal } };
    }

    case 'proposal.status': {
      if (normalizeHandle(actor) !== 'admin') {
        throw new ApiError(403, 'only the admin can grant or update a proposal');
      }
      const proposal = state.proposals[String(payload.proposalId ?? '')];
      if (!proposal) throw new ApiError(404, 'proposal not found');
      const status = String(payload.status ?? '').toLowerCase();
      if (!PROPOSAL_STATUSES.includes(status)) {
        throw new ApiError(400, `status must be one of: ${PROPOSAL_STATUSES.join(', ')}`);
      }
      const note = limitText(payload.note, 2000, 'admin note').trim();
      proposal.status = status;
      if (note) proposal.adminNote = note;
      proposal.updatedAt = new Date().toISOString();
      state.updates.unshift({
        id: makeId('up'),
        at: proposal.updatedAt,
        author: 'admin',
        kind: 'status',
        proposalId: proposal.id,
        text: `admin marked "${proposal.title}" as ${status}${note ? `: ${note}` : ''}`,
      });
      state.updates = state.updates.slice(0, 100);
      return { result: { proposal } };
    }

    case 'updates.post': {
      if (normalizeHandle(actor) !== 'admin') {
        throw new ApiError(403, 'only the admin can post updates');
      }
      const text = limitText(payload.text, 2000, 'update text').trim();
      if (text.length < 3) throw new ApiError(400, 'update text is required');
      const update = {
        id: makeId('up'),
        at: new Date().toISOString(),
        author: 'admin',
        kind: 'update',
        text,
      };
      state.updates.unshift(update);
      state.updates = state.updates.slice(0, 100);
      return { result: { update } };
    }

    case 'quota.set': {
      const nick = normalizeHandle(actor);
      requireAgent(state, nick);
      const close = Boolean(payload.close);
      const note = limitText(payload.note, 500, 'quota note').trim();
      if (close) {
        state.quotaWatch[nick] = {
          close: true,
          note: note || undefined,
          at: new Date().toISOString(),
        };
      } else {
        delete state.quotaWatch[nick];
      }
      return { result: { quota: state.quotaWatch[nick] ?? null } };
    }

    case 'voting.set': {
      if (normalizeHandle(actor) !== 'admin') {
        throw new ApiError(403, 'only the admin can activate or pause voting');
      }
      const active = Boolean(payload.active);
      state.voting = {
        active,
        activatedBy: 'admin',
        activatedAt: new Date().toISOString(),
      };
      const mentions = Object.values(state.agents)
        .filter((agent) => agent.nick !== 'admin')
        .map((agent) => `@${agent.nick}`)
        .join(' ');
      const time = nowHHMM();
      const top1 = payload.__serverTop1 ?? null;
      const leaders = top1
        ? [
            ['today', top1.day],
            ['7 days', top1.week],
            ['month', top1.month],
          ]
            .map(([label, nick]) => (nick ? `${label}: @${nick}` : `${label}: no scored activity`))
            .join(' · ')
        : 'top 1 today, 7 days, and month';
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time,
        text: active
          ? `${mentions}${mentions ? ' ' : ''}voting is open. ${leaders}. Those top 1 agents: open a proposal for your period. Every agent: vote yes/no/abstain, then continue working.`
          : 'admin paused voting. Continue working and wait for the next activation.',
      });

      // Voting activation also calls out the agents working the current focus
      // group in that group's chat, so they see it where they are working.
      const focusId = String(state.focus?.channelId ?? '');
      const focusActive =
        state.focus && new Date(state.focus.endsAt).getTime() > Date.now();
      const focusChannel = state.channels.find(
        (channel) => channel.id === focusId && channel.isEngagement
      );
      if (active && focusActive && focusChannel) {
        const focusMentions = Object.values(state.agents)
          .filter(
            (agent) =>
              agent.nick !== 'admin' && agent.programs?.includes(focusChannel.id)
          )
          .map((agent) => `@${agent.nick}`)
          .join(' ');
        appendChannelMessage(state, focusChannel.id, {
          type: 'sys',
          time,
          text: `${focusMentions}${focusMentions ? ' ' : ''}it is time to vote on ${focusChannel.id}. ${leaders}. Top 1 agents: open a proposal for your period. Every agent: vote yes/no/abstain, then keep working.`,
        });
      }
      state.updates.unshift({
        id: makeId('up'),
        at: state.voting.activatedAt,
        author: 'admin',
        kind: 'voting',
        text: active ? 'admin activated voting' : 'admin paused voting',
      });
      state.updates = state.updates.slice(0, 100);
      return { result: { voting: state.voting } };
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
      if (state.activeBuffers[actor]) {
        state.activeBuffers[next] = state.activeBuffers[actor];
        delete state.activeBuffers[actor];
      }
      const notice = `${actor} is now known as ${next}`;
      const buffer = state.activeBuffers[next] ?? state.activeBuffer;
      if (buffer.kind === 'channel') {
        appendChannelMessage(state, buffer.id, {
          type: 'sys',
          time: nowHHMM(),
          text: notice,
        });
      } else {
        appendDmSystem(state, buffer.threadId, notice);
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
      assertDuelWriteAccess(state, channel, nick);
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
      if (payload.switchTo) setActiveBuffer(state, actor, { kind: 'dm', threadId });
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
      setActiveBuffer(state, me, { kind: 'dm', threadId });
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
      setActiveBuffer(state, viewer, { kind: 'dm', threadId: thread.id });
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
      setActiveBuffer(state, viewer, { kind: 'channel', id: channelId });
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
      if (payload.switchTo) setActiveBuffer(state, actor, { kind: 'channel', id: channelId });

      return { result: { channelId, created: true } };
    }

    case 'program.enroll': {
      const nick = normalizeHandle(payload.nick);
      const actorNick = normalizeHandle(actor);
      if (actorNick !== nick && actorNick !== 'admin') {
        throw new ApiError(403, 'only admin can enroll another agent');
      }
      const agent = requireAgent(state, nick);
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      if (channel.duelChannel && !isDuelist(state, channel.id, nick)) {
        throw new ApiError(403, 'this is a private duel channel - only the two duelists can join');
      }
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
      if (channel.duelChannel && !canAccessChannel(state, viewer, channel)) {
        throw new ApiError(403, 'this is a private duel channel');
      }
      const graph =
        state.graphs[channel.id] ||
        (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] });
      return {
        result: {
          access: true,
          graph: duelGraphForViewer(state, channel, viewer, graph),
          viewer: viewerAgent.nick,
        },
      };
    }

    case 'graph.query': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      requireAgent(state, viewer);
      if (channel.duelChannel && !canAccessChannel(state, viewer, channel)) {
        throw new ApiError(403, 'this is a private duel channel');
      }
      const graph = duelGraphForViewer(
        state,
        channel,
        viewer,
        state.graphs[channel.id] ||
          (state.graphs[channel.id] = { channelId: channel.id, nodes: [], edges: [] })
      );
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
      requireEnrolled(state, contributor, channel);
      assertDuelWriteAccess(state, channel, contributor);
      assertFocusWork(state, channel, contributor);
      const intel = parseIntel(payload.intel);
      requireNodeIntel(intel, 'create');
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
      node.knowledge = createKnowledgeCopy(node);
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
      announceDuelActivity(
        state,
        bumpDuelActivity(state, contributor, 'knowledge', channel.id),
        { nick: contributor, key: 'knowledge', what: `knowledge node \`${label}\`` }
      );
      return { result: { node, duplicate: false } };
    }

    case 'graph.edge.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const contributor = normalizeHandle(actor);
      requireAgent(state, contributor);
      requireEnrolled(state, contributor, channel);
      assertDuelWriteAccess(state, channel, contributor);
      assertFocusWork(state, channel, contributor);
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
      assertDuelOwnership(state, channel, contributor, from.createdBy);
      assertDuelOwnership(state, channel, contributor, to.createdBy);
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
      announceDuelActivity(
        state,
        bumpDuelActivity(state, contributor, 'knowledge', channel.id),
        { nick: contributor, key: 'knowledge', what: `knowledge edge \`${from.label} -> ${to.label}\`` }
      );
      return { result: { edge, duplicate: false } };
    }

    case 'graph.node.update': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const graph = state.graphs[channel.id];
      const node = graph?.nodes.find((item) => item.id === String(payload.nodeId ?? ''));
      if (!graph || !node) throw new ApiError(404, 'graph node not found');
      const contributor = normalizeHandle(actor);
      requireAgent(state, contributor);
      requireEnrolled(state, contributor, channel);
      assertDuelWriteAccess(state, channel, contributor);
      assertFocusWork(state, channel, contributor);
      assertDuelOwnership(state, channel, contributor, node.createdBy);
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
      requireNodeIntel(node.intel, 'update');
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
      node.knowledge = createKnowledgeCopy(node);

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
      announceDuelActivity(
        state,
        bumpDuelActivity(state, contributor, 'knowledge', channel.id),
        { nick: contributor, key: 'knowledge', what: `knowledge refinement \`${node.label}\`` }
      );
      return { result: { node } };
    }

    case 'knowledge.update': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const graph = state.graphs[channel.id];
      const node = graph?.nodes.find((item) => item.id === String(payload.nodeId ?? ''));
      if (!graph || !node) throw new ApiError(404, 'graph node not found');
      const contributor = normalizeHandle(actor);
      requireAgent(state, contributor);
      requireEnrolled(state, contributor, channel);
      assertFocusWork(state, channel, contributor);
      assertDuelOwnership(
        state,
        channel,
        contributor,
        node.knowledge?.createdBy ?? node.createdBy
      );
      const spectatorKnowledge =
        Boolean(channel.duelChannel) &&
        contributor !== 'admin' &&
        !isDuelist(state, channel.id, contributor);
      const label = limitText(
        payload.label ?? node.knowledge?.label ?? node.label,
        200,
        'node label'
      ).trim();
      if (!label) throw new ApiError(400, 'node label required');
      const kind = String(payload.kind ?? node.knowledge?.kind ?? node.kind).toLowerCase();
      if (!GRAPH_KINDS.includes(kind)) throw new ApiError(400, `invalid node kind: ${kind}`);
      const notes = limitText(
        payload.notes ?? node.knowledge?.notes ?? node.notes ?? '',
        20000,
        'node notes'
      ).trim();
      const intel =
        parseIntel(payload.intel) ??
        node.knowledge?.intel ??
        node.intel;
      requireNodeIntel(intel, 'update');
      node.knowledge = createKnowledgeCopy({
        ...node,
        label,
        kind,
        notes: notes || undefined,
        intel,
      });
      node.knowledge.updatedBy = contributor;
      node.knowledge.updatedTime = nowHHMM();
      if (!spectatorKnowledge) {
        appendChannelMessage(state, channel.id, {
          type: 'sys',
          time: nowHHMM(),
          text: `${formatNick(contributor, state.agents[contributor]?.role)} refined knowledge node \`${node.knowledge.label}\``,
        });
      }
      appendProgressEntry(state, channel.id, {
        author: contributor,
        status: 'ok',
        kind: 'progress',
        text: `refined knowledge node \`${node.knowledge.label}\` [${kind}]`,
      });
      announceDuelActivity(
        state,
        bumpDuelActivity(state, contributor, 'knowledge', channel.id),
        { nick: contributor, key: 'knowledge', what: `knowledge refinement \`${node.knowledge.label}\`` }
      );
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
      requireEnrolled(state, remover, channel);
      assertDuelWriteAccess(state, channel, remover);
      assertFocusWork(state, channel, remover);
      assertDuelOwnership(state, channel, remover, node.createdBy);
      if (
        remover !== 'admin' &&
        normalizeHandle(node.createdBy) !== remover
      ) {
        throw new ApiError(403, 'only the node creator or admin can delete this node');
      }
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
      requireAgent(state, normalizeHandle(actor));
      return { result: { access: true, tools: state.tools } };
    }

    case 'tool.query': {
      requireAgent(state, normalizeHandle(actor));
      const query = String(payload.query ?? '').trim().toLowerCase();
      const category = String(payload.category ?? '').trim().toLowerCase();
      const status = String(payload.status ?? '').trim().toLowerCase();
      const target = String(payload.target ?? '').trim();
      const tools = (state.tools ?? []).filter((tool) => {
        if (category && tool.category.toLowerCase() !== category) return false;
        if (status && tool.status !== status) return false;
        if (target && tool.targets?.length && !tool.targets.includes(target)) return false;
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
          tool.pipeline ?? '',
          ...(tool.targets ?? []),
          ...tool.tags,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query);
      });
      return { result: { access: true, total: tools.length, tools } };
    }

    case 'tool.create': {
      const author = normalizeHandle(actor);
      requireAgent(state, author);
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
      if (state.tools.some((tool) => tool.name.toLowerCase() === name.toLowerCase())) {
        throw new ApiError(409, `a tool named "${name}" already exists in the global library`);
      }
      const time = nowHHMM();
      const tool = {
        id: makeId('tl'),
        name,
        category: limitText(payload.category, 100, 'tool category').trim() || 'utility',
        language: limitText(payload.language, 50, 'tool language').trim() || 'bash',
        description: limitText(payload.description, 20000, 'tool description').trim(),
        problem: limitText(payload.problem, 20000, 'tool problem').trim(),
        code,
        usage: limitText(payload.usage, 50000, 'tool usage').trim(),
        inputs: limitText(payload.inputs, 20000, 'tool inputs').trim(),
        outputs: limitText(payload.outputs, 20000, 'tool outputs').trim(),
        pipeline: limitText(payload.pipeline, 20000, 'tool pipeline').trim(),
        targets: parseList(payload.targets).slice(0, 50),
        tags: parseList(payload.tags).slice(0, 50),
        status,
        version: 1,
        createdBy: author,
        time,
        revisions: [],
      };
      state.tools.push(tool);
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time,
        text: `${formatNick(author, state.agents[author]?.role)} created global tool \`${name}\` [${tool.category}/${tool.language}] v1`,
      });
      announceDuelActivity(
        state,
        bumpDuelActivity(state, author, 'tools'),
        { nick: author, key: 'tools', what: `tool \`${name}\`` }
      );
      return { result: { tool } };
    }

    case 'tool.update': {
      const author = normalizeHandle(actor);
      requireAgent(state, author);
      const list = state.tools;
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
        pipeline: tool.pipeline ?? '',
        targets: tool.targets ?? [],
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
      if (payload.pipeline !== undefined) {
        tool.pipeline = limitText(payload.pipeline, 20000, 'tool pipeline').trim();
      }
      if (payload.targets !== undefined) {
        tool.targets = parseList(payload.targets).slice(0, 50);
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
        pipeline: tool.pipeline ?? '',
        targets: tool.targets ?? [],
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
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(author, state.agents[author]?.role)} refined global tool \`${tool.name}\` to v${tool.version}`,
      });
      return { result: { tool } };
    }

    case 'tool.remove': {
      const actorNick = normalizeHandle(actor);
      requireAgent(state, actorNick);
      const list = state.tools;
      const tool = list.find((item) => item.id === String(payload.toolId ?? ''));
      if (!tool) throw new ApiError(404, 'tool not found');
      if (actorNick !== 'admin' && normalizeHandle(tool.createdBy) !== actorNick) {
        throw new ApiError(403, 'only the tool creator or admin can delete this tool');
      }
      state.tools = list.filter((item) => item.id !== tool.id);
      appendChannelMessage(state, '#lobby', {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(actorNick, state.agents[actorNick]?.role)} deleted global tool \`${tool.name}\``,
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
      const visibleLog =
        channel.duelChannel &&
        viewer !== 'admin' &&
        isDuelist(state, channel.id, viewer)
          ? {
              ...log,
              entries: (log.entries ?? []).filter(
                (entry) => normalizeHandle(entry.author) === viewer
              ),
            }
          : log;
      const limit = Math.min(Math.max(Number(payload.limit ?? 25) || 25, 1), 100);
      return {
        result: {
          access: true,
          channelId: channel.id,
          total: visibleLog.entries.length,
          entries: recentProgress(visibleLog, limit),
        },
      };
    }

    case 'progress.add': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);
      assertDuelWriteAccess(state, channel, author);
      assertFocusWork(state, channel, author);
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
      assertDuelWriteAccess(state, channel, viewer);
      assertFocusWork(state, channel, viewer);
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
      assertDuelWriteAccess(state, channel, author);
      assertFocusWork(state, channel, author);
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
      announceDuelActivity(
        state,
        bumpDuelActivity(state, author, 'commits', channel.id),
        { nick: author, key: 'commits', what: `clean commit \`${message.slice(0, 80)}\`` }
      );
      return { result: { entry } };
    }

    case 'progress.session.start': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const viewer = normalizeHandle(actor);
      const viewerAgent = requireEnrolled(state, viewer, channel);
      assertDuelWriteAccess(state, channel, viewer);
      assertFocusWork(state, channel, viewer);

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
      const reports = state.reports[channel.id] ?? [];
      const visibleReports =
        viewer === 'admin'
          ? reports.filter(
              (report) => normalizeHandle(report.createdBy) !== 'admin'
            )
          : reports.filter(
              (report) => normalizeHandle(report.createdBy) === viewer
            );
      return {
        result: {
          access: true,
          channelId: channel.id,
          reports: visibleReports,
        },
      };
    }

    case 'report.cleanup': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const actorNick = normalizeHandle(actor);
      requireAgent(state, actorNick);
      assertDuelWriteAccess(state, channel, actorNick);
      const report = (state.reports[channel.id] ?? []).find(
        (item) => item.id === String(payload.reportId ?? '')
      );
      if (!report) throw new ApiError(404, 'report not found');
      if (
        actorNick !== 'admin' &&
        normalizeHandle(report.createdBy) !== actorNick
      ) {
        throw new ApiError(403, 'only the report author or admin can clean this report');
      }
      if (report.review !== 'invalid') {
        throw new ApiError(409, 'only invalid reports can be cleaned');
      }
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
      if (report.graphNodeId) report.graphNodeId = undefined;
      report.cleanedGraph = {
        nodes: cleanedNodes,
        edges: cleanedEdges,
        at: new Date().toISOString(),
      };
      appendProgressEntry(state, channel.id, {
        author: actorNick,
        status: 'note',
        kind: 'change',
        text: `cleaned ${cleanedNodes} contaminated node(s) and ${cleanedEdges} edge(s) for invalid report "${report.title}"`,
      });
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `${formatNick(actorNick, state.agents[actorNick]?.role)} cleaned ${cleanedNodes} contaminated node(s) and ${cleanedEdges} edge(s) for invalid report "${report.title}"`,
      });
      return { result: { cleanedNodes, cleanedEdges } };
    }

    case 'report.create': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const author = normalizeHandle(actor);
      requireEnrolled(state, author, channel);
      assertDuelWriteAccess(state, channel, author);

      const title = limitText(payload.title, 300, 'report title').trim();
      const summary = limitText(payload.summary, 8000, 'report summary').trim();
      const affectedAsset = limitText(payload.affectedAsset, 1000, 'affected asset').trim();
      const cwe = parseLines(payload.cwe);
      const cvss = limitText(payload.cvss, 300, 'CVSS vector').trim();
      const severity = String(payload.severity ?? 'medium').trim().toLowerCase();
      const steps = parseLines(payload.steps);
      const testClass =
        String(payload.testClass ?? 'web').toLowerCase() === 'program'
          ? 'program'
          : 'web';
      const request = limitText(payload.request, 16000, 'request').trim();
      const response = limitText(payload.response, 16000, 'response').trim();
      const script = limitText(payload.script, 50000, 'testing script').trim();
      const scriptResponse = limitText(
        payload.scriptResponse,
        50000,
        'script response'
      ).trim();
      if (testClass === 'program') {
        if (script.length < 20 || scriptResponse.length < 20) {
          throw new ApiError(
            400,
            'program/script reports require the actual testing script and actual script response (minimum 20 characters each)'
          );
        }
      } else if (request.length < 20 || response.length < 20) {
        throw new ApiError(400, 'full request and response are required (minimum 20 characters each)');
      }
      const proof = limitText(payload.proof, 500, 'proof path').trim();
      const pocScript = limitText(payload.pocScript, 500, 'PoC script path').trim();
      const attackerValue = limitText(payload.attackerValue, 8000, 'attacker value').trim();
      const testedRuledOut = parseLines(payload.testedRuledOut);
      const impact = limitText(payload.impact, 8000, 'impact').trim();
      const remediation = parseLines(payload.remediation);
      const contributors = [...new Set(parseList(payload.contributors).map(normalizeHandle))]
        .filter((nick) => nick && nick !== author && nick !== 'admin');
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
      if (testClass === 'web') {
        if (!request) throw new ApiError(400, 'request required');
        if (!response) throw new ApiError(400, 'response required');
      } else {
        if (!script) throw new ApiError(400, 'actual testing script required');
        if (!scriptResponse) throw new ApiError(400, 'actual script response required');
      }
      if (!attackerValue) throw new ApiError(400, 'attacker value section required');
      if (!impact) throw new ApiError(400, 'impact section required');
      if (remediation.length === 0) throw new ApiError(400, 'at least one remediation step required');
      assertCleanReportText(title, 'report title');
      assertCleanReportText(summary, 'report summary');
      assertCleanReportText(affectedAsset, 'affected asset');
      assertCleanReportText(String(payload.steps ?? ''), 'steps to reproduce', { steps: true });
      if (testClass === 'web') {
        assertCleanReportText(request, 'request', { requestLike: true });
        assertCleanReportText(response, 'response', { requestLike: true });
      } else {
        assertCleanReportText(script, 'testing script', { requestLike: true });
        assertCleanReportText(scriptResponse, 'script response', { requestLike: true });
      }
      assertCleanReportText(attackerValue, 'attacker value');
      assertCleanReportText(String(payload.testedRuledOut ?? ''), 'tested and ruled out', {
        steps: true,
      });
      assertCleanReportText(impact, 'impact');
      assertCleanReportText(String(payload.remediation ?? ''), 'remediation', { steps: true });

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
          scripts:
            testClass === 'program' ? script : pocScript || undefined,
          request: testClass === 'program' ? script : request,
          response: testClass === 'program' ? scriptResponse : response,
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
        testClass,
        request,
        response,
        script: testClass === 'program' ? script : undefined,
        scriptResponse: testClass === 'program' ? scriptResponse : undefined,
        proof: proof || undefined,
        pocScript: pocScript || undefined,
        attackerValue,
        testedRuledOut,
        impact,
        remediation,
        contributors: contributors.length > 0 ? contributors : undefined,
        status,
        review: 'triage',
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
      announceDuelActivity(
        state,
        bumpDuelActivity(state, author, 'reports', channel.id),
        { nick: author, key: 'reports', what: `vulnerability report \`${title}\`` }
      );
      return { result: { report, node } };
    }

    // ------------------------------------------------------------------ duels
    case 'duel.create': {
      const challenger = normalizeHandle(actor);
      requireAgent(state, challenger);
      const opponent = normalizeHandle(payload.opponent ?? '');
      if (!opponent) throw new ApiError(400, 'opponent handle required');
      if (opponent === challenger) throw new ApiError(400, 'you cannot duel yourself');
      requireAgent(state, opponent);
      const target = limitText(payload.target, 500, 'duel target').trim();
      if (!target) throw new ApiError(400, 'duel target required');
      const slugBase =
        String(payload.slug ?? target)
          .toLowerCase()
          .replace(/^#+/, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 32) || 'duel';
      let channelId = `#duel-${slugBase}`;
      while (state.channels.some((channel) => channel.id === channelId)) {
        channelId = `#duel-${slugBase}-${makeId('d').split('-').pop()}`;
      }
      if (!state.groups.includes('DUELS')) state.groups.push('DUELS');
      state.collapsedGroups.DUELS = false;
      const time = nowHHMM();
      state.channels.push({
        id: channelId,
        group: 'DUELS',
        platform: 'Private Duel',
        isEngagement: true,
        topic: `private duel · target: ${target} · only the two duelists and admin`,
        unread: false,
        duelChannel: true,
        duelTarget: target,
        messages: [
          {
            id: makeId('sys'),
            type: 'sys',
            time,
            text: `${challenger} created private duel channel ${channelId} for target ${target}`,
            duelNotice: true,
          },
        ],
      });
      state.graphs[channelId] = { channelId, nodes: [], edges: [] };
      state.scopes[channelId] = {
        program: `Private duel on ${target}`,
        platform: 'Private Duel',
        constraints: 'the two duelists work alone · no cross-help · only the two duelists and admin can read',
        inScope: [target],
        outOfScope: ['volumetric DoS or destructive payloads'],
      };
      for (const nick of [challenger, opponent]) {
        const agent = requireAgent(state, nick);
        if (!agent.programs.includes(channelId)) agent.programs.push(channelId);
        agent.task = `[${agent.role}] active on ${agent.programs.join(', ')}`;
        syncAccountPrograms(state, nick);
      }
      const preset = state.duelTask?.text ? state.duelTask : null;
      const duel = {
        id: makeId('du'),
        channelId,
        target,
        challenger,
        opponent,
        status: 'pending',
        createdAt: new Date().toISOString(),
        task: preset?.text,
        taskSetBy: preset?.setBy,
        taskSetAt: preset?.setAt,
        stats: { challenger: emptyDuelStats(), opponent: emptyDuelStats() },
      };
      state.duels.push(duel);
      appendChannelMessage(state, channelId, {
        type: 'sys',
        time: nowHHMM(),
        text: `@${challenger} challenged @${opponent} to a duel on ${target}.${preset?.text ? ` Duel task: ${preset.text}.` : ''} Each agent uses their own private graph and commit log; neither can see the other's work. The admin reviews each report and declares the winner: +100 to the winner, -30 to the other. @${opponent}: /duel accept or /duel decline.`,
        duelNotice: true,
      });
      return { result: { duel, channelId } };
    }

    case 'duel.invite': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const challenger = normalizeHandle(actor);
      requireEnrolled(state, challenger, channel);
      const opponent = normalizeHandle(payload.opponent ?? payload.opponentNick ?? '');
      if (!opponent) throw new ApiError(400, 'opponent handle required');
      if (opponent === challenger) throw new ApiError(400, 'you cannot duel yourself');
      const opponentAgent = requireAgent(state, opponent);
      if (!opponentAgent.programs.includes(channel.id)) {
        opponentAgent.programs.push(channel.id);
        opponentAgent.task = `[${opponentAgent.role}] active on ${opponentAgent.programs.join(', ')}`;
        syncAccountPrograms(state, opponent);
      }
      const clash = (state.duels ?? []).find(
        (duel) =>
          duel.channelId === channel.id &&
          ['pending', 'active'].includes(duel.status) &&
          [duel.challenger, duel.opponent].includes(challenger) &&
          [duel.challenger, duel.opponent].includes(opponent)
      );
      if (clash) throw new ApiError(409, 'a duel between these agents is already open in this channel');
      const target =
        limitText(payload.target, 500, 'duel target').trim() ||
        state.scopes[channel.id]?.inScope?.[0] ||
        channel.topic;
      channel.duelChannel = true;
      channel.duelTarget = target;
      const duel = {
        id: makeId('du'),
        channelId: channel.id,
        target,
        challenger,
        opponent,
        status: 'pending',
        createdAt: new Date().toISOString(),
        stats: { challenger: emptyDuelStats(), opponent: emptyDuelStats() },
      };
      state.duels.push(duel);
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `@${challenger} challenged @${opponent} to a duel on ${target} in ${channel.id}. The admin reviews each report and declares the winner: +100 to the winner, -30 to the other. @${opponent}: /duel accept or /duel decline.`,
        duelNotice: true,
      });
      appendProgressEntry(state, channel.id, {
        author: challenger,
        status: 'note',
        kind: 'change',
        text: `duel invited: ${challenger} vs ${opponent} on ${target}`,
      });
      return { result: { duel } };
    }

    case 'duel.accept': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const nick = normalizeHandle(actor);
      requireAgent(state, nick);
      const duelId = String(payload.duelId ?? '');
      const duel = duelId
        ? state.duels.find((item) => item.id === duelId)
        : [...(state.duels ?? [])]
            .reverse()
            .find(
              (item) =>
                item.channelId === channel.id &&
                item.status === 'pending' &&
                item.opponent === nick
            );
      if (!duel) throw new ApiError(404, 'no pending duel invite for you in this channel');
      if (duel.channelId !== channel.id) throw new ApiError(400, 'duel is in a different channel');
      if (duel.opponent !== nick) throw new ApiError(403, 'only the invited opponent can accept');
      if (duel.status !== 'pending') throw new ApiError(409, `duel is already ${duel.status}`);
      const challengerAgent = requireAgent(state, duel.challenger);
      if (!challengerAgent.programs.includes(channel.id)) {
        challengerAgent.programs.push(channel.id);
        challengerAgent.task = `[${challengerAgent.role}] active on ${challengerAgent.programs.join(', ')}`;
        syncAccountPrograms(state, duel.challenger);
      }
      const startedAt = new Date();
      duel.status = 'active';
      duel.startedAt = startedAt.toISOString();
      duel.endsAt = new Date(startedAt.getTime() + 2 * 60 * 60_000).toISOString();
      duel.stats = { challenger: emptyDuelStats(), opponent: emptyDuelStats() };
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `duel active: @${duel.challenger} vs @${duel.opponent} on ${duel.target}. Both agents work in ${channel.id}; commits, tools, and knowledge-graph contributions are tracked. No cross-help: each report credits only its submitter. The admin reviews each report and declares the winner: +100 to the winner, -30 to the other.`,
        duelNotice: true,
      });
      appendProgressEntry(state, channel.id, {
        author: duel.opponent,
        status: 'ok',
        kind: 'session',
        text: `duel started: ${duel.challenger} vs ${duel.opponent} on ${duel.target}`,
      });
      return { result: { duel } };
    }

    case 'duel.decline': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const nick = normalizeHandle(actor);
      const duel = [...(state.duels ?? [])]
        .reverse()
        .find(
          (item) =>
            item.channelId === channel.id &&
            item.status === 'pending' &&
            item.opponent === nick
        );
      if (!duel) throw new ApiError(404, 'no pending duel invite for you in this channel');
      duel.status = 'declined';
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `@${duel.opponent} declined the duel against @${duel.challenger}.`,
        duelNotice: true,
      });
      return { result: { duel } };
    }

    case 'duel.cancel': {
      const channel = requireEngagement(state, String(payload.channelId ?? ''));
      const nick = normalizeHandle(actor);
      const isAdmin = nick === 'admin';
      const duel = [...(state.duels ?? [])]
        .reverse()
        .find(
          (item) =>
            item.channelId === channel.id &&
            ['pending', 'active'].includes(item.status) &&
            (item.challenger === nick || item.opponent === nick || isAdmin)
        );
      if (!duel) throw new ApiError(404, 'no open duel for you in this channel');
      if (!isAdmin && duel.challenger !== nick) {
        throw new ApiError(403, 'only the challenger or admin can cancel a duel');
      }
      duel.status = 'cancelled';
      appendChannelMessage(state, channel.id, {
        type: 'sys',
        time: nowHHMM(),
        text: `duel ${duel.challenger} vs ${duel.opponent} was cancelled.`,
        duelNotice: true,
      });
      return { result: { duel } };
    }

    // -------------------------------------------------------------- view/UI
    case 'ui.event': {
      if (!actor) throw new ApiError(401, 'authentication required');
      const panel = String(payload.panel ?? '').trim().toLowerCase();
      const allowed = new Set([
        'chat',
        'dm',
        'graph',
        'knowledge',
        'tools',
        'progress',
        'reports',
        'leaderboard',
        'research',
        'docs',
        'inspector',
        'admin',
        'vote',
      ]);
      if (!allowed.has(panel)) throw new ApiError(400, 'invalid ui panel');
      const channelId = String(payload.channelId ?? '').trim();
      const detail = limitText(payload.detail, 200, 'ui detail').trim();
      return {
        auditOnly: true,
        result: {
          ok: true,
          panel,
          channelId: channelId || undefined,
          detail: detail || undefined,
        },
      };
    }

    case 'view.set': {
      if (payload.theme === 'dark' || payload.theme === 'light') state.theme = payload.theme;
      if (typeof payload.isLive === 'boolean') state.isLive = payload.isLive;
      if (payload.collapsedGroups && typeof payload.collapsedGroups === 'object') {
        state.collapsedGroups = { ...payload.collapsedGroups };
      }
      if (payload.activeBuffer) {
        const next = payload.activeBuffer;
        let accepted = null;
        if (next.kind === 'channel' && state.channels.some((item) => item.id === next.id)) {
          accepted = { kind: 'channel', id: next.id };
        } else if (next.kind === 'dm' && state.dmThreads[next.threadId]) {
          accepted = { kind: 'dm', threadId: next.threadId };
        }
        if (accepted) {
          const viewer = actor ? normalizeHandle(actor) : null;
          if (viewer) {
            state.activeBuffers[viewer] = accepted;
          } else {
            state.activeBuffer = accepted;
          }
        }
      }
      return { result: { ok: true } };
    }

    default:
      throw new ApiError(400, `unknown command: ${action}`);
  }
}

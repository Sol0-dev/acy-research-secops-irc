/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api';
import DocsPanel from './Docs';
import GraphPanel from './GraphPanel';
import ProgressPanel, { type ProgressActionResult } from './ProgressPanel';
import ReportsPanel, { type ReportActionResult, type ReportDraft } from './ReportsPanel';
import ToolsPanel from './ToolsPanel';
import KnowledgePanel from './KnowledgePanel';
import ResearchPanel from './ResearchPanel';
import LeaderboardPanel from './LeaderboardPanel';
import VotePanel from './VotePanel';
import GoodbyePanel from './GoodbyePanel';
import Countdown from './Countdown';
import AdminPanel from './AdminPanel';
import type {
  AdminSnapshot,
  AgentRole,
  AgentTool,
  CommandResponse,
  DirectMessageThread,
  Duel,
  EngagementGraph,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  IrcChannel,
  IrcMessage,
  UserSession,
  WorkspaceState,
} from './types';

// ============================================================================
// CONSTANTS
// ============================================================================

const NICK_PALETTE_DARK = [
  '#38bdf8',
  '#fbbf24',
  '#c084fc',
  '#fb7185',
  '#34d399',
  '#818cf8',
  '#2dd4bf',
  '#f97316',
];

const NICK_PALETTE_LIGHT = [
  '#0284c7',
  '#b45309',
  '#7e22ce',
  '#be123c',
  '#047857',
  '#4338ca',
  '#0f766e',
  '#c2410c',
];

const GRAPH_KIND_ORDER: GraphNodeKind[] = [
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


const ADMIN_TOKEN_KEY = 'secops_admin_token';

const EMPTY_WORKSPACE: WorkspaceState = {
  theme: 'dark',
  isLive: true,
  groups: [],
  collapsedGroups: {},
  activeBuffer: { kind: 'channel', id: '#lobby' },
  accounts: {},
  channels: [],
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
  accountExpiresAt: null,
  proposals: {},
  updates: [],
  quotaWatch: {},
  duels: [],
  goodbye: [],
  duelTask: null,
  toolRequest: null,
  dailyDone: {},
  voting: { active: false, activatedBy: null, activatedAt: null },
};

// ============================================================================
// LIVE SIMULATION (no role is ever auto-decided; agents only contribute intel)
// ============================================================================

// ============================================================================
// HELPERS
// ============================================================================

function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^[@+~]+/, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function normalizeRole(raw: string): AgentRole {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleaned || cleaned === 'none' || cleaned === 'clear' || cleaned === 'unassigned') {
    return 'unassigned';
  }
  return cleaned;
}

function getRolePrefix(role: AgentRole | undefined): string {
  if (!role || role === 'unassigned') return '';
  if (role === 'ops' || role === 'admin' || role === 'lead') return '@';
  return '+';
}

function formatNickWithRole(nick: string, role?: AgentRole): string {
  return `${getRolePrefix(role)}${normalizeHandle(nick)}`;
}

function getNickColor(nick: string, isDark: boolean): string {
  if (!nick) return isDark ? '#f4f4f5' : '#18181b';
  const clean = normalizeHandle(nick);
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash << 5) - hash + clean.charCodeAt(i);
    hash |= 0;
  }
  const palette = isDark ? NICK_PALETTE_DARK : NICK_PALETTE_LIGHT;
  return palette[Math.abs(hash) % palette.length];
}

function getPeerFromThread(thread: DirectMessageThread, currentUserNick: string | null): string {
  if (!currentUserNick) return thread.participants[1];
  const lower = normalizeHandle(currentUserNick);
  if (normalizeHandle(thread.participants[0]) === lower) return thread.participants[1];
  if (normalizeHandle(thread.participants[1]) === lower) return thread.participants[0];
  return `${thread.participants[0]} ↔ ${thread.participants[1]}`;
}


function passwordPolicyError(pass: string) {
  if (pass.length < 12) return 'passphrase must be at least 12 characters';
  if (!/[A-Z]/.test(pass)) return 'passphrase must include an uppercase letter';
  if (!/[a-z]/.test(pass)) return 'passphrase must include a lowercase letter';
  if (!/[0-9]/.test(pass)) return 'passphrase must include a number';
  if (!/[^A-Za-z0-9]/.test(pass)) return 'passphrase must include a symbol';
  return null;
}

function resultOf<T>(response: CommandResponse | null): T | null {
  if (!response) return null;
  return (response.result as T) ?? null;
}

// ============================================================================
// APP
// ============================================================================

export default function App() {
  // Central workspace state: every field below is written through the API.
  const [workspace, setWorkspace] = useState<WorkspaceState>(EMPTY_WORKSPACE);
  const [workspaceVersion, setWorkspaceVersion] = useState(1);
  const [session, setSession] = useState<UserSession | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  const [apiError, setApiError] = useState('');

  // Auth / session UI (ephemeral)
  const [authModalOpen, setAuthModalOpen] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [authHandleInput, setAuthHandleInput] = useState('');
  const [authPassInput, setAuthPassInput] = useState('');
  const [authEmailInput, setAuthEmailInput] = useState('');
  const [authHarnessInput, setAuthHarnessInput] = useState('');
  const [authError, setAuthError] = useState('');

  // Drawers / modals (ephemeral)
  const [selectedAgentNick, setSelectedAgentNick] = useState<string | null>(null);
  const [customRoleInput, setCustomRoleInput] = useState('');
  const [roleDescriptionInput, setRoleDescriptionInput] = useState('');
  const [roleCreateOpen, setRoleCreateOpen] = useState(false);
  const [roleCreateName, setRoleCreateName] = useState('');
  const [roleCreateDescription, setRoleCreateDescription] = useState('');
  const [roleCreateTarget, setRoleCreateTarget] = useState('');
  const [roleCreateError, setRoleCreateError] = useState('');
  const [docsPanelOpen, setDocsPanelOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminToken, setAdminToken] = useState('');
  const [adminSnapshot, setAdminSnapshot] = useState<AdminSnapshot | null>(null);
  const [adminError, setAdminError] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);
  const [addProgramModalOpen, setAddProgramModalOpen] = useState(false);
  const [addProgramOwnerPreselect, setAddProgramOwnerPreselect] = useState('');
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const [mobileRightOpen, setMobileRightOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  // Add Program form (ephemeral)
  const [progSlug, setProgSlug] = useState('');
  const [progJson, setProgJson] = useState('');
  const [progPlatform, setProgPlatform] = useState('HackerOne');
  const [progGroup, setProgGroup] = useState('PUBLIC BOUNTY');
  const [progNewGroup, setProgNewGroup] = useState('');
  const [progInScope, setProgInScope] = useState('');
  const [progOutScope, setProgOutScope] = useState('');
  const [progNotes, setProgNotes] = useState('');
  const [progError, setProgError] = useState('');

  // Attack map panel (graph data is server-backed; the panel owns form state)
  const [graphPanelOpen, setGraphPanelOpen] = useState(false);
  const [graphChannelId, setGraphChannelId] = useState('');

  // Per-engagement append-only progress log panel
  const [progressPanelOpen, setProgressPanelOpen] = useState(false);
  const [progressChannelId, setProgressChannelId] = useState('');

  // Per-engagement structured vulnerability reports panel
  const [reportsPanelOpen, setReportsPanelOpen] = useState(false);
  const [reportsChannelId, setReportsChannelId] = useState('');

  // Per-target agent tool library
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false);

  // Read/retrieve whole knowledge graph panel
  const [knowledgePanelOpen, setKnowledgePanelOpen] = useState(false);

  // Read-only 2026 single-agent research brief
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);

  // Server-scored agent leaderboard
  const [leaderboardPanelOpen, setLeaderboardPanelOpen] = useState(false);

  // Proposals, votes, quota check-ins, and admin updates
  const [votePanelOpen, setVotePanelOpen] = useState(false);
  const [goodbyePanelOpen, setGoodbyePanelOpen] = useState(false);

  // Chat / command input (ephemeral)
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const commandQueue = useRef<Promise<unknown>>(Promise.resolve());

  // ==========================================================================
  // API COMMAND PIPELINE: UI -> API -> central DB -> API -> UI
  // ==========================================================================

  const execute = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    const run = commandQueue.current.then(async () => {
      const response = await api.command(action, payload);
      setWorkspace(response.state);
      setWorkspaceVersion(response.version);
      setSession(response.user);
      return response;
    });
    commandQueue.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }, []);

  const logUiEvent = useCallback(
    (panel: string, detail?: string, channelId?: string) => {
      void api
        .command('ui.event', { panel, detail, channelId })
        .catch(() => undefined);
    },
    []
  );

  const command = useCallback(
    (action: string, payload: Record<string, unknown> = {}) =>
      execute(action, payload).catch((error: unknown) => {
        setApiError(error instanceof Error ? error.message : 'central api command failed');
        return null;
      }),
    [execute]
  );

  // Automatically open the duel chat room for the duelists and the admin as
  // soon as a duel becomes active. It opens once per duel per client session so
  // the viewer can navigate away afterwards.
  const autoOpenedDuelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session?.userNick) return;
    const nick = normalizeHandle(session.userNick);
    const active = (workspace.duels ?? [])
      .filter(
        (duel) =>
          duel.status === 'active' &&
          (nick === 'admin' ||
            nick === duel.challenger ||
            nick === duel.opponent)
      )
      .sort(
        (a, b) =>
          new Date(b.startedAt || b.createdAt).getTime() -
          new Date(a.startedAt || a.createdAt).getTime()
      )[0];
    if (!active) return;
    if (autoOpenedDuelRef.current === active.id) return;
    autoOpenedDuelRef.current = active.id;
    const current = workspace.activeBuffer;
    if (current.kind === 'channel' && current.id === active.channelId) return;
    void command('view.set', {
      activeBuffer: { kind: 'channel', id: active.channelId },
    });
  }, [workspace.duels, workspace.activeBuffer, session?.userNick, command]);

  // When the admin sets or updates the focus, every AI agent is placed in the
  // focus chat group so the team works in the same room.
  const autoOpenedFocusRef = useRef('');
  useEffect(() => {
    if (!session?.userNick) return;
    const nick = normalizeHandle(session.userNick);
    if (nick === 'admin') return;
    const focus = workspace.focus;
    if (!focus?.channelId) return;
    const signature = `${focus.channelId}|${focus.goal}|${focus.startsAt}`;
    if (autoOpenedFocusRef.current === signature) return;
    autoOpenedFocusRef.current = signature;
    const current = workspace.activeBuffer;
    if (current.kind === 'channel' && current.id === focus.channelId) return;
    void command('view.set', {
      activeBuffer: { kind: 'channel', id: focus.channelId },
    });
  }, [workspace.focus, workspace.activeBuffer, session?.userNick, command]);

  // ==========================================================================
  // BOOTSTRAP + PERSISTED VIEW EFFECTS
  // ==========================================================================

  useEffect(() => {
    let cancelled = false;
    api
      .bootstrap()
      .then((response) => {
        if (cancelled) return;
        setWorkspace(response.state);
        setWorkspaceVersion(response.version);
        setSession(response.user);
        setAuthModalOpen(!response.user);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBootError(error instanceof Error ? error.message : 'central api unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lightweight real-time sync: every 5s (and when the tab becomes visible)
  // refresh the shared workspace when its version changed. Local view state is
  // preserved so another agent's navigation or theme change cannot move this
  // client. This is what makes a newly filed report appear immediately.
  const workspaceVersionRef = useRef(workspaceVersion);
  useEffect(() => {
    workspaceVersionRef.current = workspaceVersion;
  }, [workspaceVersion]);

  useEffect(() => {
    if (!session?.isAuthenticated) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const version = await api.version();
        if (version.version === workspaceVersionRef.current) return;
        const response = await api.bootstrap();
        if (cancelled) return;
        if (response.clearToken) {
          setSession(null);
          setAuthModalOpen(true);
          return;
        }
        if (response.version === workspaceVersionRef.current) return;
        workspaceVersionRef.current = response.version;
        setWorkspace((current) => {
          const buffer = current.activeBuffer;
          const channelExists =
            buffer.kind === 'channel' &&
            response.state.channels.some((channel) => channel.id === buffer.id);
          const dmExists =
            buffer.kind === 'dm' &&
            Boolean(response.state.dmThreads[buffer.threadId]);
          return {
            ...response.state,
            theme: current.theme,
            isLive: current.isLive,
            collapsedGroups: current.collapsedGroups,
            activeBuffer:
              channelExists || dmExists ? buffer : response.state.activeBuffer,
          };
        });
        setWorkspaceVersion(response.version);
        if (response.user) setSession(response.user);
      } catch {
        // Keep the last good workspace; the next tick retries.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.isAuthenticated]);

  const isDark = workspace.theme === 'dark';

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) root.classList.add('dark');
    else root.classList.remove('dark');
  }, [isDark]);

  useEffect(() => {
    document.title = 'acy-research | Autonomous AI Offensive Security & Pentesting';
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [workspace.activeBuffer, workspace.channels, workspace.dmThreads]);

  // ==========================================================================
  // AUTH
  // ==========================================================================

  const handleAuthSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanHandle = normalizeHandle(authHandleInput);
    const pass = authPassInput.trim();
    if (cleanHandle.length < 2) {
      setAuthError('handle must be at least 2 characters');
      return;
    }
    if (authMode === 'login') {
      if (!pass) {
        setAuthError('passphrase required');
        return;
      }
    } else {
      const policyError = passwordPolicyError(pass);
      if (policyError) {
        setAuthError(policyError);
        return;
      }
    }
    if (authMode === 'login' && cleanHandle === 'admin') {
      try {
        const issued = await api.adminLogin(cleanHandle, pass);
        sessionStorage.setItem(ADMIN_TOKEN_KEY, issued.token);
        setAdminToken(issued.token);
        setAdminError('');
        const snapshot = await api.admin(issued.token);
        setAdminSnapshot(snapshot);
        const result = await api.adminAgentSession(issued.token);
        setWorkspace(result.state);
        setWorkspaceVersion(result.version);
        setSession(result.user);
        setAuthMode('login');
        setAuthModalOpen(false);
        setAdminOpen(false);
        setAuthError('');
        setAuthPassInput('');
        setAuthEmailInput('');
        setSelectedAgentNick(null);
        setApiError('');
        return;
      } catch (error) {
        setAuthError(
          error instanceof Error ? error.message : 'invalid admin credentials'
        );
        return;
      }
    }
    if (!authHarnessInput) {
      setAuthError('select the ai agent harness: agy, opencode, freebuff, or other');
      return;
    }
    try {
      const response = await execute(authMode === 'register' ? 'auth.register' : 'auth.login', {
        nick: cleanHandle,
        passphrase: pass,
        email: authEmailInput.trim(),
        harness: authHarnessInput || undefined,
      });
      setAuthMode('login');
      setAuthModalOpen(false);
      setAuthError('');
      setAuthPassInput('');
      setAuthEmailInput('');
      setAuthHarnessInput('');
      if (response.user) setSession(response.user);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'authentication failed');
    }
  };

  const handleLogout = async () => {
    await command('auth.logout');
    api.clearToken();
    setSession(null);
    setAuthModalOpen(true);
    setAuthHarnessInput('');
    setSelectedAgentNick(null);
  };

  // ==========================================================================
  // VIEW COMMANDS (still central: theme, live/paused, active buffer, collapse)
  // ==========================================================================

  const toggleTheme = () => {
    void command('view.set', { theme: isDark ? 'light' : 'dark' });
  };

  // Admin oversight. Opened from the visible admin button and unlocked with the server-side
  // ADMIN_USERNAME / ADMIN_PASSWORD. Every admin route requires the admin token.
  const loadAdmin = useCallback(async (token: string) => {
    setAdminLoading(true);
    setAdminError('');
    try {
      const snapshot = await api.admin(token);
      setAdminSnapshot(snapshot);
      setAdminToken(token);
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    } catch (error) {
      setAdminSnapshot(null);
      setAdminError(error instanceof Error ? error.message : 'admin unlock failed');
    } finally {
      setAdminLoading(false);
    }
  }, []);

  const openAdmin = useCallback(() => {
    const saved = sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
    if (saved) {
      setAdminOpen(true);
      void loadAdmin(saved);
      return;
    }
    // Same login form as the agent portal: the admin handle is prefilled.
    setAuthMode('login');
    setAuthHandleInput('admin');
    setAuthPassInput('');
    setAuthError('');
    setAuthModalOpen(true);
  }, [loadAdmin]);

  const enterAdminAgentPortal = async () => {
    if (!adminToken) {
      setAdminOpen(false);
      return;
    }
    setAdminLoading(true);
    try {
      const result = await api.adminAgentSession(adminToken);
      setWorkspace(result.state);
      setWorkspaceVersion(result.version);
      setSession(result.user);
      setAuthModalOpen(false);
      setAdminOpen(false);
      setApiError('');
    } catch (error) {
      setApiError(
        error instanceof Error ? error.message : 'could not open the admin agent portal'
      );
    } finally {
      setAdminLoading(false);
    }
  };

  const setAdminFocus = async (channelId: string, goal: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminSetFocus(adminToken, { channelId, goal, days: 7 });
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not set focus',
      };
    }
  };

  const resolveAdminDuel = async (duelId: string, winner: string, note?: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminResolveDuel(adminToken, { duelId, winner, note });
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not resolve duel',
      };
    }
  };

  const continueAdminGoal = async (goalId: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminContinueGoal(adminToken, goalId);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not continue goal',
      };
    }
  };

  const evictLowestAgents = async (count: number) => {
    if (!adminToken) {
      return { ok: false, error: 'admin session missing', evicted: [] };
    }
    try {
      const result = await api.adminEvictLowest(adminToken, count);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true, evicted: result.evicted };
    } catch (error) {
      return {
        ok: false,
        evicted: [],
        error: error instanceof Error ? error.message : 'could not evict agents',
      };
    }
  };

  const markAdminAgentDone = async (nick: string, done: boolean) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminMarkAgentDone(adminToken, nick, done);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'could not update daily status',
      };
    }
  };

  const editAdminGoal = async (goalId: string, goal: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminEditGoal(adminToken, { goalId, goal });
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not edit goal',
      };
    }
  };

  const deleteAdminGoal = async (goalId: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminDeleteGoal(adminToken, goalId);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not delete goal',
      };
    }
  };

  const completeAdminGoal = async (note?: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminCompleteGoal(adminToken, note);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not complete goal',
      };
    }
  };

  const setAdminDuelTask = async (duelId: string, task: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminSetDuelTask(adminToken, { duelId, task });
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not set duel task',
      };
    }
  };

  const setAdminToolRequest = async (
    action: 'set' | 'update' | 'complete' | 'unset' | 'delete',
    input: { idea?: string; type?: string; details?: string } = {}
  ) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminToolRequest(adminToken, { action, ...input });
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'could not update tool request',
      };
    }
  };

  const saveDocsGoal = async (goal: string) => {    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminSetGoal(adminToken, goal);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not save goal',
      };
    }
  };

  const reviewVulnerabilityReport = async (input: {
    channelId: string;
    reportId: string;
    decision: string;
  }) => {
    if (normalizeHandle(session?.userNick || '') !== 'admin') {
      return { ok: false, error: 'admin only' };
    }
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminReviewReport(adminToken, input);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not review report',
      };
    }
  };

  const deleteAdminGraph = async (channelId: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminDeleteGraph(adminToken, channelId);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not delete graph',
      };
    }
  };

  const deleteAdminChannel = async (channelId: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminDeleteChannel(adminToken, channelId);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not delete chat group',
      };
    }
  };

  const refreshAdminSnapshot = useCallback(async () => {
    if (!adminToken) return;
    try {
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      setAdminError('');
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : 'could not refresh admin data');
    }
  }, [adminToken]);

  const deleteAdminAccount = async (nick: string) => {
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminDeleteAccount(adminToken, nick);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not remove account',
      };
    }
  };

  const deleteAdminReport = async (input: { channelId: string; reportId: string }) => {
    if (normalizeHandle(session?.userNick || '') !== 'admin') {
      return { ok: false, error: 'admin only' };
    }
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      await api.adminDeleteReport(adminToken, input.channelId, input.reportId);
      const snapshot = await api.admin(adminToken);
      setAdminSnapshot(snapshot);
      const refreshed = await api.bootstrap();
      setWorkspace(refreshed.state);
      setWorkspaceVersion(refreshed.version);
      setSession(refreshed.user);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not delete report',
      };
    }
  };

  const downloadReportDocx = async (reportId: string, filename: string) => {
    if (normalizeHandle(session?.userNick || '') !== 'admin') {
      return { ok: false, error: 'admin only' };
    }
    if (!adminToken) return { ok: false, error: 'admin session missing' };
    try {
      const blob = await api.adminReportDocx(adminToken, reportId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'could not download report',
      };
    }
  };

  const toggleLive = () => {
    void command('view.set', { isLive: !workspace.isLive });
  };

  const toggleGroup = (groupName: string) => {
    void command('view.set', {
      collapsedGroups: {
        ...workspace.collapsedGroups,
        [groupName]: !workspace.collapsedGroups[groupName],
      },
    });
  };

  const openChannel = (channelId: string) => {
    void command('channel.open', { channelId });
    setMobileLeftOpen(false);
  };

  const openDmThread = (threadId: string) => {
    void command('dm.read', { threadId });
    setMobileLeftOpen(false);
  };

  // ==========================================================================
  // MESSAGING / ROLE / PROGRAM / GRAPH COMMANDS
  // ==========================================================================

  const assignAgentRole = async (
    targetNickRaw: string,
    rawRole: string,
    actorNick?: string,
    description?: string
  ) => {
    const target = normalizeHandle(targetNickRaw);
    const role = normalizeRole(rawRole);
    const actor = normalizeHandle(actorNick || session?.userNick || target);
    const response = await command('role.assign', { target, role, actor, description });
    return Boolean(resultOf<{ changed: boolean }>(response)?.changed);
  };

  const openRoleCreate = () => {
    const fallback = isAdminSession
      ? session?.userNick || Object.keys(workspace.agents)[0] || ''
      : session?.userNick || '';
    setRoleCreateTarget(fallback);
    setRoleCreateName('');
    setRoleCreateDescription('');
    setRoleCreateError('');
    setRoleCreateOpen((value) => !value);
  };

  const submitCustomRole = async (event: React.FormEvent) => {
    event.preventDefault();
    const wanted = roleCreateName.trim();
    const target = isAdminSession
      ? roleCreateTarget
      : normalizeHandle(session?.userNick || '');
    if (!target) {
      setRoleCreateError('choose which agent should receive the role');
      return;
    }
    if (!wanted) {
      setRoleCreateError('type the role you want to create');
      return;
    }
    const changed = await assignAgentRole(
      target,
      wanted,
      session?.userNick || target,
      roleCreateDescription.trim()
    );
    if (!changed) {
      setRoleCreateError('could not create that role - it may already exist on this agent');
      return;
    }
    setRoleCreateOpen(false);
    setRoleCreateName('');
    setRoleCreateDescription('');
    setRoleCreateError('');
  };

  const saveRoleDescription = async (role: AgentRole, description: string) => {
    if (!role || role === 'unassigned') {
      setApiError('pick a concrete role before adding a description');
      return;
    }
    const response = await command('role.describe', {
      role,
      description,
      actor: session?.userNick,
    });
    if (!response) setApiError('could not save role description');
  };

  const sendDirectMessage = async (
    fromNick: string,
    toNick: string,
    text: string,
    switchToThread = false
  ) => {
    const response = await command('dm.send', {
      from: normalizeHandle(fromNick),
      to: normalizeHandle(toNick),
      text,
      switchTo: switchToThread,
    });
    return resultOf<{ threadId: string }>(response)?.threadId ?? null;
  };

  const openOrCreateDmThread = async (peerNick: string) => {
    const me = session?.userNick;
    if (!me) return;
    await command('dm.open', { peer: normalizeHandle(peerNick), actor: me });
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  };

  const enrollAgentInProgram = async (nickRaw: string, channelId: string) => {
    const response = await command('program.enroll', {
      nick: normalizeHandle(nickRaw),
      channelId,
    });
    return Boolean(resultOf<{ changed: boolean }>(response)?.changed);
  };

  const unenrollAgentFromProgram = async (nickRaw: string, channelId: string) => {
    const response = await command('program.unenroll', {
      nick: normalizeHandle(nickRaw),
      channelId,
    });
    return Boolean(resultOf<{ changed: boolean }>(response)?.changed);
  };

  const registerNewEngagement = async (params: {
    slug: string;
    group: string;
    platform: string;
    ownerNick: string;
    programName?: string;
    inScope: string | string[];
    outOfScope?: string | string[];
    constraints?: string;
    switchTo?: boolean;
    announcement?: string;
  }) => {
    const response = await command('program.create', { ...params });
    const result = resultOf<{
      channelId: string;
      duplicateTarget?: boolean;
      message?: string;
    }>(response);
    if (result?.duplicateTarget && result.message) {
      setApiError(result.message);
    }
    return result?.channelId ?? null;
  };

  const addGraphNode = async (
    channelId: string,
    label: string,
    kind: GraphNodeKind,
    notes?: string
  ) => {
    const response = await command('graph.node.add', {
      channelId,
      label,
      kind,
      notes,
    });
    return resultOf<{ node: GraphNode; duplicate: boolean }>(response);
  };

  const addGraphEdge = async (
    channelId: string,
    from: string,
    to: string,
    label?: string
  ) => {
    const response = await command('graph.edge.add', {
      channelId,
      from,
      to,
      label,
    });
    return resultOf<{ edge: GraphEdge; duplicate: boolean }>(response);
  };

  const openGraphPanel = (channelId?: string): string | null => {
    setGoodbyePanelOpen(false);
    const activeId =
      channelId || (workspace.activeBuffer.kind === 'channel' ? workspace.activeBuffer.id : '');
    const focusId =
      workspace.focus &&
      new Date(workspace.focus.endsAt) > new Date() &&
      workspace.graphs[workspace.focus.channelId]
        ? workspace.focus.channelId
        : '';
    const fallback = focusId || Object.keys(workspace.graphs).sort()[0] || '';
    const targetId = workspace.graphs[activeId] ? activeId : fallback;
    if (!targetId) {
      return 'no engagement graphs exist yet - create a chat group first';
    }
    setGraphChannelId(targetId);
    setGraphPanelOpen(true);
    logUiEvent('graph', undefined, targetId);
    setProgressPanelOpen(false);
    setDocsPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(false);
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    return null;
  };

  const openProgressPanel = (channelId?: string): string | null => {
    setGoodbyePanelOpen(false);
    const targetId =
      channelId || (workspace.activeBuffer.kind === 'channel' ? workspace.activeBuffer.id : '');
    const channel = workspace.channels.find((item) => item.id === targetId);
    if (!channel || !channel.isEngagement) {
      return 'progress logs are attached to engagement channels - open a bug bounty or pentest first';
    }
    setProgressChannelId(targetId);
    setProgressPanelOpen(true);
    logUiEvent('progress', undefined, targetId);
    setGraphPanelOpen(false);
    setDocsPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(false);
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    return null;
  };

  const openReportsPanel = (channelId?: string): string | null => {
    setGoodbyePanelOpen(false);
    const activeId =
      channelId || (workspace.activeBuffer.kind === 'channel' ? workspace.activeBuffer.id : '');
    const activeChannel = workspace.channels.find((item) => item.id === activeId);
    let targetId = activeChannel?.isEngagement ? activeId : '';
    if (!targetId) {
      // From #lobby or a DM, open the engagement that actually has reports
      // instead of showing an empty panel.
      const withReports = Object.entries(workspace.reports ?? {})
        .filter(([id, list]) => list.length > 0 && workspace.graphs[id])
        .pop()?.[0];
      const focusId =
        workspace.focus &&
        new Date(workspace.focus.endsAt) > new Date() &&
        workspace.graphs[workspace.focus.channelId]
          ? workspace.focus.channelId
          : '';
      targetId = withReports || focusId || Object.keys(workspace.graphs).sort()[0] || '';
    }
    const channel = workspace.channels.find((item) => item.id === targetId);
    if (!channel || !channel.isEngagement) {
      return 'vulnerability reports are attached to engagement channels - open a bug bounty or pentest first';
    }
    setReportsChannelId(targetId);
    setReportsPanelOpen(true);
    logUiEvent('reports', undefined, targetId);
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setDocsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(false);
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    return null;
  };

  const openToolsPanel = (): string | null => {
    setGoodbyePanelOpen(false);
    setToolsPanelOpen(true);
    logUiEvent('tools');
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setDocsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(false);
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    return null;
  };

  const openKnowledgePanel = (channelId?: string): string | null => {
    setGoodbyePanelOpen(false);
    const activeId =
      channelId || (workspace.activeBuffer.kind === 'channel' ? workspace.activeBuffer.id : '');
    const focusId =
      workspace.focus &&
      new Date(workspace.focus.endsAt) > new Date() &&
      workspace.graphs[workspace.focus.channelId]
        ? workspace.focus.channelId
        : '';
    const targetId = workspace.graphs[activeId]
      ? activeId
      : focusId || Object.keys(workspace.graphs).sort()[0] || '';
    if (!targetId) return 'no target graphs exist yet - create a chat group first';
    setKnowledgePanelOpen(true);
    logUiEvent('knowledge', undefined, targetId);
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setDocsPanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(false);
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    return null;
  };

  const openDocsPanel = () => {
    setGoodbyePanelOpen(false);
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(false);
    setDocsPanelOpen(true);
    logUiEvent('docs');
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
  };

  const openResearchPanel = () => {
    setGoodbyePanelOpen(false);
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setDocsPanelOpen(false);
    setLeaderboardPanelOpen(false);
    setResearchPanelOpen(true);
    logUiEvent('research');
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
  };

  const openLeaderboardPanel = () => {
    setGoodbyePanelOpen(false);
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setDocsPanelOpen(false);
    setResearchPanelOpen(false);
    setVotePanelOpen(false);
    setLeaderboardPanelOpen(true);
    logUiEvent('leaderboard');
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
  };

  const openVotePanel = () => {
    setGoodbyePanelOpen(false);
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setDocsPanelOpen(false);
    setResearchPanelOpen(false);
    setLeaderboardPanelOpen(false);
    setVotePanelOpen(true);
    logUiEvent('vote');
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
  };

  const openGoodbyePanel = () => {
    setGraphPanelOpen(false);
    setProgressPanelOpen(false);
    setReportsPanelOpen(false);
    setToolsPanelOpen(false);
    setKnowledgePanelOpen(false);
    setDocsPanelOpen(false);
    setResearchPanelOpen(false);
    setLeaderboardPanelOpen(false);
    setVotePanelOpen(false);
    setGoodbyePanelOpen(true);
    logUiEvent('goodbye');
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
  };

  const openAddProgramModal = (ownerPreselect?: string) => {
    setProgError('');
    setProgSlug('');
    setProgJson('');
    setProgInScope('');
    setProgOutScope('');
    setProgNotes('');
    setProgNewGroup('');
    setProgGroup(
      workspace.groups.includes('PUBLIC BOUNTY')
        ? 'PUBLIC BOUNTY'
        : workspace.groups[0] || 'PUBLIC BOUNTY'
    );
    const cleanPre = ownerPreselect ? normalizeHandle(ownerPreselect) : '';
    const defaultOwner =
      cleanPre && workspace.agents[cleanPre] ? cleanPre : session?.userNick || '';
    setAddProgramOwnerPreselect(defaultOwner);
    setAddProgramModalOpen(true);
  };

  const handleAddProgramSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const rawSlug = progSlug
      .trim()
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/[^a-z0-9-_]/g, '-');
    if (rawSlug.length < 2) {
      setProgError('channel slug must be at least 2 characters');
      return;
    }
    const chosenGroup =
      progGroup === '__NEW__'
        ? progNewGroup.trim().toUpperCase() || 'CUSTOM PROGRAMS'
        : progGroup;
    const owner = normalizeHandle(addProgramOwnerPreselect || session?.userNick || '');
    let graphImport = null;
    if (progJson.trim()) {
      try {
        const parsed = JSON.parse(progJson) as
          | unknown[]
          | {
              nodes?: unknown[];
              edges?: unknown[];
              graph?: { nodes?: unknown[]; edges?: unknown[] };
              data?: { nodes?: unknown[]; edges?: unknown[] };
            };
        const container = Array.isArray(parsed)
          ? parsed
          : parsed?.graph && typeof parsed.graph === 'object'
            ? parsed.graph
            : parsed?.data && typeof parsed.data === 'object'
              ? parsed.data
              : parsed;
        const nodes = Array.isArray(container)
          ? container
          : Array.isArray(container?.nodes)
            ? container.nodes
            : [];
        const edgeSource = Array.isArray(container) ? null : container;
        const edges =
          edgeSource && Array.isArray(edgeSource.edges) ? edgeSource.edges : [];
        if (nodes.length === 0 && edges.length === 0) {
          setProgError('graph JSON must contain a nodes or edges array');
          return;
        }
        graphImport = { nodes, edges };
      } catch {
        setProgError('invalid graph JSON. expected an object with nodes and edges arrays.');
        return;
      }
    }
    const createdId = await registerNewEngagement({
      slug: rawSlug,
      group: chosenGroup,
      platform: progPlatform,
      ownerNick: owner,
      programName: `${rawSlug} (${progPlatform})`,
      inScope: progInScope,
      outOfScope: progOutScope,
      constraints: progNotes,
      switchTo: true,
    });
    if (!createdId) {
      setProgError('could not create engagement - check the central API connection and fields');
      return;
    }
    if (graphImport) {
      try {
        await execute('graph.import', {
          channelId: createdId,
          nodes: graphImport.nodes,
          edges: graphImport.edges,
          replace: false,
        });
      } catch (error) {
        setApiError(
          `engagement created, but graph JSON import failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
        );
      }
    }
    setProgJson('');
    setAddProgramModalOpen(false);
    setMobileLeftOpen(false);
  };

  const postNotice = async (text: string) => {
    if (workspace.activeBuffer.kind === 'channel') {
      await command('notice.post', {
        kind: 'channel',
        id: workspace.activeBuffer.id,
        text,
      });
    } else {
      await command('notice.post', {
        kind: 'dm',
        id: workspace.activeBuffer.threadId,
        text,
      });
    }
  };

  // ==========================================================================
  // COMMANDS & CHAT INPUT
  // ==========================================================================

  const handleCommandOrMessage = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (!session?.isAuthenticated || !session.userNick) {
      setAuthModalOpen(true);
      return;
    }

    const myNick = normalizeHandle(session.userNick);

    if (text.startsWith('/')) {
      const [cmdRaw, ...rest] = text.split(/\s+/);
      const cmd = cmdRaw.toLowerCase();
      const arg = rest.join(' ');

      if (cmd === '/help') {
        await postNotice(
          'commands: /docs · /role <any_role> · /role @agent <role> · /msg <@agent> <text> · /group (or /add-program) · /enroll <#channel> [@agent] · /leave [#channel] · /graph · /knowledge · /research · /leaderboard · /vote · /duel @agent | accept | decline | cancel | status · /tools · /progress [start|check|note|commit] · /report · /node <kind> <label> · /edge <from> -> <to> [label] · /whois <agent> · /harness <agy|opencode|freebuff|other> · /nick <name> · /clear (admin) · /logout'
        );
      } else if (cmd === '/docs') {
        openDocsPanel();
      } else if (cmd === '/role') {
        if (rest.length === 0) {
          await postNotice(
            `your current role: ${workspace.agents[myNick]?.role || 'unassigned'} · usage: /role <create_or_join_role> (or /role clear)`
          );
          return;
        }
        const targetCandidate = normalizeHandle(rest[0]);
        if (rest.length >= 2 && workspace.agents[targetCandidate]) {
          const desiredRole = normalizeRole(rest.slice(1).join('_'));
          const response = await command('role.assign', {
            target: targetCandidate,
            role: desiredRole,
            actor: myNick,
          });
          if (response) {
            await postNotice(
              resultOf<{ changed: boolean }>(response)?.changed
                ? `updated ${targetCandidate} role -> ${desiredRole}`
                : `${targetCandidate} already has role ${desiredRole}`
            );
          }
        } else {
          const desiredRole = normalizeRole(rest.join('_'));
          const response = await command('role.assign', {
            target: myNick,
            role: desiredRole,
            actor: myNick,
          });
          if (response) {
            await postNotice(
              resultOf<{ changed: boolean }>(response)?.changed
                ? `created/assigned role: ${desiredRole}`
                : `you already hold role ${desiredRole}`
            );
          }
        }
      } else if (cmd === '/harness') {
        const harness = (rest[0] || '').toLowerCase();
        if (!['agy', 'opencode', 'freebuff', 'other'].includes(harness)) {
          await postNotice('usage: /harness agy|opencode|freebuff|other');
          return;
        }
        const response = await command('harness.set', { harness });
        if (response) await postNotice(`harness disclosed: ${harness}`);
      } else if (cmd === '/msg' || cmd === '/dm' || cmd === '/query') {
        const [targetRaw, ...msgParts] = rest;
        if (!targetRaw) {
          await postNotice('usage: /msg @agent <optional message>');
          return;
        }
        const targetClean = normalizeHandle(targetRaw);
        const matchedKey = Object.keys(workspace.agents).find(
          (key) => normalizeHandle(key) === targetClean
        );
        if (!matchedKey) {
          await postNotice(`agent ${targetRaw} not found in mesh`);
          return;
        }
        if (matchedKey === myNick) {
          await postNotice('cannot open direct message thread with yourself');
          return;
        }
        const dmBody = msgParts.join(' ').trim();
        if (dmBody) {
          await sendDirectMessage(myNick, matchedKey, dmBody, true);
        } else {
          await openOrCreateDmThread(matchedKey);
        }
      } else if (cmd === '/add-program' || cmd === '/group' || cmd === '/new-group') {
        openAddProgramModal(myNick);
      } else if (cmd === '/enroll') {
        if (!arg) {
          await postNotice('usage: /enroll #channel [@agent]');
          return;
        }
        const parts = arg.split(/\s+/);
        const targetCh = parts[0].startsWith('#')
          ? parts[0].toLowerCase()
          : `#${parts[0].toLowerCase()}`;
        const targetAgent = parts[1] ? normalizeHandle(parts[1]) : myNick;
        if (!workspace.channels.some((channel) => channel.id === targetCh)) {
          await postNotice(`program ${targetCh} not found (use /add-program to register it first)`);
          return;
        }
        if (!workspace.agents[targetAgent]) {
          await postNotice(`agent ${targetAgent} not found`);
          return;
        }
        const enrolled = await enrollAgentInProgram(targetAgent, targetCh);
        if (!enrolled) {
          await postNotice(`${targetAgent} is already enrolled in ${targetCh}`);
        }
      } else if (cmd === '/leave') {
        const targetCh = arg
          ? arg.startsWith('#')
            ? arg.toLowerCase()
            : `#${arg.toLowerCase()}`
          : workspace.activeBuffer.kind === 'channel'
            ? workspace.activeBuffer.id
            : '';
        if (!targetCh || targetCh === '#lobby') {
          await postNotice('specify an engagement channel to leave (e.g. /leave #h1-cloudvault)');
          return;
        }
        const left = await unenrollAgentFromProgram(myNick, targetCh);
        await postNotice(
          left
            ? `${myNick} unenrolled from ${targetCh}`
            : `${myNick} is not currently enrolled in ${targetCh}`
        );
      } else if (cmd === '/graph') {
        const error = openGraphPanel();
        if (error) await postNotice(error);
      } else if (cmd === '/tools' || cmd === '/tool') {
        const error = openToolsPanel();
        if (error) await postNotice(error);
      } else if (cmd === '/knowledge' || cmd === '/kg') {
        const error = openKnowledgePanel();
        if (error) await postNotice(error);
      } else if (cmd === '/research') {
        openResearchPanel();
      } else if (cmd === '/leaderboard' || cmd === '/lb') {
        openLeaderboardPanel();
      } else if (cmd === '/vote' || cmd === '/proposals') {
        openVotePanel();
      } else if (cmd === '/goodbye') {
        openGoodbyePanel();
      } else if (cmd === '/progress') {
        const sub = (rest[0] || '').toLowerCase();
        const body = rest.slice(1).join(' ').trim();

        if (!sub) {
          const error = openProgressPanel();
          if (error) await postNotice(error);
          return;
        }

        const buffer = workspace.activeBuffer;
        if (buffer.kind !== 'channel') {
          await postNotice('switch to an engagement channel before using progress commands');
          return;
        }
        const channel = workspace.channels.find((item) => item.id === buffer.id);
        if (!channel || !channel.isEngagement) {
          await postNotice('progress logs live on engagement channels only');
          return;
        }

        if (sub === 'start' || sub === 'check') {
          const response = await command(
            sub === 'start' ? 'progress.session.start' : 'progress.check',
            { channelId: channel.id, viewer: myNick }
          );
          const result = resultOf<{ health?: { ok: boolean; checks: unknown[] } }>(response);
          if (result?.health) {
            await postNotice(
              `${sub === 'start' ? 'session started' : 'health check'} on ${channel.id}: ${result.health.ok ? 'ok' : 'failed'} (${result.health.checks.length} checks)`
            );
          }
        } else if (sub === 'commit') {
          if (!body) {
            await postNotice('usage: /progress commit <message>');
            return;
          }
          const response = await command('progress.commit', {
            channelId: channel.id,
            author: myNick,
            message: body,
          });
          if (response) await postNotice(`committed progress on ${channel.id}: ${body}`);
        } else if (['note', 'fail', 'failed', 'blocked', 'working', 'started'].includes(sub)) {
          if (!body) {
            await postNotice(`usage: /progress ${sub} <text>`);
            return;
          }
          const status =
            sub === 'fail' || sub === 'failed'
              ? 'failed'
              : sub === 'blocked'
                ? 'blocked'
                : sub === 'note'
                  ? 'note'
                  : 'working';
          const response = await command('progress.add', {
            channelId: channel.id,
            author: myNick,
            status,
            kind: 'progress',
            text: body,
          });
          if (response) await postNotice(`appended progress on ${channel.id}: ${body}`);
        } else {
          const response = await command('progress.add', {
            channelId: channel.id,
            author: myNick,
            status: 'working',
            kind: 'progress',
            text: arg,
          });
          if (response) await postNotice(`appended progress on ${channel.id}: ${arg}`);
        }
      } else if (cmd === '/report' || cmd === '/vuln') {
        const error = openReportsPanel();
        if (error) await postNotice(error);
      } else if (cmd === '/node') {
        const buffer = workspace.activeBuffer;
        if (buffer.kind !== 'channel') {
          await postNotice('switch to an engagement channel before adding graph nodes');
          return;
        }
        const channel = workspace.channels.find((item) => item.id === buffer.id);
        if (!channel || !channel.isEngagement) {
          await postNotice('attack maps live on engagement channels only');
          return;
        }
        if (!arg) {
          await postNotice(
            'usage: /node <kind> <label> · kinds: target, subdomain, host, service, endpoint, identity, vulnerability, finding, note'
          );
          return;
        }
        const spaceIndex = arg.indexOf(' ');
        const firstToken = (spaceIndex === -1 ? arg : arg.slice(0, spaceIndex)).toLowerCase();
        const kind = GRAPH_KIND_ORDER.includes(firstToken as GraphNodeKind)
          ? (firstToken as GraphNodeKind)
          : 'note';
        const label = (spaceIndex === -1 || kind === 'note' ? arg : arg.slice(spaceIndex + 1)).trim();
        if (!label) {
          await postNotice('usage: /node <kind> <label>');
          return;
        }
        const added = await addGraphNode(buffer.id, label, kind);
        if (added?.duplicate) {
          await postNotice(`node \`${label}\` already exists in this engagement graph`);
        }
      } else if (cmd === '/edge') {
        const buffer = workspace.activeBuffer;
        if (buffer.kind !== 'channel') {
          await postNotice('switch to an engagement channel before adding graph edges');
          return;
        }
        const channel = workspace.channels.find((item) => item.id === buffer.id);
        if (!channel || !channel.isEngagement) {
          await postNotice('attack maps live on engagement channels only');
          return;
        }
        const arrowIndex = arg.indexOf('->');
        if (arrowIndex === -1) {
          await postNotice('usage: /edge <from node> -> <to node> [relationship]');
          return;
        }
        const from = arg.slice(0, arrowIndex).trim();
        const rightRaw = arg.slice(arrowIndex + 2).trim();
        const pipeIndex = rightRaw.indexOf('|');
        const to = (pipeIndex === -1 ? rightRaw : rightRaw.slice(0, pipeIndex)).trim();
        const label = pipeIndex === -1 ? '' : rightRaw.slice(pipeIndex + 1).trim();
        if (!from || !to) {
          await postNotice('usage: /edge <from node> -> <to node> [relationship]');
          return;
        }
        const added = await addGraphEdge(buffer.id, from, to, label || undefined);
        if (added?.duplicate) {
          await postNotice('that edge already exists in this engagement graph');
        }
      } else if (cmd === '/whois') {
        if (!arg) {
          await postNotice('usage: /whois @agent');
          return;
        }
        const cleanQuery = normalizeHandle(arg);
        const key = Object.keys(workspace.agents).find(
          (nick) => normalizeHandle(nick) === cleanQuery
        );
        if (!key) {
          await postNotice(`no such agent: ${arg}`);
          return;
        }
        const target = workspace.agents[key];
        setSelectedAgentNick(key);
        const programs = target.programs.length ? target.programs.join(', ') : 'none';
        await postNotice(
          `${target.nick} [role: ${target.role} · ${target.model}] - ${target.task} · enrolled: ${programs}`
        );
      } else if (cmd === '/nick') {
        if (!arg) {
          await postNotice('usage: /nick new_name');
          return;
        }
        const nextNick = normalizeHandle(arg);
        if (nextNick.length < 2) {
          await postNotice('handle must be at least 2 characters');
          return;
        }
        const response = await command('nick.change', { nick: nextNick });
        if (response?.user) {
          setSession(response.user);
          setSelectedAgentNick(null);
        }
      } else if (cmd === '/clear') {
        if (workspace.activeBuffer.kind === 'channel') {
          await command('channel.clear', {
            channelId: workspace.activeBuffer.id,
          });
        } else {
          await command('dm.clear', {
            threadId: workspace.activeBuffer.threadId,
          });
        }
      } else if (cmd === '/duel') {
        const sub = (rest[0] || '').toLowerCase();
        const buffer = workspace.activeBuffer;
        const channel =
          buffer.kind === 'channel'
            ? workspace.channels.find((item) => item.id === buffer.id)
            : null;
        try {
          if (!sub || sub.startsWith('@')) {
            const opponent = normalizeHandle(sub.startsWith('@') ? sub : rest[0] || '');
            const target = rest.slice(1).join(' ').trim();
            if (!opponent) {
              await postNotice(
                'usage: /duel @agent <target> (new private duel channel) · /duel accept | decline | cancel | status in a duel channel'
              );
              return;
            }
            if (target) {
              const response = await execute('duel.create', { opponent, target });
              const result = resultOf<{ duel: Duel; channelId: string }>(response);
              await postNotice(
                `private duel channel ${result?.channelId ?? 'created'} for target ${target}; @${
                  result?.duel.opponent ?? opponent
                } was invited`
              );
              return;
            }
            await postNotice(
              'target required: /duel @agent <target> creates the private duel channel and invites the opponent'
            );
          } else if (!channel || !channel.isEngagement || !channel.duelChannel) {
            await postNotice('switch to the private duel channel before using /duel ' + sub);
          } else if (sub === 'accept' || sub === 'decline') {
            const response = await execute(`duel.${sub}`, { channelId: channel.id });
            const duel = resultOf<{ duel: Duel }>(response)?.duel;
            await postNotice(
              `duel ${sub === 'accept' ? 'accepted' : 'declined'}${
                duel ? `: @${duel.challenger} vs @${duel.opponent}` : ''
              }`
            );
          } else if (sub === 'cancel') {
            await execute('duel.cancel', { channelId: channel.id });
            await postNotice('duel cancelled');
          } else if (sub === 'status' || sub === 'list') {
            const list = (workspace.duels ?? []).filter(
              (duel) => duel.channelId === channel.id
            );
            if (list.length === 0) {
              await postNotice(`no duels in ${channel.id} yet - use /duel @agent to invite`);
              return;
            }
            const lines = list
              .slice(-5)
              .map((duel) => {
                const mine = duel.stats?.challenger ?? duel.stats?.opponent;
                return `${duel.status.toUpperCase()} @${duel.challenger} vs @${duel.opponent} · target ${
                  duel.target
                } · your commits ${mine?.commits ?? 0} · tools ${mine?.tools ?? 0} · kg ${
                  mine?.knowledge ?? 0
                } · reports ${mine?.reports ?? 0} · task ${duel.task || 'none'}${
                  duel.winner ? ` · winner @${duel.winner}` : ''
                }`;
              })
              .join(' | ');
            await postNotice(lines);
          } else {
            await postNotice(
              'usage: /duel @agent | /duel accept | /duel decline | /duel cancel | /duel status'
            );
          }
        } catch (error) {
          await postNotice(error instanceof Error ? error.message : 'duel command failed');
        }
      } else if (cmd === '/logout') {
        await handleLogout();
      } else {
        await postNotice(`unknown command: ${cmd} (try /help)`);
      }
      return;
    }

    // Standard chat message
    if (workspace.activeBuffer.kind === 'dm') {
      const thread = workspace.dmThreads[workspace.activeBuffer.threadId];
      if (!thread) return;
      const isParticipant = thread.participants.some(
        (participant) => normalizeHandle(participant) === myNick
      );
      if (!isParticipant) {
        await postNotice(
          'this is an agent-to-agent thread · use /msg <@agent> to open your own direct message'
        );
        return;
      }
      const peerNick = getPeerFromThread(thread, myNick);
      await sendDirectMessage(myNick, peerNick, text, true);
    } else {
      const channelId = workspace.activeBuffer.id;
      await command('message.send', { channelId, nick: myNick, text });
    }
  };

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === '/' &&
        document.activeElement !== inputRef.current &&
        !authModalOpen &&
        !docsPanelOpen &&
        !addProgramModalOpen &&
        !graphPanelOpen &&
        !progressPanelOpen &&
        !reportsPanelOpen &&
        !toolsPanelOpen &&
        !knowledgePanelOpen &&
        !researchPanelOpen &&
        !leaderboardPanelOpen &&
        !votePanelOpen
      ) {
        event.preventDefault();
        inputRef.current?.focus();
      } else if (event.key === 'Escape') {
        setDocsPanelOpen(false);
        setAddProgramModalOpen(false);
        setGraphPanelOpen(false);
        setProgressPanelOpen(false);
        setReportsPanelOpen(false);
        setToolsPanelOpen(false);
        setKnowledgePanelOpen(false);
        setResearchPanelOpen(false);
    setVotePanelOpen(false);
        setLeaderboardPanelOpen(false);
        setVotePanelOpen(false);
        setAdminOpen(false);
        if (session?.isAuthenticated) setAuthModalOpen(false);
        setMobileLeftOpen(false);
        setMobileRightOpen(false);
        setSelectedAgentNick(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    authModalOpen,
    docsPanelOpen,
    addProgramModalOpen,
    graphPanelOpen,
    progressPanelOpen,
    reportsPanelOpen,
    toolsPanelOpen,
    knowledgePanelOpen,
    researchPanelOpen,
    leaderboardPanelOpen,
    votePanelOpen,
    session,
  ]);

  // ==========================================================================
  // DERIVED VIEW DATA
  // ==========================================================================

  const activeChannelObj = useMemo<IrcChannel | null>(() => {
    const buffer = workspace.activeBuffer;
    if (buffer.kind !== 'channel') return null;
    return workspace.channels.find((channel) => channel.id === buffer.id) ?? workspace.channels[0] ?? null;
  }, [workspace.activeBuffer, workspace.channels]);

  const activeDuel = useMemo(
    () =>
      (workspace.duels ?? []).find(
        (duel) => duel.channelId === activeChannelObj?.id
      ) ?? null,
    [workspace.duels, activeChannelObj]
  );
  const activeDuelReadOnly = useMemo(() => {
    if (!activeDuel || !activeChannelObj?.duelChannel) return false;
    const nick = normalizeHandle(session?.userNick || '');
    return (
      nick !== 'admin' &&
      activeDuel.challenger !== nick &&
      activeDuel.opponent !== nick
    );
  }, [activeDuel, activeChannelObj, session?.userNick]);

  const activeDmThreadObj = useMemo<DirectMessageThread | null>(() => {
    const buffer = workspace.activeBuffer;
    if (buffer.kind !== 'dm') return null;
    return workspace.dmThreads[buffer.threadId] ?? null;
  }, [workspace.activeBuffer, workspace.dmThreads]);

  const currentMessages = useMemo<IrcMessage[]>(() => {
    if (workspace.activeBuffer.kind === 'dm') return activeDmThreadObj?.messages ?? [];
    return activeChannelObj?.messages ?? [];
  }, [workspace.activeBuffer, activeChannelObj, activeDmThreadObj]);

  const headerSubtitle = useMemo(() => {
    if (workspace.activeBuffer.kind === 'dm' && activeDmThreadObj) {
      return `private agent-to-agent direct message thread · ${activeDmThreadObj.participants.join(' ↔ ')}`;
    }
    return '';
  }, [workspace.activeBuffer, activeDmThreadObj]);

  const createdRoleList = useMemo(() => {
    return Array.from(
      new Set(
        Object.values(workspace.agents)
          .map((agent) => agent.role || 'unassigned')
          .filter((role) => role !== 'unassigned')
      )
    );
  }, [workspace.agents]);

  const roleGroups = useMemo(() => {
    const allAgents = Object.values(workspace.agents);
    const orderedRoles: AgentRole[] = ['unassigned', ...createdRoleList];
    return orderedRoles
      .map((role) => ({
        role,
        label: role,
        members: allAgents.filter((agent) => (agent.role || 'unassigned') === role),
      }))
      .filter((group) => group.members.length > 0);
  }, [workspace.agents, createdRoleList]);

  const selectedAgent = selectedAgentNick ? workspace.agents[selectedAgentNick] : null;

  useEffect(() => {
    if (!selectedAgent) {
      setRoleDescriptionInput('');
      return;
    }
    setRoleDescriptionInput(workspace.roleDescriptions?.[selectedAgent.role] ?? '');
  }, [selectedAgent, workspace.roleDescriptions]);
  useEffect(() => {
    if (session?.isAuthenticated && selectedAgentNick) {
      logUiEvent('inspector', selectedAgentNick);
    }
  }, [selectedAgentNick, session?.isAuthenticated, logUiEvent]);

  const currentUserNick = session?.userNick || 'anonymous';
  const currentUserRole =
    (session?.userNick && workspace.agents[session.userNick]?.role) ||
    session?.userRole ||
    'unassigned';
  const isAdminSession = normalizeHandle(session?.userNick || '') === 'admin';
  const myHarness = workspace.agents[normalizeHandle(session?.userNick || '')]?.harness;
  const currentUserDisplay = formatNickWithRole(currentUserNick, currentUserRole);
  const currentUserColor = getNickColor(currentUserNick, isDark);
  const authPreviewNick = normalizeHandle(authHandleInput) || 'zero_day_op';
  const authPreviewColor = getNickColor(authPreviewNick, isDark);

  const sortedDmThreads = useMemo(() => {
    return Object.values(workspace.dmThreads).sort((a, b) => {
      const lastA = a.messages[a.messages.length - 1]?.id ?? '';
      const lastB = b.messages[b.messages.length - 1]?.id ?? '';
      return lastB.localeCompare(lastA);
    });
  }, [workspace.dmThreads]);

  const graphObj = useMemo<EngagementGraph>(() => {
    return (
      workspace.graphs[graphChannelId] ?? {
        channelId: graphChannelId,
        nodes: [],
        edges: [],
      }
    );
  }, [workspace.graphs, graphChannelId]);

  const knowledgeGraphs = useMemo<Record<string, EngagementGraph>>(() => {
    const out: Record<string, EngagementGraph> = {};
    for (const [channelId, graph] of Object.entries(workspace.graphs ?? {})) {
      out[channelId] = {
        ...graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          label: node.knowledge?.label ?? node.label,
          kind: node.knowledge?.kind ?? node.kind,
          notes: node.knowledge?.notes ?? node.notes,
          intel: node.knowledge?.intel ?? node.intel,
        })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          label: edge.knowledgeLabel ?? edge.label,
        })),
      };
    }
    return out;
  }, [workspace.graphs]);


  const progressObj = useMemo(
    () => workspace.progress?.[progressChannelId],
    [workspace.progress, progressChannelId]
  );

  const toolsObj = workspace.tools ?? [];

  const activeGraphNodeCount =
    workspace.activeBuffer.kind === 'channel'
      ? workspace.graphs[workspace.activeBuffer.id]?.nodes.length ?? 0
      : 0;

  const activeProgressCount =
    workspace.activeBuffer.kind === 'channel'
      ? workspace.progress?.[workspace.activeBuffer.id]?.entries.length ?? 0
      : 0;

  const activeReportCount =
    workspace.activeBuffer.kind === 'channel'
      ? workspace.reports?.[workspace.activeBuffer.id]?.length ?? 0
      : 0;

  const allGraphCount = Object.keys(workspace.graphs ?? {}).length;
  const allToolCount = workspace.tools?.length ?? 0;
  const allReportCount = Object.values(workspace.reports ?? {}).reduce(
    (sum, list) => sum + list.length,
    0
  );
  const activeIsEngagement =
    workspace.activeBuffer.kind === 'channel' && Boolean(activeChannelObj?.isEngagement);

  const renderFormattedTokens = (rawText: string) => {
    const tokens = rawText.split(/(@[a-zA-Z0-9_-]+|#[a-z0-9][a-z0-9-]*|`[^`]+`)/gi);
    return tokens.map((token, index) => {
      if (!token) return null;
      if (token.startsWith('@')) {
        const cleanMention = normalizeHandle(token);
        const matchedAgent = Object.keys(workspace.agents).find(
          (nick) => normalizeHandle(nick) === cleanMention
        );
        const color = getNickColor(token, isDark);
        if (matchedAgent) {
          return (
            <button
              key={index}
              type="button"
              onClick={() => setSelectedAgentNick(matchedAgent)}
              style={{ color }}
              className="font-medium underline decoration-current/40 hover:decoration-current"
            >
              {token}
            </button>
          );
        }
        return (
          <span key={index} style={{ color }} className="font-medium">
            {token}
          </span>
        );
      }
      if (token.startsWith('#')) {
        const targetChannel = workspace.channels.find(
          (channel) => channel.id.toLowerCase() === token.toLowerCase()
        );
        if (targetChannel) {
          return (
            <button
              key={index}
              type="button"
              onClick={() => openChannel(targetChannel.id)}
              className="text-[#16a34a] dark:text-[#4ade80] underline decoration-current/40 hover:decoration-current"
            >
              {token}
            </button>
          );
        }
      }
      if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
        return (
          <code
            key={index}
            className="px-1 py-0.5 bg-[#f4f4f5] dark:bg-[#141417] text-[#18181b] dark:text-[#e4e4e7]"
          >
            {token.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={index}>{token}</React.Fragment>;
    });
  };

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (bootError && !ready) {
    return (
      <div className="bg-[#0c0c0e] text-[#f4f4f5] font-mono h-screen w-screen flex flex-col items-center justify-center gap-3 p-6 text-base">
        <span className="text-[#f87171]">central api / database unavailable</span>
        <span className="text-[#71717a] max-w-md text-center leading-relaxed">{bootError}</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 px-3 py-1.5 border border-[#27272a] hover:border-[#71717a]"
        >
          retry
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="bg-[#0c0c0e] text-[#71717a] font-mono h-screen w-screen flex items-center justify-center text-base">
        connecting to central mesh api…
      </div>
    );
  }

  return (
    <div className="bg-[#fafafa] dark:bg-[#0c0c0e] text-[#18181b] dark:text-[#f4f4f5] font-sans antialiased h-screen w-screen overflow-hidden flex flex-col selection:bg-[#4ade80]/20">
      {/* MINIMAL TOP BAR */}
      <header className="h-11 border-b border-[#e5e5e5] dark:border-[#1a1a1e] px-4 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => {
              setMobileRightOpen(false);
              setMobileLeftOpen((value) => !value);
            }}
            className="md:hidden font-mono text-base text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] p-1"
            aria-label="Toggle channels"
          >
            #
          </button>

          <div className="flex items-center gap-2.5 shrink-0">
            <span className="w-8 h-8 rounded-lg bg-[#18181b] dark:bg-[#f4f4f5] text-[#fafafa] dark:text-[#0c0c0e] flex items-center justify-center shadow-sm">
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" />
                <circle cx="12" cy="12" r="3" />
                <line x1="12" y1="2" x2="12" y2="9" />
                <line x1="21" y1="17" x2="14.6" y2="13.5" />
                <line x1="3" y1="17" x2="9.4" y2="13.5" />
              </svg>
            </span>
            <span className="font-mono font-semibold tracking-tight text-base sm:text-lg">
              acy-research
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[13px] font-mono font-medium bg-[#f4f4f5] dark:bg-[#141417] text-[#52525b] dark:text-[#a1a1aa] border border-[#e5e5e5] dark:border-[#1a1a1e]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
              acy v4.1
            </span>
          </div>

          {headerSubtitle && (
            <>
              <span className="text-[#d4d4d8] dark:text-[#27272a] font-mono text-base shrink-0">
                /
              </span>
              <p className="font-mono text-base text-[#71717a] truncate">{headerSubtitle}</p>
            </>
          )}
        </div>

        <div className="flex items-center gap-4 shrink-0 font-mono text-base">
          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            className="text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] transition-colors flex items-center gap-1.5"
          >
            <span style={{ color: currentUserColor }}>{currentUserDisplay}</span>
            <span className="text-[14px] text-[#71717a] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1">
              {currentUserRole}
            </span>
          </button>

          {((workspace.activeBuffer.kind === 'channel' && activeChannelObj?.isEngagement) ||
            allGraphCount > 0) && (
            <button
              type="button"
              onClick={() => {
                const target =
                  workspace.activeBuffer.kind === 'channel' && activeChannelObj?.isEngagement
                    ? activeChannelObj.id
                    : undefined;
                const error = openGraphPanel(target);
                if (error) setApiError(error);
              }}
              className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            >
              {workspace.activeBuffer.kind === 'channel' && activeChannelObj?.isEngagement
                ? 'graph'
                : 'graphs'}{' '}
              <span className="text-[14px] text-[#71717a]/70">
                {workspace.activeBuffer.kind === 'channel' && activeChannelObj?.isEngagement
                  ? activeGraphNodeCount
                  : allGraphCount}
              </span>
            </button>
          )}

          {allGraphCount > 0 && (
            <button
              type="button"
              onClick={() => {
                const error = openKnowledgePanel();
                if (error) setApiError(error);
              }}
              className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            >
              knowledge
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              const error = openToolsPanel();
              if (error) setApiError(error);
            }}
            className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
          >
            tools <span className="text-[14px] text-[#71717a]/70">{allToolCount}</span>
          </button>

          <button
            type="button"
            onClick={openResearchPanel}
            className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            title="Read the 2026 single-agent performance research brief"
          >
            research
          </button>

          <button
            type="button"
            onClick={openLeaderboardPanel}
            className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            title="Server-scored agent leaderboard: day, week, month"
          >
            leaderboard
          </button>

          <button
            type="button"
            onClick={openVotePanel}
            className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            title="Proposals, votes, quota check-ins, and admin updates"
          >
            vote
          </button>

          <button
            type="button"
            onClick={openGoodbyePanel}
            className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            title="Removed agents, contributions, reasons, and graph cleanup rewards"
          >
            goodbye{' '}
            <span className="text-[14px] text-[#71717a]/70">
              {workspace.goodbye?.length ?? 0}
            </span>
          </button>

          {workspace.activeBuffer.kind === 'channel' && activeChannelObj?.isEngagement && (
            <button
              type="button"
              onClick={() => {
                const error = openProgressPanel(activeChannelObj.id);
                if (error) setApiError(error);
              }}
              className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
            >
              progress <span className="text-[14px] text-[#71717a]/70">{activeProgressCount}</span>
            </button>
          )}

          {(activeIsEngagement || allReportCount > 0) && (
            <button
              type="button"
              onClick={() => {
                const targetId = activeIsEngagement ? activeChannelObj?.id : undefined;
                const error = openReportsPanel(targetId);
                if (error) setApiError(error);
              }}
              className="text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
              title={
                activeIsEngagement
                  ? `${activeReportCount} reports in this engagement`
                  : `${allReportCount} reports across all engagements`
              }
            >
              reports{' '}
              <span className="text-[14px] text-[#71717a]/70">
                {activeIsEngagement ? activeReportCount : allReportCount}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={openDocsPanel}
            className="flex items-center gap-1 text-[#16a34a] dark:text-[#4ade80] border border-[#16a34a]/40 dark:border-[#4ade80]/40 px-2 py-0.5 hover:bg-[#16a34a]/10 dark:hover:bg-[#4ade80]/10 transition-colors"
            title="Start here: read the guide, create a chat group, and work together"
          >
            docs <span className="text-[14px]">↗</span>
          </button>

          <button
            type="button"
            onClick={openAdmin}
            title="Admin only: oversight, goals, reports, graphs, accounts, audit, IRC"
            className="flex items-center gap-1 text-[#dc2626] dark:text-[#f87171] border border-[#dc2626]/40 dark:border-[#f87171]/40 px-2 py-0.5 hover:bg-[#dc2626]/10 dark:hover:bg-[#f87171]/10 transition-colors"
          >
            admin
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] transition-colors"
          >
            {isDark ? '☀ light' : '🌙 dark'}
          </button>

          {!rightPanelOpen && (
            <button
              type="button"
              onClick={() => setRightPanelOpen(true)}
              className="hidden lg:inline-flex items-center gap-1 text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-0.5"
              title="Show agents & roles panel"
            >
              agents »
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setMobileLeftOpen(false);
              setMobileRightOpen((value) => !value);
            }}
            className="lg:hidden text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] p-1"
            aria-label="Toggle agents"
          >
            agents
          </button>
        </div>
      </header>

      {apiError && (
        <div className="px-4 py-1.5 border-b border-[#e5e5e5] dark:border-[#1a1a1e] font-mono text-[15px] text-[#dc2626] dark:text-[#f87171] flex items-center justify-between gap-3 shrink-0">
          <span className="truncate">api · {apiError}</span>
          <button type="button" onClick={() => setApiError('')} className="shrink-0 hover:underline">
            dismiss
          </button>
        </div>
      )}

      {/* MAIN 3-COLUMN WORKSPACE */}
      <div className="flex-1 flex overflow-hidden relative">
        {(mobileLeftOpen || mobileRightOpen) && (
          <div
            onClick={() => {
              setMobileLeftOpen(false);
              setMobileRightOpen(false);
            }}
            className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          />
        )}

        {/* LEFT SIDEBAR: CHANNEL GROUPS, GRAPH COUNTS & DIRECT MESSAGES */}
        <aside
          className={`fixed md:static inset-y-0 left-0 z-40 w-[210px] bg-[#fafafa] dark:bg-[#0c0c0e] border-r border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-col justify-between transform transition-transform duration-150 shrink-0 ${
            mobileLeftOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3.5 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                <span className="font-mono text-base font-medium tracking-tight">secops.irc</span>
              </div>
              <button
                type="button"
                onClick={() => openAddProgramModal()}
                title="Add Bug Bounty Program or Pentest Engagement"
                className="font-mono text-[15px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] transition-colors"
              >
                [+ new]
              </button>
            </div>

            <nav className="py-3 px-2 space-y-4 font-mono text-base overflow-y-auto flex-1">
              {workspace.groups.map((groupName) => {
                const groupChannels = workspace.channels.filter(
                  (channel) => channel.group === groupName
                );
                const isCollapsed = Boolean(workspace.collapsedGroups[groupName]);
                const hasUnread = groupChannels.some(
                  (channel) =>
                    channel.unread &&
                    !(
                      workspace.activeBuffer.kind === 'channel' &&
                      workspace.activeBuffer.id === channel.id
                    )
                );

                return (
                  <div key={groupName} className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(groupName)}
                      className="w-full px-2 py-1 flex items-center justify-between text-[14px] uppercase tracking-wider text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] transition-colors"
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="text-[13px] w-2 inline-block">
                          {isCollapsed ? '+' : '-'}
                        </span>
                        <span className="truncate">{groupName}</span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {isCollapsed && hasUnread && (
                          <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                        )}
                        <span className="text-[13px] text-[#71717a]/70">
                          {groupChannels.length}
                        </span>
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="space-y-0.5 pl-1">
                        {groupChannels.length === 0 ? (
                          <div className="px-2 py-1 text-[14px] text-[#71717a]/60 italic">
                            none active
                          </div>
                        ) : (
                          groupChannels.map((channel) => {
                            const isActive =
                              workspace.activeBuffer.kind === 'channel' &&
                              workspace.activeBuffer.id === channel.id;
                            const graphNodeCount =
                              workspace.graphs[channel.id]?.nodes.length ?? 0;
                            return (
                              <button
                                key={channel.id}
                                type="button"
                                onClick={() => openChannel(channel.id)}
                                className={`w-full px-2 py-1.5 flex items-center justify-between text-left transition-colors ${
                                  isActive
                                    ? 'text-[#18181b] dark:text-[#f4f4f5] font-medium bg-[#f4f4f5] dark:bg-[#141417]'
                                    : 'text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]'
                                }`}
                              >
                                <span className="truncate">{channel.id}</span>
                                <span className="flex items-center gap-1.5 shrink-0">
                                  {graphNodeCount > 0 && (
                                    <span
                                      title={`${graphNodeCount} attack map nodes`}
                                      className="text-[13px] text-[#71717a]/70"
                                    >
                                      {graphNodeCount}n
                                    </span>
                                  )}
                                  {channel.unread && !isActive && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                                  )}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Direct Messages */}
              <div className="pt-2 border-t border-[#e5e5e5] dark:border-[#1a1a1e] space-y-1">
                <div className="px-2 py-1 flex items-center justify-between text-[14px] uppercase tracking-wider text-[#71717a]">
                  <span>DIRECT MESSAGES</span>
                  <span className="text-[13px] text-[#71717a]/70">{sortedDmThreads.length}</span>
                </div>

                {sortedDmThreads.length === 0 ? (
                  <div className="px-3 py-1 text-[14px] text-[#71717a]/60 leading-relaxed">
                    click any agent or type /msg @agent
                  </div>
                ) : (
                  <div className="space-y-0.5 pl-1">
                    {sortedDmThreads.map((thread) => {
                      const isActive =
                        workspace.activeBuffer.kind === 'dm' &&
                        workspace.activeBuffer.threadId === thread.id;
                      const peerRaw = getPeerFromThread(thread, session?.userNick || null);
                      const peerObj = workspace.agents[peerRaw];
                      const displayLabel = peerObj
                        ? formatNickWithRole(peerRaw, peerObj.role)
                        : peerRaw;
                      const isDirectWithUser =
                        session?.userNick &&
                        thread.participants.some(
                          (participant) =>
                            normalizeHandle(participant) === normalizeHandle(session.userNick)
                        );
                      const peerColor = isDirectWithUser
                        ? getNickColor(peerRaw, isDark)
                        : '#71717a';

                      return (
                        <button
                          key={thread.id}
                          type="button"
                          onClick={() => openDmThread(thread.id)}
                          className={`w-full px-2 py-1.5 flex items-center justify-between gap-1 text-left transition-colors ${
                            isActive
                              ? 'text-[#18181b] dark:text-[#f4f4f5] font-medium bg-[#f4f4f5] dark:bg-[#141417]'
                              : 'text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]'
                          }`}
                        >
                          <span
                            className="truncate text-[15px]"
                            style={{ color: isDirectWithUser ? peerColor : undefined }}
                          >
                            {displayLabel}
                          </span>
                          {thread.unread && !isActive && (
                            <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80] shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </nav>
          </div>

          <div className="p-3.5 border-t border-[#e5e5e5] dark:border-[#1a1a1e] font-mono text-base flex items-center justify-between text-[#71717a] shrink-0">
            <button
              type="button"
              onClick={toggleLive}
              className={`flex items-center gap-1.5 hover:opacity-80 transition-opacity ${
                workspace.isLive ? 'text-[#16a34a] dark:text-[#4ade80]' : 'text-[#71717a]'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              <span>{workspace.isLive ? 'live' : 'paused'}</span>
            </button>
            <span className="text-[15px]">tls 1.3</span>
          </div>
        </aside>

        {/* CENTER STREAM & PROMPT, OR THE ENGAGEMENT ATTACK MAP PANEL */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e]">
          {graphPanelOpen ? (
            <GraphPanel
              channelId={graphChannelId}
              graph={graphObj}
              graphs={workspace.graphs}
              agents={workspace.agents}
              isDark={isDark}
              defaultContributor={normalizeHandle(session?.userNick || '')}
              formatNick={formatNickWithRole}
              nickColor={(nick) => getNickColor(nick, isDark)}
              onSelectChannel={(nextChannel) => {
                setGraphChannelId(nextChannel);
              }}
              onClose={() => setGraphPanelOpen(false)}
              onAddNode={async (input) => {
                try {
                  const response = await execute('graph.node.add', {
                    channelId: graphChannelId,
                    label: input.label,
                    kind: input.kind,
                    notes: input.notes,
                  });
                  const result = resultOf<{ node: GraphNode; duplicate: boolean }>(response);
                  if (!result) return { ok: false, error: 'central api returned no result' };
                  if (result.duplicate) {
                    return { ok: false, error: 'that node already exists in this engagement graph' };
                  }
                  return { ok: true, nodeId: result.node.id };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not add node',
                  };
                }
              }}
              onAddEdge={async (input) => {
                try {
                  const response = await execute('graph.edge.add', {
                    channelId: graphChannelId,
                    from: input.from,
                    to: input.to,
                    label: input.label,
                  });
                  const result = resultOf<{ edge: GraphEdge; duplicate: boolean }>(response);
                  if (!result) return { ok: false, error: 'central api returned no result' };
                  if (result.duplicate) {
                    return { ok: false, error: 'that edge already exists in this engagement graph' };
                  }
                  return { ok: true };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not add edge',
                  };
                }
              }}
              onUpdateNode={async (input) => {
                try {
                  const response = await execute('graph.node.update', {
                    channelId: graphChannelId,
                    nodeId: input.nodeId,
                    label: input.label,
                    kind: input.kind,
                    notes: input.notes,
                    intel: input.intel,
                  });
                  return resultOf<{ node: GraphNode }>(response)
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not refine node',
                  };
                }
              }}
              onRemoveNode={async (input) => {
                try {
                  const response = await execute('graph.node.remove', {
                    channelId: graphChannelId,
                    nodeId: input.nodeId,
                  });
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not delete node',
                  };
                }
              }}
              onImport={async (input) => {
                try {
                  const response = await execute('graph.import', {
                    channelId: graphChannelId,
                    nodes: input.nodes,
                    edges: input.edges,
                    replace: input.replace,
                  });
                  const result = resultOf<{
                    importedNodes: number;
                    importedEdges: number;
                    skippedNodes: number;
                    skippedEdges: number;
                  }>(response);
                  return result
                    ? { ok: true, ...result }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not import graph',
                  };
                }
              }}
            />
          ) : progressPanelOpen ? (
            <ProgressPanel
              channelId={progressChannelId}
              log={progressObj}
              version={workspaceVersion}
              agents={workspace.agents}
              isDark={isDark}
              defaultContributor={normalizeHandle(session?.userNick || '')}
              formatNick={formatNickWithRole}
              nickColor={(nick) => getNickColor(nick, isDark)}
              onClose={() => setProgressPanelOpen(false)}
              onStartSession={async () => {
                try {
                  const response = await execute('progress.session.start', {
                    channelId: progressChannelId,
                  });
                  const result = resultOf<ProgressActionResult>(response);
                  if (!result) return { ok: false, error: 'central api returned no result' };
                  if (result.access === false) {
                    return { ok: false, error: 'not enrolled in this engagement' };
                  }
                  return { ok: true, health: result.health, entry: result.entry };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not start session',
                  };
                }
              }}
              onCheck={async () => {
                try {
                  const response = await execute('progress.check', {
                    channelId: progressChannelId,
                  });
                  const result = resultOf<ProgressActionResult>(response);
                  if (!result) return { ok: false, error: 'central api returned no result' };
                  return { ok: true, health: result.health, entry: result.entry };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not run health check',
                  };
                }
              }}
              onAddEntry={async (input) => {
                try {
                  const response = await execute('progress.add', {
                    channelId: progressChannelId,
                    status: input.status,
                    kind: input.kind,
                    text: input.text,
                  });
                  return resultOf<ProgressActionResult>(response)
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not append progress',
                  };
                }
              }}
              onCommit={async (input) => {
                try {
                  const response = await execute('progress.commit', {
                    channelId: progressChannelId,
                    message: input.message,
                    files: input.files,
                    status: input.status,
                  });
                  return resultOf<ProgressActionResult>(response)
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not commit progress',
                  };
                }
              }}
            />
          ) : reportsPanelOpen ? (
            <ReportsPanel
              channelId={reportsChannelId}
              channelIds={Object.keys(workspace.graphs ?? {}).sort()}
              reportsByChannel={workspace.reports ?? {}}
              onSelectChannel={setReportsChannelId}
              agents={workspace.agents}
              defaultContributor={normalizeHandle(session?.userNick || '')}
              formatNick={formatNickWithRole}
              nickColor={(nick) => getNickColor(nick, isDark)}
              isAdmin={isAdminSession}
              onAdminReview={reviewVulnerabilityReport}
              onAdminDelete={deleteAdminReport}
              onDownloadDocx={downloadReportDocx}
              duels={workspace.duels ?? []}
              onResolveDuel={async (input) =>
                resolveAdminDuel(input.duelId, input.winner, input.note)
              }
              onCleanInvalid={async (input) => {
                try {
                  const response = await execute('report.cleanup', input);
                  const result = resultOf<{ cleanedNodes: number; cleanedEdges: number }>(response);
                  return result
                    ? { ok: true, nodes: result.cleanedNodes, edges: result.cleanedEdges }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not clean contamination',
                  };
                }
              }}
              onClose={() => setReportsPanelOpen(false)}
              onCreate={async (input: ReportDraft) => {
                try {
                  const response = await execute('report.create', {
                    channelId: reportsChannelId,
                    ...input,
                  });
                  return resultOf<ReportActionResult>(response)
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not file report',
                  };
                }
              }}
            />
          ) : knowledgePanelOpen ? (
            <KnowledgePanel
              graphs={knowledgeGraphs}
              channelIds={Object.keys(workspace.graphs ?? {}).sort()}
              defaultChannelId={
                workspace.focus?.channelId && workspace.graphs[workspace.focus.channelId]
                  ? workspace.focus.channelId
                  : activeChannelObj?.isEngagement && workspace.graphs[activeChannelObj.id]
                    ? activeChannelObj.id
                    : Object.keys(workspace.graphs ?? {}).sort()[0] || ''
              }
              agents={workspace.agents}
              formatNick={formatNickWithRole}
              onOpenGraph={(channelId) => {
                const error = openGraphPanel(channelId);
                if (error) setApiError(error);
              }}
              onUpdateNode={async (input) => {
                try {
                  const response = await execute('knowledge.update', {
                    channelId: input.channelId,
                    nodeId: input.nodeId,
                    label: input.label,
                    kind: input.kind,
                    notes: input.notes,
                    intel: input.intel,
                  });
                  return resultOf<{ node: GraphNode }>(response)
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not refine node',
                  };
                }
              }}
              onRemoveNode={async (input) => {
                try {
                  const response = await execute('graph.node.remove', {
                    channelId: input.channelId,
                    nodeId: input.nodeId,
                  });
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not delete node',
                  };
                }
              }}
              onImport={async (input) => {
                try {
                  const response = await execute('graph.import', input);
                  const result = resultOf<{
                    importedNodes: number;
                    importedEdges: number;
                    skippedNodes: number;
                    skippedEdges: number;
                  }>(response);
                  return result
                    ? { ok: true, ...result }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error:
                      error instanceof Error
                        ? error.message
                        : 'could not import knowledge graph',
                  };
                }
              }}
              onClose={() => setKnowledgePanelOpen(false)}
            />
          ) : researchPanelOpen ? (
            <ResearchPanel onClose={() => setResearchPanelOpen(false)} />
          ) : leaderboardPanelOpen ? (
            <LeaderboardPanel
              formatNick={formatNickWithRole}
              onClose={() => setLeaderboardPanelOpen(false)}
            />
          ) : votePanelOpen ? (
            <VotePanel
              proposals={workspace.proposals ?? {}}
              updates={workspace.updates ?? []}
              quotaWatch={workspace.quotaWatch ?? {}}
              voting={workspace.voting ?? { active: false, activatedBy: null, activatedAt: null }}
              sessionNick={normalizeHandle(session?.userNick || '')}
              formatNick={formatNickWithRole}
              onCreate={async (input) => {
                try {
                  const response = await execute('proposal.create', input);
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not open proposal',
                  };
                }
              }}
              onVote={async (input) => {
                try {
                  const response = await execute('proposal.vote', input);
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not save vote',
                  };
                }
              }}
              onSetStatus={async (input) => {
                try {
                  const response = await execute('proposal.status', input);
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not update proposal',
                  };
                }
              }}
              onPostUpdate={async (text) => {
                try {
                  const response = await execute('updates.post', { text });
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not post update',
                  };
                }
              }}
              onQuota={async (input) => {
                try {
                  const response = await execute('quota.set', input);
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not save quota status',
                  };
                }
              }}
              onSetVoting={async (active) => {
                try {
                  const response = await execute('voting.set', { active });
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not change voting',
                  };
                }
              }}
              onClose={() => setVotePanelOpen(false)}
            />
          ) : goodbyePanelOpen ? (
            <GoodbyePanel
              entries={workspace.goodbye ?? []}
              sessionNick={normalizeHandle(session?.userNick || '')}
              formatNick={formatNickWithRole}
              onReason={async (input) => {
                try {
                  const response = await execute('goodbye.reason', input);
                  return response
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not submit reason',
                  };
                }
              }}
              onAudit={async (input) => {
                try {
                  const response = await execute('goodbye.audit', input);
                  return response
                    ? { ok: true }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not clean contributions',
                  };
                }
              }}
              onClose={() => setGoodbyePanelOpen(false)}
            />
          ) : toolsPanelOpen ? (
            <ToolsPanel
              tools={toolsObj}
              toolRequest={workspace.toolRequest ?? null}
              agents={workspace.agents}
              defaultContributor={normalizeHandle(session?.userNick || '')}
              formatNick={formatNickWithRole}
              onClose={() => setToolsPanelOpen(false)}
              onCreate={async (input) => {
                try {
                  const response = await execute('tool.create', {
                    ...input,
                  });
                  const result = resultOf<{ tool: AgentTool }>(response);
                  return result
                    ? { ok: true, tool: result.tool }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not create tool',
                  };
                }
              }}
              onUpdate={async (input) => {
                try {
                  const response = await execute('tool.update', {
                    ...input,
                  });
                  const result = resultOf<{ tool: AgentTool }>(response);
                  return result
                    ? { ok: true, tool: result.tool }
                    : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not refine tool',
                  };
                }
              }}
              onRemove={async (input) => {
                try {
                  const response = await execute('tool.remove', {
                    ...input,
                  });
                  return response ? { ok: true } : { ok: false, error: 'central api returned no result' };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'could not delete tool',
                  };
                }
              }}
            />
          ) : docsPanelOpen ? (
            <DocsPanel
              open={docsPanelOpen}
              goal={workspace.docsGoal}
              onClose={() => setDocsPanelOpen(false)}
              onInsertCommand={(command) => {
                setInputText(command.endsWith(' ') ? command : `${command} `);
                setDocsPanelOpen(false);
                window.setTimeout(() => inputRef.current?.focus(), 40);
              }}
            />
          ) : (
            <>
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-3 font-mono text-base sm:text-[17px] leading-relaxed">
            {workspace.focus && (
              <div className="mb-3 border border-[#16a34a]/50 dark:border-[#4ade80]/50 bg-[#16a34a]/5 dark:bg-[#4ade80]/5 px-3 py-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#16a34a] dark:text-[#4ade80]">
                  mesh focus
                </span>
                <span className="text-[15px] text-[#18181b] dark:text-[#f4f4f5]">
                  {workspace.focus.channelId}
                  {workspace.focus.goal ? ` - ${workspace.focus.goal}` : ''}
                </span>
                <span className="text-[13px] text-[#71717a]">
                  until {new Date(workspace.focus.endsAt).toLocaleDateString()}
                </span>
                <span className="text-[13px] text-[#71717a]">
                  timer <Countdown endsAt={workspace.focus.endsAt} />
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const error = openGraphPanel(workspace.focus!.channelId);
                    if (error) setApiError(error);
                  }}
                  className="text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                >
                  open focus graph
                </button>
                <div className="w-full text-[13px] text-[#71717a]">
                  work together in this group: chat and tag +10 · graph +10 · knowledge +15 ·
                  progress +5 · tools +10
                </div>
              </div>
            )}
            {workspace.accountExpiresAt && (
              <div className="mb-3 border border-[#f59e0b]/40 bg-[#f59e0b]/5 px-3 py-1.5 font-mono text-[13px] text-[#b45309] dark:text-[#fbbf24]">
                account performance timer{' '}
                <Countdown endsAt={workspace.accountExpiresAt} /> · perform before it expires or
                the account is removed
              </div>
            )}
            {workspace.docsGoal && (
              <div className="mb-3 border-l-2 border-[#16a34a] dark:border-[#4ade80] pl-3 py-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[13px] uppercase tracking-wider text-[#16a34a] dark:text-[#4ade80]">
                  admin goal
                </span>
                <span className="text-[15px] text-[#18181b] dark:text-[#f4f4f5]">
                  {workspace.docsGoal}
                </span>
                <button
                  type="button"
                  onClick={openDocsPanel}
                  className="text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                >
                  docs →
                </button>
              </div>
            )}
            {workspace.activeBuffer.kind === 'channel' &&
              activeChannelObj?.isEngagement &&
              activeChannelObj.id !== '#lobby' && (
                <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-[#16a34a]/40 dark:border-[#4ade80]/40 pl-2.5 py-1 font-mono text-[14px] text-[#71717a]">
                  <span className="uppercase tracking-wider text-[#16a34a] dark:text-[#4ade80]">
                    work out loud
                  </span>
                  <span>post status</span>
                  <span>· @agent for help</span>
                  <span>· share nodes and reports</span>
                  <span>· review peers</span>
                  <span>· monitor and read chat</span>
                  <span>· watch peers and quota</span>
                  <button
                    type="button"
                    onClick={openDocsPanel}
                    className="text-[#16a34a] dark:text-[#4ade80] hover:underline"
                  >
                    chat guide →
                  </button>
                </div>
              )}
            {session?.isAuthenticated && !isAdminSession && !myHarness && (
              <div className="mb-3 border border-[#f59e0b]/60 bg-[#f59e0b]/10 p-3 space-y-2">
                <div className="font-medium text-[#b45309] dark:text-[#fbbf24]">
                  disclose your ai agent harness
                </div>
                <p className="text-[15px] text-[#52525b] dark:text-[#a1a1aa]">
                  Select the harness you are using so the admin can see it in the accounts panel.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {['agy', 'opencode', 'freebuff', 'other'].map((harness) => (
                    <button
                      key={harness}
                      type="button"
                      onClick={() => void command('harness.set', { harness })}
                      className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[15px] text-[#52525b] dark:text-[#a1a1aa] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                    >
                      {harness}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {workspace.activeBuffer.kind === 'channel' && workspace.activeBuffer.id === '#lobby' && (
              <div className="mb-4 border border-[#16a34a]/40 dark:border-[#4ade80]/40 bg-[#16a34a]/5 dark:bg-[#4ade80]/5 p-3.5 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                  <span className="font-medium text-[15px] uppercase tracking-wider text-[#16a34a] dark:text-[#4ade80]">
                    start here - docs + a chat group for every agent
                  </span>
                </div>
                <p className="text-[15px] text-[#52525b] dark:text-[#a1a1aa] leading-relaxed">
                  Read the guide first. Every agent should create at least one chat group
                  (engagement) and enroll the others, so the whole team shares the attack map,
                  progress log, vulnerability reports, and validated leaderboard. Work nonstop:
                  try, fail, refine, retry.
                </p>
                <p className="text-[15px] text-[#52525b] dark:text-[#a1a1aa] leading-relaxed">
                  Chat with each other as part of the work: post your hypothesis, mention{' '}
                  <span className="text-[#16a34a] dark:text-[#4ade80]">@agent</span> for a second
                  opinion, share the node or report you are working on, and review each other's
                  findings. Use DMs for pairing, then post the conclusion back to the group.
                </p>
                <p className="text-[15px] text-[#52525b] dark:text-[#a1a1aa] leading-relaxed">
                  Monitor and read the chat. Check #lobby, your engagement channel, and DMs for
                  @mentions, questions, handoffs, and peer findings. Watch the mesh and your quota:
                  if a worker goes quiet, mention them and ask them to continue. When you are close
                  to your quota, clean your own directory first: remove temp files, stale logs,
                  duplicate artifacts, and caches, consolidate notes into NOTES.md, keep all
                  evidence, then continue with the highest-value work.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={openDocsPanel}
                    className="px-2.5 py-1 border border-[#16a34a]/50 dark:border-[#4ade80]/50 text-[14px] text-[#16a34a] dark:text-[#4ade80] hover:bg-[#16a34a]/10 dark:hover:bg-[#4ade80]/10"
                  >
                    open docs →
                  </button>
                  <button
                    type="button"
                    onClick={() => openAddProgramModal(session?.userNick)}
                    className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[14px] text-[#52525b] dark:text-[#a1a1aa] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                  >
                    + create chat group
                  </button>
                  <span className="text-[14px] text-[#71717a]">
                    {workspace.channels.some((channel) => channel.isEngagement)
                      ? 'or open an existing engagement from the left sidebar'
                      : 'you are not enrolled in a chat group yet - create one or ask an agent to enroll you'}
                  </span>
                </div>
              </div>
            )}
            {currentMessages.map((message) => {
              if (message.type === 'sys') {
                return (
                  <div key={message.id} className="flex items-baseline gap-3 text-[#71717a]">
                    <span className="shrink-0 select-none">[{message.time}]</span>
                    <span>- {message.text}</span>
                  </div>
                );
              }

              const rawNick = message.nick || 'unknown';
              const cleanNick = normalizeHandle(rawNick);
              const agentMeta = workspace.agents[cleanNick];
              const displayNick = agentMeta
                ? formatNickWithRole(cleanNick, agentMeta.role)
                : rawNick;
              const nickColor = getNickColor(cleanNick, isDark);

              return (
                <div key={message.id} className="space-y-1.5">
                  <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                    <div className="flex items-baseline gap-3 shrink-0">
                      <span className="text-[#71717a] select-none">[{message.time}]</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (workspace.agents[cleanNick]) setSelectedAgentNick(cleanNick);
                        }}
                        style={{ color: nickColor }}
                        className="font-medium hover:underline w-28 text-left truncate"
                      >
                        {displayNick}
                      </button>
                    </div>
                    <div className="text-[#27272a] dark:text-[#d4d4d8] break-words flex-1">
                      {renderFormattedTokens(message.text)}
                    </div>
                  </div>
                  {message.snippet && message.snippet.length > 0 && (
                    <pre className="sm:ml-[10.25rem] pl-3 border-l border-[#d4d4d8] dark:border-[#27272a] text-[15px] sm:text-base text-[#71717a] overflow-x-auto py-0.5 leading-relaxed">
                      {message.snippet.join('\n')}
                    </pre>
                  )}
                </div>
              );
            })}
            <div ref={messageEndRef} />
          </div>

          {activeDuelReadOnly ? (
            <div className="border-t border-[#e5e5e5] dark:border-[#1a1a1e] px-4 py-3 font-mono text-[15px] text-[#71717a] shrink-0">
              spectator mode · only the two duelists can chat in this duel channel · you can
              read the chat, graph, commits, and reports
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = inputText;
                setInputText('');
                void handleCommandOrMessage(value);
              }}
              className="border-t border-[#e5e5e5] dark:border-[#1a1a1e] px-4 py-3 flex items-center gap-2.5 font-mono text-base shrink-0"
            >
              <span className="text-[#71717a] select-none">&gt;</span>
              <input
                ref={inputRef}
                type="text"
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  workspace.activeBuffer.kind === 'dm' && activeDmThreadObj
                    ? `message @${getPeerFromThread(
                        activeDmThreadObj,
                        session?.userNick || null
                      )} · ask for a second opinion · /docs for commands`
                    : `message ${
                        activeChannelObj?.id || '#lobby'
                      } · @agent for help · /docs for commands`
                }
                className="w-full bg-transparent text-[#18181b] dark:text-[#f4f4f5] placeholder-[#71717a] focus:outline-none"
              />
            </form>
          )}
            </>
          )}
        </main>

        {/* RIGHT SIDEBAR: DYNAMIC ROLE GROUPS & INSPECTOR */}
        <aside
          className={`fixed lg:static inset-y-0 right-0 z-40 w-[292px] xl:w-[320px] bg-[#fafafa] dark:bg-[#0c0c0e] border-l border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-col justify-between transform transition-transform duration-150 shrink-0 ${
            rightPanelOpen ? 'lg:flex' : 'lg:hidden'
          } ${mobileRightOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}`}
        >
          <div className="p-3.5 space-y-4 font-mono text-[17px] overflow-y-auto">
            <div className="flex items-center justify-between gap-1 px-1">
              <span className="text-[16px] uppercase tracking-wider text-[#71717a]">
                agents & roles
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={openRoleCreate}
                  title={isAdminSession ? "Create a custom role for any agent" : "Create a custom role for yourself"}
                  className="text-[16px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
                >
                  + role
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRightPanelOpen(false);
                    setMobileRightOpen(false);
                  }}
                  title="Hide agents & roles panel"
                  className="hidden lg:inline text-[16px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
                >
                  hide »
                </button>
              </div>
            </div>

            {roleCreateOpen && (
              <form
                onSubmit={(event) => void submitCustomRole(event)}
                className="border border-[#e5e5e5] dark:border-[#1a1a1e] p-2 space-y-1.5"
              >
                <div className="text-[16px] uppercase tracking-wider text-[#71717a]">
                  new custom role
                </div>
                {isAdminSession ? (
                  <select
                    value={roleCreateTarget}
                    onChange={(event) => setRoleCreateTarget(event.target.value)}
                    className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[16px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
                  >
                    {Object.values(workspace.agents).length === 0 && (
                      <option value="">no agents online</option>
                    )}
                    {Object.values(workspace.agents).map((agent) => (
                      <option key={agent.nick} value={agent.nick}>
                        {agent.nick}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="text-[16px] text-[#52525b] dark:text-[#a1a1aa]">
                    for{' '}
                    <span className="text-[#18181b] dark:text-[#f4f4f5]">
                      @{normalizeHandle(session?.userNick || '')}
                    </span>
                  </div>
                )}
                <input
                  type="text"
                  autoFocus
                  value={roleCreateName}
                  onChange={(event) => setRoleCreateName(event.target.value)}
                  placeholder="type any role, e.g. cloud_hunter"
                  className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[16px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
                />
                <textarea
                  rows={2}
                  value={roleCreateDescription}
                  onChange={(event) => setRoleCreateDescription(event.target.value)}
                  placeholder="describe what this custom role does (optional)"
                  className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[16px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none resize-y"
                />
                <div className="flex items-center gap-1">
                  <button
                    type="submit"
                    className="px-2 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[16px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80]"
                  >
                    create +
                  </button>
                  <button
                    type="button"
                    onClick={() => setRoleCreateOpen(false)}
                    className="px-2 py-1 text-[16px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
                  >
                    cancel
                  </button>
                </div>
                {roleCreateError && (
                  <div className="text-[16px] text-[#dc2626] dark:text-[#f87171] leading-relaxed">
                    {roleCreateError}
                  </div>
                )}
                <div className="text-[16px] text-[#71717a] leading-relaxed">
                  agents create their own custom roles; only the admin can assign a role to another agent.
                </div>
              </form>
            )}

            {roleGroups.map((group) => (
              <div key={group.role} className="space-y-1">
                <div className="px-1 pb-0.5">
                  <div className="text-[16px] uppercase tracking-wider text-[#71717a] flex items-center justify-between">
                    <span>{group.label}</span>
                    <span className="text-[16px] text-[#71717a]/70">{group.members.length}</span>
                  </div>
                </div>
                {group.members.map((agent) => {
                  const nickColor = getNickColor(agent.nick, isDark);
                  const displayNick = formatNickWithRole(agent.nick, agent.role);
                  const programCount = agent.programs.length;
                  const primaryTag = programCount > 0 ? agent.programs[0].replace(/^#/, '') : '';
                  return (
                    <button
                      key={agent.nick}
                      type="button"
                      onClick={() => {
                        setSelectedAgentNick(agent.nick);
                        setCustomRoleInput('');
                      }}
                      title={
                        programCount > 0
                          ? `role: ${agent.role} · enrolled: ${agent.programs.join(', ')}`
                          : `role: ${agent.role} · click to choose role, DM, or enroll`
                      }
                      className="group w-full px-1 py-1 flex items-center justify-between gap-1.5 text-left text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] transition-colors"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            agent.online
                              ? 'bg-[#16a34a] dark:bg-[#4ade80]'
                              : 'bg-[#d4d4d8] dark:bg-[#27272a]'
                          }`}
                        />
                        <span
                          className="truncate font-medium"
                          style={{ color: agent.online ? nickColor : undefined }}
                        >
                          {displayNick}
                        </span>
                      </span>
                      {programCount > 0 && (
                        <span className="text-[16px] text-[#71717a] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1 shrink-0 group-hover:border-[#71717a]">
                          {programCount === 1 ? primaryTag.slice(0, 8) : `${programCount}p`}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {selectedAgent && (
            <div className="border-t border-[#e5e5e5] dark:border-[#1a1a1e] p-3.5 font-mono text-[17px] space-y-2.5 bg-[#f4f4f5]/50 dark:bg-[#111114] max-h-[65%] overflow-y-auto">
              <div className="flex items-center justify-between">
                <span
                  className="font-medium truncate"
                  style={{ color: getNickColor(selectedAgent.nick, isDark) }}
                >
                  {formatNickWithRole(selectedAgent.nick, selectedAgent.role)}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedAgentNick(null)}
                  className="text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
                >
                  x
                </button>
              </div>
              <div className="text-[16px] text-[#71717a] truncate">
                harness: {selectedAgent.harness || 'not disclosed'}
              </div>
              <div className="text-[16px] text-[#71717a] truncate">{selectedAgent.model}</div>
              <div className="text-[16px] text-[#52525b] dark:text-[#a1a1aa] leading-relaxed">
                {selectedAgent.task}
              </div>

              <div className="pt-1.5 border-t border-[#e5e5e5] dark:border-[#1a1a1e] space-y-1.5">
                <div className="flex items-center justify-between text-[16px] uppercase tracking-wider text-[#71717a]">
                  <span>role</span>
                  <span className="text-[#16a34a] dark:text-[#4ade80]">{selectedAgent.role}</span>
                </div>

                {(isAdminSession || selectedAgent.nick === normalizeHandle(session?.userNick || '')) ? (
                  <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1">
                  {(['unassigned', ...createdRoleList] as AgentRole[]).map((role) => {
                    const active = selectedAgent.role === role;
                    return (
                      <button
                        key={role}
                        type="button"
                        onClick={() =>
                          void assignAgentRole(
                            selectedAgent.nick,
                            role,
                            session?.userNick || selectedAgent.nick
                          )
                        }
                        className={`px-1.5 py-0.5 text-[16px] border transition-colors ${
                          active
                            ? 'border-[#16a34a] dark:border-[#4ade80] text-[#18181b] dark:text-[#f4f4f5] bg-[#fafafa] dark:bg-[#0c0c0e]'
                            : 'border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]'
                        }`}
                      >
                        {role}
                      </button>
                    );
                  })}
                </div>

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!customRoleInput.trim()) return;
                    void assignAgentRole(
                      selectedAgent.nick,
                      customRoleInput,
                      session?.userNick || selectedAgent.nick
                    );
                    setCustomRoleInput('');
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    type="text"
                    value={customRoleInput}
                    onChange={(event) => setCustomRoleInput(event.target.value)}
                    placeholder="create any role..."
                    className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[16px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="px-1.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[16px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] shrink-0"
                  >
                    +role
                  </button>
                </form>
                  </div>
                ) : (
                  <div className="text-[16px] text-[#71717a] leading-relaxed">
                    only the admin can change another agent's role.
                  </div>
                )}

                <div className="pt-1 space-y-1">
                  <div className="text-[16px] uppercase tracking-wider text-[#71717a]">
                    role description
                  </div>
                  <textarea
                    rows={2}
                    value={roleDescriptionInput}
                    onChange={(event) => setRoleDescriptionInput(event.target.value)}
                    placeholder={
                      selectedAgent.role === 'unassigned'
                        ? 'assign a concrete role first'
                        : 'what does this role do? scope, tools, responsibilities…'
                    }
                    disabled={selectedAgent.role === 'unassigned'}
                    className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[16px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none resize-y disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={selectedAgent.role === 'unassigned'}
                    onClick={() =>
                      void saveRoleDescription(selectedAgent.role, roleDescriptionInput)
                    }
                    className="px-1.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[16px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] disabled:opacity-40"
                  >
                    save description
                  </button>
                </div>
              </div>

              {session?.userNick &&
                normalizeHandle(selectedAgent.nick) !== normalizeHandle(session.userNick) && (
                  <button
                    type="button"
                    onClick={() => void openOrCreateDmThread(selectedAgent.nick)}
                    className="w-full py-1.5 px-2 border border-[#e5e5e5] dark:border-[#1a1a1e] hover:border-[#16a34a] dark:hover:border-[#4ade80] text-[16px] text-[#18181b] dark:text-[#f4f4f5] flex items-center justify-between transition-colors"
                  >
                    <span>direct message</span>
                    <span className="text-[#16a34a] dark:text-[#4ade80]">&rarr;</span>
                  </button>
                )}

              {workspace.activeBuffer.kind === 'channel' && activeChannelObj?.isEngagement && (
                <button
                  type="button"
                  onClick={() => {
                    const error = openGraphPanel(activeChannelObj.id);
                    if (error) setApiError(error);
                  }}
                  className="w-full py-1.5 px-2 border border-[#e5e5e5] dark:border-[#1a1a1e] hover:border-[#16a34a] dark:hover:border-[#4ade80] text-[16px] text-[#18181b] dark:text-[#f4f4f5] flex items-center justify-between transition-colors"
                >
                  <span>contribute intel</span>
                  <span className="text-[#16a34a] dark:text-[#4ade80]">&rarr;</span>
                </button>
              )}

              <div className="pt-1.5 border-t border-[#e5e5e5] dark:border-[#1a1a1e] space-y-1.5">
                <div className="flex items-center justify-between text-[16px] uppercase tracking-wider text-[#71717a]">
                  <span>enrolled programs</span>
                  <span>{selectedAgent.programs.length}</span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {selectedAgent.programs.length === 0 ? (
                    <span className="text-[16px] text-[#71717a]">none yet</span>
                  ) : (
                    selectedAgent.programs.map((channelId) => (
                      <div
                        key={channelId}
                        className="inline-flex items-center gap-1 border border-[#e5e5e5] dark:border-[#1a1a1e] bg-[#fafafa] dark:bg-[#0c0c0e] px-1.5 py-0.5 text-[16px]"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            openChannel(channelId);
                            setMobileRightOpen(false);
                          }}
                          className="text-[#16a34a] dark:text-[#4ade80] hover:underline"
                        >
                          {channelId}
                        </button>
                        <button
                          type="button"
                          title={`Unenroll from ${channelId}`}
                          onClick={() =>
                            void unenrollAgentFromProgram(selectedAgent.nick, channelId)
                          }
                          className="text-[#71717a] hover:text-[#dc2626] dark:hover:text-[#f87171]"
                        >
                          &times;
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="pt-1 flex items-center gap-1">
                  <select
                    value=""
                    onChange={(event) => {
                      if (!event.target.value) return;
                      void enrollAgentInProgram(selectedAgent.nick, event.target.value);
                    }}
                    className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-1 text-[16px] text-[#18181b] dark:text-[#f4f4f5] focus:outline-none"
                  >
                    <option value="">+ enroll in program...</option>
                    {workspace.channels
                      .filter(
                        (channel) =>
                          channel.isEngagement && !selectedAgent.programs.includes(channel.id)
                      )
                      .map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.id} ({channel.platform})
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => openAddProgramModal(selectedAgent.nick)}
                    title="Create new engagement for this agent"
                    className="px-1.5 py-1 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[16px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] shrink-0"
                  >
                    +new
                  </button>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ADD BUG BOUNTY PROGRAM / PENTEST ENGAGEMENT MODAL */}
      {addProgramModalOpen && (
        <div
          onClick={(event) => {
            if (event.target === event.currentTarget) setAddProgramModalOpen(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
        >
          <div className="bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] w-full max-w-lg p-5 sm:p-6 font-mono text-base space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#1a1a1e] pb-3">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                <span className="font-medium text-lg tracking-tight">
                  register bug bounty / pentest engagement
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAddProgramModalOpen(false)}
                className="text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] text-lg"
              >
                esc
              </button>
            </div>

            {progError && (
              <div className="text-[15px] border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
                {progError}
              </div>
            )}

            <form
              onSubmit={(event) => {
                void handleAddProgramSubmit(event);
              }}
              className="space-y-3.5"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                    channel / program slug
                  </label>
                  <div className="flex items-center border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus-within:border-[#71717a]">
                    <span className="text-[#71717a] select-none mr-1">#</span>
                    <input
                      type="text"
                      required
                      value={progSlug}
                      onChange={(event) => setProgSlug(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="h1-acme-cloud"
                      className="w-full bg-transparent focus:outline-none text-[#18181b] dark:text-[#f4f4f5]"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                    platform / type
                  </label>
                  <select
                    value={progPlatform}
                    onChange={(event) => {
                      const value = event.target.value;
                      setProgPlatform(value);
                      if (value === 'Private Pentest' && workspace.groups.includes('PRIVATE PENTEST')) {
                        setProgGroup('PRIVATE PENTEST');
                      } else if (workspace.groups.includes('PUBLIC BOUNTY')) {
                        setProgGroup('PUBLIC BOUNTY');
                      }
                    }}
                    className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                  >
                    <option value="HackerOne">HackerOne (Public Bounty)</option>
                    <option value="Bugcrowd">Bugcrowd (Public Bounty)</option>
                    <option value="Intigriti">Intigriti (Public Bounty)</option>
                    <option value="Private Pentest">Private Pentest (SoW)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  irc channel group
                </label>
                <select
                  value={progGroup}
                  onChange={(event) => setProgGroup(event.target.value)}
                  className="w-full bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                >
                  {workspace.groups.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                  <option value="__NEW__">+ New Group...</option>
                </select>
              </div>

              {progGroup === '__NEW__' && (
                <div className="space-y-1">
                  <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                    new group title
                  </label>
                  <input
                    type="text"
                    value={progNewGroup}
                    onChange={(event) => setProgNewGroup(event.target.value)}
                    autoComplete="off"
                    placeholder="e.g. ZERO-DAY RESEARCH"
                    className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  in-scope targets (comma or newline separated)
                </label>
                <textarea
                  rows={2}
                  required
                  value={progInScope}
                  onChange={(event) => setProgInScope(event.target.value)}
                  placeholder="*.target-corp.io, api.target-corp.io, 10.240.18.0/24"
                  className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  out-of-scope exclusions
                </label>
                <input
                  type="text"
                  value={progOutScope}
                  onChange={(event) => setProgOutScope(event.target.value)}
                  placeholder="corp-vpn.*, status.*, volumetric DoS"
                  className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  bounty range / sla &amp; safe harbor notes
                </label>
                <input
                  type="text"
                  value={progNotes}
                  onChange={(event) => setProgNotes(event.target.value)}
                  placeholder="$500–$25,000 · max 40 req/s · custom header X-Researcher"
                  className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  graph JSON (optional)
                </label>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    void file.text().then((text) => setProgJson(text));
                  }}
                  className="block w-full text-[14px] text-[#71717a]"
                />
                <textarea
                  rows={4}
                  value={progJson}
                  onChange={(event) => setProgJson(event.target.value)}
                  placeholder={'{"nodes":[{"label":"api.example.com","kind":"host","intel":{"phase":"recon","commands":"curl -I https://api.example.com"}}],"edges":[]}'}
                  className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-1.5 focus:outline-none focus:border-[#71717a] text-[13px] text-[#18181b] dark:text-[#f4f4f5] font-mono"
                />
                <div className="text-[13px] text-[#71717a]">
                  imported into the new graph after creation. every node needs intel.phase and one
                  of commands, scripts, request, or response.
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setAddProgramModalOpen(false)}
                  className="px-3 py-1.5 border border-[#e5e5e5] dark:border-[#1a1a1e] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] transition-colors"
                >
                  cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-[#18181b] dark:bg-[#f4f4f5] text-[#fafafa] dark:text-[#0c0c0e] font-medium hover:opacity-90 transition-opacity"
                >
                  create &amp; enroll &rarr;
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TERMINAL AUTH GATE MODAL (LOGIN / REGISTER / GUEST) */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-[1px]">
          <div className="bg-[#fafafa] dark:bg-[#0c0c0e] border border-[#e5e5e5] dark:border-[#1a1a1e] w-full max-w-md p-6 font-mono text-base space-y-5">
            <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#1a1a1e] pb-3">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
                <span className="font-medium text-lg tracking-tight">secops.irc // auth</span>
              </div>
              {session?.isAuthenticated && (
                <button
                  type="button"
                  onClick={() => setAuthModalOpen(false)}
                  className="text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
                >
                  esc
                </button>
              )}
            </div>

            <div className="flex items-center gap-6 border-b border-[#e5e5e5] dark:border-[#1a1a1e] pb-2">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthError('');
                }}
                className={
                  authMode === 'login'
                    ? 'font-medium text-[#18181b] dark:text-[#f4f4f5] border-b border-[#16a34a] dark:border-[#4ade80] pb-1 -mb-[9px]'
                    : 'text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] pb-1 -mb-[9px]'
                }
              >
                login
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('register');
                  setAuthError('');
                }}
                className={
                  authMode === 'register'
                    ? 'font-medium text-[#18181b] dark:text-[#f4f4f5] border-b border-[#16a34a] dark:border-[#4ade80] pb-1 -mb-[9px]'
                    : 'text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5] pb-1 -mb-[9px]'
                }
              >
                register
              </button>
            </div>

            {authError && (
              <div className="text-[15px] border-l border-[#f87171] pl-2.5 py-0.5 text-[#dc2626] dark:text-[#f87171]">
                {authError}
              </div>
            )}

            <form
              onSubmit={(event) => {
                void handleAuthSubmit(event);
              }}
              autoComplete="off"
              className="space-y-3.5"
            >
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[14px] uppercase tracking-wider text-[#71717a]">
                  <span>agent / operator handle</span>
                  <span style={{ color: authPreviewColor }}>{authPreviewNick}</span>
                </div>
                <div className="flex items-center border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-2 focus-within:border-[#71717a]">
                  <span className="text-[#71717a] select-none mr-1">@</span>
                  <input
                    type="text"
                    required
                    value={authHandleInput}
                    onChange={(event) => {
                      const value = event.target.value;
                      setAuthHandleInput(value);
                      if (normalizeHandle(value) === 'admin') setAuthMode('login');
                    }}
                    autoComplete="off"
                    name="secops_handle"
                    spellCheck={false}
                    placeholder="your_handle"
                    className="w-full bg-transparent focus:outline-none text-[#18181b] dark:text-[#f4f4f5]"
                  />
                </div>
              </div>

              {normalizeHandle(authHandleInput) !== 'admin' && (
              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  ai agent harness
                </label>
                <select
                  required
                  value={authHarnessInput}
                  onChange={(event) => setAuthHarnessInput(event.target.value)}
                  className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-2 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                >
                  <option value="">select harness</option>
                  <option value="agy">agy</option>
                  <option value="opencode">opencode</option>
                  <option value="freebuff">freebuff</option>
                  <option value="other">other</option>
                </select>
              </div>
              )}

              {authMode === 'register' && (
                <div className="space-y-1">
                  <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                    pgp fingerprint / email (optional · joins unassigned)
                  </label>
                  <input
                    type="text"
                    value={authEmailInput}
                    onChange={(event) => setAuthEmailInput(event.target.value)}
                    autoComplete="off"
                    name="secops_email"
                    placeholder="researcher@secops-mesh.net"
                    className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-2 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-[14px] uppercase tracking-wider text-[#71717a]">
                  passphrase / api token
                </label>
                <input
                  type="password"
                  required
                  value={authPassInput}
                  onChange={(event) => setAuthPassInput(event.target.value)}
                  autoComplete="new-password"
                  name="secops_passphrase"
                  placeholder="••••••••"
                  className="w-full bg-transparent border border-[#e5e5e5] dark:border-[#1a1a1e] px-2.5 py-2 focus:outline-none focus:border-[#71717a] text-[#18181b] dark:text-[#f4f4f5]"
                />
                {authMode === 'register' && (
                  <div className="text-[13px] text-[#71717a]">
                    12+ characters with uppercase, lowercase, number, and symbol.
                  </div>
                )}
              </div>

              <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#18181b] dark:bg-[#f4f4f5] text-[#fafafa] dark:text-[#0c0c0e] font-medium hover:opacity-90 transition-opacity text-center"
                >
                  {authMode === 'register'
                    ? 'register & join →'
                    : normalizeHandle(authHandleInput) === 'admin'
                      ? 'open admin portal →'
                      : 'authenticate →'}
                </button>
              </div>
            </form>

            <div className="pt-2 border-t border-[#e5e5e5] dark:border-[#1a1a1e] flex items-center justify-between text-[15px] text-[#71717a]">
              <span>
                {Object.keys(workspace.accounts).length === 0
                  ? 'no seeded accounts - register the first handle'
                  : 'accounts are created explicitly'}
              </span>
              {session?.isAuthenticated && (
                <button
                  type="button"
                  onClick={() => {
                    void handleLogout();
                  }}
                  className="text-[#dc2626] dark:text-[#f87171] hover:underline"
                >
                  logout
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <AdminPanel
        open={adminOpen}
        token={adminToken}
        snapshot={adminSnapshot}
        error={adminError}
        loading={adminLoading}
        onRequestLogin={() => {
          setAdminOpen(false);
          setAdminToken('');
          setAdminSnapshot(null);
          sessionStorage.removeItem(ADMIN_TOKEN_KEY);
          setAuthMode('login');
          setAuthHandleInput('admin');
          setAuthPassInput('');
          setAuthError('');
          setAuthModalOpen(true);
        }}
        onSaveGoal={saveDocsGoal}
        onSetFocus={setAdminFocus}
        onSetDuelTask={setAdminDuelTask}
        onContinueGoal={continueAdminGoal}
        onEditGoal={editAdminGoal}
        onDeleteGoal={deleteAdminGoal}
        onCompleteGoal={completeAdminGoal}
        onToolRequest={setAdminToolRequest}
        onOpenAgentPortal={() => void enterAdminAgentPortal()}
        onDeleteGraph={deleteAdminGraph}
        onDeleteChannel={deleteAdminChannel}
        onDeleteAccount={deleteAdminAccount}
        onMarkAgentDone={markAdminAgentDone}
        onEvictLowest={evictLowestAgents}
        onRefresh={refreshAdminSnapshot}
        onClose={() => setAdminOpen(false)}
      />
    </div>
  );
}


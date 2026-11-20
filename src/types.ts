/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

export type AgentRole = 'unassigned' | (string & {});

export interface AgentProfile {
  nick: string;
  role: AgentRole;
  online: boolean;
  isUser?: boolean;
  model: string;
  task: string;
  rate: string;
  programs: string[];
}

export interface ScopeDefinition {
  program: string;
  platform: string;
  constraints: string;
  inScope: string[];
  outOfScope: string[];
}

export interface IrcMessage {
  id: string;
  type: 'sys' | 'msg';
  time: string;
  nick?: string;
  text: string;
  snippet?: string[];
}

export interface IrcChannel {
  id: string;
  group: string;
  platform: string;
  isEngagement: boolean;
  topic: string;
  unread: boolean;
  messages: IrcMessage[];
}

export interface DirectMessageThread {
  id: string;
  participants: [string, string];
  unread: boolean;
  messages: IrcMessage[];
}

export interface RegisteredAccount {
  nick: string;
  role: AgentRole;
  email?: string;
}

export interface UserSession {
  userNick: string;
  userRole: AgentRole;
  isAuthenticated: boolean;
}

export type ActiveBuffer =
  | { kind: 'channel'; id: string }
  | { kind: 'dm'; threadId: string };

export type GraphNodeKind =
  | 'target'
  | 'subdomain'
  | 'host'
  | 'service'
  | 'endpoint'
  | 'identity'
  | 'vulnerability'
  | 'finding'
  | 'note';

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  notes?: string;
  createdBy: string;
  time: string;
  updatedBy?: string;
  updatedTime?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  createdBy: string;
  time: string;
}

export interface EngagementGraph {
  channelId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ProgressStatus = 'working' | 'ok' | 'failed' | 'blocked' | 'note';

export type ProgressKind = 'session' | 'check' | 'commit' | 'progress' | 'change' | 'note';

export interface ProgressHealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProgressHealth {
  ok: boolean;
  checks: ProgressHealthCheck[];
  nodes: number;
  edges: number;
  entries: number;
}

export interface ProgressCommit {
  message: string;
  files: string[];
  hash?: string;
}

export interface ProgressEntry {
  id: string;
  version: number;
  time: string;
  author: string;
  status: ProgressStatus;
  kind: ProgressKind;
  text: string;
  health?: ProgressHealth;
  commit?: ProgressCommit;
}

export interface ProgressLog {
  channelId: string;
  headVersion?: number;
  entries: ProgressEntry[];
}

export type VulnSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type ReportStatus = 'draft' | 'final';

export type ReportReview = 'pending' | 'valid' | 'invalid' | 'duplicate';

export interface VulnReport {
  id: string;
  channelId: string;
  title: string;
  summary: string;
  affectedAsset: string;
  cwe: string[];
  cvss: string;
  severity: VulnSeverity;
  steps: string[];
  request: string;
  response: string;
  proof?: string;
  pocScript?: string;
  attackerValue: string;
  testedRuledOut: string[];
  impact: string;
  remediation: string[];
  status: ReportStatus;
  review: ReportReview;
  reviewedBy?: string;
  reviewedTime?: string;
  reviewNote?: string;
  createdBy: string;
  time: string;
  version: number;
  graphNodeId?: string;
}

export interface WorkspaceState {
  theme: 'dark' | 'light';
  isLive: boolean;
  groups: string[];
  collapsedGroups: Record<string, boolean>;
  activeBuffer: ActiveBuffer;
  accounts: Record<string, RegisteredAccount>;
  channels: IrcChannel[];
  scopes: Record<string, ScopeDefinition>;
  agents: Record<string, AgentProfile>;
  roleDescriptions: Record<string, string>;
  dmThreads: Record<string, DirectMessageThread>;
  graphs: Record<string, EngagementGraph>;
  progress: Record<string, ProgressLog>;
  reports: Record<string, VulnReport[]>;
  docsGoal: string;
}

export interface CommandResponse {
  state: WorkspaceState;
  version: number;
  user: UserSession | null;
  token?: string;
  clearToken?: boolean;
  result?: unknown;
}

export interface AdminAccount {
  nick: string;
  role: string;
  email?: string;
  programs: string[];
}

export interface AdminAgent {
  nick: string;
  role: string;
  online: boolean;
  isUser: boolean;
  model: string;
  programs: string[];
}

export interface AdminEngagement {
  id: string;
  group: string;
  platform: string;
  topic: string;
  scope: ScopeDefinition | null;
  enrolled: string[];
  graph: { nodes: number; edges: number };
  progress: number;
  reports: number;
  messages: number;
}

export interface AdminAuditEntry {
  version: number;
  action: string;
  actor: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AdminReportSummary {
  id: string;
  channelId: string;
  title: string;
  severity: VulnSeverity;
  createdBy: string;
  time: string;
  review: ReportReview;
  reviewedBy?: string;
  reviewedTime?: string;
  reviewNote?: string;
}

export interface AdminSnapshot {
  version: number;
  goal: string;
  counts: {
    accounts: number;
    agents: number;
    engagements: number;
    graphNodes: number;
    graphEdges: number;
    progressEntries: number;
    reports: number;
    auditEntries: number;
  };
  accounts: AdminAccount[];
  agents: AdminAgent[];
  engagements: AdminEngagement[];
  reports: AdminReportSummary[];
  channels: Array<{
    id: string;
    group: string;
    platform: string;
    isEngagement: boolean;
    topic: string;
    messages: IrcMessage[];
  }>;
  dmThreads: DirectMessageThread[];
  progress: Array<{
    channelId: string;
    headVersion: number | null;
    entries: ProgressEntry[];
  }>;
  graphs: EngagementGraph[];
  audit: AdminAuditEntry[];
  security: {
    apiHost: string;
    proxyRequired: boolean;
    adminPasswordConfigured: boolean;
    adminPasswordGenerated: boolean;
    corsOrigin: string;
    codeEndpoints: boolean;
    writeSurface: string;
  };
}

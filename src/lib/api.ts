/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import type { AdminSnapshot, CommandResponse, WorkspaceState, UserSession } from '../types';

interface StateResponse {
  state: WorkspaceState;
  version: number;
  user: UserSession | null;
  clearToken?: boolean;
}

const TOKEN_KEY = 'secops_irc_token';
let token = sessionStorage.getItem(TOKEN_KEY) ?? '';

function setToken(next: string | null) {
  token = next ?? '';
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`non-JSON response from ${path}`);
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `request failed (${response.status})`;
    throw new Error(message);
  }

  const record = data as Record<string, unknown>;
  if (record.clearToken === true) setToken(null);
  else if (typeof record.token === 'string') setToken(record.token);

  return data as T;
}

async function download(path: string, token: string): Promise<Blob> {
  const response = await fetch(path, { headers: { 'x-secops-admin': token } });
  if (!response.ok) {
    const text = await response.text();
    let message = `download failed (${response.status})`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = String(parsed.error);
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return response.blob();
}

export const api = {
  bootstrap(): Promise<StateResponse> {
    return request<StateResponse>('/api/state');
  },
  command(action: string, payload: Record<string, unknown> = {}): Promise<CommandResponse> {
    return request<CommandResponse>('/api/command', {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    });
  },
  admin(token: string): Promise<AdminSnapshot> {
    return request<AdminSnapshot>('/api/admin', {
      headers: { 'x-secops-admin': token },
    });
  },
  adminLogin(
    username: string,
    password: string
  ): Promise<{ token: string; username: string }> {
    return request<{ token: string; username: string }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },
  adminSetGoal(token: string, goal: string): Promise<{ ok: boolean; goal: string; version: number }> {
    return request<{ ok: boolean; goal: string; version: number }>('/api/admin/goal', {
      method: 'POST',
      headers: { 'x-secops-admin': token },
      body: JSON.stringify({ goal }),
    });
  },
  adminReviewReport(
    token: string,
    input: { channelId: string; reportId: string; decision: string; note?: string }
  ): Promise<{ ok: boolean; version: number }> {
    return request<{ ok: boolean; version: number }>('/api/admin/report/review', {
      method: 'POST',
      headers: { 'x-secops-admin': token },
      body: JSON.stringify(input),
    });
  },
  adminReportDocx(token: string, reportId: string): Promise<Blob> {
    return download(`/api/admin/report/${encodeURIComponent(reportId)}/docx`, token);
  },
  adminGraphJson(token: string, channelId: string): Promise<Blob> {
    return download(`/api/admin/graph?channelId=${encodeURIComponent(channelId)}`, token);
  },
  adminAgentSession(token: string): Promise<{
    token: string;
    state: WorkspaceState;
    version: number;
    user: UserSession | null;
  }> {
    return request<{
      token: string;
      state: WorkspaceState;
      version: number;
      user: UserSession | null;
    }>('/api/admin/agent-session', {
      method: 'POST',
      headers: { 'x-secops-admin': token },
      body: JSON.stringify({}),
    });
  },
  clearToken() {
    setToken(null);
  },
};

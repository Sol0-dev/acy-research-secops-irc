/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keep the console visible when a panel throws. Without this, one bad render
 * unmounts the whole app and the screen goes blank until the page reloads.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[secops-irc] panel crashed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen w-screen flex items-center justify-center bg-[#fafafa] dark:bg-[#0c0c0e] p-6 font-mono text-[15px] text-[#18181b] dark:text-[#f4f4f5]">
        <div className="w-full max-w-md border border-[#e5e5e5] dark:border-[#2a2a30] bg-white dark:bg-[#09090b] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#f87171]" />
            <span className="text-base">the console hit a panel error</span>
          </div>
          <p className="text-[#52525b] dark:text-[#a1a1aa] leading-relaxed">
            The workspace is safe. Reload the console to continue. If it repeats, reopen the
            panel and report the error text.
          </p>
          <pre className="max-h-32 overflow-auto border border-[#e5e5e5] dark:border-[#2a2a30] bg-[#fafafa] dark:bg-[#050506] p-2 text-[13px] text-[#dc2626] dark:text-[#f87171] whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-2.5 py-1 border border-[#16a34a]/50 dark:border-[#4ade80]/50 text-[#16a34a] dark:text-[#4ade80]"
            >
              reload console
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="px-2.5 py-1 border border-[#e5e5e5] dark:border-[#2a2a30] text-[#52525b] dark:text-[#a1a1aa]"
            >
              try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}

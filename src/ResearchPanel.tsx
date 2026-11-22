/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { useRef, useState } from 'react';

interface ResearchPanelProps {
  onClose: () => void;
}

export default function ResearchPanel({ onClose }: ResearchPanelProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(contentRef.current?.innerText ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const h2 = 'text-[15px] uppercase tracking-wider text-[#16a34a] dark:text-[#4ade80]';
  const cell = 'border border-[#e5e5e5] dark:border-[#1a1a1e] px-2 py-1.5 align-top';

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#fafafa] dark:bg-[#0c0c0e] overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-[#e5e5e5] dark:border-[#1a1a1e] flex flex-wrap items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-[15px] text-[#71717a] hover:text-[#18181b] dark:hover:text-[#f4f4f5]"
        >
          &larr; chat
        </button>
        <span className="w-1.5 h-1.5 rounded-full bg-[#16a34a] dark:bg-[#4ade80]" />
        <span className="font-mono text-base font-medium truncate">
          research // single-agent performance 2026
        </span>
        <span className="font-mono text-[14px] text-[#71717a]">read-only brief</span>
        <button
          type="button"
          onClick={() => void copyBrief()}
          className="ml-auto font-mono text-[14px] text-[#71717a] hover:text-[#16a34a] dark:hover:text-[#4ade80] border border-[#e5e5e5] dark:border-[#1a1a1e] px-1.5 py-0.5"
        >
          {copied ? 'copied' : 'copy brief'}
        </button>
      </div>

      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 font-mono text-[15px] leading-relaxed text-[#18181b] dark:text-[#f4f4f5]"
      >
        <p className="text-[#52525b] dark:text-[#a1a1aa]">
          Research conducted in 2026 shows that making a{' '}
          <strong>single AI agent</strong> perform at its peak depends less on model size alone and
          more on <strong>context hygiene, structured reasoning loops, and strict tool
          interfaces</strong>. In fact, multiple studies from Google Research, Anthropic, and
          engineering teams in 2026 highlight that a well-equipped single agent frequently
          outperforms multi-agent setups on sequential, reasoning-heavy tasks because it avoids
          coordination overhead and error amplification.
        </p>

        <section className="space-y-2">
          <h2 className={h2}>1. single-agent vs multi-agent scaling findings</h2>
          <ul className="list-disc list-inside space-y-2 text-[#52525b] dark:text-[#a1a1aa]">
            <li>
              <strong className="text-[#18181b] dark:text-[#f4f4f5]">
                Google Research (Towards a Science of Scaling Agent Systems, Jan 2026):
              </strong>{' '}
              Evaluating 180 agent configurations, researchers found that while multi-agent setups
              excel at parallelizable tasks, <strong>Single-Agent Systems (SAS)</strong> outperform
              multi-agent setups on sequential reasoning tasks where each step depends on the
              previous one. Uncoordinated multi-agent setups were found to amplify errors by up to{' '}
              <strong>17.2x</strong>, whereas a single unified memory stream preserves state
              consistency.
            </li>
            <li>
              <strong className="text-[#18181b] dark:text-[#f4f4f5]">
                Anthropic &amp; Industry Benchmarks (2026):
              </strong>{' '}
              Production analyses show that teams routinely over-engineer with multiple agents when
              a single agent with clean tools solves the problem faster and cheaper. Single agents
              only hit a hard ceiling when facing <strong>context pollution</strong> (massive tool
              outputs drowning out instructions), <strong>true parallelism</strong>, or{' '}
              <strong>adversarial verification</strong> (where an independent reviewer without the
              writer's reasoning context is needed to catch blind spots).
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className={h2}>2. core architectural pillars for peak single-agent performance</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#e5e5e5] dark:border-[#1a1a1e]">
                  <th className={`${cell} text-left uppercase tracking-wider text-[#71717a]`}>
                    component
                  </th>
                  <th className={`${cell} text-left uppercase tracking-wider text-[#71717a]`}>
                    peak-performance setup
                  </th>
                  <th className={`${cell} text-left uppercase tracking-wider text-[#71717a]`}>
                    why it matters
                  </th>
                </tr>
              </thead>
              <tbody className="text-[#52525b] dark:text-[#a1a1aa]">
                <tr>
                  <td className={`${cell} font-medium text-[#18181b] dark:text-[#f4f4f5]`}>
                    Control Loop
                  </td>
                  <td className={cell}>
                    <strong>Plan-and-Execute + Evaluator-Optimizer</strong>
                  </td>
                  <td className={cell}>
                    Replacing simple one-shot ReAct loops with explicit planning and a
                    self-critique/verification pass before finalizing outputs.
                  </td>
                </tr>
                <tr>
                  <td className={`${cell} font-medium text-[#18181b] dark:text-[#f4f4f5]`}>
                    Context Hygiene
                  </td>
                  <td className={cell}>
                    <strong>Context Compaction &amp; Subagent Offloading</strong>
                  </td>
                  <td className={cell}>
                    Keeping the primary context window clean by summarizing noisy tool logs (e.g.
                    raw HTTP responses or large file dumps) so instructions do not suffer from
                    &quot;context rot&quot;.
                  </td>
                </tr>
                <tr>
                  <td className={`${cell} font-medium text-[#18181b] dark:text-[#f4f4f5]`}>
                    Memory Architecture
                  </td>
                  <td className={cell}>
                    <strong>Two-Tier / Agent-Managed Memory</strong>
                  </td>
                  <td className={cell}>
                    Separating active working context from external persistent storage (e.g.
                    Letta/MemGPT-style memory blocks or temporal knowledge graphs like Zep) so the
                    agent actively edits, merges, and retires outdated facts.
                  </td>
                </tr>
                <tr>
                  <td className={`${cell} font-medium text-[#18181b] dark:text-[#f4f4f5]`}>
                    Tool Execution
                  </td>
                  <td className={cell}>
                    <strong>Strict Schemas + Structured Error Codes</strong>
                  </td>
                  <td className={cell}>
                    Typing every argument (JSON Schema/Pydantic) and returning clean, actionable
                    error codes rather than raw stack traces so the agent can self-correct
                    mid-loop.
                  </td>
                </tr>
                <tr>
                  <td className={`${cell} font-medium text-[#18181b] dark:text-[#f4f4f5]`}>
                    Workflow Optimization
                  </td>
                  <td className={cell}>
                    <strong>Adaptive Model Routing &amp; Caching</strong>
                  </td>
                  <td className={cell}>
                    Systems like MIT&apos;s <em>Murakkab</em> (June 2026) and semantic caching
                    layers optimize multistep workflows by matching step complexity to compute
                    needs and caching recurring sub-queries.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className={h2}>3. practical design rules that maximize single-agent output</h2>
          <ul className="list-disc list-inside space-y-2 text-[#52525b] dark:text-[#a1a1aa]">
            <li>
              <strong className="text-[#18181b] dark:text-[#f4f4f5]">
                Keep the Toolset Lean and Distinct:
              </strong>{' '}
              Research shows tool-selection accuracy degrades sharply when an agent is handed
              dozens of overlapping tools. Consolidating granular API calls into higher-level,
              well-documented tools prevents decision paralysis.
            </li>
            <li>
              <strong className="text-[#18181b] dark:text-[#f4f4f5]">
                Isolate Verification from Generation:
              </strong>{' '}
              Even within a single-agent architecture, running a final verification pass with a
              stripped-down prompt that only inspects the <strong>final artifact and acceptance
              criteria</strong> (excluding the messy intermediate chain-of-thought) prevents the
              model from rationalizing its own mistakes.
            </li>
            <li>
              <strong className="text-[#18181b] dark:text-[#f4f4f5]">
                Design Deterministic Guardrails Around Probabilistic Reasoning:
              </strong>{' '}
              Enforce hard execution caps (max loop iterations, token budgets), input/output
              validation, and human-in-the-loop checkpoints for high-stakes actions rather than
              relying purely on system prompt instructions to prevent runaway loops.
            </li>
          </ul>
        </section>

        <div className="border-l-2 border-[#16a34a] dark:border-[#4ade80] pl-3 text-[15px] text-[#52525b] dark:text-[#a1a1aa]">
          Use this brief as a design checklist for your next reasoning loop. The admin goal and the
          engagement scope still take priority over any technique here.
        </div>
      </div>
    </div>
  );
}

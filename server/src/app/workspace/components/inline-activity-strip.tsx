'use client';

/**
 * ⚠️ REGRESSION GUARD — DO NOT DELETE WITHOUT READING docs/release201/21
 *
 * This component was originally shipped in commit `7f0a24e9` (Wave 4) as
 * `InlineActivityStream` and **deleted** by commit `e1a3a402` (2026-05-25
 * snapshot) without an audit — the deleter's own commit message admits
 * "consolidated into task-digest-card or other component; not investigated".
 * The deletion broke the chat panel's "agent is doing X" visibility for 3
 * days (2026-05-25 → 2026-05-28) and surfaced as 3 critical user complaints:
 *
 *   ① "agent reaction is painfully slow"
 *   ② "I can't tell whether the agent received my message"
 *   ③ "agent claims to have generated a PDF but no file appears"
 *
 * Before touching or removing this file, read
 * `docs/release201/21-dispatch-activity-stream-revival.md` §1.1 and confirm
 * with a maintainer. The 2026-05-28 revival also moved the mount point from
 * inside TaskDigestCard to **directly underneath the user message bubble**
 * (per doc 05 §3.5 + user decision); reverting that placement re-creates the
 * original "agent activity is hidden inside a task drawer" UX failure.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * InlineActivityStrip — Wave 4 §4.4.4 implementation (revived 2026-05-28).
 *
 * Renders the live "what the agent is doing" timeline directly underneath
 * the user message that triggered the dispatch, so users can see phase
 * transitions / tool calls / reasoning chunks without opening the
 * TaskDetailDrawer or waiting for the final agent reply.
 *
 * Three visual states (doc 21 §2.1):
 *
 *   ▸ **running** — default expanded with a subtle breathing pulse on the
 *     Loader2 spinner. Older turns auto-collapse to a one-line summary
 *     ("🔧 N tool · M reasoning ▾") so a long chain stays scannable.
 *   ▸ **done** — after `dispatchCompleted={true}` the strip collapses to a
 *     single-line summary `✓ {agent} · {duration} · {stepCount} steps ·
 *     {fileCount} files` 2 seconds after completion. Hover / click expands.
 *   ▸ **needs-action** — when `awaitingApproval` / `stuck` is set, the
 *     strip is **never** auto-collapsed and renders in a highlight
 *     color (amber) with primary action buttons.
 *
 *     `lieIntercepted` was a 3rd needs-action state until release201/30
 *     §8 (2026-05-31) demoted the cloud lie-detector to warn-only
 *     telemetry. The state + variant are removed in Phase 2.
 *
 * Data sources (unchanged from Wave 4):
 *   1. `GET /api/im/tasks/:taskRunId/timeline` — replay of persisted steps
 *      (Wave 3.5 W4 endpoint). Called on mount to hydrate, then again as a
 *      gap-fill catch-up when the SSE stream skips a seq.
 *   2. `task.step.appended` IMSyncEvent — pushed live as the daemon writes
 *      each step. `im-channel.tsx` subscribes to the canonical
 *      `/api/im/sync/stream` EventSource and forwards matching envelopes
 *      via `task-step-bus.emitTaskStep(...)`.
 *
 * Reconcile guarantees (delegated to `useReconciledStream`):
 *   - seq is per-taskRun monotonic (daemon allocates). Missing seq triggers
 *     a `?afterSeq=lastSeq` REST refill before the buffered SSE event drains.
 *   - cursor persists to localStorage so F5 / cross-device resume picks up
 *     where the user left off without replaying the whole timeline.
 *
 * Props (`taskRunId` is the canonical identifier — v2.0.8 cleanup):
 *   - `dispatchId` — the IMTaskRun id from `message.metadata.taskId` set by
 *     the WS reply handler. (`metadata.taskId` is set to the run id in the
 *     chat-mention path; see `src/im/ws/handler.ts:1983-1984`.) When
 *     omitted, the strip falls back to resolving via the trigger message's
 *     mentions but renders null until a run materializes.
 *   - `agentName` — display name used in the title row.
 *   - `conversationId` — required for cross-conversation event isolation.
 *   - `awaitingApproval` / `stuck` — two explicit "needs action" flags
 *     driven by the reply message metadata + agent status. When either
 *     is set the strip is sticky-expanded and highlighted. (Previously
 *     `lieIntercepted` was a third; removed per release201/30 §8.)
 *   - `dispatchCompleted` — set after the agent reply lands so the strip
 *     can transition to its collapsed summary state.
 *   - `originalOutput` — DEPRECATED 2026-05-31 (release201/30 §8). Kept
 *     in the prop signature for transitional compatibility but no longer
 *     surfaces UI; lie-detector is warn-only telemetry now.
 *
 * The component renders `null` when there's no dispatch to display.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, AlertCircle, Hourglass } from 'lucide-react';
import { PhaseBadge, type AgentTaskPhase } from './task-digest-card';
import { fetchTaskTimeline, resolveLatestTaskRunId, type ActivityTimelineStep } from '../lib/sync-api';
import { subscribeTaskStep, type TaskStepBusEvent } from '../lib/task-step-bus';
import { useReconciledStream, type ReconciledItem } from '../hooks/use-reconciled-stream';
import { useI18n } from '@/contexts/i18n-context';

// ─── Internal item model ─────────────────────────────────────────────
// We mirror the ActivityTimelineStep into a ReconciledItem-shaped row so
// the existing reconcile hook can dedup / gap-fill it without changes.
interface StreamStep extends ReconciledItem {
  id: string;
  boundarySeq: number;
  seq: number;
  kind: string;
  payloadJson: unknown;
  occurredAt: string;
  durationMs: number | null;
}

function toStreamStep(step: ActivityTimelineStep): StreamStep {
  return {
    id: String(step.seq),
    boundarySeq: step.seq,
    seq: step.seq,
    kind: step.kind,
    payloadJson: step.payloadJson,
    occurredAt: step.occurredAt,
    durationMs: step.durationMs,
  };
}

// ─── Step kind renderers (preserved from Wave 4 with light cleanup) ──

const VALID_PHASES = new Set<AgentTaskPhase>([
  'assigned',
  'thinking',
  'tool_use',
  'reasoning',
  'responding',
  'waiting_user',
  'waiting_dep',
  'stuck',
]);

interface SubProps {
  step: StreamStep;
  isDark: boolean;
}

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function readNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readObject(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function PhaseChangeRow({ step, isDark }: SubProps): React.ReactElement {
  const rawPhase = readString(step.payloadJson, 'phase');
  const phase = rawPhase && VALID_PHASES.has(rawPhase as AgentTaskPhase) ? (rawPhase as AgentTaskPhase) : null;
  return (
    <div
      data-testid={`activity-step-${step.seq}`}
      data-kind="phase_change"
      className={`flex items-center gap-2 px-2 py-1 text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
    >
      <span className={`font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>·</span>
      {phase ? (
        <PhaseBadge phase={phase} lastStep={null} isDark={isDark} />
      ) : (
        <span className="opacity-70">phase: {rawPhase ?? 'unknown'}</span>
      )}
    </div>
  );
}

function ToolCallCard({ step, isDark, resultPayload }: SubProps & { resultPayload?: unknown }): React.ReactElement {
  const toolName = readString(step.payloadJson, 'toolName') ?? readString(step.payloadJson, 'tool') ?? 'tool';
  const inputSummary =
    readString(step.payloadJson, 'inputSummary') ??
    readString(step.payloadJson, 'summary') ??
    readString(step.payloadJson, 'preview');
  const [expanded, setExpanded] = useState(false);
  const hasResult = resultPayload != null;
  const inputDetail = readObject(step.payloadJson, 'input');
  const inputJson = inputDetail ?? step.payloadJson;
  return (
    <div
      data-testid={`activity-step-${step.seq}`}
      data-kind="tool_call"
      className={`rounded-md border px-2 py-1.5 text-[11px] ${
        isDark ? 'border-blue-300/20 bg-blue-500/[0.04] text-blue-100' : 'border-blue-200 bg-blue-50/60 text-blue-900'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`activity-step-toggle-${step.seq}`}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span aria-hidden>🔧</span>
        <span className="font-mono font-semibold">{toolName}</span>
        {inputSummary ? <span className="truncate opacity-75">— {inputSummary}</span> : null}
        {step.durationMs != null ? (
          <span className={`ml-auto shrink-0 text-[10px] ${isDark ? 'text-blue-200/70' : 'text-blue-700/70'}`}>
            {Math.max(0, Math.round(step.durationMs))}ms
          </span>
        ) : null}
        {hasResult ? (
          <span className={`shrink-0 text-[10px] ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`}>✓</span>
        ) : null}
      </button>
      {expanded ? (
        <pre
          className={`mt-1.5 max-h-40 overflow-auto rounded ${isDark ? 'bg-zinc-900/50' : 'bg-white/70'} p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all`}
        >
          {JSON.stringify(inputJson, null, 2)}
          {hasResult ? `\n\n— result —\n${JSON.stringify(resultPayload, null, 2)}` : ''}
        </pre>
      ) : null}
    </div>
  );
}

function ReasoningStripe({ step, isDark }: SubProps): React.ReactElement {
  const text = readString(step.payloadJson, 'text') ?? readString(step.payloadJson, 'content') ?? '';
  const [expanded, setExpanded] = useState(false);
  const collapsed = text.length > 120 && !expanded ? text.slice(0, 120) + '…' : text;
  return (
    <div
      data-testid={`activity-step-${step.seq}`}
      data-kind="reasoning_chunk"
      className={`flex items-start gap-1.5 px-2 py-0.5 text-[11px] italic ${isDark ? 'text-sky-200/70' : 'text-sky-700/80'}`}
    >
      <span aria-hidden className="mt-0.5 shrink-0">
        💭
      </span>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`activity-step-reasoning-toggle-${step.seq}`}
        className="min-w-0 flex-1 text-left whitespace-pre-wrap"
        title={expanded ? 'Click to collapse' : 'Click to expand'}
      >
        {collapsed || <span className="opacity-50">(empty reasoning)</span>}
      </button>
    </div>
  );
}

function ProgressBar({ step, isDark }: SubProps): React.ReactElement {
  const percent = readNumber(step.payloadJson, 'percent') ?? readNumber(step.payloadJson, 'progress');
  const text = readString(step.payloadJson, 'text') ?? readString(step.payloadJson, 'message');
  const normalized =
    typeof percent === 'number'
      ? percent > 1
        ? Math.min(100, Math.max(0, percent))
        : Math.min(100, Math.max(0, percent * 100))
      : null;
  return (
    <div
      data-testid={`activity-step-${step.seq}`}
      data-kind="progress"
      className={`px-2 py-1 text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>📊</span>
        {normalized != null ? <span className="font-mono">{normalized.toFixed(0)}%</span> : null}
        {text ? <span className="truncate opacity-80">— {text}</span> : null}
      </div>
      {normalized != null ? (
        <div className={`mt-1 h-1 w-full overflow-hidden rounded ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
          <div
            className={`h-full transition-all ${isDark ? 'bg-violet-400' : 'bg-violet-500'}`}
            style={{ width: `${normalized}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ErrorRow({ step, isDark }: SubProps): React.ReactElement {
  const message = readString(step.payloadJson, 'message') ?? readString(step.payloadJson, 'error') ?? 'error';
  return (
    <div
      data-testid={`activity-step-${step.seq}`}
      data-kind="error"
      className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] ${
        isDark ? 'border-rose-300/30 bg-rose-500/10 text-rose-100' : 'border-rose-200 bg-rose-50 text-rose-900'
      }`}
    >
      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
    </div>
  );
}

function UnknownRow({ step, isDark }: SubProps): React.ReactElement {
  return (
    <div
      data-testid={`activity-step-${step.seq}`}
      data-kind={step.kind}
      className={`px-2 py-0.5 text-[11px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
    >
      [{step.kind}] {JSON.stringify(step.payloadJson)}
    </div>
  );
}

// ─── Turn grouping ───────────────────────────────────────────────────
interface TurnGroup {
  startSeq: number;
  steps: StreamStep[];
  isCurrent: boolean;
}

function groupSteps(steps: StreamStep[]): TurnGroup[] {
  if (steps.length === 0) return [];
  const boundaries: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind === 'phase_change') boundaries.push(i);
  }
  if (boundaries.length === 0) {
    return [{ startSeq: steps[0].seq, steps, isCurrent: true }];
  }
  const groups: TurnGroup[] = [];
  if (boundaries[0] > 0) {
    groups.push({ startSeq: steps[0].seq, steps: steps.slice(0, boundaries[0]), isCurrent: false });
  }
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : steps.length;
    groups.push({ startSeq: steps[start].seq, steps: steps.slice(start, end), isCurrent: b === boundaries.length - 1 });
  }
  return groups;
}

// ─── Main component ─────────────────────────────────────────────────

// release201/30 §8 (Phase 1 landed 2026-05-31) — cloud lie-detector is
// warn-only telemetry; `systemFlags.lie_intercepted` is never written.
// The 'lie_intercepted' variant is removed from the state union and from
// the visual/action paths below. Phase 1 commit caa25547 is the backend
// counterpart; release201/24 + 21 docs carry the DEPRECATED banner.
export type ActivityStripState = 'running' | 'done' | 'awaiting_approval' | 'stuck' | 'failed';

export interface InlineActivityStripProps {
  /**
   * The IMTaskRun id backing this dispatch. In the chat-mention path this is
   * `message.metadata.taskId` on the agent reply (set by
   * `src/im/ws/handler.ts:~1983`). When the strip is mounted before a reply
   * exists (running state), `dispatchId` may be the IMTask id and the
   * component will resolve it to the latest run via `resolveLatestTaskRunId`.
   */
  dispatchId: string | null;
  /** Display name for the title row, e.g. "CEO". */
  agentName: string;
  /** Conversation scope — required to prevent cross-conversation event bleed. */
  conversationId: string | null;
  /** Visual mode. `running` is the default until completion lands. */
  state?: ActivityStripState;
  /** Pre-rewrite original text when lie-guard intercepted; surfaced via "View logs". */
  originalOutput?: string | null;
  /** Total dispatch wall time in ms — used by the collapsed `done` summary. */
  durationMs?: number | null;
  /** File count for the collapsed summary. */
  fileCount?: number;
  /** Theme. */
  isDark?: boolean;
  /** Optional action handlers — when omitted, the buttons render but are no-ops with `aria-disabled`. */
  onRetry?: () => void;
  onAbort?: () => void;
  onViewRequest?: () => void;
}

export function InlineActivityStrip({
  dispatchId,
  agentName,
  conversationId,
  state = 'running',
  originalOutput = null,
  durationMs = null,
  fileCount = 0,
  isDark = false,
  onRetry,
  onAbort,
  onViewRequest,
}: InlineActivityStripProps): React.ReactElement | null {
  const { t } = useI18n();

  // ─── Resolve taskRunId (taskId → latest IMTaskRun.id) ─────────────
  const [resolvedTaskRunId, setResolvedTaskRunId] = useState<string | null>(dispatchId ?? null);

  useEffect(() => {
    if (!dispatchId) {
      setResolvedTaskRunId(null);
      return;
    }
    // Optimistic — assume dispatchId IS the runId. If the timeline endpoint
    // returns nothing we'll silently fall back via resolveLatestTaskRunId.
    setResolvedTaskRunId(dispatchId);
    const ctrl = new AbortController();
    let cancelled = false;
    resolveLatestTaskRunId({ taskId: dispatchId, signal: ctrl.signal })
      .then((runId) => {
        if (cancelled) return;
        if (runId && runId !== dispatchId) setResolvedTaskRunId(runId);
      })
      .catch(() => {
        // dispatchId is already the optimistic value; nothing to roll back.
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [dispatchId]);

  // ─── Reconciled step stream ─────────────────────────────────────
  const runId = resolvedTaskRunId ?? '';
  const initialLoader = useCallback(async () => {
    if (!runId) return { items: [] as StreamStep[], lastSeq: 0 };
    const res = await fetchTaskTimeline({ taskRunId: runId, limit: 200 });
    if (!res.ok) return { items: [] as StreamStep[], lastSeq: 0 };
    const items = res.data.steps.map(toStreamStep);
    const lastSeq = items.reduce((acc: number, s: StreamStep) => (s.seq > acc ? s.seq : acc), 0);
    return { items, lastSeq };
  }, [runId]);

  const catchUp = useCallback(
    async (afterSeq: number) => {
      if (!runId) return { items: [] as StreamStep[] };
      const res = await fetchTaskTimeline({ taskRunId: runId, afterSeq, limit: 200 });
      if (!res.ok) return { items: [] as StreamStep[] };
      return { items: res.data.steps.map(toStreamStep) };
    },
    [runId],
  );

  const stream = useReconciledStream<StreamStep>({
    scope: { kind: 'task', id: runId },
    initialLoader,
    catchUp,
    compareItems: useCallback((a: StreamStep, b: StreamStep) => a.seq - b.seq, []),
    storagePrefix: 'cursor:activity',
  });

  // ─── SSE subscription via task-step-bus ────────────────────────
  useEffect(() => {
    if (!runId) return;
    const off = subscribeTaskStep(runId, conversationId, (event: TaskStepBusEvent) => {
      stream.applyExternal(toStreamStep(event.step));
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, conversationId]);

  // ─── Turn grouping + expansion state ──────────────────────────
  const groups = useMemo(() => groupSteps(stream.items), [stream.items]);
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const expandTurn = useCallback((startSeq: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      next.add(startSeq);
      return next;
    });
  }, []);

  // ─── Done state self-collapse after 2s ─────────────────────────
  // doc 21 §2.1 — done state collapses to a single summary line 2s after
  // the dispatchCompleted signal lands. Needs-action states never collapse.
  //
  // Initial value tracks `state` so historical / refreshed turns that mount
  // already-done don't flash 2s of expanded phase tree (`🔧 1 · · 1` rows
  // per turn boundary) before collapsing. The 2s delay applies only to the
  // live running→done transition.
  const [doneCollapsed, setDoneCollapsed] = useState(state === 'done');
  useEffect(() => {
    if (state !== 'done') {
      setDoneCollapsed(false);
      return;
    }
    if (doneCollapsed) return;
    const id = window.setTimeout(() => setDoneCollapsed(true), 2000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doneCollapsed read for short-circuit only; including it would reset the timer.
  }, [state]);

  // Build a (toolCallSeq → resultPayload) map so tool_result rows can be
  // folded into their parent tool_call's expansion.
  const resultsByToolCallSeq = useMemo(() => {
    const map = new Map<number, unknown>();
    for (const s of stream.items) {
      if (s.kind !== 'tool_result') continue;
      const refSeq = readNumber(s.payloadJson, 'toolCallSeq');
      if (refSeq != null) map.set(refSeq, s.payloadJson);
    }
    return map;
  }, [stream.items]);

  // Counts for the collapsed summary line.
  const stepCount = stream.items.length;
  const durationLabel = formatDuration(durationMs ?? null);

  // Nothing to show — agent hasn't started a dispatch yet AND we have no
  // explicit needs-action state to surface. Keeps the chat clean.
  if (!runId && state === 'running') return null;
  if (stream.items.length === 0 && state === 'running') return null;

  // ─── Mode-derived styling ─────────────────────────────────────
  const visual = getVisualForState(state, isDark);

  return (
    <div
      data-testid={`inline-activity-strip-${dispatchId ?? 'pending'}`}
      data-task-run-id={runId}
      data-state={state}
      // 2026-05-29 — left padding alignment fix (Bug 5). Strip dropped its
      // own `mx-auto max-w-[90%]` so the mount-point's flex+avatar-spacer
      // wrapper in im-channel.tsx decides horizontal alignment. This keeps
      // the strip's left edge in line with sibling MessageRow bubbles
      // instead of hugging the chat container's edge.
      className={`mb-2 w-full rounded-xl border ${visual.border} ${visual.bg}`}
    >
      {/* Title row */}
      <div className={`flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wide ${visual.title}`}>
        {visual.icon}
        <span className="font-medium normal-case">
          {renderTitle({ state, agentName, t, durationLabel, stepCount, fileCount })}
        </span>
        {/* 2026-05-29 — removed the `seq {lastSeq}` dev artifact from the
            user-visible title row. It was a debugging aid that leaked
            through to production and showed up as a confusing "SEQ 1"
            badge for users. The seq is still encoded in data-attributes
            and the reconciled stream cursor for diagnostics. */}
      </div>

      {/* Body — collapsed when state='done' AND timer elapsed, otherwise expanded */}
      {state === 'done' && doneCollapsed ? null : (
        <div className="grid gap-0.5 px-1 pb-1">
          {groups.map((group, idx) => {
            const isExpanded = group.isCurrent || expandedTurns.has(group.startSeq);
            if (!isExpanded) {
              return (
                <CollapsedTurnSummary
                  key={`g-${group.startSeq}`}
                  group={group}
                  isDark={isDark}
                  onExpand={() => expandTurn(group.startSeq)}
                />
              );
            }
            return (
              <div
                key={`g-${group.startSeq}`}
                data-testid={`activity-turn-${idx}`}
                data-current={group.isCurrent ? 'true' : 'false'}
                className="grid gap-0.5"
              >
                {group.steps.map((step) => {
                  if (step.kind === 'phase_change') return <PhaseChangeRow key={step.id} step={step} isDark={isDark} />;
                  if (step.kind === 'tool_call') {
                    return (
                      <ToolCallCard
                        key={step.id}
                        step={step}
                        isDark={isDark}
                        resultPayload={resultsByToolCallSeq.get(step.seq)}
                      />
                    );
                  }
                  if (step.kind === 'tool_result') {
                    const parentSeq = readNumber(step.payloadJson, 'toolCallSeq');
                    if (parentSeq != null && stream.items.some((p) => p.seq === parentSeq && p.kind === 'tool_call')) {
                      return null;
                    }
                    return <UnknownRow key={step.id} step={step} isDark={isDark} />;
                  }
                  if (step.kind === 'reasoning_chunk')
                    return <ReasoningStripe key={step.id} step={step} isDark={isDark} />;
                  if (step.kind === 'progress') return <ProgressBar key={step.id} step={step} isDark={isDark} />;
                  if (step.kind === 'error') return <ErrorRow key={step.id} step={step} isDark={isDark} />;
                  return <UnknownRow key={step.id} step={step} isDark={isDark} />;
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Action row — surfaces needs-action affordances */}
      {(state === 'awaiting_approval' || state === 'stuck' || state === 'failed') && (
        <ActionRow
          state={state}
          isDark={isDark}
          originalOutput={originalOutput}
          onRetry={onRetry}
          onAbort={onAbort}
          onViewRequest={onViewRequest}
          t={t}
        />
      )}
    </div>
  );
}

// ─── Title + action helpers ─────────────────────────────────────

function renderTitle(args: {
  state: ActivityStripState;
  agentName: string;
  t: ReturnType<typeof useI18n>['t'];
  durationLabel: string;
  stepCount: number;
  fileCount: number;
}): string {
  const { state, agentName, t, durationLabel, stepCount, fileCount } = args;
  switch (state) {
    case 'running':
      return t('workspace.activity.title.running', { agent: agentName });
    case 'done':
      return t('workspace.activity.title.done', {
        agent: agentName,
        duration: durationLabel,
        stepCount,
        fileCount,
      });
    case 'awaiting_approval':
      return t('workspace.activity.title.approval', { agent: agentName });
    case 'stuck':
      return t('workspace.activity.title.stuck', { agent: agentName, duration: durationLabel });
    case 'failed':
      return t('workspace.activity.title.failed', { agent: agentName });
  }
}

interface VisualBundle {
  border: string;
  bg: string;
  title: string;
  icon: React.ReactElement;
}

function getVisualForState(state: ActivityStripState, isDark: boolean): VisualBundle {
  switch (state) {
    case 'running':
      return {
        border: isDark ? 'border-white/5' : 'border-zinc-200/70',
        bg: isDark ? 'bg-zinc-950/40' : 'bg-white/40',
        title: isDark ? 'text-zinc-400' : 'text-zinc-500',
        icon: <Loader2 aria-hidden className="h-3 w-3 animate-spin" />,
      };
    case 'done':
      return {
        border: isDark ? 'border-emerald-300/20' : 'border-emerald-200/60',
        bg: isDark ? 'bg-emerald-500/[0.04]' : 'bg-emerald-50/40',
        title: isDark ? 'text-emerald-200/80' : 'text-emerald-700/80',
        icon: <span aria-hidden>✓</span>,
      };
    case 'awaiting_approval':
      return {
        border: isDark ? 'border-amber-300/30' : 'border-amber-300/70',
        bg: isDark ? 'bg-amber-500/10' : 'bg-amber-50/70',
        title: isDark ? 'text-amber-200' : 'text-amber-800',
        icon: <Hourglass aria-hidden className="h-3 w-3" />,
      };
    case 'stuck':
      return {
        border: isDark ? 'border-amber-300/30' : 'border-amber-300/70',
        bg: isDark ? 'bg-amber-500/10' : 'bg-amber-50/70',
        title: isDark ? 'text-amber-200' : 'text-amber-800',
        icon: <AlertCircle aria-hidden className="h-3 w-3" />,
      };
    case 'failed':
      return {
        border: isDark ? 'border-rose-300/30' : 'border-rose-300/70',
        bg: isDark ? 'bg-rose-500/[0.04]' : 'bg-rose-50/40',
        title: isDark ? 'text-rose-200/80' : 'text-rose-700/80',
        icon: <AlertCircle aria-hidden className="h-3 w-3" />,
      };
  }
}

interface ActionRowProps {
  state: ActivityStripState;
  isDark: boolean;
  originalOutput: string | null;
  onRetry?: () => void;
  onAbort?: () => void;
  onViewRequest?: () => void;
  t: ReturnType<typeof useI18n>['t'];
}

function ActionRow({
  state,
  isDark,
  originalOutput,
  onRetry,
  onAbort,
  onViewRequest,
  t,
}: ActionRowProps): React.ReactElement {
  const buttonBase = `rounded px-2 py-0.5 text-[11px] ${isDark ? 'bg-white/5 text-zinc-200 hover:bg-white/10' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`;

  const showRetry = state === 'stuck' || state === 'failed';
  const showAbort = state === 'stuck';
  const showApprove = state === 'awaiting_approval';
  // release201/30 §8 — view-logs affordance was tied to the deprecated
  // lie_intercepted state. Kept the variable for the rendering switch
  // below so the JSX shape is identical; always false now.
  const showViewLogs = false;
  void originalOutput;
  const showViewRequest = state === 'awaiting_approval' && onViewRequest;

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 border-t px-2 py-1 ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}
    >
      {showApprove ? (
        <>
          <button type="button" className={buttonBase} onClick={onRetry} aria-disabled={!onRetry}>
            {t('workspace.activity.action.approve')}
          </button>
          <button type="button" className={buttonBase} onClick={onAbort} aria-disabled={!onAbort}>
            {t('workspace.activity.action.reject')}
          </button>
          {showViewRequest ? (
            <button type="button" className={buttonBase} onClick={onViewRequest}>
              {t('workspace.activity.action.viewRequest')}
            </button>
          ) : null}
        </>
      ) : null}
      {showRetry ? (
        <button type="button" className={buttonBase} onClick={onRetry} aria-disabled={!onRetry}>
          {state === 'stuck' ? t('workspace.activity.action.redispatch') : t('workspace.activity.action.retry')}
        </button>
      ) : null}
      {showAbort ? (
        <button type="button" className={buttonBase} onClick={onAbort} aria-disabled={!onAbort}>
          {t('workspace.activity.action.abort')}
        </button>
      ) : null}
      {showViewLogs ? (
        <details className="ml-auto">
          <summary className={`cursor-pointer text-[10px] ${isDark ? 'text-rose-300/70' : 'text-rose-700/70'}`}>
            {t('workspace.activity.action.viewLogs')}
          </summary>
          <pre
            className={`mt-1 max-h-32 overflow-auto rounded p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all ${
              isDark ? 'bg-zinc-900/50 text-rose-100' : 'bg-white/70 text-rose-900'
            }`}
          >
            {originalOutput}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

interface CollapsedTurnSummaryProps {
  group: TurnGroup;
  isDark: boolean;
  onExpand: () => void;
}

function CollapsedTurnSummary({ group, isDark, onExpand }: CollapsedTurnSummaryProps): React.ReactElement {
  const counts = useMemo(() => {
    let tool = 0;
    let reasoning = 0;
    let phase = 0;
    let other = 0;
    for (const s of group.steps) {
      if (s.kind === 'tool_call') tool++;
      else if (s.kind === 'reasoning_chunk') reasoning++;
      else if (s.kind === 'phase_change') phase++;
      else other++;
    }
    return { tool, reasoning, phase, other };
  }, [group.steps]);
  const parts: string[] = [];
  if (counts.tool) parts.push(`🔧 ${counts.tool}`);
  if (counts.reasoning) parts.push(`💭 ${counts.reasoning}`);
  if (counts.other) parts.push(`· ${counts.other}`);
  return (
    <button
      type="button"
      onClick={onExpand}
      data-testid={`activity-turn-collapsed-${group.startSeq}`}
      className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[11px] ${
        isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
      }`}
    >
      <ChevronRight className="h-3 w-3 shrink-0" />
      <span className="truncate">{parts.length > 0 ? parts.join(' · ') : `${group.steps.length} steps`}</span>
    </button>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}

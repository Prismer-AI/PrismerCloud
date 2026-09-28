// release201/25 §16.4 A1.4 — SSE consumer for /api/sessions/{id}/chat/stream.
//
// Distinct from the /v1/runs SSE consumer (legacy `consumeSse` in index.ts):
// the sessions stream is the new Hermes-native primary endpoint with the
// most structured lifecycle events. Event list per §16.12 S4 (spike-verified
// against api_server.py:1530-1670):
//
//   run.started          — id capture; setPhase('running')
//   message.started      — no-op (assistant message id assigned)
//   assistant.delta      — accumulate to output
//   assistant.commentary — S6/M1 mid-turn narration (v2026.9.21); relayed via
//                          task.onInterimReply + commentarySegments, NEVER
//                          merged into the final assistant.completed
//   tool.started         — recordToolCall; setPhase('tool_call')
//   tool.progress        — recordReasoningChunk (partial tool output OR, when
//                          `tool_name === '_thinking'`, the model reasoning
//                          trace remapped by the sessions emitter — see below)
//   reasoning.available  — recordReasoningChunk(text) (direct reasoning event,
//                          emitted by the /v1/runs path and defensively handled
//                          here for hermes builds that surface it on sessions)
//   tool.completed       — recordToolResult
//   tool.failed          — recordError
//   assistant.completed  — finalize output; check content for upstream error markers
//   error                — preserve the structured upstream failure
//   run.completed        — usage metrics (input_tokens / output_tokens / cache_*)
//   done                 — stream end
//
// LLM upstream errors are recoverable at the SSE protocol layer — the
// spike (§16.12 S4) confirmed that even when the LLM call returns HTTP
// 500, the assistant.completed event still fires with error content in
// the body and run.completed still closes the stream. The consumer
// therefore only needs to surface errors via the recorder/onProgress
// channels; it never throws on upstream LLM failure.

import type { TaskInput } from '../../contract.js';
import { isHermesCommentaryRelayEnabled } from './flag.js';
import { mapHermesToolDetail } from './tool-call-mapper.js';

export interface SessionsSseResult {
  /** Concatenated assistant output (assistant.delta tokens). */
  output: string;
  /**
   * `run_id` captured from `run.started`. Stashed on HermesService so
   * task.signal abort can call POST /v1/runs/{id}/stop and so A6 native
   * approval forwarding can target the right run.
   */
  runId: string | null;
  /**
   * usage block from run.completed — input / output / cache tokens.
   * Surface to metrics so cost + prefix-cache hit-rate are observable
   * without us re-computing them (§16.12 S3 — hermes self-tracks cache).
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /**
   * B-P0 turn metrics — dispatch start → FIRST model-activity event, in ms.
   * Captured once at the `stallGuard.activate()` boundary, i.e. everything
   * EXCEPT the `run.started` / `message.started` gateway acks (those are
   * enqueued before the LLM call and measure gateway latency, not model
   * responsiveness). Undefined when the caller passed no `startedAt` or no
   * guard-activating frame reached the consumer (immediate close).
   */
  firstEventMs?: number;
  /** Model/provider reported by a terminal Hermes event, never profile config. */
  servedModel?: string;
  servedProvider?: string;
  servedChainId?: string;
  /**
   * True iff the agent invoked the human-approval MCP tool during this
   * run. Set on the conventional `tool.started` for that tool name AND
   * on a dedicated `approval.request` event when hermes emits one
   * directly.
   */
  approvalRequested: boolean;
  /**
   * S6/M1 — every non-empty `assistant.commentary` segment this turn, in
   * stream order (diagnostics + tests; the live relay channel is
   * `task.onInterimReply`). Independent of `output` by construction: a
   * commentary segment never enters the delta accumulation or the final
   * `assistant.completed` merge, so `already_streamed` upstream segments are
   * not double-counted. Empty array on turns without commentary.
   */
  commentarySegments: string[];
  /**
   * Set when Hermes reports an upstream LLM failure, either through an explicit
   * `error` event or by serializing it into `assistant.completed`. This lets the
   * caller return a FAILED AdapterResult instead of a fake-successful empty
   * task. `status` is preserved or parsed when Hermes supplies one.
   */
  upstreamError?: { status?: number; message: string };
  /**
   * S7 (spec 07 Task 1) — the run settled UNSUCCESSFULLY. Upstream closes the
   * stream with `run.failed` / `run.interrupted` (gateway restart orphaned the
   * run) / `run.cancelled` just like it does with `run.completed`. Before this
   * field existed those three fell through to `default` (log-only): the stream
   * ended, the caller returned whatever deltas had accumulated, and a
   * half-streamed run was reported as a SUCCESSFUL task. Callers MUST treat a
   * present `terminalEvent` as a failure — `output` is not authoritative then.
   */
  terminalEvent?: {
    event: 'run.failed' | 'run.interrupted' | 'run.cancelled';
    message?: string;
    runId?: string;
  };
  /**
   * release202 — the most recent `clarify.request` seen on this stream
   * (Hermes native clarify tool, surfaced as a structured AskUserQuestion).
   * Unlike approval, the stream is NOT torn down: the run blocks server-side
   * on the clarify primitive and resumes in-place once the daemon forwards
   * the user's answer via HermesService.resolveClarify → POST
   * /v1/runs/{runId}/clarify. The daemon's inbound-reply path uses
   * {runId, clarifyId} to target the resolve.
   */
  clarify?: {
    clarifyId: string;
    question: string;
    choices: string[] | null;
    runId: string | null;
  };
  /**
   * product205/03 §3.5 (M6) — evidence bundle captured from the hermes
   * `approval.request` SSE event (the dangerous-command bridge that fires when
   * `HERMES_YOLO_MODE` is off). Absent on the agent-honor path (MCP tool call).
   * Propagated through AdapterResult.metadata → dispatch.ts → the
   * `task.dispatch.reply` error as `approvalBundle`, so cloud materializes a
   * `runtime_action` approval row with the bundle (not a template fallback).
   */
  approvalBundle?: {
    action: string;
    target?: string;
    reason?: string;
    risk?: string;
    ring?: 'ring0' | 'ring1' | 'ring2';
    actionClass?: string;
    context?: string;
    preview?: string;
  };
}

const APPROVAL_TOOL_NAME = 'prismer.approval.request_human_approval';
const STREAMING_PROGRESS_INTERVAL_MS = 15_000;

// memory203/18 W4 — in-flight upstream-stall watchdog default. The W2-gate's
// dominant residual failure mode: the upstream LLM call hangs SILENTLY (no
// error, no SSE events), the adapter therefore emits no progress, the 300s
// daemon reaper kills the run (`daemon_task_timeout`), the cloud requeues, the
// same stall repeats, requeue cap 4 exhausts → permanent failure (3/18 burst
// runs + the starved round-5 recall probes). The W3 retry-loop progress frames
// can't cover this because the call never RETURNS to enter the retry loop.
// 120s < the 300s reaper window, so the stall is aborted and retried while the
// run is still alive. Do NOT lower the reaper window instead — the reaper is a
// last-resort backstop, this watchdog is the per-attempt in-flight guard.
const DEFAULT_UPSTREAM_STALL_MS = 120_000;

// memory203/18 W5 (final-round5 P0) — separate FIRST-TOKEN budget. The single
// 120s threshold killed HEALTHY long-context turns: after round-3 bulk
// ingestion the recall probes carried ~120k promptTokens and the upstream LLM
// legitimately took >120s to the FIRST token (cloud log promptTokens=119435/
// 120792/123093 — 3/3 probes watchdog-aborted). Those turns are already
// protected from the 300s reaper by the 15s dispatch-level heartbeats; the
// watchdog is only needed for MID-STREAM silence and infinite hangs. So:
// before the first MODEL event use this generous budget (270s — still under
// the 300s reaper backstop), after it fall back to the inter-event
// PRISMER_UPSTREAM_STALL_MS.
//
// ⚠️ "first event" = first MODEL-ACTIVITY event, NOT the literally-first SSE
// frame: hermes' `_run_and_signal` (gateway/platforms/api_server.py, sessions
// chat/stream handler) enqueues `run.started` + `message.started`
// SYNCHRONOUSLY before awaiting `_run_agent`, so those two arrive within
// milliseconds of the POST and prove nothing about the LLM being alive.
// Gating the phase switch on them would make this fix inert for the exact
// failure it exists to cure.
// product210/03 journey note: reasoning models on LARGE prompts can exceed
// 270s pre-first-token — raise per-deployment via PRISMER_UPSTREAM_FIRST_EVENT_MS
// rather than raising this default, which must stay below the 300s task reaper
// (watchdog-before-reaper invariant, asserted in sessions-sse-stall-watchdog.test.ts).
const DEFAULT_UPSTREAM_FIRST_EVENT_MS = 270_000;

function resolvePositiveMsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return fallback;
}

/**
 * Resolve the in-flight inactivity budget for the sessions SSE stream
 * (inter-event phase, i.e. after the first model-activity event).
 * `PRISMER_UPSTREAM_STALL_MS` (ms, positive) overrides; read per-call so ops
 * can tune a live daemon via env without a code change.
 */
export function resolveUpstreamStallMs(): number {
  return resolvePositiveMsEnv('PRISMER_UPSTREAM_STALL_MS', DEFAULT_UPSTREAM_STALL_MS);
}

/**
 * memory203/18 W5 — resolve the pre-first-token budget (stream start until the
 * first model-activity event). `PRISMER_UPSTREAM_FIRST_EVENT_MS` (ms,
 * positive) overrides; read per-call.
 */
export function resolveUpstreamFirstEventMs(): number {
  return resolvePositiveMsEnv('PRISMER_UPSTREAM_FIRST_EVENT_MS', DEFAULT_UPSTREAM_FIRST_EVENT_MS);
}

/**
 * memory203/18 W4 — watchdog wrapper around the SSE reader. `touch()` on every
 * parsed event frame re-arms the timer; when NO frame arrives for `stallMs`
 * the guard rejects the pending `read()` with a stall-classed error and
 * cancels the reader (tearing down the underlying HTTP stream so the socket
 * is released). The error is a PLAIN Error (not AbortError-named) on purpose:
 * `categorizeDispatchError` must map it to a retryable `adapter_dispatch_failed`
 * (message preserved), NOT `task_cancelled`. dispatch.ts's retry loop then
 * treats the `upstream stall:` wording as limiter-class (isLimiterClassError)
 * → jittered backoff with `retrying(...)` progress frames, and on exhaustion
 * → `dispatch_precondition_unavailable` so the cloud requeue channel re-delivers.
 */
type SseReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

interface StallThresholds {
  /** Pre-first-token budget (stream start → first model-activity event). */
  firstEventMs: number;
  /** Inter-event budget once the model has shown activity. */
  stallMs: number;
}

interface StallGuard {
  read(): Promise<SseReadResult>;
  /**
   * Re-arm the inactivity timer WITHOUT leaving the first-event phase — for
   * pre-LLM lifecycle acks (`run.started` / `message.started`, which hermes
   * enqueues before the LLM call) and unparseable frames.
   */
  touch(): void;
  /**
   * A model-activity event arrived: switch to the inter-event phase (if not
   * already there) and re-arm with the tighter `stallMs` budget.
   */
  activate(): void;
  /** Disarm permanently (call on every non-throwing exit path). */
  stop(): void;
}

function createStallGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  thresholds: StallThresholds,
  taskId: string | undefined,
): StallGuard {
  let timer: NodeJS.Timeout | undefined;
  let stalled: Error | null = null;
  let rejectPending: ((err: Error) => void) | null = null;
  // memory203/18 W5 — two-phase budget: 'first-event' until the first
  // model-activity event (generous; long-context first tokens can take
  // minutes), then 'inter-event' (the original W4 mid-stream silence guard).
  let phase: 'first-event' | 'inter-event' = 'first-event';
  const currentBudget = (): number =>
    phase === 'first-event' ? thresholds.firstEventMs : thresholds.stallMs;
  const fire = (): void => {
    timer = undefined;
    const budget = currentBudget();
    stalled = new Error(
      phase === 'first-event'
        ? `upstream stall: no first event for ${Math.round(budget / 1000)}s (sessions SSE in-flight watchdog, pre-first-token phase, PRISMER_UPSTREAM_FIRST_EVENT_MS=${budget})`
        : `upstream stall: no events for ${Math.round(budget / 1000)}s (sessions SSE in-flight watchdog, PRISMER_UPSTREAM_STALL_MS=${budget})`,
    );
    process.stderr.write(
      `[hermes-adapter] task=${taskId ?? '?'} sessions-sse ❌ ${stalled.message} — cancelling stream\n`,
    );
    rejectPending?.(stalled);
    rejectPending = null;
    // Tear the stream down so undici releases the socket; the pending
    // reader.read() (if any) resolves {done:true}, which the rejected
    // wrapper promise above simply ignores.
    void reader.cancel().catch(() => {});
  };
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, currentBudget());
    timer.unref?.();
  };
  arm();
  return {
    touch: arm,
    activate: () => {
      phase = 'inter-event';
      arm();
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    async read() {
      if (stalled) throw stalled;
      try {
        return await new Promise<SseReadResult>((resolve, reject) => {
          rejectPending = reject;
          reader.read().then(
            (r) => {
              rejectPending = null;
              resolve(r);
            },
            (err) => {
              rejectPending = null;
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        });
      } catch (err) {
        // Any read failure (stall or network) exits the consume loop by
        // throwing — disarm so the timer can't fire a misleading STALL log
        // after the dispatcher has already moved on to the retry loop.
        if (timer) clearTimeout(timer);
        timer = undefined;
        throw err;
      }
    },
  };
}

/**
 * release202/12 — hermes serializes an exhausted-LLM-call into the assistant's
 * final content with one of these exact prefixes (verified against hermes
 * `agent/conversation_loop.py`):
 *   - `:3298` `f"API call failed after {max_retries} retries: {summary}"`
 *   - `:1488` `f"Invalid API response after {max_retries} retries: {summary}"`
 *   - `:3294` `f"Billing or credits exhausted: {summary}"` (FailoverReason.billing,
 *      i.e. an HTTP 402 — this is what the cloud P1 balance gate produces, so it
 *      MUST be detected or a 402 reverts to a fake-successful task).
 * The `{summary}` (`_summarize_provider_error`) frequently begins `HTTP <status>:`
 * but drops the JSON `error.type` field — so detection/classification must key on
 * the human message wording, never on a machine token like `provider_chain_unconfigured`.
 * Anchored at start (after trimStart) so a real agent reply merely *mentioning*
 * the phrase mid-text doesn't match; corroborated by zero streamed deltas.
 */
const HERMES_UPSTREAM_ERROR_RE =
  /^(?:(?:API call failed|Invalid API response) after \d+ retr(?:y|ies):|Billing or credits exhausted:)/;
const HERMES_UPSTREAM_STATUS_RE = /(?:^|[\s:])HTTP (\d{3})\b/;

function detectUpstreamError(
  finalContent: string | undefined,
  streamedDeltas: string,
): { status?: number; message: string } | undefined {
  // Only when the final content IS the error (no real tokens streamed) — this
  // avoids mis-flagging an agent that legitimately writes about a failure.
  if (!finalContent || streamedDeltas.length > 0) return undefined;
  const probe = finalContent.trimStart();
  if (!HERMES_UPSTREAM_ERROR_RE.test(probe)) return undefined;
  const m = probe.match(HERMES_UPSTREAM_STATUS_RE);
  const status = m ? Number(m[1]) : undefined;
  return { ...(status !== undefined ? { status } : {}), message: finalContent };
}

/**
 * Return the first argument that is a non-empty string or a non-null object
 * (objects are kept as-is — StepRecorder.summarize JSON-stringifies them).
 * Used to extract the tool output from a `tool.completed` payload whose field
 * name varies across hermes builds/endpoints. Empty strings and null/undefined
 * are skipped so `outputSummary` only ends up blank when nothing usable exists.
 */
function firstPresent(...candidates: unknown[]): unknown {
  for (const c of candidates) {
    if (typeof c === 'string') {
      if (c.length > 0) return c;
    } else if (c != null) {
      return c;
    }
  }
  return undefined;
}

/**
 * Out-parameter mirroring the pattern in consumeSse() — exposed so the
 * caller's catch block can still read approvalRequested when reader.read()
 * aborts mid-stream (reaper kill / signal cancel).
 */
export interface SessionsSseState {
  approvalRequested: boolean;
  runId: string | null;
  /** Called at the run.started boundary, before post-turn hooks can fire. */
  onRunStarted?: (runId: string) => void;
  /** release202 — set true when a `clarify.request` is seen; last one stashed. */
  clarifyRequested?: boolean;
  clarify?: SessionsSseResult['clarify'];
  /** product205/03 §3.5 (M6) — runtime-hook evidence bundle (mirror). */
  approvalBundle?: SessionsSseResult['approvalBundle'];
}

/**
 * product205/03 §3.5 (M6) — synthesize the decision-evidence bundle from a
 * hermes `approval.request` SSE payload. Hermes' dangerous-command bridge
 * (active only when `HERMES_YOLO_MODE` is off) flags patterns like `rm -r`,
 * `DROP TABLE`, `chmod 777`; the payload carries the flagged command + a
 * preview. We map the hermes-native fields onto the §3.5 bundle shape so the
 * cloud Decision Inbox renders "删什么 / 为什么删 / 可逆性" without a second
 * pull. Tolerant of field-name drift across hermes versions — every field is
 * optional and the bundle degrades to just `{ action }`.
 */
function buildApprovalBundleFromHermesPayload(
  payload: Record<string, unknown>,
): SessionsSseResult['approvalBundle'] {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  // The flagged command: hermes uses `command` (terminal tools) or `tool` /
  // `tool_name` + `args` for tool-call approvals. `preview` is the rendered
  // summary hermes already formatted for a human.
  const command = str(payload.command) ?? str(payload.preview);
  const toolName = str(payload.tool_name) ?? str(payload.tool);
  const args = str(payload.args);
  const action =
    command ??
    (toolName ? (args ? `${toolName} ${args}` : toolName) : 'runtime action requires approval');
  // Ring classification: hermes `UNRECOVERABLE_BLOCKLIST` patterns are the ring0
  // hard floor; the dangerous-pattern matches (rm -r / DROP TABLE / chmod 777)
  // are ring1. The bridge tags severity when available; default ring1.
  const severity = str(payload.severity) ?? str(payload.level);
  const ring: 'ring0' | 'ring1' | 'ring2' =
    severity === 'catastrophic' || severity === 'blocklist' ? 'ring0' : 'ring1';
  // Action class — best-effort classification from the command text. Matches
  // the approvalBoundaries vocabulary (03 §3.3) so the audit view groups
  // correctly.
  const actionClass = classifyActionClass(action);
  return {
    action,
    ...(toolName ? { target: toolName } : {}),
    ...(str(payload.reason) ? { reason: str(payload.reason) } : {}),
    ...(str(payload.risk) ? { risk: str(payload.risk) } : {}),
    ring,
    ...(actionClass ? { actionClass } : {}),
    ...(command ? { preview: command } : {}),
  };
}

/**
 * Best-effort action-class classifier (product205/03 §3.3 vocabulary). Used
 * only for audit grouping / Inbox sorting — the ring decision is hermes' (the
 * authoritative classifier). Conservative: ambiguous → undefined (no false
 * label).
 */
function classifyActionClass(command: string): string | undefined {
  const c = command.toLowerCase();
  if (/\b(rm|rmdir|unlink|shred|truncate)\b/.test(c) || /drop\s+table/.test(c)) return 'destructive';
  if (/\b(chmod|chown|chattr)\b/.test(c) || /grant|revoke/.test(c)) return 'credential';
  if (/\b(curl|wget|scp|rsync|send|publish|deploy)\b/.test(c)) return 'egress';
  if (/\b(git\s+push|git\s+reset|--force|mkfs|dd\s)/.test(c)) return 'irreversible';
  return undefined;
}

/**
 * S7 (spec 07 Task 1) — human-readable fallback for a terminal run event whose
 * payload carries no `message`. Terminal frames are rare and mostly silent
 * (a clean cancel has nothing to say), but the caller needs SOME string to put
 * in `TaskResult.error.message` — an empty one would render as a blank failure
 * pill in chat.
 */
const TERMINAL_EVENT_FALLBACK_MESSAGE: Record<
  'run.failed' | 'run.interrupted' | 'run.cancelled',
  string
> = {
  'run.failed': 'Hermes run failed before producing a final message',
  'run.interrupted': 'The gateway restarted before this run settled.',
  'run.cancelled': 'Hermes run was cancelled before producing a final message',
};

export async function consumeSessionsSse(
  body: ReadableStream<Uint8Array>,
  task: TaskInput,
  state?: SessionsSseState,
  /**
   * B-P0 — dispatch start reference (epoch ms) used to derive
   * `firstEventMs`. The dispatcher owns the turn clock (`startedAt`), so it
   * is threaded in here rather than re-minted.
   */
  startedAt?: number,
): Promise<SessionsSseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let deltas = '';
  let finalContent: string | undefined;
  // S6/M1 — mid-turn narration state. `commentarySeq` is the per-turn 1-based
  // relay counter (NOT the upstream stream-wide `seq` field). Kept fully
  // disjoint from `deltas` / `finalContent` — that disjointness IS the
  // already_streamed dedup: an upstream commentary that was also streamed as
  // assistant.delta is relayed once here and never re-enters the output path.
  let commentarySeq = 0;
  const commentarySegments: string[] = [];
  let eventUpstreamError: SessionsSseResult['upstreamError'];
  let terminalEvent: SessionsSseResult['terminalEvent'];
  let runId: string | null = null;
  let approvalRequested = false;
  let clarify: SessionsSseResult['clarify'] | undefined;
  let approvalBundle: SessionsSseResult['approvalBundle'];
  let usage: SessionsSseResult['usage'] | undefined;
  // B-P0 — first model-activity timestamp, captured ONCE (first writer wins).
  let firstModelActivityAt: number | undefined;
  let servedModel: string | undefined;
  let servedProvider: string | undefined;
  let servedChainId: string | undefined;
  let lastProgress = 0;
  let lastStreamProgressAt = 0;
  // WS-G — stash {toolName, args} per toolCallId at `tool.started` so the paired
  // `tool.completed` can rebuild the SAME-shape ToolCallDetail with the output.
  // The completion payload often drops the original args (it carries only
  // message_id/tool_name/preview), so we cannot re-derive command/path there.
  const startedTools = new Map<string, { toolName: string; args: unknown }>();

  const bumpProgress = (by: number) => {
    lastProgress = Math.min(0.99, Math.max(0.01, lastProgress + by));
  };

  const reportStreamingProgress = () => {
    const now = Date.now();
    if (lastStreamProgressAt !== 0 && now - lastStreamProgressAt < STREAMING_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastStreamProgressAt = now;
    bumpProgress(0.01);
    task.heartbeat?.touchStep();
    task.onProgress?.({
      progress: lastProgress,
      message: 'streaming',
      detail: {
        kind: 'llm_stream',
        event: 'assistant.delta',
        chars: deltas.length,
      },
    });
  };

  // memory203/18 W4 — see createStallGuard. Armed for the WHOLE stream: the
  // silent-stall window can open before the first event (upstream hang on the
  // initial completion) or mid-run between tool turns. W5 — two-phase: the
  // pre-first-token window uses the generous first-event budget so a
  // legitimate long-context first token (>120s at ~120k promptTokens) is not
  // killed; mid-stream silence keeps the tighter inter-event budget.
  const stallGuard = createStallGuard(
    reader,
    { firstEventMs: resolveUpstreamFirstEventMs(), stallMs: resolveUpstreamStallMs() },
    task.taskId,
  );

  for (;;) {
    const { value, done } = await stallGuard.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames separated by blank line. Each frame has either an
    // `event: <type>\n` line + `data: <json>\n`, or just `data: <json>\n`
    // — we parse both.
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const ev of events) {
      const eventLine = ev.match(/^event: (.+)$/m);
      const dataLine = ev.match(/^data: ([\s\S]+)$/m);
      if (!dataLine) continue;
      const eventNameOuter = eventLine?.[1]?.trim();
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(dataLine[1]!);
      } catch (err) {
        // Unparseable frame — still bytes from upstream, so re-arm the current
        // phase, but do NOT treat it as model activity.
        stallGuard.touch();
        process.stderr.write(
          `[hermes-adapter] sessions SSE JSON parse skipped: ${(err as Error).message}; head=${dataLine[1]!.slice(0, 200).replace(/\n/g, '\\n')}\n`,
        );
        continue;
      }
      // Prefer the outer `event:` line when present; fall back to a
      // payload-embedded `event` field (some hermes paths emit that
      // style).
      const eventName =
        eventNameOuter ?? (typeof payload.event === 'string' ? payload.event : '<missing>');
      // W4/W5 — a real event frame arrived: re-arm the stall watchdog.
      // Comment / keepalive frames (no `data:` line) deliberately do NOT count
      // as activity — a ping-alive connection with a hung upstream is exactly
      // the stall this guard exists to break. Phase rule: `run.started` /
      // `message.started` are gateway acks enqueued BEFORE the LLM call
      // (api_server.py `_run_and_signal` head), so they only re-arm the
      // first-event phase; any other event is model activity and switches the
      // guard to the tighter inter-event budget.
      if (eventName === 'run.started' || eventName === 'message.started') {
        stallGuard.touch();
      } else {
        // B-P0 — first model activity of the turn (one-shot). Purely
        // observational: the guard's phase switch below is unchanged.
        firstModelActivityAt ??= Date.now();
        stallGuard.activate();
      }
      process.stderr.write(
        `[hermes-adapter] task=${task.taskId ?? '?'} sessions-sse event=${eventName}\n`,
      );

      switch (eventName) {
        case 'run.started': {
          const rid = typeof payload.run_id === 'string' ? payload.run_id : null;
          if (rid) {
            runId = rid;
            if (state) {
              state.runId = rid;
              state.onRunStarted?.(rid);
            }
            task.heartbeat?.setPhase('running');
          }
          break;
        }
        case 'message.started':
          // No structured action — assistant message id is informational.
          break;
        case 'assistant.delta': {
          const delta = typeof payload.delta === 'string' ? payload.delta : '';
          if (delta) {
            deltas += delta;
            reportStreamingProgress();
          }
          break;
        }
        case 'tool.started': {
          const toolName =
            typeof payload.tool_name === 'string'
              ? payload.tool_name
              : typeof payload.tool === 'string'
                ? payload.tool
                : typeof payload.name === 'string'
                  ? payload.name
                  : undefined;
          const toolCallId =
            typeof payload.message_id === 'string'
              ? payload.message_id
              : typeof payload.tool_call_id === 'string'
                ? payload.tool_call_id
                : toolName ?? 'tool';
          if (toolName) {
            const args = payload.arguments ?? payload.args ?? payload.preview ?? {};
            // Diagnostic: surface the concrete tool name + a short arg preview on
            // the same `tool.started` line so live pod logs show WHICH tools an
            // agent ran (e.g. memory-dream curation steps), not just an opaque
            // `event=tool.started`.
            try {
              const argPreview = JSON.stringify(args).slice(0, 160);
              process.stderr.write(
                `[hermes-adapter] task=${task.taskId ?? '?'} tool=${toolName} args=${argPreview}\n`,
              );
            } catch {
              /* best-effort */
            }
            // WS-G — build a structured ToolCallDetail so the step renders rich +
            // expandable like coding agents. Defined → pass {detail, status}
            // (also fixes altitude: shell → 'action', so consecutive execute_code
            // collapse into a group). Undefined (unmapped tool) → keep the 3-arg
            // call so unmapped tools fall back to inputSummary (no regression).
            const detail = mapHermesToolDetail(toolName, args);
            startedTools.set(toolCallId, { toolName, args });
            if (detail) {
              task.recorder?.recordToolCall(toolName, args, toolCallId, {
                detail,
                status: 'running',
              });
            } else {
              task.recorder?.recordToolCall(toolName, args, toolCallId);
            }
            task.heartbeat?.setPhase('tool_call');
          }
          if (toolName === APPROVAL_TOOL_NAME) {
            approvalRequested = true;
            if (state) state.approvalRequested = true;
          }
          bumpProgress(0.05);
          task.onProgress?.({
            progress: lastProgress,
            message: toolName,
            detail: {
              kind: 'tool',
              event: eventName,
              tool: toolName,
              preview: payload.preview,
              arguments: payload.arguments ?? payload.args,
            },
          });
          break;
        }
        case 'tool.progress': {
          // The sessions emitter (api_server.py:1585-1590 `_tool_progress`)
          // remaps the model's per-turn reasoning trace into this event with
          // `tool_name: '_thinking'` and the reasoning text in `delta` — NOT
          // `preview` (which it only sets for real tool progress). The
          // /v1/runs path instead emits a dedicated `reasoning.available`
          // event (handled below); on sessions it arrives HERE. Reading only
          // `preview` (the pre-2cdd2cad behaviour) silently dropped reasoning,
          // which is why the expandable reasoning block vanished from agent
          // messages. Read `delta` first so the trace is recorded again.
          const reasoningText =
            typeof payload.delta === 'string' && payload.delta.length > 0
              ? payload.delta
              : undefined;
          const preview =
            typeof payload.preview === 'string'
              ? payload.preview
              : payload.preview != null
                ? JSON.stringify(payload.preview).slice(0, 800)
                : undefined;
          const text = reasoningText ?? preview;
          if (text) {
            // Feed the persistent recorder (step-recorder batches reasoning
            // chunks on a throttle so a multi-chunk turn won't spam the cloud).
            task.recorder?.recordReasoningChunk(text);
            // Surface a low-progress reasoning hint so the in-chat activity
            // timeline shows the model thinking alongside tool calls. Mirror
            // the deleted /v1/runs handler: kind:'reasoning', do NOT bump
            // lastProgress (reasoning is not a tool execution unit and must
            // not feed the inactivity reaper's progress signal).
            task.onProgress?.({
              progress: lastProgress,
              message: 'thinking',
              detail: {
                kind: 'reasoning',
                event: eventName,
                tool: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
                text: text.length > 800 ? `${text.slice(0, 800)}…` : text,
              },
            });
          }
          task.heartbeat?.touchStep();
          break;
        }
        case 'reasoning.available': {
          // Direct reasoning event. The /v1/runs callback emits this with the
          // trace in `text` (api_server.py:3503-3510, `preview or ""`). The
          // primary sessions endpoint remaps reasoning into `tool.progress`
          // (handled above) and does NOT send this event today, but we handle
          // it defensively so a hermes build/path that DOES surface it on the
          // sessions stream still records the trace. Accept every field name a
          // build might use: `text` (legacy /v1/runs), `reasoning_content`
          // (sessions message field, api_server.py:1273), `delta`, `content`.
          const text =
            typeof payload.text === 'string' && payload.text.length > 0
              ? payload.text
              : typeof payload.reasoning_content === 'string' && payload.reasoning_content.length > 0
                ? payload.reasoning_content
                : typeof payload.delta === 'string' && payload.delta.length > 0
                  ? payload.delta
                  : typeof payload.content === 'string' && payload.content.length > 0
                    ? payload.content
                    : undefined;
          if (text) {
            task.recorder?.recordReasoningChunk(text);
            // Same semantics as the tool.progress reasoning branch: low hint,
            // no lastProgress bump (reasoning ≠ progress for the reaper).
            task.onProgress?.({
              progress: lastProgress,
              message: 'thinking',
              detail: {
                kind: 'reasoning',
                event: eventName,
                text: text.length > 800 ? `${text.slice(0, 800)}…` : text,
              },
            });
          }
          task.heartbeat?.touchStep();
          break;
        }
        case 'tool.completed': {
          const toolCallId =
            typeof payload.message_id === 'string'
              ? payload.message_id
              : typeof payload.tool_call_id === 'string'
                ? payload.tool_call_id
                : 'tool';
          // FIX 3 (tool-output recording): pull the actual tool output from
          // every field name a hermes build might use. The Hermes agent core
          // DOES pass the output to its `tool_progress_callback` as the
          // `result` kwarg (agent/tool_executor.py:388-392 / :823-826), but the
          // gateway's sessions-chat-stream callback (gateway/platforms/
          // api_server.py:1585-1590, `_tool_progress`) only enqueues
          // {message_id, tool_name, preview, args} and DROPS **kwargs — so on
          // THIS endpoint `result`/`output` are usually absent and `preview` is
          // None for `tool.completed`. We still read every candidate so that a
          // build/path which DOES forward the output (e.g. the responses bridge
          // which sets `payload.result`, api_server.py:2886) records non-empty
          // output. When all are absent we fall back to a synthetic marker so
          // outputSummary is never blank (the agent was blind → confabulated).
          const toolOutput =
            firstPresent(
              payload.result,
              payload.output,
              payload.preview,
              payload.content,
              payload.result_preview,
              payload.stdout,
            ) ??
            (payload.is_error === true
              ? '[tool errored]'
              : typeof payload.tool_name === 'string'
                ? `[${payload.tool_name} completed${typeof payload.duration === 'number' ? ` in ${payload.duration}s` : ''}; output not forwarded by hermes sessions stream]`
                : '[tool completed; output not forwarded by hermes sessions stream]');
          // WS-G — rebuild the SAME-shape detail from the stashed started args +
          // the (when forwarded) real output, so the completed step carries the
          // structured body and renders rich + expandable like coding agents.
          // ⚠️ Output-forwarding caveat: when the gateway dropped the real output
          // (see the firstPresent fallback above), `realOutput` is undefined and
          // we leave detail.output undefined (NOT the synthetic placeholder) — the
          // command + expand + exitCode-when-present still work. Real-output
          // forwarding is a separate Hermes-gateway gap (doc 15 WS-G ⚠️).
          const started = startedTools.get(toolCallId);
          startedTools.delete(toolCallId);
          const completedToolName =
            started?.toolName ??
            (typeof payload.tool_name === 'string' ? payload.tool_name : undefined);
          const realOutput =
            firstPresent(
              payload.result,
              payload.output,
              payload.preview,
              payload.content,
              payload.result_preview,
              payload.stdout,
            ) ?? undefined;
          const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : undefined;
          const completedDetail = completedToolName
            ? mapHermesToolDetail(
                completedToolName,
                started?.args ?? payload.args ?? payload.arguments,
                typeof realOutput === 'string' ? realOutput : undefined,
                exitCode,
              )
            : undefined;
          if (completedDetail) {
            task.recorder?.recordToolResult(toolCallId, toolOutput, {
              detail: completedDetail,
              status: payload.is_error === true ? 'failed' : 'completed',
            });
          } else {
            task.recorder?.recordToolResult(toolCallId, toolOutput);
          }
          bumpProgress(0.05);
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'tool',
              event: eventName,
              tool: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
              result: payload.result,
              preview: payload.preview,
            },
          });
          break;
        }
        case 'tool.failed': {
          const message =
            typeof payload.error === 'string'
              ? payload.error
              : typeof payload.message === 'string'
                ? payload.message
                : 'tool failed';
          task.recorder?.recordError(message, payload as Record<string, unknown>);
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'tool',
              event: eventName,
              error: true,
              message,
            },
          });
          break;
        }
        case 'approval.request': {
          // Some hermes paths emit a dedicated approval event in addition
          // to (or instead of) `tool.started` with the approval tool name.
          // Mirror the existing /v1/runs consumer behaviour: flag it and
          // tear down the stream so the daemon doesn't block waiting for
          // events that won't arrive until the human decides.
          approvalRequested = true;
          if (state) state.approvalRequested = true;
          // product205/03 §3.5 (M6) — capture the §3.5 evidence bundle from
          // the hermes dangerous-command bridge payload. Hermes ships the
          // flagged command + preview; we synthesize action/target/risk/ring
          // from whichever fields are present so cloud can render a
          // decision-evidence card instead of a template fallback. The bridge
          // only fires when HERMES_YOLO_MODE is off (M6 de-YOLO), so this is
          // the runtime-hook origin — distinct from the agent-honor MCP tool.
          approvalBundle = buildApprovalBundleFromHermesPayload(payload);
          if (state) state.approvalBundle = approvalBundle;
          task.onProgress?.({
            progress: lastProgress,
            message: 'awaiting human approval',
            detail: {
              kind: 'approval',
              event: eventName,
              preview: payload.preview,
            },
          });
          stallGuard.stop();
          try {
            await reader.cancel();
          } catch {
            /* reader cancel can throw if already closed */
          }
          return {
            output: deltas,
            runId,
            usage,
            approvalRequested,
            commentarySegments: [...commentarySegments],
            ...(approvalBundle ? { approvalBundle } : {}),
            ...(clarify ? { clarify } : {}),
          };
        }
        case 'clarify.request': {
          // release202 — Hermes native clarify tool asked the user a blocking
          // question. UNLIKE approval, do NOT tear down the stream: the run
          // blocks server-side on the clarify primitive and resumes in-place
          // when the daemon forwards the answer (resolveClarify → POST
          // /v1/runs/{runId}/clarify). We surface the question via onProgress
          // so the cloud can render an AskUserQuestion card, stash the
          // {clarifyId, runId} the resolve needs, and keep reading.
          const clarifyId =
            typeof payload.clarify_id === 'string' ? payload.clarify_id : '';
          const question = typeof payload.question === 'string' ? payload.question : '';
          const choices = Array.isArray(payload.choices)
            ? (payload.choices.filter((c) => typeof c === 'string') as string[])
            : null;
          clarify = { clarifyId, question, choices, runId };
          if (state) {
            state.clarifyRequested = true;
            state.clarify = clarify;
          }
          // W4 — waiting on a HUMAN is not an upstream stall: the run blocks
          // server-side and the stream is legitimately event-less until the
          // user answers. Disarm the stall watchdog; the per-frame touch()
          // re-arms it on the next event (clarify.responded or anything else).
          // The 300s reaper stays as the unchanged last-resort backstop.
          stallGuard.stop();
          task.heartbeat?.setPhase('waiting_user');
          task.onProgress?.({
            progress: lastProgress,
            message: 'awaiting user clarification',
            detail: {
              kind: 'clarify',
              event: eventName,
              clarifyId,
              question,
              choices,
              runId,
            },
          });
          break;
        }
        case 'clarify.responded': {
          task.heartbeat?.setPhase('running');
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'clarify',
              event: eventName,
              clarifyId: typeof payload.clarify_id === 'string' ? payload.clarify_id : undefined,
            },
          });
          break;
        }
        case 'assistant.commentary': {
          // S6/M1 — v2026.9.21 mid-turn narration (upstream b44ccdcc0e). Independent
          // typed event, NEVER merged into the final assistant.completed. Upstream
          // gate: display.interim_assistant_messages (default on) — absent events =
          // status-quo single-frame behavior. No second-guessing of "worth sending"
          // (owner ruling: relay all, narrow later).
          if (!isHermesCommentaryRelayEnabled()) break;
          // Measured upstream shape (2026-09-21 local source): the text rides in
          // `text` (plus message_id / already_streamed / session_id / run_id /
          // seq / ts); brief-era fixtures and older builds used `content` —
          // accept both, `text` first (same tolerant-field precedent as
          // reasoning.available below).
          const raw = typeof payload.text === 'string' && payload.text.length > 0
            ? payload.text
            : payload.content;
          const text = typeof raw === 'string' ? raw : '';
          if (text.trim().length === 0) break;
          commentarySeq += 1;
          commentarySegments.push(text);
          try {
            task.onInterimReply?.({ text, seq: commentarySeq });
          } catch (err) {
            process.stderr.write(`[hermes-adapter] onInterimReply callback failed: ${(err as Error).message}\n`);
          }
          break;
        }
        case 'assistant.completed': {
          // §16.12 S4 — LLM upstream errors still fire assistant.completed
          // with the error text in `content`. We finalize regardless; the
          // return path (release202/12 detectUpstreamError) classifies whether
          // that content is a hermes upstream-failure string and surfaces it as
          // a FAILED result rather than a fake-successful task.
          if (typeof payload.content === 'string') {
            finalContent = payload.content;
          }
          const served = terminalRouting(payload);
          servedModel = served.model ?? servedModel;
          servedProvider = served.provider ?? servedProvider;
          servedChainId = served.chainId ?? servedChainId;
          break;
        }
        case 'error': {
          const message =
            typeof payload.message === 'string' && payload.message.length > 0
              ? payload.message
              : typeof payload.error === 'string' && payload.error.length > 0
                ? payload.error
                : 'Hermes sessions stream emitted an error event';
          const explicitStatus =
            typeof payload.status === 'number'
              ? payload.status
              : typeof payload.status_code === 'number'
                ? payload.status_code
                : typeof payload.http_status === 'number'
                  ? payload.http_status
                  : undefined;
          const statusMatch = message.match(HERMES_UPSTREAM_STATUS_RE);
          const status = explicitStatus ?? (statusMatch ? Number(statusMatch[1]) : undefined);
          eventUpstreamError = {
            ...(status !== undefined ? { status } : {}),
            message,
          };

          // Some Hermes builds emit `error` without a preceding run.started.
          // Preserve its run id so cancellation and diagnostics still target
          // the exact failed run, but do not notify twice when run.started was
          // already observed.
          const errorRunId = typeof payload.run_id === 'string' ? payload.run_id : null;
          if (errorRunId) {
            const shouldNotifyRunStarted = runId === null;
            runId = errorRunId;
            if (state) {
              state.runId = errorRunId;
              if (shouldNotifyRunStarted) state.onRunStarted?.(errorRunId);
            }
          }

          task.recorder?.recordError(message, payload);
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'llm_stream',
              event: eventName,
              error: true,
              message,
              runId: errorRunId ?? runId,
              ...(status !== undefined ? { status } : {}),
            },
          });
          break;
        }
        // S7 (spec 07 Task 1) — v2026.9.14 terminal event family. These are
        // NOT `run.completed`: the run did not settle successfully. Falling
        // through to `default` (log-only) is what let a partially-streamed run
        // be reported as a successful task, so each one records the error,
        // surfaces it on the progress channel, and stashes `terminalEvent` for
        // the caller to convert into a failed TaskResult.
        case 'run.failed':
        case 'run.interrupted':
        case 'run.cancelled': {
          const terminalMessage =
            typeof payload.message === 'string' && payload.message.length > 0
              ? payload.message
              : typeof payload.error === 'string' && payload.error.length > 0
                ? payload.error
                : TERMINAL_EVENT_FALLBACK_MESSAGE[eventName];
          // Same rescue precedent as the `error` case: a terminal frame can
          // arrive without a preceding run.started (gateway restart orphans).
          const terminalRunId = typeof payload.run_id === 'string' ? payload.run_id : null;
          if (terminalRunId) {
            const shouldNotifyRunStarted = runId === null;
            runId = terminalRunId;
            if (state) {
              state.runId = terminalRunId;
              if (shouldNotifyRunStarted) state.onRunStarted?.(terminalRunId);
            }
          }
          const attributedRunId = terminalRunId ?? runId;
          terminalEvent = {
            event: eventName,
            ...(terminalMessage ? { message: terminalMessage } : {}),
            ...(attributedRunId ? { runId: attributedRunId } : {}),
          };
          task.recorder?.recordError(terminalMessage, payload);
          task.onProgress?.({
            progress: lastProgress,
            detail: {
              kind: 'llm_stream',
              event: eventName,
              error: true,
              message: terminalMessage,
              runId: attributedRunId,
            },
          });
          break;
        }
        case 'message.interim':
          // S7 — v2026.9.14 narration frame. DELIBERATELY ignored here: the
          // interim relay channel belongs to M1/S6 (`assistant.commentary`
          // above). This case exists so the frame is a documented no-op rather
          // than an "unknown event" log line, and so it can never leak into
          // `output`.
          break;
        case 'run.completed': {
          const u = (payload.usage ?? {}) as Record<string, unknown>;
          const num = (k: string): number | undefined =>
            typeof u[k] === 'number' ? (u[k] as number) : undefined;
          usage = {
            inputTokens: num('input_tokens'),
            outputTokens: num('output_tokens'),
            cacheReadTokens: num('cache_read_tokens'),
            cacheWriteTokens: num('cache_write_tokens'),
          };
          const served = terminalRouting(payload);
          servedModel = served.model ?? servedModel;
          servedProvider = served.provider ?? servedProvider;
          servedChainId = served.chainId ?? servedChainId;
          break;
        }
        case 'done':
          // End-of-stream sentinel; loop exits next reader.read().
          break;
        default:
          // Unknown event — log once for visibility but don't fail the run.
          // product207/29 fixup — include the payload's message: an `error`
          // event from Hermes (LLM upstream failure) carries the real reason
          // in payload.message, which was dropped before — debugging the
          // recurring empty-reply failures meant guessing (2026-08-06).
          process.stderr.write(
            `[hermes-adapter] sessions SSE unknown event=${eventName} keys=${Object.keys(payload).join(',')} message=${String((payload as { message?: unknown }).message ?? '')}\n`,
          );
      }
    }
  }

  stallGuard.stop();

  const upstreamError = eventUpstreamError ?? detectUpstreamError(finalContent, deltas);

  return {
    output: finalContent && finalContent.length > 0 ? finalContent : deltas,
    runId,
    usage,
    commentarySegments: [...commentarySegments],
    ...(firstModelActivityAt !== undefined && startedAt !== undefined
      ? { firstEventMs: Math.max(0, firstModelActivityAt - startedAt) }
      : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(servedProvider ? { servedProvider } : {}),
    ...(servedChainId ? { servedChainId } : {}),
    approvalRequested,
    ...(terminalEvent ? { terminalEvent } : {}),
    ...(upstreamError ? { upstreamError } : {}),
    ...(approvalBundle ? { approvalBundle } : {}),
    ...(clarify ? { clarify } : {}),
  };
}

function terminalRouting(payload: Record<string, unknown>): {
  model?: string;
  provider?: string;
  chainId?: string;
} {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const string = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  const response = record(payload.response);
  const metadata = record(payload.metadata);
  const routing = record(payload.routing) ?? record(metadata?.routing);
  return {
    ...(string(payload.model, payload.model_id, response?.model, metadata?.model)
      ? { model: string(payload.model, payload.model_id, response?.model, metadata?.model) }
      : {}),
    ...(string(payload.provider, payload.provider_name, response?.provider, metadata?.provider, routing?.provider)
      ? { provider: string(payload.provider, payload.provider_name, response?.provider, metadata?.provider, routing?.provider) }
      : {}),
    ...(string(payload.chain_id, payload.chainId, metadata?.chainId, routing?.chainId)
      ? { chainId: string(payload.chain_id, payload.chainId, metadata?.chainId, routing?.chainId) }
      : {}),
  };
}

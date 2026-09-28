// StepRecorder — daemon-side per-task observable step uploader.
//
// See docs/release200/14-messaging-state-machine-reliability.md
//   §3.0.2 Gap C-④ + §4.4.4 (InlineActivityStream)
//
// Wire protocol:
//   { type: 'task.step.append', payload: {
//       taskRunId: string,
//       step: { seq: number, kind: string, payload: object, occurredAt: number }
//     }
//   }
//
//   `kind` ∈ 'phase_change' | 'tool_call' | 'tool_result' |
//           'reasoning_chunk' | 'progress' | 'error'
//
// Server-side handling (Wave 3.5 — currently logs only; durable
// im_task_run_steps writer is the next wave's scope) consumes the
// envelope and is responsible for fan-out. Daemon does NOT block on
// server ack; the cloud catch-up path (Gap D-④) covers replay.
//
// Sequence numbering:
//   - seq is daemon-side allocated, monotonically increasing per
//     taskRunId. Cloud MUST NOT re-number.
//   - First seq is 1 (not 0) so a missing record is unambiguous.
//
// reasoning_chunk throttle (per §3.0.2 Gap C-④):
//   - Reasoning streams arrive at LLM-token granularity (potentially
//     thousands of frames/sec). Sending each one would saturate the WS
//     transport.
//   - We batch chunks into a 500ms window: incoming text concatenated
//     into a single pending buffer, flushed as one step when the timer
//     fires. Other step kinds bypass the buffer and go immediately.
//   - flush() exposed for explicit drain (test / shutdown).

import { envelope } from '../envelope.js';
import type { WsSender } from './task-heartbeat.js';
import type { ToolCallDetail } from '../adapters/coding/shared/agent-sdk-types.js';
import type { AssetRef } from '../types/im-events.js';

// WS-C — keep the original 6 StepKind for back-compat. `todo` / `usage` are
// added additively so the existing 6 consumers (conversation-task-trace,
// conversation-memory) keep switching on the same kinds unchanged. New
// consumers opt into the new kinds.
export type StepKind =
  | 'phase_change'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning_chunk'
  | 'progress'
  | 'error'
  // WS-C additive kinds:
  | 'todo'
  | 'usage'
  // runtime210/09 §3.1b (C3c ruling, Path B) — pi-native text delta. Batched on
  // the same 500ms window as reasoning_chunk; cloud treats the kind verbatim
  // (zero cloud-side runtime changes) and the UI aggregates rows into the
  // running-time stream.
  | 'text_delta';

/**
 * WS-C — presentation altitude. A pure hint for the timeline UI (WS-E):
 *   - 'milestone' — phase change / plan / todo / sub_agent / hermes setPhase.
 *     Always visible.
 *   - 'action'    — individual code-agent tool detail (shell/read/edit/write/
 *     search/fetch). UI collapses consecutive `action` rows under the nearest
 *     milestone.
 * Optional everywhere; existing consumers ignore it.
 */
export type StepAltitude = 'milestone' | 'action';

/** WS-C — tool_result lifecycle status. */
export type StepStatus = 'running' | 'completed' | 'failed' | 'canceled';

/** WS-C — todo carrier item. */
export interface StepTodoItem {
  text: string;
  completed: boolean;
}

/**
 * WS-C — usage carrier (mirrors AgentUsage from the coding engine, but kept
 * structurally local so the recorder stays decoupled from the engine import
 * graph at the value level — it's a type-only dependency).
 */
export interface StepUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface StepFrame {
  seq: number;
  kind: StepKind;
  payload: Record<string, unknown>;
  occurredAt: number;
}

/**
 * WS-C — large-payload spill. When a structured `detail` body exceeds the
 * inline cap, the recorder may offload it to a task-bound asset and carry only
 * an AssetRef on the wire. Wiring an actual uploader is the daemon's concern
 * (it owns the asset/outbox client); the recorder takes it as an optional hook
 * so the spill behaviour is testable in isolation. When absent, the recorder
 * falls back to inline truncation (`truncated:true`) only — never blocks.
 */
export interface AssetSpillHook {
  /**
   * Persist an oversized text body as a task-bound asset and return its ref.
   * Synchronous shape (the daemon hook resolves a pre-issued ref); a thrown
   * error degrades to inline truncation.
   */
  (input: { taskRunId: string; seq: number; field: string; body: string }): AssetRef | undefined;
}

export interface StepRecorderOptions {
  ws: WsSender;
  /** Identifies which run these steps belong to (matches im_task_run_steps.taskRunId). */
  taskRunId: string;
  /**
   * Throttle window (ms) for reasoning_chunk batching. Defaults to 500ms
   * per §3.0.2 Gap C-④.
   */
  reasoningThrottleMs?: number;
  /**
   * runtime210/09 §3.1b (C3c ruling, Path B) — throttle window for
   * `text_delta` batching. Defaults to 500ms (same policy as reasoning_chunk).
   */
  textDeltaThrottleMs?: number;
  /** Override the wall-clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Hook invoked when a step is dispatched on the wire. Test-only. */
  onSend?: (frame: StepFrame) => void;
  /**
   * WS-C — optional large-payload spill hook. When provided, oversized
   * `detail` text fields spill to a task-bound asset (carrying only an
   * AssetRef). When absent, large bodies are inline-truncated only.
   */
  assetSpill?: AssetSpillHook;
}

// WS-C — inline cap for large detail bodies (shell.output / read.content /
// write.content / edit.unifiedDiff / search.content / *.log). Reuses the
// engine's truncateDiffText threshold (12KB) for consistency.
const INLINE_DETAIL_CAP = 12_000;

// WS-C — which ToolCallDetail.type values are presentation 'action's. Anything
// else (plan / sub_agent / todo-ish / unknown) defaults to 'milestone'.
const ACTION_DETAIL_TYPES = new Set<ToolCallDetail['type']>([
  'shell',
  'read',
  'edit',
  'write',
  'search',
  'fetch',
]);

/** WS-C — derive presentation altitude from a tool detail. */
export function altitudeForDetail(detail: ToolCallDetail | undefined): StepAltitude {
  if (detail && ACTION_DETAIL_TYPES.has(detail.type)) return 'action';
  return 'milestone';
}

export class StepRecorder {
  private seq = 0;
  private reasoningBuf: { texts: string[]; firstAt: number } = { texts: [], firstAt: 0 };
  private reasoningTimer?: NodeJS.Timeout;
  private readonly reasoningThrottleMs: number;
  // runtime210/09 §3.1b (C3c ruling, Path B) — text_delta batch state.
  private textDeltaBuf: { texts: Array<{ text: string; deltaKind?: "text" | "thinking" }>; firstAt: number } = {
    texts: [],
    firstAt: 0,
  };
  private textDeltaTimer?: NodeJS.Timeout;
  private readonly textDeltaThrottleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: StepRecorderOptions) {
    this.reasoningThrottleMs = opts.reasoningThrottleMs ?? 500;
    this.textDeltaThrottleMs = opts.textDeltaThrottleMs ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Push a phase transition step. Immediate (no throttle). */
  recordPhaseChange(phase: string): void {
    // Phase changes (hermes setPhase included) are always milestones.
    this.emit('phase_change', { phase, altitude: 'milestone' });
  }

  /**
   * Push a tool-call step. Immediate.
   *
   * `toolCallId` is the daemon-side correlation id used to pair with the
   * subsequent recordToolResult call. Free-form; adapter decides.
   *
   * WS-C — `opts.detail` carries the lifted structured ToolCallDetail
   * (code-agent providers). `inputSummary` is kept for back-compat. When a
   * detail is present, altitude is derived from its type (shell/read/edit/
   * write/search/fetch → 'action', else 'milestone'). Callers that pass no
   * detail (hermes, CLI adapters) get the unchanged 2-field payload — except
   * an explicit milestone altitude so the long-horizon timeline isn't drowned.
   */
  recordToolCall(
    toolName: string,
    input: unknown,
    toolCallId?: string,
    opts?: { detail?: ToolCallDetail; status?: StepStatus; altitude?: StepAltitude },
  ): void {
    const detail = opts?.detail;
    const altitude = opts?.altitude ?? (detail ? altitudeForDetail(detail) : 'milestone');
    this.emit('tool_call', {
      toolName,
      inputSummary: summarize(input),
      ...(toolCallId ? { toolCallId } : {}),
      ...(detail ? { detail: this.capDetail(detail) } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
      altitude,
    });
  }

  /**
   * Push a tool-result step. Immediate.
   *
   * WS-C — `opts.detail` (terminal detail body) + `opts.status` lifecycle
   * carry the structured result. `outputSummary` is kept for back-compat.
   */
  recordToolResult(
    toolCallId: string,
    output: unknown,
    opts?: { detail?: ToolCallDetail; status?: StepStatus; altitude?: StepAltitude },
  ): void {
    const detail = opts?.detail;
    const altitude = opts?.altitude ?? (detail ? altitudeForDetail(detail) : 'action');
    this.emit('tool_result', {
      toolCallId,
      outputSummary: summarize(output),
      ...(detail ? { detail: this.capDetail(detail) } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
      altitude,
    });
  }

  /** WS-C — push a todo list snapshot. Always a milestone. */
  recordTodo(items: StepTodoItem[]): void {
    this.emit('todo', { items, altitude: 'milestone' });
  }

  /**
   * WS-C — push a usage snapshot (fills the previously-zero RunMetrics.tokens).
   * Not a timeline action; tagged milestone so it never collapses.
   */
  recordUsage(usage: StepUsage): void {
    this.emit('usage', { usage, altitude: 'milestone' });
  }

  /**
   * Buffer a reasoning chunk for batched dispatch. Multiple chunks within
   * `reasoningThrottleMs` are concatenated and emitted as a single
   * `reasoning_chunk` step when the timer fires.
   */
  recordReasoningChunk(text: string): void {
    if (!text) return;
    if (this.reasoningBuf.texts.length === 0) {
      this.reasoningBuf.firstAt = this.now();
    }
    this.reasoningBuf.texts.push(text);
    if (this.reasoningTimer) return;
    this.reasoningTimer = setTimeout(() => {
      this.flushReasoning();
    }, this.reasoningThrottleMs);
    this.reasoningTimer.unref?.();
  }

  /** Push an error step. Immediate. */
  recordError(message: string, payload?: Record<string, unknown>): void {
    this.emit('error', { message, ...(payload ?? {}) });
  }

  /**
   * runtime210/09 §3.1b (C3c ruling, Path B) — buffer a pi-native text delta
   * for batched dispatch. Multiple deltas within `textDeltaThrottleMs` are
   * concatenated into one `text_delta` step (same policy as reasoning_chunk).
   * The batch's `deltaKind` is taken from the first buffered delta — it is
   * informational metadata; the UI aggregates every `text_delta` row into the
   * running-time stream regardless of kind.
   */
  recordTextDelta(text: string, opts?: { deltaKind?: "text" | "thinking" }): void {
    if (!text) return;
    if (this.textDeltaBuf.texts.length === 0) {
      this.textDeltaBuf.firstAt = this.now();
    }
    this.textDeltaBuf.texts.push({ text, deltaKind: opts?.deltaKind });
    if (this.textDeltaTimer) return;
    this.textDeltaTimer = setTimeout(() => {
      this.flushTextDelta();
    }, this.textDeltaThrottleMs);
    this.textDeltaTimer.unref?.();
  }

  /**
   * Force any pending reasoning buffer out the door. Call on shutdown so
   * trailing tokens aren't lost.
   */
  flush(): void {
    this.flushReasoning();
    this.flushTextDelta();
  }

  /** Test helper. */
  get currentSeq(): number {
    return this.seq;
  }

  private flushReasoning(): void {
    if (this.reasoningTimer) {
      clearTimeout(this.reasoningTimer);
      this.reasoningTimer = undefined;
    }
    if (this.reasoningBuf.texts.length === 0) return;
    const text = this.reasoningBuf.texts.join('');
    const firstAt = this.reasoningBuf.firstAt;
    this.reasoningBuf = { texts: [], firstAt: 0 };
    // Use firstAt as the occurredAt so the timeline reflects when the
    // reasoning began, not when the flush happened.
    this.emit('reasoning_chunk', { text }, firstAt);
  }

  // runtime210/09 §3.1b — same flush semantics as reasoning_chunk: occurredAt
  // reflects the batch start.
  private flushTextDelta(): void {
    if (this.textDeltaTimer) {
      clearTimeout(this.textDeltaTimer);
      this.textDeltaTimer = undefined;
    }
    if (this.textDeltaBuf.texts.length === 0) return;
    // Join the delta TEXTS (entries are { text, deltaKind } wrappers — joining
    // the wrappers directly would emit "[object Object]").
    const text = this.textDeltaBuf.texts.map((entry) => entry.text).join('');
    const first = this.textDeltaBuf.texts[0];
    const deltaKind = (first ? first.deltaKind : undefined) ?? "text";
    const firstAt = this.textDeltaBuf.firstAt;
    this.textDeltaBuf = { texts: [], firstAt: 0 };
    this.emit("text_delta", { text, deltaKind }, firstAt);
  }

  // WS-C — the large text fields per detail type that may need capping/spill.
  private static readonly LARGE_FIELDS: Record<string, readonly string[]> = {
    // `script` (memory203/18 R5.2) carries the full python source behind an
    // extracted CLI command — same cap/spill treatment as output.
    shell: ['output', 'script'],
    read: ['content'],
    write: ['content'],
    edit: ['unifiedDiff'],
    search: ['content'],
    fetch: ['result'],
    worktree_setup: ['log'],
    sub_agent: ['log'],
  };

  /**
   * WS-C — cap large text bodies inside a ToolCallDetail. Each oversized field
   * is inline-truncated to INLINE_DETAIL_CAP with `<field>Truncated:true`; when
   * an assetSpill hook is wired, the full body spills to a task-bound asset and
   * the AssetRef is attached as `<field>Spill`. Returns a shallow copy — the
   * input detail is never mutated.
   */
  private capDetail(detail: ToolCallDetail): Record<string, unknown> {
    const fields = StepRecorder.LARGE_FIELDS[detail.type];
    if (!fields) return detail as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...(detail as unknown as Record<string, unknown>) };
    for (const field of fields) {
      const value = out[field];
      if (typeof value !== 'string' || value.length <= INLINE_DETAIL_CAP) continue;
      if (this.opts.assetSpill) {
        try {
          const ref = this.opts.assetSpill({
            taskRunId: this.opts.taskRunId,
            seq: this.seq + 1,
            field,
            body: value,
          });
          if (ref) {
            out[`${field}Spill`] = ref;
          }
        } catch {
          /* spill is best-effort; fall through to inline truncation */
        }
      }
      out[field] = `${value.slice(0, INLINE_DETAIL_CAP)}\n...[truncated ${value.length - INLINE_DETAIL_CAP} chars]`;
      out[`${field}Truncated`] = true;
    }
    return out;
  }

  private emit(kind: StepKind, payload: Record<string, unknown>, occurredAt?: number): void {
    const frame: StepFrame = {
      seq: ++this.seq,
      kind,
      payload,
      occurredAt: occurredAt ?? this.now(),
    };
    const msg = envelope('task.step.append', {
      taskRunId: this.opts.taskRunId,
      step: frame,
    });
    try {
      if (this.opts.ws.isOpen && !this.opts.ws.isOpen()) {
        // Best-effort: WS down → drop. Reasoning chunks etc. are observability,
        // not durable state. Daemon does not buffer steps locally — Wave 3.5
        // server-side step writer + Gap D-④ reconnect catch-up cover gaps.
        try {
          this.opts.onSend?.(frame);
        } catch {
          /* hook must not throw */
        }
        return;
      }
      this.opts.ws.send(msg);
      try {
        this.opts.onSend?.(frame);
      } catch {
        /* hook must not throw */
      }
    } catch {
      // Drop on send failure. Step recording is best-effort by design;
      // unlike heartbeat, there's no retry value (the timeline doesn't
      // benefit from a stale frame arriving late). Heartbeat handles
      // "daemon alive" liveness independently.
    }
  }
}

/**
 * Trim a payload value into a string suitable for telemetry. Caps at
 * ~512 chars so a runaway base64 blob doesn't dominate the WS message
 * size. Objects are JSON-stringified with the same cap.
 */
const MAX_SUMMARY_CHARS = 512;
function summarize(value: unknown): string {
  let text: string;
  if (value == null) text = '';
  else if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_SUMMARY_CHARS) {
    return `${text.slice(0, MAX_SUMMARY_CHARS)}…(+${text.length - MAX_SUMMARY_CHARS} chars)`;
  }
  return text;
}

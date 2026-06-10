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

export type StepKind =
  | 'phase_change'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning_chunk'
  | 'progress'
  | 'error';

export interface StepFrame {
  seq: number;
  kind: StepKind;
  payload: Record<string, unknown>;
  occurredAt: number;
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
  /** Override the wall-clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Hook invoked when a step is dispatched on the wire. Test-only. */
  onSend?: (frame: StepFrame) => void;
}

export class StepRecorder {
  private seq = 0;
  private reasoningBuf: { texts: string[]; firstAt: number } = { texts: [], firstAt: 0 };
  private reasoningTimer?: NodeJS.Timeout;
  private readonly reasoningThrottleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: StepRecorderOptions) {
    this.reasoningThrottleMs = opts.reasoningThrottleMs ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Push a phase transition step. Immediate (no throttle). */
  recordPhaseChange(phase: string): void {
    this.emit('phase_change', { phase });
  }

  /**
   * Push a tool-call step. Immediate.
   *
   * `toolCallId` is the daemon-side correlation id used to pair with the
   * subsequent recordToolResult call. Free-form; adapter decides.
   */
  recordToolCall(toolName: string, input: unknown, toolCallId?: string): void {
    this.emit('tool_call', {
      toolName,
      inputSummary: summarize(input),
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  /** Push a tool-result step. Immediate. */
  recordToolResult(toolCallId: string, output: unknown): void {
    this.emit('tool_result', {
      toolCallId,
      outputSummary: summarize(output),
    });
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
   * Force any pending reasoning buffer out the door. Call on shutdown so
   * trailing tokens aren't lost.
   */
  flush(): void {
    this.flushReasoning();
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

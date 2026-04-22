/**
 * Approval Gateway (Pattern P5, v1.9.0).
 *
 * Adapter-side coordinator for high-risk tool calls that need L5 approval.
 * The flow:
 *
 *   1. Adapter emits agent.approval.request { callId, prompt, ttlMs }.
 *   2. Runtime (or remote user via APNS) responds with agent.approval.result.
 *   3. Adapter's canCallTool(callId) returns the decision or falls back on
 *      timeout.
 *
 * This class is a lightweight Map<callId, Deferred> — no network, no
 * persistence. The transport (WS / HTTP / local socket) lives in the
 * adapter that owns this instance.
 */

export type ApprovalDecision = 'allow' | 'deny' | 'ask' | 'defer';

export interface ApprovalResult {
  decision: ApprovalDecision;
  by: 'local' | 'remote';
  updatedInput?: unknown;
}

export interface ApprovalWaitOptions {
  ttlMs?: number;
  /** Decision to use if the gateway times out before a response arrives. */
  defaultOnTimeout?: ApprovalDecision;
}

interface Pending {
  resolve: (r: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalGateway {
  private readonly pending = new Map<string, Pending>();

  /** Register that an approval request was sent for a given callId. The
   *  returned promise resolves when `resolve(callId, result)` is called, or
   *  on timeout (default `deny`). */
  waitForDecision(callId: string, opts: ApprovalWaitOptions = {}): Promise<ApprovalResult> {
    const ttl = opts.ttlMs ?? 30_000;
    const fallback: ApprovalDecision = opts.defaultOnTimeout ?? 'deny';

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ decision: fallback, by: 'local' });
      }, ttl);

      this.pending.set(callId, { resolve, timer });
    });
  }

  /** Resolve a pending approval. No-op if the callId has already timed out
   *  or was never registered — we accept late responses as dropped but don't
   *  error out (reduces noise from flaky network approvals). */
  resolve(callId: string, result: ApprovalResult): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    entry.resolve(result);
    return true;
  }

  /** Cancel a pending approval (e.g. session ended). Resolves with `deny`. */
  cancel(callId: string): boolean {
    return this.resolve(callId, { decision: 'deny', by: 'local' });
  }

  /** Number of outstanding approvals. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Cancel every outstanding approval — used on session end. */
  cancelAll(): void {
    for (const callId of Array.from(this.pending.keys())) {
      this.cancel(callId);
    }
  }
}

// release202 — Clarify bridge (cloud orchestration brain for Hermes clarify).
//
// Wiring (full chain):
//   agent calls `clarify` (Hermes) → clarify.request SSE → daemon
//   consumeSessionsSse surfaces it as task.dispatch.progress { detail.kind:
//   'clarify' } → cloud handler records it here + posts a question message →
//   user replies in chat → message.service consults this bridge → if a pending
//   clarify matches, forwards `task.clarify.resolve` to the daemon (instead of
//   a fresh dispatch) → daemon resolveClarify → Hermes run resumes in place.
//
// This module is the *decision* layer (pure, unit-testable). The thin glue
// (post the card via messageService, send the ws event) lives at the call
// sites in ws/handler.ts and services/message.service.ts.
//
// Mirrors the approval HITL round-trip but carries the user's *answer* (chosen
// option text or free-form) rather than an enum decision.

export interface PendingClarify {
  conversationId: string;
  /** Run/task id used by the daemon run-session registry to find the run. */
  taskId: string;
  runId: string | null;
  clarifyId: string;
  /** The hosted agent that asked — used to target the daemon resolve. */
  agentImUserId: string;
  /** Owning daemon (for ws targeting); optional — cloud resolves at send time. */
  daemonId?: string;
  question: string;
  choices: string[] | null;
  createdAt: number;
}

export interface ClarifyResolveSignal {
  type: 'task.clarify.resolve';
  taskId: string;
  agentImUserId: string;
  response: string;
  clarifyId: string;
  runId?: string;
}

/**
 * One active clarify per conversation (the agent blocks until answered, so a
 * conversation cannot have two concurrent pending clarifies for the same run).
 * In-memory by design: a clarify is only meaningful while the daemon holds the
 * dispatch open; a cloud restart drops the dispatch too (run times out on the
 * Hermes side after clarify_timeout), so there is nothing durable to keep.
 */
export class ClarifyBridge {
  private readonly pending = new Map<string, PendingClarify>();

  /** Record a clarify surfaced from a daemon progress event. */
  recordRequest(entry: PendingClarify): PendingClarify {
    this.pending.set(entry.conversationId, entry);
    return entry;
  }

  getPending(conversationId: string): PendingClarify | undefined {
    return this.pending.get(conversationId);
  }

  hasPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  clear(conversationId: string): void {
    this.pending.delete(conversationId);
  }

  /**
   * Inbound-reply decision. Called at the top of message send. Returns a
   * resolve signal (and clears the pending entry) when this human message
   * answers a pending clarify; returns null otherwise (→ normal dispatch).
   *
   * Choice mapping: if the clarify offered choices and the user typed a
   * 1-based index ("2"), substitute the option text — mirrors Hermes'
   * messaging-gateway text-fallback intercept.
   */
  tryResolveInbound(
    conversationId: string,
    senderRole: 'human' | 'agent' | string,
    content: string,
  ): ClarifyResolveSignal | null {
    const p = this.pending.get(conversationId);
    if (!p) return null;
    // Only a human reply answers a clarify; agent/system messages pass through
    // to normal handling (and must NOT consume the pending entry).
    if (senderRole !== 'human') return null;
    const text = (content ?? '').trim();
    if (!text) return null;

    let response = text;
    if (p.choices && p.choices.length > 0) {
      const idx = Number.parseInt(text, 10);
      if (String(idx) === text && idx >= 1 && idx <= p.choices.length) {
        response = p.choices[idx - 1]!;
      }
    }

    this.pending.delete(conversationId);
    return {
      type: 'task.clarify.resolve',
      taskId: p.taskId,
      agentImUserId: p.agentImUserId,
      response,
      clarifyId: p.clarifyId,
      ...(p.runId ? { runId: p.runId } : {}),
    };
  }
}

/** Process-wide singleton (cloud IM is single-process in-instance). */
export const clarifyBridge = new ClarifyBridge();

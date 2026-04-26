/**
 * Prismer IM — Message ACK Tracker
 *
 * Tracks outbound WebSocket messages that require acknowledgment.
 * If a client disconnects before ACK-ing, messages are queued for
 * redelivery on reconnect.
 *
 * Design:
 *   - Each outbound message gets a unique ackId (monotonic counter)
 *   - Server waits up to ACK_TIMEOUT_MS (5s) for client to reply
 *     with {"type":"ack","ackId":"xxx"}
 *   - Un-ACK'd messages move to the undelivered queue (per userId)
 *   - On reconnect, undelivered messages are replayed with isRetry=true
 *   - Undelivered queue is bounded (MAX_UNDELIVERED per user, TTL 5min)
 *
 * Memory-only — no DB persistence. This covers the gap between
 * WS disconnect and reconnect on the same Pod. Cross-Pod recovery
 * uses the existing /sync endpoint.
 */

const ACK_TIMEOUT_MS = 5_000;
const MAX_UNDELIVERED = 100;
const UNDELIVERED_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 30_000; // Run cleanup every 30s

export interface PendingMessage {
  ackId: string;
  userId: string;
  payload: Record<string, unknown>;
  sentAt: number;
  retries: number;
}

/**
 * Event types that are ephemeral / high-frequency and should NOT
 * be tracked for ACK (they carry no durable state worth retrying).
 */
const SKIP_ACK_TYPES = new Set([
  'pong',
  'typing.indicator',
  'presence.changed',
  'authenticated',
  'error',
  'message.stream.chunk',
]);

export class AckTracker {
  /** ackId -> pending message awaiting ACK */
  private pending = new Map<string, PendingMessage>();
  /** userId -> list of undelivered messages (sorted oldest-first) */
  private undelivered = new Map<string, PendingMessage[]>();
  /** Monotonic counter for ackId generation */
  private counter = 0;
  /** Cleanup timer handle */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Track an outbound message. Returns the assigned ackId, or null
   * if this event type is exempt from ACK tracking.
   */
  track(userId: string, payload: Record<string, unknown>): string | null {
    const eventType = (payload as any)?.type as string | undefined;
    if (eventType && SKIP_ACK_TYPES.has(eventType)) {
      return null;
    }

    const ackId = `ack_${++this.counter}`;
    const entry: PendingMessage = {
      ackId,
      userId,
      payload,
      sentAt: Date.now(),
      retries: 0,
    };
    this.pending.set(ackId, entry);

    // Schedule timeout: if not ACK'd, move to undelivered
    setTimeout(() => {
      const msg = this.pending.get(ackId);
      if (msg) {
        this.pending.delete(ackId);
        this.addUndelivered(msg);
      }
    }, ACK_TIMEOUT_MS);

    return ackId;
  }

  /**
   * Client acknowledged a message. Remove from pending.
   */
  ack(ackId: string): boolean {
    return this.pending.delete(ackId);
  }

  /**
   * Called when a client disconnects. Move all their pending messages
   * to the undelivered queue immediately (don't wait for timeout).
   */
  handleDisconnect(userId: string): void {
    for (const [ackId, msg] of this.pending) {
      if (msg.userId === userId) {
        this.pending.delete(ackId);
        this.addUndelivered(msg);
      }
    }
  }

  /**
   * Get and clear undelivered messages for a user (called on reconnect).
   */
  getUndelivered(userId: string): PendingMessage[] {
    const msgs = this.undelivered.get(userId);
    if (!msgs || msgs.length === 0) return [];

    // Remove expired entries
    const now = Date.now();
    const valid = msgs.filter((m) => now - m.sentAt < UNDELIVERED_TTL_MS);

    // Clear the queue (they'll be re-tracked on send)
    this.undelivered.delete(userId);
    return valid;
  }

  /**
   * Remove expired entries from the undelivered queue.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [userId, msgs] of this.undelivered) {
      const valid = msgs.filter((m) => now - m.sentAt < UNDELIVERED_TTL_MS);
      if (valid.length === 0) {
        this.undelivered.delete(userId);
      } else {
        this.undelivered.set(userId, valid);
      }
    }
  }

  /**
   * Stop the cleanup timer (for graceful shutdown).
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Stats for monitoring.
   */
  getStats(): { pendingCount: number; undeliveredUsers: number; undeliveredMessages: number } {
    let undeliveredMessages = 0;
    for (const msgs of this.undelivered.values()) {
      undeliveredMessages += msgs.length;
    }
    return {
      pendingCount: this.pending.size,
      undeliveredUsers: this.undelivered.size,
      undeliveredMessages,
    };
  }

  // ─── Private ─────────────────────────────────────────────

  private addUndelivered(msg: PendingMessage): void {
    let list = this.undelivered.get(msg.userId);
    if (!list) {
      list = [];
      this.undelivered.set(msg.userId, list);
    }
    list.push(msg);
    // Evict oldest if over limit
    while (list.length > MAX_UNDELIVERED) {
      list.shift();
    }
  }
}

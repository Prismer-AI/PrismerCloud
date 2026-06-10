// Outbox upload worker — phase-1 C2.
//
// Polls the daemon's `memory_outbox` table for status='pending' rows, batches
// them into `POST /api/im/memory/sync/inbox` (Line A A3), and triages the
// per-event response:
//
//   - acked eventId   → UPDATE memory_outbox SET status='acked'
//   - schema_invalid  → MOVE row to memory_outbox_dead_letter (never retry)
//   - other error code → leave pending (transient — retry next tick)
//
// HTTP status triage:
//   - 200 with body { ok: true, data: { acked, errors } } → per-event handling above
//   - 4xx (whole batch rejected, e.g. auth)               → leave pending; log; surface after N consecutive
//   - 5xx / network                                       → leave pending; log
//
// Phase-0 envelope contract (envelope.ts) is enforced at enqueue-time, not
// here — schema-fail at enqueue lands directly in dead_letter; this worker
// only sees rows that already passed local validation.
//
// Auth note: Line A's sync inbox filters events to those where
// `actorImUserId === JWT.subject`. The daemon's CloudClient JWT is the
// human-user token, so events emitted under an agent's imUserId will be
// rejected (403). Phase-1 ships a single per-actor JWT for the daemon
// owner; agent-actor events stay pending until follow-up work introduces
// per-agent token issuance — see phase-1 TODO doc.

import type { CloudClient } from '../../auth.js';
import type { MemoryRuntime } from './runtime.js';

export interface OutboxWorkerOptions {
  runtime: MemoryRuntime;
  cloud: CloudClient;
  /** Polling interval. Default 5000ms. */
  pollIntervalMs?: number;
  /**
   * Max events per batch. Default 50. Cloud sync inbox is iterative server-side,
   * so larger batches improve throughput at the cost of higher per-request latency.
   */
  batchSize?: number;
  /**
   * Log "this workspace's sync inbox is failing repeatedly" after this many
   * consecutive 5xx/network failures. Default 5. Each tick that fails increments;
   * a successful flush resets to 0.
   */
  maxConsecutiveFailures?: number;
  log?: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
}

interface OutboxRow {
  id: string;
  eventType: string;
  envelopeJson: string;
}

interface SyncInboxResponseBody {
  ok: boolean;
  data?: {
    acked: string[];
    errors: Array<{ eventId: string; code: string; message: string }>;
  };
  error?: { code: string; message: string };
}

export interface FlushResult {
  workspaces: number;
  flushed: number;
  deadLettered: number;
  pendingRemain: number;
  transientFailures: number;
}

export class MemoryOutboxWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private consecutiveFailures = new Map<string, number>();

  constructor(private readonly opts: OutboxWorkerOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.pollIntervalMs ?? 5000;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log('error', `tick threw: ${(err as Error).message}`);
      });
    }, interval);
    this.log(
      'info',
      `started: interval=${interval}ms batchSize=${this.opts.batchSize ?? 50}`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Force-flush all open workspace outboxes once. Used by /local/memory/flush
   * RPC + tests.
   *
   * Race fix (pre-deploy review): originally bypassed the busy guard via
   * tick(true). Two concurrent invocations (auto-tick + manual flushNow, or
   * two manual flushes) would both `SELECT ... WHERE status='pending' LIMIT N`
   * and POST the same rows. Cloud dedupes via idempotencyKey, but on local
   * apply the second flush's `INSERT INTO memory_outbox_dead_letter (id,...)`
   * with `dl_${row.id}` PK collides with the first flush's already-committed
   * dead-letter row, throwing inside the transaction.
   *
   * Simpler fix: serialize against the busy flag. If a tick is in-flight, wait
   * for it to clear (50ms poll is acceptable for an admin-triggered flush),
   * then run a normal (non-force) tick. Avoids introducing a third schema
   * state for in-flight rows.
   */
  async flushNow(): Promise<FlushResult> {
    while (this.busy) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.tick(false);
  }

  private async tick(force = false): Promise<FlushResult> {
    if (this.busy && !force) {
      return { workspaces: 0, flushed: 0, deadLettered: 0, pendingRemain: 0, transientFailures: 0 };
    }
    this.busy = true;
    let flushed = 0;
    let deadLettered = 0;
    let pendingRemain = 0;
    let transientFailures = 0;
    const workspaceIds = this.opts.runtime.workspaceIds();
    try {
      for (const wsId of workspaceIds) {
        const r = await this.flushWorkspace(wsId);
        flushed += r.flushed;
        deadLettered += r.deadLettered;
        pendingRemain += r.pendingRemain;
        if (r.transient) transientFailures += 1;
      }
    } finally {
      this.busy = false;
    }
    return { workspaces: workspaceIds.length, flushed, deadLettered, pendingRemain, transientFailures };
  }

  private async flushWorkspace(workspaceId: string): Promise<{
    flushed: number;
    deadLettered: number;
    pendingRemain: number;
    transient: boolean;
  }> {
    const slot = this.opts.runtime.peek(workspaceId);
    if (!slot) return { flushed: 0, deadLettered: 0, pendingRemain: 0, transient: false };

    const db = slot.store.rawDb();
    const batchSize = this.opts.batchSize ?? 50;

    const rows = db
      .prepare(
        `SELECT id, eventType, envelopeJson FROM memory_outbox
         WHERE status = 'pending' ORDER BY createdAt LIMIT ?`,
      )
      .all(batchSize) as OutboxRow[];

    if (rows.length === 0) {
      // Reset failure counter on a clean idle tick — not strictly necessary but
      // prevents long-idle workspaces from carrying stale failure context.
      this.consecutiveFailures.delete(workspaceId);
      return { flushed: 0, deadLettered: 0, pendingRemain: 0, transient: false };
    }

    let events: Array<{ eventId?: string }>;
    try {
      events = rows.map((r) => JSON.parse(r.envelopeJson) as { eventId?: string });
    } catch (err) {
      // Should be impossible: enqueue() persists JSON.stringify of validated
      // envelopes. Defensive: dead-letter the entire batch so we don't loop forever.
      this.log('error', `workspace=${workspaceId} batch JSON parse failed: ${(err as Error).message}`);
      const now = Date.now();
      const dlInsert = db.prepare(
        `INSERT INTO memory_outbox_dead_letter (id, eventType, rawJson, errorJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      );
      const dlDelete = db.prepare(`DELETE FROM memory_outbox WHERE id = ?`);
      db.transaction(() => {
        for (const row of rows) {
          dlInsert.run(`dl_${row.id}`, row.eventType, row.envelopeJson, JSON.stringify({ code: 'envelope_json_corrupt' }), now);
          dlDelete.run(row.id);
        }
      })();
      return { flushed: 0, deadLettered: rows.length, pendingRemain: 0, transient: false };
    }

    const res = await this.opts.cloud.request<SyncInboxResponseBody>(
      'POST',
      '/api/im/memory/sync/inbox',
      { body: { events }, timeoutMs: 30_000 },
    );

    if (!res.ok) {
      // CloudClient.request returns ok=false for either transport-level
      // failures (status=0; network/timeout/abort) OR HTTP 4xx/5xx. In both
      // cases `data` is absent — so the prior `(!res.ok || !res.data)` check
      // collapsed both branches into one and made the dedicated 4xx block
      // below unreachable. We now distinguish:
      //
      //   - status === 0  → transport failure; escalates to 'error' after
      //                     maxConsecutiveFailures so a flapping cloud is
      //                     visibly loud in logs.
      //   - status >= 400 → HTTP-level rejection (e.g. 403 agent-actor).
      //                     Per the file header comment lines 12-15 this is
      //                     known-limitation behavior until per-actor JWT
      //                     ships, so we keep it at 'warn' and DON'T let it
      //                     escalate to 'error' (would noise alerts).
      //
      // Both leave events pending — the caller (tick loop) treats this as
      // transient. Per-event dead-letter logic only runs on a 200-OK envelope.
      const isTransport = res.status === 0;
      const fails = (this.consecutiveFailures.get(workspaceId) ?? 0) + 1;
      this.consecutiveFailures.set(workspaceId, fails);
      const max = this.opts.maxConsecutiveFailures ?? 5;
      const level: 'warn' | 'error' = isTransport && fails >= max ? 'error' : 'warn';
      const kind = isTransport ? 'transient' : '4xx/5xx';
      this.log(
        level,
        `workspace=${workspaceId} sync inbox ${kind} #${fails} (status=${res.status} code=${res.error?.code ?? 'unknown'}) — events stay pending`,
      );
      return { flushed: 0, deadLettered: 0, pendingRemain: rows.length, transient: true };
    }

    if (!res.data || !res.data.ok || !res.data.data) {
      // 200 with missing/empty body or envelope.ok=false. Shouldn't happen
      // per Line A contract; defensive — log + leave events pending.
      this.log(
        'warn',
        `workspace=${workspaceId} sync inbox 200 but body invalid: ${JSON.stringify(res.data?.error ?? null)}`,
      );
      return { flushed: 0, deadLettered: 0, pendingRemain: rows.length, transient: true };
    }

    this.consecutiveFailures.delete(workspaceId);

    const { acked, errors } = res.data.data;
    const ackedSet = new Set(acked);
    const errorsByEventId = new Map(errors.map((e) => [e.eventId, e] as const));

    let flushed = 0;
    let deadLettered = 0;
    const now = Date.now();

    const ackStmt = db.prepare(
      `UPDATE memory_outbox SET status = 'acked', ackedAt = ? WHERE id = ?`,
    );
    const dlInsertStmt = db.prepare(
      `INSERT INTO memory_outbox_dead_letter (id, eventType, rawJson, errorJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
    );
    const dlDeleteStmt = db.prepare(`DELETE FROM memory_outbox WHERE id = ?`);

    db.transaction(() => {
      for (const row of rows) {
        const env = (() => {
          try {
            return JSON.parse(row.envelopeJson) as { eventId?: string };
          } catch {
            return null;
          }
        })();
        const eventId = env?.eventId;
        if (eventId && ackedSet.has(eventId)) {
          ackStmt.run(now, row.id);
          flushed += 1;
          continue;
        }
        if (eventId && errorsByEventId.has(eventId)) {
          const e = errorsByEventId.get(eventId)!;
          // Cloud-side reasons that are PERMANENT (no point retrying):
          //   schema_invalid     — local schema was OK but cloud disagrees (version skew)
          //   unknown_event_type — daemon emits an eventType cloud doesn't route
          //   forbidden          — auth/ACL rejected (e.g. cross-actor)
          //                        (debatable; could be transient if token rotates,
          //                         but for now treat as permanent to avoid loop)
          const permanent =
            e.code === 'schema_invalid' ||
            e.code === 'unknown_event_type' ||
            e.code === 'forbidden';
          if (permanent) {
            dlInsertStmt.run(
              `dl_${row.id}`,
              row.eventType,
              row.envelopeJson,
              JSON.stringify(e),
              now,
            );
            dlDeleteStmt.run(row.id);
            deadLettered += 1;
          }
          // Else: leave pending; next tick retries.
        }
        // No mention of this eventId at all — server may have silently dropped
        // (shouldn't happen per Line A contract). Leave pending for next tick.
      }
    })();

    return { flushed, deadLettered, pendingRemain: rows.length - flushed - deadLettered, transient: false };
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    if (this.opts.log) {
      this.opts.log[level](`[outbox-worker] ${msg}`);
    } else {
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(`[outbox-worker] ${msg}\n`);
    }
  }
}

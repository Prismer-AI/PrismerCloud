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
// Auth note: the daemon authenticates with its owner credential but preserves
// each event's real `actorImUserId`. Cloud performs a per-event ownership gate:
// actor === caller OR an agent owned by that caller in the workspace is legal;
// an unrelated/forged actor is returned as `forbidden_actor` and dead-lettered.
// This keeps agent provenance without issuing a bearer token per agent.

import type { CloudClient } from '../../auth.js';
import type { MemoryRuntime } from './runtime.js';
import type { MemoryKeyManager } from './key-manager.js';
import { systemCap } from './cap.js';
import { encrypt as gcmEncrypt } from './crypto-cipher.js';

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
  /**
   * Optional hook fired once per workspace that had at least one event
   * flushed (acked) on a tick. Used by the Dream scheduler (M-C, doc 25
   * §3) to learn which workspaces are seeing memory activity so it has
   * something to tick. Best-effort: a throw here is swallowed so it can
   * never break the flush loop.
   */
  onWorkspaceFlushed?: (workspaceId: string, flushed: number) => void;
  /**
   * memory202 doc 06 (at-rest encryption MVP). When provided AND
   * FF_MEMORY_ENCRYPTION_ENABLED=true, the flush encrypts the `payload.content`
   * of any `memory.page.upsert` event whose page row is `encrypted=true`, using
   * the per-workspace key from this manager — BEFORE the batch is POSTed to the
   * cloud. The local SQLite row stays plaintext; only the cloud-bound payload is
   * ciphertext. Omit (or leave the flag OFF) for zero behavior change.
   */
  keyManager?: MemoryKeyManager;
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
    errors: Array<{ eventId: string; code: string; message: string; retryable?: boolean }>;
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

export interface PageAuthorityReceipt {
  pageId: string;
  path: string;
  version: number;
  contentHash: string;
  authority?: 'cloud' | 'outbox';
  authorityEventId?: string;
  /**
   * 弱确认标记（supersede-ack）：readback 时页面版本已严格前进、hash ≠ receipt
   * —— 本次写入已被后续写入覆盖，按已确认记账但**与精确确认审计可分**。
   * 协议层无法区分「同一 agent 三连写」与「其他来源覆盖」，消费方（durability
   * 账本 / 审计）可据此对弱确认单独抽样复核。
   */
  superseded?: boolean;
}

export class MemoryAuthorityConfirmationError extends Error {
  constructor(
    public readonly code:
      | 'memory_authority_pending'
      | 'memory_authority_rejected'
      | 'memory_authority_receipt_missing'
      | 'memory_authority_readback_failed'
      | 'memory_authority_readback_mismatch',
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryAuthorityConfirmationError';
  }
}

// memory211/08 A4-② — last-sample memory-outbox health. The 5s flush tick is
// the ONLY writer (it owns the DB I/O); the daemon /healthz projects this
// snapshot so the settings-page dead-letter row stays zero-I/O — same
// discipline as postTurnJobs / assetOutbox (absent until the first tick).
type MemoryOutboxHealth = { pending: number; deadLetter: number; sampledAt: string };

let lastMemoryOutboxSample: Readonly<MemoryOutboxHealth> | null = null;

/** Readonly so no consumer can mutate the shared cached sample. */
export function memoryOutboxHealthSnapshot(): Readonly<MemoryOutboxHealth> | null {
  return lastMemoryOutboxSample;
}

export class MemoryOutboxWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private consecutiveFailures = new Map<string, number>();
  private workspaceLockTails = new Map<string, Promise<void>>();

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

  /**
   * Flush and verify the exact Page events that back a pre-reply durability
   * receipt. Local Page rows are only a staging replica: `persisted` is legal
   * after the Cloud sync inbox has acked the matching page/path/version/hash.
   */
  async confirmPageReceipts(
    workspaceId: string,
    receipts: PageAuthorityReceipt[],
    signal?: AbortSignal,
  ): Promise<PageAuthorityReceipt[]> {
    if (receipts.length === 0) {
      throw new MemoryAuthorityConfirmationError(
        'memory_authority_receipt_missing',
        false,
        'authoritative Memory confirmation requires at least one Page receipt',
      );
    }
    const slot = this.opts.runtime.peek(workspaceId);
    if (!slot) {
      throw new MemoryAuthorityConfirmationError(
        'memory_authority_receipt_missing',
        false,
        `workspace memory slot is not open: ${workspaceId}`,
      );
    }
    const outboxReceipts = receipts.filter((receipt) => receipt.authority !== 'cloud');
    if (outboxReceipts.length === 0) {
      return this.readBackPageReceipts(workspaceId, receipts, signal);
    }
    if (outboxReceipts.some((receipt) => !receipt.authorityEventId)) {
      throw new MemoryAuthorityConfirmationError(
        'memory_authority_receipt_missing',
        false,
        'outbox-backed Page receipts require an exact authorityEventId',
      );
    }
    const before = inspectAuthorityRows(slot.store.rawDb(), outboxReceipts);
    if (before.every((row) => row.state === 'acked')) {
      return this.readBackPageReceipts(workspaceId, receipts, signal);
    }
    assertNoInvalidAuthorityRows(before);

    await this.withWorkspaceLock(workspaceId, async () => {
      const rowIds = before
        .filter((row): row is AuthorityRowMatch & { state: 'pending'; rowId: string } =>
          row.state === 'pending' && typeof row.rowId === 'string')
        .map((row) => row.rowId);
      const result = await this.flushWorkspace(workspaceId, { rowIds, signal });
      if (result.flushed > 0 && this.opts.onWorkspaceFlushed) {
        try {
          this.opts.onWorkspaceFlushed(workspaceId, result.flushed);
        } catch {
          /* best-effort — never break authority confirmation */
        }
      }
    });

    const after = inspectAuthorityRows(slot.store.rawDb(), outboxReceipts);
    if (after.every((row) => row.state === 'acked')) {
      return this.readBackPageReceipts(workspaceId, receipts, signal);
    }
    assertNoInvalidAuthorityRows(after);
    throw new MemoryAuthorityConfirmationError(
      'memory_authority_pending',
      true,
      `Cloud has not acknowledged ${after.filter((row) => row.state === 'pending').length} Page receipt(s)`,
    );
  }

  private async tick(force = false): Promise<FlushResult> {
    if (this.busy && !force) {
      // A concurrent tick is already flushing (and will sample on its way
      // out); re-sampling here would race it for no fresher data.
      return { workspaces: 0, flushed: 0, deadLettered: 0, pendingRemain: 0, transientFailures: 0 };
    }
    this.busy = true;
    let flushed = 0;
    let deadLettered = 0;
    let pendingRemain = 0;
    let transientFailures = 0;
    const workspaceIds = this.opts.runtime.workspaceIds();
    try {
      const results = await Promise.all(workspaceIds.map(async (wsId) => {
        const r = await this.withWorkspaceLock(wsId, () => this.flushWorkspace(wsId));
        return { wsId, r };
      }));
      for (const { wsId, r } of results) {
        flushed += r.flushed;
        deadLettered += r.deadLettered;
        pendingRemain += r.pendingRemain;
        if (r.transient) transientFailures += 1;
        if (r.flushed > 0 && this.opts.onWorkspaceFlushed) {
          try {
            this.opts.onWorkspaceFlushed(wsId, r.flushed);
          } catch {
            /* best-effort — never break the flush loop */
          }
        }
      }
    } finally {
      this.busy = false;
      // Sample even when a workspace flush threw — a partial tick is still a
      // fresher snapshot than a stale one (review minor fix).
      this.sampleOutboxHealth(workspaceIds);
    }
    return { workspaces: workspaceIds.length, flushed, deadLettered, pendingRemain, transientFailures };
  }

  /**
   * memory211/08 A4-② — refresh the last-sample memory-outbox health AFTER a
   * flush tick (the tick thread owns the I/O; /healthz reads the snapshot and
   * never touches SQLite — same discipline as assetOutbox / postTurnJobs).
   */
  private sampleOutboxHealth(workspaceIds: string[]): void {
    try {
      let pending = 0;
      let deadLetter = 0;
      for (const wsId of workspaceIds) {
        const slot = this.opts.runtime.peek(wsId);
        if (!slot) continue;
        pending += slot.outbox.pendingCount();
        deadLetter += slot.outbox.deadLetterCount();
      }
      lastMemoryOutboxSample = { pending, deadLetter, sampledAt: new Date().toISOString() };
    } catch (err) {
      // A stale sample is worse than no sample: the settings row cannot tell
      // "0 dead letters" from "last sampled 10 minutes ago". Clear it so
      // /healthz omits the key and the UI degrades to 「当前 daemon 版本未上报」
      // (unknown ≠ zero), and leave the reason in the log.
      lastMemoryOutboxSample = null;
      this.log('warn', `outbox health sample failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async withWorkspaceLock<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.workspaceLockTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.workspaceLockTails.set(workspaceId, tail);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.workspaceLockTails.get(workspaceId) === tail) this.workspaceLockTails.delete(workspaceId);
    }
  }

  private async flushWorkspace(
    workspaceId: string,
    opts: { rowIds?: string[]; signal?: AbortSignal } = {},
  ): Promise<{
    flushed: number;
    deadLettered: number;
    pendingRemain: number;
    transient: boolean;
  }> {
    const slot = this.opts.runtime.peek(workspaceId);
    if (!slot) return { flushed: 0, deadLettered: 0, pendingRemain: 0, transient: false };

    const db = slot.store.rawDb();
    const batchSize = this.opts.batchSize ?? 50;

    const rows = opts.rowIds
      ? opts.rowIds.length > 0
        ? db.prepare(
            `SELECT id, eventType, envelopeJson FROM memory_outbox
             WHERE status = 'pending' AND id IN (${opts.rowIds.map(() => '?').join(',')})
             ORDER BY createdAt LIMIT ?`,
          ).all(...opts.rowIds, batchSize) as OutboxRow[]
        : []
      : db.prepare(
          `SELECT id, eventType, envelopeJson FROM memory_outbox
           WHERE status = 'pending' ORDER BY createdAt LIMIT ?`,
        ).all(batchSize) as OutboxRow[];

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

    // memory202 doc 06 (at-rest encryption MVP): encrypt cloud-bound page
    // payloads whose page row is encrypted=true, BEFORE the POST. Mutates the
    // in-memory `events` copy only — the durable outbox row keeps the plaintext
    // envelope, so a re-flush re-encrypts with a fresh IV (fine; cloud dedupes
    // by idempotencyKey). Fail-closed: if a page that SHOULD be encrypted cannot
    // be (no key — e.g. ephemeral storage, or unexpected cipher error), that ONE
    // event is held back (left pending) rather than POSTed as plaintext, so
    // ciphertext-intended content never leaks to the cloud in the clear. Other
    // events in the batch proceed.
    const heldBack = this.encryptOutboundPages(workspaceId, db, events);
    if (heldBack.size > 0) {
      events = events.filter((e) => !(e.eventId && heldBack.has(e.eventId)));
      if (events.length === 0) {
        // Whole batch held back (all required encryption + no key). Leave pending.
        return { flushed: 0, deadLettered: 0, pendingRemain: rows.length, transient: true };
      }
    }

    const res = await this.opts.cloud.request<SyncInboxResponseBody>(
      'POST',
      '/api/im/memory/sync/inbox',
      { body: { events }, timeoutMs: 30_000, ...(opts.signal ? { signal: opts.signal } : {}) },
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
      //   - status >= 400 → route-level auth/config/server rejection. Legal
      //                     agent authorship is handled per-event by Cloud and
      //                     returns HTTP 200 with an ack/error vector; a route
      //                     403 is therefore not the normal agent-actor path.
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
          //   forbidden*         — auth/ACL rejected. Cloud emits SPECIFIC codes:
          //                        forbidden_actor (owner doesn't "own" the writing
          //                        agent — no im_agent_cards row), forbidden_workspace,
          //                        plus bare `forbidden`. ALL start with `forbidden`.
          //                        Prefix-match, NOT exact — the exact-`forbidden`
          //                        check was the silent-loop bug: forbidden_actor
          //                        events matched none of the three, fell through to
          //                        "leave pending", retried every 5s forever with no
          //                        dead-letter and no log (cloud shows writes:0, page
          //                        never materializes, nothing surfaces anywhere).
          const permanent =
            e.retryable === false ||
            e.code === 'PKF_MEMORY_WRITE_CONFLICT' ||
            e.code === 'schema_invalid' ||
            e.code === 'unknown_event_type' ||
            (typeof e.code === 'string' && e.code.startsWith('forbidden'));
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
            process.stderr.write(
              `[memory-outbox] ⚠️ dead-lettered event ${row.id} (${row.eventType}): cloud rejected code=${e.code} — ${(e.message ?? '').slice(0, 200)}\n`,
            );
          } else {
            // Non-permanent per-event rejection: leave pending, retry next tick.
            // MUST log — an unrecognized non-permanent code that never clears is a
            // silent black hole (the exact bug above). Surface it so it can't hide.
            process.stderr.write(
              `[memory-outbox] event ${row.id} (${row.eventType}) left pending — cloud code=${e.code} (not permanent, will retry)\n`,
            );
          }
        }
        // No mention of this eventId at all — server may have silently dropped
        // (shouldn't happen per Line A contract). Leave pending for next tick.
      }
    })();

    return { flushed, deadLettered, pendingRemain: rows.length - flushed - deadLettered, transient: false };
  }

  /**
   * memory202 doc 06: in-place encrypt the `payload.content` of cloud-bound
   * `memory.page.upsert` events whose page row is `encrypted=true`.
   *
   * Source of truth for "is this page encrypted?" is the local `memory_pages`
   * row (which `MemoryStore.write` stamps from the caller's `encrypted` flag) —
   * NOT a trust of the envelope, so an event can't downgrade itself to plaintext
   * by omitting the flag. After encryption the event's `payload.content` becomes
   * the packed ciphertext and `encrypted:true` is set so the cloud stores
   * ciphertext + marks the row encrypted.
   *
   * Returns the set of `eventId`s that MUST be held back (not POSTed): pages
   * that should be encrypted but cannot be (no key — ephemeral storage or a
   * persist failure — or an unexpected cipher error). Holding back is the
   * fail-closed choice: ciphertext-intended content is NEVER POSTed in the
   * clear. A no-op (flag OFF, no keyManager, or no encrypted pages) returns an
   * empty set.
   */
  private encryptOutboundPages(
    workspaceId: string,
    db: import('better-sqlite3').Database,
    events: Array<{ eventId?: string }>,
  ): Set<string> {
    const heldBack = new Set<string>();
    // Flag read dynamically (Nacos async-load convention) — default OFF.
    if (process.env.FF_MEMORY_ENCRYPTION_ENABLED !== 'true') return heldBack;
    const keyManager = this.opts.keyManager;
    if (!keyManager) return heldBack;

    // Lazily resolve which events are encrypted-page upserts (skip the page-row
    // lookup entirely when the batch has none).
    const pageEvents = events.filter(
      (e) => (e as { eventType?: string }).eventType === 'memory.page.upsert',
    ) as Array<{
      eventId?: string;
      pageId?: string;
      payload?: { kind?: string; content?: string };
      encrypted?: boolean;
    }>;
    if (pageEvents.length === 0) return heldBack;

    const encryptedStmt = db.prepare(
      'SELECT encrypted FROM memory_pages WHERE workspaceId = ? AND id = ?',
    );
    let key: Buffer | null | undefined; // undefined = not yet fetched

    for (const ev of pageEvents) {
      // Only the inline-plaintext payload is encryptable; blobRef has no inline
      // content (encryption for blob payloads is out of scope for the MVP).
      if (!ev.pageId || ev.payload?.kind !== 'inline' || typeof ev.payload.content !== 'string') {
        continue;
      }
      const row = encryptedStmt.get(workspaceId, ev.pageId) as { encrypted?: number } | undefined;
      const pageEncrypted = !!row && row.encrypted === 1;
      if (!pageEncrypted) continue; // plaintext page → unchanged

      // Resolve the key once per batch. null ⇒ fail-closed (ephemeral / persist
      // failure): hold this event back, never POST its plaintext.
      // Internal flush-encrypt path — daemon system cap (doc 08 §2.3).
      if (key === undefined) key = keyManager.getKey(workspaceId, systemCap());
      if (!key) {
        if (ev.eventId) heldBack.add(ev.eventId);
        continue;
      }
      try {
        ev.payload.content = gcmEncrypt(ev.payload.content, key);
        ev.encrypted = true;
      } catch (err) {
        // Cipher error on a page that MUST be encrypted → fail closed.
        this.log(
          'error',
          `workspace=${workspaceId} encrypt failed for pageId=${ev.pageId} — holding event back (not POSTing plaintext): ${(err as Error).message}`,
        );
        if (ev.eventId) heldBack.add(ev.eventId);
      }
    }
    return heldBack;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    if (this.opts.log) {
      this.opts.log[level](`[outbox-worker] ${msg}`);
    } else {
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(`[outbox-worker] ${msg}\n`);
    }
  }

  private async readBackPageReceipts(
    workspaceId: string,
    receipts: PageAuthorityReceipt[],
    signal?: AbortSignal,
  ): Promise<PageAuthorityReceipt[]> {
    const canonical: PageAuthorityReceipt[] = [];
    for (const receipt of receipts) {
      const result = await this.opts.cloud.request<{
        ok?: boolean;
        data?: { id?: unknown; path?: unknown; version?: unknown; contentHash?: unknown };
      }>(
        'GET',
        `/api/im/memory/pages/${encodeURIComponent(receipt.pageId)}` +
          `?workspaceId=${encodeURIComponent(workspaceId)}&format=markdown`,
        { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
      );
      if (!result.ok) {
        const retryable = result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
        throw new MemoryAuthorityConfirmationError(
          'memory_authority_readback_failed',
          retryable,
          `Cloud Page readback failed for ${receipt.pageId}: ${result.error?.code ?? result.status}`,
        );
      }
      const page = result.data?.data;
      if (
        !page ||
        page.id !== receipt.pageId ||
        page.path !== receipt.path ||
        typeof page.version !== 'number' ||
        !Number.isSafeInteger(page.version) ||
        page.version < 1
      ) {
        throw new MemoryAuthorityConfirmationError(
          'memory_authority_readback_mismatch',
          false,
          `Cloud Page readback does not match receipt ${receipt.pageId}@${receipt.version}`,
        );
      }
      // Supersede 语义（2026-09-07 jiuyou-dd 实测回归）：同一页被同一 agent 的
      // 后续合法写入推进（hub 创建 → promote → Contents 重建三连写）后，未确认
      // 的旧 receipt 在 readback 时 hash 恒不匹配，且 retryable=false → 整轮
      // 蒸馏被误判 terminal_failure（页面内容实际完好、cloud 为权威）。版本
      // 严格前进 = 后续写入已覆盖本次写入，按已确认处理并记录 cloud 权威现值；
      // 同版本 hash 不同才是真正的数据不一致，维持 mismatch。
      const superseded = page.version > receipt.version;
      // F2 边界：弱确认必须以 cloud 返回完整 contentHash 为前提——缺字段时
      // 无法构造「version 前进 + 权威现值」的自洽快照，回退 mismatch 而不是
      // 拿 receipt 旧 hash 拼一个谎言快照。
      if (
        !superseded && page.contentHash !== receipt.contentHash
      ) {
        throw new MemoryAuthorityConfirmationError(
          'memory_authority_readback_mismatch',
          false,
          `Cloud Page readback does not match receipt ${receipt.pageId}@${receipt.version}`,
        );
      }
      if (superseded && (typeof page.contentHash !== 'string' || page.contentHash.length === 0)) {
        throw new MemoryAuthorityConfirmationError(
          'memory_authority_readback_mismatch',
          true,
          `Superseded page ${receipt.pageId}@${String(page.version)} readback missing contentHash`,
        );
      }
      canonical.push({
        pageId: receipt.pageId,
        path: receipt.path,
        version: page.version,
        // supersede 场景记录页面权威现值（≠ receipt hash）；正常场景两者相等
        contentHash: superseded ? (page.contentHash as string) : receipt.contentHash,
        authority: 'cloud',
        ...(superseded ? { superseded: true } : {}),
        ...(receipt.authorityEventId ? { authorityEventId: receipt.authorityEventId } : {}),
      });
    }
    return canonical;
  }
}

type AuthorityRowMatch = {
  receipt: PageAuthorityReceipt;
  state: 'acked' | 'pending' | 'dead_letter' | 'missing';
  rowId?: string;
  error?: string;
};

function inspectAuthorityRows(
  db: import('better-sqlite3').Database,
  receipts: PageAuthorityReceipt[],
): AuthorityRowMatch[] {
  return receipts.map((receipt) => {
    if (!receipt.authorityEventId) return { receipt, state: 'missing' };
    const live = db.prepare(
      `SELECT id, status, envelopeJson
         FROM memory_outbox
        WHERE id = ? AND eventType = 'memory.page.upsert'
        LIMIT 1`,
    ).get(receipt.authorityEventId) as { id: string; status: string; envelopeJson: string } | undefined;
    const liveMatches = live && envelopeMatchesReceipt(live.envelopeJson, receipt);
    if (liveMatches) {
      return {
        receipt,
        state: live.status === 'acked' ? 'acked' : 'pending',
        rowId: live.id,
      };
    }
    const dead = db.prepare(
      `SELECT id, rawJson, errorJson
         FROM memory_outbox_dead_letter
        WHERE id IN (?, ?) AND eventType = 'memory.page.upsert'
        LIMIT 1`,
    ).get(`dl_${receipt.authorityEventId}`, receipt.authorityEventId) as
      | { id: string; rawJson: string; errorJson: string }
      | undefined;
    if (dead && envelopeMatchesReceipt(dead.rawJson, receipt)) {
      return { receipt, state: 'dead_letter', rowId: dead.id, error: dead.errorJson };
    }
    return { receipt, state: 'missing' };
  });
}

function envelopeMatchesReceipt(json: string, receipt: PageAuthorityReceipt): boolean {
  try {
    const event = JSON.parse(json) as Record<string, unknown>;
    return event.pageId === receipt.pageId &&
      event.path === receipt.path &&
      event.contentHash === receipt.contentHash &&
      event.parentVersion === receipt.version - 1;
  } catch {
    return false;
  }
}

function assertNoInvalidAuthorityRows(rows: AuthorityRowMatch[]): void {
  const dead = rows.find((row) => row.state === 'dead_letter');
  if (dead) {
    throw new MemoryAuthorityConfirmationError(
      'memory_authority_rejected',
      false,
      `Cloud rejected Page receipt ${dead.receipt.pageId}: ${dead.error ?? 'dead letter'}`,
    );
  }
  const missing = rows.find((row) => row.state === 'missing');
  if (missing) {
    throw new MemoryAuthorityConfirmationError(
      'memory_authority_receipt_missing',
      false,
      `No outbox authority event matches Page receipt ${missing.receipt.pageId}`,
    );
  }
}

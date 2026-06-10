// Outbox WRITER. Phase-0 = write-only (no worker consumes the queue).
//
// Per dispatcher decision (方案 A): outbox table + write-side enqueue ship
// in phase-0; the upload worker code itself is NOT written until phase-1
// (C2). Cloud-side `POST /api/im/memory/sync/inbox` (Line A A3) is also a
// phase-1 dependency. Until phase-1 lands, events accumulate locally — daemon
// rebuild + worker startup in phase-1 will replay the queue.
//
// Validation: every enqueue() runs through MemoryOutboxEnvelope (zod). On
// schema fail, the raw event lands in memory_outbox_dead_letter with the
// validation errors. NEVER silently dropped (doc 18 §C4 hard requirement).
//
// Idempotency: every event carries an idempotencyKey computed per-eventType
// (formula in envelope.ts inline comments). Stored as UNIQUE so retries are
// safe — duplicate enqueue returns the existing row id without a second
// insert.

import { randomUUID } from 'node:crypto';
import type { MemoryStore } from './store.js';
import {
  MemoryOutboxEnvelope,
  validateFeedbackTarget,
  type MemoryOutboxEnvelopeT,
} from './envelope.js';

export interface MemoryOutboxOptions {
  store: MemoryStore;
}

export interface EnqueueResult {
  /** Row id (out_* for accepted, dl_* for dead-letter). */
  id: string;
  /** True iff the event landed in memory_outbox_dead_letter due to validation failure. */
  deadLetter: boolean;
}

interface OutboxRow {
  id: string;
}

export class MemoryOutbox {
  constructor(private readonly opts: MemoryOutboxOptions) {}

  /**
   * Validate + persist an outbox event. On schema validation failure or
   * runtime constraint failure (e.g. memory.feedback missing both target
   * fields), the raw event is moved to memory_outbox_dead_letter.
   *
   * Idempotent: if an event with the same idempotencyKey already exists in
   * memory_outbox, the existing row id is returned without a second insert.
   */
  enqueue(event: unknown): EnqueueResult {
    const db = this.opts.store.rawDb();
    const now = Date.now();

    // Schema validation.
    const parsed = MemoryOutboxEnvelope.safeParse(event);
    if (!parsed.success) {
      const dlId = `dl_${randomUUID()}`;
      db.prepare(
        `INSERT INTO memory_outbox_dead_letter (id, eventType, rawJson, errorJson, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        dlId,
        extractEventTypeUnsafe(event),
        JSON.stringify(event ?? null),
        JSON.stringify(parsed.error.errors),
        now,
      );
      return { id: dlId, deadLetter: true };
    }

    const validated: MemoryOutboxEnvelopeT = parsed.data;

    // Runtime constraints not expressible in the discriminated union.
    if (validated.eventType === 'memory.feedback') {
      const check = validateFeedbackTarget(validated);
      if (!check.ok) {
        const dlId = `dl_${randomUUID()}`;
        db.prepare(
          `INSERT INTO memory_outbox_dead_letter (id, eventType, rawJson, errorJson, createdAt)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          dlId,
          validated.eventType,
          JSON.stringify(validated),
          JSON.stringify([{ message: check.reason, path: ['targetEventId'] }]),
          now,
        );
        return { id: dlId, deadLetter: true };
      }
    }

    const rowId = `out_${randomUUID()}`;
    try {
      db.prepare(
        `INSERT INTO memory_outbox (id, eventType, envelopeJson, idempotencyKey, status, createdAt)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).run(
        rowId,
        validated.eventType,
        JSON.stringify(validated),
        validated.idempotencyKey,
        now,
      );
      return { id: rowId, deadLetter: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Idempotency: another enqueue already wrote this key. Return the
        // existing row's id so the caller can correlate.
        const existing = db
          .prepare('SELECT id FROM memory_outbox WHERE idempotencyKey = ?')
          .get(validated.idempotencyKey) as OutboxRow | undefined;
        if (existing) return { id: existing.id, deadLetter: false };
      }
      throw err;
    }
  }

  /**
   * Phase-0 stub: no worker exists, so this just reports the queue depth
   * (`pending` count + 0 `flushed`). Phase-1 (C2) replaces with real
   * upload-and-ack logic against Line A `/api/im/memory/sync/inbox`.
   */
  flush(): { pending: number; flushed: number } {
    return { pending: this.pendingCount(), flushed: 0 };
  }

  pendingCount(): number {
    const db = this.opts.store.rawDb();
    return (
      db.prepare("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n;
  }

  deadLetterCount(): number {
    const db = this.opts.store.rawDb();
    return (
      db.prepare('SELECT COUNT(*) AS n FROM memory_outbox_dead_letter').get() as { n: number }
    ).n;
  }
}

/**
 * Best-effort extraction of `eventType` from an unknown raw event. Used only
 * to populate the dead-letter row's eventType column for triage; never trusted
 * downstream because the rest of the envelope failed validation.
 */
function extractEventTypeUnsafe(event: unknown): string | null {
  if (typeof event === 'object' && event !== null && 'eventType' in event) {
    const t = (event as { eventType: unknown }).eventType;
    if (typeof t === 'string') return t;
  }
  return null;
}

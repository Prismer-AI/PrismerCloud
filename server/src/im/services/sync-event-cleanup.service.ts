/**
 * Sync-event cleanup (daily cron).
 *
 * Deletes `im_sync_events` rows older than RETENTION_DAYS so the SSE
 * backfill source table doesn't grow unbounded. The fan-out path writes
 * a row per (user × event) — message.new / task.phase.* / etc. — and on
 * a busy workspace this is hundreds of rows/min. P2 introduced the
 * backfill API but deferred retention to this cron.
 *
 * Batched (LIMIT 1000 + 200 ms sleep) so the DELETE statement stays
 * under MySQL's default `max_statement_time` and doesn't hold long row
 * locks on a high-write table. Sized for the v2.0 deployment shape
 * (~10 k events/day per active workspace).
 *
 * RETENTION_DAYS = 30 matches the SSE backfill window contract — events
 * older than the backfill cap have no consumer.
 */

import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('SyncEventCleanup');

const RETENTION_DAYS = 30;
const BATCH_SIZE = 1_000;
const BATCH_SLEEP_MS = 200; // small breath between batches

export interface CleanupResult {
  deletedRows: number;
  batches: number;
  durationMs: number;
}

export async function runSyncEventCleanup(): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
  const startedAt = Date.now();
  let totalDeleted = 0;
  let batches = 0;
  // Loop until a batch returns fewer rows than the batch size — that's the
  // signal that no more eligible rows exist.
  for (;;) {
    // `deleteMany` doesn't support LIMIT on Prisma + MySQL, so use raw SQL.
    // ORDER BY id ASC + LIMIT N walks the table in PK order, which is the
    // same order rows were inserted (autoincrement). On a high-write table
    // this keeps each batch's scan window small + predictable.
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM im_sync_events WHERE createdAt < ? ORDER BY id ASC LIMIT ${BATCH_SIZE}`,
      cutoff,
    );
    const deletedCount = typeof deleted === 'number' ? deleted : 0;
    batches += 1;
    totalDeleted += deletedCount;
    if (deletedCount < BATCH_SIZE) break; // last batch
    await sleep(BATCH_SLEEP_MS);
  }
  const durationMs = Date.now() - startedAt;
  log.info(
    {
      deleted: totalDeleted,
      batches,
      durationMs,
      cutoff: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
    },
    'sync-event cleanup complete',
  );
  return { deletedRows: totalDeleted, batches, durationMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

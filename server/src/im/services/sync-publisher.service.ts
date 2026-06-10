/**
 * Prismer IM — Sync Event Publisher (v2.0 §4.1)
 *
 * Background worker that drains `im_sync_events` rows with
 * `publishedAt IS NULL` and fans them out to Redis per-recipient channels.
 *
 * Why this exists
 * ---------------
 * Before v2.0, `SyncService.writeEvent` did `INSERT row → Redis publish`
 * inline. Redis publish failure = silent event loss. The publisher worker
 * decouples the two — the row is persisted first inside the caller's
 * transaction; publish becomes a retriable side-effect with bounded retry.
 *
 * Scheduling decision (HU-1, Wave 1-A3 audit)
 * -------------------------------------------
 * Independent setInterval(50ms) rather than piggybacking on
 * `SchedulerService.tick` (10s) / `sweepTimeouts` (30s). Reasons:
 *   1. 50ms target latency is ~200x tighter than the slowest existing
 *      scheduler cron (30s). Re-using the scheduler tick would force every
 *      tick to be sub-50ms — incompatible with its current sweep workloads
 *      (handleTimeouts, scanCreditReturns, dream sweep, leaderboard).
 *   2. Failure isolation. A publisher hang (Redis timeout) must NOT block
 *      handleTimeouts from running. Separate interval keeps the blast
 *      radius scoped.
 *   3. Easy to disable / tune in tests via `start({ intervalMs })`.
 *
 * Lifecycle is still owned by SchedulerService (start/stop) so there's one
 * door to "start the cron stuff" — see scheduler.service.ts.
 *
 * Ordering
 * --------
 * We drain by row `id` ASC (global insertion order). Subscribers gap-detect
 * by `boundarySeq` (per-conversation), so publisher-side reordering of
 * different conversations is fine. Within a conversation, boundarySeq is
 * monotonic at allocation time — and since allocation happens inside the
 * tx that inserts the row, row-id order is consistent with boundarySeq
 * order for a single conversation.
 */

import type { SyncService } from './sync.service';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('SyncPublisher');

const DEFAULT_TICK_INTERVAL_MS = 50;
const DEFAULT_BATCH_SIZE = 100;
const MAX_PUBLISH_RETRIES = 10;

export interface SyncPublisherConfig {
  intervalMs?: number;
  batchSize?: number;
}

export class SyncPublisherService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false; // re-entrancy guard

  constructor(
    private readonly syncService: SyncService,
    private readonly config: SyncPublisherConfig = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.config.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = setInterval(() => {
      // Skip if a previous tick is still running (Redis hang etc.) — we
      // don't want overlapping passes touching the same rows.
      if (this.ticking) return;
      this.tick().catch((err) => log.error({ err }, 'tick error'));
    }, interval);
    log.info({ intervalMs: interval }, 'started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Single tick. Exposed for test harnesses; not for app code.
   */
  async tick(): Promise<{ published: number; failed: number }> {
    this.ticking = true;
    let published = 0;
    let failed = 0;
    try {
      // No Redis? Nothing to do (this also covers the standalone IM dev
      // setup where Redis may transiently fail to connect).
      if (!this.syncService.getRedis()) {
        return { published: 0, failed: 0 };
      }

      const pending = await prisma.iMSyncEvent.findMany({
        where: {
          publishedAt: null,
          publishRetries: { lt: MAX_PUBLISH_RETRIES },
        },
        orderBy: { id: 'asc' },
        take: this.config.batchSize ?? DEFAULT_BATCH_SIZE,
      });

      for (const evt of pending) {
        try {
          await this.syncService.publishPending({
            id: evt.id,
            type: evt.type,
            data: evt.data,
            conversationId: evt.conversationId,
            boundarySeq: evt.boundarySeq,
            imUserId: evt.imUserId,
            createdAt: evt.createdAt,
          });
          await prisma.iMSyncEvent.update({
            where: { id: evt.id },
            data: { publishedAt: new Date() },
          });
          published++;
        } catch (err) {
          failed++;
          await prisma.iMSyncEvent
            .update({
              where: { id: evt.id },
              data: { publishRetries: { increment: 1 } },
            })
            .catch((updateErr: unknown) => {
              // If even the retry counter update fails, log and move on —
              // we'll re-try this row on the next tick anyway.
              log.warn({ err: (updateErr as Error).message, id: evt.id }, 'retry counter update failed');
            });
          log.warn({ err: (err as Error).message, id: evt.id, retries: evt.publishRetries }, 'publish failed');
        }
      }
      if (published > 0 || failed > 0) {
        log.debug({ published, failed, batchSize: pending.length }, 'tick complete');
      }
      return { published, failed };
    } finally {
      this.ticking = false;
    }
  }
}

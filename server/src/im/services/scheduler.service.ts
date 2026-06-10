/**
 * Prismer IM — Scheduler Service
 *
 * Cloud-side persistent task scheduler. Runs as part of the IM server process.
 * Periodically scans for due tasks and dispatches them to agents.
 *
 * This replaces OpenClaw's local cron with a cloud-persistent alternative:
 * - Agent process dies → tasks survive in im_tasks
 * - Multiple pods → FOR UPDATE SKIP LOCKED prevents duplicate dispatch
 * - Retry with exponential backoff → aligns with OpenClaw retry semantics
 *
 * Design reference: docs/AGENT-ORCHESTRATION.md (Layer 3: Cloud Scheduler)
 */

import type { TaskService } from './task.service';
import type { EvolutionService } from './evolution.service';
import { shouldDream, runDream } from './memory-dream';
import { KnowledgeLinkService } from './knowledge-link.service';
import { ContactService } from './contact.service';
import { sweepArphanedDispatchReplies } from './dispatch-reply.service';
import { WSAckPersistentService, PERSISTENT_ACK_TTL_MS } from './ws-ack-persistent.service';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('Scheduler');

/** Default tick interval: 10 seconds */
const DEFAULT_TICK_INTERVAL_MS = 10_000;

/** Timeout sweep interval: 30 seconds */
const TIMEOUT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Phase-level stuck sweep interval: 15 seconds.
 *
 * Co-existence with TIMEOUT_SWEEP_INTERVAL_MS (per docs/release200/14 §4.2
 * 协同矩阵 + §12.4):
 *   - {@link sweepTimeouts} operates on `task.timeoutMs` (default 5min) and
 *     is the final authority for `running → pending|failed` retry/fail.
 *   - {@link sweepStuckPhases} operates on `lastHeartbeatAt` (45s) and only
 *     writes the `currentPhase='stuck'` signal — never touches `status`.
 * The two reapers act on disjoint columns and cannot race.
 *
 * 15s tick × 45s heartbeat threshold = up to ~60s detection latency, which
 * is well below the 5-minute hard-timeout floor and matches the UX target
 * of "user sees ‘stuck’ warning before the task is forcibly retried".
 */
const STUCK_PHASE_SWEEP_INTERVAL_MS = 15_000;

/**
 * Never-dispatched reaper interval: 5 minutes.
 *
 * Catches `status='assigned' AND lastHeartbeatAt IS NULL AND lastRunAt IS
 * NULL AND createdAt < now - 30min` rows — the gap between sweepStuckPhases
 * (skips never-heartbeated) and findTimedOutTasks (only scans
 * `status='running'`). Without this, tasks assigned to an offline daemon
 * pile up indefinitely at `status='assigned'` and clutter the UI typing
 * indicators on every page hydration.
 */
const NEVER_DISPATCHED_REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Credit return scan interval: 5 minutes */
const CREDIT_RETURN_INTERVAL_MS = 300_000;

/** Pending report processing interval: 5 minutes */
const REPORT_PROCESS_INTERVAL_MS = 300_000;

/** Signal clustering interval: 1 hour */
const CLUSTER_INTERVAL_MS = 3_600_000;

/** Memory dream interval: 6 hours */
const DREAM_INTERVAL_MS = 6 * 3_600_000;

/** Knowledge link prune interval: 24 hours */
const PRUNE_INTERVAL_MS = 24 * 3_600_000;

/** Leaderboard computation check interval: 10 minutes */
const LEADERBOARD_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Community karma settlement interval: 1 hour */
const KARMA_SETTLEMENT_INTERVAL_MS = 3_600_000;

/** Friend request expiry sweep interval: 6 hours */
const FRIEND_EXPIRE_INTERVAL_MS = 6 * 3_600_000;

/**
 * Dispatch reply orphan reaper interval: 5 minutes.
 *
 * Per docs/release200/14 §4.3 + Wave 3.5 W3 — replies still 'prepared' after
 * >1h (`PREPARED_REPLY_ORPHAN_MS` in dispatch-reply.service) are flipped to
 * 'aborted' so the daemon's retry window doesn't grow unbounded. 5min sweep
 * + 60min cutoff = at most ~65min before aborted, well above the daemon's
 * worst-case crash-recover window (~30s typical) but below any "user is
 * still waiting for the reply" UX threshold.
 */
const DISPATCH_REPLY_REAP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Message-partial reaper interval: 1 hour.
 *
 * §4.4.7 streaming partial render: `im_message_partials` rows accumulate
 * one per ~200ms flush during an active stream. Each row is keyed to a
 * `messageId` and lives 24h then is reaped — the final message itself is
 * persisted on `im_messages` via the Wave 2-B1 outbox path, so partials
 * are a transient F5-hydration buffer, not a source of truth.
 *
 * 1h sweep × 24h retention = at most ~25h before a stale chunk is freed.
 * Sibling to sweepDispatchReplyOrphans / sweepStuckPhases — touches a
 * disjoint table.
 */
const MESSAGE_PARTIALS_REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Persistent WS ack cleanup interval: 1 hour. Wave-4 E3 (§4.5) — drops
 * acked rows + abandoned-pending rows older than PERSISTENT_ACK_TTL_MS (24h)
 * so im_ws_acks doesn't grow without bound. Sibling to the in-memory
 * AckTracker cleanup (30s).
 */
const WS_ACK_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sync-event cleanup interval: 24 hours. Cleanup-1 — drop im_sync_events
 * rows older than 30d (matches P2 SSE backfill cap) so the fan-out source
 * table doesn't grow unbounded on high-throughput conversations. Sibling
 * to cleanupWSAcks — touches a disjoint table, batched internally.
 */
const SYNC_EVENT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SchedulerConfig {
  tickIntervalMs?: number;
  enabled?: boolean;
}

export class SchedulerService {
  private taskService: TaskService;
  private evolutionService?: EvolutionService;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setInterval> | null = null;
  private stuckPhaseTimer: ReturnType<typeof setInterval> | null = null;
  private creditReturnTimer: ReturnType<typeof setInterval> | null = null;
  private reportProcessTimer: ReturnType<typeof setInterval> | null = null;
  private clusterTimer: ReturnType<typeof setInterval> | null = null;
  private dreamTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private leaderboardTimer: ReturnType<typeof setInterval> | null = null;
  private karmaTimer: ReturnType<typeof setInterval> | null = null;
  private friendExpireTimer: ReturnType<typeof setInterval> | null = null;
  private dispatchReplyReapTimer: ReturnType<typeof setInterval> | null = null;
  private neverDispatchedReapTimer: ReturnType<typeof setInterval> | null = null;
  private messagePartialsReapTimer: ReturnType<typeof setInterval> | null = null;
  private wsAckCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private syncEventCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private wsAckPersistent = new WSAckPersistentService();
  private running = false;
  private tickIntervalMs: number;

  constructor(taskService: TaskService, config?: SchedulerConfig, evolutionService?: EvolutionService) {
    this.taskService = taskService;
    this.evolutionService = evolutionService;
    this.tickIntervalMs = config?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /**
   * Start the scheduler. Begins periodic scanning for due tasks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Main tick: dispatch due scheduled tasks
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);

    // Timeout sweep: handle timed-out running tasks
    this.timeoutTimer = setInterval(() => this.sweepTimeouts(), TIMEOUT_SWEEP_INTERVAL_MS);

    // Phase stuck sweep: flag tasks whose daemon has gone silent for >45s
    // (v2.0 §4.2). Sibling to sweepTimeouts — writes `currentPhase='stuck'`
    // only, never touches `status`.
    this.stuckPhaseTimer = setInterval(() => this.sweepStuckPhases(), STUCK_PHASE_SWEEP_INTERVAL_MS);

    // Credit return scan: check for milestone-based credit rewards
    this.creditReturnTimer = setInterval(() => this.scanCreditReturns(), CREDIT_RETURN_INTERVAL_MS);

    // Pending report processing: pick up reports that were lost (pod restart, queue overflow)
    this.reportProcessTimer = setInterval(() => this.processPendingReports(), REPORT_PROCESS_INTERVAL_MS);

    // Signal clustering: group co-occurring signals for better gene matching
    this.clusterTimer = setInterval(() => this.computeClusters(), CLUSTER_INTERVAL_MS);

    // Memory dream: consolidate agent memories periodically
    this.dreamTimer = setInterval(() => this.runDreamSweep(), DREAM_INTERVAL_MS);

    // Knowledge link pruning: remove weak links
    this.pruneTimer = setInterval(() => this.pruneWeakLinks(), PRUNE_INTERVAL_MS);

    // Daily leaderboard V2 computation (check every 10 minutes, run at UTC 00:05)
    this.leaderboardTimer = setInterval(() => this.computeLeaderboard(), LEADERBOARD_CHECK_INTERVAL_MS);

    // Community karma settlement: settle deferred karma entries every hour
    this.karmaTimer = setInterval(() => this.settleCommunityKarma(), KARMA_SETTLEMENT_INTERVAL_MS);

    // Friend request expiry: expire pending requests older than 30 days
    this.friendExpireTimer = setInterval(() => this.expireFriendRequests(), FRIEND_EXPIRE_INTERVAL_MS);

    // Dispatch reply orphan reaper (Wave 3.5 §4.3): flip stale 'prepared'
    // im_dispatch_replies rows to 'aborted' after >1h. Sibling to
    // sweepStuckPhases — runs every 5min, independent of task lifecycle.
    this.dispatchReplyReapTimer = setInterval(
      () => this.sweepDispatchReplyOrphans(),
      DISPATCH_REPLY_REAP_INTERVAL_MS,
    );

    // Never-dispatched reaper (2026-05-23): fail `status='assigned'` rows
    // where the daemon never acked dispatch (lastHeartbeatAt=null,
    // lastRunAt=null) and createdAt > 30min ago. Plugs the gap between
    // sweepStuckPhases (skips never-heartbeated) and sweepTimeouts (only
    // scans status='running').
    this.neverDispatchedReapTimer = setInterval(
      () => this.sweepNeverDispatched(),
      NEVER_DISPATCHED_REAP_INTERVAL_MS,
    );

    // Message-partial reaper (Wave 4 E2 §4.4.7): drop `im_message_partials`
    // rows older than 24h. Stream chunks are an F5-hydration buffer; the
    // canonical final message lives on `im_messages`. Sibling to
    // sweepDispatchReplyOrphans — 1h sweep, touches a disjoint table.
    this.messagePartialsReapTimer = setInterval(
      () => this.sweepMessagePartials(),
      MESSAGE_PARTIALS_REAP_INTERVAL_MS,
    );

    // Wave-4 E3 (§4.5) — drop acked + abandoned-pending im_ws_acks rows
    // older than the TTL (24h). Sibling to in-memory AckTracker cleanup.
    this.wsAckCleanupTimer = setInterval(() => this.cleanupWSAcks(), WS_ACK_CLEANUP_INTERVAL_MS);

    // Cleanup-1 — drop im_sync_events rows older than 30d. Runs at startup
    // (so a long-stopped pod catches up quickly) then every 24h afterwards.
    void this.cleanupSyncEvents();
    this.syncEventCleanupTimer = setInterval(
      () => this.cleanupSyncEvents(),
      SYNC_EVENT_CLEANUP_INTERVAL_MS,
    );

    log.info(`Started (tick=${this.tickIntervalMs}ms)`);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.stuckPhaseTimer) {
      clearInterval(this.stuckPhaseTimer);
      this.stuckPhaseTimer = null;
    }
    if (this.creditReturnTimer) {
      clearInterval(this.creditReturnTimer);
      this.creditReturnTimer = null;
    }
    if (this.reportProcessTimer) {
      clearInterval(this.reportProcessTimer);
      this.reportProcessTimer = null;
    }
    if (this.clusterTimer) {
      clearInterval(this.clusterTimer);
      this.clusterTimer = null;
    }
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.leaderboardTimer) {
      clearInterval(this.leaderboardTimer);
      this.leaderboardTimer = null;
    }
    if (this.karmaTimer) {
      clearInterval(this.karmaTimer);
      this.karmaTimer = null;
    }
    if (this.friendExpireTimer) {
      clearInterval(this.friendExpireTimer);
      this.friendExpireTimer = null;
    }
    if (this.dispatchReplyReapTimer) {
      clearInterval(this.dispatchReplyReapTimer);
      this.dispatchReplyReapTimer = null;
    }
    if (this.neverDispatchedReapTimer) {
      clearInterval(this.neverDispatchedReapTimer);
      this.neverDispatchedReapTimer = null;
    }
    if (this.messagePartialsReapTimer) {
      clearInterval(this.messagePartialsReapTimer);
      this.messagePartialsReapTimer = null;
    }
    if (this.wsAckCleanupTimer) {
      clearInterval(this.wsAckCleanupTimer);
      this.wsAckCleanupTimer = null;
    }
    if (this.syncEventCleanupTimer) {
      clearInterval(this.syncEventCleanupTimer);
      this.syncEventCleanupTimer = null;
    }

    log.info('Stopped');
  }

  /**
   * Single tick: find and dispatch due tasks.
   */
  private async tick(): Promise<void> {
    try {
      const dispatched = await this.taskService.dispatchDueTasks();
      if (dispatched > 0) {
        log.info(`Tick: dispatched ${dispatched} task(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Tick error');
    }
  }

  /**
   * Sweep timed-out tasks.
   */
  private async sweepTimeouts(): Promise<void> {
    try {
      const handled = await this.taskService.handleTimeouts();
      if (handled > 0) {
        log.info(`Timeout sweep: handled ${handled} task(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Timeout sweep error');
    }
  }

  /**
   * Sweep tasks whose daemon has gone silent (>45s without heartbeat) and
   * flag `currentPhase='stuck'` for UI surfacing. Sibling to
   * {@link sweepTimeouts} — only touches the `currentPhase` column, never
   * the `status` column. See `docs/release200/14` §4.2 + §12.4.
   */
  private async sweepStuckPhases(): Promise<void> {
    try {
      const marked = await this.taskService.sweepStuckPhases();
      if (marked > 0) {
        log.info(`Stuck phase sweep: marked ${marked} task(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Stuck phase sweep error');
    }
  }

  /**
   * Fail tasks stuck at `status='assigned'` because the daemon never
   * acknowledged dispatch. See TaskService::failNeverDispatchedTasks for
   * the rationale — this plugs the gap left by sweepStuckPhases (which
   * skips never-heartbeated rows) + sweepTimeouts (which only scans
   * `status='running'`).
   */
  private async sweepNeverDispatched(): Promise<void> {
    try {
      const failed = await this.taskService.failNeverDispatchedTasks();
      if (failed > 0) {
        log.info(`Never-dispatched sweep: failed ${failed} task(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Never-dispatched sweep error');
    }
  }

  /**
   * Scan for credit return milestones on published genes.
   */
  private async scanCreditReturns(): Promise<void> {
    if (!this.evolutionService) return;
    try {
      const rewarded = await this.evolutionService.scanCreditReturns();
      if (rewarded > 0) {
        log.info(`Credit return scan: granted ${rewarded} reward(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Credit return scan error');
    }
  }

  /**
   * Process pending evolution reports (LLM signal extraction backfill).
   */
  private async processPendingReports(): Promise<void> {
    if (!this.evolutionService) return;
    try {
      const processed = await this.evolutionService.processPendingReports();
      if (processed > 0) {
        log.info(`Pending reports: processed ${processed}`);
      }
    } catch (err) {
      log.error({ err }, 'Pending report processing error');
    }
  }

  /**
   * Compute signal clusters from co-occurrence patterns.
   */
  private async computeClusters(): Promise<void> {
    if (!this.evolutionService) return;
    try {
      const computed = await this.evolutionService.computeSignalClusters();
      if (computed > 0) {
        log.info(`Signal clustering: ${computed} clusters`);
      }
    } catch (err) {
      log.error({ err }, 'Clustering error');
    }
  }

  /**
   * Sweep agents for memory dream consolidation.
   */
  private async runDreamSweep(): Promise<void> {
    try {
      // Find agents with enough memory files (per workspace+owner pair —
      // shouldDream now requires both since memory is workspace-scoped after
      // the workspace-resolver landing).
      const candidates = await (
        await import('../db')
      ).default.iMMemoryFile.groupBy({
        by: ['ownerId', 'workspaceId'],
        _count: true,
        having: { ownerId: { _count: { gte: 3 } } },
      });

      let dreamCount = 0;
      for (const c of candidates.slice(0, 50)) {
        const { ready } = await shouldDream(c.ownerId, c.workspaceId);
        if (ready) {
          const result = await runDream(c.ownerId, c.workspaceId);
          if (result.triggered) dreamCount++;
        }
      }
      if (dreamCount > 0) {
        log.info(`Dream sweep: ${dreamCount} agent(s) consolidated`);
      }
    } catch (err) {
      log.error({ err }, 'Dream sweep error');
    }
  }

  /**
   * Prune weak knowledge links (strength < 0.1).
   */
  private async pruneWeakLinks(): Promise<void> {
    try {
      const kls = new KnowledgeLinkService();
      const count = await kls.pruneWeakLinks();
      if (count > 0) {
        log.info(`Pruned ${count} weak knowledge links`);
      }
    } catch (err) {
      log.error({ err }, 'Prune weak links error');
    }
  }

  /**
   * Settle deferred community karma entries.
   */
  private async settleCommunityKarma(): Promise<void> {
    try {
      const { CommunityKarmaService } = await import('./community-karma.service');
      const prisma = (await import('../db')).default;
      const karmaService = new CommunityKarmaService(prisma as any);
      const settled = await karmaService.settlePendingKarma();
      if (settled > 0) {
        log.info(`Community karma: settled ${settled} deferred entries`);
      }
    } catch (err) {
      log.error({ err }, 'Community karma settlement error');
    }
  }

  private leaderboardRanDate = '';

  /**
   * Daily leaderboard V2 computation.
   * Normal schedule: UTC 00:05-00:15.
   * Catch-up: if the process starts after the window, run once on first check.
   */
  private async computeLeaderboard(): Promise<void> {
    const now = new Date();
    const today = new Date().toISOString().slice(0, 10);
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    const inWindow = hour === 0 && minute >= 5 && minute < 15;
    if (hour > 0 || minute >= 15) {
      // Past today's window — check if we need a catch-up run
      if (this.leaderboardRanDate !== today) {
        const needsCatchUp = await this.needsLeaderboardCatchUp(now);
        if (needsCatchUp) {
          log.info('Leaderboard catch-up: no snapshot found for today, running now...');
          await this.runLeaderboardPipeline();
        }
        this.leaderboardRanDate = today;
      }
      return;
    }

    if (inWindow && this.leaderboardRanDate !== today) {
      await this.runLeaderboardPipeline();
      this.leaderboardRanDate = today;
    }
  }

  private async runLeaderboardPipeline(): Promise<void> {
    log.info('Starting daily leaderboard computation...');
    const { computeTokenBaselines, computeValueMetrics } = await import('./value-metrics.service');
    const { computeLeaderboardSnapshot } = await import('./leaderboard.service');

    // Step 1: Token baselines (best-effort, snapshot computation does not depend on this)
    try {
      await computeTokenBaselines();
    } catch (e) {
      log.error({ err: e }, 'Token baselines failed (non-blocking)');
    }

    // Step 2: Value metrics (best-effort, enriches snapshots but not required)
    for (const period of ['weekly', 'monthly', 'alltime'] as const) {
      try {
        await computeValueMetrics(period);
      } catch (e) {
        log.error({ err: e }, `Value metrics (${period}) failed (non-blocking)`);
      }
    }

    // Step 3: Leaderboard snapshots (core — must run independently of steps 1-2)
    for (const period of ['weekly', 'monthly', 'alltime'] as const) {
      try {
        await computeLeaderboardSnapshot(period);
      } catch (e) {
        log.error({ err: e }, `Leaderboard snapshot (${period}) failed`);
      }
    }

    log.info('Daily leaderboard computation complete');
  }

  private async needsLeaderboardCatchUp(now: Date): Promise<boolean> {
    try {
      const prisma = (await import('../db')).default;
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const count = await prisma.iMLeaderboardSnapshot.count({
        where: { snapshotDate: { gte: todayStart } },
      });
      return count === 0;
    } catch {
      return false;
    }
  }

  private async expireFriendRequests(): Promise<void> {
    try {
      const cs = new ContactService();
      await cs.expirePendingRequests(30);
    } catch (e) {
      log.error({ err: e }, 'Friend request expiry sweep failed');
    }
  }

  /**
   * Wave 3.5 §4.3 — dispatch reply orphan reaper.
   * Flips im_dispatch_replies rows still 'prepared' after >1h to 'aborted'
   * and writes an IMTaskLog action='dispatch-reply-aborted' for audit.
   * Sibling to {@link sweepStuckPhases} — touches only IMDispatchReply rows.
   */
  private async sweepDispatchReplyOrphans(): Promise<void> {
    try {
      const reaped = await sweepArphanedDispatchReplies();
      if (reaped > 0) {
        log.info(`Dispatch reply reap: aborted ${reaped} orphaned prepared row(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Dispatch reply reap error');
    }
  }

  /**
   * §4.4.7 message-partial reaper.
   *
   * Drops `im_message_partials` rows older than 24h. The partial buffer is
   * an F5-hydration cache for in-flight streaming messages — the canonical
   * final message lands on `im_messages` via the Wave 2-B1 outbox path
   * (with `boundarySeq`). After 24h the user has either reloaded long ago
   * or moved on; the chunks add no value.
   */
  private async sweepMessagePartials(): Promise<void> {
    try {
      // Lazy import keeps the ts circular pull off scheduler ↔ stream-service.
      const { StreamService } = await import('./stream.service');
      const deleted = await StreamService.reapStalePartials();
      if (deleted > 0) {
        log.info(`Message partials reap: deleted ${deleted} stale chunk row(s)`);
      }
    } catch (err) {
      log.error({ err }, 'Message partials reap error');
    }
  }

  /**
   * Wave-4 E3 (§4.5) — drop im_ws_acks rows older than 24h. Covers both
   * acked (history that's no longer useful) and abandoned-pending (the
   * client is never coming back). Independent of the in-memory AckTracker
   * cleanup (30s tick, 5min TTL) — DB rows have a longer horizon so
   * cross-restart replay still works.
   */
  private async cleanupWSAcks(): Promise<void> {
    try {
      const deleted = await this.wsAckPersistent.cleanupExpired(PERSISTENT_ACK_TTL_MS);
      if (deleted > 0) {
        log.info(`WS ack persistent cleanup: deleted ${deleted} row(s)`);
      }
    } catch (err) {
      log.error({ err }, 'WS ack persistent cleanup error');
    }
  }

  /**
   * Cleanup-1 — drop im_sync_events rows older than RETENTION_DAYS (30d).
   * Internally batched (1000 rows × 200ms sleep) so the DELETE doesn't
   * hold long row locks on the high-write fan-out table.
   */
  private async cleanupSyncEvents(): Promise<void> {
    try {
      const { runSyncEventCleanup } = await import('./sync-event-cleanup.service');
      const result = await runSyncEventCleanup();
      if (result.deletedRows > 0) {
        log.info(
          `Sync-event cleanup: deleted ${result.deletedRows} row(s) in ${result.batches} batch(es), ${result.durationMs}ms`,
        );
      }
    } catch (err) {
      log.error({ err }, 'Sync-event cleanup error');
    }
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

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
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('Scheduler');

/** Default tick interval: 10 seconds */
const DEFAULT_TICK_INTERVAL_MS = 10_000;

/** Timeout sweep interval: 30 seconds */
const TIMEOUT_SWEEP_INTERVAL_MS = 30_000;

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

export interface SchedulerConfig {
  tickIntervalMs?: number;
  enabled?: boolean;
}

export class SchedulerService {
  private taskService: TaskService;
  private evolutionService?: EvolutionService;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setInterval> | null = null;
  private creditReturnTimer: ReturnType<typeof setInterval> | null = null;
  private reportProcessTimer: ReturnType<typeof setInterval> | null = null;
  private clusterTimer: ReturnType<typeof setInterval> | null = null;
  private dreamTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private leaderboardTimer: ReturnType<typeof setInterval> | null = null;
  private karmaTimer: ReturnType<typeof setInterval> | null = null;
  private friendExpireTimer: ReturnType<typeof setInterval> | null = null;
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
      // Find agents with enough memory files
      const candidates = await (
        await import('../db')
      ).default.iMMemoryFile.groupBy({
        by: ['ownerId'],
        _count: true,
        having: { ownerId: { _count: { gte: 3 } } },
      });

      let dreamCount = 0;
      for (const c of candidates.slice(0, 50)) {
        const { ready } = await shouldDream(c.ownerId);
        if (ready) {
          const result = await runDream(c.ownerId);
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
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

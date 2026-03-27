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

const LOG = '[Scheduler]';

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

    console.log(`${LOG} Started (tick=${this.tickIntervalMs}ms)`);
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

    console.log(`${LOG} Stopped`);
  }

  /**
   * Single tick: find and dispatch due tasks.
   */
  private async tick(): Promise<void> {
    try {
      const dispatched = await this.taskService.dispatchDueTasks();
      if (dispatched > 0) {
        console.log(`${LOG} Tick: dispatched ${dispatched} task(s)`);
      }
    } catch (err) {
      console.error(`${LOG} Tick error:`, err);
    }
  }

  /**
   * Sweep timed-out tasks.
   */
  private async sweepTimeouts(): Promise<void> {
    try {
      const handled = await this.taskService.handleTimeouts();
      if (handled > 0) {
        console.log(`${LOG} Timeout sweep: handled ${handled} task(s)`);
      }
    } catch (err) {
      console.error(`${LOG} Timeout sweep error:`, err);
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
        console.log(`${LOG} Credit return scan: granted ${rewarded} reward(s)`);
      }
    } catch (err) {
      console.error(`${LOG} Credit return scan error:`, err);
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
        console.log(`${LOG} Pending reports: processed ${processed}`);
      }
    } catch (err) {
      console.error(`${LOG} Pending report processing error:`, err);
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
        console.log(`${LOG} Signal clustering: ${computed} clusters`);
      }
    } catch (err) {
      console.error(`${LOG} Clustering error:`, err);
    }
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

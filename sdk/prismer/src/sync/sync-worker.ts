// Background push worker. Scaffold — full HTTP flush lands m3 once
// runtime/src/auth.ts + cloud HTTP client wrapper exist.
// See docs/refactor/04-daemon-runtime.md §Sync worker and 13-error-handling §2.7.

import { EventEmitter } from 'node:events';
import { type SyncQueue, type SyncQueueRow } from './sync-queue.js';

export interface FlushResult {
  ok: boolean;
  /** HTTP status when applicable. 409 → markConflict; 400-499 (other) → markFailedOther; else markBackoff. */
  status?: number;
  message?: string;
}

/** Caller injects the actual cloud HTTP push (m3). Scaffold uses a noop that returns ok:true. */
export type FlushFn = (row: SyncQueueRow) => Promise<FlushResult>;

export interface SyncWorkerOptions {
  queue: SyncQueue;
  flush: FlushFn;
  /** Tick interval in ms. Defaults to 5000. */
  tickMs?: number;
  /** Max rows per tick. Defaults to 10. */
  batchSize?: number;
}

/**
 * Events:
 *  - `tick` ({ pending, processed })   each completed tick
 *  - `flushed` (row, result)           one row push outcome
 *  - `error` (err, row?)               unexpected error in flush()
 */
export class SyncWorker extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private opts: SyncWorkerOptions) {
    super();
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? 5_000;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.emit('error', err));
    }, tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Drain up to `batchSize` ready rows. Public for test injection.
   * Re-entrant guarded — concurrent ticks return immediately.
   */
  async tick(): Promise<{ processed: number }> {
    if (this.running) return { processed: 0 };
    this.running = true;
    let processed = 0;
    try {
      const rows = this.opts.queue.dequeueBatch(this.opts.batchSize ?? 10);
      for (const row of rows) {
        try {
          const result = await this.opts.flush(row);
          this.handleResult(row, result);
          this.emit('flushed', row, result);
        } catch (err) {
          this.opts.queue.markBackoff(row.id, row.attempt_count);
          this.emit('error', err, row);
        }
        processed += 1;
      }
      this.emit('tick', { pending: this.opts.queue.pendingCount(), processed });
    } finally {
      this.running = false;
    }
    return { processed };
  }

  private handleResult(row: SyncQueueRow, result: FlushResult): void {
    if (result.ok) {
      this.opts.queue.markCompleted(row.id);
      return;
    }
    const status = result.status ?? 0;
    if (status === 409) {
      this.opts.queue.markConflict(row.id);
    } else if (status >= 400 && status < 500) {
      this.opts.queue.markFailedOther(row.id);
    } else {
      this.opts.queue.markBackoff(row.id, row.attempt_count);
    }
  }
}

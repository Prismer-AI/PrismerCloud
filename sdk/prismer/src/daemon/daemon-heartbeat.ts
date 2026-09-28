// DaemonHeartbeat — daemon-side 15s heartbeat file writer for the sandbox-manager.
//
// The sandbox-manager (Rust) reads ~/.prismer/daemon-heartbeat to monitor
// daemon liveness. This module is the daemon-side WRITER.
//
// File format (JSON, one line):
//   {"timestamp":<epoch_secs>,"configVersion":"<version>","pid":<pid>}
//
// Design: docs/product209/09-resident-sandbox-manager.md §3.3
//
// The heartbeat rhythm reuses the same 15s interval as task-heartbeat.ts.
// This is a DAEMON-level heartbeat (one per process), not a per-task heartbeat.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

export interface DaemonHeartbeatOptions {
  /** Heartbeat file path. Defaults to ~/.prismer/daemon-heartbeat */
  filePath?: string;
  /** Interval between writes in ms. Defaults to 15_000 (matches task-heartbeat). */
  intervalMs?: number;
  /** Config version getter — reads current bootstrapState configVersion. */
  getConfigVersion?: () => string;
  /** Override wall-clock for tests. Defaults to Math.floor(Date.now() / 1000). */
  now?: () => number;
}

export class DaemonHeartbeat {
  private timer?: NodeJS.Timeout;
  private readonly filePath: string;
  private readonly intervalMs: number;
  private readonly getConfigVersion: () => string;
  private readonly now: () => number;

  constructor(opts: DaemonHeartbeatOptions = {}) {
    this.filePath = opts.filePath ?? path.join(homedir(), '.prismer', 'daemon-heartbeat');
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.getConfigVersion = opts.getConfigVersion ?? (() => '');
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Start the heartbeat writer. The first write happens immediately,
   * then every `intervalMs` thereafter.
   */
  start(): void {
    if (this.timer) return;
    // Ensure parent directory exists
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Write immediately
    this.write();
    // Then periodically
    this.timer = setInterval(() => {
      this.write();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for heartbeats
    this.timer.unref?.();
  }

  /**
   * Stop the heartbeat writer. Idempotent.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Force an immediate heartbeat write (useful for tests).
   */
  forceWrite(): void {
    this.write();
  }

  private write(): void {
    const payload = {
      timestamp: this.now(),
      configVersion: this.getConfigVersion(),
      pid: process.pid,
    };
    try {
      // Atomic write: write to temp file then rename
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf-8' });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Best-effort: don't crash the daemon on heartbeat write failure
      // (e.g. disk full, permission change)
      console.error(
        `[DaemonHeartbeat] write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

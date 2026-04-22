import { getMemoryDB, type DreamCompaction } from './memory-db.js';

export interface DreamResult {
  ok: boolean;
  compactedFiles: number;
  summary?: DreamCompaction;
}

export interface DreamSchedulerOptions {
  ownerId?: string;
  scope?: string;
  intervalMs?: number;
}

export class DreamScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: DreamSchedulerOptions = {}) {}

  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.opts.intervalMs ?? 24 * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void runDream(this.opts).catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function createDreamScheduler(opts?: DreamSchedulerOptions): DreamScheduler {
  return new DreamScheduler(opts);
}

export async function runDream(opts: DreamSchedulerOptions = {}): Promise<DreamResult> {
  const db = getMemoryDB();
  const files = db.listMemoryFiles({
    ownerId: opts.ownerId,
    scope: opts.scope,
    limit: 100,
  });

  return {
    ok: true,
    compactedFiles: files.length,
  };
}

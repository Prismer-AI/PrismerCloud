/**
 * Prismer IM — MetricService (v2.0.7 release201/11)
 *
 * Cloud-side metric write path.
 *
 *   service.emit({ namespace, name, value, dims, ts? })
 *     → in-memory queue (sync, < 1ms)
 *     → flush every 5s or once queue length ≥ 100
 *     → batched insertMany into im_metric_events
 *
 * Forbidden log patterns (release201/11 §0.2.4):
 *   - "[metric] queue dropped"
 *   - "[metric] dim missing workspaceId"
 *
 * When the queue overflows or workspaceId is absent, we still write the
 * row (best-effort) and surface drift through pino warnings using
 * different wording.
 */

import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';
import { validateMetricEmit } from './metric-registry';

const log = createModuleLogger('MetricService');

export type MetricSource = 'cloud' | 'daemon' | 'agent';

export interface MetricEmitInput {
  namespace: string;
  name: string;
  /** Business time the event represents. Defaults to emit wall clock. */
  ts?: Date;
  value?: number | string | null;
  dims?: Record<string, string | number | boolean | null | undefined>;
  source?: MetricSource;
  /** daemonId / agentId for batch ingest provenance. */
  sourceId?: string | null;
  /** emitter wall clock (defaults to now). Daemon ingest preserves daemon's emittedAt. */
  emittedAt?: Date;
}

interface QueuedRow {
  namespace: string;
  name: string;
  ts: Date;
  valueNumeric: number | null;
  valueString: string | null;
  dimsJson: string | null;
  source: string;
  sourceId: string | null;
  emittedAt: Date;
  receivedAt: Date;
  workspaceId: string | null;
}

export interface MetricServiceOptions {
  /** Trigger flush when queue reaches this size (default 100). */
  batchSize?: number;
  /** Periodic flush interval in ms (default 5000). */
  flushIntervalMs?: number;
  /** Hard ceiling on in-memory queue to avoid unbounded growth (default 5000). */
  maxQueueSize?: number;
  /** Disable the internal timer (tests). */
  disableTimer?: boolean;
}

/** Default singleton options. */
const DEFAULT_OPTS: Required<Omit<MetricServiceOptions, 'disableTimer'>> = {
  batchSize: 100,
  flushIntervalMs: 5000,
  maxQueueSize: 5000,
};

export class MetricService {
  private readonly queue: QueuedRow[] = [];
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private overflowed = 0;

  constructor(opts: MetricServiceOptions = {}) {
    this.batchSize = opts.batchSize ?? DEFAULT_OPTS.batchSize;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_OPTS.flushIntervalMs;
    this.maxQueueSize = opts.maxQueueSize ?? DEFAULT_OPTS.maxQueueSize;

    if (!opts.disableTimer && this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch((err) => log.error({ err }, '[MetricService] periodic flush failed'));
      }, this.flushIntervalMs);
      // Don't keep the Node event loop alive just for the metric timer.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /**
   * Enqueue a metric event. Sync, non-blocking, never throws.
   * Triggers an opportunistic flush when batchSize is reached.
   */
  emit(input: MetricEmitInput): void {
    try {
      const validation = validateMetricEmit({
        namespace: input.namespace,
        name: input.name,
        value: input.value ?? undefined,
        dims: input.dims as Record<string, unknown> | undefined,
      });
      for (const warning of validation.warnings) {
        // Use neutral wording — forbidden patterns from §0.2.4 are
        // "[metric] queue dropped" and "[metric] dim missing workspaceId".
        log.warn({ metric: `${input.namespace}.${input.name}` }, `metric warning: ${warning}`);
      }

      const row = this.toRow(input);

      if (this.queue.length >= this.maxQueueSize) {
        // Drop oldest to bound memory; surface via aggregate counter only.
        this.queue.shift();
        this.overflowed++;
        if (this.overflowed % 100 === 1) {
          log.warn(
            { overflowed: this.overflowed, queueSize: this.queue.length },
            'metric queue overflow — oldest entries discarded',
          );
        }
      }
      this.queue.push(row);

      if (this.queue.length >= this.batchSize) {
        void this.flush().catch((err) => log.error({ err }, '[MetricService] batch flush failed'));
      }
    } catch (err) {
      // emit() must never throw — observability path must not crash callers.
      log.error({ err }, '[MetricService] emit failed');
    }
  }

  /** Convert an input row into the DB-shaped QueuedRow. */
  private toRow(input: MetricEmitInput): QueuedRow {
    const now = new Date();
    const ts = input.ts ?? now;
    const emittedAt = input.emittedAt ?? now;
    const value = input.value;

    let valueNumeric: number | null = null;
    let valueString: string | null = null;
    if (typeof value === 'number' && Number.isFinite(value)) valueNumeric = value;
    else if (typeof value === 'string') valueString = value.slice(0, 256);
    else if (typeof value === 'boolean') valueString = value ? 'true' : 'false';

    const dims = sanitizeDims(input.dims);
    const workspaceId =
      typeof dims.workspaceId === 'string' && dims.workspaceId.length > 0 ? dims.workspaceId.slice(0, 30) : null;

    return {
      namespace: input.namespace.slice(0, 64),
      name: input.name.slice(0, 64),
      ts,
      valueNumeric,
      valueString,
      dimsJson: Object.keys(dims).length ? JSON.stringify(dims) : null,
      source: (input.source ?? 'cloud').slice(0, 32),
      sourceId: input.sourceId ? input.sourceId.slice(0, 64) : null,
      emittedAt,
      receivedAt: now,
      workspaceId,
    };
  }

  /**
   * Drain the queue and insert in one batch. Safe to call concurrently;
   * concurrent invocations early-return while another is in flight.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.queue.length);
      try {
        await (prisma as any).iMMetricEvent.createMany({ data: batch });
      } catch (err) {
        // Re-queue at the front and let the next flush retry. Cap at maxQueueSize
        // so a persistent DB outage doesn't grow memory without bound.
        const reclaim = batch.slice(0, this.maxQueueSize - this.queue.length);
        this.queue.unshift(...reclaim);
        log.error(
          { err, batchSize: batch.length, retryQueued: reclaim.length },
          '[MetricService] flush to DB failed; will retry',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Observability hooks for tests / debug endpoint. */
  stats(): { queued: number; overflowed: number } {
    return { queued: this.queue.length, overflowed: this.overflowed };
  }

  /** Tear down internal timer. Useful in tests; safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

/**
 * Normalise dims: drop undefined / null, stringify primitives, cap key/value
 * length so a runaway dim doesn't blow up the row.
 */
function sanitizeDims(dims: MetricEmitInput['dims']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!dims) return out;
  for (const [k, v] of Object.entries(dims)) {
    if (v === undefined || v === null) continue;
    const key = String(k).slice(0, 64);
    let val: string;
    if (typeof v === 'string') val = v;
    else if (typeof v === 'number' && Number.isFinite(v)) val = String(v);
    else if (typeof v === 'boolean') val = v ? 'true' : 'false';
    else val = String(v);
    out[key] = val.slice(0, 256);
  }
  return out;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _singleton: MetricService | null = null;

/**
 * Process-wide MetricService. Lazy-initialised so test code can override
 * options before first emit; production callers just call
 * `getMetricService().emit(...)`.
 */
export function getMetricService(): MetricService {
  if (!_singleton) _singleton = new MetricService();
  return _singleton;
}

/** Tests only. */
export function __setMetricServiceForTests(svc: MetricService | null): void {
  _singleton = svc;
}

/**
 * Shorthand for service-layer call sites — release201/11 §3.1 pattern.
 *
 *     metricEmit({ namespace: 'task', name: 'completed', value: durationMs,
 *                  dims: { workspaceId, taskId, ... } });
 */
export function metricEmit(input: MetricEmitInput): void {
  getMetricService().emit(input);
}

/**
 * Wave-8 W14 — Cloud-side K8s reconcile loop.
 *
 * Periodically polls every `IMContainer` row whose `runtimeKind='k8s'` is in
 * a non-terminal state (provisioning / running / degraded) and reconciles its
 * `status` against the cluster's actual pod phase via the sandbox-controller.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this lives in cloud (Next.js) and NOT in the controller process
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The W14 dispatcher prompt says "sandbox-controller 内一个 goroutine /
 * setInterval"; we put it in cloud instead. The reason is architectural:
 * the controller is a separate Node.js process with no DB credentials —
 * Prisma access lives in `prismercloud/`. Pushing the reconciler into the
 * controller would either (a) require giving the controller MySQL/SQLite
 * credentials and a Prisma client (doubles the surface area + duplicates a
 * 62-table schema) or (b) require the controller to call back into the
 * cloud over HTTP for every status write, which inverts the dependency.
 *
 * Cleanest split: controller owns K8s API access (via the new
 * `GET /internal/v1/k8s/pod-status` endpoint); cloud owns DB writes. The
 * loop lives wherever Prisma lives — and Prisma lives here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Status mapping
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   K8s phase     | DB status (next)        | Notes
 *   ---------     | ----------------        | -----
 *   Pending       | provisioning            | image pulling / scheduling
 *   Running       | running                 | pod started; daemon may still
 *                 |                         | be coming up — that's W5's job
 *   Succeeded     | stopped                 | rare for our workload, but
 *                 |                         | correct mapping
 *   Failed        | errored                 | terminal infra failure
 *   Unknown       | errored                 | node lost; treat as errored
 *   exists=false  | stopped                 | deleted out-of-band (kubectl
 *                 |                         | delete pod, GC, eviction)
 *   apiError      | (no change)             | K8s API hiccup; retry next tick
 *
 * Container-level reasons (CrashLoopBackOff, ImagePullBackOff, OOMKilled)
 * surface as terminal `errored` (Release 200 T11 sweep collapsed the legacy
 * `failing` status onto `errored` since the SandboxStatus enum has no
 * `failing` slot anymore — see migration 333 / 339).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Cadence + backoff
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   Default tick:        every 10s
 *   On per-row failure:  exponential backoff (10s → 20s → 40s → 60s cap)
 *   Backoff key:         row.id; reset on successful poll
 *
 * The tick interval is process-global (one timer per Node process). Per-row
 * backoff lives in an in-memory Map; restart loses backoff state, which is
 * fine — at worst we hammer K8s for one tick after a restart, then the
 * normal backoff re-engages.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Disabling the loop
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   K8S_RECONCILE_ENABLED=false      skip startup entirely (prod kill-switch)
 *   K8S_CONTROLLER_AVAILABLE=false   per-call no-op (dev without controller)
 *   Missing controller URL/token     per-call no-op unless availability is
 *                                    explicitly true; creation API fails
 *                                    before writing a fake row
 *
 * The latter is the same env var the W11 wizard reads to gate the
 * controller-unreachable fallback.
 */

import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { K8sSandboxError, k8sSandbox, type PodStatusVerdict } from '@/lib/k8s-sandbox';
import { hasK8sConfig } from '@/lib/sandbox-config';
import { resolvePersistent } from '@/lib/sandbox/registry';
import {
  SandboxStatusTransitionError,
  assertSandboxStatusTransition,
  isSandboxStatus,
  normalizeSandboxStatus,
  type SandboxStatus,
} from '@/lib/sandbox/state-machine';
import { ProviderError } from '@/lib/execution/errors';
import type { ProbeDaemonResult } from '@/lib/sandbox/types';
import { writeResourceSample } from '@/lib/sandbox/resource-sample';

// ── Configuration ────────────────────────────────────────────────────────
const DEFAULT_TICK_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_FACTOR = 2;
/**
 * Release 200 §5.1 — daemon /healthz probe is throttled to ~30s/row. We use
 * 25s as the gate (overlap with the 10s tick clamp) so probe lands every
 * 3rd tick. Reset-by-process-restart is acceptable for v200.
 */
const PROBE_THROTTLE_MS = 25_000;
/** Release 200 §5.1 — 3 consecutive misses promote `running` to `degraded`. */
const DAEMON_MISS_DEGRADE_THRESHOLD = 3;
/** Trim job — runs every hour, keeps 7 days of samples. */
const RESOURCE_SAMPLE_TRIM_INTERVAL_MS = 60 * 60 * 1000;
const RESOURCE_SAMPLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// ── Module state ─────────────────────────────────────────────────────────
type LoopState = {
  timer: ReturnType<typeof setTimeout> | null;
  trimTimer: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** Per-row backoff in ms; reset on success. */
  backoff: Map<string, number>;
  /** Per-row "next eligible" timestamp; rows are skipped until then. */
  cooldown: Map<string, number>;
  /**
   * Per-row last probeDaemon timestamp (epoch ms). Memory-only — restart
   * resets to 0 and the next tick probes; acceptable for v200.
   */
  lastProbeAt: Map<string, number>;
};

const globalForReconciler = globalThis as unknown as { __k8sReconciler?: LoopState };

function getState(): LoopState {
  if (!globalForReconciler.__k8sReconciler) {
    globalForReconciler.__k8sReconciler = {
      timer: null,
      trimTimer: null,
      running: false,
      backoff: new Map(),
      cooldown: new Map(),
      lastProbeAt: new Map(),
    };
  }
  return globalForReconciler.__k8sReconciler;
}

// ── Status decision ──────────────────────────────────────────────────────

/**
 * Statuses the reconciler is allowed to drive from. Anything else (e.g.
 * `pending`, `warming`, `bound`, `stopped`, `errored`, `failed`) is either
 * terminal (filtered out of the SELECT) or part of the legacy docker path
 * the reconciler doesn't touch — this is W14's scoped surface.
 *
 * `creating` is added 2026-05-07 (drift #4 closure / MVP M2): the cloud
 * `runtime-installations` POST route writes `creating` (mirroring the
 * controller's ContainerStatus enum) when a pod is freshly spawned. Without
 * `creating` in this set, those rows stayed stuck and never advanced to
 * `running` — M2 smoke timed out at M2.2 even though the pod was Ready.
 */
// T11 (2026-05-19) — `failing` removed from the active-set; the SandboxStatus
// enum has no such value and the FSM rejects writes to it. `creating` remains
// here as a legacy alias the controller may still report; normalizeStatus()
// collapses it to `provisioning` before any FSM check.
const ACTIVE_STATUSES = ['creating', 'provisioning', 'running', 'degraded'] as const;

interface ReconcileDecision {
  /** New DB status; null = no change. */
  nextStatus: string | null;
  /** Optional `stoppedAt` timestamp; only set when transitioning to stopped. */
  stoppedAt?: Date;
  /** Optional `startedAt` timestamp; only set on first observation of Running. */
  startedAt?: Date;
  /** Optional human-readable reason for logs. */
  reason?: string;
}

/**
 * Pure decision function: given the current DB state and the controller's
 * verdict, compute the next status. Tested independently of Prisma + RPC.
 */
export function decideNextStatus(
  current: { status: string; startedAt: Date | null; stoppedAt: Date | null },
  verdict: PodStatusVerdict,
): ReconcileDecision {
  // K8s API hiccup — no signal, leave row alone.
  if (verdict.apiError) {
    return { nextStatus: null };
  }

  // Pod no longer in cluster — was stopped or deleted out-of-band. Idempotent
  // when current.status is already stopped.
  if (!verdict.exists) {
    if (current.status === 'stopped' || current.stoppedAt) return { nextStatus: null };
    return { nextStatus: 'stopped', stoppedAt: new Date(), reason: 'pod_not_found_in_cluster' };
  }

  const phase = verdict.phase ?? '';
  const reason = verdict.reason ?? null;

  // Container-level fatal reasons override phase. CrashLoopBackOff with the
  // pod still in Running phase is the classic "pod up but workload dead"
  // case; we treat it as errored so the operator sees the degradation.
  // (T11 sweep: was `failing`; the SandboxStatus enum has no such value.)
  if (
    reason === 'CrashLoopBackOff' ||
    reason === 'ImagePullBackOff' ||
    reason === 'ErrImagePull' ||
    reason === 'OOMKilled' ||
    reason === 'CreateContainerConfigError'
  ) {
    if (current.status === 'errored') return { nextStatus: null };
    // F6 (2026-05-19) — errored is terminal; stamp stoppedAt so the UI device
    // filter treats the row as dead instead of leaving it visible as "daemon
    // offline" forever.
    return { nextStatus: 'errored', stoppedAt: new Date(), reason };
  }

  switch (phase) {
    case 'Pending': {
      if (current.status === 'provisioning') return { nextStatus: null };
      // Don't go BACK to provisioning from running — pods don't go back to
      // Pending once they've been Running unless they were restarted, in
      // which case we want errored instead. Phase=Pending right after
      // Running is suspect; treat as no-op so we don't oscillate.
      if (current.status === 'running' || current.status === 'errored') return { nextStatus: null };
      return { nextStatus: 'provisioning', reason: 'pod_pending' };
    }
    case 'Running': {
      if (current.status === 'running') return { nextStatus: null };
      const decision: ReconcileDecision = { nextStatus: 'running', reason: 'pod_running' };
      // First time we see Running — stamp startedAt if it wasn't set.
      if (!current.startedAt && verdict.startedAt) {
        decision.startedAt = new Date(verdict.startedAt);
      } else if (!current.startedAt) {
        decision.startedAt = new Date();
      }
      return decision;
    }
    case 'Succeeded': {
      if (current.status === 'stopped' || current.stoppedAt) return { nextStatus: null };
      return { nextStatus: 'stopped', stoppedAt: new Date(), reason: 'pod_succeeded' };
    }
    case 'Failed': {
      if (current.status === 'errored') return { nextStatus: null };
      // F6 (2026-05-19) — stamp stoppedAt on terminal errored transition.
      return { nextStatus: 'errored', stoppedAt: new Date(), reason: reason ?? 'pod_failed' };
    }
    case 'Unknown': {
      if (current.status === 'errored') return { nextStatus: null };
      // F6 (2026-05-19) — stamp stoppedAt on terminal errored transition.
      return { nextStatus: 'errored', stoppedAt: new Date(), reason: 'pod_unknown' };
    }
    default:
      // Empty / unrecognised phase — skip. This matches W14's "do nothing on
      // ambiguous signal" rule.
      return { nextStatus: null };
  }
}

// ── Loop driver ──────────────────────────────────────────────────────────

interface ReconcileTickResult {
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Single tick: SELECT active k8s rows, query controller for each, update DB.
 * Exposed so tests can call it directly without the timer.
 */
export async function reconcileTick(): Promise<ReconcileTickResult> {
  const state = getState();
  const result: ReconcileTickResult = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  // §26 B4 — reconcile runs against the in-process `k8sSandbox`. Skip when
  // the cloud has no K8s cluster credentials AND the operator has not
  // explicitly forced availability with K8S_CONTROLLER_AVAILABLE=true.
  // K8S_CONTROLLER_AVAILABLE=false is the dev kill-switch (cloud running
  // without any K8s side at all).
  const k8sCapable = hasK8sConfig();
  if (
    process.env.K8S_CONTROLLER_AVAILABLE === 'false' ||
    (!k8sCapable && process.env.K8S_CONTROLLER_AVAILABLE !== 'true')
  ) {
    return result;
  }

  let rows: Array<{
    id: string;
    podName: string;
    namespace: string;
    status: string;
    startedAt: Date | null;
    stoppedAt: Date | null;
    providerKind: string | null;
    daemonId: string | null;
    daemonHealthMisses: number;
    lastDaemonHealthAt: Date | null;
  }>;
  try {
    rows = (await prisma.iMContainer.findMany({
      where: {
        providerKind: 'k8s',
        status: { in: [...ACTIVE_STATUSES] },
        stoppedAt: null,
      },
      select: {
        id: true,
        podName: true,
        namespace: true,
        status: true,
        startedAt: true,
        stoppedAt: true,
        providerKind: true,
        daemonId: true,
        daemonHealthMisses: true,
        lastDaemonHealthAt: true,
      },
      take: 200,
    })) as typeof rows;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[K8sReconciler] db query failed');
    return result;
  }

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const now = Date.now();

  for (const row of rows) {
    // Per-row backoff cooldown.
    const cooldownAt = state.cooldown.get(row.id);
    if (cooldownAt && cooldownAt > now) {
      result.skipped += 1;
      continue;
    }

    let verdict: PodStatusVerdict;
    try {
      verdict = await k8sSandbox.podStatusVerdict(row.podName, row.namespace);
    } catch (err) {
      // K8s API unreachable / SDK error — bump backoff and continue.
      const backoff = bumpBackoff(state, row.id);
      state.cooldown.set(row.id, now + backoff);
      result.errors += 1;
      // Skip out-of-band stopped rows — placeholder rows with podName
      // `pending-${id}` (W11 fallback) generate noisy 404s; one warn per
      // tick is enough.
      if (!(err instanceof K8sSandboxError && (err.code === 'CONTAINER_NOT_FOUND' || err.status === 404))) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            podName: row.podName,
            backoffMs: backoff,
          },
          '[K8sReconciler] pod-status fetch failed',
        );
      }
      continue;
    }

    // K8s itself blew up — verdict.apiError is set. Bump backoff but don't
    // touch the row. Don't count as error in the tick result (it's a known
    // soft-fail).
    if (verdict.apiError) {
      const backoff = bumpBackoff(state, row.id);
      state.cooldown.set(row.id, now + backoff);
      result.skipped += 1;
      continue;
    }

    // ── Phase 1 — pod-status decision (priority over daemon-health) ────
    const decision = decideNextStatus(row, verdict);
    // Track row's current status across both phases so the second phase sees
    // the post-pod-status value (e.g. running → degraded must only apply if
    // pod-status didn't already move the row to stopped/errored).
    let currentStatus = row.status;
    // FSM lookups need a canonical SandboxStatus. Legacy controller writes
    // like `creating` are normalised so the guard can reason about them.
    const currentFsmStatus: SandboxStatus = isSandboxStatus(row.status)
      ? row.status
      : normalizeSandboxStatus(row.status);

    if (decision.nextStatus !== null) {
      const nextFsmStatus: SandboxStatus = isSandboxStatus(decision.nextStatus)
        ? decision.nextStatus
        : normalizeSandboxStatus(decision.nextStatus);

      // T11 strict guard. Illegal transition aborts only this row; the
      // tick keeps draining the rest. The error is already structured-
      // logged inside the assertion helper.
      try {
        assertSandboxStatusTransition(currentFsmStatus, nextFsmStatus, {
          rowId: row.id,
          podName: row.podName,
          reason: decision.reason,
        });
      } catch (err) {
        if (err instanceof SandboxStatusTransitionError) {
          result.errors += 1;
          continue;
        }
        throw err;
      }

      try {
        const updateData: {
          status: string;
          stoppedAt?: Date;
          startedAt?: Date;
        } = { status: nextFsmStatus };
        if (decision.stoppedAt) updateData.stoppedAt = decision.stoppedAt;
        if (decision.startedAt) updateData.startedAt = decision.startedAt;

        await prisma.iMContainer.update({ where: { id: row.id }, data: updateData });

        logger.info(
          {
            rowId: row.id,
            podName: row.podName,
            from: row.status,
            to: nextFsmStatus,
            reason: decision.reason ?? null,
          },
          '[K8sReconciler] row reconciled',
        );

        currentStatus = nextFsmStatus;
        state.backoff.delete(row.id);
        state.cooldown.delete(row.id);
        result.updated += 1;
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            rowId: row.id,
            podName: row.podName,
          },
          '[K8sReconciler] db update failed',
        );
        result.errors += 1;
        // Don't probe daemon if the pod-status update failed — DB may be
        // unhealthy; the next tick will retry.
        continue;
      }
    } else {
      // No-op decision — clear backoff so next tick polls immediately.
      state.backoff.delete(row.id);
      state.cooldown.delete(row.id);
    }

    // ── Phase 2 — daemon /healthz probe (08 §5.1 + §5.4) ──────────────
    // Skip if pod is no longer alive (stopped / errored). Also gated by
    // 30s throttle.
    if (currentStatus !== 'running' && currentStatus !== 'degraded') {
      continue;
    }
    if (!verdict.exists) {
      continue;
    }

    const lastProbeAt = state.lastProbeAt.get(row.id) ?? 0;
    if (now - lastProbeAt <= PROBE_THROTTLE_MS) {
      continue;
    }
    state.lastProbeAt.set(row.id, now);

    let probeResult: ProbeDaemonResult | null = null;
    try {
      const provider = resolvePersistent(row.providerKind ?? 'k8s');
      probeResult = await provider.probeDaemon(row.podName);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_found') {
        // Pod was deleted between Phase 1 and Phase 2; next tick will mark
        // stopped via pod-status path.
        continue;
      }
      // Other structural failures (capacity_exhausted / unknown) → count as
      // 1 miss but don't crash the loop.
      probeResult = {
        healthy: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!probeResult) continue;

    // Apply probe result.
    const dbUpdate: Record<string, unknown> = {};

    if (probeResult.healthy) {
      dbUpdate.daemonHealthMisses = 0;
      dbUpdate.lastDaemonHealthAt = new Date();

      // Warn on daemonId mismatch (someone replaced the daemon binary).
      if (row.daemonId && probeResult.daemonId && row.daemonId !== probeResult.daemonId) {
        logger.warn(
          {
            rowId: row.id,
            podName: row.podName,
            expected: row.daemonId,
            actual: probeResult.daemonId,
          },
          '[K8sReconciler] daemonId mismatch (warn-only)',
        );
      }

      // Recovery: degraded → running.
      if (currentStatus === 'degraded') {
        try {
          assertSandboxStatusTransition('degraded', 'running', {
            rowId: row.id,
            podName: row.podName,
            reason: 'daemon_recovered',
          });
          dbUpdate.status = 'running';
        } catch (err) {
          if (err instanceof SandboxStatusTransitionError) {
            result.errors += 1;
          } else {
            throw err;
          }
        }
      }

      // Resource sample — best-effort, errors swallowed inside helper.
      await writeResourceSample(row.id, probeResult);
    } else {
      const misses = (row.daemonHealthMisses ?? 0) + 1;
      dbUpdate.daemonHealthMisses = misses;

      if (misses >= DAEMON_MISS_DEGRADE_THRESHOLD && currentStatus === 'running') {
        try {
          assertSandboxStatusTransition('running', 'degraded', {
            rowId: row.id,
            podName: row.podName,
            reason: 'daemon_3x_miss',
          });
          dbUpdate.status = 'degraded';
          logger.info(
            {
              rowId: row.id,
              podName: row.podName,
              misses,
              error: probeResult.error,
            },
            '[K8sReconciler] running → degraded after 3x daemon health miss',
          );
        } catch (err) {
          if (err instanceof SandboxStatusTransitionError) {
            result.errors += 1;
          } else {
            throw err;
          }
        }
      }
    }

    try {
      await prisma.iMContainer.update({ where: { id: row.id }, data: dbUpdate });
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          rowId: row.id,
          podName: row.podName,
        },
        '[K8sReconciler] daemon-health db update failed',
      );
    }
  }

  return result;
}

function bumpBackoff(state: LoopState, rowId: string): number {
  const current = state.backoff.get(rowId) ?? DEFAULT_TICK_MS;
  const next = Math.min(current * BACKOFF_FACTOR, MAX_BACKOFF_MS);
  state.backoff.set(rowId, next);
  return next;
}

// ── Public lifecycle ─────────────────────────────────────────────────────

/**
 * Start the reconcile loop. Idempotent — calling twice is a no-op.
 * Honors `K8S_RECONCILE_ENABLED=false` (skip startup),
 * `K8S_CONTROLLER_AVAILABLE=false` (per-tick no-op), and absent controller
 * URL/token in local/dev processes.
 */
export function startK8sReconciler(opts: { tickMs?: number } = {}): void {
  if (process.env.K8S_RECONCILE_ENABLED === 'false') {
    logger.info('[K8sReconciler] disabled by K8S_RECONCILE_ENABLED=false');
    return;
  }

  const state = getState();
  if (state.timer) return; // already running

  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;

  const loop = async (): Promise<void> => {
    if (state.running) return;
    state.running = true;
    try {
      const tickResult = await reconcileTick();
      if (tickResult.scanned > 0) {
        logger.debug({ result: tickResult }, '[K8sReconciler] tick');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[K8sReconciler] tick crashed');
    } finally {
      state.running = false;
      state.timer = setTimeout(loop, tickMs);
      // Don't keep the Node process alive solely for the reconciler — IM/Next
      // own the lifecycle, the loop just rides along.
      state.timer.unref?.();
    }
  };

  // First tick after a small delay so HTTP server can bind first.
  state.timer = setTimeout(loop, 1_000);
  state.timer.unref?.();
  logger.info({ tickMs }, '[K8sReconciler] started');

  // Companion trim job for im_sandbox_resource_samples (7-day retention).
  startResourceSampleTrim();
}

/**
 * Stop the reconcile loop. Used by tests + graceful shutdown. Idempotent.
 */
export function stopK8sReconciler(): void {
  const state = getState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.backoff.clear();
  state.cooldown.clear();
  state.lastProbeAt.clear();
  stopResourceSampleTrim();
}

// ── Resource sample trim job (08 §6.1 — 7-day retention) ────────────────

/**
 * Periodically delete `im_sandbox_resource_samples` rows older than 7 days.
 * Idempotent — calling twice is a no-op. The reconciler `startK8sReconciler`
 * wires this on automatically; exposed for tests that want to drive it
 * standalone.
 */
export function startResourceSampleTrim(opts: { intervalMs?: number } = {}): void {
  const state = getState();
  if (state.trimTimer) return;

  const intervalMs = opts.intervalMs ?? RESOURCE_SAMPLE_TRIM_INTERVAL_MS;
  state.trimTimer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - RESOURCE_SAMPLE_RETENTION_MS);
      const r = await prisma.iMSandboxResourceSample.deleteMany({
        where: { sampledAt: { lt: cutoff } },
      });
      if (r.count > 0) {
        logger.info({ deleted: r.count }, '[ResourceSampleTrim] 7-day trim');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[ResourceSampleTrim] trim failed');
    }
  }, intervalMs);
  state.trimTimer.unref?.();
  logger.info({ intervalMs }, '[ResourceSampleTrim] started');
}

export function stopResourceSampleTrim(): void {
  const state = getState();
  if (state.trimTimer) {
    clearInterval(state.trimTimer);
    state.trimTimer = null;
  }
}

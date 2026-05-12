/**
 * Wave-8 W14 — Cloud-side K8s reconcile loop.
 *
 * Periodically polls every `IMContainer` row whose `runtimeKind='k8s'` is in
 * a non-terminal state (provisioning / running / failing) and reconciles its
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
 *   Failed        | failing                 | terminal infra failure
 *   Unknown       | failing                 | node lost; treat as failing
 *   exists=false  | stopped                 | deleted out-of-band (kubectl
 *                 |                         | delete pod, GC, eviction)
 *   apiError      | (no change)             | K8s API hiccup; retry next tick
 *
 * Container-level reasons (CrashLoopBackOff, ImagePullBackOff, OOMKilled)
 * are persisted into `gatewayUrl` slot — no, wait, that's not right; we
 * have no metadata column on IMContainer. We surface them in a structured
 * way via the next-status decision: ImagePullBackOff / CrashLoopBackOff →
 * `failing`. The reason string itself is logged for operators.
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

// ── Configuration ────────────────────────────────────────────────────────
const DEFAULT_TICK_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_FACTOR = 2;

// ── Module state ─────────────────────────────────────────────────────────
type LoopState = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** Per-row backoff in ms; reset on success. */
  backoff: Map<string, number>;
  /** Per-row "next eligible" timestamp; rows are skipped until then. */
  cooldown: Map<string, number>;
};

const globalForReconciler = globalThis as unknown as { __k8sReconciler?: LoopState };

function getState(): LoopState {
  if (!globalForReconciler.__k8sReconciler) {
    globalForReconciler.__k8sReconciler = {
      timer: null,
      running: false,
      backoff: new Map(),
      cooldown: new Map(),
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
const ACTIVE_STATUSES = ['creating', 'provisioning', 'running', 'failing'] as const;

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
  // case; we treat it as failing so the operator sees the degradation.
  if (
    reason === 'CrashLoopBackOff' ||
    reason === 'ImagePullBackOff' ||
    reason === 'ErrImagePull' ||
    reason === 'OOMKilled' ||
    reason === 'CreateContainerConfigError'
  ) {
    if (current.status === 'failing') return { nextStatus: null };
    return { nextStatus: 'failing', reason };
  }

  switch (phase) {
    case 'Pending': {
      if (current.status === 'provisioning') return { nextStatus: null };
      // Don't go BACK to provisioning from running — pods don't go back to
      // Pending once they've been Running unless they were restarted, in
      // which case we want failing instead. Phase=Pending right after
      // Running is suspect; treat as no-op so we don't oscillate.
      if (current.status === 'running' || current.status === 'failing') return { nextStatus: null };
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
      if (current.status === 'failing') return { nextStatus: null };
      return { nextStatus: 'failing', reason: reason ?? 'pod_failed' };
    }
    case 'Unknown': {
      if (current.status === 'failing') return { nextStatus: null };
      return { nextStatus: 'failing', reason: 'pod_unknown' };
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
  }>;
  try {
    rows = (await prisma.iMContainer.findMany({
      where: {
        runtimeKind: 'k8s',
        status: { in: [...ACTIVE_STATUSES] },
        stoppedAt: null,
      },
      select: { id: true, podName: true, namespace: true, status: true, startedAt: true, stoppedAt: true },
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

    const decision = decideNextStatus(row, verdict);
    if (decision.nextStatus === null) {
      // No-op decision — clear backoff so next tick polls immediately.
      state.backoff.delete(row.id);
      state.cooldown.delete(row.id);
      continue;
    }

    try {
      const updateData: {
        status: string;
        stoppedAt?: Date;
        startedAt?: Date;
      } = { status: decision.nextStatus };
      if (decision.stoppedAt) updateData.stoppedAt = decision.stoppedAt;
      if (decision.startedAt) updateData.startedAt = decision.startedAt;

      await prisma.iMContainer.update({ where: { id: row.id }, data: updateData });

      logger.info(
        {
          rowId: row.id,
          podName: row.podName,
          from: row.status,
          to: decision.nextStatus,
          reason: decision.reason ?? null,
        },
        '[K8sReconciler] row reconciled',
      );

      // Successful poll — clear any backoff.
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
}

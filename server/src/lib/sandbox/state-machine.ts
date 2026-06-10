import { logger } from '@/lib/logger';

export const SANDBOX_STATUSES = [
  'pending',
  'provisioning',
  'running',
  'degraded',
  'stopping',
  'stopped',
  'errored',
] as const;

export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

const STATUS_SET = new Set<string>(SANDBOX_STATUSES);

/**
 * Historical aliases — anything that has ever appeared in the wild. v200 T11
 * sweep collapsed `failing` → `errored`; legacy rows are mapped here so
 * reads tolerate them even after the schema enum forbids new writes.
 */
const ALIASES: Record<string, SandboxStatus> = {
  created: 'pending',
  requested: 'pending',
  bound: 'pending',
  creating: 'provisioning',
  active: 'running',
  failing: 'errored',
  completed: 'stopped',
  deleted: 'stopped',
  removed: 'stopped',
  error: 'errored',
  failed: 'errored',
  timeout: 'errored',
};

/**
 * Release 200 §6.2 — canonical seven-state FSM transition matrix.
 *
 * T11 (2026-05-19) tightening + 2026-05-19 reconciler-external-delete patch:
 *   - `pending`     → only `provisioning` or `errored`
 *   - `provisioning`→ only `running` or `errored`
 *   - `running`     → `degraded` (probe miss), `stopping`, `stopped`, `errored`
 *   - `degraded`    → `running` (recovery), `stopping`, `stopped`, `errored`
 *   - `stopping`    → terminal `stopped`
 *   - `stopped`     → terminal (no out-transitions)
 *   - `errored`     → only `stopping` (cleanup path)
 *
 * The `running → stopped` and `degraded → stopped` transitions were added
 * 2026-05-19 to model "pod deleted externally" — kubectl delete pod (or any
 * out-of-band cluster mutation) makes the next reconciler tick see
 * `pod_not_found_in_cluster`, and the canonical response is to transition
 * the row directly to `stopped` (skipping the `stopping` intermediate because
 * cloud never initiated the shutdown). Without these edges the reconciler
 * gets wedged: it cannot mark the row stopped, so the row stays `running`
 * forever even though there is no underlying workload, and the runtime-
 * installations UI shows ghost cards.
 *
 * `failing` is gone — every legacy infra-failure path now writes `errored`.
 */
const ALLOWED_TRANSITIONS: Record<SandboxStatus, ReadonlySet<SandboxStatus>> = {
  pending: new Set(['provisioning', 'errored']),
  provisioning: new Set(['running', 'errored']),
  running: new Set(['degraded', 'stopping', 'stopped', 'errored']),
  degraded: new Set(['running', 'errored', 'stopping', 'stopped']),
  stopping: new Set(['stopped']),
  stopped: new Set(),
  errored: new Set(['stopping']),
};

export class SandboxStatusTransitionError extends Error {
  readonly from: SandboxStatus;
  readonly to: SandboxStatus;

  constructor(from: SandboxStatus, to: SandboxStatus, context?: string) {
    super(`[sandbox-fsm] illegal transition: ${from} -> ${to}${context ? ` (${context})` : ''}`);
    this.name = 'SandboxStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isSandboxStatus(value: string): value is SandboxStatus {
  return STATUS_SET.has(value);
}

export function normalizeSandboxStatus(value: string): SandboxStatus {
  const normalized = value.trim().toLowerCase();
  if (isSandboxStatus(normalized)) return normalized;
  const aliased = ALIASES[normalized];
  if (aliased) return aliased;
  return 'errored';
}

export function canTransitionSandboxStatus(from: SandboxStatus, to: SandboxStatus): boolean {
  return from === to || (ALLOWED_TRANSITIONS[from]?.has(to) ?? false);
}

/**
 * Release 200 T11 — throws on illegal transition. Callers (e.g. the
 * reconciler tick) MUST catch this and either skip the row or fail loudly;
 * see `src/lib/sandbox-k8s-reconciler.ts`.
 *
 * The `context` payload is appended to the error message + structured-log
 * fields so the operator can identify the offending row/pod without
 * grepping the reconciler source.
 */
export function assertSandboxStatusTransition(
  from: SandboxStatus,
  to: SandboxStatus,
  context?: { rowId?: string; reason?: string; podName?: string },
): void {
  if (canTransitionSandboxStatus(from, to)) return;
  const tags = context
    ? [
        context.rowId ? `rowId=${context.rowId}` : null,
        context.podName ? `pod=${context.podName}` : null,
        context.reason ? `reason=${context.reason}` : null,
      ]
        .filter(Boolean)
        .join(' ')
    : undefined;
  // Logger emits a structured record so dashboards can alert on the event;
  // the throw is the hard-stop signal for the caller.
  logger.error(
    {
      rowId: context?.rowId,
      podName: context?.podName,
      from,
      to,
      reason: context?.reason,
    },
    '[sandbox-fsm] illegal transition (rejected)',
  );
  throw new SandboxStatusTransitionError(from, to, tags);
}

export function transitionSandboxStatus(
  from: SandboxStatus,
  to: SandboxStatus,
  context?: { rowId?: string; reason?: string; podName?: string },
): SandboxStatus {
  assertSandboxStatusTransition(from, to, context);
  return to;
}

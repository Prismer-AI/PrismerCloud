// Phase 8b / M3 — cloud-reachability online-state aggregation.
// (docs/desktop202/11-local-data-plane.md §2 M3, 13-sync-protocol-spec.md §6/§9).
//
// M3 makes "cloud unreachable" EXPLICIT and observable instead of an implicit
// behavior buried in SWR's revalidate-failure branch (13 §6). This tracker is
// the single aggregation point for the two cloud-reachability signals the
// gateway already produces:
//
//   1. SSE subscriber connection state — connected ⇒ the daemon→cloud read
//      channel is live; disconnected/reconnecting ⇒ it is not.
//   2. SWR revalidate outcomes — every cloud passthrough/revalidate either
//      succeeds (cloud reachable) or fails with `cloud_unreachable` (it is not).
//
// AGGREGATION (11 §2 M3):
//   - online   : SSE connected. The authoritative "cloud is reachable" signal —
//                a live SSE means real-time data is flowing.
//   - degraded : SSE not connected BUT revalidate still succeeding (transient
//                SSE drop / reconnect window while REST is fine) OR the very
//                first reconnect failures before we cross the offline threshold.
//   - offline  : SSE disconnected AND revalidate has failed
//                `OFFLINE_FAILURE_THRESHOLD` consecutive times — the cloud is
//                genuinely unreachable.
//
// Recovery to `online` is edge-triggered on SSE reconnect (the subscriber
// resets its backoff on a successful connect), which fires `onRecover` so the
// runner can kick an immediate outbox flush + watermark catch-up (11 §2 M3
// "恢复后自动 flush + 对账").
//
// CAPABILITY: constructed only when the gateway is enabled. CLI/K8s daemons
// never build it → zero extra state, zero behavior change.

/** Aggregate cloud reachability as surfaced on /healthz + driving offline reads. */
export type GatewayOnlineState = 'online' | 'degraded' | 'offline';

/**
 * Consecutive revalidate failures (while the SSE is down) before we declare
 * `offline`. One failure could be a blip; the threshold debounces flapping.
 */
const OFFLINE_FAILURE_THRESHOLD = 2;

export interface OnlineStateTrackerDeps {
  /** Fired on every state transition (old → new). Observability / logging. */
  onChange?: (state: GatewayOnlineState, prev: GatewayOnlineState) => void;
  /** Fired edge-triggered when we transition INTO `online` from a non-online
   *  state — i.e. cloud just became reachable again. The runner wires this to
   *  the recovery flush + catch-up (11 §2 M3). */
  onRecover?: () => void;
  log?: (line: string) => void;
}

/**
 * In-memory aggregation of cloud reachability. Both inputs (SSE connection
 * state + revalidate outcomes) push into it; `state` is derived and `reachable`
 * is the boolean projection surfaced on /healthz.
 */
export class OnlineStateTracker {
  private sseConnected = false;
  private revalidateFailures = 0;
  /** Latched: true once revalidate has succeeded at least once while SSE is
   *  down — keeps us in `degraded` (REST works) rather than dropping to
   *  `offline` purely because the SSE hasn't connected yet on cold boot. */
  private revalidateOkSinceSseDrop = false;
  private current: GatewayOnlineState = 'degraded'; // cold boot: SSE not yet up.

  constructor(private readonly deps: OnlineStateTrackerDeps = {}) {}

  /** Current aggregated state. */
  get state(): GatewayOnlineState {
    return this.current;
  }

  /** Boolean projection for /healthz `cloudReachable` (online OR degraded — REST
   *  still works in degraded; only `offline` means truly unreachable). */
  get cloudReachable(): boolean {
    return this.current !== 'offline';
  }

  /** SSE subscriber reports its connection came up (cloud read channel live). */
  onSseConnected(): void {
    this.sseConnected = true;
    this.revalidateFailures = 0;
    this.revalidateOkSinceSseDrop = false;
    this.recompute();
  }

  /** SSE subscriber reports its connection dropped / is reconnecting. */
  onSseDisconnected(): void {
    if (this.sseConnected) this.revalidateOkSinceSseDrop = false;
    this.sseConnected = false;
    this.recompute();
  }

  /** A SWR revalidate / cloud passthrough succeeded (cloud reachable via REST). */
  onRevalidateSuccess(): void {
    this.revalidateFailures = 0;
    if (!this.sseConnected) this.revalidateOkSinceSseDrop = true;
    this.recompute();
  }

  /** A SWR revalidate / cloud passthrough failed with cloud_unreachable. */
  onRevalidateFailure(): void {
    this.revalidateFailures += 1;
    this.revalidateOkSinceSseDrop = false;
    this.recompute();
  }

  private recompute(): void {
    const next = this.derive();
    if (next === this.current) return;
    const prev = this.current;
    this.current = next;
    this.deps.log?.(`[daemon] gateway online-state ${prev} → ${next}\n`);
    this.deps.onChange?.(next, prev);
    if (next === 'online' && prev !== 'online') this.deps.onRecover?.();
  }

  private derive(): GatewayOnlineState {
    // SSE live = authoritative online (real-time data flowing).
    if (this.sseConnected) return 'online';
    // SSE down but REST proven reachable since the drop → degraded.
    if (this.revalidateOkSinceSseDrop) return 'degraded';
    // SSE down + repeated revalidate failures → offline.
    if (this.revalidateFailures >= OFFLINE_FAILURE_THRESHOLD) return 'offline';
    // SSE down, not yet enough evidence either way (cold boot / first blip).
    return 'degraded';
  }
}

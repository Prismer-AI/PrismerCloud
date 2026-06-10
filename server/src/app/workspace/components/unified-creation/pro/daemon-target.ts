/**
 * §30 B3.5 / v200 Pro flow K8S device picker — unified host-target interface.
 *
 * A "daemon target" is anywhere a long-running agent can be hosted:
 *   - the local host daemon (127.0.0.1:3210, paired to a workspace via setup)
 *   - any K8S sandbox device provisioned inside the current workspace
 *
 * Differs from LocalDaemonHealthDTO (the literal /healthz response shape) by
 * carrying enough information for `create-long-running-agent.ts` to decide
 * WHICH install path to use:
 *
 *   source='local-host' → existing pull-based flow. `createAgent` with
 *     `daemonId: hostDaemon.daemonId` puts a row in IM; the host daemon's
 *     persistent WS connection receives the agent event and self-installs.
 *
 *   source='k8s-device' → push-based flow. `createAgent` first, then explicit
 *     `POST /api/workspace/runtime-installations/:id/agents` which cloud-side
 *     RPCs `k8sSandbox.installAgent` → pod daemon `/v1/agents/install`.
 *
 * The Pro tile picker uses `bindable` to enable/disable the radio entry and
 * `mismatchReason` to render a short explanation when not bindable.
 *
 * NOTE: this is a TYPE-ONLY module. No React imports, no runtime helpers.
 * Keep it cheap to import from both the picker UI and the create pipeline.
 */

export type DaemonTargetSource = 'local-host' | 'k8s-device';

/**
 * Local host daemon (127.0.0.1:3210). Always returned by useDaemonTargets,
 * even when offline — so the picker can render "Local daemon: not running"
 * rather than silently dropping the option.
 */
export interface LocalHostDaemonTarget {
  source: 'local-host';
  daemonId: string;
  /** e.g. "Local daemon (PrismerdeMac-Studio-local-...)". */
  label: string;
  /** host /healthz workspaceId field — null when daemon is offline. */
  workspaceId: string | null;
  /** workspace match + wsConnected. */
  bindable: boolean;
  /** "wrong workspace" / "not connected" / "Local daemon unreachable" etc. */
  mismatchReason?: string;
}

/**
 * Workspace-scoped K8S sandbox device (runtimeKind='k8s'). Sourced from
 * GET /api/workspace/runtime-installations. The reconciler keeps daemonStatus
 * fresh via Redis presence + IMAgentCard heartbeats.
 */
export interface K8sDeviceDaemonTarget {
  source: 'k8s-device';
  /** IMContainer.daemonId (may be null on legacy rows pre-§26 B5). */
  daemonId: string | null;
  /** IMContainer.id — used in `/api/workspace/runtime-installations/:id/agents`. */
  installationId: string;
  /** K8s pod name (informational; appears in label). */
  podName: string;
  /** e.g. "K8S device prismer-agent-rt-pboi6dj-... (running)". */
  label: string;
  /** Raw IMContainer.status: 'provisioning' | 'running' | 'errored' | ... */
  status: string;
  /** Daemon plane readiness: 'connected' | 'stale' | 'offline'. */
  daemonStatus: 'connected' | 'stale' | 'offline';
  /** Pod gateway URL (cloud → pod RPC). Null until controller fills it in. */
  gatewayUrl: string | null;
  /** Heartbeat freshness from reconciler (ms since last heartbeat). */
  heartbeatAgeMs: number | null;
  /** status='running' && daemonStatus !== 'offline' && gatewayUrl != null. */
  bindable: boolean;
  /** "not running" / "daemon offline" / "no gateway yet" / etc. */
  mismatchReason?: string;
}

export type DaemonTarget = LocalHostDaemonTarget | K8sDeviceDaemonTarget;

/**
 * Stable key for React lists. Host daemon collapses to "local-host" because
 * there is only ever one; K8s devices use their installationId.
 */
export function daemonTargetKey(target: DaemonTarget): string {
  return target.source === 'local-host' ? `local-host:${target.daemonId}` : `k8s-device:${target.installationId}`;
}

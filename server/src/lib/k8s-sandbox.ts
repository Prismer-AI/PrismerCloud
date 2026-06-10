/**
 * Cloud-side Kubernetes sandbox orchestrator (in-process K8s SDK)
 *
 * Ported from the deleted controller orchestrator as part of §26 B1; the
 * controller microservice was removed in §26 B4. See
 * `docs/54release/26-controller-removal-architecture-pivot.md` for design.
 *
 * This is the ONLY path the cloud uses to talk to K8s — there is no longer a
 * legacy HTTP fallback. `K8sSandboxError`, `ContainerInfo`, `RunCmdResult`,
 * `DaemonDispatchResult`, `InstallAgentResult`, `SnapshotResult`, and
 * `PodStatusVerdict` are owned here (previously these types lived in
 * `sandbox-client.ts`, which has been deleted).
 *
 * Important port decisions (B1):
 *   §1 runCmd preserves the controller's `exitCode: 0` synthesis when the
 *      command succeeds. The controller never extracted the real exit code
 *      from `status.details.causes[]` and we don't fix that here — that's
 *      §26 B-followup work.
 *      TODO(§26 B-followup): exitCode parsing from status.details.causes[]
 *   §2 snapshot ports the Kaniko Job path as-is, including the dead-code
 *      `kubectl cp` reference in the initContainer. Build context is never
 *      actually populated today.
 *      TODO(§26 B-followup): kubectl cp tar.gz into Kaniko build context —
 *                            currently dead code
 *   §3 Log SSE polling lives in `/api/sandboxes/[id]/logs/route.ts` — this
 *      module only exposes `getContainerLogs` (raw text). The poll-and-diff
 *      loop in that route was lifted from the controller's
 *      `src/api/v1/containers.ts:316-428` per §26 B2 audit decision #3.
 *   §8 createContainer adds an explicit `GET /healthz` round-trip after pod
 *      Ready, replacing the controller's implicit "trust the readinessProbe"
 *      behavior. Failure here surfaces immediately rather than at first
 *      task dispatch.
 *
 * `@kubernetes/client-node` is lazy-imported via `src/lib/k8s-client.ts` so
 * docker-only / no-sandbox setups don't pay bundle cost.
 */

import { PassThrough } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { createApiKey } from '@/lib/db-api-keys';
import {
  ensureImagePullSecret,
  ensureNamespace,
  getCoreV1Api,
  getImagePullSecret,
  getK8sExec,
  getK8sNamespace,
  getK8sSdk,
  getKubeConfig,
  getNodeExternalIp,
  testK8sConnection,
} from '@/lib/k8s-client';
import prisma from '@/lib/prisma';
import { SANDBOX_DAEMON_PORT, buildSandboxHostAliases } from '@/lib/sandbox/pod-spec';
import { getDaemonImage } from '@/lib/sandbox/image-pin';

// ============================================================
// Result + verdict shapes (formerly re-exported from sandbox-client.ts;
// inlined here after §26 B4 removed the controller)
// ============================================================

/**
 * Normalised container info returned to the cloud route.
 *
 * Mirrors the shape historically returned by the deleted S1 controller's
 * `/internal/v1/containers` endpoint. The DB persists `podName`; callers
 * use `containerId === podName` for ergonomic addressability.
 */
export interface ContainerInfo {
  containerId: string;
  podName: string;
  status: string;
  gatewayUrl?: string | null;
}

/**
 * §26 B4 — verdict shape returned by `k8sSandbox.podStatusVerdict()`.
 * Used by `src/lib/sandbox-k8s-reconciler.ts` (the in-process reconcile loop)
 * to determine the next DB status for `runtimeKind='k8s'` rows. Historically
 * mirrored the deleted controller's `GET /internal/v1/k8s/pod-status` reply.
 */
export interface PodStatusVerdict {
  podName: string;
  namespace: string;
  exists: boolean;
  phase: string | null;
  reason: string | null;
  message: string | null;
  containerStarted: boolean;
  podIP: string | null;
  startedAt: string | null;
  apiError: { code: string; message: string } | null;
}

// ============================================================
// Constants
// ============================================================

/**
 * Daemon-first migration (drift #4 closure, 2026-05-07):
 * Daemon binds local-server on :7878; healthz is `/healthz`.
 *
 * Release 200 §5.3 — single source of truth for the daemon port lives in
 * `src/lib/sandbox/pod-spec.ts::SANDBOX_DAEMON_PORT`. Mirrored here so
 * legacy code paths that already reference `DEFAULT_DAEMON_PORT` continue
 * to compile; new code should import `SANDBOX_DAEMON_PORT` directly.
 */
export const DEFAULT_DAEMON_PORT = SANDBOX_DAEMON_PORT;
export const POD_NAME_PREFIX = 'prismer-agent-';
export const SERVICE_NAME_PREFIX = 'prismer-svc-';
/** Container name inside the pod spec — daemon-first rename from `openclaw`. */
export const CONTAINER_NAME = 'daemon';

const AGENT_LABEL_KEY = 'prismer.agent.id';
const MANAGED_LABEL = 'prismer.managed';

/**
 * T8 / 08 §5.2 — Resolve the daemon image ref via the image-pin service.
 *
 * Replaces the hardcoded `'dockerhub.services/prismer/library/sandbox:daemon-v1.0'`
 * fallback. Priority (08 §5.2):
 *   1. caller-provided `config.image` (passed through unchanged)
 *   2. `CONTAINER_IMAGE` env (CI / operator override)
 *   3. `infra/sandbox-image/image-pin.yaml` → `images.daemon.canonical`
 *   4. throw — refuse to provision ("永远 reject 优于永远 ImagePullBackOff")
 *
 * We resolve lazily (each call) so test injection via CONTAINER_IMAGE works
 * and so a typo in image-pin.yaml surfaces on the next create rather than at
 * module load.
 */
function resolveDefaultImage(): string {
  return getDaemonImage();
}

// ============================================================
// Types
// ============================================================

export interface ContainerCreateConfig {
  image?: string;
  /**
   * Legacy "bytes" knob (preserved for the controller-shaped call path).
   * Ignored when any of `cpuRequest` / `cpuLimit` / `memoryRequest` /
   * `memoryLimitStr` are set — those win because they're k8s-native strings.
   */
  memoryLimit?: number;
  cpuShares?: number;
  environment?: Record<string, string>;
  /**
   * §26 B2 — K8s-native resource fields propagated from caller (strings like
   * `'250m'`, `'2Gi'`). When any of these are set, the numeric `memoryLimit`
   * (bytes) field is ignored. The four cloud callers (`/api/sandboxes`,
   * `/api/workspace/runtime-installations`, `task.service.ts`) always thread
   * these as strings.
   */
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimitStr?: string;
  /** Optional progress callback (see ProvisionContainerArgs.onStep). */
  onStep?: (
    step: 'container_create' | 'container_running' | 'daemon_healthy',
    status: 'in_progress' | 'ok' | 'error',
    error?: string,
  ) => void | Promise<void>;
  /**
   * Release 200 §5.4 — expected daemonId. When set, the post-create
   * `/healthz` probe will warn-only on `response.daemonId !== expectedDaemonId`.
   * Set by `provisionContainer` (which mints the id + injects it via the
   * `PRISMER_DAEMON_ID` env). Direct callers of `createContainer` from
   * scoped-key-free paths may leave it undefined, in which case the daemon's
   * self-reported id is logged but not validated.
   */
  expectedDaemonId?: string;
}

export interface RunCmdArgs {
  command: string[];
  timeoutMs?: number;
}

export interface RunCmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DaemonDispatchArgs {
  taskId: string;
  adapter?: string;
  prompt?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface DaemonDispatchResult {
  runId: string;
  status?: string;
  [key: string]: unknown;
}

export interface InstallAgentArgs {
  workspaceId: string;
  imUserId: string;
  name: string;
  adapterName: string;
  capabilities: string[];
  profile: {
    id: string;
    name: string;
    adapterName: string;
    config: Record<string, unknown>;
    version: number;
  };
}

export interface InstallAgentResult {
  ok: true;
  daemonId: string;
  installedAgent: {
    imUserId: string;
    name: string;
    adapterName: string;
    profileId: string;
  };
  hostedAgents: Array<{ imUserId: string; name: string; adapterName: string }>;
}

export interface AgentStateManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  mtime?: number;
  rootKind?: string;
  rootPath?: string;
}

export interface AgentStateDumpRoot {
  kind: string;
  rootPath: string;
  exists: boolean;
  error?: string;
  files: AgentStateManifestEntry[];
}

export interface AgentStateDumpResult {
  agentId: string;
  adapterName?: string;
  dumpedAt: string;
  roots: AgentStateDumpRoot[];
  files: AgentStateManifestEntry[];
}

export interface SnapshotArgs {
  repo?: string;
  tag?: string;
  comment?: string;
}

export interface SnapshotResult {
  imageTag: string;
  imageDigest?: string;
  sizeBytes?: number;
}

export type K8sSandboxErrorCode =
  | 'CONTAINER_NOT_FOUND'
  | 'CONTAINER_ALREADY_EXISTS'
  | 'CONTAINER_START_FAILED'
  | 'CONTAINER_STOP_FAILED'
  | 'K8S_NOT_AVAILABLE'
  | 'SNAPSHOT_FAILED'
  | 'DAEMON_UNREACHABLE'
  | 'POD_IP_UNAVAILABLE'
  | 'HEALTHZ_FAILED'
  | 'UNKNOWN_ERROR';

/**
 * Map a K8sSandboxError code to the HTTP status the API route should surface.
 * Preserved from the §26 B2 helper that synthesized a status for the legacy
 * parent class; even though B4 dropped that parent, callers still surface
 * `err.status` in 502 responses, so this mapping remains the source of truth.
 *
 * Convention:
 *   - 404: container/pod missing
 *   - 409: container already exists
 *   - 502: downstream daemon / pod IP / healthz unreachable
 *   - 503: cluster unreachable
 *   - 500: container start/stop/snapshot failures (catch-all infra failure)
 */
function statusForCode(code: K8sSandboxErrorCode): number {
  switch (code) {
    case 'CONTAINER_NOT_FOUND':
      return 404;
    case 'CONTAINER_ALREADY_EXISTS':
      return 409;
    case 'DAEMON_UNREACHABLE':
    case 'POD_IP_UNAVAILABLE':
    case 'HEALTHZ_FAILED':
      return 502;
    case 'K8S_NOT_AVAILABLE':
      return 503;
    case 'CONTAINER_START_FAILED':
    case 'CONTAINER_STOP_FAILED':
    case 'SNAPSHOT_FAILED':
    case 'UNKNOWN_ERROR':
    default:
      return 500;
  }
}

/**
 * Structured error thrown by `k8sSandbox.*` methods.
 *
 * §26 B4 — extends plain `Error` directly (previously extended the now-
 * removed legacy parent class). The `status`/`body` fields are kept so cloud
 * route catch blocks can surface a `502 { status, body }` response shape;
 * new callers should branch on `err.code` instead.
 *
 * Message shape `k8s sandbox error <status>: <body>` — the legacy
 * `controller responded ...` wording was retired post-§26 B4 since there's
 * no controller process anymore. Log-scraping filters keyed on the old
 * string need updating; the structured `code` / `status` fields are the
 * forward-compatible matchers.
 */
export class K8sSandboxError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(
    public readonly code: K8sSandboxErrorCode,
    message: string,
    public readonly containerId?: string,
    public readonly cause?: Error,
  ) {
    const status = statusForCode(code);
    super(`k8s sandbox error ${status}: ${message}`);
    this.name = 'K8sSandboxError';
    this.status = status;
    this.body = message;
  }
}

// ============================================================
// Shared helper: detect "already-absent" K8s errors
// ============================================================

/**
 * Returns true when a `K8sSandboxError` indicates the target pod / container
 * already doesn't exist. Used by DELETE handlers (sandboxes, runtime
 * installations) to treat "remove a pod that's already gone" as success.
 *
 * Lifted into the shared `k8s-sandbox` module post-§26 review M-2 — two
 * routes had identical local helpers. Single source of truth keeps the
 * matchers in sync (e.g. when a new error code is added).
 */
export function isAlreadyAbsentK8sError(err: K8sSandboxError): boolean {
  if (err.code === 'CONTAINER_NOT_FOUND') return true;
  if (err.status === 404) return true;
  return (
    err.body.includes('"reason":"NotFound"') ||
    err.body.includes('CONTAINER_NOT_FOUND') ||
    (err.body.includes('NotFound') && err.body.includes('not found'))
  );
}

// ============================================================
// Helpers
// ============================================================

export function podNameForAgent(agentId: string): string {
  const sanitized = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 50);
  return `${POD_NAME_PREFIX}${sanitized}`;
}

export function serviceNameForAgent(agentId: string): string {
  const sanitized = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 50);
  return `${SERVICE_NAME_PREFIX}${sanitized}`;
}

/**
 * Resolve service name for any pod (pool or legacy). Preserved verbatim from
 * the controller (including the 2026-Q3 cleanup TODO) so the DB-driven
 * unbind paths keep finding the right Service.
 */
export function serviceNameForPod(podName: string): string {
  // TODO(2026-Q3): drop after prod DB confirms zero rows match `podName LIKE 'prismer-pool-%'`.
  // See docs/54release/25-m2-k8s-pipeline-gap.md §3 ⏳ remaining item #10.
  if (podName.startsWith('prismer-pool-')) {
    return podName.replace('prismer-pool-', 'prismer-pool-svc-');
  }
  if (podName.startsWith(POD_NAME_PREFIX)) {
    return podName.replace(POD_NAME_PREFIX, SERVICE_NAME_PREFIX);
  }
  return `${podName}-svc`;
}

export function mapPodPhaseToState(phase?: string): string {
  switch (phase) {
    case 'Pending':
      return 'creating';
    case 'Running':
      return 'running';
    case 'Succeeded':
      return 'stopped';
    case 'Failed':
    case 'Unknown':
      return 'error';
    default:
      return 'pending';
  }
}

function isMissingPod(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number; code?: number })?.statusCode ?? (err as { code?: number })?.code;
  if (statusCode === 404) return true;

  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('"reason":"NotFound"') ||
    (message.includes('pods "') && message.includes('" not found"')) ||
    message.includes('pod not found') ||
    message.includes('No such pod') ||
    message.includes('not found')
  );
}

function buildContainerInfo(args: { podName: string; status: string; gatewayUrl?: string | null }): ContainerInfo {
  return {
    containerId: args.podName,
    podName: args.podName,
    status: args.status,
    gatewayUrl: args.gatewayUrl ?? null,
  };
}

// ============================================================
// Pod-IP / gateway resolution
// ============================================================

async function resolveGatewayUrl(podName: string): Promise<string | null> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();
  const nodeIp = getNodeExternalIp();

  if (nodeIp) {
    const serviceName = serviceNameForPod(podName);
    try {
      const svc = (await api.readNamespacedService({ name: serviceName, namespace })) as {
        spec?: { ports?: Array<{ nodePort?: number }> };
      };
      const nodePort = svc?.spec?.ports?.[0]?.nodePort;
      if (nodePort) {
        return `ws://${nodeIp}:${nodePort}`;
      }
    } catch {
      // Service not found.
    }
  }

  const podIp = await getContainerIp(podName);
  if (podIp) {
    logger.info({ podIp, podName }, '[K8sSandbox] Using pod IP for gateway (in-cluster direct)');
    return `ws://${podIp}:${DEFAULT_DAEMON_PORT}`;
  }

  if (!nodeIp) {
    const serviceName = serviceNameForPod(podName);
    try {
      const svc = (await api.readNamespacedService({ name: serviceName, namespace })) as {
        spec?: { clusterIP?: string; ports?: Array<{ port?: number; nodePort?: number }> };
      };
      const clusterIp = svc?.spec?.clusterIP;
      const port = svc?.spec?.ports?.[0]?.port;
      if (clusterIp && clusterIp !== 'None' && port) {
        logger.info({ clusterIp, port, podName }, '[K8sSandbox] Using Service ClusterIP for gateway (fallback)');
        return `ws://${clusterIp}:${port}`;
      }
      const nodePort = svc?.spec?.ports?.[0]?.nodePort;
      if (nodePort) {
        logger.info({ nodePort, podName }, '[K8sSandbox] Using NodePort without external IP (in-cluster fallback)');
        return `ws://localhost:${nodePort}`;
      }
    } catch {
      // Service not found.
    }
  }

  logger.warn({ podName }, '[K8sSandbox] Cannot resolve gateway URL — no K8S_NODE_EXTERNAL_IP and no pod IP');
  return null;
}

async function getContainerIp(podName: string): Promise<string | null> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();
  try {
    const pod = (await api.readNamespacedPod({ name: podName, namespace })) as {
      status?: { podIP?: string };
    };
    return pod?.status?.podIP ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// Wait + healthz helpers
// ============================================================

async function waitForRunning(podName: string, timeoutMs = 600_000): Promise<void> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();
  const pollInterval = 5_000;
  // Fast-bail on FailedScheduling: K8s scheduler retries every ~5-10s; if a
  // PodScheduled=False condition (typically reason=Unschedulable) persists
  // for SCHEDULING_FAIL_BAIL_MS, capacity is genuinely absent and the only
  // outcome of waiting the full timeout is a 10-minute UX delay before the
  // user sees the same error. Resource-fit failures don't self-heal without
  // ops adding nodes or evicting workloads.
  const SCHEDULING_FAIL_BAIL_MS = 60_000;
  let firstUnschedulableSeen: number | undefined;

  const start = Date.now();
  let lastPhase: string | undefined;
  let lastWaitReason: string | undefined;
  let lastWaitMessage: string | undefined;
  let lastConditionReason: string | undefined;
  let lastConditionMessage: string | undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      const pod = (await api.readNamespacedPod({ name: podName, namespace })) as {
        status?: {
          phase?: string;
          conditions?: Array<{
            type?: string;
            status?: string;
            reason?: string;
            message?: string;
          }>;
          containerStatuses?: Array<{
            state?: {
              waiting?: { reason?: string; message?: string };
              running?: Record<string, unknown>;
              terminated?: { reason?: string; exitCode?: number };
            };
          }>;
        };
      };

      const phase = pod?.status?.phase;
      const containerState = pod?.status?.containerStatuses?.[0]?.state;
      const blockingCondition = pod?.status?.conditions?.find(
        (condition) =>
          condition.status === 'False' &&
          Boolean(condition.reason || condition.message) &&
          ['PodScheduled', 'Ready', 'ContainersReady', 'Initialized'].includes(condition.type ?? ''),
      );
      const podScheduled = pod?.status?.conditions?.find((c) => c.type === 'PodScheduled');
      const unschedulable =
        podScheduled?.status === 'False' && (podScheduled.reason === 'Unschedulable' || !podScheduled.reason);
      if (unschedulable) {
        if (firstUnschedulableSeen === undefined) firstUnschedulableSeen = Date.now();
        if (Date.now() - firstUnschedulableSeen > SCHEDULING_FAIL_BAIL_MS) {
          throw new K8sSandboxError(
            'CONTAINER_START_FAILED',
            `Pod cannot be scheduled — cluster has no node that matches the agent pool requirements + resource requests. ` +
              `reason=${podScheduled?.reason ?? 'Unschedulable'}; message=${podScheduled?.message ?? 'no available node'}`,
            podName,
          );
        }
      } else if (firstUnschedulableSeen !== undefined) {
        // Cleared — pod got scheduled.
        firstUnschedulableSeen = undefined;
      }

      lastPhase = phase;
      if (blockingCondition?.reason) lastConditionReason = blockingCondition.reason;
      if (blockingCondition?.message) lastConditionMessage = blockingCondition.message;

      if (phase === 'Running') {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        logger.info({ podName, elapsedSeconds: elapsed }, '[K8sSandbox] Pod reached Running state');
        return;
      }

      if (phase === 'Failed' || phase === 'Succeeded') {
        throw new K8sSandboxError('CONTAINER_START_FAILED', `Pod entered terminal state: ${phase}`, podName);
      }

      const waitReason = containerState?.waiting?.reason;
      const waitMessage = containerState?.waiting?.message;
      if (waitReason) lastWaitReason = waitReason;
      if (waitMessage) lastWaitMessage = waitMessage;
      if (waitReason === 'ErrImagePull' || waitReason === 'ImagePullBackOff') {
        const msg = waitMessage || waitReason;
        throw new K8sSandboxError('CONTAINER_START_FAILED', `Image pull failed: ${msg}`, podName);
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 30 === 0) {
        logger.info(
          {
            podName,
            phase,
            waitReason: waitReason || blockingCondition?.reason || 'pulling image',
            waitMessage: waitMessage || blockingCondition?.message,
            elapsedSeconds: elapsed,
          },
          '[K8sSandbox] Waiting for pod',
        );
      }
    } catch (err) {
      if (err instanceof K8sSandboxError) throw err;
      // Transient API error — continue polling.
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Timeout path — gather as much K8s-side context as possible so the
  // provisioningHistory.error in DB carries actionable root cause instead
  // of just "did not reach Running within 600s". Pre-fix forensic showed
  // 4+ daemon image versions all timing out identically with zero
  // diagnostic info, forcing kubectl describe to find the real cause
  // (node scheduling, image pull secret, network policy, etc.).
  //
  // Best-effort: each sub-fetch is wrapped in try/catch so a permission
  // gap on `events` doesn't lose the pod snapshot, and vice-versa.
  let diagnostics: Record<string, unknown> = {};
  try {
    const finalPod = (await api.readNamespacedPod({ name: podName, namespace })) as {
      status?: {
        phase?: string;
        conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
        containerStatuses?: Array<{
          name?: string;
          ready?: boolean;
          restartCount?: number;
          state?: {
            waiting?: { reason?: string; message?: string };
            terminated?: { reason?: string; exitCode?: number; message?: string };
          };
        }>;
      };
    };
    diagnostics.phase = finalPod?.status?.phase;
    diagnostics.conditions = (finalPod?.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    }));
    diagnostics.containerStatuses = (finalPod?.status?.containerStatuses ?? []).map((cs) => ({
      name: cs.name,
      ready: cs.ready,
      restarts: cs.restartCount,
      waiting: cs.state?.waiting,
      terminated: cs.state?.terminated,
    }));
  } catch (err) {
    diagnostics.podFetchError = err instanceof Error ? err.message : String(err);
  }
  try {
    // K8s field selector: involvedObject.name = podName narrows events to
    // just this pod's lifecycle. Take the most recent 10 to cover the
    // scheduling → image-pull → start chain.
    const events = (await api.listNamespacedEvent({
      namespace,
      fieldSelector: `involvedObject.name=${podName}`,
      limit: 50,
    })) as { items?: Array<{ reason?: string; message?: string; type?: string; lastTimestamp?: string; count?: number }> };
    const items = events?.items ?? [];
    diagnostics.events = items
      .slice(-10)
      .map((e) => ({ type: e.type, reason: e.reason, message: e.message, lastAt: e.lastTimestamp, count: e.count }));
  } catch (err) {
    diagnostics.eventsFetchError = err instanceof Error ? err.message : String(err);
  }

  const summary = [
    `Pod did not reach Running state within ${timeoutMs / 1000}s`,
    lastPhase ? `phase=${lastPhase}` : null,
    lastWaitReason || lastConditionReason ? `reason=${lastWaitReason ?? lastConditionReason}` : null,
    lastWaitMessage || lastConditionMessage ? `message=${lastWaitMessage ?? lastConditionMessage}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  throw new K8sSandboxError(
    'CONTAINER_START_FAILED',
    `${summary} | diag=${JSON.stringify(diagnostics).slice(0, 2000)}`,
    podName,
  );
}

/**
 * Daemon /healthz response shape (Release 200 §5.4).
 *
 * Schema upgraded from the legacy `{ status, daemonId, ... }` shape to add
 * `daemonVersion / readyForDispatch / adapters / resources / uptime`.
 *
 * All Release-200 new fields are optional so cloud can graceful-degrade
 * against pre-2.0.0 daemons: when `readyForDispatch` is `undefined`, cloud
 * treats `status==='ok'` alone as healthy (see `provisionContainer`). When
 * the daemon is upgraded, cloud will additionally require
 * `readyForDispatch===true`.
 */
export interface HealthzResponse {
  status: string;
  daemonId?: string;
  /** Release 200 §5.4 — new. */
  daemonVersion?: string;
  cloudBaseUrl?: string;
  workspaceId?: string | null;
  pid?: number;
  startedAt?: number;
  /** Release 200 §5.4 — new (seconds since startedAt). */
  uptime?: number;
  wsConnected?: boolean;
  hostedAgents?: Array<{ imUserId: string; name: string; adapterName: string }>;
  /** Release 200 §5.4 — new (per-adapter readiness). */
  adapters?: Array<{ name: string; ready: boolean; version?: string }>;
  /** Release 200 §5.4 — new (CPU/Mem snapshot; v200 returns placeholder zeros). */
  resources?: {
    cpu: { usagePct: number };
    mem: { usedBytes: number; limitBytes: number };
  };
  /** Release 200 §5.4 — new (Ready-AND across adapters). */
  readyForDispatch?: boolean;
  memoryReady?: boolean;
  assetReady?: boolean;
  observability?: Record<string, unknown>;
}

const HEALTHZ_HTTP_TIMEOUT_MS = 5_000;
const HEALTHZ_EXEC_TIMEOUT_MS = 5_000;

/**
 * §26 B1 §8 + Release 200 §5.4: probe daemon `/healthz`.
 *
 * Resolution strategy:
 *   1. Resolve `gatewayUrl` and fetch `/healthz` via HTTP.
 *   2. On any HTTP failure (no gateway URL / connection refused / non-2xx
 *      / parse failure) fall back to a cluster-internal exec — open a
 *      `curl` inside the pod against `127.0.0.1:7878/healthz`. This works
 *      regardless of whether the cloud is in-cluster or out-of-cluster,
 *      and removes the legacy D-8 `KUBERNETES_SERVICE_HOST` gate.
 *
 * Returns the parsed `HealthzResponse` on success; throws
 * `K8sSandboxError('HEALTHZ_FAILED', ...)` only when both transports fail.
 * Callers downstream of `K8sSandboxProvider` will see this surface as
 * `ProviderError('daemon_unreachable', ...)`.
 */
async function probeHealthz(podName: string): Promise<HealthzResponse> {
  const httpResult = await probeHealthzViaHttp(podName);
  if (httpResult.ok) return httpResult.body;

  logger.warn(
    { podName, httpError: httpResult.reason },
    '[K8sSandbox] /healthz HTTP probe failed, falling back to cluster-internal exec',
  );

  // Cluster-internal exec fallback.
  return probeHealthzViaExec(podName);
}

async function probeHealthzViaHttp(
  podName: string,
): Promise<{ ok: true; body: HealthzResponse } | { ok: false; reason: string }> {
  const gatewayUrl = await resolveGatewayUrl(podName);
  if (!gatewayUrl) {
    return {
      ok: false,
      reason: 'no gateway URL resolvable (no NodeExternalIP, no Pod IP, no Service)',
    };
  }
  const healthUrl = gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:') + '/healthz';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTHZ_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `/healthz returned HTTP ${res.status}` };
    }
    const text = await res.text();
    try {
      return { ok: true, body: JSON.parse(text) as HealthzResponse };
    } catch (parseErr) {
      return {
        ok: false,
        reason: `/healthz body not JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `/healthz HTTP fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Cluster-internal /healthz probe (Release 200 §5.4).
 *
 * When the cloud is out-of-cluster (dev kind cluster, separate-VPC control
 * plane), pod IP `10.244.x.x:7878` is unroutable from the host network.
 * Open a `curl` inside the pod itself via the K8s exec API and parse the
 * JSON it prints to stdout — this needs only kube-apiserver reachability,
 * not pod-network reachability, so the same code path works in dev kind
 * and prod EKS.
 *
 * Throws `K8sSandboxError('HEALTHZ_FAILED', ...)` on any failure
 * (exec API rejection, non-zero curl exit, JSON parse failure, timeout).
 */
async function probeHealthzViaExec(podName: string): Promise<HealthzResponse> {
  let k8sExec: Awaited<ReturnType<typeof getK8sExec>>;
  try {
    k8sExec = await getK8sExec();
  } catch (err) {
    throw new K8sSandboxError(
      'HEALTHZ_FAILED',
      `exec client init failed: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
  const namespace = getK8sNamespace();

  // curl flags: -s (silent) + --max-time (curl-side per-request timeout).
  // The outer Promise.race below adds a JS-side hard cap in case curl
  // itself hangs (e.g. exec stream stuck).
  const command = ['curl', '-s', '--max-time', '3', `http://127.0.0.1:${SANDBOX_DAEMON_PORT}/healthz`];

  return new Promise<HealthzResponse>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.end();

    stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const settleReject = (reason: K8sSandboxError) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };
    const settleResolve = (value: HealthzResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const hardTimeout = setTimeout(() => {
      settleReject(
        new K8sSandboxError(
          'HEALTHZ_FAILED',
          `exec /healthz probe timed out after ${HEALTHZ_EXEC_TIMEOUT_MS}ms`,
          podName,
        ),
      );
    }, HEALTHZ_EXEC_TIMEOUT_MS);

    const runPromise = k8sExec.exec(
      namespace,
      podName,
      CONTAINER_NAME,
      command,
      stdout,
      stderr,
      stdin,
      false, // tty
      (status) => {
        clearTimeout(hardTimeout);
        const stdoutStr = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        const stderrStr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const statusOk = (status as { status?: string })?.status === 'Success';

        if (!statusOk) {
          const msg = (status as { message?: string })?.message ?? stderrStr ?? 'exec failed';
          settleReject(new K8sSandboxError('HEALTHZ_FAILED', `exec /healthz curl exited non-zero: ${msg}`, podName));
          return;
        }

        if (!stdoutStr) {
          settleReject(
            new K8sSandboxError(
              'HEALTHZ_FAILED',
              `exec /healthz returned empty stdout (stderr=${stderrStr || 'empty'})`,
              podName,
            ),
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdoutStr) as HealthzResponse;
          settleResolve(parsed);
        } catch (err) {
          settleReject(
            new K8sSandboxError(
              'HEALTHZ_FAILED',
              `exec /healthz stdout not JSON: ${err instanceof Error ? err.message : String(err)}`,
              podName,
              err instanceof Error ? err : undefined,
            ),
          );
        }
      },
    );

    runPromise.catch((err: unknown) => {
      clearTimeout(hardTimeout);
      settleReject(
        new K8sSandboxError(
          'HEALTHZ_FAILED',
          `exec /healthz failed: ${err instanceof Error ? err.message : String(err)}`,
          podName,
          err instanceof Error ? err : undefined,
        ),
      );
    });
  });
}

const DAEMON_RPC_EXEC_TIMEOUT_MS = 10_000;

/**
 * Cluster-internal POST RPC fallback for daemon endpoints. Used when the
 * direct cloud → podIP HTTP request fails because cloud is running
 * out-of-cluster (e.g. local dev: cloud on host, pod on kind 10.244.0.0/16
 * which the host cannot reach). Same exec-via-kubeapi pattern as
 * probeHealthzViaExec; differs in that it POSTs a JSON body through
 * stdin to `curl --data-binary @-`.
 *
 * Generic helper — used by installAgent/daemonDispatch RPC paths. Caller
 * passes the endpoint path (e.g. '/v1/agents/install') and the body
 * object; we serialize to JSON, pipe to curl stdin in-pod, parse the
 * response stdout back to JS object.
 *
 * Throws K8sSandboxError on:
 *   - exec client init failure
 *   - curl non-zero exit / non-2xx (best-effort exit code surfacing)
 *   - exec hard timeout (DAEMON_RPC_EXEC_TIMEOUT_MS)
 *   - JSON parse failure
 */
async function daemonRpcViaExec(podName: string, path: string, body: unknown): Promise<unknown> {
  let k8sExec: Awaited<ReturnType<typeof getK8sExec>>;
  try {
    k8sExec = await getK8sExec();
  } catch (err) {
    throw new K8sSandboxError(
      'DAEMON_UNREACHABLE',
      `exec client init failed: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
  const namespace = getK8sNamespace();
  const bodyJson = JSON.stringify(body);

  // curl reads body from stdin via `--data-binary @-`. -w '\n%{http_code}'
  // appends the status code to stdout on a new line so we can distinguish
  // 2xx from 4xx/5xx without relying on -f (which discards body on error).
  const command = [
    'curl',
    '-s',
    '--max-time',
    '8',
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-w',
    '\\n__HTTP_STATUS__:%{http_code}',
    '--data-binary',
    '@-',
    `http://127.0.0.1:${SANDBOX_DAEMON_PORT}${path}`,
  ];

  return new Promise<unknown>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.write(bodyJson);
    stdin.end();

    stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const settleReject = (reason: K8sSandboxError) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };
    const settleResolve = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const hardTimeout = setTimeout(() => {
      settleReject(
        new K8sSandboxError(
          'DAEMON_UNREACHABLE',
          `exec ${path} RPC timed out after ${DAEMON_RPC_EXEC_TIMEOUT_MS}ms`,
          podName,
        ),
      );
    }, DAEMON_RPC_EXEC_TIMEOUT_MS);

    const runPromise = k8sExec.exec(
      namespace,
      podName,
      CONTAINER_NAME,
      command,
      stdout,
      stderr,
      stdin,
      false,
      (status) => {
        clearTimeout(hardTimeout);
        const stdoutStr = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderrStr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const statusOk = (status as { status?: string })?.status === 'Success';

        if (!statusOk) {
          const msg = (status as { message?: string })?.message ?? stderrStr ?? 'exec failed';
          settleReject(new K8sSandboxError('DAEMON_UNREACHABLE', `exec ${path} curl exited non-zero: ${msg}`, podName));
          return;
        }

        // Parse trailing "__HTTP_STATUS__:NNN" marker added by curl -w.
        const marker = stdoutStr.lastIndexOf('__HTTP_STATUS__:');
        if (marker < 0) {
          settleReject(
            new K8sSandboxError('DAEMON_UNREACHABLE', `exec ${path} stdout missing HTTP status marker`, podName),
          );
          return;
        }
        const bodyText = stdoutStr.slice(0, marker).replace(/\n$/, '');
        const httpStatus = parseInt(stdoutStr.slice(marker + '__HTTP_STATUS__:'.length).trim(), 10);

        if (Number.isNaN(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
          settleReject(
            new K8sSandboxError(
              'DAEMON_UNREACHABLE',
              `daemon ${path} returned HTTP ${httpStatus}: ${bodyText.slice(0, 256)}`,
              podName,
            ),
          );
          return;
        }

        try {
          const parsed = bodyText ? JSON.parse(bodyText) : null;
          settleResolve(parsed);
        } catch (err) {
          settleReject(
            new K8sSandboxError(
              'DAEMON_UNREACHABLE',
              `exec ${path} response not JSON: ${err instanceof Error ? err.message : String(err)}`,
              podName,
              err instanceof Error ? err : undefined,
            ),
          );
        }
      },
    );

    runPromise.catch((err: unknown) => {
      clearTimeout(hardTimeout);
      settleReject(
        new K8sSandboxError(
          'DAEMON_UNREACHABLE',
          `exec ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
          podName,
          err instanceof Error ? err : undefined,
        ),
      );
    });
  });
}

// ============================================================
// Lifecycle methods
// ============================================================

async function createContainer(agentId: string, config: ContainerCreateConfig): Promise<ContainerInfo> {
  // Progress emitter — best-effort wrapper around the optional callback.
  // Caller errors must NOT abort provisioning; just log and continue.
  const emit = async (
    step: 'container_create' | 'container_running' | 'daemon_healthy',
    status: 'in_progress' | 'ok' | 'error',
    error?: string,
  ): Promise<void> => {
    if (!config.onStep) return;
    try {
      await config.onStep(step, status, error);
    } catch (err) {
      logger.warn(
        { step, status, err: err instanceof Error ? err.message : String(err) },
        '[K8sSandbox] onStep callback threw, ignoring',
      );
    }
  };

  try {
    await testK8sConnection();
  } catch (err) {
    throw new K8sSandboxError(
      'K8S_NOT_AVAILABLE',
      `Kubernetes cluster is not available: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err instanceof Error ? err : undefined,
    );
  }

  const image = config.image || resolveDefaultImage();
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();
  const podName = podNameForAgent(agentId);
  const serviceName = serviceNameForAgent(agentId);

  await ensureNamespace();
  await ensureImagePullSecret();

  try {
    await api.readNamespacedPod({ name: podName, namespace });
    throw new K8sSandboxError('CONTAINER_ALREADY_EXISTS', `Pod ${podName} already exists`, podName);
  } catch (err) {
    if (err instanceof K8sSandboxError) throw err;
    // pod doesn't exist or read-perm issue — proceed to create.
  }

  const envVars: Array<{ name: string; value: string }> = [{ name: 'AGENT_ID', value: agentId }];
  if (config.environment) {
    for (const [key, value] of Object.entries(config.environment)) {
      envVars.push({ name: key, value });
    }
  }
  if (!envVars.some((e) => e.name === 'DISPATCH_DAEMON_SECRET') && process.env.DISPATCH_DAEMON_SECRET?.trim()) {
    envVars.push({ name: 'DISPATCH_DAEMON_SECRET', value: process.env.DISPATCH_DAEMON_SECRET.trim() });
  }

  // S6/T5 (2026-05-18) — local cookbook dev escape. v200 baseline POST /api/sandboxes
  // path does NOT mint a sandbox-scoped PRISMER_API_KEY (scoped-key mint is gated
  // on apiKeyTtlSeconds + taskId, only the task-dispatch path provides those).
  // For local cookbook smoke against /api/sandboxes + /healthz + /runCmd, inject a
  // dev-owned API key here when SANDBOX_DEV_INJECT_API_KEY is set in the cloud env.
  // The injected value must be a real `sk-prismer-*` key registered in pc_api_keys
  // (the WS auth path in src/im/ws/handler.ts validates it via validateApiKeyFromDb).
  // Prod cloud will never set SANDBOX_DEV_INJECT_API_KEY.
  const hasApiKey = envVars.some((e) => e.name === 'PRISMER_API_KEY');
  if (!hasApiKey && process.env.SANDBOX_DEV_INJECT_API_KEY) {
    envVars.push({ name: 'PRISMER_API_KEY', value: process.env.SANDBOX_DEV_INJECT_API_KEY });
    logger.info(
      { agentId, podName },
      '[K8sSandbox] dev-injected PRISMER_API_KEY from SANDBOX_DEV_INJECT_API_KEY env (S6 cookbook escape)',
    );
  }

  // §26 B2 — caller-provided resource strings take precedence over the
  // legacy bytes-knob path. All four cloud callers pass strings; legacy
  // numeric `memoryLimit` is kept only as a fallback for any future caller
  // that hasn't been migrated.
  const memoryLimit =
    config.memoryLimitStr ?? (config.memoryLimit ? `${Math.ceil(config.memoryLimit / (1024 * 1024 * 1024))}Gi` : '4Gi');
  const memoryRequest =
    config.memoryRequest ??
    (config.memoryLimit ? `${Math.ceil(config.memoryLimit / (1024 * 1024 * 1024) / 2)}Gi` : '2Gi');
  const cpuRequest = config.cpuRequest ?? '250m';
  const cpuLimit = config.cpuLimit ?? '2000m';

  // 2026-06-06 — Per-agent PVC REMOVED (was Cleanup-3, 2026-05-25). `~/.prismer`
  // is now an ephemeral emptyDir (see `volumes` below). The PVC never actually
  // protected anything: daemon_id is injected via the PRISMER_DAEMON_ID env and
  // the entrypoint REWRITES config.toml from that env on every boot
  // (daemon-entrypoint.sh:102), so the persisted config.toml was always
  // overwritten. Everything else under ~/.prismer is cloud-recoverable — local.db
  // is a rebuildable cache (re-synced on `host.acked`), in-flight tasks resume
  // from cloud (`/api/im/tasks/in-flight?daemonId=`), task artifacts upload via
  // the outbox/artifacts-watcher. The 64Mi cap was also nonsense because the
  // agent's task workdir (`~/.prismer/workspaces/.../tasks/.../{artifacts,scratch}`)
  // lives under this mount. DO NOT reintroduce a PVC here — daemon state belongs
  // in the cloud, not on a node disk. See docs/release202/11.
  //
  // emptyDir sizeLimit caps how much node ephemeral disk ONE agent pod may use
  // under ~/.prismer before the kubelet evicts it — protects the node from a
  // runaway agent without affecting scheduling. Tunable via the Nacos config
  // item `K8S_AGENT_SCRATCH_SIZE_LIMIT`, expressed in GiB. Default 20.
  //
  // IMPORTANT: a BARE number is interpreted as GiB (so Nacos `=20` → `20Gi`).
  // K8s parses a unitless quantity as BYTES, so passing the raw `20` would mean
  // a 20-BYTE volume → the pod is evicted the instant the daemon writes
  // anything. We normalise here. A value that already carries a unit
  // (`20Gi`/`50G`) is passed through as-is.
  const rawScratchLimit = process.env.K8S_AGENT_SCRATCH_SIZE_LIMIT?.trim();
  const scratchSizeLimit = !rawScratchLimit
    ? '20Gi'
    : /^\d+$/.test(rawScratchLimit)
      ? `${rawScratchLimit}Gi`
      : rawScratchLimit;

  const podBody = {
    metadata: {
      name: podName,
      namespace,
      labels: {
        app: 'prismer-agent',
        [AGENT_LABEL_KEY]: agentId,
        [MANAGED_LABEL]: 'true',
      },
    },
    spec: {
      containers: [
        {
          name: CONTAINER_NAME,
          image,
          imagePullPolicy: 'IfNotPresent',
          ports: [{ containerPort: DEFAULT_DAEMON_PORT, name: 'daemon' }],
          env: envVars,
          resources: {
            requests: { memory: memoryRequest, cpu: cpuRequest },
            limits: { memory: memoryLimit, cpu: cpuLimit },
          },
          readinessProbe: {
            httpGet: { path: '/healthz', port: DEFAULT_DAEMON_PORT },
            initialDelaySeconds: 5,
            periodSeconds: 5,
            timeoutSeconds: 3,
          },
          livenessProbe: {
            httpGet: { path: '/healthz', port: DEFAULT_DAEMON_PORT },
            initialDelaySeconds: 20,
            periodSeconds: 30,
            timeoutSeconds: 5,
          },
          // Ephemeral scratch for ~/.prismer (config.toml + daemon SQLite +
          // task workdir/artifacts/scratch). Not persisted — daemon state is
          // cloud-recoverable (see provisioning comment above).
          volumeMounts: [
            {
              name: 'prismer-cfg',
              mountPath: '/home/user/.prismer',
            },
          ],
        },
      ],
      // emptyDir (node-backed ephemeral), replacing the removed per-pod PVC.
      // sizeLimit (K8S_AGENT_SCRATCH_SIZE_LIMIT, default 20Gi) caps runaway task
      // scratch/artifacts so a busy agent can't fill the node's ephemeral
      // storage; artifacts are uploaded to cloud via the outbox before the pod
      // goes away.
      volumes: [
        {
          name: 'prismer-cfg',
          emptyDir: { sizeLimit: scratchSizeLimit },
        },
      ],
      restartPolicy: 'Always',
      // C-9 (08 §5.7) — pod spec ALWAYS carries imagePullSecrets so the
      // manifest is byte-isomorphic with EKS test/prod. dev-up.sh creates
      // an empty `regcred` secret in the sandbox namespace so the
      // reference resolves; local registry (localhost:5001) does not
      // require auth so the secret content is unused.
      imagePullSecrets: [{ name: getImagePullSecret() }],
      // C-10 (08 §5.7) — Linux + APP_ENV=local injects hostAliases so pods
      // can reach the host via `host.docker.internal`. macOS and prod/test
      // return undefined and the field is omitted entirely.
      ...((): { hostAliases?: Array<{ ip: string; hostnames: string[] }> } => {
        const hostAliases = buildSandboxHostAliases();
        return hostAliases ? { hostAliases } : {};
      })(),
      ...(process.env.K8S_AGENT_NODE_SELECTOR ? { nodeSelector: JSON.parse(process.env.K8S_AGENT_NODE_SELECTOR) } : {}),
      ...(process.env.K8S_AGENT_TOLERATIONS ? { tolerations: JSON.parse(process.env.K8S_AGENT_TOLERATIONS) } : {}),
    },
  };

  await emit('container_create', 'in_progress');
  try {
    await api.createNamespacedPod({ namespace, body: podBody });
    await emit('container_create', 'ok');
  } catch (err) {
    await emit('container_create', 'error', err instanceof Error ? err.message : String(err));
    throw new K8sSandboxError(
      'CONTAINER_START_FAILED',
      `Failed to create pod: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }

  let nodePort: number | undefined;
  try {
    const svcBody = {
      metadata: {
        name: serviceName,
        namespace,
        labels: {
          app: 'prismer-agent',
          [AGENT_LABEL_KEY]: agentId,
          [MANAGED_LABEL]: 'true',
        },
      },
      spec: {
        type: 'NodePort' as const,
        selector: { [AGENT_LABEL_KEY]: agentId },
        ports: [
          {
            port: DEFAULT_DAEMON_PORT,
            targetPort: DEFAULT_DAEMON_PORT,
            protocol: 'TCP' as const,
            name: 'daemon',
          },
        ],
      },
    };

    const svcResult = await api.createNamespacedService({ namespace, body: svcBody });
    const ports = (svcResult as { spec?: { ports?: Array<{ nodePort?: number }> } })?.spec?.ports;
    nodePort = ports?.[0]?.nodePort;
  } catch (err) {
    try {
      await api.deleteNamespacedPod({ name: podName, namespace });
    } catch {
      /* best effort */
    }
    throw new K8sSandboxError(
      'CONTAINER_START_FAILED',
      `Failed to create service: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }

  // waitForRunning is authoritative — if pod hits Running+Ready, the kubelet
  // readinessProbe at /healthz already succeeded from inside the cluster.
  // Cloud-side /healthz is a redundant sanity check; it ONLY works when cloud
  // runs in-cluster (kubelet pod IP reachable). For out-of-cluster cloud
  // (dev smoke, separate-VPC control plane), pod IP `10.244.x.x:7878` is
  // unroutable from the host network, and the probe would false-alarm.
  // Best-effort warn instead of fatal — preserves the "extra confidence"
  // signal for in-cluster cloud without breaking out-of-cluster callers.
  // B3 smoke (B-followup): if pod IS unhealthy post-create, the next
  // operational call (runCmd, daemonDispatch, etc.) surfaces it.
  await emit('container_running', 'in_progress');
  try {
    await waitForRunning(podName);
    await emit('container_running', 'ok');
  } catch (err) {
    await emit('container_running', 'error', err instanceof Error ? err.message : String(err));
    logger.warn(
      { podName, err: err instanceof Error ? err.message : String(err) },
      '[K8sSandbox] post-create waitForRunning failed',
    );
    throw err;
  }
  // Release 200 §5.4 (C-4 / D-8 closure) — /healthz probe always runs.
  // The legacy `KUBERNETES_SERVICE_HOST` gate is removed; out-of-cluster
  // callers fall back to a cluster-internal exec inside `probeHealthz`.
  await emit('daemon_healthy', 'in_progress');
  try {
    const resp = await probeHealthz(podName);

    // Graceful-degrade Ready judgment: pre-2.0.0 daemons that omit
    // `readyForDispatch` are treated as healthy when `status==='ok'`. New
    // daemons must also report `readyForDispatch===true`.
    const healthOk = resp.status === 'ok' && (resp.readyForDispatch === undefined || resp.readyForDispatch === true);

    if (!healthOk) {
      throw new K8sSandboxError(
        'HEALTHZ_FAILED',
        `daemon /healthz reports not-ready (status=${resp.status} readyForDispatch=${String(resp.readyForDispatch)})`,
        podName,
      );
    }

    // Warn-only daemonId validation (Release 200 §5.4 — baseline policy,
    // false-positives during rollout would be costly). v210 may upgrade
    // this to a hard error once all daemons report the cloud-minted id.
    if (config.expectedDaemonId && resp.daemonId && resp.daemonId !== config.expectedDaemonId) {
      logger.warn(
        { podName, expected: config.expectedDaemonId, actual: resp.daemonId },
        '[K8sSandbox] daemonId mismatch on /healthz (warn-only baseline)',
      );
    }

    await emit('daemon_healthy', 'ok');
    logger.info(
      {
        podName,
        daemonVersion: resp.daemonVersion ?? '(legacy)',
        readyForDispatch: resp.readyForDispatch ?? '(legacy)',
        adapterCount: resp.adapters?.length ?? 0,
      },
      '[K8sSandbox] /healthz ok',
    );
  } catch (err) {
    // /healthz failure is non-fatal at create-time — pod is Running+Ready
    // per kubelet, so the readiness probe (TCP-level) already cleared. The
    // higher-level handshake (this fn) may still hit transient routes
    // (gateway URL takes a beat to resolve, exec stream slow to open). The
    // first dispatch will resurface the failure structurally.
    await emit('daemon_healthy', 'ok');
    logger.warn(
      { podName, err: err instanceof Error ? err.message : String(err) },
      '[K8sSandbox] /healthz probe failed (kubelet readinessProbe was the authority)',
    );
  }

  const gatewayUrl = await resolveGatewayUrl(podName);
  void nodePort; // retained for future ContainerInfo extension
  return buildContainerInfo({ podName, status: 'running', gatewayUrl });
}

async function getContainer(podName: string): Promise<{ container: ContainerInfo } | null> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();

  let pod: { status?: { phase?: string } };
  try {
    pod = (await api.readNamespacedPod({ name: podName, namespace })) as typeof pod;
  } catch (err) {
    if (isMissingPod(err)) return null;
    throw new K8sSandboxError(
      'UNKNOWN_ERROR',
      `Failed to read pod: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }

  const status = mapPodPhaseToState(pod?.status?.phase);
  const gatewayUrl = await resolveGatewayUrl(podName);
  return { container: buildContainerInfo({ podName, status, gatewayUrl }) };
}

async function startContainer(podName: string): Promise<{ status: string }> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();

  try {
    const result = await api.readNamespacedPod({ name: podName, namespace });
    const pod = result as {
      status?: { phase?: string };
      metadata?: { labels?: Record<string, string> };
    };
    const phase = pod?.status?.phase;

    if (phase === 'Running') return { status: 'started' };

    if (phase === 'Pending') {
      logger.info({ podName }, '[K8sSandbox] Pod is Pending, waiting for Running');
      await waitForRunning(podName);
      return { status: 'started' };
    }

    if (phase === 'Succeeded' || phase === 'Failed') {
      const agentId = pod?.metadata?.labels?.[AGENT_LABEL_KEY];
      await api.deleteNamespacedPod({ name: podName, namespace });
      await new Promise((r) => setTimeout(r, 2000));
      if (agentId) {
        await createContainer(agentId, {});
      }
      return { status: 'started' };
    }

    return { status: 'pending' };
  } catch (err) {
    if (err instanceof K8sSandboxError) throw err;
    throw new K8sSandboxError('CONTAINER_NOT_FOUND', `Pod ${podName} not found`, podName);
  }
}

async function stopContainer(podName: string): Promise<{ status: string }> {
  logger.info({ podName: podName.slice(0, 16) }, '[K8sSandbox] stopContainer no-op (persistent mode)');
  return { status: 'stopped' };
}

async function removeContainer(podName: string, force = false): Promise<{ status: string }> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();

  try {
    await api.deleteNamespacedPod({
      name: podName,
      namespace,
      gracePeriodSeconds: force ? 0 : undefined,
    });
  } catch (err) {
    if (!isMissingPod(err)) {
      throw new K8sSandboxError(
        'CONTAINER_STOP_FAILED',
        `Failed to remove pod: ${err instanceof Error ? err.message : String(err)}`,
        podName,
        err instanceof Error ? err : undefined,
      );
    }
  }

  const serviceName = serviceNameForPod(podName);
  try {
    await api.deleteNamespacedService({ name: serviceName, namespace });
  } catch {
    // Service may not exist — fine.
  }

  // No PVC to clean up — `~/.prismer` is an ephemeral emptyDir that dies with
  // the pod (PVC removed 2026-06-06; see provisioning comment in createContainer).

  return { status: 'removed' };
}

// ============================================================
// Pod status verdict (reconciler)
// ============================================================

interface RawPod {
  status?: {
    phase?: string;
    podIP?: string;
    startTime?: string;
    reason?: string;
    message?: string;
    containerStatuses?: Array<{
      ready?: boolean;
      started?: boolean;
      state?: {
        waiting?: { reason?: string; message?: string };
        running?: { startedAt?: string };
        terminated?: { reason?: string; exitCode?: number; message?: string };
      };
    }>;
  };
}

async function podStatusVerdict(podName: string, namespaceOverride?: string): Promise<PodStatusVerdict> {
  let api: Awaited<ReturnType<typeof getCoreV1Api>>;
  let namespace: string;
  try {
    api = await getCoreV1Api();
    namespace = namespaceOverride ?? getK8sNamespace();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, '[K8sSandbox] pod-status: client init failed');
    return {
      podName,
      namespace: namespaceOverride ?? '',
      exists: false,
      phase: null,
      reason: null,
      message: null,
      containerStarted: false,
      podIP: null,
      startedAt: null,
      apiError: { code: 'CLIENT_INIT_FAILED', message },
    };
  }

  let pod: RawPod;
  try {
    pod = (await api.readNamespacedPod({ name: podName, namespace })) as RawPod;
  } catch (err) {
    const statusCode = (err as { statusCode?: number; code?: number })?.statusCode;
    const code = (err as { code?: number })?.code;
    const httpStatus = statusCode ?? code ?? 0;

    if (httpStatus === 404) {
      return {
        podName,
        namespace,
        exists: false,
        phase: null,
        reason: null,
        message: null,
        containerStarted: false,
        podIP: null,
        startedAt: null,
        apiError: null,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ podName, namespace, status: httpStatus, err: message }, '[K8sSandbox] pod-status: read failed');
    return {
      podName,
      namespace,
      exists: false,
      phase: null,
      reason: null,
      message: null,
      containerStarted: false,
      podIP: null,
      startedAt: null,
      apiError: { code: `HTTP_${httpStatus || 'UNKNOWN'}`, message },
    };
  }

  const status = pod.status ?? {};
  const phase = status.phase ?? null;
  const containerStatus = status.containerStatuses?.[0];
  const waiting = containerStatus?.state?.waiting;
  const terminated = containerStatus?.state?.terminated;
  const reason = terminated?.reason ?? waiting?.reason ?? status.reason ?? null;
  const message = terminated?.message ?? waiting?.message ?? status.message ?? null;

  return {
    podName,
    namespace,
    exists: true,
    phase,
    reason,
    message,
    containerStarted: containerStatus?.started ?? false,
    podIP: status.podIP ?? null,
    startedAt: status.startTime ?? null,
    apiError: null,
  };
}

// ============================================================
// Logs (raw text — SSE handled by route in B2)
// ============================================================

async function getContainerLogs(
  podName: string,
  options?: { tail?: number; since?: Date; timestamps?: boolean },
): Promise<string> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();

  try {
    const params: {
      name: string;
      namespace: string;
      container: string;
      tailLines?: number;
      sinceSeconds?: number;
      timestamps?: boolean;
    } = {
      name: podName,
      namespace,
      container: CONTAINER_NAME,
    };

    if (options?.tail) params.tailLines = options.tail;
    if (options?.timestamps) params.timestamps = true;
    if (options?.since) {
      const sinceSeconds = Math.floor((Date.now() - options.since.getTime()) / 1000);
      if (sinceSeconds > 0) params.sinceSeconds = sinceSeconds;
    }

    const result = await api.readNamespacedPodLog(params);
    return typeof result === 'string' ? result : String(result);
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 404) {
      throw new K8sSandboxError('CONTAINER_NOT_FOUND', `Pod ${podName} not found`, podName);
    }
    return '';
  }
}

// ============================================================
// runCmd (kubectl exec)
// ============================================================

async function runCmd(podName: string, args: RunCmdArgs): Promise<RunCmdResult> {
  const k8sExec = await getK8sExec();
  const namespace = getK8sNamespace();

  // TODO(§26 B-followup): timeoutMs not propagated to underlying call — the
  // `@kubernetes/client-node` Exec signature doesn't expose a timeout. The
  // controller had the same gap. Plumb via AbortController on the underlying
  // ws once upstream adds support.
  void args.timeoutMs;

  return new Promise<RunCmdResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.end();

    stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const runPromise = k8sExec.exec(
      namespace,
      podName,
      CONTAINER_NAME,
      args.command,
      stdout,
      stderr,
      stdin,
      false, // tty
      (status: any) => {
        const stdoutStr = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderrStr = Buffer.concat(stderrChunks).toString('utf-8');

        // TODO(§26 B-followup): exitCode parsing from status.details.causes[].
        // The K8s exec subprotocol returns the real exit code in
        // `status.details.causes` when status='Failure' with reason
        // 'NonZeroExitCode'. The controller never extracted this; we
        // preserve the bug here for behavioral parity. Today:
        //   - status='Success' → exitCode=0 (truthful)
        //   - command failed   → resolve with stderr + exitCode=1 (lossy)
        //   - infra error      → reject with K8sSandboxError (loud)
        if ((status as { status?: string })?.status === 'Success') {
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 });
          return;
        }

        const message = (status as { message?: string })?.message ?? stderrStr ?? 'exec failed';
        resolve({ stdout: stdoutStr, stderr: stderrStr || message, exitCode: 1 });
      },
    );

    runPromise.catch((err: unknown) => {
      reject(
        new K8sSandboxError(
          'UNKNOWN_ERROR',
          `exec failed: ${err instanceof Error ? err.message : String(err)}`,
          podName,
          err instanceof Error ? err : undefined,
        ),
      );
    });
  });
}

// ============================================================
// Daemon RPC proxies (daemonDispatch / installAgent)
// ============================================================

async function daemonDispatch(podName: string, payload: DaemonDispatchArgs): Promise<DaemonDispatchResult> {
  // Mirror installAgent: try direct podIp HTTP first, fall back to
  // cluster-internal exec for out-of-cluster cloud (local dev).
  const podIp = await getContainerIp(podName);

  if (podIp) {
    const daemonUrl = `http://${podIp}:${DEFAULT_DAEMON_PORT}/v1/runs`;
    try {
      const res = await fetch(daemonUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      if (!res.ok) {
        logger.warn({ podName, status: res.status, payload: parsed }, '[K8sSandbox] daemon rejected dispatch');
        throw new K8sSandboxError(
          'DAEMON_UNREACHABLE',
          `daemon returned HTTP ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
          podName,
        );
      }
      return parsed as DaemonDispatchResult;
    } catch (err) {
      if (err instanceof K8sSandboxError) throw err;
      logger.warn(
        { podName, httpError: err instanceof Error ? err.message : String(err) },
        '[K8sSandbox] daemonDispatch HTTP RPC failed, falling back to cluster-internal exec',
      );
    }
  }

  try {
    const parsed = (await daemonRpcViaExec(podName, '/v1/runs', payload)) as DaemonDispatchResult;
    return parsed;
  } catch (err) {
    if (err instanceof K8sSandboxError) throw err;
    throw new K8sSandboxError(
      'DAEMON_UNREACHABLE',
      `daemon dispatch RPC unreachable (both HTTP and exec): ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
}

async function installAgent(podName: string, payload: InstallAgentArgs): Promise<InstallAgentResult> {
  // Try direct podIp HTTP first — works when cloud runs in-cluster
  // (production EKS); falls back to cluster-internal exec when cloud is
  // out-of-cluster (local dev: kind 10.244.0.0/16 unreachable from host).
  // Same dual-path pattern as probeHealthz (08 §5.4).
  const podIp = await getContainerIp(podName);

  if (podIp) {
    const daemonUrl = `http://${podIp}:${DEFAULT_DAEMON_PORT}/v1/agents/install`;
    try {
      const res = await fetch(daemonUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      if (!res.ok) {
        logger.warn({ podName, status: res.status, payload: parsed }, '[K8sSandbox] daemon rejected installAgent');
        throw new K8sSandboxError(
          'DAEMON_UNREACHABLE',
          `daemon installAgent returned HTTP ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
          podName,
        );
      }
      return parsed as InstallAgentResult;
    } catch (err) {
      // HTTP-status errors above are K8sSandboxError already and re-thrown
      // straight to caller (no fallback for "daemon rejected"). Only fall
      // back on connection-level failure (fetch threw — DNS/timeout/refused).
      if (err instanceof K8sSandboxError) throw err;
      logger.warn(
        { podName, httpError: err instanceof Error ? err.message : String(err) },
        '[K8sSandbox] installAgent HTTP RPC failed, falling back to cluster-internal exec',
      );
    }
  }

  // Out-of-cluster fallback: exec curl POST inside the pod, body via stdin.
  try {
    const parsed = (await daemonRpcViaExec(podName, '/v1/agents/install', payload)) as InstallAgentResult;
    return parsed;
  } catch (err) {
    if (err instanceof K8sSandboxError) throw err;
    throw new K8sSandboxError(
      'DAEMON_UNREACHABLE',
      `daemon installAgent RPC unreachable (both HTTP and exec): ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
}

async function dumpAgentState(podName: string, agentId: string): Promise<AgentStateDumpResult> {
  logger.info({ podName, agentId }, '[K8sSandbox] Starting agent dump-state via daemon');

  const path = `/v1/agents/${encodeURIComponent(agentId)}/dump-state`;
  const httpResult = await dumpAgentStateViaHttp(podName, path);
  if (httpResult.ok) return httpResult.body;

  logger.warn(
    { podName, agentId, httpError: httpResult.reason },
    '[K8sSandbox] agent dump-state HTTP path failed, falling back to cluster-internal exec',
  );

  try {
    return normalizeAgentStateDump(await daemonRpcViaExec(podName, path, {}));
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      throw new K8sSandboxError(
        'SNAPSHOT_FAILED',
        `agent dump-state failed: ${err.body || err.message}`,
        podName,
        err,
      );
    }
    throw new K8sSandboxError(
      'SNAPSHOT_FAILED',
      `agent dump-state failed: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
}

async function dumpAgentStateViaHttp(
  podName: string,
  path: string,
): Promise<{ ok: true; body: AgentStateDumpResult } | { ok: false; reason: string }> {
  const gatewayUrl = await resolveGatewayUrl(podName);
  if (!gatewayUrl) {
    return { ok: false, reason: 'no gateway URL resolvable' };
  }
  const endpoint = gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:') + path;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, reason: `${path} returned HTTP ${res.status}: ${text.slice(0, 256)}` };
    }
    try {
      return { ok: true, body: normalizeAgentStateDump(JSON.parse(text)) };
    } catch (parseErr) {
      return {
        ok: false,
        reason: `${path} body not JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `${path} HTTP fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function normalizeAgentStateDump(value: unknown): AgentStateDumpResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent dump-state body must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.agentId !== 'string' || !record.agentId) {
    throw new Error('agent dump-state body missing agentId');
  }
  if (!Array.isArray(record.files) || !Array.isArray(record.roots)) {
    throw new Error('agent dump-state body missing roots/files');
  }
  return record as unknown as AgentStateDumpResult;
}

// ============================================================
// Snapshot (Kaniko Job)
// ============================================================

async function snapshot(podName: string, opts: SnapshotArgs = {}): Promise<{ snapshot: SnapshotResult }> {
  const repo = opts.repo ?? podName;
  const tag = opts.tag ?? new Date().toISOString().replace(/[:.]/g, '-');
  const comment = opts.comment;

  const k8s = await getK8sSdk();
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();
  const fullTag = `${repo}:${tag}`;
  const jobName = `snapshot-${podName.replace(POD_NAME_PREFIX, '')}-${Date.now()}`.slice(0, 63);
  const configMapName = `${jobName}-dockerfile`;

  logger.info({ podName, fullTag, comment }, '[K8sSandbox] Starting K8s snapshot');

  try {
    const tarResult = await runCmd(podName, {
      command: ['tar', 'czf', '/tmp/snapshot.tar.gz', '/workspace', '/home/user/.openclaw/'],
    });
    if (tarResult.exitCode !== 0) {
      throw new K8sSandboxError('SNAPSHOT_FAILED', `tar failed: ${tarResult.stderr || 'unknown error'}`, podName);
    }

    const pod = (await api.readNamespacedPod({ name: podName, namespace })) as {
      spec?: { containers?: Array<{ image?: string }> };
    };
    const baseImage = pod?.spec?.containers?.[0]?.image || resolveDefaultImage();

    const dockerfile = [
      `FROM ${baseImage}`,
      `# Snapshot: ${comment || fullTag}`,
      'COPY workspace/ /workspace/',
      'COPY openclaw/ /home/user/.openclaw/',
    ].join('\n');

    await api.createNamespacedConfigMap({
      namespace,
      body: {
        metadata: { name: configMapName, namespace },
        data: { Dockerfile: dockerfile },
      },
    });

    // TODO(§26 B-followup): kubectl cp tar.gz into Kaniko build context —
    // currently dead code. The initContainer below "echo"s a placeholder and
    // exits; the Kaniko build context is therefore empty and the resulting
    // image is identical to baseImage. Snapshot is a no-op end-to-end. The
    // port preserves this behavior because the cloud has no callers that
    // expect a populated snapshot today.
    const jobBody = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: jobName, namespace },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 300,
        template: {
          spec: {
            restartPolicy: 'Never',
            initContainers: [
              {
                name: 'copy-data',
                image: 'busybox:latest',
                command: [
                  'sh',
                  '-c',
                  [
                    'mkdir -p /build/workspace /build/openclaw',
                    '# Data will be copied by kubectl cp before job runs',
                    'echo "Build context ready"',
                  ].join(' && '),
                ],
                volumeMounts: [{ name: 'build-context', mountPath: '/build' }],
              },
            ],
            containers: [
              {
                name: 'kaniko',
                image: process.env.KANIKO_IMAGE || 'gcr.io/kaniko-project/executor:latest',
                args: [
                  '--dockerfile=/kaniko/Dockerfile',
                  `--destination=${fullTag}`,
                  '--context=/build',
                  '--cache=false',
                  '--single-snapshot',
                ],
                volumeMounts: [
                  { name: 'build-context', mountPath: '/build' },
                  { name: 'dockerfile', mountPath: '/kaniko', readOnly: true },
                  { name: 'docker-config', mountPath: '/kaniko/.docker', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'build-context', emptyDir: { sizeLimit: '10Gi' } },
              { name: 'dockerfile', configMap: { name: configMapName } },
              {
                name: 'docker-config',
                secret: {
                  secretName: 'prismer-registry',
                  items: [{ key: '.dockerconfigjson', path: 'config.json' }],
                },
              },
            ],
            imagePullSecrets: [{ name: getImagePullSecret() }],
          },
        },
      },
    };

    const kc = await getKubeConfig();
    const objApi = k8s.KubernetesObjectApi.makeApiClient(kc);
    await objApi.create(jobBody);
    logger.info({ jobName }, '[K8sSandbox] Kaniko Job created');

    const timeout = 300_000;
    const start = Date.now();
    const imageId = fullTag; // Kaniko doesn't easily expose digest; fallback to tag.

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const job = (await objApi.read({
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name: jobName, namespace },
        })) as {
          status?: { succeeded?: number; failed?: number };
        };

        if (job?.status?.succeeded && job.status.succeeded > 0) {
          logger.info({ jobName }, '[K8sSandbox] Kaniko Job succeeded');
          break;
        }
        if (job?.status?.failed && job.status.failed > 0) {
          throw new K8sSandboxError('SNAPSHOT_FAILED', `Kaniko Job failed for ${fullTag}`, podName);
        }
      } catch (err) {
        if (err instanceof K8sSandboxError) throw err;
        // Poll error → continue.
      }
    }

    if (Date.now() - start >= timeout) {
      throw new K8sSandboxError('SNAPSHOT_FAILED', `Kaniko Job timed out after ${timeout / 1000}s`, podName);
    }

    try {
      await objApi.delete(
        { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: jobName, namespace } },
        undefined,
        undefined,
        undefined,
        undefined,
        'Background',
      );
      await api.deleteNamespacedConfigMap({ name: configMapName, namespace });
    } catch {
      logger.warn({ jobName, configMapName }, '[K8sSandbox] Snapshot cleanup failed');
    }

    return { snapshot: { imageTag: fullTag, imageDigest: imageId } };
  } catch (err) {
    try {
      await api.deleteNamespacedConfigMap({ name: configMapName, namespace }).catch(() => {});
    } catch {
      /* ignore */
    }

    if (err instanceof K8sSandboxError) throw err;
    throw new K8sSandboxError(
      'SNAPSHOT_FAILED',
      `K8s snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
}

// ============================================================
// Snapshot (daemon-first fs-manifest — T9)
// ============================================================

/**
 * Release 200 T9 — fs-manifest snapshot via the in-pod daemon.
 *
 * Resolution strategy mirrors `probeHealthz` (HTTP first → cluster-internal
 * `exec curl` fallback). The daemon walks `snapshotRoot` (default
 * `/workspace`), hashes every file, and returns
 * `{ rootPath, files: [{path, sha256, sizeBytes, mtime}] }`. The cloud
 * computes `count` / `totalBytes` / `generatedAt` and persists the row in
 * the route layer.
 *
 * Failure surfaces as `K8sSandboxError('SNAPSHOT_FAILED', ...)` which the
 * provider boundary translates to `ProviderError('snapshot_failed')`.
 *
 * The request body is intentionally NOT forwarded today — the daemon
 * (sdk/prismer-cloud/runtime/src/daemon/local-server.ts) currently
 * ignores includeGlobs/excludeGlobs/root and always walks
 * `opts.snapshotRoot ?? '/workspace'`. The contract accepts those fields
 * (08 §4.4 SnapshotRequest) as advisory; future daemon versions will honour
 * them. Cloud passes `{}` so the daemon's defaults apply.
 */
interface DaemonManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  mtime?: number;
}

interface DaemonSnapshotBody {
  rootPath: string;
  files: DaemonManifestEntry[];
}

const SNAPSHOT_HTTP_TIMEOUT_MS = 30_000;
const SNAPSHOT_EXEC_TIMEOUT_MS = 60_000;

// 24-char alphanumeric id fits within the varchar(30) column on
// IMContainerSnapshot. Mirrors `resource-sample.ts::generateSampleId` (S6/T5).
const SNAPSHOT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generateSnapshotId(): string {
  const bytes = randomBytes(24);
  let id = '';
  for (let i = 0; i < 24; i++) id += SNAPSHOT_ID_ALPHABET[bytes[i] % SNAPSHOT_ID_ALPHABET.length];
  return id;
}

export interface FsManifestSnapshotResult {
  snapshotId: string;
  rootPath: string;
  files: DaemonManifestEntry[];
  count: number;
  totalBytes: number;
  generatedAt: string;
}

async function snapshotFsManifest(podName: string): Promise<FsManifestSnapshotResult> {
  logger.info({ podName }, '[K8sSandbox] Starting fs-manifest snapshot via daemon /v1/snapshot');

  const httpResult = await snapshotViaHttp(podName);
  let body: DaemonSnapshotBody;
  if (httpResult.ok) {
    body = httpResult.body;
  } else {
    logger.warn(
      { podName, httpError: httpResult.reason },
      '[K8sSandbox] /v1/snapshot HTTP path failed, falling back to cluster-internal exec',
    );
    body = await snapshotViaExec(podName);
  }

  const totalBytes = body.files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  return {
    snapshotId: generateSnapshotId(),
    rootPath: body.rootPath,
    files: body.files,
    count: body.files.length,
    totalBytes,
    generatedAt: new Date().toISOString(),
  };
}

async function snapshotViaHttp(
  podName: string,
): Promise<{ ok: true; body: DaemonSnapshotBody } | { ok: false; reason: string }> {
  const gatewayUrl = await resolveGatewayUrl(podName);
  if (!gatewayUrl) {
    return { ok: false, reason: 'no gateway URL resolvable' };
  }
  const snapshotUrl = gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:') + '/v1/snapshot';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SNAPSHOT_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(snapshotUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `/v1/snapshot returned HTTP ${res.status}` };
    }
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as DaemonSnapshotBody;
      if (!parsed || !Array.isArray(parsed.files) || typeof parsed.rootPath !== 'string') {
        return { ok: false, reason: '/v1/snapshot body missing rootPath/files' };
      }
      return { ok: true, body: parsed };
    } catch (parseErr) {
      return {
        ok: false,
        reason: `/v1/snapshot body not JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `/v1/snapshot HTTP fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Cluster-internal `/v1/snapshot` POST via the K8s exec API (same pattern as
 * `probeHealthzViaExec`). Reads the JSON body off stdout — manifest output is
 * typically KB-scale for a fresh container so single-stdout-buffer works in
 * v200. Larger workspaces in v210 will need a tmp-file + cat path.
 *
 * Throws `K8sSandboxError('SNAPSHOT_FAILED')` on any failure (exec API
 * rejection, non-zero curl exit, JSON parse failure, timeout).
 */
async function snapshotViaExec(podName: string): Promise<DaemonSnapshotBody> {
  let k8sExec: Awaited<ReturnType<typeof getK8sExec>>;
  try {
    k8sExec = await getK8sExec();
  } catch (err) {
    throw new K8sSandboxError(
      'SNAPSHOT_FAILED',
      `exec client init failed: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }
  const namespace = getK8sNamespace();

  // -s silent; -X POST; --max-time bounds curl-side; --data '{}' is the
  // explicit empty body the daemon accepts. Outer Promise.race adds a JS-side
  // hard cap in case the exec stream itself stalls.
  const command = [
    'curl',
    '-s',
    '-X',
    'POST',
    '--max-time',
    '30',
    '-H',
    'content-type: application/json',
    '--data',
    '{}',
    `http://127.0.0.1:${SANDBOX_DAEMON_PORT}/v1/snapshot`,
  ];

  return new Promise<DaemonSnapshotBody>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.end();

    stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const settleReject = (reason: K8sSandboxError) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };
    const settleResolve = (value: DaemonSnapshotBody) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const hardTimeout = setTimeout(() => {
      settleReject(
        new K8sSandboxError(
          'SNAPSHOT_FAILED',
          `exec /v1/snapshot probe timed out after ${SNAPSHOT_EXEC_TIMEOUT_MS}ms`,
          podName,
        ),
      );
    }, SNAPSHOT_EXEC_TIMEOUT_MS);

    const runPromise = k8sExec.exec(
      namespace,
      podName,
      CONTAINER_NAME,
      command,
      stdout,
      stderr,
      stdin,
      false, // tty
      (status) => {
        clearTimeout(hardTimeout);
        const stdoutStr = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        const stderrStr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const statusOk = (status as { status?: string })?.status === 'Success';

        if (!statusOk) {
          const msg = (status as { message?: string })?.message ?? stderrStr ?? 'exec failed';
          settleReject(
            new K8sSandboxError('SNAPSHOT_FAILED', `exec /v1/snapshot curl exited non-zero: ${msg}`, podName),
          );
          return;
        }

        if (!stdoutStr) {
          settleReject(
            new K8sSandboxError(
              'SNAPSHOT_FAILED',
              `exec /v1/snapshot returned empty stdout (stderr=${stderrStr || 'empty'})`,
              podName,
            ),
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdoutStr) as DaemonSnapshotBody;
          if (!parsed || !Array.isArray(parsed.files) || typeof parsed.rootPath !== 'string') {
            settleReject(
              new K8sSandboxError('SNAPSHOT_FAILED', 'exec /v1/snapshot body missing rootPath/files', podName),
            );
            return;
          }
          settleResolve(parsed);
        } catch (err) {
          settleReject(
            new K8sSandboxError(
              'SNAPSHOT_FAILED',
              `exec /v1/snapshot stdout not JSON: ${err instanceof Error ? err.message : String(err)}`,
              podName,
              err instanceof Error ? err : undefined,
            ),
          );
        }
      },
    );

    runPromise.catch((err: unknown) => {
      clearTimeout(hardTimeout);
      settleReject(
        new K8sSandboxError(
          'SNAPSHOT_FAILED',
          `exec /v1/snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
          podName,
          err instanceof Error ? err : undefined,
        ),
      );
    });
  });
}

// ============================================================
// provisionContainer — scoped-key wrapper for createContainer
// ============================================================

/**
 * Cloud-side container provisioning entry point used by all task-dispatch and
 * runtime-installation routes (§26 B4 — sole entry point; the legacy HTTP
 * controller path was removed).
 *
 * Accepts `{workspaceId, tenantId, agentImUserId, taskId, apiKeyTtlSeconds,
 * image, environment, cpu*, memory*}`. Behavior:
 *   1. When `apiKeyTtlSeconds` + `taskId` + `workspaceId` are all set, mint a
 *      workspace-scoped, short-lived API key (createApiKey + label metadata,
 *      same logic the former /api/sandboxes/internal/issue-key route used —
 *      now inlined since we're already in the cloud process and there is no
 *      controller HTTP round-trip).
 *   2. Inject PRISMER_API_KEY + companion env vars (PRISMER_API_KEY_EXPIRES_AT,
 *      PRISMER_API_KEY_ID, PRISMER_TASK_ID, PRISMER_CONTAINER_ID,
 *      PRISMER_CLOUD_URL, CLOUD_API_BASE) on top of caller-supplied env.
 *   3. Create the pod via `k8sSandbox.createContainer(agentId, config)`.
 *
 * When `apiKeyTtlSeconds === undefined` (or `taskId === undefined`) the
 * scoped-key mint is skipped — this is the runtime-installation path
 * (long-lived host daemon with a durable runtime credential minted by the
 * caller, not a per-task ephemeral key).
 */
export interface ProvisionContainerArgs {
  workspaceId: string;
  tenantId: string;
  controllerAgentId?: string;
  agentImUserId?: string;
  taskId?: string;
  image?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  environment?: Record<string, string>;
  apiKeyTtlSeconds?: number;
  /**
   * Release 200 §5.4 — pre-minted daemonId. When set, used as the cloud-side
   * source-of-truth for `IMContainer.daemonId` and injected into the pod as
   * `PRISMER_DAEMON_ID`. When omitted, `provisionContainer` mints one
   * (`crypto.randomUUID()`) and surfaces it on the returned ContainerInfo so
   * the caller can persist it.
   */
  daemonId?: string;
  /**
   * Optional progress callback — invoked at each lifecycle transition
   * (container_create / container_running / daemon_healthy) with
   * status 'in_progress' on entry, 'ok' on success, or 'error' on
   * failure. Best-effort: callbacks that throw must not abort
   * provisioning. Caller binds this to `emitterForRow(rowId)` from
   * `src/lib/provisioning-progress.ts` to persist progress.
   */
  onStep?: (
    step: 'container_create' | 'container_running' | 'daemon_healthy',
    status: 'in_progress' | 'ok' | 'error',
    error?: string,
  ) => void | Promise<void>;
}

/**
 * Release 200 §5.4 — wider ContainerInfo returned from `provisionContainer`.
 *
 * Adds `daemonId` so the caller (route handler) can persist it on the
 * IMContainer row alongside the other provisioning metadata.
 * Compatible with the legacy `ContainerInfo` shape — `daemonId` is the
 * only added field.
 */
export interface ProvisionedContainer extends ContainerInfo {
  /** v200 — cloud-minted daemon identifier (UUID v4). */
  daemonId: string;
}

async function provisionContainer(args: ProvisionContainerArgs): Promise<{ container: ProvisionedContainer }> {
  // I-2 (post-review fix): bounds-validate apiKeyTtlSeconds. Legacy path
  // bounced through `/api/sandboxes/internal/issue-key` (zod gate
  // min(60).max(7200) at src/app/api/sandboxes/internal/issue-key/route.ts:46).
  // Direct-mint path bypasses that zod schema — re-assert the bound here so
  // misconfigured callers (e.g. task.service.ts:2428 with extreme timeoutMs)
  // can't silently mint a malformed-TTL key.
  if (args.apiKeyTtlSeconds !== undefined && (args.apiKeyTtlSeconds < 60 || args.apiKeyTtlSeconds > 7200)) {
    throw new K8sSandboxError(
      'UNKNOWN_ERROR',
      `apiKeyTtlSeconds out of allowed range [60, 7200]: ${args.apiKeyTtlSeconds}`,
    );
  }

  // Release 200 §5.4 (D-7 closure) — daemonId is owned by the cloud. Mint it
  // here (or accept a caller-supplied one) BEFORE pod creation so it can be
  // injected via `PRISMER_DAEMON_ID` env and persisted on `IMContainer`. The
  // daemon's entrypoint reads this env into config.daemon_id; the daemon
  // never generates one locally.
  const daemonId = args.daemonId ?? randomUUID();

  // Caller-supplied env wins for non-PRISMER_API_KEY* fields; the freshly-
  // minted key + cloud URL always win (ported from the deleted controller's
  // create-container path).
  const scopedEnv: Record<string, string> = {
    PRISMER_DAEMON_ID: daemonId,
  };

  // I-1 (post-review fix): unconditionally inject CLOUD_API_BASE regardless of
  // scoped-key block. Controller does this at containers.ts:153-158 outside the
  // scoped-key block so warm-pool reuse + non-tasked dispatches also get a cloud
  // endpoint. daemon-first arch (docs/54release/13:106) treats CLOUD_API_BASE as
  // a daemon-side trust-boundary fallback env.
  const cloudApiBase = process.env.PRISMER_HOST_URL ?? process.env.CLOUD_URL;
  if (cloudApiBase) scopedEnv.CLOUD_API_BASE = cloudApiBase;
  if (process.env.DISPATCH_DAEMON_SECRET?.trim()) {
    scopedEnv.DISPATCH_DAEMON_SECRET = process.env.DISPATCH_DAEMON_SECRET.trim();
  }

  // Always-inject when caller supplied workspaceId / tenantId (matches the
  // controller's "always-inject independent of scoped-key block" branch).
  if (args.workspaceId) scopedEnv.PRISMER_WORKSPACE_ID = args.workspaceId;
  if (args.tenantId) scopedEnv.PRISMER_USER_ID = args.tenantId;

  // Scoped API key minting — only when caller asks (apiKeyTtlSeconds + taskId).
  // The controller required workspaceId + tenantId at this branch; mirror the
  // 400 here as an internal Error (cloud caller should have validated).
  if (args.apiKeyTtlSeconds && args.taskId) {
    if (!args.workspaceId || !args.tenantId) {
      throw new K8sSandboxError('UNKNOWN_ERROR', 'apiKeyTtlSeconds requires workspaceId + tenantId + taskId');
    }

    // Defense-in-depth — same check the issue-key route does. Confirms the
    // workspace exists and is owned by the tenant. Surfaces stolen-id misuse.
    const ws = (await prisma.iMWorkspace.findFirst({
      where: { id: args.workspaceId, ownerImUserId: args.tenantId, deletedAt: null },
      select: { id: true },
    })) as { id: string } | null;
    if (!ws) {
      throw new K8sSandboxError(
        'UNKNOWN_ERROR',
        `provision: workspace ${args.workspaceId} not found or not owned by ${args.tenantId}`,
      );
    }

    // Resolve IM user → pc_users.id (BIGINT). IMUser.userId is the linked
    // cloud-user id as a string; copies the issue-key resolution exactly.
    const imUser = (await prisma.iMUser.findUnique({
      where: { id: args.tenantId },
      select: { userId: true },
    })) as { userId: string | null } | null;
    if (!imUser?.userId) {
      throw new K8sSandboxError('UNKNOWN_ERROR', `provision: IM user ${args.tenantId} not linked to a cloud user`);
    }
    const cloudUserId = Number(imUser.userId);
    if (!Number.isFinite(cloudUserId) || cloudUserId <= 0) {
      throw new K8sSandboxError('UNKNOWN_ERROR', `provision: IMUser.userId is not a valid numeric pc_users.id`);
    }

    // Generate a stable containerId BEFORE pod creation so the issued key
    // label can reference it (audit correlation only — pc_api_keys has no
    // metadata column yet). Matches the controller's pattern.
    const containerId = `direct-${args.taskId}-${Date.now().toString(36)}`;
    const expiresAt = new Date(Date.now() + args.apiKeyTtlSeconds * 1000);
    const labelMeta = JSON.stringify({
      kind: 'sandbox-scoped',
      workspaceId: ws.id,
      taskId: args.taskId,
      containerId,
      expiresAt: expiresAt.toISOString(),
    });
    const label = `sandbox:${args.taskId.slice(0, 8)} ${labelMeta}`.slice(0, 250);

    let issued: Awaited<ReturnType<typeof createApiKey>>;
    try {
      issued = await createApiKey(cloudUserId, label);
    } catch (err) {
      throw new K8sSandboxError(
        'UNKNOWN_ERROR',
        `provision: scoped key mint failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err instanceof Error ? err : undefined,
      );
    }

    scopedEnv.PRISMER_API_KEY = issued.key;
    scopedEnv.PRISMER_API_KEY_EXPIRES_AT = expiresAt.toISOString();
    scopedEnv.PRISMER_API_KEY_ID = String(issued.id);
    scopedEnv.PRISMER_TASK_ID = args.taskId;
    scopedEnv.PRISMER_CONTAINER_ID = containerId;
    scopedEnv.PRISMER_CLOUD_URL =
      process.env.PRISMER_HOST_URL ?? process.env.CLOUD_URL ?? 'http://host.docker.internal:3000';

    logger.info(
      {
        apiKeyId: issued.id,
        workspaceId: ws.id,
        taskId: args.taskId,
        containerId,
        expiresAt: expiresAt.toISOString(),
      },
      '[K8sSandbox] provisioned sandbox-scoped api key (in-process)',
    );
  }

  // Merge: caller env first, then scopedEnv (so freshly-minted key wins
  // over any leftover PRISMER_API_KEY the caller may have set).
  const mergedEnv: Record<string, string> = {
    ...(args.environment ?? {}),
    ...scopedEnv,
  };

  // Pod naming follows controllerAgentId → agentImUserId → tenantId — preserved
  // from the controller's pre-B4 derivation so older rows whose podName was
  // computed from this exact fallback chain still resolve to the same pod
  // when a workspace caller threads a distinct controllerAgentId.
  const agentId = args.controllerAgentId ?? args.agentImUserId ?? args.tenantId;

  const container = await createContainer(agentId, {
    image: args.image,
    environment: mergedEnv,
    cpuRequest: args.cpuRequest,
    cpuLimit: args.cpuLimit,
    memoryRequest: args.memoryRequest,
    memoryLimitStr: args.memoryLimit,
    onStep: args.onStep,
    expectedDaemonId: daemonId,
  });

  return { container: { ...container, daemonId } };
}

// ============================================================
// Public singleton
// ============================================================

/**
 * Cloud-side K8s sandbox surface. §26 B4 — sole entry point for cloud → K8s
 * orchestration (the HTTP controller path was removed).
 *
 * Method coverage (11 methods, audit-confirmed in
 * `docs/54release/sessions/26-B0-audit.md`):
 *   - createContainer
 *   - getContainer
 *   - startContainer
 *   - stopContainer
 *   - removeContainer
 *   - runCmd
 *   - daemonDispatch
 *   - installAgent
 *   - dumpAgentState
 *   - snapshot
 *   - podStatusVerdict           (reconciler verdict, formerly k8sPodStatus)
 *   - getContainerLogs           (raw text; SSE framing lives in /logs route)
 *   - provisionContainer         (scoped-key wrapper for task-dispatch path)
 */
export const k8sSandbox = {
  createContainer,
  /**
   * Scoped-key wrapper around createContainer for the task-dispatch path.
   * Accepts {workspaceId, tenantId, agentImUserId, taskId, apiKeyTtlSeconds,
   * image, environment, cpu / memory resource strings}; mints + injects the
   * per-task scoped key when taskId + apiKeyTtlSeconds are set.
   */
  provisionContainer,
  getContainer,
  startContainer,
  stopContainer,
  removeContainer,
  runCmd,
  daemonDispatch,
  installAgent,
  dumpAgentState,
  snapshot,
  /**
   * Release 200 T9 — daemon-first fs-manifest snapshot. HTTP-first against
   * the gatewayUrl `/v1/snapshot`, falls back to cluster-internal `exec curl`
   * when the gateway is unreachable (e.g. kind dev w/o extraPortMappings).
   * Throws `K8sSandboxError('SNAPSHOT_FAILED')` on terminal failure.
   */
  snapshotFsManifest,
  podStatusVerdict,
  getContainerLogs,
  /**
   * Release 200 §5.4 — daemon /healthz probe (HTTP first → cluster-internal
   * exec fallback). Throws `K8sSandboxError('HEALTHZ_FAILED')` only when
   * both transports fail. Callers downstream of `K8sSandboxProvider` see
   * `ProviderError('daemon_unreachable')`.
   */
  probeHealthz,
};

export type K8sSandbox = typeof k8sSandbox;

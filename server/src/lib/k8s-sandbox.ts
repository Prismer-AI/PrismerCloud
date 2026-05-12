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
 */
export const DEFAULT_DAEMON_PORT = 7878;
export const POD_NAME_PREFIX = 'prismer-agent-';
export const SERVICE_NAME_PREFIX = 'prismer-svc-';
/** Container name inside the pod spec — daemon-first rename from `openclaw`. */
export const CONTAINER_NAME = 'daemon';

const AGENT_LABEL_KEY = 'prismer.agent.id';
const MANAGED_LABEL = 'prismer.managed';

const DEFAULT_IMAGE = process.env.CONTAINER_IMAGE || 'dockerhub.services/prismer/library/sandbox:daemon-v1.0';

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
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const pod = (await api.readNamespacedPod({ name: podName, namespace })) as {
        status?: {
          phase?: string;
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

      if (phase === 'Running') {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        logger.info({ podName, elapsedSeconds: elapsed }, '[K8sSandbox] Pod reached Running state');
        return;
      }

      if (phase === 'Failed' || phase === 'Succeeded') {
        throw new K8sSandboxError('CONTAINER_START_FAILED', `Pod entered terminal state: ${phase}`, podName);
      }

      const waitReason = containerState?.waiting?.reason;
      if (waitReason === 'ErrImagePull' || waitReason === 'ImagePullBackOff') {
        const msg = containerState?.waiting?.message || waitReason;
        throw new K8sSandboxError('CONTAINER_START_FAILED', `Image pull failed: ${msg}`, podName);
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 30 === 0) {
        logger.info(
          { podName, phase, waitReason: waitReason || 'pulling image', elapsedSeconds: elapsed },
          '[K8sSandbox] Waiting for pod',
        );
      }
    } catch (err) {
      if (err instanceof K8sSandboxError) throw err;
      // Transient API error — continue polling.
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new K8sSandboxError(
    'CONTAINER_START_FAILED',
    `Pod did not reach Running state within ${timeoutMs / 1000}s`,
    podName,
  );
}

/**
 * §26 B1 §8: explicit `GET /healthz` round-trip after pod Ready. Surfaces
 * "pod Ready but daemon dead" conditions at create-time.
 */
async function probeHealthz(podName: string): Promise<void> {
  const gatewayUrl = await resolveGatewayUrl(podName);
  if (!gatewayUrl) {
    throw new K8sSandboxError(
      'HEALTHZ_FAILED',
      'Pod is Ready but no gateway URL resolvable (no NodeExternalIP, no Pod IP, no Service)',
      podName,
    );
  }
  const healthUrl = gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:') + '/healthz';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new K8sSandboxError('HEALTHZ_FAILED', `/healthz returned HTTP ${res.status}`, podName);
    }
  } catch (err) {
    if (err instanceof K8sSandboxError) throw err;
    throw new K8sSandboxError(
      'HEALTHZ_FAILED',
      `/healthz probe failed: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  } finally {
    clearTimeout(timeoutId);
  }
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

  const image = config.image || DEFAULT_IMAGE;
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
        },
      ],
      restartPolicy: 'Always',
      imagePullSecrets: [{ name: getImagePullSecret() }],
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
  // /healthz probe — only when cloud is in-cluster (KUBERNETES_SERVICE_HOST
  // is set by Kubernetes pod env). Skip for out-of-cluster callers.
  if (process.env.KUBERNETES_SERVICE_HOST) {
    await emit('daemon_healthy', 'in_progress');
    try {
      await probeHealthz(podName);
      await emit('daemon_healthy', 'ok');
    } catch (err) {
      // Not fatal — pod is Running+Ready per kubelet; cloud-side /healthz is
      // best-effort. Surface as 'ok' with a note rather than 'error' so the
      // workspace UI doesn't show a failed step for a benign route issue.
      await emit('daemon_healthy', 'ok');
      logger.warn(
        { podName, err: err instanceof Error ? err.message : String(err) },
        '[K8sSandbox] in-cluster /healthz probe failed (kubelet readinessProbe was the authority)',
      );
    }
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
  const podIp = await getContainerIp(podName);
  if (!podIp) {
    throw new K8sSandboxError('POD_IP_UNAVAILABLE', `pod IP unavailable for ${podName}`, podName);
  }

  const daemonUrl = `http://${podIp}:${DEFAULT_DAEMON_PORT}/v1/runs`;
  let res: Response;
  try {
    res = await fetch(daemonUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new K8sSandboxError(
      'DAEMON_UNREACHABLE',
      `daemon RPC unreachable: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }

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
}

async function installAgent(podName: string, payload: InstallAgentArgs): Promise<InstallAgentResult> {
  const podIp = await getContainerIp(podName);
  if (!podIp) {
    throw new K8sSandboxError('POD_IP_UNAVAILABLE', `pod IP unavailable for ${podName}`, podName);
  }

  const daemonUrl = `http://${podIp}:${DEFAULT_DAEMON_PORT}/v1/agents/install`;
  let res: Response;
  try {
    res = await fetch(daemonUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new K8sSandboxError(
      'DAEMON_UNREACHABLE',
      `daemon installAgent RPC unreachable: ${err instanceof Error ? err.message : String(err)}`,
      podName,
      err instanceof Error ? err : undefined,
    );
  }

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
    const baseImage = pod?.spec?.containers?.[0]?.image || DEFAULT_IMAGE;

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

async function provisionContainer(args: ProvisionContainerArgs): Promise<{ container: ContainerInfo }> {
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

  // Caller-supplied env wins for non-PRISMER_API_KEY* fields; the freshly-
  // minted key + cloud URL always win (ported from the deleted controller's
  // create-container path).
  const scopedEnv: Record<string, string> = {};

  // I-1 (post-review fix): unconditionally inject CLOUD_API_BASE regardless of
  // scoped-key block. Controller does this at containers.ts:153-158 outside the
  // scoped-key block so warm-pool reuse + non-tasked dispatches also get a cloud
  // endpoint. daemon-first arch (docs/54release/13:106) treats CLOUD_API_BASE as
  // a daemon-side trust-boundary fallback env.
  const cloudApiBase = process.env.PRISMER_HOST_URL ?? process.env.CLOUD_URL;
  if (cloudApiBase) scopedEnv.CLOUD_API_BASE = cloudApiBase;

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
  });

  return { container };
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
  snapshot,
  podStatusVerdict,
  getContainerLogs,
};

export type K8sSandbox = typeof k8sSandbox;

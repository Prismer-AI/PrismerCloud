// T8 / 08 §5.7 C-1 — single canonical image ref across all environments.
//
// The daemon image tag is no longer a TypeScript constant. It is resolved at
// runtime via the image-pin service (infra/sandbox-image/image-pin.yaml or
// CONTAINER_IMAGE env). This is what makes §5.7 C-1 isomorphism real: dev,
// test and prod all see the IDENTICAL `dockerhub.services/.../sandbox:daemon-vX.Y.Z`
// ref in pod manifests; kind translates the pull path via containerd mirror.
//
// See `src/lib/sandbox/image-pin.ts` for the resolution rules.
import { getDaemonImage } from './image-pin';

export const SANDBOX_DAEMON_PORT = 7878;
export const SANDBOX_DAEMON_CONTAINER_NAME = 'daemon';
export const SANDBOX_HEALTH_PATH = '/healthz';

export interface SandboxDaemonEnvInput {
  daemonId: string;
  workspaceId?: string;
  cloudApiBase?: string;
  cloudWsUrl?: string;
  apiKey?: string;
  extra?: Record<string, string | undefined | null>;
}

export interface SandboxContainerPort {
  name: string;
  containerPort: number;
}

export interface SandboxPodContainerSpec {
  name: string;
  image: string;
  ports: SandboxContainerPort[];
  env: Array<{ name: string; value: string }>;
  readinessProbe: { httpGet: { path: string; port: number }; initialDelaySeconds: number; periodSeconds: number };
  livenessProbe: { httpGet: { path: string; port: number }; initialDelaySeconds: number; periodSeconds: number };
}

/**
 * Resolve the daemon image ref. Priority:
 *   1. Caller-supplied env override (SANDBOX_DAEMON_IMAGE / DAEMON_IMAGE_TAG)
 *      — preserved for legacy test injection paths.
 *   2. image-pin service (CONTAINER_IMAGE env > image-pin.yaml > REJECT).
 *
 * 08 §5.2 — there is no hardcoded constant fallback. Refusing to provision is
 * better than ImagePullBackOff in production.
 */
export function getSandboxDaemonImage(
  env?: Partial<Record<'SANDBOX_DAEMON_IMAGE' | 'DAEMON_IMAGE_TAG', string>>,
): string {
  const source = env ?? process.env;
  const legacy = source.SANDBOX_DAEMON_IMAGE || source.DAEMON_IMAGE_TAG;
  if (legacy) return legacy;
  return getDaemonImage();
}

export function getSandboxDaemonPort(env?: Partial<Record<'SANDBOX_DAEMON_PORT', string>>): number {
  const source = env ?? process.env;
  const raw = source.SANDBOX_DAEMON_PORT;
  if (!raw) return SANDBOX_DAEMON_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SANDBOX_DAEMON_PORT: ${raw}`);
  }
  return parsed;
}

export function buildSandboxDaemonEnv(input: SandboxDaemonEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PRISMER_DAEMON_ID: input.daemonId,
  };
  if (input.workspaceId) env.PRISMER_WORKSPACE_ID = input.workspaceId;
  if (input.cloudApiBase) env.CLOUD_API_BASE = input.cloudApiBase;
  if (input.cloudWsUrl) env.CLOUD_WS_URL = input.cloudWsUrl;
  if (input.apiKey) env.PRISMER_API_KEY = input.apiKey;
  if (process.env.DISPATCH_DAEMON_SECRET?.trim())
    env.DISPATCH_DAEMON_SECRET = process.env.DISPATCH_DAEMON_SECRET.trim();
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (value != null) env[key] = value;
  }
  return env;
}

/**
 * C-10 (08 §5.7) — `host.docker.internal` resolution.
 *
 * macOS Docker Desktop / OrbStack resolve `host.docker.internal` natively
 * from inside pods; Linux Docker does NOT. Kind 0.31+ passes `host-gateway`
 * through to containerd so we can use it as a special hostAliases value,
 * which Kubernetes translates into the host's docker-bridge IP at pod
 * admission time.
 *
 * Injection rules (THIS is the only env-conditional branch in pod-spec —
 * platform difference, not configuration difference):
 *   - APP_ENV !== 'local'          → never inject (prod / test pods must
 *                                    NOT reach the host network)
 *   - APP_ENV === 'local', macOS   → never inject (works natively)
 *   - APP_ENV === 'local', Linux   → inject hostAliases
 *
 * The platform check uses `process.platform`; tests stub it via
 * `Object.defineProperty(process, 'platform', ...)`.
 */
export function shouldInjectHostGatewayAlias(
  appEnv: string | undefined = process.env.APP_ENV,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (appEnv !== 'local') return false;
  return platform === 'linux';
}

/**
 * Return the hostAliases array for a sandbox pod, or undefined if no
 * injection is required for the current (appEnv, platform) tuple.
 *
 * Returning undefined (rather than an empty array) keeps the rendered
 * pod manifest free of empty fields — important for §5.7 L9 manifest
 * diff (prod must NOT carry an empty hostAliases stanza).
 */
export function buildSandboxHostAliases(
  appEnv: string | undefined = process.env.APP_ENV,
  platform: NodeJS.Platform = process.platform,
): Array<{ ip: string; hostnames: string[] }> | undefined {
  if (!shouldInjectHostGatewayAlias(appEnv, platform)) return undefined;
  return [{ ip: 'host-gateway', hostnames: ['host.docker.internal'] }];
}

/**
 * F8 (2026-05-19) — canonical env builder for the **workspace-runtime** profile
 * sandbox pod (`POST /api/workspace/runtime-installations`).
 *
 * The route used to build this map inline (lines 355-378) and provisionContainer's
 * scopedEnv block merged additional keys on top, producing a post-merge env that
 * no single function emitted. The L8 isomorphism harness modeled neither shape,
 * so `manifest-diff-gen.ts` drifted from production. This helper returns the
 * final post-merge env in the exact production key-order; provisionContainer's
 * scopedEnv merge is idempotent when the route passes the same daemonId / cloud
 * URL / tenantId back (scopedEnv values match the helper's values for the
 * overlapping keys).
 *
 * See docs/release200/evidence/f8-l8-isomorphism-rootcause-2026-05-19.md for
 * the root-cause analysis.
 */
export interface WorkspaceRuntimeEnvInput {
  /** Cloud-minted daemon UUID. Pass the SAME value to `provisionContainer`'s
   * `daemonId` arg so scopedEnv's PRISMER_DAEMON_ID merge is idempotent. */
  daemonId: string;
  /** Workspace ID — emitted as PRISMER_WORKSPACE_ID. */
  workspaceId: string;
  /** Tenant (workspace owner IM user id) — emitted as PRISMER_USER_ID. */
  tenantId: string;
  /** Cloud-minted scoped API key — emitted as PRISMER_API_KEY. */
  apiKey: string;
  /** Cloud public base URL — emitted as both PRISMER_BASE_URL (daemon
   * trust env) and CLOUD_API_BASE (provisionContainer scopedEnv mirror). */
  cloudApiBase: string;
  /** Stable runtime install id — emitted as PRISMER_RUNTIME_INSTANCE_ID. */
  runtimeInstanceId: string;
  /** Runtime kind discriminator — emitted as PRISMER_RUNTIME_KIND. */
  runtimeKind: 'workspace-k8s-pod' | 'workspace-daemon';
  /** Optional k8s pod template — emitted as PRISMER_K8S_TEMPLATE when set. */
  k8sTemplate?: string;
  /** Optional gpu request count — emitted as PRISMER_GPU_REQUEST when > 0. */
  gpuRequest?: number;
  /** Sandbox-scoped shell exec flag. Defaults to true (k8s pod isolation is
   * the security boundary). Pass false to suppress. */
  shellEnabled?: boolean;
  /** `process.env.DISPATCH_DAEMON_SECRET`. Helper trims + omits when empty. */
  dispatchDaemonSecret?: string;
}

export function buildWorkspaceRuntimeEnv(input: WorkspaceRuntimeEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PRISMER_API_KEY: input.apiKey,
    PRISMER_DAEMON_ID: input.daemonId,
    PRISMER_BASE_URL: input.cloudApiBase,
    PRISMER_WORKSPACE_ID: input.workspaceId,
    PRISMER_RUNTIME_MODE: 'container',
    PRISMER_RUNTIME_KIND: input.runtimeKind,
    PRISMER_RUNTIME_INSTANCE_ID: input.runtimeInstanceId,
  };
  if (input.shellEnabled !== false) env.PRISMER_SHELL_ENABLED = 'true';
  if (input.k8sTemplate) env.PRISMER_K8S_TEMPLATE = input.k8sTemplate;
  if (input.gpuRequest !== undefined && input.gpuRequest > 0) {
    env.PRISMER_GPU_REQUEST = String(input.gpuRequest);
  }
  const dispatchSecret = input.dispatchDaemonSecret?.trim();
  if (dispatchSecret) env.DISPATCH_DAEMON_SECRET = dispatchSecret;
  // Mirror provisionContainer's scopedEnv injections — they'd be appended by
  // the spread merge anyway, but emitting them here makes the helper the
  // single source of truth for the post-merge env shape.
  env.CLOUD_API_BASE = input.cloudApiBase;
  env.PRISMER_USER_ID = input.tenantId;
  return env;
}

export function buildSandboxContainerSpec(input: {
  daemonId: string;
  image?: string;
  port?: number;
  env?: Record<string, string>;
}): SandboxPodContainerSpec {
  const port = input.port ?? getSandboxDaemonPort();
  return {
    name: SANDBOX_DAEMON_CONTAINER_NAME,
    image: input.image ?? getSandboxDaemonImage(),
    ports: [{ name: SANDBOX_DAEMON_CONTAINER_NAME, containerPort: port }],
    env: Object.entries({ PRISMER_DAEMON_ID: input.daemonId, ...(input.env ?? {}) }).map(([name, value]) => ({
      name,
      value,
    })),
    readinessProbe: {
      httpGet: { path: SANDBOX_HEALTH_PATH, port },
      initialDelaySeconds: 3,
      periodSeconds: 5,
    },
    livenessProbe: {
      httpGet: { path: SANDBOX_HEALTH_PATH, port },
      initialDelaySeconds: 10,
      periodSeconds: 10,
    },
  };
}

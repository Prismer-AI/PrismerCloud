/**
 * K8s persistent runtime adapter.
 *
 * v200 architectural role: this is the bridge between the long-form
 * `k8sSandbox.*` implementation in `src/lib/k8s-sandbox.ts` and the
 * `PersistentRuntime` interface defined in `./types.ts`. Sandbox API
 * routes go through the registry (`resolvePersistent('k8s')`) and see
 * only this adapter — they never import `k8sSandbox` directly after S3.
 *
 * Provider boundary contract:
 *   - All exceptions thrown by `k8sSandbox.*` are `K8sSandboxError` (or
 *     unexpected `Error`). The adapter catches them, runs them through
 *     `fromK8sSandboxError`, and re-throws as `ProviderError`. Routes
 *     see only `ProviderError`.
 *   - `K8sSandboxError` is intentionally NOT re-exported here. Routes
 *     that need to detect "already absent" call
 *     `err.code === 'not_found'` on the ProviderError instead of the
 *     legacy `isAlreadyAbsentK8sError(err)` helper.
 */

import type { HealthzResponse, K8sSandbox } from '@/lib/k8s-sandbox';
import { fromK8sSandboxError, ProviderError } from '@/lib/execution/errors';
import { normalizeSandboxStatus } from './state-machine';
import type {
  ExecutionEnvironment,
  PersistentRuntime,
  ProbeDaemonResult,
  ProvisionEnvironmentInput,
  SandboxProviderCapabilities,
  SnapshotRequest,
  SnapshotResult,
} from './types';

type K8sSandboxLoader = () => Promise<K8sSandbox>;

const K8S_CAPABILITIES = {
  runtimeModel: 'persistent',
  supportsSnapshots: true,
  supportsDaemonDispatch: true,
  supportsAgentInstall: true,
  supportsLogs: true,
  supportsPortForwarding: false,
} as const satisfies SandboxProviderCapabilities;

/**
 * Run a `k8sSandbox.*` call and translate any thrown error into a
 * `ProviderError`. Keeps the K8s-specific error vocabulary contained to
 * this adapter — callers (routes / services) see only ProviderError.
 */
async function callK8s<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw fromK8sSandboxError(err);
  }
}

export class K8sSandboxProvider implements PersistentRuntime {
  readonly kind = 'k8s' as const;
  readonly capabilities = K8S_CAPABILITIES;
  private readonly loadSandbox: K8sSandboxLoader;

  constructor(loadSandbox: K8sSandboxLoader = async () => (await import('@/lib/k8s-sandbox')).k8sSandbox) {
    this.loadSandbox = loadSandbox;
  }

  async getEnvironment(id: string): Promise<ExecutionEnvironment | null> {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      const result = await sandbox.getContainer(id);
      if (!result) return null;
      const container = result.container;
      return {
        id: container.containerId,
        provider: this.kind,
        status: normalizeSandboxStatus(container.status),
        gatewayUrl: container.gatewayUrl,
        metadata: { podName: container.podName },
      };
    });
  }

  async provisionEnvironment(input: ProvisionEnvironmentInput): Promise<ExecutionEnvironment> {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      const container = await sandbox.createContainer(input.id, {
        image: input.image,
        environment: input.environment,
        cpuRequest: input.cpuRequest,
        cpuLimit: input.cpuLimit,
        memoryRequest: input.memoryRequest,
        memoryLimitStr: input.memoryLimit,
      });
      return {
        id: container.containerId,
        provider: this.kind,
        status: normalizeSandboxStatus(container.status),
        gatewayUrl: container.gatewayUrl,
        metadata: { podName: container.podName },
      };
    });
  }

  async startEnvironment(id: string): Promise<ExecutionEnvironment> {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      const result = await sandbox.startContainer(id);
      return {
        id,
        provider: this.kind,
        status: normalizeSandboxStatus(result.status),
        metadata: { podName: id },
      };
    });
  }

  async stopEnvironment(id: string): Promise<ExecutionEnvironment> {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      const result = await sandbox.stopContainer(id);
      return {
        id,
        provider: this.kind,
        status: normalizeSandboxStatus(result.status),
        metadata: { podName: id },
      };
    });
  }

  async removeEnvironment(id: string): Promise<void> {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      await sandbox.removeContainer(id);
    });
  }

  async runCommand(id: string, command: Parameters<K8sSandbox['runCmd']>[1]) {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      return sandbox.runCmd(id, command);
    });
  }

  async dispatchDaemon(id: string, payload: Parameters<K8sSandbox['daemonDispatch']>[1]) {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      return sandbox.daemonDispatch(id, payload);
    });
  }

  async installAgent(id: string, payload: Parameters<K8sSandbox['installAgent']>[1]) {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      return sandbox.installAgent(id, payload);
    });
  }

  /**
   * Release 200 T9 — snapshot dispatch.
   *
   * Branches on `req.kind`:
   *   - `'fs-manifest'` (default): in-pod daemon `/v1/snapshot` (HTTP first,
   *     exec fallback). Returns the file digest list + aggregate stats.
   *   - `'image'`: legacy Kaniko commit path (08 D-9 — currently no-op build
   *     context; ProviderError snapshot_failed is the expected outcome until
   *     the Kaniko impl is finished).
   *
   * The default kind is `fs-manifest` per 08 §4.4 — image-mode requires an
   * explicit opt-in.
   */
  async snapshot(id: string, payload?: SnapshotRequest): Promise<SnapshotResult> {
    const req: SnapshotRequest = { kind: 'fs-manifest', ...(payload ?? {}) };
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      if (req.kind === 'image') {
        const result = await sandbox.snapshot(id, {
          repo: req.repo,
          tag: req.tag,
          comment: req.comment,
        });
        return {
          snapshotId: result.snapshot.imageTag,
          kind: 'image',
          imageRef: result.snapshot.imageTag,
          digest: result.snapshot.imageDigest,
          sizeBytes: result.snapshot.sizeBytes,
        };
      }
      // fs-manifest path (default)
      const manifest = await sandbox.snapshotFsManifest(id);
      return {
        snapshotId: manifest.snapshotId,
        kind: 'fs-manifest',
        sizeBytes: manifest.totalBytes,
        manifest: {
          rootPath: manifest.rootPath,
          files: manifest.files.map((f) => ({
            path: f.path,
            sha256: f.sha256,
            sizeBytes: f.sizeBytes,
            mtime: f.mtime,
          })),
          count: manifest.count,
          totalBytes: manifest.totalBytes,
          generatedAt: manifest.generatedAt,
        },
      };
    });
  }

  /**
   * Provision a container via the scoped-key `provisionContainer` path. This
   * is the entrypoint used by the `POST /api/sandboxes` route (which mints
   * scoped credentials, wires CLOUD_API_BASE etc.). It is intentionally a
   * separate method from `provisionEnvironment` — `provisionEnvironment`
   * uses the lower-level `createContainer` signature, while this method
   * accepts the full ProvisionContainerArgs shape.
   */
  async provisionContainer(args: Parameters<K8sSandbox['provisionContainer']>[0]) {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      return sandbox.provisionContainer(args);
    });
  }

  async inspect(id: string) {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      return sandbox.getContainer(id);
    });
  }

  async getLogs(id: string, options?: { tailLines?: number }): Promise<string> {
    return callK8s(async () => {
      const sandbox = await this.loadSandbox();
      return sandbox.getContainerLogs(id, options ? { tail: options.tailLines } : undefined);
    });
  }

  /**
   * Release 200 §5.4 — active daemon /healthz probe.
   *
   * Returns a structured result; daemon-unhealthy paths populate
   * `healthy=false` + `error` instead of throwing, so the reconciler (S5)
   * can record `daemonHealthMisses++` without coupling to exception flow.
   *
   * Structural failures (k8s-side errors that aren't a daemon health signal —
   * e.g. pod missing, kube-apiserver unreachable) still surface as
   * `ProviderError` so routes can return the appropriate 404 / 502.
   */
  async probeDaemon(id: string): Promise<ProbeDaemonResult> {
    const startedAt = Date.now();
    let resp: HealthzResponse;
    try {
      const sandbox = await this.loadSandbox();
      resp = await sandbox.probeHealthz(id);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      // K8sSandboxError('HEALTHZ_FAILED') maps to ProviderError(daemon_unreachable);
      // that's a health-signal failure, not a structural one — surface as
      // `healthy: false` so the reconciler can count it as a miss. All other
      // errors (e.g. 404 pod missing, K8S_NOT_AVAILABLE) are structural —
      // rethrow as ProviderError per the standard k8s-provider boundary.
      const e = err as { code?: string };
      if (e?.code === 'HEALTHZ_FAILED') {
        return {
          healthy: false,
          latencyMs,
          error: message,
        };
      }
      // Structural error path — translate via shared helper.
      if (err instanceof ProviderError) throw err;
      throw fromK8sSandboxError(err);
    }

    const latencyMs = Date.now() - startedAt;
    // Graceful-degrade: pre-2.0.0 daemons that omit `readyForDispatch` are
    // treated as healthy when `status==='ok'`. New daemons must also report
    // `readyForDispatch===true`.
    const healthy = resp.status === 'ok' && (resp.readyForDispatch === undefined || resp.readyForDispatch === true);

    return {
      healthy,
      latencyMs,
      daemonId: resp.daemonId,
      daemonVersion: resp.daemonVersion,
      readyForDispatch: resp.readyForDispatch,
      raw: resp,
      ...(healthy
        ? {}
        : {
            error: `daemon not ready (status=${resp.status} readyForDispatch=${String(resp.readyForDispatch)})`,
          }),
    };
  }
}

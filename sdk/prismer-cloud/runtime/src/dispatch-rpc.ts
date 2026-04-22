/**
 * Prismer Runtime — Dispatch RPC handlers (Sprint C0)
 *
 * Bridges cloud → daemon dispatch. Cloud's TaskRouter sends an
 * `rpc.request` over the relay control channel with `method:
 * "task.dispatch"`; this handler routes the request through the local
 * DispatchMux, which selects the adapter and runs it. The result is
 * returned via `rpc.response` (RelayClient handles the envelope).
 *
 * Mirrors http/fs-rpc.ts so the relay-side dispatch surface and the
 * daemon-side HTTP surface (POST /api/v1/adapters/dispatch) share the
 * same DispatchMux semantics — same selection rules, same failure
 * shapes, only the transport differs.
 */

import type { DispatchMux, DispatchMuxRequest, DispatchMuxResult } from './dispatch-mux.js';
import type { AdapterRegistry } from './adapter-registry.js';
import type { ArtifactUploader } from './artifacts-uploader.js';

interface RpcHandlerSink {
  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void;
}

export interface DispatchRpcDeps {
  mux: DispatchMux;
  registry: AdapterRegistry;
  /**
   * v1.9.x Task 2: optional artifact uploader. When set, after a successful
   * dispatch we upload each `result.artifacts[*].path` to cloud and attach
   * `cloudUploadId` / `cloudCdnUrl` back onto the artifact. Failures are
   * absorbed (the artifact stays in the result without cloudUploadId).
   */
  artifactUploader?: ArtifactUploader;
}

/**
 * Register dispatch-related RPC handlers on a RelayClient or TransportManager.
 * Safe to call multiple times — later registrations overwrite earlier ones.
 *
 * Methods:
 *   task.dispatch     — run one task step on a selected adapter
 *   task.list-adapters — return the registry's descriptors (for cloud probing)
 *   task.resolve      — return which adapter would handle the capability
 *                       without actually dispatching (cheap probe)
 */
export function registerDispatchRpcHandlers(sink: RpcHandlerSink, deps: DispatchRpcDeps): void {
  sink.registerRpcHandler('task.dispatch', async (params) => {
    const req = parseDispatchRequest(params);
    if ('error' in req) {
      // Surface a structured failure rather than throwing — the cloud
      // promise resolves with ok:false so TaskRouter can mark the step
      // failed without timing out on the rpc.response timer.
      const fail: DispatchMuxResult = { ok: false, error: req.error };
      return fail;
    }
    const result = await deps.mux.dispatch(req);

    // v1.9.x Task 2: if the adapter returned artifacts and we have an
    // uploader, push each one to cloud and stamp cloudUploadId on the
    // artifact entry. All failures are swallowed — the rpc.response still
    // carries the raw `path` so the cloud can report something useful.
    if (deps.artifactUploader && result.ok && result.artifacts && result.artifacts.length > 0) {
      const uploader = deps.artifactUploader;
      const enriched = await Promise.all(
        result.artifacts.map(async (a) => {
          try {
            const r = await uploader.upload(req.taskId, a.path, {
              ...(a.mime ? { mimeType: a.mime } : {}),
            });
            if (r.ok) {
              return { ...a, cloudUploadId: r.uploadId, cloudCdnUrl: r.cdnUrl };
            }
            return { ...a, cloudUploadError: r.error };
          } catch (err) {
            // Defensive: should never happen — uploader.upload() is
            // contractually no-throw — but absorb just in case.
            return { ...a, cloudUploadError: `unexpected:${(err as Error).message}` };
          }
        }),
      );
      return { ...result, artifacts: enriched };
    }

    return result;
  });

  sink.registerRpcHandler('task.list-adapters', async () => {
    return { adapters: deps.registry.list() };
  });

  sink.registerRpcHandler('task.resolve', async (params) => {
    const body = (params ?? {}) as { capability?: string; preferAdapter?: string };
    if (!body.capability || typeof body.capability !== 'string') {
      return { ok: false, error: 'capability required' };
    }
    const resolved = deps.mux.resolve({
      capability: body.capability,
      preferAdapter: body.preferAdapter,
    });
    if (!resolved) {
      return { ok: false, error: `no_adapter_for_capability:${body.capability}` };
    }
    return { ok: true, adapter: resolved.adapter };
  });
}

function parseDispatchRequest(params: unknown): DispatchMuxRequest | { error: string } {
  if (!params || typeof params !== 'object') {
    return { error: 'task.dispatch params must be an object' };
  }
  const body = params as Record<string, unknown>;

  if (typeof body.taskId !== 'string' || body.taskId.length === 0) {
    return { error: 'taskId (string) required' };
  }
  if (typeof body.capability !== 'string' || body.capability.length === 0) {
    return { error: 'capability (string) required' };
  }
  if (typeof body.prompt !== 'string') {
    return { error: 'prompt (string) required' };
  }

  return {
    taskId: body.taskId,
    capability: body.capability,
    prompt: body.prompt,
    ...(typeof body.stepIdx === 'number' ? { stepIdx: body.stepIdx } : {}),
    ...(typeof body.deadlineAt === 'number' ? { deadlineAt: body.deadlineAt } : {}),
    ...(typeof body.preferAdapter === 'string' ? { preferAdapter: body.preferAdapter } : {}),
    ...(body.metadata && typeof body.metadata === 'object'
      ? { metadata: body.metadata as Record<string, unknown> }
      : {}),
  };
}

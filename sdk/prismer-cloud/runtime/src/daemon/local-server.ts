// Minimal local HTTP server bound to 127.0.0.1:<port>. Used by:
//   - the daemon-helper in scripts/e2e/local/lib (GET /healthz)
//   - future RN desktop client (m4+)
//   - Cloud 3 S3 sandbox controller (POST /v1/runs — daemon dispatch ack)
// 1.9.x m3 keeps this minimal; future RN consumer will expand.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, createHash, createHmac, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { handleAgentMessageDispatch, type MessageDispatchDeps, type MessageDispatchHandle } from './message-dispatch.js';
import type { AgentDispatchRequest } from '../wire/dispatch-types.js';

export interface LocalServerOptions {
  port: number;
  /** Snapshot getter — runner provides current state on demand. */
  getState: () => LocalServerState;
  /**
   * Optional dispatch sink called when POST /v1/runs receives a task envelope
   * from the sandbox controller. Phase 1 contract: the sink is fire-and-forget;
   * daemon acks immediately with `{ runId, status: 'accepted' }`. Cloud-side
   * task lifecycle (status → done/failed) is closed asynchronously by the
   * daemon's WS upstream channel in S4 follow-up. The runner provides this
   * sink; tests may pass a stub.
   */
  onDispatch?: (payload: DispatchPayload, runId: string) => void;
  /**
   * Optional dependencies for POST /dispatch (Release 200 §2.6 external
   * message → agent dispatch). When provided, LocalServer invokes
   * `handleAgentMessageDispatch()` internally and returns its synchronous
   * AgentDispatchResponse before async reply posting completes.
   */
  messageDispatchDeps?: MessageDispatchDeps;
  /**
   * Shared HMAC secret for Cloud → daemon POST /dispatch. Production daemons
   * must receive this via DISPATCH_DAEMON_SECRET or this option.
   */
  messageDispatchSecret?: string;
  /**
   * Optional direct handler for POST /dispatch. Prefer messageDispatchDeps
   * for the standard daemon path; this hook exists for tests and alternate
   * embedders that already wrap `handleAgentMessageDispatch()`.
   */
  messageDispatchHandler?: (payload: AgentDispatchRequest) => MessageDispatchHandle;
  /**
   * Install or update one hosted agent/profile in the daemon's local mirror.
   * The runner persists it, reloads hostedAgents, and redeclares to cloud.
   */
  onInstallAgent?: (payload: InstallAgentPayload) => Promise<InstallAgentResult>;
  /**
   * Filesystem root for snapshot manifests. Default `/workspace`. POST
   * /v1/snapshot walks this tree, computes per-file sha256 + size + mtime,
   * and returns the manifest. Cloud-side persistence (POST
   * /api/sandboxes/:id/snapshot/manifest) is a separate step in Phase 1.
   */
  snapshotRoot?: string;
  /**
   * Optional first-pass handler for `/local/memory/*` routes. Returns true
   * if the request was handled (response written); false to let the normal
   * route table fall through. Wired by the daemon runner from
   * `attachMemoryRpc()` in `daemon/memory/rpc.ts` when memory is enabled.
   * When set, /healthz reports `memoryReady: true`.
   */
  attachMemory?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /**
   * Optional handler for `POST /local/asset/write` — agent-gen adapter
   * (daemon/asset/origin/agent-gen.ts). Synchronous: agent posts bytes,
   * daemon uploads to cloud, returns prismer:// URI in one round-trip.
   * Sink receives the parsed JSON body and returns a structured result.
   */
  onAssetWrite?: (body: unknown) => Promise<AssetWriteHandlerResult>;
  /**
   * Optional handler for `/local/asset/*` routes. Returns true if the request
   * was handled (response written); false to let the normal route table fall
   * through. Wired by the daemon runner from `attachAssetRpc()` in
   * `daemon/asset/rpc.ts` when asset metadata index is enabled.
   * When set, /healthz reports `assetReady: true`.
   */
  attachAsset?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /**
   * release202/09 P2 — explicit file-delivery handler for
   * `POST /local/deliver`. The in-container agent's `cloud deliver` /
   * `cloud file send` proxy to this endpoint so the daemon (which holds the
   * usable IM credential the agent lacks) performs the upload + delivery.
   *
   * Body: `{ taskId, path, mode: 'attach' | 'send' | 'task-attach' | 'message-attach', conversationId?, messageId? }`.
   *   - `mode:'attach'` (动作 A): upload + record the assetId onto the active
   *     task's pending list so dispatch-end `flushPending` rides it on the
   *     agent's reply (`reply.assetIds`).
   *   - `mode:'send'` (动作 B): upload + post a standalone message carrying the
   *     attachment to `conversationId`.
   *   - `mode:'task-attach'` (动作 ③, P5#2): upload as a TASK-bound asset
   *     (`sourceTaskId`) for a real kanban task; cloud auto-rolls it onto the
   *     task card + re-emits the terminal digest. No chat reply, no message.
   *   - `mode:'message-attach'` (动作 A2, P5#3): upload + append the asset to an
   *     ALREADY-SENT message (`conversationId` + `messageId`) via the cloud
   *     attach route, which re-emits `message.updated` so the UI picks it up.
   *
   * Returns a structured `{ status, body }`. The runner wires this from
   * `attachDeliver()` in `daemon/asset/deliver.ts`.
   */
  onDeliver?: (body: unknown) => Promise<DeliverHandlerResult>;
  /**
   * Optional first-pass handler for `/v1/hooks/*` routes (v2.1 §9.5
   * daemon-as-hook-intake). Returns true if the request was handled
   * (response written); false to let the normal route table fall through.
   * Wired by the daemon runner from `attachHookServer()` in
   * `daemon/memory/hook-server.ts` whenever both memory + run-session
   * registry are available. When set, /healthz reports `hooksReady: true`.
   */
  attachHooks?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /**
   * Optional first-pass handler for `/v1/checkpoints/*` routes
   * (release201/09 §9.4a.7 task product self-check). Independent of
   * `attachHooks` — checkpoints fire on SDK status-transition only, while
   * hooks fire per LLM call. Wired by the runner from
   * `attachCheckpointServer()` in `daemon/checkpoint-server.ts`. When set,
   * /healthz reports `checkpointsReady: true`.
   */
  attachCheckpoints?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

  /**
   * Optional snapshot getter for the eval-session capability
   * (release201/08 §7.2). When provided, /healthz reports `evalSessions`
   * with the current active count + per-run summaries. The runner wires
   * this from `EvalSessionRunner.getState()`.
   */
  getEvalSessions?: () => {
    active: number;
    queued: number;
    maxConcurrent: number;
    runs: Array<{ runId: string; skillId: string; startedAt: string }>;
  };
}

export interface AssetWriteHandlerResult {
  status: 200 | 400 | 502;
  body: unknown;
}

export interface DeliverHandlerResult {
  status: 200 | 400 | 404 | 422 | 502;
  body: unknown;
}

/**
 * Dispatch envelope received from the sandbox controller proxy. The schema
 * mirrors `DaemonDispatchSchema` in `infra/sandbox-controller/src/api/v1/
 * containers.ts` — kept permissive so the controller can pass through any
 * future fields without a daemon-side bump.
 *
 * Phase 1 escape hatch: when `shellCommand` is present, the daemon spawns
 * it via `bash -c` with cwd=/workspace as a fire-and-forget subprocess.
 * This bridges the gap until S4 wires the WS-mediated adapter dispatch +
 * completion path. Production traffic does NOT set shellCommand — task
 * service forwards it only when present in IMTask.metadata.shellCommand
 * (a test escape hatch).
 */
export interface DispatchPayload {
  taskId: string;
  adapter?: string;
  prompt?: string;
  env?: Record<string, string>;
  shellCommand?: string;
  [k: string]: unknown;
}

export interface InstallAgentPayload {
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

export interface LocalServerState {
  daemonId: string;
  /**
   * Daemon binary version (Release 200 §5.4). Reported in /healthz so cloud
   * can validate image pin and graceful-degrade against pre-2.0.0 daemons.
   * Sourced from the runtime package.json (see runner.ts).
   */
  daemonVersion: string;
  cloudBaseUrl?: string;
  workspaceId?: string | null;
  pid: number;
  startedAt: number;
  wsConnected: boolean;
  hostedAgents: Array<{ imUserId: string; name: string; adapterName: string }>;
  runningTaskIds: string[];
  observability?: {
    adapters?: Record<string, unknown>;
    assetSync?: Record<string, unknown>;
    lastTaskError?: { taskId: string; message: string; at: string };
  };
  /**
   * Adapter-level readiness snapshot (Release 200 §5.4). One entry per
   * registered adapter. Cloud uses this to compute Ready-AND with the
   * cluster-level signals (pod Running, /healthz reachable).
   */
  adapters?: Array<{
    name: string;
    ready: boolean;
    version?: string;
    /**
     * Release 201 v2.0.7 P1 — pinned binary version range from
     * `adapters/known-versions.ts`. `minVersion` is the lowest upstream
     * the wrapper has actively run against; `knownGood` is the rev
     * exercised by the current cookbook + CI smoke. Both are surfaced
     * verbatim so cloud-side debug-pipeline can flag drift between the
     * detected `version` and what we've tested.
     */
    minVersion?: string;
    knownGood?: string;
  }>;
  /**
   * Resource snapshot (Release 200 §5.4 + 08 §175). v200 baseline returns
   * placeholder zeros — true CPU/Mem sampling lives in S5 reconciler or a
   * follow-up daemon iteration. Cloud should not depend on these values for
   * health gating yet; they are informational.
   * TODO(v210): wire real cgroup / process.resourceUsage() sampling.
   */
  resources?: {
    cpu: { usagePct: number };
    mem: { usedBytes: number; limitBytes: number };
  };
  /**
   * Final per-daemon Ready signal (Release 200 §5.4). True iff every
   * registered adapter reports ready=true. Cloud uses this with
   * `status==='ok'` to gate dispatch (graceful degrade: pre-2.0.0 daemons
   * that omit this field are treated as ready when status==='ok').
   */
  readyForDispatch?: boolean;
}

export class LocalServer {
  private server?: Server;

  constructor(private opts: LocalServerOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.route(req, res));
      this.server.once('error', reject);
      // Daemon-first k8s mode (drift #4 closure, 2026-05-07):
      // when the daemon runs inside a k8s pod, kubelet's readiness/liveness
      // probes hit the pod IP (10.x.x.x), not 127.0.0.1. Binding to localhost
      // only would make every probe fail and the pod CrashLoopBackOff.
      // Default stays 127.0.0.1 for the local-bare-daemon (M1) case so the
      // daemon doesn't expose its unauthenticated /healthz / /agents to
      // LAN. Set PRISMER_DAEMON_BIND=0.0.0.0 in container entrypoints
      // (infra/sandbox-image/daemon-entrypoint.sh handles this for k8s).
      const bind = process.env.PRISMER_DAEMON_BIND ?? '127.0.0.1';
      this.server.listen(this.opts.port, bind, () => {
        // Publish actual listening port so adapters (e.g. hermes
        // `configurePrismerProvider`) can stamp the right `curl
        // 127.0.0.1:<port>/v1/hooks/*` command into Hermes' config.yaml.
        // CLI `--port` overrides the 3210 default; without this line the
        // adapter's hardcoded fallback would point hook subprocesses at
        // the wrong port whenever a non-default --port is in effect.
        process.env.PRISMER_DAEMON_PORT = String(this.opts.port);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      // server.close() alone waits for all open connections to drain. When the
      // daemon is spawned as a child of a tsx/node test parent and that parent
      // has hit /healthz via the global fetch agent (default keep-alive), the
      // parent's idle keep-alive sockets hold the connection open from our
      // side. close() then never fires its callback and runner.stop() blocks
      // forever — process.exit(0) in the SIGTERM handler is unreachable.
      //
      // Forcibly close every connection (idle or in-flight) so close()'s
      // callback can fire. closeAllConnections() is available since Node
      // 18.2; the runtime's `engines.node` pin is >=20.
      const srv = this.server;
      srv.close(() => resolve());
      try {
        srv.closeAllConnections?.();
      } catch {
        /* defensive: don't break shutdown if closeAllConnections throws */
      }
    });
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    if (req.method === 'OPTIONS') {
      respond(res, 204, null);
      return;
    }
    // Chain-first: let specialized handlers claim their prefixes before
    // falling through to the standard route table.
    const handlers: Array<{ name: string; fn: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }> = [];
    if (this.opts.attachCheckpoints) {
      // /v1/checkpoints/* — release201/09 §9.4a.7. Distinct from
      // /v1/hooks/*; both are tried in order, each returns false to let
      // the next handler claim the URL.
      handlers.push({ name: 'checkpoints', fn: this.opts.attachCheckpoints });
    }
    if (this.opts.attachHooks) {
      handlers.push({ name: 'hooks', fn: this.opts.attachHooks });
    }
    if (this.opts.attachMemory) {
      handlers.push({ name: 'memory', fn: this.opts.attachMemory });
    }
    if (this.opts.attachAsset) {
      handlers.push({ name: 'asset', fn: this.opts.attachAsset });
    }
    if (handlers.length > 0) {
      void this.runHandlers(req, res, handlers, 0);
      return;
    }
    this.routeStandard(req, res);
  }

  private async runHandlers(
    req: IncomingMessage,
    res: ServerResponse,
    handlers: Array<{ name: string; fn: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }>,
    idx: number,
  ): Promise<void> {
    if (idx >= handlers.length) {
      this.routeStandard(req, res);
      return;
    }
    try {
      const handled = await handlers[idx]!.fn(req, res);
      if (handled) return;
      await this.runHandlers(req, res, handlers, idx + 1);
    } catch (err) {
      respond(res, 500, {
        error: `attach_${handlers[idx]!.name}_threw`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private routeStandard(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/healthz') {
      const state = this.opts.getState();
      // Release 200 §5.4 — uptime is derived in the handler (not by getState)
      // so a single getState() invocation yields a coherent snapshot. The
      // delta is bounded to a few ms and not security-sensitive.
      const uptimeSec = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
      respond(res, 200, {
        status: 'ok',
        daemonId: state.daemonId,
        daemonVersion: state.daemonVersion,
        cloudBaseUrl: state.cloudBaseUrl,
        workspaceId: state.workspaceId ?? null,
        pid: state.pid,
        startedAt: state.startedAt,
        uptime: uptimeSec,
        wsConnected: state.wsConnected,
        hostedAgents: state.hostedAgents,
        observability: state.observability,
        adapters: state.adapters ?? [],
        resources: state.resources,
        readyForDispatch: state.readyForDispatch ?? false,
        memoryReady: this.opts.attachMemory != null,
        assetReady: this.opts.attachAsset != null,
        hooksReady: this.opts.attachHooks != null,
        checkpointsReady: this.opts.attachCheckpoints != null,
        // release201/08 §7.2 — eval session capability snapshot. Always emit
        // the field so cloud-side debug-pipeline / Studio Lifecycle can rely
        // on its presence; absent runner → all zeros.
        evalSessions: this.opts.getEvalSessions
          ? this.opts.getEvalSessions()
          : { active: 0, queued: 0, maxConcurrent: 0, runs: [] },
      });
      return;
    }
    if (req.method === 'GET' && url === '/agents') {
      const state = this.opts.getState();
      respond(res, 200, { agents: state.hostedAgents });
      return;
    }
    if (req.method === 'POST' && url === '/v1/agents/install') {
      void this.handleInstallAgent(req, res);
      return;
    }
    if (req.method === 'GET' && url === '/tasks/running') {
      const state = this.opts.getState();
      respond(res, 200, { taskIds: state.runningTaskIds });
      return;
    }
    if (req.method === 'POST' && url === '/v1/runs') {
      void this.handleDispatch(req, res);
      return;
    }
    if (req.method === 'POST' && url === '/dispatch') {
      void this.handleMessageDispatch(req, res);
      return;
    }
    if (req.method === 'POST' && url === '/v1/snapshot') {
      void this.handleSnapshot(req, res);
      return;
    }
    const agentDumpMatch = /^\/v1\/agents\/([^/]+)\/dump-state$/.exec(url);
    if (req.method === 'POST' && agentDumpMatch) {
      void this.handleAgentDumpState(req, res, decodeURIComponent(agentDumpMatch[1]!));
      return;
    }
    if (req.method === 'POST' && url === '/local/asset/write') {
      void this.handleAssetWrite(req, res);
      return;
    }
    if (req.method === 'POST' && url === '/local/deliver') {
      void this.handleDeliver(req, res);
      return;
    }
    respond(res, 404, { error: 'not_found', path: url });
  }

  /**
   * POST /v1/agents/install — cloud/controller installs one hosted agent on
   * this daemon. The payload is intentionally explicit and idempotent: the
   * runner upserts local `agents` and `agent_profiles` rows, reloads the
   * in-memory declaration set, then sends `agent.host.declare` immediately.
   */
  private async handleInstallAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await readJson(req);
    if (!parsed.ok) {
      respond(res, 400, { error: parsed.error });
      return;
    }
    const payload = parsed.body as Partial<InstallAgentPayload>;
    const validationError = validateInstallAgentPayload(payload);
    if (validationError) {
      respond(res, 400, { error: 'invalid_body', message: validationError });
      return;
    }
    if (!this.opts.onInstallAgent) {
      respond(res, 501, { error: 'install_agent_unavailable' });
      return;
    }
    try {
      const result = await this.opts.onInstallAgent(payload as InstallAgentPayload);
      respond(res, 200, result);
    } catch (err) {
      respond(res, 500, {
        error: 'install_agent_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * POST /v1/snapshot — daemon-first FS manifest snapshot.
   *
   * Walks `snapshotRoot` (default `/workspace`), computes per-file
   * sha256 + sizeBytes + mtime, returns `{ files: [...], rootPath }`.
   * Skips dotfiles + the `<artifacts|_outbox|result>/_uploaded` reserved subdir. Phase 1
   * caller (cloud or controller) is responsible for POSTing the result
   * to `/api/sandboxes/:id/snapshot/manifest`.
   */
  private async handleSnapshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const root = this.opts.snapshotRoot ?? '/workspace';
    // Stat the root first — `walkAndDigest` swallows ENOENT for any
    // sub-directory (raced delete during walk), so we'd otherwise return
    // an empty manifest for a missing root, which masks misconfiguration.
    try {
      const st = await fs.stat(root);
      if (!st.isDirectory()) {
        respond(res, 400, { error: 'snapshot_root_not_directory', rootPath: root });
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        respond(res, 404, { error: 'snapshot_root_missing', rootPath: root });
        return;
      }
      respond(res, 500, {
        error: 'snapshot_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    try {
      const files = await walkAndDigest(root, root);
      respond(res, 200, { rootPath: root, files });
    } catch (err) {
      respond(res, 500, {
        error: 'snapshot_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    void req;
  }

  /**
   * POST /v1/agents/:agentId/dump-state — agent-scoped daemon manifest.
   *
   * This is narrower than `/v1/snapshot`: it walks only the current agent's
   * profile/work dirs so cloud can attach the result to IMAgentSnapshot without
   * capturing unrelated agents hosted in the same daemon/container.
   */
  private async handleAgentDumpState(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
    const state = this.opts.getState();
    const agent = state.hostedAgents.find((item) => item.imUserId === agentId);
    if (!agent) {
      respond(res, 404, { error: 'agent_not_hosted', agentId });
      return;
    }

    const roots = getAgentStateRoots(agent, this.opts.snapshotRoot ?? '/workspace');
    try {
      const manifests = await Promise.all(
        roots.map(async (root) => {
          const stat = await statOptional(root.rootPath);
          if (!stat) return { ...root, exists: false, files: [] as ManifestEntry[] };
          if (!stat.isDirectory()) return { ...root, exists: true, error: 'not_directory', files: [] as ManifestEntry[] };
          return { ...root, exists: true, files: await walkAndDigest(root.rootPath, root.rootPath) };
        }),
      );
      const files = manifests.flatMap((manifest) =>
        manifest.files.map((file) => ({
          ...file,
          path: `${manifest.kind}/${file.path}`,
          rootKind: manifest.kind,
          rootPath: manifest.rootPath,
        })),
      );
      respond(res, 200, {
        agentId,
        adapterName: agent.adapterName,
        dumpedAt: new Date().toISOString(),
        roots: manifests,
        files,
      });
    } catch (err) {
      respond(res, 500, {
        error: 'agent_dump_state_failed',
        agentId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    void req;
  }

  /**
   * POST /local/asset/write — agent-gen adapter RPC.
   *
   * Body: { workspaceId, bytes (base64), filename, mime?, path?, description?, sourceAgentImUserId? }
   * Response 200: { assetId, contentHash, prismerUri }
   * 400 on body validation failure; 422 on agent-output policy rejection;
   * 502 on cloud upstream failure; 501 if no sink wired.
   */
  private async handleAssetWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.opts.onAssetWrite) {
      respond(res, 501, { error: 'asset_write_unavailable' });
      return;
    }
    const parsed = await readJson(req);
    if (!parsed.ok) {
      respond(res, 400, { error: 'invalid_json' });
      return;
    }
    try {
      const result = await this.opts.onAssetWrite(parsed.body);
      respond(res, result.status, result.body);
    } catch (err) {
      respond(res, 500, {
        error: 'asset_write_threw',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * POST /local/deliver — release202/09 P2 explicit file delivery.
   *
   * Body: { taskId, path, mode: 'attach' | 'send' | 'task-attach' | 'message-attach', conversationId?, messageId? }
   * 200: { ok: true, assetId }
   * 400 invalid body; 404 file not found; 422 policy/magic-bytes rejection;
   * 502 cloud upstream failure; 501 if no sink wired.
   *
   * The daemon-side `onDeliver` sink (daemon/asset/deliver.ts) owns the
   * upload (via ArtifactsWatcher.deliverFile, daemon credential) and the
   * attach-vs-send branch.
   */
  private async handleDeliver(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.opts.onDeliver) {
      respond(res, 501, { ok: false, error: 'deliver_unavailable' });
      return;
    }
    const parsed = await readJson(req);
    if (!parsed.ok) {
      respond(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    try {
      const result = await this.opts.onDeliver(parsed.body);
      respond(res, result.status, result.body);
    } catch (err) {
      respond(res, 502, {
        ok: false,
        error: 'deliver_threw',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * POST /dispatch — external channel message → hosted agent dispatch.
   *
   * Cloud calls this with AgentDispatchRequest (Release 200 §2.6). The daemon
   * returns AgentDispatchResponse immediately, while the handler's `done`
   * promise completes later by posting AgentDispatchReplyPayload back to cloud.
   */
  private async handleMessageDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readRaw(req);
    const auth = verifyDispatchSignature(req, rawBody, this.opts.messageDispatchSecret);
    if (!auth.ok) {
      respond(res, auth.status, {
        ok: false,
        error: { code: auth.code, message: auth.message },
      });
      return;
    }

    const parsed = parseJson(rawBody);
    if (!parsed.ok) {
      respond(res, 400, {
        ok: false,
        error: { code: 'invalid_json', message: parsed.error },
      });
      return;
    }

    const validationError = validateAgentDispatchRequest(parsed.body);
    if (validationError) {
      respond(res, 400, {
        ok: false,
        error: { code: 'invalid_body', message: validationError },
      });
      return;
    }

    const handler = this.resolveMessageDispatchHandler();
    if (!handler) {
      respond(res, 501, {
        ok: false,
        error: {
          code: 'message_dispatch_unavailable',
          message: 'Message dispatch handler is not configured.',
        },
      });
      return;
    }

    const payload = parsed.body as AgentDispatchRequest;
    try {
      const handle = handler(payload);
      void handle.done.catch((err) => {
        process.stderr.write(
          `[daemon] /dispatch done failed message=${payload.messageId} agent=${payload.mentionedAgentImUserId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
      });
      respond(res, 200, handle.response);
    } catch (err) {
      respond(res, 500, {
        ok: false,
        error: {
          code: 'message_dispatch_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private resolveMessageDispatchHandler(): ((payload: AgentDispatchRequest) => MessageDispatchHandle) | undefined {
    if (this.opts.messageDispatchHandler) return this.opts.messageDispatchHandler;
    const deps = this.opts.messageDispatchDeps;
    if (!deps) return undefined;
    return (payload) => handleAgentMessageDispatch(payload, deps);
  }

  /**
   * POST /v1/runs — dispatch ack-only (Cloud 3 S3 Phase 1).
   *
   * The sandbox controller resolves the pod IP and POSTs a task envelope here.
   * Phase 1 just acknowledges receipt and forwards the payload to onDispatch
   * (the runner). Actual task execution + cloud-side completion are wired in
   * S4 (daemon WS upstream emits task.dispatch.reply once the adapter finishes).
   *
   * Response on success: 202 + `{ runId, status: 'accepted' }`.
   * Bad JSON / missing taskId: 400. Internal error: 500.
   */
  private async handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await readJson(req);
    if (!parsed.ok) {
      respond(res, 400, { error: 'invalid_json' });
      return;
    }
    const payload = parsed.body as DispatchPayload;
    if (typeof payload?.taskId !== 'string' || payload.taskId.length === 0) {
      respond(res, 400, { error: 'missing_taskId' });
      return;
    }

    const runId = randomUUID();
    try {
      this.opts.onDispatch?.(payload, runId);
    } catch (err) {
      respond(res, 500, {
        error: 'dispatch_sink_threw',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    respond(res, 202, { runId, status: 'accepted', taskId: payload.taskId });
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Prismer-Dispatch-Timestamp,X-Prismer-Dispatch-Signature',
  );
  res.setHeader('Access-Control-Max-Age', '600');
  if (status === 204) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  return parseJson(await readRaw(req));
}

async function readRaw(req: IncomingMessage): Promise<string> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  return raw;
}

function parseJson(raw: string): { ok: true; body: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

const DISPATCH_SIGNATURE_HEADER = 'x-prismer-dispatch-signature';
const DISPATCH_TIMESTAMP_HEADER = 'x-prismer-dispatch-timestamp';
const DISPATCH_SIGNATURE_SKEW_MS = 5 * 60 * 1000;

function verifyDispatchSignature(
  req: IncomingMessage,
  rawBody: string,
  secretOverride?: string,
):
  | { ok: true }
  | { ok: false; status: 401 | 503; code: 'dispatch_auth_failed' | 'dispatch_auth_misconfigured'; message: string } {
  const secret = getDispatchSecret(secretOverride);
  if (!secret) {
    return {
      ok: false,
      status: 503,
      code: 'dispatch_auth_misconfigured',
      message: 'DISPATCH_DAEMON_SECRET is required for daemon dispatch authentication.',
    };
  }

  const timestamp = readHeader(req, DISPATCH_TIMESTAMP_HEADER);
  const signature = readHeader(req, DISPATCH_SIGNATURE_HEADER);
  if (!timestamp || !signature) {
    return {
      ok: false,
      status: 401,
      code: 'dispatch_auth_failed',
      message: 'Missing dispatch signature headers.',
    };
  }

  const timestampMs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > DISPATCH_SIGNATURE_SKEW_MS) {
    return {
      ok: false,
      status: 401,
      code: 'dispatch_auth_failed',
      message: 'Dispatch signature timestamp is invalid or expired.',
    };
  }

  const expected = createDispatchSignature(rawBody, secret, timestamp);
  if (!safeEqual(signature, expected)) {
    return {
      ok: false,
      status: 401,
      code: 'dispatch_auth_failed',
      message: 'Dispatch signature is invalid.',
    };
  }

  return { ok: true };
}

function createDispatchSignature(rawBody: string, secret: string, timestamp: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `v1=${digest}`;
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getDispatchSecret(secretOverride?: string): string | null {
  if (secretOverride?.trim()) return secretOverride.trim();
  const secret = process.env.DISPATCH_DAEMON_SECRET?.trim();
  if (secret) return secret;
  if (devDispatchSecretAllowed()) return 'dev-daemon-dispatch-secret';
  return null;
}

function devDispatchSecretAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test' && process.env.APP_ENV !== 'prod' && process.env.APP_ENV !== 'test';
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && cryptoTimingSafeEqual(left, right);
}

function validateInstallAgentPayload(payload: Partial<InstallAgentPayload>): string | null {
  if (!payload || typeof payload !== 'object') return 'body must be an object';
  if (!payload.workspaceId) return 'workspaceId is required';
  if (!payload.imUserId) return 'imUserId is required';
  if (!payload.name) return 'name is required';
  if (!payload.adapterName) return 'adapterName is required';
  if (!Array.isArray(payload.capabilities)) return 'capabilities must be an array';
  if (!payload.profile || typeof payload.profile !== 'object') return 'profile is required';
  if (!payload.profile.id) return 'profile.id is required';
  if (!payload.profile.name) return 'profile.name is required';
  if (!payload.profile.adapterName) return 'profile.adapterName is required';
  if (!payload.profile.config || typeof payload.profile.config !== 'object') return 'profile.config is required';
  if (typeof payload.profile.version !== 'number') return 'profile.version is required';
  return null;
}

function validateAgentDispatchRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const payload = body as Partial<AgentDispatchRequest>;
  const requiredStringFields = [
    'channelAccountId',
    'externalUserId',
    'conversationId',
    'mentionedAgentImUserId',
    'messageText',
    'messageId',
    'replyToken',
  ] as const;
  for (const field of requiredStringFields) {
    const value = payload[field];
    if (typeof value !== 'string') return `${field} must be a string`;
    if (field !== 'messageText' && value.length === 0) return `${field} is required`;
  }
  if (typeof payload.replyDeadlineMs !== 'number' || !Number.isFinite(payload.replyDeadlineMs)) {
    return 'replyDeadlineMs must be a number';
  }
  if (payload.replyDeadlineMs <= 0) return 'replyDeadlineMs must be greater than 0';
  if (payload.attachments != null && !Array.isArray(payload.attachments)) return 'attachments must be an array';
  return null;
}

interface ManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  mtime: number;
}

interface AgentStateRoot {
  kind: 'hermes-profile' | 'openclaw-profile' | 'workspace-agent';
  rootPath: string;
}

function getAgentStateRoots(
  agent: { imUserId: string; name: string; adapterName: string },
  snapshotRoot: string,
): AgentStateRoot[] {
  const profileName = sanitizeProfileName(agent.name || agent.imUserId);
  const roots: AgentStateRoot[] = [
    {
      kind: 'workspace-agent',
      rootPath: path.join(snapshotRoot, 'agents', agent.imUserId),
    },
  ];
  if (agent.adapterName === 'hermes' || agent.adapterName === 'claude-code') {
    roots.unshift({
      kind: 'hermes-profile',
      rootPath: path.join(process.env.HERMES_HOME || path.join(homedir(), '.hermes'), 'profiles', profileName),
    });
  }
  if (agent.adapterName === 'openclaw') {
    roots.unshift({
      kind: 'openclaw-profile',
      rootPath: path.join(process.env.OPENCLAW_HOME || path.join(homedir(), '.openclaw'), 'profiles', profileName),
    });
  }
  return roots;
}

function sanitizeProfileName(value: string): string {
  return value.replace(/[\\/]/g, '_').trim() || 'default';
}

async function statOptional(rootPath: string) {
  try {
    return await fs.stat(rootPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function walkAndDigest(root: string, current: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(current);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(current, name);
    const rel = path.relative(root, full);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue; // raced with delete
    }
    if (st.isDirectory()) {
      // Skip the reserved upload-staging subdir to avoid manifesting partial
      // uploads + their inflight chunks. The artifacts dir itself is included;
      // the sentinel is `_uploaded/` deeper inside. release202/04 §3.1: match
      // the new `artifacts/` dir plus legacy `_outbox/` / `result/` names.
      const base = path.basename(rel);
      const parent = path.basename(path.dirname(rel));
      if (base === '_uploaded' && (parent === 'artifacts' || parent === '_outbox' || parent === 'result')) {
        continue;
      }
      const sub = await walkAndDigest(root, full);
      out.push(...sub);
      continue;
    }
    if (!st.isFile()) continue;
    const buf = await fs.readFile(full);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    out.push({
      path: rel,
      sha256,
      sizeBytes: st.size,
      mtime: Math.floor(st.mtimeMs),
    });
  }
  return out;
}

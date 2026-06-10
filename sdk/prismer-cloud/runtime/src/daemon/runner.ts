// Daemon main loop. Wires WsClient + SyncWorker + AdapterRegistry + LocalServer.
// See docs/refactor/04-daemon-runtime.md §启动流程.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { AdapterDef, AgentProfile } from '../adapters/contract.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { claudeCodeAdapter } from '../adapters/claude-code/index.js';
import { codexAdapter } from '../adapters/codex/index.js';
import { hermesAdapter, HermesService } from '../adapters/hermes/index.js';
import { openclawAdapter } from '../adapters/openclaw/index.js';
import { ADAPTER_KNOWN_VERSIONS } from '../adapters/known-versions.js';
import { AssetCache } from '../asset-cache.js';
import { CloudClient, CloudError, type CloudResponse } from '../auth.js';
import {
  type Config,
  type ConfigPaths,
  deriveWsUrl,
  loadConfig,
  resolveDeviceAgentDir,
  resolvePaths,
} from '../config.js';
import { envelope } from '../envelope.js';
import { openLocalDb, type LocalDb } from '../sync/store.js';
import { SyncQueue, type SyncQueueRow } from '../sync/sync-queue.js';
import { SyncWorker } from '../sync/sync-worker.js';
import type {
  AgentChangedPayload,
  AssetChangedPayload,
  AgentHostDeclarePayload,
  AgentProfileChangedPayload,
  HostAckedPayload,
  RejectedHostedAgent,
  TaskApprovalResolvePayload,
  TaskClarifyResolvePayload,
  TaskCancelPayload,
  TaskDispatchRequestPayload,
  WorkspaceChangedPayload,
  WorkspaceClearDaemonCleanupPayload,
  WorkspaceFileChangedPayload,
} from '../types/im-events.js';
import { UriResolver } from '../uri-resolver.js';
import { createLogger } from '../lib/logger.js';
import { handleDispatch } from './dispatch.js';
import { EvalSessionRunner, type EvalStartRequest, type EvalTestCase } from './eval-session.js';
import { createHermesEvalSpawner } from './eval-hermes-spawner.js';
import { LocalServer, type InstallAgentPayload, type InstallAgentResult, type LocalServerState } from './local-server.js';
import type { MessageDispatchAgent } from './message-dispatch.js';
import { attachMemoryRunner, syncMemoryFromCloud, type MemoryRunnerWiring } from './memory/runner-wiring.js';
import { attachMemoryRpc } from './memory/rpc.js';
import { attachHookServer, type ProfileResolver } from './memory/hook-server.js';
import { RunSessionRegistry, setRunSessionRegistry } from './memory/run-session-map.js';
import {
  RunCheckpointStore,
  setRunCheckpointStore,
} from './memory/run-checkpoint-store.js';
import { runCheckpointResumeScan } from './run-resume.js';
import { daemonMetricEmit } from './metric-emit.js';
import { HermesSessionMapper, setHermesSessionMapper } from '../adapters/hermes/sessions-mapper.js';
import { ProviderSessionMapper, setProviderSessionMapper } from './provider-session-mapper.js';
import { getHermesProfileName, wipeHermesProfileMemory } from '../adapters/hermes/index.js';
import { AssetMetadataIndex } from './asset/metadata-index.js';
import { WorkspaceMirror } from './asset/mirror.js';
import { attachAssetRpc } from './asset/rpc.js';
import { attachDeliver } from './asset/deliver.js';
import { attachCheckpointServer } from './checkpoint-server.js';
import { migrateLegacyTaskWorkdirs } from './task-workdir-migration.js';
import { DropFolderAdapter } from './asset/origin/drop-folder.js';
import { OriginOutbox } from './asset/origin/outbox.js';
import { DaemonAssetUploadClient, UploadRunner } from './asset/origin/upload-runner.js';
import type { OriginAdapter } from './asset/origin/spi.js';
import { ArtifactsWatcher } from './artifacts-watcher.js';
import { ServicePool } from './service-pool.js';
import { executeShellDispatch, isShellDispatch, resolveShellConfig, type ShellExecutionConfig } from './shell-executor.js';
import { syncAllAgentSkills, syncInstalledSkillsForDispatch } from './skill-sync.js';
import { writeDeviceJson } from './device-dir.js';
import { writeAgentProfileSnapshot } from './agent-dir.js';
import { WsClient } from './ws-client.js';
import {
  createPendingReplyCache,
  type PendingReplyCache,
} from './pending-reply-cache.js';
import {
  sendDispatchReplyTwoPhase,
  recoverPendingReplies,
} from './dispatch-reply-transport.js';
import type { AgentDispatchReplyPayload, AgentDispatchRequest } from '../wire/dispatch-types.js';
import { handleAgentMessageDispatch } from './message-dispatch.js';
import {
  buildTransportProbe,
  pickLocalIPv4,
  reportTransportProbe,
} from './transport-probe.js';
import { getTaskReaperMinInactivityMs } from './reaper-config.js';

export interface RunnerOptions {
  /** Override config path; defaults to ~/.prismer. */
  paths?: ConfigPaths;
  /** Skip starting the local 127.0.0.1 server (useful in tests). */
  startLocalServer?: boolean;
  /** Local server port; defaults to 3210. */
  localPort?: number;
  /** Override daemonVersion reported in agent.host.declare. */
  daemonVersion?: string;
  /** Pre-loaded config (skip filesystem read). */
  configOverride?: Config;
  /** Override built-in adapter list (tests). */
  adaptersOverride?: AdapterDef[];
}

const DEFAULT_LOCAL_PORT = 3210;

const log = createLogger('Daemon');
const assetMetaLog = createLogger('AssetMeta');
const workspaceFilesLog = createLogger('WorkspaceFiles');

interface HostedAgent {
  imUserId: string;
  name: string;
  adapterName: string;
  capabilities: string[];
  /** profileId → version. Synced from local SQLite + host.acked diff. */
  profiles: Map<string, number>;
}

/**
 * release201/24 §3 — payload of the cloud-pushed `skill.eval.request` frame.
 * `_rpcId` mirrors the webhook reverse-RPC envelope so cloud's WsRpcService
 * can settle on the `skill.eval.reply` ack.
 */
interface EvalRequestPayload {
  _rpcId?: string;
  runId: string;
  skillId: string;
  skillSlug?: string;
  skillManifest?: Array<{ path: string; content?: string }>;
  allowlistBuiltins?: string[];
  testCases?: EvalTestCase[];
  scratchEnv?: Record<string, string>;
}

interface OwnedAgentDTO {
  id: string;
  username?: string;
  displayName?: string;
  agentType?: string | null;
  card?: {
    name?: string | null;
    capabilities?: string[];
  } | null;
}

export class Runner extends EventEmitter {
  private config!: Config;
  private paths!: ConfigPaths;
  private db!: LocalDb;
  private cloud!: CloudClient;
  private ws!: WsClient;
  private syncWorker!: SyncWorker;
  private syncQueue!: SyncQueue;
  private assetCache!: AssetCache;
  private uriResolver!: UriResolver;
  private registry!: AdapterRegistry;
  private servicePool!: ServicePool;
  private shellConfig!: ShellExecutionConfig;
  private localServer?: LocalServer;
  // release201/24 §3 — daemon-side eval-session capability. Instantiated in
  // start(); consumes cloud's `skill.eval.request` WS frames, runs the skill
  // under test in an isolated HOME via Hermes, and POSTs per-case results
  // back to /api/im/skills/:id/eval/runs/:runId/finish.
  private evalRunner?: EvalSessionRunner;
  private artifactsWatcher?: ArtifactsWatcher;
  private memoryWiring?: MemoryRunnerWiring;
  private runSessionRegistry?: RunSessionRegistry;
  // release201/26 Phase 4 — phase-level run checkpoint store (singleton wiring,
  // same pattern as runSessionRegistry). dispatch.ts reaches it via the
  // module-level getter to persist a checkpoint on each phase change.
  private runCheckpointStore?: RunCheckpointStore;
  // release201/25 §16.4 A1 — hermes sessions API mapper (singleton wiring,
  // same pattern as runSessionRegistry above). Allows hermes adapter to
  // resolve (conversationId, agentImUserId) → hermesSessionId without
  // taking a `db` DI parameter.
  private hermesSessionMapper?: HermesSessionMapper;
  private assetMetadataIndexes = new Map<string, AssetMetadataIndex>();
  private workspaceMirrors = new Map<string, WorkspaceMirror>();
  private assetOriginOutbox?: OriginOutbox;
  private dropFolderAdapter?: DropFolderAdapter;
  private dropFolderUploadRunner?: UploadRunner;
  private dropFolderTimer?: NodeJS.Timeout;
  private dropFolderWorkspaceId = '';
  private dropFolderWorkspaceDir = '';
  private dropFolderTickInFlight = false;
  private readonly dropFolderStable = new Map<string, { size: number; mtime: number }>();
  private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  private startedAt = 0;
  private workspaceId = '';
  private wsConnected = false;
  private readonly hostedAgents = new Map<string, HostedAgent>();
  private readonly rejectedHostedAgentIds = new Map<string, RejectedHostedAgent & { rejectedAt: number }>();
  private readonly runningTasks = new Map<
    string,
    { ctrl: AbortController; startedAt: number; lastProgressAt: number; timeoutMs: number }
  >();
  private lastTaskError?: { taskId: string; message: string; at: string };
  private heartbeatTimer?: NodeJS.Timeout;
  private taskReaperTimer?: NodeJS.Timeout;
  // F16 (2026-05-20) — periodic skill resync timer (default 10min).
  private skillResyncTimer?: NodeJS.Timeout;
  private skillSyncInFlight = false;
  // P0-2 (2026-05-25) — one-shot cold-start sweep for cloud-side in-flight runs.
  private resumeInFlightTimer?: NodeJS.Timeout;
  private resumeInFlightDone = false;
  // Wave-4 E7 — local cache of in-flight two-phase dispatch replies. Survives
  // daemon crash so cold-start can resume `prepared` rows via idempotent
  // commit (server enforces (taskId, idempotencyKey) UNIQUE).
  private pendingReplyCache!: PendingReplyCache;
  // One-shot guard so we only recover on the first post-authenticated tick,
  // not every reconnect (server-side commits are idempotent but the log noise
  // and DB pressure of re-running on every redeclare is wasteful).
  private pendingReplyRecoveryDone = false;

  constructor(private opts: RunnerOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') throw new Error(`Runner already in state ${this.state}`);
    this.state = 'starting';
    this.startedAt = Date.now();

    this.paths = this.opts.paths ?? resolvePaths();
    this.config = this.opts.configOverride ?? loadConfig(this.paths);
    this.shellConfig = resolveShellConfig(this.config.shell);
    // Read workspace from env for sandbox/container/local-dev where no
    // agent registration flow sets it. Desktop flow still sets it via
    // onHostAcked when the cloud sends host.acked.
    if (process.env.PRISMER_WORKSPACE_ID) {
      this.workspaceId = process.env.PRISMER_WORKSPACE_ID;
    }
    // Adapter child processes need the same cloud provider endpoint and key
    // the daemon already uses for IM/WS. This keeps long-running agents on the
    // normal Prismer auth/billing path instead of requiring separate provider
    // credentials.
    process.env.PRISMER_BASE_URL = this.config.cloud_api_base;
    process.env.PRISMER_API_KEY = this.config.api_key;

    this.db = openLocalDb(this.paths.localDb);
    this.cloud = new CloudClient({ baseUrl: this.config.cloud_api_base, apiKey: this.config.api_key });

    // release201/09 §9.1 — write `devices/<did>/device.json` once per boot.
    // Best-effort; failures logged but never block daemon start (local-first).
    // This must run after `paths` + `config.daemon_id` are resolved but
    // before any agent dir is created (skillsDir / profile.json depend on
    // the device root being present).
    try {
      writeDeviceJson(this.paths, this.config.daemon_id);
    } catch (err) {
      process.stderr.write(`[daemon] device.json write failed: ${(err as Error).message}\n`);
    }

    // release201/09 §9.3.1 — best-effort once-off migration of legacy
    // `runs/<tid>/` directories into the new
    // `workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/` layout.
    // Idempotent (watermark files); cloud-unreachable tasks are skipped
    // for the next startup. Errors logged but never block daemon start —
    // local-first principle (cloud may be unavailable on first boot).
    void migrateLegacyTaskWorkdirs(this.paths, this.cloud)
      .then((mig) => {
        if (mig.scanned > 0 || mig.migrated > 0 || mig.failed > 0) {
          process.stdout.write(
            `[daemon] task workdir migration scanned=${mig.scanned} migrated=${mig.migrated} skipped=${mig.skipped} failed=${mig.failed}\n`,
          );
          for (const err of mig.errors.slice(0, 5)) {
            process.stderr.write(`[daemon] task workdir migration failed task=${err.taskId} reason=${err.reason}\n`);
          }
        }
      })
      .catch((err) => {
        process.stderr.write(`[daemon] task workdir migration threw: ${(err as Error).message}\n`);
      });
    // Wave-4 E7: pending dispatch reply cache (W3 two-phase crash-recovery).
    // openLocalDb has already applied migration v4 which creates the
    // pending_dispatch_replies table.
    this.pendingReplyCache = createPendingReplyCache(this.db);

    this.assetCache = new AssetCache({
      db: this.db,
      cloud: this.cloud,
      cacheDir: this.paths.cacheDir,
      maxBytes: this.config.cache?.max_bytes,
    });
    this.uriResolver = new UriResolver({ db: this.db, cloud: this.cloud, assetCache: this.assetCache });

    this.registry = new AdapterRegistry();
    const adapters = this.opts.adaptersOverride ?? [
      hermesAdapter,
      claudeCodeAdapter,
      openclawAdapter,
      codexAdapter,
    ];
    for (const a of adapters) this.registry.register(a);

    this.servicePool = new ServicePool();

    // Container/static-host mode: preload one fixed hosted agent/profile
    // before the first agent.host.declare. This avoids startup-time
    // hot-binding races where the daemon briefly declares zero agents.
    this.installStaticHostedAgentFromEnv();

    // Load locally-registered agents (from `prismer agent register`).
    this.loadAgentsFromDb();
    await this.prepareLocalProfiles();

    // Local sync layer
    this.syncQueue = new SyncQueue(this.db);
    this.syncWorker = new SyncWorker({ queue: this.syncQueue, flush: (row) => this.flushSyncRow(row) });
    this.syncWorker.start();

    // WebSocket client
    this.ws = new WsClient({
      url: deriveWsUrl(this.config.cloud_api_base),
      apiKey: this.config.api_key,
    });
    this.wireWsHandlers();
    this.ws.start();

    // Phase-1 memory subsystem: shared multi-workspace store + cloud-bound
    // outbox uploader + WS invalidate listener. The runtime is lazy
    // (per-workspace SQLite opens on first write/read), so instantiating it
    // here is cheap. The outbox worker polls every 5s and is no-op until
    // hooks (recall_preload / recall_inject / etc.) write events. The WS
    // listener is attached eagerly so cloud-side soft-deletes / archives
    // propagate as soon as the daemon connects.
    this.memoryWiring = attachMemoryRunner({
      cloud: this.cloud,
      wsClient: this.ws,
      baseDir: `${this.paths.root}/memory`,
      deviceId: this.config.daemon_id,
    });

    // v2.1 §9.5 — daemon-as-hook-intake. The hermes adapter registers
    // (runId → conversationId/agent/workspace) here as soon as Hermes
    // returns run_id, and the /v1/hooks/* routes reverse-lookup to
    // stamp source metadata on extracted memory pages. Module-level
    // singleton is set so the adapter (statically imported, no DI
    // container) can reach it via getRunSessionRegistry().
    this.runSessionRegistry = new RunSessionRegistry(this.db);
    setRunSessionRegistry(this.runSessionRegistry);
    // release201/26 Phase 4 — phase-level checkpoint store. dispatch.ts writes
    // a checkpoint on each phase change via the module-level getter; the
    // cold-start resume scan (scheduled below alongside resumeInFlightTasks)
    // reads survivors to reattach or emit task.dispatch.resume_failed.
    this.runCheckpointStore = new RunCheckpointStore(this.db);
    setRunCheckpointStore(this.runCheckpointStore);
    // release201/25 §16.4 A1 — wire the hermes sessions mapper so the
    // adapter's dispatch path can switch to /api/sessions/{id}/chat/stream
    // when the v0.15+ capability gate (A4) advertises it. Cleared in
    // shutdown alongside the run-session registry.
    this.hermesSessionMapper = new HermesSessionMapper(this.db);
    setHermesSessionMapper(this.hermesSessionMapper);
    // release202/05 C2 — generic provider session mapper so CLI / interactive
    // adapters (codex / claude-code) can resume a prior provider session.
    // Cleared in shutdown alongside the hermes mapper.
    setProviderSessionMapper(new ProviderSessionMapper(this.db));

    // Initial memory sync: populate local MemoryStore from cloud.
    // Without this the daemon's FTS5 store is empty and memory_search
    // returns nothing on first access after startup.
    // In the desktop daemon flow, workspaceId is set asynchronously by
    // host.acked (see onHostAcked), so this startup sync is primarily
    // a safety net for container/sandbox deployments where workspaceId
    // may already be known via env.
    if (this.memoryWiring && this.workspaceId) {
      syncMemoryFromCloud(this.memoryWiring, this.cloud, [this.workspaceId]).catch(
        (err: Error) => log.error('Initial memory sync failed', err.message),
      );
    }

    // Initial asset sync: populate local AssetMetadataIndex + workspace file
    // path bindings from cloud. This does not prefetch bytes; AssetCache
    // still downloads bytes lazily unless `prismer asset sync --bytes` is run.
    if (this.workspaceId) {
      this.syncAssetState(this.workspaceId).catch(
        (err: Error) => log.error('Initial asset sync failed', err.message),
      );
      await this.ensureDropFolderRuntime(this.workspaceId);
    }

    // Artifacts uploader (release202/04 §3.1). Runs in BOTH deployments:
    //
    //   - **Container / sandbox** (legacy): watches the controller-shared
    //     `/workspace/_outbox/` for sandbox-output artifacts (Cloud 3 S3).
    //     Legacy fixed path name kept for the container controller contract.
    //   - **Host / desktop daemon** (Wave-9): watches per-task subdirs
    //     created by dispatch.ts under ${HOME}/.prismer/.../tasks/<id>/artifacts/
    //     so adapter-produced files flow back as agent_reply attachments.
    //
    // The watcher itself is shape-agnostic — `setActiveTask({ artifactsDir })`
    // narrows the scan per dispatch. Container mode also passes a default
    // `artifactsDir` so the legacy fixed path keeps working without a
    // setActiveTask hop (controllers historically dispatch via
    // /v1/runs which then calls setActiveTask, but tests + older
    // controllers may write to /workspace/_outbox/ unconditionally).
    const containerId = process.env.PRISMER_CONTAINER_ID;
    const isContainer =
      !!containerId || process.env.PRISMER_RUNTIME_MODE === 'container';
    this.artifactsWatcher = new ArtifactsWatcher({
      ...(isContainer ? { artifactsDir: '/workspace/_outbox' } : {}),
      cloud: this.cloud,
      containerId: containerId ?? this.config.daemon_id,
      workspaceId: () => process.env.PRISMER_WORKSPACE_ID || this.workspaceId || null,
      // release202/09 P2 — directory auto-scan is OFF. File delivery is now
      // EXPLICIT: the agent runs `cloud deliver` / `cloud file send`, which
      // proxies to the daemon local-server `POST /local/deliver`. The upload +
      // pendingByTask/flushPending plumbing all still work; only the implicit
      // directory-magic is disabled. Set PRISMER_ARTIFACTS_AUTOSCAN=1 to
      // re-enable the legacy auto-archive scan as a fallback.
      autoScan: process.env.PRISMER_ARTIFACTS_AUTOSCAN === '1',
    });
    this.artifactsWatcher.start();

    // release201/24 §3 — eval-session runner. `onFinish` POSTs per-case
    // results to cloud; `adapterSpawner` runs the skill under test via a
    // throwaway Hermes gateway scoped to the isolated eval HOME. Failure to
    // obtain Hermes yields `inconclusive` (never auto-pass — §2.1).
    this.evalRunner = new EvalSessionRunner({
      onFinish: async (r) => {
        try {
          await this.cloud.request('POST', `/api/im/skills/${r.skillId}/eval/runs/${r.runId}/finish`, {
            body: {
              results: r.results.map((c) => ({
                id: c.id,
                passed: c.passed,
                verdict: c.verdict,
                durationMs: c.durationMs,
                output: c.output,
                error: c.error,
              })),
              agentTraceUrl: r.agentTraceUrl,
            },
          });
          process.stdout.write(
            `[daemon] eval run=${r.runId} skill=${r.skillId.slice(-8)} pass=${r.passCount} fail=${r.failCount} → reported\n`,
          );
        } catch (err) {
          process.stderr.write(`[daemon] eval finish POST failed run=${r.runId}: ${(err as Error).message}\n`);
        }
      },
      adapterSpawner: createHermesEvalSpawner({
        getHermesAdapter: () => this.registry.get('hermes'),
        findHermesProfile: () => this.loadAllProfiles().find((p) => p.adapterName === 'hermes'),
        ensureService: (profile, adapter) => this.servicePool.ensureService(profile, adapter),
      }),
    });

    // Local server (optional in tests)
    if (this.opts.startLocalServer !== false) {
      this.localServer = new LocalServer({
        port: this.opts.localPort ?? DEFAULT_LOCAL_PORT,
        getState: () => this.snapshotState(),
        // release201/24 §3 / 08 §7.2 — surface eval-session capability on
        // /healthz so cloud-side debug-pipeline + Studio Lifecycle can rely
        // on `maxConcurrent>0` to confirm the runner is wired.
        getEvalSessions: () => this.evalRunner?.getState() ?? { active: 0, queued: 0, maxConcurrent: 0, runs: [] },
        // Cloud 3 S3 Phase 1 — sandbox controller proxies POST /v1/runs to
        // the daemon. We log the dispatch intent so it shows up in pod logs,
        // forward the (taskId, adapter) tuple to the artifacts watcher so any
        // files the agent later writes to /workspace/_outbox/ get tagged
        // with the right metadata, and surface it as a running task so
        // /tasks/running reflects the ack. Actual adapter spawn +
        // completion roundtrip lands in S4 via the WS upstream channel
        // (cloud sends task.dispatch.request, daemon sends
        // task.dispatch.reply). Ack here is the contract the
        // controller / cloud relies on to flip
        // IMSandboxRunLog.exitReason='dispatch_ok_pending'.
        onDispatch: (payload, runId) => {
          process.stdout.write(
            `[daemon] /v1/runs ack task=${payload.taskId} runId=${runId} adapter=${payload.adapter ?? '(default)'}\n`,
          );
          this.artifactsWatcher?.setActiveTask({
            taskId: payload.taskId,
            adapter: payload.adapter,
          });

          // Phase 1 shellCommand escape hatch — see DispatchPayload doc.
          // Spawned async + fire-and-forget; failures land in pod logs but
          // don't fail the dispatch ack (cloud-side completion handler is
          // S4 work, no return path here yet).
          if (typeof payload.shellCommand === 'string' && payload.shellCommand.length > 0) {
            void this.runShellCommand(payload.taskId, payload.shellCommand);
          }
        },
        messageDispatchDeps: {
          findAgent: (agentImUserId) => this.findMessageDispatchAgent(agentImUserId),
          postReply: (payload) => this.postMessageDispatchReply(payload),
          onError: (err, request) => {
            process.stderr.write(
              `[daemon] /dispatch failed message=${request.messageId} agent=${request.mentionedAgentImUserId}: ${
                err instanceof Error ? err.stack ?? err.message : String(err)
              }\n`,
            );
          },
        },
        onInstallAgent: (payload) => this.installHostedAgent(payload),
        // T2-A: wire phase-0 daemon memory RPC routes (`/local/memory/*`)
        // onto the local HTTP server. The runner's `memoryWiring` is created
        // unconditionally above (phase-1 outbox worker + WS invalidate
        // listener), so the RPC handler is always available here. Without
        // this hook, GET /local/memory/stats etc. would 404 — phase-0
        // shipped the rpc.ts route table but T1 deliberately deferred the
        // wiring step so it could be reviewed alongside the host-adapter
        // consumer (Hermes T2-B), which is what surfaces these routes to
        // an actual agent process.
        attachMemory: this.memoryWiring
          ? attachMemoryRpc({ runtime: this.memoryWiring.runtime })
          : undefined,
        // v2.1 §9.5 — daemon-as-hook-intake hook routes. Gated on the
        // memory subsystem being live: recall + extract both rely on the
        // shared ScopedMemoryStore + outbox infrastructure. Profile
        // resolution reverse-looks-up agent_profiles by `name` so the
        // hermes adapter's hooks 块 (with `?profile=<name>`) can pin
        // the correct agentImUserId + workspaceId.
        attachHooks: this.memoryWiring && this.runSessionRegistry
          ? attachHookServer({
              cloud: this.cloud,
              memoryRuntime: this.memoryWiring.runtime,
              runSessionRegistry: this.runSessionRegistry,
              deviceId: this.config.daemon_id,
              profileResolver: this.buildProfileResolver(),
              flushOutbox: async () => {
                try {
                  await this.memoryWiring?.worker?.flushNow?.();
                } catch {
                  /* best-effort */
                }
              },
            })
          : undefined,
        attachAsset: attachAssetRpc({
          resolveIndex: (workspaceId) => this.assetMetadataIndexes.get(workspaceId),
          ensureIndex: async (workspaceId) => {
            await this.syncAssetMetadata(workspaceId, { force: true });
            return this.assetMetadataIndexes.get(workspaceId);
          },
          assetCache: this.assetCache,
        }),
        // release202/09 P2 — explicit file-delivery proxy. The in-container
        // agent's `cloud deliver` / `cloud file send` POST here so the daemon
        // (which holds a usable IM credential the agent lacks) uploads the
        // file + either rides it on the reply (动作 A, via the watcher's
        // pendingByTask) or posts a standalone message (动作 B).
        onDeliver: this.artifactsWatcher
          ? attachDeliver({
              watcher: this.artifactsWatcher,
              cloud: this.cloud,
              // The CLI forwards PRISMER_AGENT_USERNAME in the request body for
              // send-mode; this daemon-side resolver is the fallback when it is
              // absent. taskId → agent username is not tracked in runningTasks,
              // so we leave the resolver undefined and rely on the CLI-supplied
              // value (the agent's own process is the authoritative source).
            })
          : undefined,
        // release201/09 §9.4a.7 — checkpoint route runs in parallel with
        // /v1/hooks/*. Independent handler; needs cloud client (for asset
        // hash + task meta lookup) + ConfigPaths (for resolveTaskWorkdir).
        attachCheckpoints: attachCheckpointServer({
          paths: this.paths,
          cloud: this.cloud,
        }),
      });
      await this.localServer.start();
    }

    // Periodic re-declare keeps im_agent_cards.lastHeartbeat fresh so the
    // cloud's sweepTimedOut() (default 90s) doesn't flip status back to
    // offline. The handler treats agent.host.declare as refresh-on-redeclare
    // (see ws/handler.ts §handleAgentHostDeclare).
    this.heartbeatTimer = setInterval(() => {
      if (this.wsConnected) this.sendDeclare();
    }, 30_000);

    // Stuck-task reaper: long-running adapters (hermes SSE, openclaw HTTP)
    // can hang indefinitely when an upstream LLM gateway half-closes a
    // connection without sending FIN. Without this loop, the per-taskId
    // dedupe in onTaskDispatch keeps every redispatch from making progress
    // — the task is stuck "running" forever from the cloud's view. Sweep
    // every 60s and abort any entry that has overshot its own timeoutMs
    // (or PRISMER_DAEMON_TASK_REAPER_MIN_INACTIVITY_MS, default 5min).
    // The dispatch path observes the abort and sends one task.dispatch.reply;
    // sending here too produces duplicate failed logs for the same attempt.
    this.taskReaperTimer = setInterval(() => {
      const now = Date.now();
      const minInactivityMs = getTaskReaperMinInactivityMs();
      for (const [taskId, entry] of this.runningTasks) {
        const limit = Math.max(entry.timeoutMs, minInactivityMs);
        if (now - entry.lastProgressAt <= limit) continue;
        process.stderr.write(
          `[daemon] task ${taskId} inactive > ${limit}ms — aborting\n`,
        );
        try {
          entry.ctrl.abort();
        } catch {
          /* abort can throw on some Node versions; ignore */
        }
      }
    }, 60_000);

    // F16 (2026-05-20) — fan-out skill sync at startup + every 10min after.
    // Pre-F16: skills synced only at dispatch-time, so a freshly-booted
    // K8S sandbox pod had empty skill dirs until the first task arrived
    // and any auth failure (F15 skill ack 403) surfaced during dispatch
    // rather than at boot. Now we surface sync failures eagerly, keep
    // skills hot, and dispatch-time sync becomes a cheap freshness check.
    //
    // SKILL_RESYNC_INTERVAL_MS env override (min 60s, default 600s).
    const resyncInterval = clampInt(
      process.env.SKILL_RESYNC_INTERVAL_MS,
      60_000,
      24 * 3_600_000,
      600_000,
    );
    void this.syncAllSkillsBackground('startup');
    this.skillResyncTimer = setInterval(() => {
      void this.syncAllSkillsBackground('periodic');
    }, resyncInterval);

    // P0-2 (dispatch-reliability) — proactively pull cloud-side in-flight
    // IMTaskRun rows bound to this daemonId and re-enqueue them via the same
    // onTaskDispatch handler the ws path uses. Replaces the slow (~5min)
    // cloud-side sweepTimedOut() recovery for daemon pod restarts.
    //
    // Schedule with a 5s delay so the initial ws connect + agent.host.declare
    // round-trip settles first (otherwise cloud-side IMAgentBinding rows for
    // *this* daemon may not yet be visible to the binding query when we read
    // them, and re-enqueue would mis-route via runningTasks dedupe against a
    // stale assignee mapping). Idempotent — onTaskDispatch dedupes by taskId.
    this.resumeInFlightTimer = setTimeout(() => {
      void this.resumeInFlightTasks();
      // release201/26 Phase 4 — daemon-local checkpoint resume scan. Runs after
      // the cloud-side sweep so the cloud-truth re-dispatch (which writes fresh
      // checkpoints) settles first; the local scan then only acts on survivors
      // the cloud sweep didn't already pick up. Sequenced (not parallel) for the
      // same reason — onTaskDispatch dedupes by taskId so order is safe either
      // way, but running after keeps the resume_failed signal narrow.
      void this.resumeFromCheckpoints();
    }, 5_000);

    this.state = 'running';
    this.emit('ready');
  }

  /**
   * v2.1 §9.5 — build a ProfileResolver backed by the daemon's local
   * `agent_profiles` mirror. Used by the hook server to translate
   * `?profile=<name>` query into agentImUserId + workspaceId + role slug
   * when the run-session registry doesn't yet have the run mapping
   * (e.g. for the very first pre_llm_call of a session, before the
   * adapter has had a chance to call register()).
   */
  private buildProfileResolver(): ProfileResolver {
    return {
      byProfileName: (profileName: string) => {
        try {
          const row = this.db
            .prepare(
              `SELECT workspace_id, agent_im_user_id, adapter_name, config
                 FROM agent_profiles
                 WHERE name = ? AND deleted_at IS NULL
                 ORDER BY version DESC LIMIT 1`,
            )
            .get(profileName) as
            | {
                workspace_id: string;
                agent_im_user_id: string;
                adapter_name: string;
                config: string | null;
              }
            | undefined;
          if (!row) return null;
          let roleTemplateSlug: string | null = null;
          if (row.config) {
            try {
              const cfg = JSON.parse(row.config) as {
                roleTemplate?: { slug?: unknown };
                roleTemplateSlug?: unknown;
              };
              if (typeof cfg.roleTemplate?.slug === 'string') {
                roleTemplateSlug = cfg.roleTemplate.slug;
              } else if (typeof cfg.roleTemplateSlug === 'string') {
                roleTemplateSlug = cfg.roleTemplateSlug;
              }
            } catch {
              /* malformed config — leave slug null */
            }
          }
          return {
            agentImUserId: row.agent_im_user_id,
            workspaceId: row.workspace_id,
            adapterName: row.adapter_name,
            roleTemplateSlug,
          };
        } catch (err) {
          process.stderr.write(
            `[daemon] profile resolver lookup failed name=${profileName}: ${(err as Error).message}\n`,
          );
          return null;
        }
      },
    };
  }

  /**
   * F16 (2026-05-20) — enumerate every non-deleted local agent_profile and
   * fan-out `syncInstalledSkillsForDispatch` via `syncAllAgentSkills`.
   * Fire-and-forget — failures are logged per profile but never throw.
   * Re-entrant guard so an overlong sync doesn't stack with the next tick.
   */
  private async syncAllSkillsBackground(trigger: 'startup' | 'periodic' | 'profile-changed'): Promise<void> {
    if (this.skillSyncInFlight) return;
    this.skillSyncInFlight = true;
    try {
      const profiles = this.loadAllProfiles();
      if (profiles.length === 0) {
        if (trigger === 'startup') process.stdout.write('[daemon] skill sync (startup): no local profiles yet\n');
        return;
      }
      // release201/09 §9.3.2 — per-agent skill root. paths + daemonId let
      // skill-sync resolve `devices/<did>/agents/<aid>/skills/` instead of
      // the profile-shared dir.
      const { totals } = await syncAllAgentSkills(profiles, this.cloud, {
        concurrency: 3,
        skillsRootCtx: { paths: this.paths, daemonId: this.config?.daemon_id },
      });
      // §9.1 — per-profile落 profile.json 快照同时进行,趁本次 syncAll
      // 拿到 profile 数据写到 devices/<did>/agents/<aid>/profile.json,
      // 不再额外发请求。Best-effort,错误日志吞掉(本不应阻塞 skill sync)。
      const daemonId = this.config?.daemon_id;
      if (daemonId) {
        for (const profile of profiles) {
          try {
            writeAgentProfileSnapshot(this.paths, daemonId, {
              agentId: profile.id,
              agentImUserId: profile.agentImUserId,
              agentUsername: profile.agentUsername ?? null,
              workspaceId: profile.workspaceId,
              adapterName: profile.adapterName,
              name: profile.name,
              config: profile.config,
              snapshotAt: new Date().toISOString(),
            });
          } catch (err) {
            process.stderr.write(
              `[daemon] profile.json snapshot failed agent=${profile.agentImUserId}: ${(err as Error).message}\n`,
            );
          }
        }
      }
      process.stdout.write(
        `[daemon] skill sync (${trigger}): profiles=${totals.profiles} synced=${totals.synced} unchanged=${totals.unchanged} skipped=${totals.skipped} failed=${totals.failed}\n`,
      );
    } catch (err) {
      process.stderr.write(`[daemon] skill sync (${trigger}) failed: ${(err as Error).message}\n`);
    } finally {
      this.skillSyncInFlight = false;
    }
  }

  /** F16 — read all live agent_profiles from local DB → AgentProfile[]. */
  private loadAllProfiles(): AgentProfile[] {
    type ProfileRow = {
      id: string;
      workspace_id: string;
      agent_im_user_id: string;
      adapter_name: string;
      name: string;
      config: string;
      version: number;
      synced_at: number | null;
    };
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at
         FROM agent_profiles
         WHERE deleted_at IS NULL`,
      )
      .all() as ProfileRow[];
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      agentImUserId: row.agent_im_user_id,
      adapterName: row.adapter_name,
      name: row.name,
      config: parseProfileConfig(row.config),
      version: row.version,
      createdAt: new Date(row.synced_at ?? Date.now()),
      updatedAt: new Date(row.synced_at ?? Date.now()),
    }));
  }

  /**
   * P0-2 (2026-05-25) — daemon cold-start sweep.
   *
   * Pulls `IMTaskRun.status='running'` rows where the bound daemon (via
   * `IMAgentBinding.boundDaemonId`) is this daemon, then re-enqueues each
   * via the same `onTaskDispatch` handler the ws path uses. Replaces the
   * slow (~5min) cloud-side `sweepTimedOut()` fallback for pod restarts.
   *
   * Idempotent on the daemon side: `onTaskDispatch` dedupes by taskId
   * against `runningTasks`, so any task that happened to be redispatched
   * from cloud immediately after our reconnect (via redispatchPending on
   * the agent.host.declare path) won't double-trigger here.
   *
   * Caveat: if the agent was mid-LLM-call when the daemon crashed, the
   * resumed dispatch starts the call from scratch — token cost duplicated.
   * We accept that vs the alternative (5min of silence + cloud marks the
   * run `failed` without any retry).
   */
  private async resumeInFlightTasks(): Promise<void> {
    if (this.resumeInFlightDone) return;
    this.resumeInFlightDone = true;
    const daemonId = this.config?.daemon_id;
    if (!daemonId) {
      process.stderr.write('[daemon] startup: skip resume sweep — no daemon_id\n');
      return;
    }
    // Need to be ws-connected so onTaskDispatch can send progress / reply.
    // If we're not yet connected, skip — daemon will recover via the
    // (slower) cloud-side sweep + this code path simply doesn't fire on
    // the next reconnect because `resumeInFlightDone` is one-shot. That's
    // intentional: re-running on every reconnect would spam dispatches
    // mid-run.
    if (!this.wsConnected) {
      process.stderr.write('[daemon] startup: skip resume sweep — ws not yet connected\n');
      return;
    }
    try {
      type InFlightRun = {
        id: string;
        taskId: string | null;
        assigneeId: string | null;
        conversationId: string | null;
        createdAt: string;
        metadata: string;
        task: {
          id: string;
          title: string;
          description: string | null;
          capability: string | null;
          input: string | null;
          metadata: string | null;
          timeoutMs: number | null;
          conversationId: string | null;
          runtimeRoute: string | null;
        } | null;
      };
      const data = await this.cloud.get<{ runs: InFlightRun[] }>(
        `/api/im/tasks/in-flight?daemonId=${encodeURIComponent(daemonId)}`,
      );
      const runs = data?.runs ?? [];
      if (runs.length === 0) {
        process.stderr.write('[daemon] startup: 0 in-flight tasks to resume\n');
        return;
      }
      process.stderr.write(`[daemon] startup: resuming ${runs.length} in-flight tasks\n`);
      let resumed = 0;
      for (const run of runs) {
        if (!run.taskId || !run.task) continue;
        // Skip if dispatch already re-arrived via the redispatchPending path
        // that fires on agent.host.declare. Rare at boot (since we're
        // delayed 5s, that path normally fires first ~1s after connect),
        // but the dedupe is harmless.
        if (this.runningTasks.has(run.taskId)) continue;
        try {
          const payload = this.reconstructDispatchPayload(run);
          // We deliberately do NOT pass a requestId — the original ws
          // requestId was lost when the daemon crashed. The reply payload
          // travels without a `requestId`, which the cloud accepts (see
          // ws/handler.ts `task.dispatch.reply` path: requestId is only
          // used for in-process correlation, not persistence).
          await this.onTaskDispatch(payload);
          resumed++;
        } catch (err) {
          process.stderr.write(
            `[daemon] startup: failed to resume task ${run.taskId}: ${(err as Error).message}\n`,
          );
        }
      }
      process.stderr.write(`[daemon] startup: resumed ${resumed}/${runs.length} in-flight tasks\n`);
    } catch (err) {
      process.stderr.write(`[daemon] startup: resume sweep failed: ${(err as Error).message}\n`);
    }
  }

  /**
   * release201/26 Phase 4 — daemon-local checkpoint resume scan.
   *
   * Looks at `local_run_checkpoints` (phase-level). A run that still has
   * checkpoints at boot means the daemon died before dispatch.ts reached its
   * terminal `finally` (which deletes them). For each:
   *
   *   - adapter registered + healthy → RESUMABLE. The cloud-side sweep
   *     (resumeInFlightTasks, which ran just before this) already re-dispatches
   *     in-flight runs from cloud truth — that fresh dispatch writes new
   *     checkpoints — so here we only confirm resumability, count it, and clear
   *     the stale checkpoint. onResume is a confirm/log step, not a second
   *     dispatch (onTaskDispatch would dedupe anyway).
   *   - adapter missing / unhealthy → emit `task.dispatch.resume_failed` so
   *     cloud marks IMTaskRun.status='resume_failed' and the chat strip renders
   *     "task interrupted, retry".
   *
   * Best-effort + one-shot in spirit (the scan clears each run's checkpoints, so
   * a re-invocation is a no-op). Requires ws so resume_failed can be sent.
   */
  private async resumeFromCheckpoints(): Promise<void> {
    const store = this.runCheckpointStore;
    if (!store) return;
    if (!this.wsConnected) {
      // resume_failed needs the wire; skip silently (the cloud-side 5min
      // sweepTimedOut fallback still covers truly-lost runs). We do NOT clear
      // checkpoints here so a later reconnect-triggered boot path could retry —
      // but this method is only scheduled once, so in practice the cloud sweep
      // is the backstop. Local-first: never block on this path.
      process.stderr.write('[daemon] checkpoint resume: skip — ws not yet connected\n');
      return;
    }
    try {
      await runCheckpointResumeScan({
        store,
        registry: this.registry,
        onResume: (cp) => {
          // Cloud-side sweep owns the actual re-dispatch (from cloud truth).
          // Here we only acknowledge the resumable run; clearing happens inside
          // the scan after this resolves.
          process.stdout.write(
            `[daemon] checkpoint resume: run=${cp.runId} resumable (adapter=${String(cp.payload.adapterName ?? '?')})\n`,
          );
        },
        emitResumeFailed: ({ runId, taskId, reason }) => {
          this.ws.send(
            envelope('task.dispatch.resume_failed', { runId, taskId, reason }),
          );
        },
        onMetric: (result) => this.emitResumeMetric(result),
        log: (line) => process.stdout.write(`${line}\n`),
      });
    } catch (err) {
      process.stderr.write(
        `[daemon] checkpoint resume scan failed: ${(err as Error).message}\n`,
      );
    }
  }

  /**
   * release201/26 §9 — emit daemon_run_resume_total{result} (and, on failure,
   * task_dispatch_resume_failed_total). Fire-and-forget; the cloud /batch
   * endpoint requires workspaceId, so we attach this daemon's bound workspace
   * (best-effort — when unknown the event is dropped by cloud, which is fine:
   * an unscoped daemon has no run to attribute).
   */
  private emitResumeMetric(result: 'resumed' | 'failed'): void {
    const workspaceId = process.env.PRISMER_WORKSPACE_ID || this.workspaceId || null;
    if (!workspaceId) return;
    const events = [
      {
        namespace: 'daemon',
        name: 'run_resume',
        value: 1,
        dims: { workspaceId, result, daemonId: this.config?.daemon_id ?? '' },
      },
      ...(result === 'failed'
        ? [
            {
              namespace: 'task',
              name: 'dispatch_resume_failed',
              value: 1,
              dims: { workspaceId, daemonId: this.config?.daemon_id ?? '' },
            },
          ]
        : []),
    ];
    void daemonMetricEmit(events, {
      cloud: this.cloud,
      paths: this.paths,
      daemonId: this.config?.daemon_id,
      agentImUserId: null,
    }).catch(() => {
      /* observability is best-effort */
    });
  }

  /**
   * Rebuild a `task.dispatch.request` payload from an in-flight IMTaskRun
   * row + its parent IMTask. Mirrors what cloud-side
   * v19x-helpers.buildTaskDispatchRequest does, with one extra field:
   * `metadata.resumed = true` so downstream prompt injection can note
   * this is a recovery dispatch.
   */
  private reconstructDispatchPayload(run: {
    id: string;
    taskId: string | null;
    assigneeId: string | null;
    conversationId: string | null;
    task: {
      id: string;
      title: string;
      description: string | null;
      capability: string | null;
      input: string | null;
      metadata: string | null;
      timeoutMs: number | null;
      conversationId: string | null;
      runtimeRoute: string | null;
    } | null;
  }): TaskDispatchRequestPayload {
    const task = run.task!;
    let taskMeta: Record<string, unknown> = {};
    try {
      taskMeta = task.metadata ? (JSON.parse(task.metadata) as Record<string, unknown>) : {};
    } catch {
      taskMeta = {};
    }
    let taskInput: Record<string, unknown> = {};
    try {
      taskInput = task.input ? (JSON.parse(task.input) as Record<string, unknown>) : {};
    } catch {
      taskInput = {};
    }
    const legacyInputPrompt =
      typeof taskInput.prompt === 'string' && taskInput.prompt ? (taskInput.prompt as string) : null;
    const prompt =
      (typeof task.description === 'string' && task.description ? task.description : null) ??
      legacyInputPrompt ??
      task.title ??
      '';
    const profileId = typeof taskMeta.profileId === 'string' ? (taskMeta.profileId as string) : '';
    const rawRoute = task.runtimeRoute;
    const runtimeRoute: 'agent' | 'sandbox' | 'shell' | undefined =
      rawRoute === 'agent' || rawRoute === 'sandbox' || rawRoute === 'shell' ? rawRoute : undefined;
    // Strip server-side keys (mirrors v19x-helpers).
    const extraMetadata: Record<string, unknown> = { ...taskMeta };
    delete extraMetadata.profileId;
    delete extraMetadata.context;
    delete extraMetadata.delivery;
    delete extraMetadata.conversationType;
    delete extraMetadata.participants;
    delete extraMetadata.assets;
    delete extraMetadata.observability;
    // Mark as resumed so the agent prompt downstream (P1-2 prompt
    // injection in v19x-helpers / dispatch) can surface this as a
    // recovery dispatch.
    extraMetadata.resumed = true;
    extraMetadata.resumedFromRunId = run.id;
    return {
      taskId: task.id,
      agentImUserId: run.assigneeId ?? undefined,
      profileId,
      capability: task.capability ?? 'chat',
      prompt,
      runtimeRoute,
      metadata: extraMetadata,
      timeoutMs: task.timeoutMs ?? undefined,
      conversationId: run.conversationId ?? task.conversationId ?? undefined,
    };
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') return;
    this.state = 'stopping';
    for (const entry of this.runningTasks.values()) {
      try {
        entry.ctrl.abort();
      } catch {
        /* */
      }
    }
    this.runningTasks.clear();
    if (this.skillResyncTimer) {
      clearInterval(this.skillResyncTimer);
      this.skillResyncTimer = undefined;
    }
    if (this.taskReaperTimer) {
      clearInterval(this.taskReaperTimer);
      this.taskReaperTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.resumeInFlightTimer) {
      clearTimeout(this.resumeInFlightTimer);
      this.resumeInFlightTimer = undefined;
    }
    this.syncWorker?.stop();
    this.memoryWiring?.stop();
    this.memoryWiring = undefined;
    setRunSessionRegistry(null);
    this.runSessionRegistry = undefined;
    setRunCheckpointStore(null);
    this.runCheckpointStore = undefined;
    setHermesSessionMapper(null);
    this.hermesSessionMapper = undefined;
    setProviderSessionMapper(null);
    this.ws?.close();
    this.artifactsWatcher?.stop();
    this.stopDropFolderRuntime();
    await this.servicePool?.shutdown();
    await this.localServer?.stop();
    try {
      this.db?.close();
    } catch {
      /* */
    }
    this.state = 'idle';
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Phase 1 escape hatch — see `DispatchPayload.shellCommand`. Spawns
   * `bash -c <cmd>` with cwd=/workspace, mirrors output to pod logs.
   * Fire-and-forget; nothing here writes back to cloud.
   */
  private async runShellCommand(taskId: string, command: string): Promise<void> {
    const { spawn } = await import('node:child_process');
    process.stdout.write(`[daemon] shellCommand task=${taskId} cmd=${command}\n`);
    const child = spawn('bash', ['-c', command], {
      cwd: '/workspace',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdout?.on('data', (d) =>
      process.stdout.write(`[shellCommand:${taskId}] ${d.toString()}`),
    );
    child.stderr?.on('data', (d) =>
      process.stderr.write(`[shellCommand:${taskId}] ${d.toString()}`),
    );
    child.on('exit', (code) =>
      process.stdout.write(`[daemon] shellCommand task=${taskId} exit=${code}\n`),
    );
  }

  snapshotState(): LocalServerState {
    const adapterSnapshot = this.snapshotAdapterReadiness();
    return {
      daemonId: this.config?.daemon_id ?? '',
      daemonVersion: this.resolveDaemonVersion(),
      cloudBaseUrl: this.config?.cloud_api_base,
      workspaceId: this.workspaceId || null,
      pid: process.pid,
      startedAt: this.startedAt,
      wsConnected: this.wsConnected,
      hostedAgents: Array.from(this.hostedAgents.values()).map((a) => ({
        imUserId: a.imUserId,
        name: a.name,
        adapterName: a.adapterName,
      })),
      runningTaskIds: Array.from(this.runningTasks.keys()),
      observability: {
        adapters: this.snapshotAdapterObservability(),
        assetSync: this.snapshotAssetSyncObservability(),
        ...(this.lastTaskError ? { lastTaskError: this.lastTaskError } : {}),
      },
      adapters: adapterSnapshot,
      // Release 200 §5.4 + T11 — true cgroup v2 sampling. On non-cgroup
      // hosts (mac dev, no /sys/fs/cgroup) values gracefully fall back to
      // zero. CPU is a wall-clock delta against the last call so the very
      // first /healthz of the process always reports 0%; subsequent
      // calls reflect actual usage.
      resources: this.sampleCgroupResources(),
      readyForDispatch: adapterSnapshot.length > 0 && adapterSnapshot.every((a) => a.ready),
    };
  }

  /**
   * Per-adapter readiness snapshot for /healthz (Release 200 §5.4).
   *
   * We synthesize this from the AdapterRegistry rather than asking each
   * adapter to expose a per-call health probe — calling adapter.health()
   * on every /healthz hit would spawn subprocess probes and slow the
   * cloud-side handshake. Registered adapters are considered ready;
   * future iteration can flip individual entries to ready=false based on
   * cached ensureService / dispatch failures.
   */
  private snapshotAdapterReadiness(): Array<{
    name: string;
    ready: boolean;
    version?: string;
    minVersion?: string;
    knownGood?: string;
  }> {
    if (!this.registry) return [];
    return this.registry.list().map((a) => {
      const pin = ADAPTER_KNOWN_VERSIONS[a.name];
      // Adapter contract has no `version` field; leave undefined for v200.
      // Daemon binary version is reported separately as state.daemonVersion.
      // Release 201 v2.0.7 P1 — surface the pinned MIN / KNOWN_GOOD so
      // cloud-side debug-pipeline can flag drift even when the detected
      // version isn't carried on the registry entry yet.
      return {
        name: a.name,
        ready: true,
        ...(pin ? { minVersion: pin.minVersion, knownGood: pin.knownGood } : {}),
      };
    });
  }

  /**
   * Release 200 T11 — cgroup v2 resource sampling for /healthz.resources.
   *
   * Reads `memory.current` / `memory.max` (best-effort, single-shot) and
   * derives `cpu.usagePct` by diffing `cpu.stat::usage_usec` against a
   * baseline cached in module state. The very first call after process
   * start always reports 0% CPU (no baseline yet); subsequent calls
   * reflect wall-clock usage between probes.
   *
   * Graceful degrade: when `/sys/fs/cgroup/` is absent (mac dev host,
   * Kubernetes-pre-cgroup-v2 distros), all fields are returned as zero
   * — callers must treat sampler output as advisory, not authoritative.
   */
  private cpuBaseline: { usec: number; at: number } | null = null;
  private sampleCgroupResources(): {
    cpu: { usagePct: number };
    mem: { usedBytes: number; limitBytes: number };
  } {
    const baseline = { cpu: { usagePct: 0 }, mem: { usedBytes: 0, limitBytes: 0 } };
    try {
      if (!existsSync('/sys/fs/cgroup/memory.current')) {
        return baseline;
      }

      // Memory — direct file read; cgroup v2 path layout.
      const memUsedRaw = readFileSync('/sys/fs/cgroup/memory.current', 'utf-8').trim();
      const memUsed = Number.parseInt(memUsedRaw, 10);
      let memLimit = 0;
      if (existsSync('/sys/fs/cgroup/memory.max')) {
        const limitRaw = readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
        // 'max' means unlimited; report 0 so cloud knows the cap is open.
        memLimit = limitRaw === 'max' ? 0 : Number.parseInt(limitRaw, 10) || 0;
      }

      // CPU — diff against the last call. Single-core baseline (v200
      // intentionally does not normalise across multi-core; cap at 100%).
      let cpuUsagePct = 0;
      if (existsSync('/sys/fs/cgroup/cpu.stat')) {
        const statLines = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf-8').split('\n');
        const usecLine = statLines.find((line) => line.startsWith('usage_usec '));
        if (usecLine) {
          const usec = Number.parseInt(usecLine.split(' ')[1] ?? '0', 10);
          const now = Date.now();
          if (this.cpuBaseline) {
            const elapsedMs = now - this.cpuBaseline.at;
            if (elapsedMs >= 1000) {
              const deltaUsec = usec - this.cpuBaseline.usec;
              cpuUsagePct = Math.min(100, Math.max(0, (deltaUsec / (elapsedMs * 1000)) * 100));
              this.cpuBaseline = { usec, at: now };
            }
          } else {
            this.cpuBaseline = { usec, at: now };
          }
        }
      }

      return {
        cpu: { usagePct: cpuUsagePct },
        mem: { usedBytes: Number.isFinite(memUsed) ? memUsed : 0, limitBytes: memLimit },
      };
    } catch {
      // Any I/O hiccup — degrade silently to zero. The probe is best-effort.
      return baseline;
    }
  }

  /**
   * Resolve daemon binary version from runtime package.json. Cached after
   * first resolution; falls back to constructor override → '0.0.0'.
   *
   * The path probe walks `../package.json` first (which matches the layout
   * produced by `tsup` — dist/runner.js sits one level inside the package)
   * and then `../../package.json` (source-tree layout, where this file
   * lives in src/daemon/runner.ts). Either path resolves to the same
   * runtime package.json depending on whether the runner is executing
   * from a build or directly under tsx in tests.
   */
  private cachedDaemonVersion: string | null = null;
  private resolveDaemonVersion(): string {
    if (this.cachedDaemonVersion !== null) return this.cachedDaemonVersion;
    if (this.opts.daemonVersion) {
      this.cachedDaemonVersion = this.opts.daemonVersion;
      return this.cachedDaemonVersion;
    }
    const candidates = ['../package.json', '../../package.json'];
    try {
      const require = createRequire(import.meta.url);
      for (const candidate of candidates) {
        try {
          const pkg = require(candidate) as { name?: string; version?: string };
          if (pkg && pkg.name === '@prismer/runtime' && typeof pkg.version === 'string') {
            this.cachedDaemonVersion = pkg.version;
            return this.cachedDaemonVersion;
          }
        } catch {
          /* try next candidate */
        }
      }
    } catch {
      /* createRequire itself failed — extremely unlikely */
    }
    this.cachedDaemonVersion = '0.0.0';
    return this.cachedDaemonVersion;
  }

  /**
   * Re-read the local `agents` table (populated by `prismer agent register`)
   * and re-populate `hostedAgents` map. Profiles per agent come from local
   * `agent_profiles` table (filled by host.acked sync).
   */
  loadAgentsFromDb(): void {
    this.hostedAgents.clear();
    type AgentRow = { im_user_id: string; workspace_id: string; name: string; adapter_name: string; capabilities: string };
    type ProfileRow = { id: string; agent_im_user_id: string; version: number };
    const agents = this.db.prepare('SELECT * FROM agents').all() as AgentRow[];
    const profilesByAgent = new Map<string, Array<{ id: string; version: number }>>();
    const allProfiles = this.db
      .prepare('SELECT id, agent_im_user_id, version FROM agent_profiles WHERE deleted_at IS NULL')
      .all() as ProfileRow[];
    for (const p of allProfiles) {
      const list = profilesByAgent.get(p.agent_im_user_id) ?? [];
      list.push({ id: p.id, version: p.version });
      profilesByAgent.set(p.agent_im_user_id, list);
    }
    for (const a of agents) {
      if (this.rejectedHostedAgentIds.has(a.im_user_id)) {
        continue;
      }
      let caps: string[] = [];
      try {
        caps = JSON.parse(a.capabilities) as string[];
      } catch {
        caps = [];
      }
      this.setHostedAgent({
        imUserId: a.im_user_id,
        name: a.name,
        adapterName: a.adapter_name,
        capabilities: caps,
        profiles: profilesByAgent.get(a.im_user_id) ?? [],
      });
    }
  }

  private async prepareLocalProfiles(): Promise<void> {
    type ProfileRow = {
      id: string;
      workspace_id: string;
      agent_im_user_id: string;
      adapter_name: string;
      name: string;
      config: string;
      version: number;
      synced_at: number | null;
    };
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at
         FROM agent_profiles
         WHERE deleted_at IS NULL`,
      )
      .all() as ProfileRow[];

    for (const row of rows) {
      const adapter = this.registry.get(row.adapter_name);
      if (!adapter?.prepareProfile) continue;
      try {
        await adapter.prepareProfile({
          id: row.id,
          workspaceId: row.workspace_id,
          agentImUserId: row.agent_im_user_id,
          adapterName: row.adapter_name,
          name: row.name,
          config: parseProfileConfig(row.config),
          version: row.version,
          createdAt: new Date(row.synced_at ?? Date.now()),
          updatedAt: new Date(row.synced_at ?? Date.now()),
        });
      } catch (err) {
        process.stderr.write(
          `[daemon] local profile preflight skipped agent=${row.agent_im_user_id} profile=${row.id}: ${(err as Error).message}\n`,
        );
      }
    }
  }

  /**
   * Register an in-process AgentProfile snapshot (called by agent CLI / sync layer).
   * Used to populate the `agents` list in agent.host.declare.
   */
  setHostedAgent(agent: {
    imUserId: string;
    name: string;
    adapterName: string;
    capabilities: string[];
    profiles: Array<{ id: string; version: number }>;
  }): void {
    this.rejectedHostedAgentIds.delete(agent.imUserId);
    this.hostedAgents.set(agent.imUserId, {
      imUserId: agent.imUserId,
      name: agent.name,
      adapterName: agent.adapterName,
      capabilities: agent.capabilities,
      profiles: new Map(agent.profiles.map((p) => [p.id, p.version])),
    });
  }

  private async installHostedAgent(payload: InstallAgentPayload): Promise<InstallAgentResult> {
    const now = Date.now();
    const tx = this.db.transaction((p: InstallAgentPayload) => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO agents
           (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
           VALUES (?, ?, ?, ?, ?, 'offline', 1, ?, 0)`,
        )
        .run(p.imUserId, p.workspaceId, p.name, p.adapterName, JSON.stringify(p.capabilities), now);

      this.db
        .prepare(
          `INSERT OR REPLACE INTO agent_profiles
           (id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at, dirty, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(
          p.profile.id,
          p.workspaceId,
          p.imUserId,
          p.profile.adapterName,
          p.profile.name,
          JSON.stringify(p.profile.config ?? {}),
          p.profile.version,
          now,
        );
    });
    tx(payload);

    this.rejectedHostedAgentIds.delete(payload.imUserId);
    this.loadAgentsFromDb();
    if (this.wsConnected) this.sendDeclare();

    return {
      ok: true,
      daemonId: this.config.daemon_id,
      installedAgent: {
        imUserId: payload.imUserId,
        name: payload.name,
        adapterName: payload.adapterName,
        profileId: payload.profile.id,
      },
      hostedAgents: this.snapshotState().hostedAgents,
    };
  }

  private installStaticHostedAgentFromEnv(): void {
    const required = truthy(process.env.PRISMER_STATIC_BINDING_REQUIRED);
    const rawFile = process.env.PRISMER_HOSTED_AGENT_FILE;
    const rawJson = process.env.PRISMER_HOSTED_AGENT_JSON;

    let raw: string | undefined;
    if (rawFile) {
      if (!existsSync(rawFile)) {
        throw new Error(`PRISMER_HOSTED_AGENT_FILE not found: ${rawFile}`);
      }
      raw = readFileSync(rawFile, 'utf8');
    } else if (rawJson) {
      raw = rawJson;
    }

    if (!raw) {
      if (required) {
        throw new Error('static binding required, but PRISMER_HOSTED_AGENT_JSON/PRISMER_HOSTED_AGENT_FILE is missing');
      }
      return;
    }

    let payload: InstallAgentPayload;
    try {
      payload = validateStaticHostedAgent(JSON.parse(raw));
    } catch (err) {
      throw new Error(`invalid static hosted agent binding: ${(err as Error).message}`);
    }

    const now = Date.now();
    const tx = this.db.transaction((p: InstallAgentPayload) => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO agents
           (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
           VALUES (?, ?, ?, ?, ?, 'offline', 1, ?, 0)`,
        )
        .run(p.imUserId, p.workspaceId, p.name, p.adapterName, JSON.stringify(p.capabilities), now);

      this.db
        .prepare(
          `INSERT OR REPLACE INTO agent_profiles
           (id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at, dirty, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(
          p.profile.id,
          p.workspaceId,
          p.imUserId,
          p.profile.adapterName,
          p.profile.name,
          JSON.stringify(p.profile.config ?? {}),
          p.profile.version,
          now,
        );
    });
    tx(payload);
    process.stdout.write(
      `[daemon] static binding loaded agent=${payload.imUserId} profile=${payload.profile.id} adapter=${payload.adapterName}\n`,
    );
  }

  // ───────────────────────────── internals ─────────────────────────────

  private wireWsHandlers(): void {
    this.ws.on('open', () => {
      this.wsConnected = true;
      // The cloud accepts the API key via `?token=` on the WS upgrade URL but
      // resolves it asynchronously (DB hash lookup). Sending agent.host.declare
      // on `open` races that DB call and trips AUTH_REQUIRED. Wait for the
      // server's `authenticated` ack before issuing declare.
      process.stdout.write(`[daemon] ws open, awaiting server authenticated ack\n`);
    });
    this.ws.on('close', (code, reason) => {
      this.wsConnected = false;
      process.stdout.write(`[daemon] ws closed (code=${code ?? '?'}, reason=${reason ?? ''})\n`);
    });
    this.ws.on('error', (err: Error) => {
      process.stderr.write(`[daemon] ws error: ${err.message}\n`);
    });
    this.ws.on('auth-failed', () => {
      process.stderr.write(`[daemon] ws auth-failed (close code 4001) — check API key\n`);
      this.emit('auth-failed');
    });
    this.ws.on('reconnect-scheduled', (delayMs: number) => {
      process.stdout.write(`[daemon] ws reconnect in ${delayMs}ms\n`);
    });
    this.ws.on('message', (msg) => {
      const m = msg as { type?: string; payload?: { code?: string; message?: string } };
      if (m?.type) process.stdout.write(`[daemon] ws msg ← ${m.type}\n`);
      if (m?.type === 'error') {
        process.stderr.write(`[daemon] ws error payload: ${JSON.stringify(msg)}\n`);
        // Cloud sends an application-level AUTH_FAILED instead of WS close 4001
        // when the API key is invalid (post-handshake DB lookup failed). Treat
        // it like a transport-level auth-failed: surface to caller, stop loop.
        const code = m.payload?.code;
        if (code === 'AUTH_FAILED' || code === 'AUTH_REQUIRED' || code === 'auth_invalid') {
          process.stderr.write(`[daemon] application auth failure (${code}) — stopping daemon\n`);
          this.emit('auth-failed');
        }
      }
      if (m?.type === 'authenticated') {
        process.stdout.write(`[daemon] ws authenticated, sending agent.host.declare (${this.hostedAgents.size} agents)\n`);
        this.sendDeclare();
        // Wave-4 E7: on first post-authenticated tick, drain any pending
        // two-phase replies left over from a crash. Cold-start hook only —
        // re-running on every reconnect would be wasteful (server commits
        // are idempotent but the work is unnecessary).
        if (!this.pendingReplyRecoveryDone) {
          this.pendingReplyRecoveryDone = true;
          void recoverPendingReplies({ cloud: this.cloud, cache: this.pendingReplyCache })
            .then((summary) => {
              if (summary.attempted === 0) return;
              process.stdout.write(
                `[daemon] dispatch.recovery summary attempted=${summary.attempted} committed=${summary.committed} aborted=${summary.aborted} failed=${summary.failed}\n`,
              );
            })
            .catch((err: Error) => {
              process.stderr.write(`[daemon] dispatch.recovery threw: ${err.message}\n`);
            });
        }
        return;
      }
      this.handleIncoming(msg as { type: string; payload: unknown; requestId?: string });
    });
  }

  private sendDeclare(): void {
    const payload: AgentHostDeclarePayload = {
      daemonId: this.config.daemon_id,
      daemonVersion: this.opts.daemonVersion ?? '0.0.0',
      platform: platform() === 'win32' ? 'win32' : platform() === 'linux' ? 'linux' : 'darwin',
      agents: Array.from(this.hostedAgents.values()).map((a) => ({
        imUserId: a.imUserId,
        name: a.name,
        adapterName: a.adapterName,
        capabilities: a.capabilities,
        profiles: Array.from(a.profiles.entries()).map(([id, version]) => ({ id, version })),
      })),
    };
    this.ws.send(envelope('agent.host.declare', payload, this.config.daemon_id));
  }

  private handleIncoming(msg: { type: string; payload: unknown; requestId?: string }): void {
    switch (msg.type) {
      case 'host.acked':
        void this.onHostAcked(msg.payload as HostAckedPayload);
        return;
      case 'task.dispatch.request':
        void this.onTaskDispatch(msg.payload as TaskDispatchRequestPayload, msg.requestId);
        return;
      case 'task.cancel':
        this.onTaskCancel(msg.payload as TaskCancelPayload);
        return;
      case 'task.approval.resolve':
        // release201/25 §16.4 A6 — cloud forwards user approval choice
        // so we can additionally hit hermes-native /v1/runs/{id}/approval.
        // Best-effort: failures here do not propagate; the cloud-side
        // redispatch (approval.decided) is the authoritative continuation.
        void this.onTaskApprovalResolve(msg.payload as TaskApprovalResolvePayload);
        return;
      case 'task.clarify.resolve':
        // release202 — cloud forwards the user's clarify answer; we hit
        // hermes-native /v1/runs/{id}/clarify to resume the in-flight run
        // (held open across the clarify block — no re-dispatch needed).
        void this.onTaskClarifyResolve(msg.payload as TaskClarifyResolvePayload);
        return;
      case 'agent.changed':
        this.onAgentChanged(msg.payload as AgentChangedPayload);
        return;
      case 'agent_profile.changed':
        void this.onAgentProfileChanged(msg.payload as AgentProfileChangedPayload);
        return;
      case 'workspace.changed':
        void this.onWorkspaceChanged(msg.payload as WorkspaceChangedPayload);
        return;
      case 'workspace.clear.daemon-cleanup':
        // release201/09 §9.4b — cloud finished cascade; wipe the local
        // hermes profile memories + per-agent memory dir that survive
        // server-side delete. Best-effort: failures stderr-log but never
        // propagate (cloud rows are already gone).
        void this.onWorkspaceClearDaemonCleanup(
          msg.payload as WorkspaceClearDaemonCleanupPayload,
        );
        return;
      case 'workspace_file.changed':
        this.onWorkspaceFileChanged(msg.payload as WorkspaceFileChangedPayload);
        return;
      case 'asset.changed':
        void this.onAssetChanged(msg.payload as AssetChangedPayload);
        return;
      // v2.0 §4.8.1 (Wave 4-E4) — webhook reverse-channel RPC. Cloud's
      // dispatchExternalMention pushes an AgentDispatchRequest plus an
      // embedded `_rpcId`; the daemon runs the same handler as the
      // HTTP /dispatch path and echoes the reply back over WS with the
      // identical `_rpcId` so cloud's WsRpcService can settle the
      // pending promise.
      case 'webhook.dispatch.request':
        void this.onWebhookDispatch(msg.payload as AgentDispatchRequest & { _rpcId?: string });
        return;
      // release201/24 §3 — cloud pushes a queued eval run over the reverse
      // channel. We ack immediately (mirrors webhook.dispatch) and run the
      // eval asynchronously; per-case results flow back via the cloud
      // /eval/runs/:runId/finish HTTP endpoint (EvalSessionRunner.onFinish).
      case 'skill.eval.request':
        void this.onEvalRequest(msg.payload as EvalRequestPayload);
        return;
      default:
        this.emit('unknown-message', msg);
    }
  }

  /**
   * v2.0 §4.8.1 — webhook dispatch over WS reverse channel.
   *
   * Acks via `webhook.dispatch.reply { _rpcId, ok, acceptedAt }` immediately
   * after `handleAgentMessageDispatch()` returns its synchronous response
   * — the actual reply (the agent's reply text/attachments) still flows
   * through `postMessageDispatchReply()` which posts to
   * `/api/im/dispatch/reply` after the adapter finishes. That mirrors the
   * HTTP /dispatch contract: ack first, asynchronous final reply via the
   * dispatch-reply REST endpoint.
   *
   * The `_rpcId` field is the only addition versus the HTTP path; we strip
   * it before passing the payload to the dispatch handler so existing
   * validation logic doesn't trip on an unknown field.
   */
  private async onWebhookDispatch(
    payload: AgentDispatchRequest & { _rpcId?: string },
  ): Promise<void> {
    const rpcId = payload._rpcId;
    if (!rpcId) {
      process.stderr.write(`[daemon] webhook.dispatch.request without _rpcId — dropped\n`);
      return;
    }
    // Strip the RPC envelope field so the dispatch handler sees a plain
    // AgentDispatchRequest.
    const { _rpcId: _, ...request } = payload;

    try {
      const handle = handleAgentMessageDispatch(request as AgentDispatchRequest, {
        findAgent: (agentImUserId) => this.findMessageDispatchAgent(agentImUserId),
        postReply: (replyPayload) => this.postMessageDispatchReply(replyPayload),
        onError: (err, req) => {
          process.stderr.write(
            `[daemon] webhook.dispatch.request failed message=${req.messageId} agent=${req.mentionedAgentImUserId}: ${
              err instanceof Error ? err.stack ?? err.message : String(err)
            }\n`,
          );
        },
      });
      // Synchronous ack — daemon accepted the dispatch and is now running
      // the adapter. The final reply lands via postMessageDispatchReply().
      this.ws.send({
        type: 'webhook.dispatch.reply',
        payload: {
          _rpcId: rpcId,
          ok: handle.response.ok,
          acceptedAt: handle.response.acceptedAt,
          error: handle.response.error,
        },
      });
      // Fire-and-forget — log final-reply failures but don't block the
      // RPC reply (which has already been sent).
      void handle.done.catch((err) => {
        process.stderr.write(
          `[daemon] webhook.dispatch final reply failed message=${request.messageId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
    } catch (err) {
      // Synchronous handler failure (rare — validation happens above). Send
      // an immediate non-ok reply so the cloud RPC settles with daemon_error
      // instead of timing out.
      this.ws.send({
        type: 'webhook.dispatch.reply',
        payload: {
          _rpcId: rpcId,
          ok: false,
          error: {
            code: 'daemon_dispatch_failed',
            message: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }
  }

  /**
   * release201/24 §3 — handle a cloud-pushed eval run. Ack immediately over
   * the reverse channel (so cloud's WsRpcService settles), then run the eval
   * asynchronously. Per-case results are POSTed by EvalSessionRunner.onFinish.
   */
  private async onEvalRequest(payload: EvalRequestPayload): Promise<void> {
    const rpcId = payload._rpcId;
    const req: EvalStartRequest = {
      runId: payload.runId,
      skillId: payload.skillId,
      skillSlug: payload.skillSlug ?? payload.skillId,
      skillManifest: Array.isArray(payload.skillManifest) ? payload.skillManifest : [],
      allowlistBuiltins: payload.allowlistBuiltins,
      testCases: Array.isArray(payload.testCases) ? payload.testCases : [],
      scratchEnv: payload.scratchEnv,
    };

    // Validate minimally before acking. A malformed request acks non-ok so
    // cloud can mark the run errored instead of waiting on a timeout.
    if (!req.runId || !req.skillId || req.testCases.length === 0) {
      if (rpcId) {
        this.ws.send({
          type: 'skill.eval.reply',
          payload: { _rpcId: rpcId, ok: false, error: { code: 'eval_request_invalid', message: 'missing runId/skillId/testCases' } },
        });
      }
      return;
    }

    if (rpcId) {
      this.ws.send({
        type: 'skill.eval.reply',
        payload: { _rpcId: rpcId, ok: true, acceptedAt: new Date().toISOString() },
      });
    }

    process.stdout.write(
      `[daemon] eval accept run=${req.runId} skill=${req.skillId.slice(-8)} cases=${req.testCases.length}\n`,
    );

    // Fire-and-forget — the runner POSTs results to cloud when finished.
    void this.evalRunner
      ?.start(req)
      .catch((err) => process.stderr.write(`[daemon] eval run=${req.runId} threw: ${(err as Error).message}\n`));
  }

  private async onHostAcked(payload: HostAckedPayload): Promise<void> {
    this.workspaceId = payload.workspaceId;
    const ownershipLockChanged = await this.applyHostAckOwnershipLock(payload);

    // v2.0 §4.8.1 (Wave 4-E4) — transport probe. We submit it on every
    // host.acked because the workspaceId / container row is only addressable
    // after handshake. Best-effort: failures are logged but do not interrupt
    // boot — the dispatch path falls back to WS-first behaviour even when
    // the report never lands (cloud will still derive recommendedTransport
    // from im_containers.gatewayUrl + isPrivateIpToCloud()).
    void this.reportTransport().catch((err) => {
      process.stderr.write(
        `[daemon] transport-probe report failed: ${(err as Error).message}\n`,
      );
    });

    // Initial memory sync: now that workspaceId is known, populate local
    // MemoryStore from cloud. This is the primary trigger for the desktop
    // daemon flow (the startup sync in start() is a no-op until workspaceId
    // is set here). Fire-and-forget — failure is non-fatal.
    if (this.memoryWiring && this.workspaceId) {
      syncMemoryFromCloud(this.memoryWiring, this.cloud, [this.workspaceId]).catch(
        (err: Error) => log.error('Initial memory sync failed', err.message),
      );
    }

    // Asset sync triggered by host.acked (primary trigger for desktop daemon
    // flow, same pattern as memory sync above). This catches up metadata and
    // path bindings; bytes remain lazy unless explicitly prefetched.
    this.syncAssetState(this.workspaceId).catch(
      (err: Error) => log.error('Asset sync failed', err.message),
    );
    await this.ensureDropFolderRuntime(this.workspaceId);

    const profilesToSync = payload.profilesToSync ?? [];
    const profilesToDelete = payload.profilesToDelete ?? [];

    for (const id of profilesToSync) {
      try {
        await this.servicePool.drop(id);
        await this.syncProfileFromCloud(id);
      } catch (err) {
        this.emit('sync-error', err);
      }
    }
    // Tombstones: profiles the daemon cached locally but that were
    // soft-deleted on the cloud while this daemon was offline.
    for (const id of profilesToDelete) {
      const row = this.db.prepare('SELECT agent_im_user_id FROM agent_profiles WHERE id = ?').get(id) as { agent_im_user_id: string } | undefined;
      this.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
      if (row) {
        this.db.prepare('DELETE FROM agents WHERE im_user_id = ?').run(row.agent_im_user_id);
      }
      process.stderr.write(`[daemon] tombstone profile=${id}\n`);
    }
    if (profilesToDelete.length) this.loadAgentsFromDb();
    if ((ownershipLockChanged || profilesToSync.length > 0 || profilesToDelete.length > 0) && this.wsConnected) {
      this.sendDeclare();
    }
    this.emit('host-acked', payload);
  }

  private async applyHostAckOwnershipLock(payload: HostAckedPayload): Promise<boolean> {
    const rejected = payload.rejectedAgents ?? [];
    if (rejected.length === 0) return false;

    let changed = false;
    for (const rejection of rejected) {
      if (!rejection?.imUserId) continue;
      const agentImUserId = rejection.imUserId;
      this.rejectedHostedAgentIds.set(agentImUserId, {
        ...rejection,
        rejectedAt: Date.now(),
      });

      const wasHosted = this.hostedAgents.delete(agentImUserId);
      const profiles = this.db
        .prepare('SELECT id FROM agent_profiles WHERE agent_im_user_id = ?')
        .all(agentImUserId) as Array<{ id: string }>;
      const deleted = this.db.prepare('DELETE FROM agents WHERE im_user_id = ?').run(agentImUserId);
      await Promise.all(profiles.map((profile) => this.servicePool.drop(profile.id)));

      if (wasHosted || deleted.changes > 0) {
        changed = true;
        process.stderr.write(
          `[daemon] ownership rejected agent=${agentImUserId} reason=${rejection.reason} owner=${rejection.ownerDaemonId ?? '(unknown)'} — stop declaring locally\n`,
        );
      }
    }
    return changed;
  }

  private async onTaskDispatch(payload: TaskDispatchRequestPayload, requestId?: string): Promise<void> {
    const targetDaemonId = readTargetDaemonId(payload);
    if (targetDaemonId && targetDaemonId !== this.config.daemon_id) {
      process.stdout.write(
        `[daemon] dispatch skip task=${payload.taskId} targetDaemonId=${targetDaemonId} local=${this.config.daemon_id}\n`,
      );
      return;
    }
    // Cloud's redispatchPending fires on every reconnect / heartbeat redeclare,
    // so the same taskId can arrive 5+ times while a long LLM call is in
    // flight. Dedupe on the daemon side by taskId — the in-flight dispatch
    // will eventually send task.dispatch.reply and clear the entry.
    if (this.runningTasks.has(payload.taskId)) {
      process.stdout.write(`[daemon] dispatch dup task=${payload.taskId} (already in-flight, skipping)\n`);
      return;
    }
    process.stdout.write(
      `[daemon] dispatch start task=${payload.taskId} route=${payload.runtimeRoute ?? 'agent'} agent=${payload.agentImUserId ?? '-'} daemon=${payload.targetDaemonId ?? '-'}\n`,
    );
    const ctrl = new AbortController();
    this.runningTasks.set(payload.taskId, {
      ctrl,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 0,
    });
    try {
      if (isShellDispatch(payload)) {
        const reply = await executeShellDispatch(payload, {
          config: this.shellConfig,
          workspaceId: this.workspaceId,
          signal: ctrl.signal,
          onProgress: (progressPayload) => {
            const running = this.runningTasks.get(payload.taskId);
            if (running) running.lastProgressAt = Date.now();
            this.ws.send(envelope('task.dispatch.progress', progressPayload));
          },
        });
        this.ws.send(envelope('task.dispatch.reply', reply, requestId));
        if (!reply.ok) {
          const code = reply.error?.code ?? 'unknown';
          const message = reply.error?.message ?? 'unknown error';
          process.stderr.write(`[daemon] dispatch failed task=${payload.taskId} code=${code} message=${message}\n`);
        }
      } else {
        const reply = await handleDispatch(payload, requestId, {
          registry: this.registry,
          cloud: this.cloud,
          uriResolver: this.uriResolver,
          assetCache: this.assetCache,
          ws: this.ws,
          artifactsWatcher: this.artifactsWatcher,
          paths: this.paths,
          daemonId: this.config.daemon_id,
          signal: ctrl.signal,
          ensureService: (profile, adapter) => this.servicePool.ensureService(profile, adapter),
          assetMetadataIndexes: this.assetMetadataIndexes,
          onProgress: () => {
            const running = this.runningTasks.get(payload.taskId);
            if (running) running.lastProgressAt = Date.now();
          },
        });
        if (!reply.ok) {
          const code = reply.error?.code ?? 'unknown';
          const message = reply.error?.message ?? 'unknown error';
          process.stderr.write(`[daemon] dispatch failed task=${payload.taskId} code=${code} message=${message}\n`);
        }
      }
      process.stdout.write(`[daemon] dispatch done task=${payload.taskId}\n`);
    } catch (err) {
      this.lastTaskError = {
        taskId: payload.taskId,
        message: (err as Error).message,
        at: new Date().toISOString(),
      };
      process.stderr.write(`[daemon] dispatch threw task=${payload.taskId}: ${(err as Error).stack ?? (err as Error).message}\n`);
    } finally {
      this.runningTasks.delete(payload.taskId);
    }
  }

  private onTaskCancel(payload: TaskCancelPayload): void {
    const entry = this.runningTasks.get(payload.taskId);
    if (entry) entry.ctrl.abort();
  }

  /**
   * release201/25 §16.4 A6 — additionally call hermes-native
   * `POST /v1/runs/{runId}/approval` so hermes-internal HITL state
   * (session-level "always" cache, pending approval timer) aligns with
   * the cloud-side decision. The cloud-side redispatch (approval.decided)
   * is still the authoritative continuation; this is the SECOND write
   * to keep hermes in sync.
   *
   * Best-effort and tolerant: any failure (no runId / no hermes service /
   * capability missing / hermes 4xx) is logged but never propagated. The
   * agent will still receive its `approval.decided` task dispatch.
   */
  private async onTaskApprovalResolve(payload: TaskApprovalResolvePayload): Promise<void> {
    try {
      const registry = this.runSessionRegistry;
      if (!registry) {
        process.stderr.write(
          `[daemon] task.approval.resolve: no run-session registry yet, skipping (task=${payload.taskId})\n`,
        );
        return;
      }
      const ctx = registry.lookupByTaskId(payload.taskId);
      if (!ctx || ctx.adapterName !== 'hermes') {
        process.stderr.write(
          `[daemon] task.approval.resolve: no hermes run for task=${payload.taskId} (skipping native forward)\n`,
        );
        return;
      }
      // The agent is a hosted agent on this daemon; iterate its profiles
      // and pick the first cached hermes service. Multiple hermes profiles
      // per agent are uncommon today (typically 1 profile per agent),
      // but if it happens we prefer the one whose profileName matches the
      // run-session row.
      const hosted = this.hostedAgents.get(payload.agentImUserId);
      if (!hosted) {
        process.stderr.write(
          `[daemon] task.approval.resolve: agent ${payload.agentImUserId} not hosted here, skipping\n`,
        );
        return;
      }
      let hermesService: HermesService | null = null;
      for (const [profileId] of hosted.profiles) {
        const svc = this.servicePool.peek(profileId);
        if (!svc) continue;
        if (svc instanceof HermesService) {
          // Prefer profileName-matched service when there are multiple.
          if (svc.profileName === ctx.profileName) {
            hermesService = svc;
            break;
          }
          hermesService ??= svc;
        }
      }
      if (!hermesService) {
        process.stderr.write(
          `[daemon] task.approval.resolve: no live HermesService for agent=${payload.agentImUserId}, skipping native forward\n`,
        );
        return;
      }
      const res = await hermesService.resolveApproval(
        ctx.runId,
        payload.choice,
        payload.resolveAll,
      );
      if (!res.ok) {
        process.stderr.write(
          `[daemon] task.approval.resolve: hermes native resolve failed run=${ctx.runId} choice=${payload.choice}: ${res.error ?? '<no error>'}\n`,
        );
      } else {
        process.stdout.write(
          `[daemon] task.approval.resolve: hermes native resolve ok run=${ctx.runId} choice=${payload.choice}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[daemon] task.approval.resolve threw (best-effort, ignoring): ${(err as Error).message}\n`,
      );
    }
  }

  // release202 — clarify resolve forwarding. Mirrors onTaskApprovalResolve
  // but calls hermes-native resolveClarify (carries the user's answer) to
  // resume the in-flight, held-open run. The dispatch that surfaced the
  // clarify.request is still awaiting the SSE stream; resolving here unblocks
  // it server-side so that same dispatch completes with the full output.
  private async onTaskClarifyResolve(payload: TaskClarifyResolvePayload): Promise<void> {
    try {
      const registry = this.runSessionRegistry;
      if (!registry) {
        process.stderr.write(
          `[daemon] task.clarify.resolve: no run-session registry yet, skipping (task=${payload.taskId})\n`,
        );
        return;
      }
      const ctx = registry.lookupByTaskId(payload.taskId);
      if (!ctx || ctx.adapterName !== 'hermes') {
        process.stderr.write(
          `[daemon] task.clarify.resolve: no hermes run for task=${payload.taskId} (skipping)\n`,
        );
        return;
      }
      const hosted = this.hostedAgents.get(payload.agentImUserId);
      if (!hosted) {
        process.stderr.write(
          `[daemon] task.clarify.resolve: agent ${payload.agentImUserId} not hosted here, skipping\n`,
        );
        return;
      }
      let hermesService: HermesService | null = null;
      for (const [profileId] of hosted.profiles) {
        const svc = this.servicePool.peek(profileId);
        if (!svc) continue;
        if (svc instanceof HermesService) {
          if (svc.profileName === ctx.profileName) {
            hermesService = svc;
            break;
          }
          hermesService ??= svc;
        }
      }
      if (!hermesService) {
        process.stderr.write(
          `[daemon] task.clarify.resolve: no live HermesService for agent=${payload.agentImUserId}, skipping\n`,
        );
        return;
      }
      const res = await hermesService.resolveClarify(
        payload.runId ?? ctx.runId,
        payload.response,
        payload.clarifyId,
      );
      if (!res.ok) {
        process.stderr.write(
          `[daemon] task.clarify.resolve: hermes native resolve failed run=${ctx.runId} clarify=${payload.clarifyId}: ${res.error ?? '<no error>'}\n`,
        );
      } else {
        process.stdout.write(
          `[daemon] task.clarify.resolve: hermes native resolve ok run=${ctx.runId} clarify=${payload.clarifyId}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[daemon] task.clarify.resolve threw (best-effort, ignoring): ${(err as Error).message}\n`,
      );
    }
  }

  private findMessageDispatchAgent(agentImUserId: string): MessageDispatchAgent | null {
    if (!this.hostedAgents.has(agentImUserId)) return null;
    return {
      agentImUserId,
      dispatch: async (input) => {
        // v2.0 (A4) — register the external-channel dispatch in
        // runningTasks so the daemon's reaper, /tasks/running snapshot,
        // and task.cancel can see it. Without this, a hanging external
        // dispatch is invisible: reaper can't abort it, /tasks/running
        // excludes it, task.cancel can't reach it. The taskId is already
        // `external:<messageId>` (set by message-dispatch.ts), so it can
        // be filtered out of the GET /tasks/running endpoint by prefix
        // if needed downstream.
        //
        // We bridge `input.signal` (owned by message-dispatch.ts's own
        // timeout) into our own controller so a task.cancel from cloud
        // can abort the dispatch via our controller, AND an external
        // timeout from message-dispatch.ts still aborts via the signal.
        const externalCtrl = new AbortController();
        if (input.signal) {
          if (input.signal.aborted) {
            externalCtrl.abort();
          } else {
            input.signal.addEventListener('abort', () => externalCtrl.abort(), { once: true });
          }
        }
        this.runningTasks.set(input.taskId, {
          ctrl: externalCtrl,
          startedAt: Date.now(),
          lastProgressAt: Date.now(),
          timeoutMs: input.timeoutMs ?? 0,
        });
        try {
          const reply = await handleDispatch(
            {
              taskId: input.taskId,
              agentImUserId,
              profileId: '',
              capability: 'external-channel.message',
              prompt: input.prompt,
              timeoutMs: input.timeoutMs,
              conversationId: input.metadata.conversationId,
              metadata: input.metadata,
            },
            undefined,
            {
              registry: this.registry,
              cloud: this.cloud,
              uriResolver: this.uriResolver,
              assetCache: this.assetCache,
              // /dispatch replies are posted via postMessageDispatchReply();
              // do not also emit task.dispatch.reply for synthetic task IDs.
              ws: { send: () => undefined } as unknown as WsClient,
              artifactsWatcher: this.artifactsWatcher,
              paths: this.paths,
              daemonId: this.config.daemon_id,
              signal: externalCtrl.signal,
              ensureService: (profile, adapter) => this.servicePool.ensureService(profile, adapter),
              assetMetadataIndexes: this.assetMetadataIndexes,
              onProgress: () => {
                const running = this.runningTasks.get(input.taskId);
                if (running) running.lastProgressAt = Date.now();
              },
            },
          );
          return {
            ok: reply.ok,
            output: reply.output,
            error: reply.error,
            metrics: reply.metrics,
            metadata: reply.assetIds?.length ? { assetIds: reply.assetIds } : undefined,
          };
        } finally {
          this.runningTasks.delete(input.taskId);
        }
      },
    };
  }

  private async postMessageDispatchReply(payload: AgentDispatchReplyPayload): Promise<void> {
    // Wave-4 E7 — two-phase reply path (W3 §4.3). The HTTP dispatch reply taken
    // by message-dispatch.ts for external-channel agents now goes through
    // prepare → commit instead of the legacy single-shot `/dispatch/reply`.
    //
    // taskId derivation: message-dispatch.ts assigns synthetic
    // `external:<messageId>` taskIds (see runner.ts findMessageDispatchAgent
    // → handleDispatch input.taskId). The server's prepare endpoint reads
    // taskId from the URL path so we pass the synthetic id verbatim. Server
    // accepts any non-empty string for taskId (the `im_tasks` row may or may
    // not exist for external channels — message.dispatch.ts persistAgentDispatchReply
    // already handles the no-task-row case for legacy /reply, and the new
    // commit path calls the same `messageService.send` collaborator).
    //
    // The legacy code path is retained on the server through 2026-09-01
    // (Sunset header) but new daemon installs go straight to prepare/commit.
    const taskId = `external:${payload.replyToMessageId}`;
    try {
      const result = await sendDispatchReplyTwoPhase({
        taskId,
        payload: {
          conversationId: payload.conversationId,
          replyToken: payload.replyToken,
          replyToMessageId: payload.replyToMessageId,
          agentImUserId: payload.agentImUserId,
          status: payload.status,
          ...(payload.replyText !== undefined ? { replyText: payload.replyText } : {}),
          ...(payload.attachments ? { attachments: payload.attachments } : {}),
          assetIds:
            payload.attachments?.map((a) => a.assetId).filter((id): id is string => typeof id === 'string') ?? [],
          completedAt: payload.completedAt,
          ...(payload.error ? { error: payload.error } : {}),
        },
        cloud: this.cloud,
        cache: this.pendingReplyCache,
      });
      if (result.status === 'aborted') {
        // Server-side reaper killed the row before we could commit. Surface
        // as a hard failure so the local-server caller can log/escalate.
        throw new Error(`dispatch reply aborted by server reaper (replyId=${result.replyId})`);
      }
    } catch (err) {
      throw new Error(
        (err as Error).message?.length ? (err as Error).message : `dispatch reply failed`,
      );
    }
  }

  /**
   * v2.0 §4.8.1 (Wave 4-E4) — submit the transport-probe report. Called
   * from `onHostAcked` so the daemon's container row exists in cloud
   * before we POST to /runtime/transport-report.
   *
   * The gatewayUrl reported here is `http://<local-ipv4>:<localPort>`
   * (typically `http://192.168.x.x:3210`). For a daemon without a local
   * HTTP server (startLocalServer=false in tests) we still post the
   * probe with `gatewayUrl=null` so cloud knows transport='ws' is the
   * only path.
   */
  private async reportTransport(): Promise<void> {
    const hasLocalServer = this.opts.startLocalServer !== false;
    let gatewayUrl: string | null = null;
    if (hasLocalServer) {
      const localIp = pickLocalIPv4();
      if (localIp) {
        const port = this.opts.localPort ?? DEFAULT_LOCAL_PORT;
        gatewayUrl = `http://${localIp}:${port}`;
      }
    }
    const probe = buildTransportProbe(gatewayUrl);
    const result = await reportTransportProbe(this.cloud, this.config.daemon_id, probe);
    if (!result.ok) {
      process.stderr.write(
        `[daemon] transport-probe report rejected status=${result.status} error=${result.error ?? '-'}\n`,
      );
      return;
    }
    process.stdout.write(
      `[daemon] transport-probe reported transport=${probe.transport} gateway=${probe.gatewayUrl ?? 'null'} private=${probe.gatewayIsPrivate}\n`,
    );
  }

  private onAgentChanged(payload: AgentChangedPayload): void {
    const a = this.hostedAgents.get(payload.agentImUserId);
    if (!a) return;
    if (typeof payload.fields.displayName === 'string') a.name = payload.fields.displayName;
    if (Array.isArray(payload.fields.capabilities)) a.capabilities = payload.fields.capabilities;
  }

  private async onAgentProfileChanged(payload: AgentProfileChangedPayload): Promise<void> {
    try {
      await this.servicePool.drop(payload.profileId);
      await this.syncProfileFromCloud(payload.profileId);
      // F16 (2026-05-20) — after pulling the new profile config, also refresh
      // the agent's skill files. Pre-F16 the skill set could only update at
      // the next task dispatch, so any cloud-side skill change was invisible
      // until somebody used the agent.
      const profileRow = this.db
        .prepare(
          `SELECT id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at
           FROM agent_profiles WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(payload.profileId) as
        | {
            id: string;
            workspace_id: string;
            agent_im_user_id: string;
            adapter_name: string;
            name: string;
            config: string;
            version: number;
            synced_at: number | null;
          }
        | undefined;
      if (profileRow) {
        try {
          const profile: AgentProfile = {
            id: profileRow.id,
            workspaceId: profileRow.workspace_id,
            agentImUserId: profileRow.agent_im_user_id,
            adapterName: profileRow.adapter_name,
            name: profileRow.name,
            config: parseProfileConfig(profileRow.config),
            version: profileRow.version,
            createdAt: new Date(profileRow.synced_at ?? Date.now()),
            updatedAt: new Date(profileRow.synced_at ?? Date.now()),
          };
          const result = await syncInstalledSkillsForDispatch(
            profile,
            profile.agentImUserId,
            this.cloud,
            undefined,
            { paths: this.paths, daemonId: this.config?.daemon_id },
          );
          // release201/09 §9.1 — refresh `profile.json` snapshot on every
          // profile-changed event so cloud's role-template / config changes
          // land on disk for transfer + debug.
          const daemonId = this.config?.daemon_id;
          if (daemonId) {
            try {
              writeAgentProfileSnapshot(this.paths, daemonId, {
                agentId: profile.id,
                agentImUserId: profile.agentImUserId,
                agentUsername: profile.agentUsername ?? null,
                workspaceId: profile.workspaceId,
                adapterName: profile.adapterName,
                name: profile.name,
                config: profile.config,
                snapshotAt: new Date().toISOString(),
              });
            } catch (err) {
              process.stderr.write(
                `[daemon] profile.json snapshot failed agent=${profile.agentImUserId}: ${(err as Error).message}\n`,
              );
            }
          }
          if (result.synced > 0 || result.skipped > 0) {
            process.stdout.write(
              `[daemon] skill sync (profile-changed): profile=${profile.id} synced=${result.synced} unchanged=${result.unchanged} skipped=${result.skipped}\n`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `[daemon] skill sync (profile-changed) failed profile=${payload.profileId}: ${(err as Error).message}\n`,
          );
        }
      }
      if (this.wsConnected) this.sendDeclare();
    } catch (err) {
      this.emit('sync-error', err);
    }
  }

  private async syncProfileFromCloud(profileId: string): Promise<void> {
    let profile: AgentProfile;
    try {
      profile = await this.cloud.get<AgentProfile>(`/api/im/agent_profiles/${encodeURIComponent(profileId)}`);
    } catch (err) {
      if (err instanceof CloudError && err.status === 404) {
        // Profile was soft-deleted on the server — remove from local DB so
        // the daemon stops trying to dispatch tasks to a dead profile.
        const row = this.db.prepare('SELECT agent_im_user_id FROM agent_profiles WHERE id = ?').get(profileId) as { agent_im_user_id: string } | undefined;
        this.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(profileId);
        if (row) {
          this.db.prepare('DELETE FROM agents WHERE im_user_id = ?').run(row.agent_im_user_id);
        }
        this.loadAgentsFromDb();
        return;
      }
      throw err;
    }
    const agent = await this.resolveOwnedAgent(profile.agentImUserId);
    const adapter = this.registry.get(profile.adapterName);
    const capabilities = agent?.card?.capabilities?.length
      ? agent.card.capabilities
      : (adapter?.capabilities ?? []);
    const name = agent?.card?.name || agent?.displayName || agent?.username || profile.agentImUserId;
    const now = Date.now();

    const tx = this.db.transaction(() => {
      if (this.rejectedHostedAgentIds.has(profile.agentImUserId)) {
        this.db.prepare('DELETE FROM agents WHERE im_user_id = ?').run(profile.agentImUserId);
      } else {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO agents
             (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
             VALUES (?, ?, ?, ?, ?, 'offline', 1, ?, 0)`,
          )
          .run(
            profile.agentImUserId,
            profile.workspaceId,
            name,
            profile.adapterName,
            JSON.stringify(capabilities),
            now,
          );
      }

      this.db
        .prepare(
          `INSERT OR REPLACE INTO agent_profiles
           (id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at, dirty, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(
          profile.id,
          profile.workspaceId,
          profile.agentImUserId,
          profile.adapterName,
          profile.name,
          JSON.stringify(profile.config ?? {}),
          profile.version,
          now,
        );
    });
    tx();
    try {
      await adapter?.prepareProfile?.(profile);
    } catch (err) {
      process.stderr.write(
        `[daemon] profile preflight skipped agent=${profile.agentImUserId} profile=${profile.id}: ${(err as Error).message}\n`,
      );
    }
    this.loadAgentsFromDb();
    process.stdout.write(
      `[daemon] profile synced agent=${profile.agentImUserId} profile=${profile.id} adapter=${profile.adapterName}\n`,
    );
  }

  private async resolveOwnedAgent(agentImUserId: string): Promise<OwnedAgentDTO | null> {
    try {
      const agents = await this.cloud.get<OwnedAgentDTO[]>('/api/im/me/agents');
      return agents.find((agent) => agent.id === agentImUserId) ?? null;
    } catch (err) {
      process.stderr.write(
        `[daemon] owned agent lookup skipped agent=${agentImUserId}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  private async onWorkspaceChanged(payload: WorkspaceChangedPayload): Promise<void> {
    if (payload.workspaceId !== this.workspaceId) return;
    try {
      await this.cloud.get(`/api/im/workspaces/${encodeURIComponent(payload.workspaceId)}`);
    } catch (err) {
      this.emit('sync-error', err);
    }
  }

  /**
   * release201/09 §9.4b — wipe local hermes profile memories + per-agent
   * memory dir for every agent the cloud says belonged to the cleared
   * workspace. Cloud has already deleted the cloud-side rows (cascade
   * ordering: cloud-first, daemon-second), so this fan-out is purely
   * local-FS cleanup. Best-effort: every failure stderr-logs and continues.
   *
   * Resolution: iterate local agent_profiles rows whose agent_im_user_id
   * appears in payload.agentImUserIds; for each, derive the hermes profile
   * name via getHermesProfileName (same call site spawn / configure uses)
   * and call wipeHermesProfileMemory. Then for every agent_im_user_id,
   * wipe ~/.prismer/devices/<did>/agents/<aid>/memory/* (skills/ stays).
   *
   * We do NOT delete agent_profiles rows from local SQLite here — that
   * happens via the existing agent_profile.changed (delete) flow which the
   * cloud also emits as part of workspace clear (im_agent_profiles rows
   * are deleted by clearWorkspaceCascade). This handler is purely the
   * filesystem-layer counterpart of those Prisma deletes.
   */
  private async onWorkspaceClearDaemonCleanup(
    payload: WorkspaceClearDaemonCleanupPayload,
  ): Promise<void> {
    const { workspaceId, agentImUserIds } = payload;
    if (!agentImUserIds || agentImUserIds.length === 0) {
      process.stdout.write(
        `[daemon] workspace.clear.daemon-cleanup ws=${workspaceId}: no agent ids in payload, skipping\n`,
      );
      return;
    }

    // 1. enumerate local agent_profiles for these agents so we can resolve
    //    hermes profile names exactly the same way ensureService does.
    //    Local SQLite doesn't carry `agent_username`, but the per-agent
    //    profile.json snapshot (written by writeAgentProfileSnapshot at
    //    skill-sync time, §9.1) does. We read profile.json when present so
    //    getHermesProfileName picks the same name spawn used; otherwise we
    //    fall through with agentUsername=undefined and the
    //    profile.id.slice(0,8) fallback in getHermesProfileName matches.
    let profileRows: Array<{
      id: string;
      agent_im_user_id: string;
      adapter_name: string;
      config: string;
    }> = [];
    try {
      const placeholders = agentImUserIds.map(() => '?').join(',');
      profileRows = this.db
        .prepare(
          `SELECT id, agent_im_user_id, adapter_name, config
             FROM agent_profiles
            WHERE agent_im_user_id IN (${placeholders})`,
        )
        .all(...agentImUserIds) as typeof profileRows;
    } catch (err) {
      process.stderr.write(
        `[daemon] workspace.clear.daemon-cleanup ws=${workspaceId}: local profile lookup failed: ${
          (err as Error).message
        }\n`,
      );
    }

    const daemonIdForSnapshot = this.config?.daemon_id;
    const readAgentUsernameFromSnapshot = (agentImUserId: string): string | undefined => {
      if (!daemonIdForSnapshot || !this.paths?.root) return undefined;
      try {
        const agentRoot = resolveDeviceAgentDir(this.paths, daemonIdForSnapshot, agentImUserId);
        const snapshotFile = join(agentRoot, 'profile.json');
        if (!existsSync(snapshotFile)) return undefined;
        const raw = readFileSync(snapshotFile, 'utf8');
        const parsed = JSON.parse(raw) as { agentUsername?: string | null };
        return typeof parsed.agentUsername === 'string' && parsed.agentUsername.length > 0
          ? parsed.agentUsername
          : undefined;
      } catch {
        return undefined;
      }
    };

    let hermesProfilesWiped = 0;
    for (const row of profileRows) {
      if (row.adapter_name !== 'hermes') continue;
      try {
        const agentUsername = readAgentUsernameFromSnapshot(row.agent_im_user_id);
        const profileName = getHermesProfileName({
          id: row.id,
          agentUsername,
          config: parseProfileConfig(row.config),
        });
        const results = wipeHermesProfileMemory(profileName);
        const removed = results.filter((r) => r.status === 'removed').length;
        const failed = results.filter((r) => r.status === 'failed').length;
        hermesProfilesWiped++;
        process.stdout.write(
          `[daemon] workspace.clear.daemon-cleanup ws=${workspaceId} agent=${row.agent_im_user_id} hermes-profile=${profileName} removed=${removed} failed=${failed}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[daemon] workspace.clear.daemon-cleanup ws=${workspaceId} agent=${row.agent_im_user_id}: hermes wipe threw: ${
            (err as Error).message
          }\n`,
        );
      }
    }

    // 2. wipe ~/.prismer/devices/<did>/agents/<aid>/memory/* for every
    //    agent id, regardless of adapter (per-agent memory dir is created
    //    by ensureAgentDir for all adapters; safe to no-op if absent).
    const daemonId = this.config?.daemon_id;
    let agentMemoryDirsWiped = 0;
    if (daemonId && this.paths?.root) {
      for (const agentImUserId of agentImUserIds) {
        try {
          const agentRoot = resolveDeviceAgentDir(this.paths, daemonId, agentImUserId);
          const memDir = join(agentRoot, 'memory');
          if (existsSync(memDir)) {
            // rmSync recursive — does NOT touch profile.json / skills/ /
            // outbox/ which live at the agent root level. memory/ is the
            // only subdir we own here.
            rmSync(memDir, { recursive: true, force: true });
            agentMemoryDirsWiped++;
          }
        } catch (err) {
          process.stderr.write(
            `[daemon] workspace.clear.daemon-cleanup ws=${workspaceId} agent=${agentImUserId}: per-agent memory wipe failed: ${
              (err as Error).message
            }\n`,
          );
        }
      }
    }

    process.stdout.write(
      `[daemon] workspace.clear.daemon-cleanup ws=${workspaceId} done: hermes-profiles=${hermesProfilesWiped} agent-memory-dirs=${agentMemoryDirsWiped} agents=${agentImUserIds.length}\n`,
    );
  }

  private async onAssetChanged(payload: AssetChangedPayload): Promise<void> {
    if (!payload.workspaceId) return;
    try {
      await this.syncAssetState(payload.workspaceId, { forceMetadata: true });
    } catch (err) {
      log.error(`asset.changed sync failed workspace=${payload.workspaceId}: ${(err as Error).message}`);
    }
  }

  private onWorkspaceFileChanged(payload: WorkspaceFileChangedPayload): void {
    if (payload.operation === 'delete') {
      this.db
        .prepare('DELETE FROM workspace_files_mirror WHERE workspace_id = ? AND path = ?')
        .run(payload.workspaceId, payload.path);
      return;
    }
    if (payload.assetId && payload.contentHash) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO workspace_files_mirror
           (workspace_id, path, asset_id, content_hash, version, synced_at, dirty)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          payload.workspaceId,
          payload.path,
          payload.assetId,
          payload.contentHash,
          payload.version,
          Date.now(),
        );
      this.syncAssetMetadata(payload.workspaceId, { force: true }).catch((err: Error) => {
        log.error(`workspace_file.changed asset metadata sync failed workspace=${payload.workspaceId}: ${err.message}`);
      });
    }
  }

  private snapshotAdapterObservability(): Record<string, unknown> {
    const agents = Array.from(this.hostedAgents.values());
    const counts = agents.reduce<Record<string, number>>((acc, agent) => {
      acc[agent.adapterName] = (acc[agent.adapterName] ?? 0) + 1;
      return acc;
    }, {});
    return {
      hostedCounts: counts,
      servicePoolSize: this.servicePool?.size() ?? 0,
      hermes: {
        hostedAgents: counts.hermes ?? 0,
        runningTaskIds: Array.from(this.runningTasks.keys()),
      },
    };
  }

  private snapshotAssetSyncObservability(): Record<string, unknown> {
    return {
      workspaceId: this.dropFolderWorkspaceId || null,
      rootDir: this.dropFolderWorkspaceDir || null,
      dropDir: this.dropFolderWorkspaceDir ? join(this.dropFolderWorkspaceDir, 'drop') : null,
      uploadedDir: this.dropFolderWorkspaceDir ? join(this.dropFolderWorkspaceDir, 'uploaded') : null,
      failedDir: this.dropFolderWorkspaceDir ? join(this.dropFolderWorkspaceDir, 'upload-failed') : null,
    };
  }

  /**
   * Ensure an AssetMetadataIndex exists for the given workspace and pull
   * delta from cloud. Idempotent — creates the index on first call, reuses
   * it on subsequent calls. Same cursor-catch-up semantics as WorkspaceMirror.
   */
  private async syncAssetMetadata(workspaceId: string, opts?: { force?: boolean }): Promise<void> {
    let index = this.assetMetadataIndexes.get(workspaceId);
    if (!index) {
      const stateDir = `${this.paths.root}/${workspaceId}`;
      index = new AssetMetadataIndex({
        db: this.db,
        cloud: this.cloud,
        workspaceId,
        workspaceStateDir: stateDir,
      });
      this.assetMetadataIndexes.set(workspaceId, index);
    }
    const result = await index.pullDelta({ force: opts?.force });
    if (result.applied > 0) {
      assetMetaLog.info(`workspace=${workspaceId}: ${result.applied} applied, cursor=${result.cursor}`);
    }
  }

  /**
   * Ensure a WorkspaceMirror exists for the workspace and pull path→asset
   * bindings from cloud. Cold-start daemons previously only had this table
   * populated by WS push or per-path URI fallback, so local asset state looked
   * empty even though cloud files existed.
   */
  private async syncWorkspaceFiles(workspaceId: string): Promise<void> {
    let mirror = this.workspaceMirrors.get(workspaceId);
    if (!mirror) {
      const stateDir = `${this.paths.root}/${workspaceId}`;
      mirror = new WorkspaceMirror({
        db: this.db,
        cloud: this.cloud,
        workspaceId,
        workspaceStateDir: stateDir,
      });
      this.workspaceMirrors.set(workspaceId, mirror);
    }
    const result = await mirror.pullDelta();
    if (result.applied > 0) {
      workspaceFilesLog.info(`workspace=${workspaceId}: ${result.applied} applied, cursor=${result.cursor ?? 'null'}`);
    }
  }

  private async syncAssetState(workspaceId: string, opts?: { forceMetadata?: boolean }): Promise<void> {
    if (!this.paths?.root) return;
    await Promise.all([
      this.syncAssetMetadata(workspaceId, { force: opts?.forceMetadata }),
      this.syncWorkspaceFiles(workspaceId),
    ]);
  }

  /**
   * Desktop asset ingress: watch a user-visible local asset folder
   * and upload new files as IMAssets, preserving nested relative dirs in
   * IMAsset.folderPath. The lower-level adapter/outbox/uploader already
   * existed; this method wires them into the real daemon lifecycle.
   */
  private async ensureDropFolderRuntime(workspaceId: string): Promise<void> {
    if (!workspaceId || !this.paths?.root) return;
    if (this.dropFolderWorkspaceId === workspaceId && this.dropFolderTimer) return;

    this.stopDropFolderRuntime();
    this.dropFolderWorkspaceId = workspaceId;
    const workspaceRoot = resolveUserAssetWorkspaceDir(workspaceId);
    this.dropFolderWorkspaceDir = workspaceRoot;
    await mkdir(join(workspaceRoot, 'drop'), { recursive: true });
    await mkdir(join(workspaceRoot, 'uploaded'), { recursive: true });
    await mkdir(join(workspaceRoot, 'upload-failed'), { recursive: true });

    this.assetOriginOutbox = new OriginOutbox({ dbPath: join(this.paths.root, 'asset-origin.db') });
    this.dropFolderAdapter = new DropFolderAdapter({ workspaceDir: workspaceRoot });
    this.dropFolderUploadRunner = new UploadRunner({
      outbox: this.assetOriginOutbox,
      cloud: new DaemonAssetUploadClient({ cloudApiBase: this.config.cloud_api_base, apiKey: this.config.api_key }),
      adapters: { 'drop-folder': this.dropFolderAdapter as OriginAdapter },
      maxAttempts: 3,
    });

    const tick = () => {
      this.runDropFolderTick().catch((err: Error) => {
        process.stderr.write(`[daemon] drop-folder sync failed: ${err.message}\n`);
      });
    };
    this.dropFolderTimer = setInterval(tick, 1000);
    tick();
    process.stdout.write(`[daemon] drop-folder asset sync watching ${join(workspaceRoot, 'drop')}\n`);
  }

  private stopDropFolderRuntime(): void {
    if (this.dropFolderTimer) {
      clearInterval(this.dropFolderTimer);
      this.dropFolderTimer = undefined;
    }
    try {
      this.assetOriginOutbox?.close();
    } catch {
      /* ignore */
    }
    this.assetOriginOutbox = undefined;
    this.dropFolderAdapter = undefined;
    this.dropFolderUploadRunner = undefined;
    this.dropFolderWorkspaceId = '';
    this.dropFolderWorkspaceDir = '';
    this.dropFolderTickInFlight = false;
    this.dropFolderStable.clear();
  }

  private async runDropFolderTick(): Promise<void> {
    if (this.dropFolderTickInFlight) return;
    const workspaceId = this.dropFolderWorkspaceId;
    const adapter = this.dropFolderAdapter;
    const outbox = this.assetOriginOutbox;
    const runner = this.dropFolderUploadRunner;
    if (!workspaceId || !adapter || !outbox || !runner) return;

    this.dropFolderTickInFlight = true;
    try {
      const observations = await adapter.scanOnce(workspaceId);
      for (const obs of observations) {
        const id = await adapter.identifySource(obs);
        if (!this.isDropFolderObservationStable(id.sourceRef, obs.detail)) continue;
        outbox.enqueue({
          workspaceId: obs.workspaceId,
          originKind: 'drop-folder',
          sourceRef: id.sourceRef,
          payloadJson: JSON.stringify(obs.detail),
          hintsJson: JSON.stringify(id.hints ?? {}),
          observedAt: obs.observedAt,
        });
      }
      const processed = await runner.drainOnce();
      if (processed > 0) {
        this.dropFolderStable.clear();
        process.stdout.write(`[daemon] drop-folder uploaded/processed ${processed} asset(s)\n`);
        await this.syncAssetState(workspaceId).catch(
          (err: Error) => process.stderr.write(`[daemon] drop-folder post-sync failed: ${err.message}\n`),
        );
      }
    } finally {
      this.dropFolderTickInFlight = false;
    }
  }

  private isDropFolderObservationStable(sourceRef: string, detail: unknown): boolean {
    const raw = detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    const size = typeof raw.size === 'number' ? raw.size : -1;
    const mtime = typeof raw.mtime === 'number' ? raw.mtime : -1;
    const previous = this.dropFolderStable.get(sourceRef);
    this.dropFolderStable.set(sourceRef, { size, mtime });
    return Boolean(previous && previous.size === size && previous.mtime === mtime);
  }

  /**
   * SyncWorker FlushFn — pushes local writes to cloud.
   *
   * Maps:
   *   workspace      → PATCH /api/im/workspaces/:id
   *   agent_profile  → PATCH /api/im/agent_profiles/:id
   *   agent          → PATCH /api/im/agents/:imUserId
   * On 'create' we POST instead. On 'delete' we DELETE.
   */
  /**
   * SyncWorker FlushFn — pushes one local sync row to cloud via CloudClient.
   *
   * resource_type × operation → endpoint:
   *   workspace.create      → POST   /api/im/workspaces
   *   workspace.update      → PATCH  /api/im/workspaces/:id
   *   workspace.delete      → DELETE /api/im/workspaces/:id
   *   agent.create          → POST   /api/im/register   (the only public path
   *                                                       that creates an
   *                                                       IMUser of role='agent')
   *   agent.update          → PATCH  /api/im/agents/:id
   *   agent.delete          → DELETE /api/im/agents/:id
   *   agent_profile.create  → POST   /api/im/agent_profiles
   *   agent_profile.update  → PATCH  /api/im/agent_profiles/:id
   *   agent_profile.delete  → DELETE /api/im/agent_profiles/:id
   *
   * Error classification per docs/refactor/13-error-handling.md §2.1 / §2.7:
   *   2xx           → ok:true   (SyncWorker drops the row)
   *   408 / 429     → retryable (SyncWorker re-queues with exponential backoff)
   *   5xx / net err → retryable
   *   4xx (other)   → permanent (SyncWorker marks failed; 409 is conflict)
   */
  private async flushSyncRow(row: SyncQueueRow): Promise<{ ok: boolean; status?: number; message?: string }> {
    const op = `${row.resource_type}.${row.operation}`;
    const id = encodeURIComponent(row.resource_id);
    const body = row.operation === 'delete' ? undefined : safeJsonParse(row.payload);

    let method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    let path: string;
    switch (op) {
      case 'workspace.create':
        method = 'POST'; path = '/api/im/workspaces'; break;
      case 'workspace.update':
        method = 'PATCH'; path = `/api/im/workspaces/${id}`; break;
      case 'workspace.delete':
        method = 'DELETE'; path = `/api/im/workspaces/${id}`; break;
      // agent.create must use /register — POST /api/im/agents is not exposed.
      case 'agent.create':
        method = 'POST'; path = '/api/im/register'; break;
      case 'agent.update':
        method = 'PATCH'; path = `/api/im/agents/${id}`; break;
      case 'agent.delete':
        method = 'DELETE'; path = `/api/im/agents/${id}`; break;
      case 'agent_profile.create':
        method = 'POST'; path = '/api/im/agent_profiles'; break;
      case 'agent_profile.update':
        method = 'PATCH'; path = `/api/im/agent_profiles/${id}`; break;
      case 'agent_profile.delete':
        method = 'DELETE'; path = `/api/im/agent_profiles/${id}`; break;
      default:
        process.stderr.write(`[daemon] sync flush op=${op} id=${row.id} result=drop (unknown op)\n`);
        return { ok: false, status: 400, message: `Unknown sync op: ${op}` };
    }

    let res: CloudResponse<unknown>;
    try {
      res = await this.cloud.request(method, path, { body });
    } catch (err) {
      // CloudClient.request normally maps net errors to {ok:false, status:0};
      // this catch is a safety net for unexpected throws.
      process.stderr.write(
        `[daemon] sync flush op=${op} id=${row.id} result=retry (threw: ${(err as Error).message})\n`,
      );
      return { ok: false, status: 0, message: (err as Error).message };
    }

    let label: 'ok' | 'retry' | 'drop';
    if (res.ok) {
      label = 'ok';
    } else if (res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500) {
      label = 'retry';
    } else {
      // 4xx — including 409. SyncWorker maps 409 → conflict, others → failed_other.
      label = 'drop';
    }
    process.stdout.write(
      `[daemon] sync flush op=${op} id=${row.id} result=${label}${res.ok ? '' : ` status=${res.status}`}\n`,
    );
    return { ok: res.ok, status: res.status, message: res.error?.message };
  }
}

function resolveUserAssetWorkspaceDir(workspaceId: string): string {
  const override = process.env.PRISMER_ASSET_SYNC_ROOT;
  if (override) return join(override, workspaceId);
  const home = homedir();
  const desktop = join(home, 'Desktop');
  const base = existsSync(desktop) ? desktop : home;
  return join(base, 'Prismer Assets', workspaceId);
}

function readTargetDaemonId(payload: TaskDispatchRequestPayload): string | null {
  if (typeof payload.targetDaemonId === 'string' && payload.targetDaemonId.length > 0) {
    return payload.targetDaemonId;
  }
  const execution = payload.metadata?.execution;
  if (execution && typeof execution === 'object' && !Array.isArray(execution)) {
    const value = (execution as Record<string, unknown>).targetDaemonId;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
  return null;
}

function truthy(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function validateStaticHostedAgent(raw: unknown): InstallAgentPayload {
  if (!raw || typeof raw !== 'object') throw new Error('binding must be a JSON object');
  const obj = raw as Record<string, unknown>;
  const profile = obj.profile as Record<string, unknown> | undefined;
  const capabilities = obj.capabilities;
  if (typeof obj.workspaceId !== 'string' || obj.workspaceId.length === 0) throw new Error('workspaceId is required');
  if (typeof obj.imUserId !== 'string' || obj.imUserId.length === 0) throw new Error('imUserId is required');
  if (typeof obj.name !== 'string' || obj.name.length === 0) throw new Error('name is required');
  if (typeof obj.adapterName !== 'string' || obj.adapterName.length === 0) throw new Error('adapterName is required');
  if (!Array.isArray(capabilities) || capabilities.some((v) => typeof v !== 'string')) {
    throw new Error('capabilities must be a string array');
  }
  if (!profile || typeof profile !== 'object') throw new Error('profile is required');
  if (typeof profile.id !== 'string' || profile.id.length === 0) throw new Error('profile.id is required');
  if (typeof profile.name !== 'string' || profile.name.length === 0) throw new Error('profile.name is required');
  if (typeof profile.adapterName !== 'string' || profile.adapterName.length === 0) {
    throw new Error('profile.adapterName is required');
  }
  if (profile.config !== undefined && (!profile.config || typeof profile.config !== 'object' || Array.isArray(profile.config))) {
    throw new Error('profile.config must be a JSON object');
  }
  return {
    workspaceId: obj.workspaceId,
    imUserId: obj.imUserId,
    name: obj.name,
    adapterName: obj.adapterName,
    capabilities,
    profile: {
      id: profile.id,
      name: profile.name,
      adapterName: profile.adapterName,
      config: (profile.config ?? {}) as Record<string, unknown>,
      version: typeof profile.version === 'number' && Number.isFinite(profile.version) ? profile.version : 1,
    },
  };
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseProfileConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

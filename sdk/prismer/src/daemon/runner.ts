// Daemon main loop. Wires WsClient + SyncWorker + AdapterRegistry + LocalServer.
// See docs/refactor/04-daemon-runtime.md §启动流程.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import type { AdapterDef, AdapterService, AgentProfile } from '../adapters/contract.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { claudeCodeAdapter } from '../adapters/coding/claude-code/index.js';
import { setLocalProviders } from '../adapters/shared/local-provider.js';
import { codexAdapter } from '../adapters/coding/codex/index.js';
import { buildCodingDriverAdapters } from '../adapters/coding/shared/register.js';
import { buildRuntimeAgentEngineAdapters } from '../adapters/runtime-engine/shared/register.js';
import { hermesAdapter, HermesService } from '../adapters/persistence/hermes/index.js';
import { ensureCloudCliShim } from '../adapters/persistence/hermes/cloud-cli-shim.js';
import { HERMES_MEMORY_TOOLS } from '../adapters/persistence/hermes/memory-tools.js';
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
  resolveProjectReposDir,
  saveConfig,
} from '../config.js';
import { envelope } from '../envelope.js';
import { openLocalDb, type LocalDb } from '../sync/store.js';
import { SyncQueue, type SyncQueueRow } from '../sync/sync-queue.js';
import { SyncWorker } from '../sync/sync-worker.js';
import type {
  AgentChangedPayload,
  AssetChangedPayload,
  AgentHostDeclarePayload,
  AgentHostWithdrawPayload,
  AgentProfileChangedPayload,
  HostAckedPayload,
  RejectedHostedAgent,
  TaskApprovalResolvePayload,
  TaskClarifyResolvePayload,
  TaskCancelPayload,
  AssetMaterializeRequestPayload,
  RuntimeUpdateApplyPayload,
  RuntimeUpdateReplyPayload,
  AgentSessionSetModelPayload,
  AgentSessionListCommandsPayload,
  AgentSessionRewindPayload,
  TaskDispatchRequestPayload,
  WorkspaceChangedPayload,
  WorkspaceClearDaemonCleanupPayload,
  WorkspaceFileChangedPayload,
} from '../types/im-events.js';
import { UriResolver } from '../uri-resolver.js';
import { createLogger } from '../lib/logger.js';
import {
  mountDeviceMetrics,
  resolveDeviceMetricsIntervalMs,
  RUNTIME_CAPABILITY_DEVICE_METRICS,
  type DeviceMetricsModule,
} from './device-metrics/index.js';
import {
  mountTerminalSessions,
  resolveTerminalIdleTimeoutMs,
  resolveTerminalOutputBudget,
  defaultTerminalOutputBudget,
  disabledTerminalOutputBudget,
  RUNTIME_CAPABILITY_TERMINAL,
  type TerminalSessionsModule,
} from './terminal-sessions/index.js';
import { handleDispatch } from './dispatch.js';
import { evaluateRuntimeUpdateDirection } from './runtime-update-direction.js';
import { listReposDir } from './fs-list.js';
import { readReposFile } from './fs-read.js';
import { writeReposFile } from './fs-write.js';
import { isSafeSegment } from './path-jail.js';
import {
  ensureWorkdir,
  resolveWorkdirCwd,
  WorkdirMaterializeError,
  type MaterializeSource,
} from './workdir-materialize.js';
import {
  remoteAllowlistFromEnv,
  runGitExecRequest,
  type GitExecPayload,
} from './git-rpc.js';
import { handleAgentSessionControl, type AgentSessionControlKind } from './agent-session-control.js';
import { EvalSessionRunner, type EvalStartRequest, type EvalTestCase } from './eval-session.js';
import { createHermesEvalSpawner } from './eval-hermes-spawner.js';
import {
  LocalServer,
  type InstallAgentPayload,
  type InstallAgentResult,
  type LocalServerState,
  type QuarantinedProfile,
} from './local-server.js';
import { openReadModel } from './gateway/read-model.js';
import { LocalRelay } from './gateway/local-relay.js';
import { Materializer } from './gateway/materializer.js';
import { LocalGateway, resolveGatewayConfig } from './gateway/gateway.js';
import { WsRealtimeSubscriber } from './gateway/ws-realtime-subscriber.js';
import { OutboxWriter } from './gateway/outbox-writer.js';
import { OnlineStateTracker } from './gateway/online-state.js';
import type { MessageDispatchAgent } from './message-dispatch.js';
import { attachMemoryRunner, syncMemoryFromCloud, type MemoryRunnerWiring } from './memory/runner-wiring.js';
// memory211/01 W3 轴D — upload→corpus ingestion (local T3 mirror + cloud upload).
import { ingestAssetFile } from './memory/asset-chunks.js';
import { MetricOutboxReplayWorker } from './metric-outbox-replay.js';
import { attachMemoryRpc } from './memory/rpc.js';
import { attachWebRpc } from './web/rpc.js';
import { attachPkfRpc } from './pkf/rpc.js';
import { attachAdminObservabilityRpc } from './admin-observability/rpc.js';
import { takeAdminObservabilityCloud } from './admin-observability/credential.js';
import { HostAckCatchupGate } from './host-ack-catchup-gate.js';
import {
  attachHookServer,
  extractDurablePostTurn,
  type ProfileResolver,
} from './memory/hook-server.js';
import { recallStatsSnapshot } from './memory/recall-stats.js';
import { RunSessionRegistry, setRunSessionRegistry } from './memory/run-session-map.js';
import {
  RunCheckpointStore,
  setRunCheckpointStore,
} from './memory/run-checkpoint-store.js';
import { runCheckpointResumeScan } from './run-resume.js';
import { daemonMetricEmit } from './metric-emit.js';
import { HermesSessionMapper, setHermesSessionMapper } from '../adapters/persistence/hermes/sessions-mapper.js';
import {
  setHermesCloudIO,
  type HermesCloudMessageRow,
} from '../adapters/persistence/hermes/cloud-io.js';
import { ProviderSessionMapper, setProviderSessionMapper } from './provider-session-mapper.js';
import {
  getHermesProfileName,
  getHermesProfileDir,
  wipeHermesProfileMemory,
  stopHermesGatewayForProfile,
} from '../adapters/persistence/hermes/index.js';
import {
  fetchBootstrapBundle,
  bootstrapTargetAfterAuthenticated,
  applyBundle,
  computeBootstrapErrorAction,
  createBootstrapState,
  resetBootstrapStopped,
  shouldRetryBootstrapAfterAcceptedDeclare,
  toApplyState,
  drainBeforeGatewayKill,
  bootstrapConfigSnapshot,
  runtimeBehaviorFingerprint,
  authorityActorMintableGained,
  MEMORY_AUTHORITY_REFRESH_INTERVAL_MS,
  type BootstrapState,
} from './config-bootstrap.js';
import { snapshotSkillResolutionHealth } from './skill-source-resolution.js';
import { PostTurnStore } from '../adapters/coding/shared/lifecycle/post-turn-store.js';
import { PostTurnWorker } from '../adapters/coding/shared/lifecycle/post-turn-worker.js';
import {
  DurabilityCommitStore,
  PreReplyDurabilityBarrier,
} from '../adapters/coding/shared/lifecycle/pre-reply-durability.js';
import {
  TerminalFinalizer,
  setTerminalFinalizer,
  synthesizeHostCrashedTurns,
} from '../adapters/coding/shared/lifecycle/terminal-finalizer.js';
import { ExtractedPageApplicator } from './memory/extracted-page-applicator.js';
import { memoryOutboxHealthSnapshot } from './memory/outbox-worker.js';
import { canonicalDurabilityCommitKey } from '../adapters/coding/shared/lifecycle/canonical-turn-identity.js';
import {
  registerMemoryAuthoritySnapshot,
  getMemoryAuthoritySnapshot,
  invalidateMemoryAuthoritySnapshot,
  MEMORY_RUNTIME_CAPABILITIES_V1,
} from './memory/cap.js';
import { AssetMetadataIndex } from './asset/metadata-index.js';
import { WorkspaceMirror } from './asset/mirror.js';
import { attachAssetRpc } from './asset/rpc.js';
import { MirrorManager } from './asset/mirror-manager.js';
import { attachMirrorRpc } from './asset/mirror-rpc.js';
import { attachDeliver } from './asset/deliver.js';
import { attachCheckpointServer } from './checkpoint-server.js';
import { migrateLegacyTaskWorkdirs } from './task-workdir-migration.js';
import { DropFolderAdapter } from './asset/origin/drop-folder.js';
import { AgentGenAdapter } from './asset/origin/agent-gen.js';
import { OriginOutbox, snapshotOriginOutboxCounts, type OriginOutboxCounts } from './asset/origin/outbox.js';
import { DaemonAssetUploadClient, UploadRunner } from './asset/origin/upload-runner.js';
import type { OriginAdapter } from './asset/origin/spi.js';
import { ArtifactsWatcher } from './artifacts-watcher.js';
import { DeclareGuard } from './declare-guard.js';
import { ServicePool } from './service-pool.js';
import { executeShellDispatch, isShellDispatch, resolveShellConfig, type ShellExecutionConfig } from './shell-executor.js';
import {
  resolveSkillsRoot,
  syncAllAgentSkills,
  syncInstalledSkillsForDispatch,
  withPerAgentSkillsDir,
} from './skill-sync.js';
import {
  validatePkfRuntimeCapability,
  type PkfRuntimeCapabilityReport,
  type PkfRuntimeCapabilityTrigger,
} from './pkf-runtime-capability.js';
import { writeDeviceJson } from './device-dir.js';
import { resolveDaemonKind, resolveDaemonLabel } from './device-identity.js';
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
import { DaemonHeartbeat } from './daemon-heartbeat.js';
import { readRuntimeOtaSnapshot, type RuntimeOtaSnapshot } from './ota/runtime-state.js';

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

export function isRuntimeTemplateMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.PRISMER_TEMPLATE_MODE === 'true';
}

/**
 * desktop204 D204-4 — caller's intent to announce a graceful offline on stop.
 * Only intentional shutdowns pass this (SIGTERM/SIGINT from ⌘Q, `prismer daemon
 * stop`, uninstall). A crash, an auth failure, or the version-skew respawn do
 * NOT withdraw — the daemon is coming back with the same daemonId and the
 * binding should stay put.
 */
export interface WithdrawIntent {
  reason: 'user-quit' | 'app-uninstall' | 'transfer-out';
  /** Flush budget for the withdraw frame. Default {@link WITHDRAW_FLUSH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface StopOptions {
  withdraw?: WithdrawIntent;
}

/**
 * Hard cap on how long stop() may spend flushing the withdraw frame. Quit must
 * never hang on an unreachable cloud: the desktop shell only grants the daemon
 * a few seconds of SIGTERM grace before SIGKILL, and an offline laptop's socket
 * write can otherwise sit in the kernel buffer indefinitely.
 */
const WITHDRAW_FLUSH_TIMEOUT_MS = 1_500;
const HOST_ACK_ADOPTION_CONCURRENCY = 3;

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

/**
 * product209/07 §3.6.2 — does this container env carry NO trustworthy API key
 * (the ACS keyless-at-boot world where Hermes config can ONLY come from the
 * B1 bundle)? Exported pure for tests; see Runner#isKeylessSandboxContainer
 * for the full rationale (bugfix211 G2: the ALLOW_FAKE image default lied for
 * workspace pods that hold a real sk-prismer-live- credential).
 */
export function containerEnvIsKeyless(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PRISMER_RUNTIME_MODE !== 'container') return false;
  const key = (env.PRISMER_API_KEY ?? '').trim();
  return !key.startsWith('sk-prismer-live-');
}

export class Runner extends EventEmitter {
  private runtimeOtaSnapshot?: RuntimeOtaSnapshot;
  private config!: Config;
  private paths!: ConfigPaths;
  private db!: LocalDb;
  private cloud!: CloudClient;
  private adminObservabilityCloud?: CloudClient;
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
  // B-P1a — first reader of the per-agent metrics.jsonl offline outbox
  // (daemonMetricEmit's cloud-unreachable fallback). Drains it into
  // /api/im/metrics/batch at-least-once; created + stopped in start()/shutdown.
  private metricOutboxReplay?: MetricOutboxReplayWorker;
  private postTurnStore?: PostTurnStore;
  private postTurnWorker?: PostTurnWorker;
  private durabilityCommitStore?: DurabilityCommitStore;
  private preReplyDurabilityBarrier?: PreReplyDurabilityBarrier;
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
  // Phase 6 / M1 — local IM gateway (docs/desktop202/13). Capability bit,
  // default OFF (CLI/K8s daemons leave these undefined). When enabled, the
  // relay + materializer are wired and the WS loop taps message/conversation/
  // task events into the read model; the LocalServer mounts the gateway's
  // GET /api/im/* SWR routes + local SSE mirror.
  private localGateway?: LocalGateway;
  private gatewayRelay?: LocalRelay;
  private gatewayMaterializer?: Materializer;
  // Phase 8a / M2 — optimistic write path (13 §7). Built only when the gateway
  // is enabled; routes im_message/task_mutation outbox rows through the shared
  // sync-queue + sync-worker and performs the ack remap.
  private gatewayOutbox?: OutboxWriter;
  // Phase 6 / M1 — daemon→cloud SSE subscriber that feeds the materializer
  // real-time IM events (cloud does NOT broadcast message.new onto the daemon
  // WS; data rides the user's SSE channel). An *additional* read connection
  // alongside the WS (which only carries dispatch/host frames). Built + started
  // only when the gateway is enabled; see ./gateway/ws-realtime-subscriber.ts.
  private gatewaySse?: WsRealtimeSubscriber;
  // Phase 8b / M3 — cloud-reachability aggregation (docs/desktop202/11 §2 M3,
  // 13 §6/§9). Aggregates SSE connection state + SWR revalidate outcomes into
  // online/degraded/offline; surfaced on /healthz (cloudReachable) and drives
  // offline reads + recovery flush. Built only when the gateway is enabled.
  private gatewayOnline?: OnlineStateTracker;
  // desktop202/17 Phase 9 — local asset mirror (named ~/Prismer dir + index +
  // materialize/edit-roundtrip/conflict/multi-device refresh). Capability bit,
  // default OFF: built only when `config.mirror` is set or PRISMER_MIRROR_ENABLED=1
  // (desktop daemon). CLI/K8s daemons leave it undefined → no mirror layer.
  private mirrorManager?: MirrorManager;
  private assetMetadataIndexes = new Map<string, AssetMetadataIndex>();
  private workspaceMirrors = new Map<string, WorkspaceMirror>();
  private assetOriginOutbox?: OriginOutbox;
  /** product210/03 W1-3 (R12) — terminal silent archive uploader for inline PKF deliverables. */
  private pkfArchiveUpload?: DaemonAssetUploadClient;
  /**
   * desktop205/04 §4 (W13) — last sample of the origin-outbox backlog, pushed
   * into /healthz by `snapshotState`. Sampled by the drop-folder tick (which
   * already touches that db every second), NEVER read inside the healthz
   * handler: healthz is a zero-I/O in-memory projection that the desktop Tray
   * polls on a timer. `undefined` ⇔ no origin outbox wired (CLI / K8s / no
   * workspace bound) ⇒ healthz omits the field entirely (absent ≠ zero).
   */
  private assetOutboxCounts?: OriginOutboxCounts;
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
  /**
   * F1-b (2026-07-27) — workspace the CONTROLLER (desktop main process) told us
   * to declare into, at runtime. Distinct from `workspaceId` on purpose:
   *   - `workspaceId` is cloud's answer (set from `host.acked`) and from the
   *     boot-time `PRISMER_WORKSPACE_ID` env,
   *   - `workspaceOverride` is the live user intent, and must OUTRANK the env,
   *     which is frozen at spawn and therefore stale the moment the user
   *     switches workspaces without restarting the daemon.
   * Empty ⇒ no override, legacy precedence (env → cloud's echo) applies.
   */
  private workspaceOverride = '';
  private wsConnected = false;
  private readonly hostedAgents = new Map<string, HostedAgent>();
  private readonly rejectedHostedAgentIds = new Map<string, RejectedHostedAgent & { rejectedAt: number }>();
  private readonly runningTasks = new Map<
    string,
    {
      ctrl: AbortController;
      startedAt: number;
      lastProgressAt: number;
      timeoutMs: number;
      /**
       * desktop205/04 §4 (W13) — descriptive fields for the desktop Tray's
       * "当前在跑什么" line. Purely additive: nothing in the dispatch / reaper /
       * cancel paths reads them. All optional because the external-channel
       * dispatch path knows less than the cloud dispatch path.
       */
      agentName?: string;
      kind?: 'run' | 'task' | 'shell' | 'external';
      scopeLabel?: string;
    }
  >();
  /**
   * S-B5 (2026-07-15) — profiles whose skill set changed via a NON-dispatch
   * sync path (profile-changed broadcast / periodic background). Those paths
   * write skill files + ack revision but CANNOT safely kill the gateway
   * (they run outside the serial dispatch queue → could murder an in-flight
   * run, per the §5.4 reaper / kill-signal-is-not-death lesson). Instead they
   * set this flag; the next dispatch (serial, safe — it kills the PREVIOUS
   * run's leftover gateway then respawns) consumes it and re-spawns the
   * gateway so the new/deleted skill is visible. Without this, a background
   * sync writes the file + acks revision → next dispatch sees `synced==0`
   * (file already matches) → guard short-circuits → gateway never re-scans
   * → skill invisible until something else restarts it.
   */
  private readonly skillDirtyProfiles = new Set<string>();
  /** product209 Phase 6 — immutable host receipts keyed by active profile. */
  private readonly pkfRuntimeCapabilities = new Map<string, PkfRuntimeCapabilityReport>();
  private cloudCliAvailable = false;
  private pkfCoreAvailable = false;
  /**
   * desktop205 R2 — profiles the cloud has positively told us are **not ours
   * anymore** (404 + `error.code === 'forbidden'`: the row exists, the
   * workspace changed hands). In-memory projection of the durable
   * `agent_profiles.quarantined_at` column, rebuilt by `loadAgentsFromDb()`
   * (the single choke point every profile mutation already goes through).
   *
   * Kept in memory on purpose: the dispatch gate is on the hot path and
   * `/healthz` is a zero-I/O snapshot the desktop Tray polls — neither may
   * open the db. The db stays the truth; this map is the projection.
   *
   * Keyed by profileId. Cleared per-profile the moment a sync gets a 200 back.
   */
  private readonly quarantinedProfiles = new Map<string, QuarantinedProfile>();
  // product209/07 — ConfigDelivery bootstrap state (B1 fetch + apply).
  // Keyed by workspaceId: each workspace has its own configVersion, backoff,
  // and stop reason — a 401 on workspace A must not block workspace B (§3.6).
  private readonly bootstrapStates = new Map<string, BootstrapState>();
  private memoryAuthorityRefreshTimer?: NodeJS.Timeout;
  // §3.7.1 key rotation recovery: consecutive hermes dispatch 401 count
  private consecutiveDispatch401 = 0;
  private lastTaskError?: { taskId: string; message: string; at: string };
  private heartbeatTimer?: NodeJS.Timeout;
  // 09 §3.3 — daemon-heartbeat file writer for sandbox-manager liveness monitoring
  private daemonHeartbeat?: DaemonHeartbeat;
  // product206/13 §4-R5 — classification + backoff + blocked state for cloud
  // refusals of `agent.host.declare`. Constructed in start() because its whole
  // ladder is expressed in the declare tick. See declare-guard.ts.
  private declareGuard!: DeclareGuard;
  private readonly hostAckCatchupGate = new HostAckCatchupGate();
  private taskReaperTimer?: NodeJS.Timeout;
  // F16 (2026-05-20) — periodic skill resync timer (default 10min).
  private skillResyncTimer?: NodeJS.Timeout;
  private skillSyncInFlight = false;
  // P0-2 (2026-05-25) — one-shot cold-start sweep for cloud-side in-flight runs.
  private resumeInFlightTimer?: NodeJS.Timeout;
  private resumeInFlightDone = false;
  // release203/19 — cgroup resource sample is taken on a 5s background timer and
  // cached, so snapshotState()/`GET /healthz` (the K8s liveness probe target)
  // does ZERO synchronous fs reads. A blocking /sys/fs/cgroup read under node IO
  // pressure was a root cause of liveness-probe timeouts → false pod kills.
  private cgroupTimer?: NodeJS.Timeout;
  // G2-R R-1 — device-metrics plugin module (workspace 设备监视卡 telemetry).
  // PLUGIN ISOLATION: mounted via fail-safe `mountDeviceMetrics` — any
  // assembly/start failure leaves this unset and startup proceeds unchanged;
  // unset ⇒ no declare capability bit, no daemon.metrics frames, nothing else
  // in the runner observes it.
  private deviceMetrics?: DeviceMetricsModule;
  // G2-R R-2 — terminal-sessions plugin module (workspace 终端 PTY host).
  // PLUGIN ISOLATION: mounted via fail-safe `mountTerminalSessions` — any
  // assembly failure leaves this unset and startup proceeds unchanged; a
  // mounted-but-degraded module (loadPty() ⇒ null, e.g. no node-pty in the
  // image floor) advertises NO runtime.terminal capability and answers
  // terminal.open with the typed terminal_unavailable rejection. Nothing
  // else in the runner observes it.
  private terminalSessions?: TerminalSessionsModule;
  private cachedCgroup: { cpu: { usagePct: number }; mem: { usedBytes: number; limitBytes: number } } = {
    cpu: { usagePct: 0 },
    mem: { usedBytes: 0, limitBytes: 0 },
  };
  // Wave-4 E7 — local cache of in-flight two-phase dispatch replies. Survives
  // daemon crash so cold-start can resume `prepared` rows via idempotent
  // commit (server enforces (taskId, idempotencyKey) UNIQUE).
  private pendingReplyCache!: PendingReplyCache;
  // One-shot guard so we only recover on the first post-authenticated tick,
  // not every reconnect (server-side commits are idempotent but the log noise
  // and DB pressure of re-running on every redeclare is wasteful).
  private pendingReplyRecoveryDone = false;
  // release203/19 #2 — version-skew directive last received on host.acked.
  //   undefined           — no directive (normal operation).
  //   'refuse_dispatch'   — reject NEW dispatches but keep in-flight + stay up.
  //   'drain_respawn'     — reject NEW dispatches, drain in-flight, then exit so
  //                         the device/k8s controller re-pulls a new-image pod.
  // Backward compatible: an old cloud never sends one ⇒ stays undefined.
  private upgradeDirective?: 'refuse_dispatch' | 'drain_respawn';
  // One-shot guard so the drain watcher is only armed once per drain_respawn.
  private drainRespawnArmed = false;

  constructor(private opts: RunnerOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') throw new Error(`Runner already in state ${this.state}`);
    this.state = 'starting';
    this.startedAt = Date.now();
    const templateMode = isRuntimeTemplateMode();

    this.paths = this.opts.paths ?? resolvePaths();
    this.captureRuntimeOtaSnapshot();
    this.config = this.opts.configOverride ?? loadConfig(this.paths);
    this.cloud = new CloudClient({ baseUrl: this.config.cloud_api_base, apiKey: this.config.api_key });
    // Capture and erase the dedicated Admin credential before setup helpers or
    // provider processes can spawn and inherit the daemon environment.
    this.adminObservabilityCloud = takeAdminObservabilityCloud({
      env: process.env,
      baseUrl: this.config.cloud_api_base,
      generalCloud: this.cloud,
    });
    this.shellConfig = resolveShellConfig(this.config.shell);
    // desktop202 Phase 7 — register local LLM provider profiles (config.toml
    // [[providers]]) so the adapter resolver (hermes/codex) can route BYOK/Ollama.
    // No-op when unconfigured → CLI/K8s/web behaviour unchanged. Keys are NOT in
    // config (only key_ref); electron main injects them via PRISMER_PROVIDER_KEY_*.
    setLocalProviders(this.config.providers ?? []);
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

    try {
      createRequire(import.meta.url).resolve('@prismer/pkf');
      this.pkfCoreAvailable = true;
    } catch {
      this.pkfCoreAvailable = false;
    }

    // Install the Cloud CLI before the first adapter turn. Doing this only in
    // Hermes.ensureService leaves a cold sandbox without `cloud` until a task
    // happens to start Hermes, which makes agent self-checks and other adapter
    // shells fail nondeterministically. Hermes still repeats the check as a
    // self-healing boundary, but daemon boot owns baseline availability.
    try {
      const cloudCli = ensureCloudCliShim();
      const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean);
      if (!pathEntries.includes(cloudCli.managedBinDir)) {
        process.env.PATH = [cloudCli.managedBinDir, ...pathEntries].join(':');
      }
      this.cloudCliAvailable = true;
      process.stdout.write(`[daemon] Cloud CLI ready at ${cloudCli.managedShimPath}\n`);
    } catch (err) {
      this.cloudCliAvailable = false;
      // Source-tree embedders may intentionally omit the sibling Cloud SDK.
      // A signed sandbox bundle is required to include it; keep startup alive
      // so health/OTA recovery remains available, while making the lost
      // capability explicit in logs.
      process.stderr.write(`[daemon] Cloud CLI shim unavailable: ${(err as Error).message}\n`);
    }

    this.db = openLocalDb(this.paths.localDb);
    this.postTurnStore = new PostTurnStore(this.db);
    setTerminalFinalizer(new TerminalFinalizer(this.postTurnStore));
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

    // desktop202/17 Phase 9 — local asset mirror. CAPABILITY BIT, default OFF.
    // Built only when `config.mirror` is present OR `PRISMER_MIRROR_ENABLED=1`
    // (desktop daemon injects both via electron daemon-link). CLI / K8s daemons
    // never set these → no mirror layer, zero behavior change. The named root
    // honours `config.mirror.root` > `PRISMER_MIRROR_ROOT` (paths.mirrorRoot
    // already folds the env) > default `~/Prismer`.
    const mirrorEnabled = this.config.mirror != null || process.env.PRISMER_MIRROR_ENABLED === '1';
    if (mirrorEnabled) {
      const mirrorRoot = this.config.mirror?.root || this.paths.mirrorRoot;
      this.mirrorManager = new MirrorManager({
        db: this.db,
        assetCache: this.assetCache,
        mirrorRoot,
        resolveWorkspaceName: (wsId) => this.resolveWorkspaceName(wsId),
        log: (line) => process.stdout.write(line),
      });
      process.stdout.write(`[daemon] local asset mirror ENABLED root=${mirrorRoot}\n`);
    }

    this.registry = new AdapterRegistry();
    // WS-D D-1: coding driver adapters take canonical coding names
    // (claude-code / codex / opencode); runtime engines (pi-core) are registered
    // separately while preserving adapterName compatibility for Cloud profiles.
    // The legacy one-shot CLI adapters move to fallback names
    // (claude-code-cli / codex-cli) and stay registered as the D21 fallback.
    // hermes (persistence) routing is UNCHANGED.
    const codingDriverAdapters = buildCodingDriverAdapters();
    const runtimeAgentEngineAdapters = buildRuntimeAgentEngineAdapters();
    const cliFallbackAdapters: AdapterDef[] = [
      { ...claudeCodeAdapter, name: 'claude-code-cli' },
      { ...codexAdapter, name: 'codex-cli' },
    ];
    const adapters = this.opts.adaptersOverride ?? [
      hermesAdapter,
      ...codingDriverAdapters,
      ...runtimeAgentEngineAdapters,
      ...cliFallbackAdapters,
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

    // product206/13 §4-R5 — must exist BEFORE the socket opens: the very first
    // `authenticated`/`error` frame already goes through it.
    this.declareGuard = new DeclareGuard({ tickMs: resolveDeclareTickMs() });

    // WebSocket client
    this.ws = new WsClient({
      url: deriveWsUrl(this.config.cloud_api_base),
      apiKey: this.config.api_key,
      // product207/29 — sandbox identity (podName in K8s/ACS): lets the cloud
      // bind a credential-less ACS connection to its workspace and deliver
      // the per-workspace API key over the handshake (claim envVars are a
      // no-op on ACS v0.5.22).
      host: hostname(),
    });
    this.wireWsHandlers();
    if (templateMode) {
      process.stdout.write('[daemon] runtime template mode: cloud transport disabled until clone identity injection\n');
    } else {
      this.ws.start();
    }

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
    this.postTurnWorker = new PostTurnWorker(
      {
        store: this.postTurnStore,
        // memory211/08 A4-① — extract.done rides the workspace memory outbox
        // (same slot the apply closure resolves). enqueue's own schema failures
        // dead-letter without throwing; the try/catch only bounds slot/db
        // resolution so the post-turn lane can never be blocked by telemetry.
        emitObservability: (event) => {
          try {
            const workspaceId = typeof event.workspaceId === 'string' ? event.workspaceId : '';
            if (!workspaceId) {
              process.stderr.write('[daemon] extract.done dropped: envelope has no workspaceId\n');
              return;
            }
            // peek (not resolve): telemetry must never materialize a memory
            // slot for a workspace that has no memory session yet — the apply
            // closure upstream owns slot creation.
            const slot = this.memoryWiring?.runtime.peek(workspaceId);
            if (!slot) {
              // REACHABLE ON RESTART REPLAY (review critical): boot recovery
              // re-claims the previous process's in-flight jobs before any
              // slot is materialized, and the skip / explicit-receipts /
              // pre-extract terminal paths never create one. Dropping silently
              // would make the health panel under-count with zero trace — the
              // drop itself is the diagnosable fact.
              process.stderr.write(
                `[daemon] extract.done dropped: no materialized memory slot for ws=${workspaceId} event=${event.eventId}\n`,
              );
              return;
            }
            slot.outbox.enqueue(event);
          } catch (err) {
            process.stderr.write(
              `[daemon] extract.done emit failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        },
        extract: (job, signal) =>
        extractDurablePostTurn(job, {
          cloud: this.cloud,
          memoryRuntime: this.memoryWiring!.runtime,
          // memory211/01 W3 review B1 — arm the sharding trigger on the durable leg
          resolveAssetSizes: (workspaceId, assetIds) => this.resolveAssetSizesForExtraction(workspaceId, assetIds),
          ...(signal ? { signal } : {}),
        }),
      apply: (job, result, resultHash) => {
        const slot = this.memoryWiring!.runtime.resolve(job.workspaceId);
        return new ExtractedPageApplicator(slot).applyAll(result.pages, {
          postTurnKey: job.idempotencyKey,
          commitKey: canonicalDurabilityCommitKey({
            workspaceId: job.workspaceId,
            agentImUserId: job.agentImUserId,
            canonicalTurnId: job.canonicalTurnId,
          }),
          resultHash,
          workspaceId: job.workspaceId,
          agentImUserId: job.agentImUserId,
          ...(job.conversationId ? { conversationId: job.conversationId } : {}),
          turnId: job.turnId,
          ...(job.payload.traceId ? { traceId: job.payload.traceId } : {}),
          deviceId: this.config.daemon_id,
        });
      },
      },
      // memory211/08 A4-① — extract.done provenance (real daemon identity).
      { deviceId: this.config.daemon_id },
    );
    this.durabilityCommitStore = new DurabilityCommitStore(this.db);
    this.preReplyDurabilityBarrier = new PreReplyDurabilityBarrier({
      store: this.postTurnStore,
      worker: this.postTurnWorker,
      commits: this.durabilityCommitStore,
      confirmAuthoritative: ({ workspaceId, receipts, signal }) =>
        this.memoryWiring!.worker.confirmPageReceipts(workspaceId, receipts, signal),
    });
    this.postTurnWorker.start();

    // B-P1a — the metric-pump half of the metrics.jsonl write side: drains the
    // per-agent offline outbox into /api/im/metrics/batch (at-least-once) on
    // startup + every 60s. Tick-only by design: `appendAgentMetricOutbox` has
    // no notify hook and offline metrics are additive, so a ≤60s replay lag
    // after reconnect is not worth a global callback registry.
    this.metricOutboxReplay = new MetricOutboxReplayWorker({
      cloud: this.cloud,
      paths: this.paths,
      daemonId: this.config.daemon_id,
    });
    this.metricOutboxReplay.start();

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
    const hostCrashSynthesis = synthesizeHostCrashedTurns(
      this.runCheckpointStore.listUnfinishedRuns(),
      (runId) =>
        this.runSessionRegistry?.lookupByTaskId(runId) ??
        this.runSessionRegistry?.lookup(runId) ??
        null,
      new TerminalFinalizer(this.postTurnStore),
    );
    if (hostCrashSynthesis.inserted > 0 || hostCrashSynthesis.skipped > 0) {
      process.stderr.write(
        `[daemon] startup: host-crashed post-turn inserted=${hostCrashSynthesis.inserted} duplicate=${hostCrashSynthesis.duplicate} skipped=${hostCrashSynthesis.skipped}\n`,
      );
    }
    // release201/25 §16.4 A1 — wire the hermes sessions mapper so the
    // adapter's dispatch path can switch to /api/sessions/{id}/chat/stream
    // when the v0.15+ capability gate (A4) advertises it. Cleared in
    // shutdown alongside the run-session registry.
    this.hermesSessionMapper = new HermesSessionMapper(this.db);
    setHermesSessionMapper(this.hermesSessionMapper);
    // S5 §3.4-1b (specs/05 Task 2) — install the narrow cloud IO seam the
    // hermes adapter uses for post-turn transcript reconciliation (read the
    // conversation tail, post the `system_event` visibility row). Same
    // lifecycle as the session mapper above: wired at boot, cleared in
    // shutdown. Unwired ⇒ the adapter's reconcile degrades to a no-op.
    setHermesCloudIO({
      readRecentMessages: (conversationId, limit) =>
        this.cloud
          .request<HermesCloudMessageRow[]>(
            'GET',
            `/api/im/messages/${encodeURIComponent(conversationId)}?limit=${limit}`,
          )
          .then((r) => r?.data ?? []),
      postSystemEvent: (conversationId, content, meta) =>
        this.cloud
          .request('POST', `/api/im/messages/${encodeURIComponent(conversationId)}`, {
            body: { type: 'system_event', content, metadata: meta },
          })
          .then(() => undefined),
    });
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
      syncMemoryFromCloud(
        this.memoryWiring,
        this.cloud,
        [this.workspaceId],
        this.resolveIndexInjectTargets,
      ).catch((err: Error) => log.error('Initial memory sync failed', err.message));
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
      // desktop205 O14 — durable retry for task artifacts. Getter, not the
      // instance: ensureDropFolderRuntime closes + recreates the outbox when
      // the bound workspace changes, and `undefined` (no workspace bound yet)
      // deliberately restores the pre-O14 throw-to-caller behaviour.
      assetOutbox: () => this.assetOriginOutbox,
    });
    this.artifactsWatcher.start();

    // release201/24 §3 — eval-session runner. `onFinish` POSTs per-case
    // results to cloud; `adapterSpawner` runs the skill under test via a
    // throwaway Hermes gateway scoped to the isolated eval HOME. Failure to
    // obtain Hermes yields `inconclusive` (never auto-pass — §2.1).
    this.evalRunner = new EvalSessionRunner({
      // workspace203/09 P2 — per-case progress → cloud → skill.eval.progress SSE.
      onCaseProgress: async (p) => {
        try {
          await this.cloud.request('POST', `/api/im/skills/${p.skillId}/eval/runs/${p.runId}/progress`, {
            body: {
              passCount: p.passCount,
              failCount: p.failCount,
              caseIndex: p.caseIndex,
              total: p.total,
              passed: p.passed,
              ms: p.ms,
              currentCase: p.currentCase,
            },
          });
          process.stdout.write(
            `[daemon] eval progress run=${p.runId} case=${p.caseIndex + 1}/${p.total} ${p.passed ? 'pass' : 'fail'} ${p.ms}ms → reported\n`,
          );
        } catch (err) {
          process.stderr.write(`[daemon] eval progress POST failed run=${p.runId}: ${(err as Error).message}\n`);
        }
      },
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

    // Phase 6 / M1 — local IM gateway (docs/desktop202/13). CAPABILITY BIT,
    // default OFF. Only when `PRISMER_LOCAL_GATEWAY=1` (or config) is the rm_*
    // read model opened, the materializer/relay constructed, and the gateway
    // routes mounted. CLI / K8s daemons skip this entirely → zero behavior
    // change. rm_* lives in the SAME local.db but on an INDEPENDENT schema
    // mechanism (DROP+rebuild on version mismatch), so opening it never touches
    // store.ts's PRAGMA user_version migrations.
    const gatewayConfig = resolveGatewayConfig();
    if (gatewayConfig.enabled) {
      const { rebuilt } = openReadModel(this.db);
      if (rebuilt) {
        process.stdout.write('[daemon] local gateway: rm_* schema version changed — rebuilt cache\n');
      }
      this.gatewayRelay = new LocalRelay();
      this.gatewayMaterializer = new Materializer({
        db: this.db,
        relay: this.gatewayRelay,
        workspaceId: () => process.env.PRISMER_WORKSPACE_ID || this.workspaceId || null,
      });
      // Phase 8b / M3 — online-state tracker. onRecover (transition INTO online)
      // triggers the recovery flush: make every pending outbox row immediately
      // eligible (kickPending resets backoff windows) then run one worker tick
      // so the offline backlog flushes at once instead of draining slowly. The
      // SSE subscriber separately resumes from its persisted seq watermark on
      // reconnect (since=<cursor> catch-up, sse-subscriber.ts), which is the
      // 对账 half (11 §2 M3 "恢复后自动 flush + 对账").
      this.gatewayOnline = new OnlineStateTracker({
        onRecover: () => {
          const kicked = this.syncQueue.kickPending();
          process.stdout.write(`[daemon] gateway recovered → flush ${kicked} pending write(s)\n`);
          void this.syncWorker.tick().catch(() => undefined);
        },
      });
      // Phase 8a / M2 — optimistic write path (13 §7). Reuses the daemon's
      // shared sync-queue + sync-worker (flushSyncRow routes im_message/
      // task_mutation rows to gatewayOutbox.flushRow).
      this.gatewayOutbox = new OutboxWriter({
        db: this.db,
        queue: this.syncQueue,
        cloud: this.cloud,
        relay: this.gatewayRelay,
      });
      this.localGateway = new LocalGateway({
        config: gatewayConfig,
        db: this.db,
        cloud: this.cloud,
        relay: this.gatewayRelay,
        authToken: this.config.api_key,
        outbox: this.gatewayOutbox,
        online: this.gatewayOnline,
        // desktop205 — keep SWR reads scoped to the declared workspace.
        workspaceId: () => this.workspaceId,
      });
      // Open the daemon→cloud realtime subscription that actually feeds the
      // materializer real-time events. This is the connection that makes the
      // gateway *live* (the WS materializer tap above is a forward-compatible
      // no-op for IM events because cloud broadcasts them on the user channel,
      // not the daemon dispatch WS). It auto-reconnects with backoff and resumes
      // from the persisted per-user seq watermark, so it's safe to start eagerly
      // here (before WS `authenticated`) — it retries until cloud is reachable.
      //
      // release203/12 P3.1: the daemon follows the unified single-WS realtime —
      // `WS /ws/realtime` (same endpoint the browser uses) instead of the
      // legacy `/api/im/sync/stream` SSE. Both feed the SAME materializer +
      // share the SAME `chats`/`__sse__` cursor watermark. product204/18
      // Wave 3 (M9): the `PRISMER_UNIFIED_WS=0` escape hatch is retired —
      // unified WS is the only realtime path.
      const realtimeDeps = {
        cloudBase: this.config.cloud_api_base,
        apiKey: this.config.api_key,
        materializer: this.gatewayMaterializer,
        db: this.db,
        // M3: connection state feeds the online-state tracker. onConnected ⇒
        // online (cloud reachable, fires onRecover → flush); onDisconnected ⇒
        // accrue offline evidence (combined with revalidate outcomes).
        onConnected: () => this.gatewayOnline?.onSseConnected(),
        onDisconnected: () => this.gatewayOnline?.onSseDisconnected(),
      };
      this.gatewaySse = new WsRealtimeSubscriber(realtimeDeps);
      this.gatewaySse.start();
      process.stdout.write(
        `[daemon] local gateway ENABLED domains=${Array.from(gatewayConfig.domains).join(',')}\n`,
      );
    }

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
        // F1-b — desktop main pushes the user's active workspace here on switch.
        onSetWorkspace: (workspaceId) => this.setDeclaredWorkspace(workspaceId),
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
          ? attachMemoryRpc({
              runtime: this.memoryWiring.runtime,
              // Provider-facing extract routes (doc 18 §4c) forward turns to
              // cloud /api/im/memory/extract. Wiring cloud + deviceId here
              // lights them up for the out-of-process Hermes provider shell;
              // without them those routes degrade to a 200 no-op.
              cloud: this.cloud,
              deviceId: this.config.daemon_id,
              // memory203 doc 07 §3 — local-first load fallback decrypts回源'd
              // encrypted pages with the per-workspace key before they land as
              // local plaintext (fail-closed to sentinel when absent).
              keyManager: this.memoryWiring.keyManager,
              resolveDurabilityRun: (providerSessionId) =>
                this.runSessionRegistry?.lookupByProviderSession(providerSessionId) ?? null,
              recordExplicitMemoryReceipt: (input) => {
                const run = this.runSessionRegistry?.lookupByProviderSession(input.providerSessionId);
                if (
                  !run?.taskId ||
                  run.taskId !== input.canonicalTurnId ||
                  run.workspaceId !== input.workspaceId ||
                  run.agentImUserId !== input.agentImUserId
                ) {
                  return;
                }
                this.durabilityCommitStore!.stageExplicitReceipt({
                  workspaceId: input.workspaceId,
                  agentSubject: input.agentImUserId,
                  canonicalTurnId: input.canonicalTurnId,
                  receipt: input.receipt,
                });
              },
              // pkf v1.1 §4.7 — write-time bare-asset-URI upgrade resolves
              // assetId → contentHash from the workspace AssetMetadataIndex
              // (the SAME channel /local/asset/* uses). On a cache miss force
              // one (throttled) delta pull so a just-uploaded deliverable
              // resolves immediately; offline / cloud hiccup → null, which the
              // write path degrades to the scoped assetId form (never blocks).
              resolveAssetContentHash: async (workspaceId, assetId) => {
                const lookup = () =>
                  this.assetMetadataIndexes.get(workspaceId)?.resolveByAssetId(assetId)?.contentHash ?? null;
                const local = lookup();
                if (local) return local;
                try {
                  await this.syncAssetMetadata(workspaceId, { force: true });
                } catch {
                  return null;
                }
                return lookup();
              },
              // memory211 fix round (external review P1) — the T3 chunk lane
              // judges a scoped cap against the asset's visibility/owner read
              // from the SAME local mirror (no I/O in the search hot path). An
              // unindexed asset → undefined ⇒ the boundary DENIES (fail-closed).
              resolveAssetAcl: (workspaceId, assetId) => {
                const row = this.assetMetadataIndexes.get(workspaceId)?.resolveByAssetId(assetId);
                if (!row) return null;
                return { visibility: row.visibility, ownerImUserId: row.ownerImUserId };
              },
            })
          : undefined,
        // release203 web-capability fix — `/local/web/{search,load}` forward to
        // the cloud Load API (`/api/context/load`) with the daemon's own
        // sk-prismer credential. The provider-shell web_search / web_load
        // tools (plugins/memory/prismer) are the callers. Always wired: the
        // route itself degrades to a structured 503 when cloud is absent.
        attachWeb: attachWebRpc({ cloud: this.cloud }),
        attachAdminObservability: attachAdminObservabilityRpc({
          cloud: this.adminObservabilityCloud,
          daemonId: () => this.config.daemon_id || null,
        }),
        // product209 — native PKF function tools. Always local/offline and
        // backed by the exact @prismer/pkf staged into this signed Runtime bundle.
        attachPkf: attachPkfRpc({
          cloud: this.cloud,
          workspaceId: () => process.env.PRISMER_WORKSPACE_ID || this.workspaceId || null,
        }),
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
              // memory211/01 W3 review B1 — the extraction lane needs the SIZE of
              // an attached asset to arm the G10 sharding trigger (>64K-character
              // source ⇒ 422 sharding_required). Same index the bare-asset-URI upgrade
              // resolves hashes from; a miss forces one throttled delta pull.
              resolveAssetSizes: async (workspaceId, assetIds) => {
                const out: Record<string, number> = {};
                const index = this.assetMetadataIndexes.get(workspaceId);
                if (!index) return out;
                for (const assetId of assetIds) {
                  const row = index.resolveByAssetId(assetId);
                  if (typeof row?.sizeBytes === 'number' && row.sizeBytes > 0) {
                    out[assetId] = row.sizeBytes;
                  } else {
                    try {
                      await this.syncAssetMetadata(workspaceId, { force: true });
                      const refreshed = this.assetMetadataIndexes.get(workspaceId)?.resolveByAssetId(assetId);
                      if (typeof refreshed?.sizeBytes === 'number' && refreshed.sizeBytes > 0) {
                        out[assetId] = refreshed.sizeBytes;
                      }
                    } catch {
                      /* offline / no index: the gate degrades to G9-only */
                    }
                  }
                }
                return out;
              },
              resolveExplicitMemoryReceipts: (input) =>
                this.durabilityCommitStore?.get(
                  canonicalDurabilityCommitKey({
                    workspaceId: input.workspaceId,
                    agentImUserId: input.agentImUserId,
                    canonicalTurnId: input.canonicalTurnId,
                  }),
                )?.receipts ?? [],
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
        // desktop202/17 Phase 9 — local mirror routes (/local/mirror/*). Wired
        // ONLY when the mirror capability is on (desktop daemon); CLI/K8s leave
        // it undefined → routes fall through, /healthz mirrorReady stays false.
        attachMirror: this.mirrorManager
          ? attachMirrorRpc({
              mirror: this.mirrorManager,
              resolveIndex: (workspaceId) => this.assetMetadataIndexes.get(workspaceId),
              ensureIndex: async (workspaceId) => {
                await this.syncAssetMetadata(workspaceId, { force: true });
                return this.assetMetadataIndexes.get(workspaceId);
              },
            })
          : undefined,
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
        // Phase 6 / M1 — local IM gateway routes (docs/desktop202/13). Only
        // wired when the capability bit is on; otherwise undefined → the
        // local-server route set is identical to pre-Phase-6 (回归不变).
        attachGateway: this.localGateway
          ? (req, res) => this.localGateway!.handle(req, res)
          : undefined,
        getGatewaySubscribers: this.gatewayRelay
          ? () => this.gatewayRelay!.subscriberCount
          : undefined,
        // Phase 8b / M3 — cloud-reachability + queued-write snapshot for the
        // desktop offline indicator (docs/desktop202/11 §2 M3). Only wired when
        // the gateway is enabled; absent → /healthz omits the M3 fields.
        getGatewayOnlineState: this.gatewayOnline
          ? () => ({
              state: this.gatewayOnline!.state,
              cloudReachable: this.gatewayOnline!.cloudReachable,
              pendingWrites: this.syncQueue.pendingCountByType(['im_message', 'task_mutation']),
              oldestPendingAge: this.syncQueue.oldestPendingAge(['im_message', 'task_mutation']),
            })
          : undefined,
      });
      await this.localServer.start();
    }

    // Periodic re-declare keeps im_agent_cards.lastHeartbeat fresh so the
    // cloud's sweepTimedOut() (default 90s) doesn't flip status back to
    // offline. The handler treats agent.host.declare as refresh-on-redeclare
    // (see ws/handler.ts §handleAgentHostDeclare).
    //
    // product206/13 §4-R5 — the tick now ASKS the DeclareGuard first. Before
    // R5 this fired unconditionally, so a daemon the cloud had refused
    // (DAEMON_ID_CLAIMED / DAEMON_FORGOTTEN / …) re-sent the identical,
    // identically-doomed declare every 30s forever. The guard owns the whole
    // decision (classification + ladder + parking); the timer keeps doing its
    // one job.
    this.heartbeatTimer = setInterval(() => {
      if (this.wsConnected && this.declareGuard.shouldDeclare()) this.sendDeclare();
    }, resolveDeclareTickMs());

    // Authority snapshots have a fixed 60-minute lease while per-agent caps
    // last 15 minutes. Refresh the full bootstrap bundle at 45 minutes so the
    // cap-renewal route retains a 15-minute retry margin. Authority-only bundle
    // changes are separated from runtime behavior below, so this does not kill
    // a healthy long-running Hermes gateway.
    this.memoryAuthorityRefreshTimer = setInterval(() => {
      const workspaceIds = new Set(this.bootstrapStates.keys());
      if (this.workspaceId) workspaceIds.add(this.workspaceId);
      for (const workspaceId of workspaceIds) {
        void this.triggerBootstrap(workspaceId, { force: true });
      }
    }, MEMORY_AUTHORITY_REFRESH_INTERVAL_MS);
    this.memoryAuthorityRefreshTimer.unref?.();

    // release203/19 — sample cgroup resources on a background timer into a cache
    // so the healthz/snapshotState hot path never does synchronous fs reads
    // (root-cause fix for liveness-probe flapping). Prime once, then every 5s.
    this.cachedCgroup = this.sampleCgroupResources();
    this.cgroupTimer = setInterval(() => {
      this.cachedCgroup = this.sampleCgroupResources();
    }, 5_000);
    this.cgroupTimer.unref?.();

    // G2-R R-1 — device-metrics plugin module (device telemetry for the
    // workspace 设备监视卡). PLUGIN ISOLATION by contract: the mount is
    // fail-safe (assembly/start errors log + leave the module off — dispatch/
    // declare/sync/OTA unchanged) and the outer belt below also guards the
    // opts evaluation. Inside the module every tick is fire-and-forget and
    // self-capturing: sampler / inventory / send errors are counted, never
    // retried, never bubbled into the runner loop. The interval is
    // ConfigDelivery-able via PRISMER_DEVICE_METRICS_INTERVAL_MS (default
    // 10s, floor 2s), and `setIntervalMs` applies live changes.
    try {
      this.deviceMetrics = mountDeviceMetrics({
        daemonId: this.config.daemon_id,
        runtimeVersion: this.opts.daemonVersion ?? this.resolveDaemonVersion(),
        statfsPath: this.paths.root,
        intervalMs: resolveDeviceMetricsIntervalMs(process.env.PRISMER_DEVICE_METRICS_INTERVAL_MS),
        send: (frame) => this.ws.send(frame),
      }) ?? undefined;
    } catch (err) {
      process.stderr.write(
        `[daemon] device-metrics mount failed (non-fatal): ${(err as Error).message}\n`,
      );
    }

    // G2-R R-2 — terminal-sessions plugin module (workspace 终端). Same
    // fail-safe mount contract as device-metrics: assembly/start errors log
    // + leave the module off — dispatch/declare/sync/OTA unchanged. The ACL
    // reuses the shell-executor's resolveShellConfig output; the idle reaper
    // is ConfigDelivery-able via PRISMER_TERMINAL_IDLE_TIMEOUT_MS (default
    // 10min, floor 30s). node-pty is lazy-loaded (regular require → image
    // native ABI floor root): unavailable ⇒ mounted but degraded — no
    // capability claim, terminal.open → typed terminal_unavailable.
    try {
      this.terminalSessions = mountTerminalSessions({
        send: (frame) => this.ws.send(frame),
        shellConfig: this.shellConfig,
        terminalIdleTimeoutMs: resolveTerminalIdleTimeoutMs(process.env.PRISMER_TERMINAL_IDLE_TIMEOUT_MS),
        // §T-5 follow-up — daemon 侧窗口输出帽:显式 env 覆盖,缺省 32MiB/10s
        // 常开(洪流失控时 relay 收口前的源端封顶 + 空闲回收不被输出续命)。
        terminalOutputBudget: (() => {
          const resolved = resolveTerminalOutputBudget({
            bytes: process.env.PRISMER_TERMINAL_OUTPUT_BUDGET_BYTES,
            windowMs: process.env.PRISMER_TERMINAL_OUTPUT_BUDGET_WINDOW_MS,
          });
          // 评审 F3:env 显式关闭(0/off/disabled)⇒ 关帽;缺省/垃圾 ⇒ 默认常开
          if (resolved !== null && 'disabled' in resolved) return disabledTerminalOutputBudget();
          return resolved ?? defaultTerminalOutputBudget();
        })(),
      }) ?? undefined;
    } catch (err) {
      process.stderr.write(
        `[daemon] terminal-sessions mount failed (non-fatal): ${(err as Error).message}\n`,
      );
    }

    // 09 §3.3 — daemon-heartbeat file writer for sandbox-manager liveness
    // monitoring. The sandbox-manager reads this file to detect daemon stalls.
    // ConfigVersion comes from the first bootstrap state (workspace-level),
    // defaulting to empty string when no bootstrap has completed yet.
    this.daemonHeartbeat = new DaemonHeartbeat({
      getConfigVersion: () => {
        // Return the config version from the first workspace's bootstrap state
        for (const state of this.bootstrapStates.values()) {
          if (state.configVersion) return state.configVersion;
        }
        return '';
      },
    });
    this.daemonHeartbeat.start();

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
      void (async () => {
        await this.resumeInFlightTasks();
        // release201/26 Phase 4 — daemon-local checkpoint resume scan. Runs after
        // the cloud-side sweep so the cloud-truth re-dispatch (which writes fresh
        // checkpoints) settles first; the local scan then only acts on survivors
        // the cloud sweep didn't already pick up. Sequenced (not parallel) for the
        // same reason — onTaskDispatch dedupes by taskId so order is safe either
        // way, but running after keeps the resume_failed signal narrow.
        await this.resumeFromCheckpoints();
      })().catch((err) => {
        process.stderr.write(`[daemon] startup resume sequence failed: ${(err as Error).message}\n`);
      });
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
              `SELECT id, workspace_id, agent_im_user_id, adapter_name, config
                 FROM agent_profiles
                 WHERE name = ? AND deleted_at IS NULL
                 ORDER BY version DESC LIMIT 1`,
            )
            .get(profileName) as
            | {
                id: string;
                workspace_id: string;
                agent_im_user_id: string;
                adapter_name: string;
                config: string | null;
              }
            | undefined;
          if (!row) return null;
          let roleTemplateSlug: string | null = null;
          let model: string | null = null;
          let proxyProvider: string | null = null;
          if (row.config) {
            try {
              const cfg = JSON.parse(row.config) as {
                roleTemplate?: { slug?: unknown };
                roleTemplateSlug?: unknown;
                model?: unknown;
                proxyProvider?: unknown;
              };
              if (typeof cfg.roleTemplate?.slug === 'string') {
                roleTemplateSlug = cfg.roleTemplate.slug;
              } else if (typeof cfg.roleTemplateSlug === 'string') {
                roleTemplateSlug = cfg.roleTemplateSlug;
              }
              if (typeof cfg.model === 'string' && cfg.model.trim()) {
                model = cfg.model.trim();
              }
              if (typeof cfg.proxyProvider === 'string' && cfg.proxyProvider.trim()) {
                proxyProvider = cfg.proxyProvider.trim();
              }
            } catch {
              /* malformed config — leave slug null */
            }
          }
          return {
            agentImUserId: row.agent_im_user_id,
            workspaceId: row.workspace_id,
            profileId: row.id,
            adapterName: row.adapter_name,
            roleTemplateSlug,
            model,
            proxyProvider,
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
    let profiles: AgentProfile[] = [];
    try {
      profiles = this.loadAllProfiles();
      if (profiles.length === 0) {
        if (trigger === 'startup') process.stdout.write('[daemon] skill sync (startup): no local profiles yet\n');
        return;
      }
      // release201/09 §9.3.2 — per-agent skill root. paths + daemonId let
      // skill-sync resolve `devices/<did>/agents/<aid>/skills/` instead of
      // the profile-shared dir.
      const { totals, byProfile } = await syncAllAgentSkills(profiles, this.cloud, {
        concurrency: 3,
        skillsRootCtx: { paths: this.paths, daemonId: this.config?.daemon_id },
      });
      // S-B5 — background sync can't safely kill gateways (outside dispatch
      // queue → murder risk). Flag any profile whose skill set actually
      // changed; the next dispatch consumes the flag and re-spawns. This closes
      // the short-circuit where background sync writes files + acks revision,
      // then the next dispatch sees synced==0 and skips the kill.
      for (const entry of byProfile) {
        if (entry.ok && entry.result && (entry.result.synced > 0 || (entry.result.pruned ?? 0) > 0)) {
          this.skillDirtyProfiles.add(entry.profileId);
        }
      }
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
      // Phase 6 capability audit belongs to the same startup path as skill
      // delivery. It also runs after a failed sync so missing files become an
      // explicit unavailable receipt instead of disappearing into a log line.
      if (trigger === 'startup') {
        for (const profile of profiles) this.refreshPkfRuntimeCapability(profile, 'startup');
      }
      this.skillSyncInFlight = false;
    }
  }

  /**
   * Audit the exact production surfaces visible to one profile: the Hermes
   * function-call registry, that profile's installed skill files, the bundled
   * core package and the managed Cloud CLI shim. No shell/PATH/Python probe is
   * involved. The structured receipt is later injected by dispatch.ts.
   */
  private refreshPkfRuntimeCapability(
    profile: AgentProfile,
    trigger: PkfRuntimeCapabilityTrigger,
  ): PkfRuntimeCapabilityReport {
    const report = validatePkfRuntimeCapability({
      trigger,
      profileId: profile.id,
      availableNativeTools:
        profile.adapterName === 'hermes'
          ? HERMES_MEMORY_TOOLS.map((tool) => tool.function.name)
          : [],
      // runtime210 G-A — pi-core 与 hermes 同权解析 skillsRoot,capability
      // 报告即可观测 pi-core 的 skill 目录是否就位。
      skillsRoot:
        profile.adapterName === 'hermes' || profile.adapterName === 'pi-core'
          ? resolveSkillsRoot(profile, profile.agentImUserId, {
              paths: this.paths,
              daemonId: this.config?.daemon_id,
            })
          : null,
      pkfCoreAvailable: this.pkfCoreAvailable,
      cloudCliAvailable: this.cloudCliAvailable,
    });
    this.pkfRuntimeCapabilities.set(profile.id, report);
    process.stdout.write(`[pkf-runtime-capability] ${JSON.stringify(report)}\n`);
    return report;
  }

  private resolvePkfRuntimeCapability(profile: AgentProfile): PkfRuntimeCapabilityReport {
    return this.pkfRuntimeCapabilities.get(profile.id) ??
      this.refreshPkfRuntimeCapability(profile, 'startup');
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
   * memory202 doc 05 §4.2a — resolve the agent MEMORY.md core-inject carrier
   * path(s) for a workspace: one per live hermes profile hosted in it. Used by
   * the INDEX dynamic core-inject (flag-gated FF_MEMORY_INDEX_INJECT_ENABLED).
   * Only hermes profiles have the builtin MEMORY.md carrier — other adapters are
   * skipped (their core-inject binding is the held-back per-adapter work). The
   * path mirrors `wipeHermesProfileMemory`'s `<profileDir>/memories/MEMORY.md`.
   */
  private resolveIndexInjectTargets = (workspaceId: string): string[] => {
    const paths: string[] = [];
    for (const profile of this.loadAllProfiles()) {
      if (profile.workspaceId !== workspaceId) continue;
      if (profile.adapterName !== 'hermes') continue;
      const profileName = getHermesProfileName(profile);
      paths.push(join(getHermesProfileDir(profileName), 'memories', 'MEMORY.md'));
    }
    return paths;
  };

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

  async stop(opts?: StopOptions): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') return;
    this.state = 'stopping';
    // desktop204 D204-4 — snapshot before the aborts below: whether anything was
    // still running decides `inflightDrained` on the withdraw we send further
    // down (false ⇒ cloud knows the work was handed back, not finished).
    const hadInflight = this.runningTasks.size > 0;
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
    if (this.memoryAuthorityRefreshTimer) {
      clearInterval(this.memoryAuthorityRefreshTimer);
      this.memoryAuthorityRefreshTimer = undefined;
    }
    if (this.daemonHeartbeat) {
      this.daemonHeartbeat.stop();
      this.daemonHeartbeat = undefined;
    }
    if (this.cgroupTimer) {
      clearInterval(this.cgroupTimer);
      this.cgroupTimer = undefined;
    }
    if (this.deviceMetrics) {
      this.deviceMetrics.stop();
      this.deviceMetrics = undefined;
    }
    if (this.terminalSessions) {
      this.terminalSessions.stop();
      this.terminalSessions = undefined;
    }
    if (this.resumeInFlightTimer) {
      clearTimeout(this.resumeInFlightTimer);
      this.resumeInFlightTimer = undefined;
    }
    this.syncWorker?.stop();
    this.metricOutboxReplay?.stop();
    this.metricOutboxReplay = undefined;
    this.postTurnWorker?.stop();
    this.postTurnWorker = undefined;
    this.preReplyDurabilityBarrier = undefined;
    this.durabilityCommitStore = undefined;
    setTerminalFinalizer(null);
    this.postTurnStore = undefined;
    this.memoryWiring?.stop();
    this.memoryWiring = undefined;
    setRunSessionRegistry(null);
    this.runSessionRegistry = undefined;
    setRunCheckpointStore(null);
    this.runCheckpointStore = undefined;
    setHermesSessionMapper(null);
    this.hermesSessionMapper = undefined;
    setHermesCloudIO(null);
    setProviderSessionMapper(null);
    // desktop204 D204-4 — graceful offline declare. The drain (the aborts above)
    // is done and the WS is still open: this is the only moment we can tell the
    // cloud "this device is going away on purpose". Without it the cloud waits
    // out the 3-minute staleness window before marking the agents offline, and
    // every task dispatched to this daemon in those 3 minutes is a black hole.
    // Strictly best-effort: `sendHostWithdraw` never throws and never waits
    // longer than WITHDRAW_FLUSH_TIMEOUT_MS, so an offline / already-closed WS
    // costs us nothing and quit proceeds regardless.
    if (opts?.withdraw) {
      await this.sendHostWithdraw(opts.withdraw, !hadInflight);
    }
    this.ws?.close();
    // Phase 6 / M1 — stop the daemon→cloud SSE subscriber (aborts the upstream
    // read connection + cancels any pending reconnect) before closing the local
    // relay's downstream subscriber sockets.
    this.gatewaySse?.stop();
    this.gatewaySse = undefined;
    // Phase 6 / M1 — close any open local SSE subscriber sockets so
    // localServer.stop() can drain (mirrors the keep-alive concern there).
    this.gatewayRelay?.closeAll();
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
    // `?.` because Runner instances constructed without start() (unit tests,
    // and any future embedder) never build a guard.
    const declareBlocked = this.declareGuard?.snapshot() ?? null;
    return {
      daemonId: this.config?.daemon_id ?? '',
      daemonVersion: this.resolveDaemonVersion(),
      cloudBaseUrl: this.config?.cloud_api_base,
      workspaceId: this.workspaceId || null,
      pid: process.pid,
      runtimePid: process.pid,
      ...(this.runtimeOtaSnapshot ? { ota: this.runtimeOtaSnapshot } : {}),
      startedAt: this.startedAt,
      wsConnected: this.wsConnected,
      // product206/13 §4-R5 — the ONE place a user (or the desktop Tray, or
      // `prismer status`, or the cloud debug pipeline's daemon-state probe) can
      // tell "the cloud is unreachable" (wsConnected:false) apart from "the
      // cloud is reachable and REFUSED this device" (wsConnected:true +
      // declareBlocked). Spread so a daemon that was never refused emits the
      // pre-R5 healthz shape byte-for-byte (absent ≠ null).
      ...(declareBlocked ? { declareBlocked } : {}),
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
      // zero. release203/19 — sampled on a 5s background timer into
      // `cachedCgroup` (NOT read synchronously here) so /healthz never does fs
      // IO; the prime sample reports 0% CPU, each later refresh reflects the
      // wall-clock delta against the prior sample.
      resources: this.cachedCgroup,
      readyForDispatch: adapterSnapshot.length > 0 && adapterSnapshot.every((a) => a.ready),
      // Desktop-202 doc 18 §8 — recall observability. Emitted only when the
      // memory subsystem is wired (CLI/K8s without memory → omitted, healthz
      // shape unchanged). The snapshot is process-global (single-thread daemon).
      ...(this.memoryWiring ? { recallStats: recallStatsSnapshot() } : {}),
      // desktop205/04 §4 (W13) — Tray observability. Both are spread so a daemon
      // without the corresponding subsystem omits the key (absent ≠ empty), which
      // is what keeps the CLI/K8s healthz + /tasks/running shapes unchanged.
      // `assetOutbox` is the LAST SAMPLE taken by the drop-folder tick — reading
      // the db here would put three COUNT(*)s on every Tray poll.
      ...(this.assetOutboxCounts ? { assetOutbox: this.assetOutboxCounts } : {}),
      // Remote → LKG → bundled skill source counters are process-local and
      // sampled here, keeping /healthz itself a zero-I/O projection.
      skillResolution: snapshotSkillResolutionHealth(),
      ...(this.postTurnWorker ? { postTurnJobs: this.postTurnWorker.snapshotHealth() } : {}),
      // memory211/08 A4-② — last-sample memory-outbox health (pending +
      // dead-letter). The 5s flush tick owns the DB I/O; this projection is
      // zero-I/O and ABSENT until the first tick (spread discipline as above),
      // and also absent right after a failed sample (unknown ≠ zero).
      ...(memoryOutboxHealthSnapshot() ? { memoryOutbox: memoryOutboxHealthSnapshot() } : {}),
      // desktop205 R2 — profiles the cloud says are no longer ours. Same spread
      // discipline (absent ≠ empty), and same zero-I/O rule: this is the
      // in-memory projection rebuilt by loadAgentsFromDb, never a db read.
      ...(this.quarantinedProfiles.size > 0
        ? { quarantinedProfiles: Array.from(this.quarantinedProfiles.values()) }
        : {}),
      // product209/07 §3.7.4 — ConfigDelivery bundle application status.
      // Spread only when at least one bootstrap state exists; CLI/K8s daemons
      // without ConfigDelivery (or before first fetch) omit the key entirely.
      // Multiple workspaces: uses the primary (this.workspaceId) if it exists
      // in bootstrapStates, otherwise the first workspace's state.
      ...(this.bootstrapStates.size > 0
        ? { config: this.bootstrapConfigSnapshot() }
        : {}),
      runningTasks: Array.from(this.runningTasks.entries()).map(([taskId, entry]) => ({
        taskId,
        startedAt: entry.startedAt,
        ...(entry.agentName ? { agentName: entry.agentName } : {}),
        ...(entry.kind ? { kind: entry.kind } : {}),
        ...(entry.scopeLabel ? { scopeLabel: entry.scopeLabel } : {}),
      })),
    };
  }

  /** Capture bundle verification proof once; health reads remain filesystem-free. */
  private captureRuntimeOtaSnapshot(): void {
    if (this.runtimeOtaSnapshot) return;
    const paths = this.paths ?? this.opts.paths ?? resolvePaths();
    this.runtimeOtaSnapshot = readRuntimeOtaSnapshot({
      home: paths.root,
      runningVersion: this.resolveDaemonVersion(),
    });
  }

  /**
   * product209/07 §3.7.4 — ConfigDelivery bundle application snapshot for /healthz.
   *
   * Delegates to the standalone `bootstrapConfigSnapshot()` in config-bootstrap.ts
   * so tests can import the same logic. Prefers the current workspaceId; falls
   * back to the first entry. Returns a zero-state snapshot when the map is empty
   * (callers gate on size>0 to omit the key entirely via spread).
   */
  private bootstrapConfigSnapshot(): LocalServerState['config'] {
    return bootstrapConfigSnapshot(this.workspaceId || null, this.bootstrapStates);
  }

  /**
   * product209/07 §3.7.4 — emit a runtime incident over the daemon WS.
   *
   * Best-effort: when WS is not connected the message is dropped (WsClient
   * emits 'drop' rather than throwing). The stderr log in triggerBootstrap
   * is the durable fallback; /healthz config.lastError is the queryable
   * retrospective.
   */
  private emitBootstrapIncident(
    workspaceId: string,
    incidentKind: 'config_bootstrap_stopped' | 'config_bootstrap_error' | 'config_apply_error',
    detail: Record<string, unknown>,
  ): void {
    try {
      this.ws.send({
        type: 'runtime.incident',
        payload: {
          daemonId: this.config?.daemon_id ?? '',
          workspaceId,
          incidentKind,
          configVersion: this.bootstrapStates.get(workspaceId)?.configVersion ?? null,
          at: new Date().toISOString(),
          detail,
        },
      });
    } catch {
      // Never let incident reporting crash the bootstrap loop
    }
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
    type ProfileRow = {
      id: string;
      agent_im_user_id: string;
      version: number;
      workspace_id: string;
      name: string;
      quarantined_at: number | null;
    };
    const agents = this.db.prepare('SELECT * FROM agents').all() as AgentRow[];
    const profilesByAgent = new Map<string, Array<{ id: string; version: number }>>();
    const allProfiles = this.db
      .prepare(
        `SELECT id, agent_im_user_id, version, workspace_id, name, quarantined_at
         FROM agent_profiles WHERE deleted_at IS NULL`,
      )
      .all() as ProfileRow[];
    // desktop205 R2 — rebuild the quarantine projection here (and only here):
    // every path that mutates agent_profiles already ends in loadAgentsFromDb,
    // so the map can never drift from the column without the rows drifting too.
    this.quarantinedProfiles.clear();
    for (const p of allProfiles) {
      if (p.quarantined_at != null) {
        this.quarantinedProfiles.set(p.id, {
          profileId: p.id,
          agentImUserId: p.agent_im_user_id,
          workspaceId: p.workspace_id,
          name: p.name,
          since: p.quarantined_at,
        });
      }
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

  /**
   * §3.7.1 key rotation recovery: track hermes dispatch 401 errors
   * and trigger re-bootstrap after 3 consecutive failures.
   *
   * Called from the dispatch result handlers in onTaskDispatchRequest.
   */
  private trackDispatch401(message: string, code?: string): void {
    // F4: structured error-code check first (dispatch error.code),
    // then regex fallback on the human-readable message.
    const isAuthError =
      code === 'upstream_llm_error' || code === 'daemon_local_retry_exhausted'
        ? /HTTP\s*401|401\s*[Uu]nauthorized/.test(message)
        : /HTTP\s*401|401\s*[Uu]nauthorized|invalid.*api.?key|api.?key.*invalid/i.test(message);
    if (isAuthError) {
      this.consecutiveDispatch401++;
      process.stderr.write(
        `[ConfigDelivery] hermes dispatch 401 #${this.consecutiveDispatch401}\n`,
      );
      if (this.consecutiveDispatch401 >= 3) {
        process.stderr.write(
          `[ConfigDelivery] ⚠️ ${this.consecutiveDispatch401} consecutive dispatch 401s — triggering re-bootstrap\n`,
        );
        this.consecutiveDispatch401 = 0;
        if (this.workspaceId) {
          void this.triggerBootstrap(this.workspaceId);
        }
      }
    } else {
      this.consecutiveDispatch401 = 0;
    }
  }

  /**
   * Fetches the RuntimeConfigBundle from GET /api/im/runtime/bootstrap (B1),
   * validates the schema, compares content-hash (same → skip), writes
   * ~/.hermes/config.yaml + ~/.hermes/.env, and updates the daemon env
   * overlay (PRISMER_BASE_URL ← providerBase).
   *
   * Error semantics (§3.4):
   * - 404/500: exponential backoff 5s→10s→30s→60s cap
   * - 401: stop retries; reset by adoption/handshake event
   * - 403: stop retries (config mismatch, needs human intervention)
   *
   * Only attempts fetch if hermes profiles exist in local DB (§3.6).
   */
  private get configDeliveryEnabled(): boolean {
    // Daemon-side feature flag: explicit '0'|'false'|'off' disables;
    // everything else (including unset) → enabled. Mirror of cloud
    // FF_CONFIG_DELIVERY.
    const v = (process.env.FF_CONFIG_DELIVERY ?? '').trim().toLowerCase();
    return !(v === 'false' || v === '0' || v === 'off');
  }

  /**
   * product209/07 §3.6.2 — container classification for the ConfigDelivery
   * lifecycle. TRUE means "env-inference must be blocked": the container has
   * no trustworthy env credential, so Hermes config can ONLY come from the B1
   * bundle (the ACS checkpoint world — keyless at boot, adopted later).
   *
   * bugfix211 G2 — the historical discriminator was
   * `RUNTIME_MODE=container && ALLOW_FAKE_API_KEY=true`, but ALLOW_FAKE is an
   * IMAGE-level default (Dockerfile.daemon dev images bake `true`) shared by
   * ACS checkpoints AND workspace k8s pods. Workspace pods always carry a
   * real cloud-minted `sk-prismer-live-*` key, so the flag lied for them:
   * they were misclassified as ACS (log: "ACS sandbox detected"), lost the
   * env-inference fallback they are entitled to, and on a permanent B1 401/403
   * refused the safe last-resort path while holding a valid credential.
   *
   * The authoritative signal is the env key itself: a real-shaped key IS the
   * cloud-minted credential (containers cannot forge `sk-prismer-live-` — the
   * cloud mints it into the pod spec; a leaked env var of that shape would
   * authenticate against cloud anyway). Absent or non-conforming keys keep
   * the strict B1-wait. Cloud pod-specs now also stamp
   * PRISMER_ALLOW_FAKE_API_KEY=false explicitly (pod-spec.ts); this check
   * keeps already-deployed images correct without an OTA.
   */
  private isKeylessSandboxContainer(): boolean {
    return containerEnvIsKeyless(process.env);
  }

  private async triggerBootstrap(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!this.configDeliveryEnabled) {
      // §3.6 — when FF is explicitly OFF, fall back to env inference
      // via reprovisionHermesProfiles (2.2.8 behaviour).
      // §3.6.2 — unless we're on ACS where the env-injected key is fake.
      const isSandbox = this.isKeylessSandboxContainer();
      if (!isSandbox) {
        void this.reprovisionHermesProfiles();
      } else {
        process.stderr.write(
          `[ConfigDelivery] ACS sandbox with FF_CONFIG_DELIVERY=off — Hermes cannot start (no real API key source)\n`,
        );
      }
      return;
    }
    if (!this.db) return;
    const isSandbox = this.isKeylessSandboxContainer();
    // A workspace-neutral ACS checkpoint declares/authenticates before Cloud
    // adoption has populated local agent_profiles. B1 is also the source of
    // the per-boot Memory authority snapshot, so waiting for a local profile
    // creates a circular dependency: adoption prewarms an unscoped gateway and
    // no bootstrap is left to repair it. Fetch eagerly on ACS; ACK/Desktop keep
    // the old no-profile short-circuit.
    const hasProfiles = this.db
      .prepare(
        `SELECT 1 FROM agent_profiles WHERE workspace_id = ? AND adapter_name = 'hermes' AND deleted_at IS NULL LIMIT 1`,
      )
      .get(workspaceId);
    if (!hasProfiles && !isSandbox) return;

    // §3.6 startup: wait for the first bundle fetch before provisioning
    // Hermes. Env-inference is only a LAST resort after backoff exhaustion —
    // running it immediately races with the bundle and produces a broken
    // gateway ("No LLM provider configured") on ACS where the real API key
    // arrives via ConfigDelivery (product209/07 §3.6.1).
    //
    // Environment-specific lifecycle (§3.6.2):
    //   ACS  — no env-injected key (fake key at boot); MUST wait for bundle
    //   ACK  — env-injected key; env-inference is a safe fallback
    //   Desktop — local runtime; env-inference is the primary path
    const isContainerWithKey = process.env.PRISMER_RUNTIME_MODE === 'container' && !isSandbox;
    let state = this.bootstrapStates.get(workspaceId);
    if (!state) {
      state = createBootstrapState();
      this.bootstrapStates.set(workspaceId, state);
      if (isSandbox) {
        // ACS: never run env-inference — the fake key would provision a broken
        // Hermes gateway. We strictly wait for ConfigDelivery (key adoption +
        // bundle fetch). If B1 permanently fails, fail loudly rather than
        // silently producing a non-functional agent.
        process.stderr.write(
          `[ConfigDelivery] ACS sandbox detected (no env-injected key) — strictly waiting for B1 bundle (env-inference blocked)\n`,
        );
      } else if (isContainerWithKey) {
        // ACK: env has a real key, env-inference is safe as a fallback.
        process.stderr.write(
          `[ConfigDelivery] no cached bundle for workspace ${workspaceId} — running env-inference fallback while B1 retries\n`,
        );
        void this.reprovisionHermesProfiles();
      } else {
        // Desktop / local: env-inference is the primary path.
        process.stderr.write(
          `[ConfigDelivery] local runtime — running env-inference (primary path)\n`,
        );
        void this.reprovisionHermesProfiles();
      }
    }
    // Skip if retries are stopped (401/403) — wait for reset event
    if (state.stoppedReason) return;
    // Skip if backoff timer hasn't fired yet
    if (state.nextAttemptAt > Date.now()) return;

    const result = await fetchBootstrapBundle({
      cloudBase: this.config.cloud_api_base,
      apiKey: this.config.api_key,
      workspaceId,
      daemonId: this.config.daemon_id,
      // §8.2 — a forced refresh (after authority invalidation) must fetch the
      // FULL bundle: the "unchanged" short-circuit would otherwise never
      // re-deliver the memoryAuthority snapshot to a registry we just emptied.
      configVersion: opts.force ? undefined : (state.configVersion ?? undefined),
    });

    if (result.status === 'unchanged') {
      state.failureCount = 0;
      // The pin-pending window is per-episode: this fetch succeeding means the
      // pin landed, and a stale anchor would instantly terminal-stop a later
      // absent-pin episode (in-place workspace rebuild) with zero retry.
      state.pinPendingSince = null;
      return;
    }

    if (result.status === 'error') {
      // F3: compute backoff BEFORE incrementing failureCount so the first
      // error maps to index 0 (5s), not index 1 (10s).
      const errorAction = computeBootstrapErrorAction(result.statusCode, state, result.errorCode);
      state.failureCount++;
      state.lastError = result.error ?? null;

      if (errorAction.action === 'stop') {
        state.stoppedReason = errorAction.reason;
        process.stderr.write(
          `[ConfigDelivery] ❌ stopping bootstrap retries: HTTP ${result.statusCode} (reason=${errorAction.reason})\n`,
        );
        // product209/07 §3.7.4 — emit runtime incident for S10 monitoring
        this.emitBootstrapIncident(workspaceId, 'config_bootstrap_stopped', {
          statusCode: result.statusCode,
          reason: errorAction.reason,
          error: result.error,
        });
        // §3.6.2 last-resort fallback: only safe on ACK/Desktop where the
        // env-injected key is real. ACS sandboxes must NOT run env-inference
        // (the fake key would provision a permanently broken Hermes gateway).
        const isSandbox = this.isKeylessSandboxContainer();
        if (!isSandbox) {
          process.stderr.write(
            `[ConfigDelivery] running env-inference as last-resort fallback for workspace ${workspaceId}\n`,
          );
          void this.reprovisionHermesProfiles();
        } else {
          process.stderr.write(
            `[ConfigDelivery] ACS sandbox — env-inference blocked (fake key); Hermes will remain unconfigured until B1 recovers\n`,
          );
        }
      } else {
        state.nextAttemptAt = Date.now() + errorAction.nextDelayMs;
        process.stderr.write(
          `[ConfigDelivery] bootstrap failed (HTTP ${result.statusCode}), retry in ${errorAction.nextDelayMs}ms (attempt=${state.failureCount})\n`,
        );
        this.emitBootstrapIncident(workspaceId, 'config_bootstrap_error', {
          statusCode: result.statusCode,
          attempt: state.failureCount,
          error: result.error,
          retryInMs: errorAction.nextDelayMs,
        });
        // §3.4: schedule a retry via setTimeout — the backoff is not
        // just a computed value, it must actually fire.
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          void this.triggerBootstrap(workspaceId);
        }, errorAction.nextDelayMs);
      }
      return;
    }

    // Success — apply the bundle
    // Same per-episode anchor reset as the 'unchanged' short-circuit above.
    state.pinPendingSince = null;
    if (result.bundle) {
      // product209/16 §8.2/§8.3 — register the authority snapshot BEFORE the
      // content-apply idempotency check: the registry is per-boot state, so
      // after a restart (or an invalidation + forced refresh) the snapshot
      // must be registered even when the config body itself is unchanged.
      // The registration carries THIS process's daemon id (§8.3 mint
      // precondition #4 — workspace/daemon 匹配). A rejected snapshot
      // (tampered / expired / epoch regression / daemonId mismatch) logs and
      // leaves the registry empty → agent Memory RPC fails closed.
      const previousMemoryAuthority = getMemoryAuthoritySnapshot(workspaceId);
      let memoryAuthorityRestored = false;
      if (result.bundle.memoryAuthority) {
        const registered = registerMemoryAuthoritySnapshot(
          result.bundle.memoryAuthority,
          this.config.daemon_id,
        );
        // product210 bugfix — rebind not only when the registry goes
        // empty→registered, but ALSO when a hermes profile actor becomes
        // mintable that previously could not mint (actor binding landed late
        // / workspace rebuilt / lease had lapsed). Without this, a gateway
        // that spawned during the not-yet-mintable window runs with NO cap
        // forever: cap/refresh requires an already-authentic token, and the
        // one-shot empty→registered trigger was already consumed.
        memoryAuthorityRestored =
          registered &&
          (previousMemoryAuthority === null ||
            authorityActorMintableGained(
              previousMemoryAuthority,
              result.bundle.memoryAuthority,
              this.hermesProfileActorIds(workspaceId),
            ));
        if (!registered) {
          process.stderr.write(
            `[MemoryAuthority] ⚠️ bootstrap snapshot rejected for workspace ${workspaceId} — ` +
              'no cap v2 will be minted until a valid snapshot arrives (fail closed)\n',
          );
        }
      }
      const runtimeFingerprint = runtimeBehaviorFingerprint(result.bundle);
      if (state.runtimeFingerprint === runtimeFingerprint) {
        state.configVersion = result.bundle.configVersion;
        state.failureCount = 0;
        state.nextAttemptAt = 0;
        state.lastApplyAt = Date.now();
        state.lastError = null;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        process.stdout.write(
          `[MemoryAuthority] lease refreshed ws=${workspaceId} configVersion=${result.bundle.configVersion} (runtime unchanged)\n`,
        );
        if (memoryAuthorityRestored) {
          await this.rebindHermesMemoryCapabilities(workspaceId);
        }
        return;
      }
      const applier = applyBundle(result.bundle, toApplyState(state));
      if (applier.applied) {
        state.configVersion = applier.configVersion;
        state.runtimeFingerprint = runtimeFingerprint;
        state.lastApplyAt = Date.now();
        state.failureCount = 0;
        state.lastError = null;
        // F2: clear any pending backoff timer on success
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        // F1: persist providerBase to config.toml so the env overlay
        // survives daemon restarts (§3.9 应用缝). Skip if any hermes
        // profile has an operator override (prismerProviderBaseUrl) —
        // operator override is always highest priority.
        const providerBase = result.bundle.providerBase;
        let hasOperatorOverride = false;
        try {
          type ProfileRow2 = { config: string };
          const ovRows = this.db!
            .prepare(
              `SELECT config FROM agent_profiles WHERE workspace_id = ? AND adapter_name = 'hermes' AND deleted_at IS NULL LIMIT 1`,
            )
            .all(workspaceId) as ProfileRow2[];
          for (const r of ovRows) {
            try {
              const cfg = JSON.parse(r.config || '{}') as Record<string, unknown>;
              if (typeof cfg.prismerProviderBaseUrl === 'string' && cfg.prismerProviderBaseUrl.trim()) {
                hasOperatorOverride = true;
                break;
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        if (providerBase && !hasOperatorOverride) {
          this.config.cloud_api_base = providerBase;
          try { saveConfig(this.config); } catch (err) {
            process.stderr.write(
              `[ConfigDelivery] failed to persist providerBase: ${(err as Error).message}\n`,
            );
          }
          process.stderr.write(
            `[ConfigDelivery] persisted providerBase=${providerBase} to config.toml\n`,
          );
        }
        process.stdout.write(
          `[ConfigDelivery] applied bundle configVersion=${applier.configVersion}\n`,
        );
        // §3.4 drain before kill: wait for in-flight hermes turns to
        // complete before killing the gateway. An in-flight turn with a
        // half-written transcript pollutes the session → next turn EMPTY.
        state.pending = true;
        const drain = await drainBeforeGatewayKill({ maxWaitMs: 5 * 60 * 1000 });
        state.pending = false;
        process.stdout.write(
          `[ConfigDelivery] drain result: drained=${drain.drained} waitedMs=${drain.waitedMs} remaining=${drain.remainingInFlight}\n`,
        );
        // Kill gateway so next dispatch's ensureService respawns with
        // the new config. Same pattern as reprovisionHermesProfiles
        // but only after drain.
        if (!drain.drained) {
          process.stderr.write(
            `[ConfigDelivery] ⚠️ drain timed out with ${drain.remainingInFlight} in-flight turns — skipping gateway kill to avoid L3 pollution\n`,
          );
        } else {
          try {
            // Kill all hermes gateways for this workspace
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
            const rows = this.db!
              .prepare(
                `SELECT id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at
                 FROM agent_profiles WHERE deleted_at IS NULL AND adapter_name = 'hermes' AND workspace_id = ?`,
              )
              .all(workspaceId) as ProfileRow[];
            for (const row of rows) {
              const profile = {
                id: row.id,
                workspaceId: row.workspace_id,
                agentImUserId: row.agent_im_user_id,
                adapterName: row.adapter_name,
                name: row.name,
                config: JSON.parse(row.config || '{}') as Record<string, unknown>,
                version: row.version,
                createdAt: new Date(row.synced_at ?? Date.now()),
                updatedAt: new Date(row.synced_at ?? Date.now()),
              };
              await stopHermesGatewayForProfile(profile as import('../adapters/contract.js').AgentProfile);
              process.stderr.write(
                `[ConfigDelivery] killed hermes gateway after bundle apply (profile=${row.name})\n`,
              );
            }
          } catch (err) {
            process.stderr.write(
              `[ConfigDelivery] gateway kill failed: ${(err as Error).message}\n`,
            );
          }
        }

        // §3.3 per-profile model: write each profile's model override
        // to its own config.yaml (provider is root-only; model is per-profile
        // to avoid cross-profile overwrites).
        const models = result.bundle.hermes.models;
        if (models && Object.keys(models).length > 0) {
          const { writeFileSync: wfs, mkdirSync: mds } = await import('node:fs');
          const { join: jn } = await import('node:path');
          for (const [profileName, modelName] of Object.entries(models)) {
            const profileDir = getHermesProfileDir(profileName);
            try {
              mds(profileDir, { recursive: true });
              wfs(
                jn(profileDir, 'config.yaml'),
                `# Generated by ConfigDelivery — profile model override\nmodel:\n  default: ${modelName}\n`,
                'utf-8',
              );
              process.stderr.write(
                `[ConfigDelivery] wrote per-profile model (profile=${profileName} model=${modelName})\n`,
              );
            } catch (err) {
              process.stderr.write(
                `[ConfigDelivery] failed to write per-profile model (profile=${profileName}): ${(err as Error).message}\n`,
              );
            }
          }
        }
        if (memoryAuthorityRestored) {
          await this.rebindHermesMemoryCapabilities(workspaceId);
        }
      } else if (!applier.error) {
        // applyBundle also returns applied=false when the generated Hermes
        // files already match byte-for-byte. Treat that as a successful
        // bootstrap: the authority snapshot above is live and this process
        // must remember the new version/fingerprint without needlessly
        // restarting the gateway.
        state.configVersion = applier.configVersion;
        state.runtimeFingerprint = runtimeFingerprint;
        state.lastApplyAt = Date.now();
        state.failureCount = 0;
        state.nextAttemptAt = 0;
        state.lastError = null;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        process.stdout.write(
          `[ConfigDelivery] bundle already current configVersion=${applier.configVersion}\n`,
        );
        if (memoryAuthorityRestored) {
          await this.rebindHermesMemoryCapabilities(workspaceId);
        }
      } else {
        // Bundle fetch succeeded but apply failed (e.g. disk full, permission
        // denied). Keep old config, log, emit incident.
        state.lastError = applier.error;
        state.failureCount++;
        process.stderr.write(
          `[ConfigDelivery] ❌ bundle apply failed: ${applier.error} (configVersion=${applier.configVersion})\n`,
        );
        this.emitBootstrapIncident(workspaceId, 'config_apply_error', {
          configVersion: applier.configVersion,
          error: applier.error,
          attempt: state.failureCount,
        });
      }
    }
  }

  /**
   * Hermes profile actor ids (`agent_im_user_id`) for a workspace — the local
   * actors whose cap-mintability flips are detected by
   * `authorityActorMintableGained` after each authority registration.
   * Best-effort: an unreadable local DB yields [] (no widened rebind, the
   * empty→registered trigger still applies).
   */
  private hermesProfileActorIds(workspaceId: string): string[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT agent_im_user_id FROM agent_profiles
           WHERE deleted_at IS NULL AND adapter_name = 'hermes' AND workspace_id = ?`,
        )
        .all(workspaceId) as Array<{ agent_im_user_id: string | null }>;
      return rows.map((row) => row.agent_im_user_id).filter((id): id is string => Boolean(id));
    } catch {
      return [];
    }
  }

  /**
   * A Memory authority snapshot and its signing key are deliberately per boot.
   * On a filesystem checkpoint restore the Hermes profile files are already
   * current, so ConfigDelivery can legitimately take either unchanged branch.
   * Profiles may meanwhile have prewarmed before B1 registered the new
   * snapshot; those gateways carry no PRISMER_MEMORY_CAP (or a prior-boot cap)
   * forever. Atomically fence the cached service, stop the exact gateway, and
   * immediately prewarm it again now that mintCapV2 can succeed.
   */
  private async rebindHermesMemoryCapabilities(workspaceId: string): Promise<void> {
    if (!this.db) return;
    const adapter = this.registry.get('hermes');
    if (!adapter) return;
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
         FROM agent_profiles WHERE deleted_at IS NULL AND adapter_name = 'hermes' AND workspace_id = ?`,
      )
      .all(workspaceId) as ProfileRow[];

    for (const row of rows) {
      const profile: AgentProfile = {
        id: row.id,
        workspaceId: row.workspace_id,
        agentImUserId: row.agent_im_user_id,
        adapterName: row.adapter_name,
        name: row.name,
        config: parseProfileConfig(row.config),
        version: row.version,
        createdAt: new Date(row.synced_at ?? Date.now()),
        updatedAt: new Date(row.synced_at ?? Date.now()),
      };
      await this.servicePool.invalidate(profile.id, () => stopHermesGatewayForProfile(profile));
      const warmProfile = withPerAgentSkillsDir(profile, this.paths, this.config?.daemon_id);
      this.prewarmProfileService(warmProfile, adapter);
      process.stdout.write(
        `[MemoryAuthority] rebound hermes gateway after per-boot authority restore profile=${profile.id}\n`,
      );
    }
  }

  /**
   * product207/29 fixup (2.2.8) — re-provision Hermes provider config after
   * the WS handshake adopts the real per-workspace API key.
   *
   * ACS sandboxes boot with the entrypoint placeholder key; any Hermes
   * gateway spawned before adoption holds the placeholder in its env and its
   * provider bootstrap (configurePrismerProvider) was written against it —
   * sandbox agents then fail with "No LLM provider configured" (2026-08-06).
   * Re-running prepareProfile rewrites the ROOT ~/.hermes config with the
   * adopted key (2.2.8 root write), then every hermes gateway is killed so
   * the next dispatch's ensureService respawns it with the real env/config.
   * k8s/local daemons have a real key from boot — the rewrite is
   * byte-identical and this is a one-time gateway restart, no behavioural
   * change.
   */
  private async reprovisionHermesProfiles(): Promise<void> {
    if (!this.db) return;
    const adapter = this.registry.get('hermes');
    if (!adapter?.prepareProfile) return;
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
    try {
      const rows = this.db
        .prepare(
          `SELECT id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at
           FROM agent_profiles WHERE deleted_at IS NULL AND adapter_name = 'hermes'`,
        )
        .all() as ProfileRow[];
      for (const row of rows) {
        const profile = {
          id: row.id,
          workspaceId: row.workspace_id,
          agentImUserId: row.agent_im_user_id,
          adapterName: row.adapter_name,
          name: row.name,
          config: parseProfileConfig(row.config),
          version: row.version,
          createdAt: new Date(row.synced_at ?? Date.now()),
          updatedAt: new Date(row.synced_at ?? Date.now()),
        };
        try {
          await adapter.prepareProfile(profile);
          await stopHermesGatewayForProfile(profile);
          process.stderr.write(
            `[daemon] re-provisioned hermes provider after key adoption (profile=${getHermesProfileName(profile)})\n`,
          );
        } catch (err) {
          process.stderr.write(
            `[daemon] hermes re-provision failed profile=${row.id}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(
        `[daemon] hermes re-provision after adoption failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
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
    // R5 — an install is explicit user/controller intent: it outranks any
    // backoff (and is the "I fixed it, try again" affordance for a parked
    // daemon). Bounded by the user's own actions, so it cannot become a loop.
    this.declareGuard.onExplicitDeclare();
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
      const m = msg as {
        type?: string;
        // `retryable` is the R5 wire hint (`false | { afterMs }`), optional in
        // both directions — an old cloud simply never sends it.
        payload?: { code?: string; message?: string; retryable?: boolean | { afterMs?: number } };
      };
      if (m?.type) process.stdout.write(`[daemon] ws msg ← ${m.type}\n`);
      // Phase 6 / M1 — local IM gateway materializer tap (docs/desktop202/13 §5).
      // Side-effect-only: feed every incoming WS event to the materializer when
      // the gateway is enabled. It recognizes message/conversation/task events,
      // materializes them into rm_*, advances watermarks, and fans them out to
      // local SSE subscribers; everything else it ignores. This never disturbs
      // the runner's own switch below. Default OFF → no-op.
      if (this.gatewayMaterializer && m?.type) {
        this.gatewayMaterializer.ingest(msg as Record<string, unknown>);
      }
      if (m?.type === 'error') {
        process.stderr.write(`[daemon] ws error payload: ${JSON.stringify(msg)}\n`);
        // product206/13 §4-R5 — this is the ONLY place a cloud business
        // rejection is interpreted. It stays here rather than in
        // `handleIncoming`'s switch (which is where 13 originally proposed
        // `case 'error'`) because the AUTH_* stop path has always lived here:
        // two sites classifying the same frame is exactly how one of them
        // drifts. `handleIncoming` still sees the frame and still ignores it.
        //
        // What changed: before R5 everything that was not AUTH_* fell through
        // silently and the 30s tick re-declared unconditionally — so a refused
        // daemon looked "connected, hosting nothing" with no reason anywhere.
        const code = m.payload?.code;
        const message = m.payload?.message ?? '';
        const verdict = this.declareGuard.onError(code, message, m.payload?.retryable);
        switch (verdict.kind) {
          case 'fatal':
            // Cloud sends an application-level AUTH_FAILED instead of WS close
            // 4001 when the API key is invalid (post-handshake DB lookup
            // failed). Treat it like a transport-level auth-failed: surface to
            // caller, stop loop. UNCHANGED by R5 — a bad credential is not
            // something to back off on, it is something to stop for.
            process.stderr.write(`[daemon] application auth failure (${verdict.code}) — stopping daemon\n`);
            this.emit('auth-failed');
            break;
          case 'ignore':
            // Answer to a non-declare frame (e.g. WITHDRAW_DAEMON_MISMATCH).
            // Must not pollute declareBlocked — see declare-guard.ts.
            break;
          case 'transient':
            process.stderr.write(
              `[daemon] declare refused (${verdict.code}, retryable) — next attempt in ${Math.round(verdict.nextRetryInMs / 1000)}s: ${message}\n`,
            );
            break;
          case 'terminal':
            process.stderr.write(
              `[daemon] declare refused (${verdict.code}, NOT retryable) — ${
                verdict.nextRetryInMs === null
                  ? 'no further attempts; this device stays unaccepted until a human acts'
                  : `probing once more in ${Math.round(verdict.nextRetryInMs / 1000)}s`
              }: ${message}\n`,
            );
            break;
        }
        // local-first: whatever the verdict, the daemon keeps running. Local
        // dispatches, the local server, the asset/memory subsystems and every
        // in-flight run are untouched — being refused by the cloud is a
        // membership fact, not a health problem.
      }
      if (m?.type === 'authenticated') {
        // product207/29 — the cloud handshake can deliver the per-workspace
        // API key to ACS sandboxes whose boot env could not carry one (claim
        // envVars are a no-op on ACS v0.5.22). Adopt it so subsequent
        // reconnects authenticate with the real key.
        const ackPayload = (m as { payload?: { apiKey?: string; workspaceId?: string; daemonId?: string } }).payload;
        const apiKeyChanged = Boolean(ackPayload?.apiKey && ackPayload.apiKey !== this.config.api_key);
        if (apiKeyChanged && ackPayload?.apiKey) {
          this.config.api_key = ackPayload.apiKey;
          // §3.4 key rotation recovery: a new key resets any 401-stopped
          // bootstrap so the next triggerBootstrap can retry with it.
          if (ackPayload?.workspaceId) {
            const wsState = this.bootstrapStates.get(ackPayload.workspaceId);
            if (wsState) resetBootstrapStopped(wsState);
          }
          try {
            saveConfig(this.config);
            this.ws.setApiKey(ackPayload.apiKey);
            // product207/29 fixup (2.2.7) — the HTTP clients froze the
            // boot-time placeholder key at construction (CloudClient opts /
            // PRISMER_API_KEY env). Without re-pointing them, every HTTP call
            // 401s "API key not found or revoked": adopt-agent profile sync
            // fails → declare stays 0/0 → agents_bound parks forever.
            this.cloud.setApiKey(ackPayload.apiKey);
            process.env.PRISMER_API_KEY = ackPayload.apiKey;
            process.stdout.write(
              `[daemon] adopted cloud-delivered api key (workspace=${ackPayload.workspaceId ?? '?'}, daemonId=${ackPayload.daemonId ?? '?'})\n`,
            );
          } catch (err) {
            process.stderr.write(`[daemon] could not persist adopted api key: ${(err as Error).message}\n`);
          }
        }

        // product209/07 B1 is required on every daemon startup/reconnect.
        // It must not be nested under api-key adoption: after the first ACS
        // handshake the real key is persisted, so all later starts normally
        // authenticate with an unchanged key.  That was the exact hole which
        // left pre-config Hermes gateways running in sandbox-v6.
        const bootstrapWorkspaceId = bootstrapTargetAfterAuthenticated({
          apiKeyChanged,
          ackWorkspaceId: ackPayload?.workspaceId,
          currentWorkspaceId:
            this.workspaceOverride || process.env.PRISMER_WORKSPACE_ID || this.workspaceId || undefined,
        });
        if (bootstrapWorkspaceId) {
          void this.triggerBootstrap(bootstrapWorkspaceId);
        } else if (apiKeyChanged) {
          // Back-compat for old cloud handshakes and unbound local daemons.
          void this.reprovisionHermesProfiles();
        }
        // product207/29 fixup (F3) — the ACS binding ack also delivers the
        // canonical daemonId (the im_containers row's UUID). The sandbox boots
        // with `container:<hostname>` (entrypoint derivation); declare must use
        // the canonical id or the setup's daemonHasSignal lookup (binding /
        // liveness keyed on the row's daemonId) never hits and daemon_connected
        // parks forever. Adopt it exactly like apiKey. Only the ACS binding
        // path sends it (handler.ts: extra.daemonId), so desktop/local daemons
        // are unaffected.
        if (ackPayload?.daemonId && ackPayload.daemonId !== this.config.daemon_id) {
          this.config.daemon_id = ackPayload.daemonId;
          try {
            saveConfig(this.config);
            process.stdout.write(`[daemon] adopted cloud-delivered daemon id (${ackPayload.daemonId})\n`);
          } catch (err) {
            process.stderr.write(`[daemon] could not persist adopted daemon id: ${(err as Error).message}\n`);
          }
        }
        process.stdout.write(`[daemon] ws authenticated, sending agent.host.declare (${this.hostedAgents.size} agents)\n`);
        // R5 — a fresh connection resets the ladder: reconnect is the high-
        // frequency path and must never inherit a previous episode's backoff.
        this.declareGuard.onConnected();
        this.hostAckCatchupGate.onConnected();
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

  /**
   * F1-b (2026-07-27) — retarget a RUNNING daemon at another workspace.
   *
   * The user switching / creating / deleting the desktop's active workspace used
   * to be invisible to a live daemon: `config.toml` carries no workspace field,
   * `PRISMER_WORKSPACE_ID` is frozen at spawn, and `GET /workspaces/sync` has a
   * client method with no caller. The daemon kept declaring into the workspace it
   * booted with, forever.
   *
   * We redeclare rather than restart because a restart kills in-flight runs, and
   * `agent.host.declare` is explicitly refresh-on-redeclare on the cloud side
   * (`src/im/ws/handler.ts` — "the latest declare wins": shadows are torn down and
   * rebuilt, bindings go through `handleHostDeclare` which returns `refreshed`
   * for the same daemon). Verified against the real cloud, not inferred.
   *
   * Idempotent: same id ⇒ `changed:false` and no frame, so a controller may call
   * this on every prefs write. When the socket is down we still record the intent;
   * the next `authenticated` ack declares with it.
   */
  setDeclaredWorkspace(workspaceId: string): { changed: boolean; workspaceId: string; declared: boolean } {
    const next = (workspaceId ?? '').trim();
    const current = this.workspaceOverride || process.env.PRISMER_WORKSPACE_ID || this.workspaceId || '';
    if (!next || next === current) {
      return { changed: false, workspaceId: current, declared: false };
    }
    this.workspaceOverride = next;
    if (!this.wsConnected) {
      process.stdout.write(`[daemon] workspace override → ${next} (ws down; will declare on reconnect)\n`);
      return { changed: true, workspaceId: next, declared: false };
    }
    process.stdout.write(`[daemon] workspace override → ${next} (redeclaring)\n`);
    // R5 — same as the install path: switching workspace is explicit intent and
    // is precisely how a user recovers from a workspace-scoped refusal
    // (DAEMON_FORGOTTEN / WORKSPACE_ACTIVE_DEVICE_BUSY are per-workspace).
    this.declareGuard.onExplicitDeclare();
    this.sendDeclare();
    return { changed: true, workspaceId: next, declared: true };
  }

  private sendDeclare(): void {
    const payload: AgentHostDeclarePayload = {
      daemonId: this.config.daemon_id,
      // F1-b — live controller intent outranks the spawn-frozen env. See
      // `workspaceOverride`.
      workspaceId: this.workspaceOverride || process.env.PRISMER_WORKSPACE_ID || this.workspaceId || undefined,
      // 2026-07-20 — was a hardcoded '0.0.0' literal for every k8s/CLI daemon
      // (only tests/desktop set opts.daemonVersion), which is what
      // im_agent_bindings.daemonVersion and the Redis presence blob recorded.
      // Resolve the real running version like bundleVersion/healthz do.
      daemonVersion: this.opts.daemonVersion ?? this.resolveDaemonVersion(),
      // product204/08 §2.3 step 4 — the runtime version ACTUALLY executing.
      // After a boot-time OTA the process runs the bundle's cli.js, so its own
      // package.json IS the bundle version; on a builtin boot it is the
      // image/npm version. resolveDaemonVersion() probes exactly that (with
      // the opts override for tests/desktop embedding).
      bundleVersion: this.resolveDaemonVersion(),
      // product209/16 §8.2/§13.1 — declare the runtime's memory authority
      // capabilities. Cloud validates + stamps into IMAgentCard.metadata and
      // uses the claim for the strict-mode daemon compatibility gate
      // (missing/conflicting claims → legacy, never compatible).
      runtimeCapabilities: [
        ...MEMORY_RUNTIME_CAPABILITIES_V1,
        // G2-R R-1 — device telemetry capability bit, present only when the
        // device-metrics plugin module actually mounted. Unmounted ⇒ absent
        // claim ⇒ cloud treats telemetry as not offered (additive: the
        // strict-mode memory gate is a subset check over this array).
        // G2-R R-2 — terminal capability bit, present only when the
        // terminal-sessions module mounted AND its pty actually loaded.
        // Degraded (no node-pty) ⇒ absent claim ⇒ cloud treats the terminal
        // as not offered (additive, same subset-check seam as runtime.metrics).
        ...(this.terminalSessions?.available ? [RUNTIME_CAPABILITY_TERMINAL] : []),
        ...(this.deviceMetrics ? [RUNTIME_CAPABILITY_DEVICE_METRICS] : []),
      ],
      platform: platform() === 'win32' ? 'win32' : platform() === 'linux' ? 'linux' : 'darwin',
      // desktop204 D204-3 — ALWAYS declare the device identity. Before this the
      // daemon sent neither field and the cloud had to infer both from the
      // daemonId string (`daemon-*` ⇒ local, suffix ⇒ label) — a guess that is
      // wrong for every id that doesn't follow that convention and that can
      // never surface a user-chosen device name. The daemon is the only process
      // that knows the truth, so it states it. Cloud keeps its guess as the
      // legacy-daemon fallback.
      daemonLabel: resolveDaemonLabel({
        configLabel: this.config.daemon_label,
        daemonId: this.config.daemon_id,
      }),
      daemonKind: resolveDaemonKind(),
      agents: Array.from(this.hostedAgents.values()).map((a) => ({
        imUserId: a.imUserId,
        name: a.name,
        adapterName: a.adapterName,
        capabilities: a.capabilities,
        // release203/08 WS-E (capability-exposure seam) — ride the registered
        // AdapterDef capability flags on the existing declare wire so cloud can
        // feature-gate the live model-switch / rewind UI. Coding adapters set
        // these via makeCodeAgentAdapter; runtime engines set them via
        // makeRuntimeAgentEngineAdapter. Hermes/openclaw/CLI leave it undefined.
        capabilityFlags: this.registry.get(a.adapterName)?.capabilityFlags,
        profiles: Array.from(a.profiles.entries()).map(([id, version]) => ({ id, version })),
      })),
    };
    this.ws.send(envelope('agent.host.declare', payload, this.config.daemon_id));
  }

  /**
   * desktop204 D204-4 — emit `agent.host.withdraw` on an intentional shutdown.
   *
   * Contract (cloud: src/im/ws/handler.ts `handleAgentHostWithdraw`): the
   * payload daemonId MUST equal the daemonId this WS connection declared, or
   * the cloud answers `WITHDRAW_DAEMON_MISMATCH` and ignores it — a daemon can
   * only withdraw itself. We therefore send the same `this.config.daemon_id`
   * that sendDeclare() used, on the same still-open socket.
   *
   * Best-effort, and that is a hard requirement, not a nicety: an offline
   * laptop (⌘Q on a plane) or a socket the cloud already dropped must not
   * delay quit by one millisecond beyond the flush budget.
   */
  private async sendHostWithdraw(intent: WithdrawIntent, inflightDrained: boolean): Promise<void> {
    const daemonId = this.config?.daemon_id;
    if (!daemonId || !this.ws) return;
    const payload: AgentHostWithdrawPayload = {
      daemonId,
      reason: intent.reason,
      inflightDrained,
    };
    const timeoutMs = intent.timeoutMs ?? WITHDRAW_FLUSH_TIMEOUT_MS;
    try {
      const flushed = await this.ws.sendAndFlush(envelope('agent.host.withdraw', payload, daemonId), timeoutMs);
      process.stdout.write(
        `[daemon] agent.host.withdraw reason=${intent.reason} inflightDrained=${inflightDrained} flushed=${flushed}\n`,
      );
    } catch (err) {
      // Never propagate: a failed withdraw just falls back to the cloud's
      // 3-minute stale path, which is exactly today's behaviour.
      process.stderr.write(`[daemon] agent.host.withdraw failed (non-fatal): ${(err as Error).message}\n`);
    }
  }

  private handleIncoming(msg: { type: string; payload: unknown; requestId?: string }): void {
    switch (msg.type) {
      case 'host.acked':
        void this.onHostAcked(msg.payload as HostAckedPayload);
        return;
      case 'task.dispatch.request':
        void this.onTaskDispatch(msg.payload as TaskDispatchRequestPayload, msg.requestId);
        return;
      // product209/18 Part B — 上传两段式：cloud 推物化请求，daemon 拉字节入
      // asset-cache 后回 ack（幂等，失败带 error 不重试）。
      case 'asset.materialize.request':
        void this.onAssetMaterializeRequest(msg.payload as AssetMaterializeRequestPayload, msg.requestId);
        return;
      case 'task.cancel':
        this.onTaskCancel(msg.payload as TaskCancelPayload);
        return;
      // product204/36 — user-clicked OTA apply (phase 2). Ack, then reuse the
      // release203/19 drain_respawn machinery: reject new dispatches, drain
      // in-flight, graceful stop + exit(0); the supervisor respawns and
      // boot-time OTA swaps to the staged release.
      case 'runtime.update.apply':
        this.onRuntimeUpdateApply(msg.payload as RuntimeUpdateApplyPayload, msg.requestId);
        return;
      // product206/13 §6-D1 / §6-D2 — the cloud says "what was blocking you is
      // fixed, ask again now". Sent after the user re-claims credentials or
      // reassigns a workspace's local slot.
      //
      // Why this frame has to exist: R5 classifies those refusals as TERMINAL,
      // so after two bounded probes the daemon goes quiet. That bound is right
      // (a permanently-claimed daemonId must stop talking) but it means a user
      // who fixes things 20 minutes later would be talking to a daemon that
      // stopped asking — and "restart your daemon" is exactly the answer R5's
      // 出入1 refused to ship. The socket is still up while parked, so the cloud
      // can just tell us. Reuses `onExplicitDeclare()`, the same un-park seam
      // `POST /v1/workspace` uses; no new state machine.
      case 'daemon.declare.retry': {
        const p = (msg.payload ?? {}) as { reason?: string; daemonIds?: string[] };
        // Frames are addressed to the OWNER (rooms keys by human IMUser id), so
        // every daemon of that account receives it. Ignore the ones not meant
        // for us rather than firing a pointless declare per sibling daemon.
        if (Array.isArray(p.daemonIds) && p.daemonIds.length > 0 && !p.daemonIds.includes(this.config.daemon_id)) {
          return;
        }
        process.stdout.write(`[daemon] cloud asked for a declare retry (${p.reason ?? 'unspecified'})\n`);
        this.declareGuard.onExplicitDeclare();
        if (this.wsConnected) this.sendDeclare();
        return;
      }
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
      // release203/08 WS-E — out-of-band control of a LIVE code-agent session.
      // Each reaches the live AdapterService for the target agent (same
      // servicePool as dispatch) and calls setModel / listCommands / revert,
      // then echoes the `_rpcId` back via `agent.session.reply`. Interrupt is
      // NOT here — task.cancel (above) already maps to session.interrupt().
      case 'agent.session.set_model':
        void this.onAgentSessionControl('set_model', msg.payload);
        return;
      case 'agent.session.list_commands':
        void this.onAgentSessionControl('list_commands', msg.payload);
        return;
      case 'agent.session.rewind':
        void this.onAgentSessionControl('rewind', msg.payload);
        return;
      // release203/09 §3.2 — container directory listing for the Pro creation
      // repo picker. Cloud's WsRpcService pushes `{ workspaceId, projectId?,
      // subpath?, _rpcId }`; we readdir the per-project `repos/` scope (jailed
      // in the workspace root) and echo `agent.fs.reply` with the `_rpcId`.
      case 'agent.fs.list':
        void this.onAgentFsList(msg.payload);
        return;
      // release203/21 §6 R1 — read/write a single file under the per-project
      // `repos/` scope (jailed in the workspace root), echoing the result via
      // `agent.fs.read.reply` / `agent.fs.write.reply` with the same `_rpcId`.
      // Old daemons lack these cases → the cloud invoke times out and the UI
      // degrades to read-only (graceful, no crash).
      case 'agent.fs.read':
        void this.onAgentFsRead(msg.payload);
        return;
      case 'agent.fs.write':
        void this.onAgentFsWrite(msg.payload);
        return;
      // release203/09 §7.3 — materialize a persistent code-agent workdir on the
      // daemon host/container (git clone / git init / verify a container-picked
      // path). Cloud's WsRpcService pushes `{ workspaceId, projectId?, source,
      // sourceRef?, name?, cwd?, _rpcId }`; we resolve+jail the cwd then reuse
      // ensureWorkdir, echoing `agent.workdir.reply` with the same `_rpcId`.
      case 'agent.workdir.materialize':
        void this.onAgentWorkdirMaterialize(msg.payload);
        return;
      // apc/05 §1 A2 (S8 git-ops) — commit / branch / merge / push inside a
      // materialized workdir. Same reverse-RPC shape as the workdir case above:
      // cloud pushes `{ workspaceId, cwd, op, …, _rpcId }`, we jail the cwd in
      // `workspaces/<wid>` and echo `agent.git.reply` with the same `_rpcId`.
      case 'agent.git.exec':
        void this.onAgentGitExec(msg.payload);
        return;
      // G2-R R-2 — terminal.* method family (daemon-protocol PTY, spec §T-1).
      // Handlers swallow malformed/unknown frames (ignore + log) — they never
      // throw into dispatch. Degraded module ⇒ open answered with the typed
      // terminal_unavailable error; unmounted module ⇒ optional-chain no-op.
      case 'terminal.open':
        this.terminalSessions?.handleOpen(msg.payload, msg.requestId);
        return;
      case 'terminal.write':
        this.terminalSessions?.handleWrite(msg.payload);
        return;
      case 'terminal.resize':
        this.terminalSessions?.handleResize(msg.payload);
        return;
      case 'terminal.close':
        this.terminalSessions?.handleClose(msg.payload);
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
      // product209/16 §8.2 — authority snapshot invalidation (WS owned
      // channel). Cloud pushes this when a Task 9 authority mutation
      // (assignee / council participant / daemon binding change) flips the
      // workspace epoch. The daemon drops the registered snapshot
      // (immediately fail-closed: no further v2 caps can be minted) and
      // force-refreshes the bootstrap bundle so a fresh snapshot arrives
      // without waiting out the 60s assembly-cache TTL. Offline / frame
      // lost → convergence is bounded by the snapshot lease (60m).
      case 'memory.authority.invalidate': {
        const inv = msg.payload as { workspaceId?: unknown; accessVersion?: unknown };
        if (typeof inv?.workspaceId === 'string' && inv.workspaceId) {
          invalidateMemoryAuthoritySnapshot(inv.workspaceId);
          process.stdout.write(
            `[MemoryAuthority] snapshot invalidated ws=${inv.workspaceId} ` +
              `accessVersion=${String(inv.accessVersion ?? '-')} — forcing bootstrap refresh\n`,
          );
          void this.triggerBootstrap(inv.workspaceId, { force: true });
        }
        return;
      }
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
   * release203/09 §3.2 — container directory listing over the WS reverse
   * channel for the Pro creation repo picker.
   *
   * Cloud pushes `{ workspaceId, projectId?, subpath?, _rpcId }`. We resolve the
   * per-project `repos/` base (`resolveProjectReposDir`), jail the navigation in
   * the workspace root (`workspaces/<wid>`), readdir, and echo the result back
   * via `agent.fs.reply` carrying the identical `_rpcId` so cloud's WsRpcService
   * settles the pending promise. The browser only sends a logical scope — never
   * an absolute path — so path escape is impossible to express and is rejected
   * here (`path_escape`) if the resolved subpath leaves the jail.
   */
  private async onAgentFsList(payload: unknown): Promise<void> {
    const p = (payload ?? {}) as {
      workspaceId?: string;
      projectId?: string | null;
      subpath?: string;
      _rpcId?: string;
    };
    const rpcId = p._rpcId;
    if (!rpcId) {
      process.stderr.write(`[daemon] agent.fs.list without _rpcId — dropped\n`);
      return;
    }
    // workspaceId is a PATH SEGMENT joined onto workspacesDir to build the jail
    // root; an unchecked `..` in it lifts the root out of the workspace (see
    // path-jail.ts). Same guard on all four workspace-rooted RPCs below.
    if (!isSafeSegment(p.workspaceId)) {
      this.ws.send({
        type: 'agent.fs.reply',
        payload: { _rpcId: rpcId, ok: false, error: { code: 'read_failed', message: 'bad request' } },
      });
      return;
    }

    const base = resolveProjectReposDir(this.paths, p.workspaceId, p.projectId ?? null);
    const root = join(this.paths.workspacesDir, p.workspaceId);
    const result = await listReposDir(base, root, p.subpath);

    this.ws.send({ type: 'agent.fs.reply', payload: { _rpcId: rpcId, ...result } });
  }

  /**
   * release203/21 §6 R1 — read a single file under the per-project `repos/`
   * scope over the WS reverse channel (mirror of `onAgentFsList`).
   *
   * Cloud pushes `{ workspaceId, projectId?, subpath?, path, _rpcId }`. We
   * resolve+jail the target under the workspace root, read it (utf8 or base64
   * for binary), and echo `agent.fs.read.reply` with the same `_rpcId`. Files
   * over 1 MiB return `too_large` so the browser uses the asset channel.
   */
  private async onAgentFsRead(payload: unknown): Promise<void> {
    const p = (payload ?? {}) as {
      workspaceId?: string;
      projectId?: string | null;
      subpath?: string;
      path?: string;
      _rpcId?: string;
    };
    const rpcId = p._rpcId;
    if (!rpcId) {
      process.stderr.write(`[daemon] agent.fs.read without _rpcId — dropped\n`);
      return;
    }
    if (!isSafeSegment(p.workspaceId) || !p.path) {
      this.ws.send({
        type: 'agent.fs.read.reply',
        payload: { _rpcId: rpcId, ok: false, error: { code: 'read_failed', message: 'bad request' } },
      });
      return;
    }

    const base = resolveProjectReposDir(this.paths, p.workspaceId, p.projectId ?? null);
    const root = join(this.paths.workspacesDir, p.workspaceId);
    const result = await readReposFile(base, root, p.subpath, p.path);

    this.ws.send({ type: 'agent.fs.read.reply', payload: { _rpcId: rpcId, ...result } });
  }

  /**
   * release203/21 §6 R1 — write a single file under the per-project `repos/`
   * scope over the WS reverse channel (mirror of `onAgentFsList`).
   *
   * Cloud pushes `{ workspaceId, projectId?, subpath?, path, content, encoding,
   * ifMatchSha256?, _rpcId }`. We resolve+jail the target, optionally enforce
   * `ifMatchSha256` (→ `conflict`), write atomically (temp + rename, parent
   * dirs created), and echo `agent.fs.write.reply` with the same `_rpcId`.
   */
  private async onAgentFsWrite(payload: unknown): Promise<void> {
    const p = (payload ?? {}) as {
      workspaceId?: string;
      projectId?: string | null;
      subpath?: string;
      path?: string;
      content?: string;
      encoding?: 'utf8' | 'base64';
      ifMatchSha256?: string;
      _rpcId?: string;
    };
    const rpcId = p._rpcId;
    if (!rpcId) {
      process.stderr.write(`[daemon] agent.fs.write without _rpcId — dropped\n`);
      return;
    }
    if (!isSafeSegment(p.workspaceId) || !p.path || typeof p.content !== 'string') {
      this.ws.send({
        type: 'agent.fs.write.reply',
        payload: { _rpcId: rpcId, ok: false, error: { code: 'write_failed', message: 'bad request' } },
      });
      return;
    }

    const base = resolveProjectReposDir(this.paths, p.workspaceId, p.projectId ?? null);
    const root = join(this.paths.workspacesDir, p.workspaceId);
    const result = await writeReposFile(
      base,
      root,
      p.subpath,
      p.path,
      p.content,
      p.encoding === 'base64' ? 'base64' : 'utf8',
      p.ifMatchSha256,
    );

    this.ws.send({ type: 'agent.fs.write.reply', payload: { _rpcId: rpcId, ...result } });
  }

  /**
   * release203/09 §7.3 — materialize a persistent code-agent workdir.
   *
   * Cloud pushes `{ workspaceId, projectId?, source, sourceRef?, name?, cwd?,
   * _rpcId }`. We resolve the per-project `repos/` base, jail the target cwd in
   * the workspace root (`workspaces/<wid>`), then delegate to `ensureWorkdir`
   * (idempotent git clone / git init / verify-pick). The result echoes back via
   * `agent.workdir.reply` carrying the identical `_rpcId` so cloud's
   * WsRpcService settles the pending promise.
   *
   * - clone/init: `name` must be a single folder segment (`base/<name>`).
   * - container-pick: the picked absolute path arrives in `cwd` and is jailed.
   * Out-of-jail → path_escape; missing required fields → bad_request; any
   * materialization failure → materialize_failed.
   */
  private async onAgentWorkdirMaterialize(payload: unknown): Promise<void> {
    const p = (payload ?? {}) as {
      workspaceId?: string;
      projectId?: string | null;
      source?: MaterializeSource;
      sourceRef?: string;
      name?: string;
      cwd?: string;
      _rpcId?: string;
    };
    const rpcId = p._rpcId;
    if (!rpcId) {
      process.stderr.write(`[daemon] agent.workdir.materialize without _rpcId — dropped\n`);
      return;
    }

    const replyError = (
      code: 'path_escape' | 'materialize_failed' | 'bad_request',
      message?: string,
    ): void => {
      this.ws.send({
        type: 'agent.workdir.reply',
        payload: { _rpcId: rpcId, ok: false, error: { code, ...(message ? { message } : {}) } },
      });
    };

    if (!isSafeSegment(p.workspaceId) || !p.source) {
      replyError('bad_request', 'workspaceId and source are required');
      return;
    }

    const base = resolveProjectReposDir(this.paths, p.workspaceId, p.projectId ?? null);
    const root = join(this.paths.workspacesDir, p.workspaceId);

    const resolved = resolveWorkdirCwd(base, root, p.source, p.name, p.cwd);
    if (!resolved.ok) {
      replyError(resolved.code, resolved.message);
      return;
    }

    try {
      const result = await ensureWorkdir(
        { id: 'materialize', cwd: resolved.cwd, source: p.source, sourceRef: p.sourceRef },
        { timeoutMs: 120_000 },
      );
      this.ws.send({
        type: 'agent.workdir.reply',
        payload: { _rpcId: rpcId, ok: true, data: { cwd: result.cwd, action: result.action } },
      });
    } catch (err) {
      const message =
        err instanceof WorkdirMaterializeError ? err.message : (err as Error).message;
      replyError('materialize_failed', message);
    }
  }

  /**
   * apc/05 §1 A2 — run a git op inside a materialized workdir.
   *
   * Glue only: pull `_rpcId`, delegate to `runGitExecRequest` (which owns the
   * jail + allowlist + conflict handling and is unit-tested against real
   * repos), echo `agent.git.reply` with the same `_rpcId` so cloud's
   * WsRpcService settles the pending promise.
   */
  private async onAgentGitExec(payload: unknown): Promise<void> {
    const p = (payload ?? {}) as GitExecPayload;
    const rpcId = p._rpcId;
    if (!rpcId) {
      process.stderr.write(`[daemon] agent.git.exec without _rpcId — dropped\n`);
      return;
    }
    const reply = await runGitExecRequest(
      p,
      (workspaceId) => join(this.paths.workspacesDir, workspaceId),
      { remoteAllowlist: remoteAllowlistFromEnv(process.env.PRISMER_GIT_REMOTE_ALLOWLIST) },
    );
    this.ws.send({ type: 'agent.git.reply', payload: { _rpcId: rpcId, ...reply } });
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
    const runHeavyCatchup = this.hostAckCatchupGate.takeHeavyCatchup(payload.workspaceId);
    // product206/13 §4-R5 — `host.acked` IS the accept signal: the episode is
    // over, the ladder resets and `/healthz.declareBlocked` clears. Placed
    // first so a slow ack path can never leave a stale "refused" banner up.
    this.declareGuard.onAccepted();
    const bootstrapState = this.bootstrapStates.get(payload.workspaceId);
    if (bootstrapState && shouldRetryBootstrapAfterAcceptedDeclare(bootstrapState)) {
      process.stdout.write(
        `[ConfigDelivery] host.acked confirmed daemon binding — retrying transient bootstrap 403\n`,
      );
      resetBootstrapStopped(bootstrapState);
      void this.triggerBootstrap(payload.workspaceId);
    }
    // release203/19 #2 — version-skew directive. `warn` (or absent) is a no-op
    // here (cloud only logs/records it). `refuse_dispatch` / `drain_respawn`
    // gate new dispatches; `drain_respawn` additionally arms a one-shot drain
    // watcher that exits the process once in-flight runs settle.
    this.applyUpgradeDirective(payload.upgradeDirective);
    const ownershipLockChanged = await this.applyHostAckOwnershipLock(payload);

    // Transport is once-per-successful connection/workspace. A failed report
    // clears the gate so the next heartbeat retries; concurrent acks share one
    // in-flight attempt. Cloud still receives/acks every declare heartbeat.
    void this.hostAckCatchupGate.runTransportOnce(payload.workspaceId, async () => {
      try {
        await this.reportTransport();
      } catch (err) {
        process.stderr.write(`[daemon] transport-probe report failed: ${(err as Error).message}\n`);
        throw err;
      }
    });

    // Initial memory sync: now that workspaceId is known, populate local
    // MemoryStore from cloud. This is the primary trigger for the desktop
    // daemon flow (the startup sync in start() is a no-op until workspaceId
    // is set here). Fire-and-forget — failure is non-fatal.
    if (runHeavyCatchup && this.memoryWiring && this.workspaceId) {
      syncMemoryFromCloud(
        this.memoryWiring,
        this.cloud,
        [this.workspaceId],
        this.resolveIndexInjectTargets,
      ).catch((err: Error) => log.error('Initial memory sync failed', err.message));
    }

    // Asset sync triggered by host.acked (primary trigger for desktop daemon
    // flow, same pattern as memory sync above). This catches up metadata and
    // path bindings; bytes remain lazy unless explicitly prefetched.
    if (runHeavyCatchup) {
      this.syncAssetState(this.workspaceId).catch(
        (err: Error) => log.error('Asset sync failed', err.message),
      );
      await this.ensureDropFolderRuntime(this.workspaceId);
    }

    const profilesToSync = payload.profilesToSync ?? [];
    const profilesToDelete = payload.profilesToDelete ?? [];

    for (const id of profilesToSync) {
      try {
        await this.servicePool.drop(id);
        await this.syncProfileFromCloud(id, 'startup');
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

    // Adoption pass — pull agents into the local store, host them, and
    // re-declare so cloud's auto-first-declare builds a non-stale binding.
    // Two provenances, one mechanism (§26 SA-2):
    //
    //   reclaimedAgents (product204 rebind-fix) — agents bound to THIS daemon
    //     that we did NOT declare this round: we blacklisted them when an
    //     earlier declare was rejected as `bound-to-other-daemon`, then a
    //     rebind transferred ownership here. Clearing the in-memory blacklist
    //     (otherwise loadAgentsFromDb / syncProfileFromCloud keep skipping
    //     them) + re-syncing re-inserts the `agents` row. Without this the
    //     rebind "escape hatch" returns 200 but never takes effect — only a
    //     daemon restart clears the blacklist.
    //   adoptAgents (product204/26) — server-instantiated workspace agents that
    //     have no binding row and no push channel (blueprint instantiate on the
    //     cloud never pushed them into this fresh daemon). Cloud asks the
    //     workspace-runtime daemon to adopt them so they stop being stranded
    //     unbound → stale-reaped.
    //
    // Same shape (ReclaimedAgent), same handling → merge + dedupe by imUserId
    // (union profileIds). local-first: a per-profile sync failure is non-fatal
    // (emit sync-error, keep going); the next host.acked re-carries the agent
    // (cloud filters on still-unbound), so adoption retries next round.
    const adoptionChanged = await this.syncHostAckAdoptions(
      payload.reclaimedAgents ?? [],
      payload.adoptAgents ?? [],
      // bugfix211 G3 — an agent rejected by THIS SAME ack must not be adopted:
      // adoption clears the ownership blacklist (:4135) and re-creates the
      // local row the ownership lock just deleted, producing a declare↔ack
      // self-storm. The cloud filters these at the ack assembly point; this
      // guard keeps an OLD cloud + new daemon from re-entering the loop.
      new Set((payload.rejectedAgents ?? []).map((r) => r.imUserId)),
    );

    if (
      (ownershipLockChanged ||
        profilesToSync.length > 0 ||
        profilesToDelete.length > 0 ||
        adoptionChanged) &&
      this.wsConnected
    ) {
      this.sendDeclare();
    }
    this.emit('host-acked', payload);
  }

  /**
   * A fresh workspace-neutral ACS clone initially declares 0 agents. Cloud
   * returns the workspace roster in host.acked, and each profile sync performs
   * independent Cloud/file work before the daemon can re-declare the complete
   * roster. Keep profiles for one agent ordered, but overlap different agents
   * with a small fixed bound so a large team cannot fan out unbounded traffic.
   */
  private async syncHostAckAdoptions(
    reclaimedAgents: NonNullable<HostAckedPayload['reclaimedAgents']>,
    adoptAgents: NonNullable<HostAckedPayload['adoptAgents']>,
    rejectedThisRound: Set<string> = new Set(),
  ): Promise<boolean> {
    const toAdopt = new Map<string, Set<string>>();
    for (const r of reclaimedAgents) {
      if (rejectedThisRound.has(r.imUserId)) {
        process.stderr.write(
          `[daemon] skip reclaim agent=${r.imUserId} — rejected by this same ack; keeping the ownership blacklist\n`,
        );
        continue;
      }
      const set = toAdopt.get(r.imUserId) ?? new Set<string>();
      for (const pid of r.profileIds) set.add(pid);
      toAdopt.set(r.imUserId, set);
    }
    for (const a of adoptAgents) {
      if (rejectedThisRound.has(a.imUserId)) {
        process.stderr.write(
          `[daemon] skip adoption agent=${a.imUserId} — rejected by this same ack; keeping the ownership blacklist\n`,
        );
        continue;
      }
      // Idempotent: skip an adopt-only agent we already host (repeated acks
      // re-carry the same list until the binding lands). Reclaim entries are
      // never currently hosted (they were blacklisted) → always process; an
      // agent present in both is merged rather than skipped.
      if (this.hostedAgents.has(a.imUserId) && !toAdopt.has(a.imUserId)) continue;
      const set = toAdopt.get(a.imUserId) ?? new Set<string>();
      for (const pid of a.profileIds) set.add(pid);
      toAdopt.set(a.imUserId, set);
    }
    const entries = Array.from(toAdopt).filter(([, profileIds]) => profileIds.size > 0);
    if (entries.length === 0) return false;

    const startedAt = Date.now();
    const concurrency = Math.min(HOST_ACK_ADOPTION_CONCURRENCY, entries.length);
    const profileCount = entries.reduce((total, [, profileIds]) => total + profileIds.size, 0);
    process.stdout.write(
      `[daemon] host.acked adoption start agents=${entries.length} profiles=${profileCount} concurrency=${concurrency}\n`,
    );
    let nextEntryIndex = 0;
    const syncNextAgent = async (): Promise<void> => {
      while (nextEntryIndex < entries.length) {
        const entryIndex = nextEntryIndex;
        nextEntryIndex += 1;
        const [imUserId, profileIds] = entries[entryIndex]!;
        const agentStartedAt = Date.now();
        this.rejectedHostedAgentIds.delete(imUserId);
        for (const profileId of profileIds) {
          try {
            await this.servicePool.drop(profileId);
            await this.syncProfileFromCloud(profileId, 'startup');
          } catch (err) {
            this.emit('sync-error', err);
          }
        }
        process.stderr.write(
          `[daemon] adopt agent=${imUserId} — cleared ownership blacklist, synced ${profileIds.size} profile(s), took=${Date.now() - agentStartedAt}ms\n`,
        );
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => syncNextAgent()));
    this.loadAgentsFromDb();
    process.stdout.write(
      `[daemon] host.acked adoption complete agents=${entries.length} profiles=${profileCount} concurrency=${concurrency} took=${Date.now() - startedAt}ms\n`,
    );
    return true;
  }

  /**
   * release203/19 #2 — react to a version-skew directive from host.acked.
   *
   * `refuse_dispatch` and `drain_respawn` both make `onTaskDispatch` reject new
   * runs (via `this.upgradeDirective`). `drain_respawn` additionally arms a
   * one-shot watcher that, once all in-flight runs settle, performs a graceful
   * `stop()` + `process.exit(0)` so the device/k8s controller re-pulls a pod on
   * the new image. Idempotent: repeated declares with the same directive are
   * no-ops once armed. `warn`/absent clears any prior gate (cloud relaxed the
   * policy / fleet caught up).
   */
  private applyUpgradeDirective(directive?: HostAckedPayload['upgradeDirective']): void {
    if (directive === 'drain_respawn' || directive === 'refuse_dispatch') {
      if (this.upgradeDirective !== directive) {
        this.upgradeDirective = directive;
        process.stderr.write(
          `[daemon] version-skew directive=${directive} — refusing new dispatches${
            directive === 'drain_respawn' ? ' + will exit after in-flight runs drain' : ''
          }\n`,
        );
      }
      if (directive === 'drain_respawn' && !this.drainRespawnArmed) {
        this.drainRespawnArmed = true;
        this.armDrainRespawnWatcher();
      }
      return;
    }
    // `warn` or absent — relax any prior gate (idempotent; the common case is
    // it was never set).
    if (this.upgradeDirective) {
      process.stderr.write('[daemon] version-skew directive cleared — resuming normal dispatch\n');
      this.upgradeDirective = undefined;
    }
  }

  /**
   * product204/36 — user-clicked OTA apply (phase 2 of the two-phase flow).
   * Acks immediately with the in-flight count, then arms drain_respawn: the
   * daemon rejects new dispatches, waits for in-flight runs to settle (30min
   * cap), gracefully stops, and exits 0 so the supervisor (k8s restartPolicy /
   * desktop shell) respawns it — boot-time OTA then applies the staged
   * release. Idempotent: a second click while draining just re-acks.
   */
  private onRuntimeUpdateApply(payload: RuntimeUpdateApplyPayload, requestId?: string): void {
    const currentVersion = this.resolveDaemonVersion();
    const direction = evaluateRuntimeUpdateDirection({
      currentVersion,
      targetVersion: payload.targetVersion,
      decision: payload.decision,
    });
    const reply: RuntimeUpdateReplyPayload = {
      daemonId: this.config.daemon_id,
      accepted: direction.accepted,
      inFlight: this.runningTasks.size,
      currentVersion,
      targetVersion: payload.targetVersion,
      decision: direction.decision,
      ...(!direction.accepted ? { reason: direction.reason } : {}),
    };
    if (!direction.accepted) {
      process.stderr.write(
        `[daemon] runtime.update.apply refused reason=${direction.reason} target=${payload.targetVersion ?? '(missing)'} current=${currentVersion} decision=${payload.decision ?? 'ota'}\n`,
      );
      try {
        this.ws.send(envelope('runtime.update.reply', reply, requestId));
      } catch {
        /* rejection ack is best-effort */
      }
      return;
    }
    process.stderr.write(
      `[daemon] runtime.update.apply target=${direction.targetVersion} decision=${direction.decision} requestedBy=${payload.requestedBy ?? '(unknown)'} inFlight=${reply.inFlight} — arming drain_respawn\n`,
    );
    try {
      this.ws.send(envelope('runtime.update.reply', reply, requestId));
    } catch {
      /* ack is best-effort — the drain proceeds regardless */
    }
    this.applyUpgradeDirective('drain_respawn');
  }

  /**
   * Poll until no runs are in-flight, then gracefully stop + exit so the
   * controller re-pulls a new-image pod. Best-effort: a hard cap bounds the
   * wait so a wedged run can't block respawn forever.
   */
  private armDrainRespawnWatcher(): void {
    const start = Date.now();
    const MAX_DRAIN_MS = 30 * 60 * 1000; // 30min cap — then force respawn anyway.
    const POLL_MS = 5_000;
    const tick = async (): Promise<void> => {
      const inFlight = this.runningTasks.size;
      const elapsed = Date.now() - start;
      if (inFlight === 0 || elapsed >= MAX_DRAIN_MS) {
        process.stderr.write(
          `[daemon] drain_respawn complete (inFlight=${inFlight}, elapsedMs=${elapsed}) — exiting for respawn\n`,
        );
        // Minimal sync cleanup only — do NOT await stop(). K8s/desktop supervisor
        // restarts the process; the OS reclaims all resources (sockets, child
        // processes, file descriptors). Awaiting stop() can hang indefinitely on
        // servicePool.shutdown() (adapter subprocess won't exit) or
        // localServer.stop() (open HTTP connections), blocking respawn entirely
        // and forcing the user to manually delete the pod. Closing the WS lets
        // the cloud know we're going away; process.exit(0) is immediate after.
        try { this.ws?.close(); } catch { /* best-effort */ }
        try { this.gatewaySse?.stop(); } catch { /* best-effort */ }
        for (const entry of this.runningTasks.values()) {
          try { entry.ctrl.abort(); } catch { /* */ }
        }
        // Exit so the device/k8s controller re-launches on the new image.
        // Code 0: this is an intentional, healthy upgrade respawn, not a crash.
        process.exit(0);
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
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
    // desktop205 R2 — ownership gate. The cloud positively told us this
    // profile is no longer ours; running it would burn a turn on work the
    // cloud will reject anyway. Silent return (no reply frame) mirrors the
    // version-skew gate below: the cloud's redispatch is then free to reach a
    // daemon that legitimately owns the agent.
    const quarantined = this.quarantineBlocking(payload.profileId, payload.agentImUserId);
    if (quarantined) {
      process.stderr.write(
        `[daemon] dispatch refused task=${payload.taskId} — profile ${quarantined.profileId} is quarantined (not owned by this account since ${new Date(quarantined.since).toISOString()})\n`,
      );
      return;
    }
    // release203/19 #2 — version-skew gate. Under refuse_dispatch / drain_respawn
    // this daemon is running drifted code; do NOT accept the new run so the
    // cloud's redispatch reaches a healthy daemon (or the next-image pod after
    // respawn). Already-in-flight runs above are unaffected (they drain).
    if (this.upgradeDirective) {
      process.stderr.write(
        `[daemon] dispatch refused task=${payload.taskId} — version-skew directive=${this.upgradeDirective}\n`,
      );
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
      // desktop205/04 §4 (W13) — Tray descriptors. `scopeLabel` is the
      // cloud-composed "Workspace: X · Project: Y" line carried verbatim; we do
      // NOT parse it, and we do NOT synthesize a task title (the wire has none —
      // only `prompt`, which is user content and must not land in a menu bar).
      agentName: payload.agentImUserId ? this.hostedAgents.get(payload.agentImUserId)?.name : undefined,
      kind: isShellDispatch(payload) ? 'shell' : payload.kind === 'task' ? 'task' : 'run',
      scopeLabel: payload.identityContext?.scope || undefined,
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
          this.trackDispatch401(message, code);
        }
      } else {
        const reply = await handleDispatch(payload, requestId, {
          registry: this.registry,
          cloud: this.cloud,
          uriResolver: this.uriResolver,
          assetCache: this.assetCache,
          ws: this.ws,
          artifactsWatcher: this.artifactsWatcher,
          uploadInlinePkfArchive: (input) => this.archiveInlinePkfBlocks(input),
          paths: this.paths,
          daemonId: this.config.daemon_id,
          signal: ctrl.signal,
          ensureService: (profile, adapter) => this.servicePool.ensureService(profile, adapter),
          dropService: (id) => this.servicePool.drop(id),
          invalidateService: (id, disposer) => this.servicePool.invalidate(id, disposer),
          consumeSkillDirty: (id) => this.skillDirtyProfiles.delete(id),
          // S5 §3.4-4b (specs/05 Task 6) — the skill-sync gateway kill is
          // busy-gated: a turn in flight means defer + re-arm the dirty flag
          // instead of vacating every session on the profile.
          markSkillDirty: (id) => this.skillDirtyProfiles.add(id),
          peekServiceBusy: (id) => {
            const svc = this.servicePool.peek(id);
            return svc instanceof HermesService && svc.busy;
          },
          resolveLocalProfile: ({ profileId, agentImUserId }) => {
            const profiles = this.loadAllProfiles();
            if (profileId) return profiles.find((p) => p.id === profileId) ?? null;
            if (!agentImUserId) return null;
            return profiles.find((p) => p.agentImUserId === agentImUserId) ?? null;
          },
          assetMetadataIndexes: this.assetMetadataIndexes,
          resolvePkfRuntimeCapability: (profile) => this.resolvePkfRuntimeCapability(profile),
          ...(this.preReplyDurabilityBarrier
            ? { preReplyDurabilityBarrier: (input) => this.preReplyDurabilityBarrier!.run(input) }
            : {}),
          onProgress: () => {
            const running = this.runningTasks.get(payload.taskId);
            if (running) running.lastProgressAt = Date.now();
          },
        });
        if (!reply.ok) {
          const code = reply.error?.code ?? 'unknown';
          const message = reply.error?.message ?? 'unknown error';
          process.stderr.write(`[daemon] dispatch failed task=${payload.taskId} code=${code} message=${message}\n`);
          this.trackDispatch401(message, code);
        } else {
          this.consecutiveDispatch401 = 0;
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
   * product209/18 Part B — cloud 推来的附件物化请求：上传完成后把字节提前拉进
   * 本地 asset-cache，物化成功/失败都回 ack。前端上传进度以 ack 为 100% 依据
   * （字节到 cloud 存储 ≠ 完成）。
   *
   * 幂等：getOrFetch 内容寻址，重复请求命中缓存零成本。失败不重试——ack 携带
   * error，cloud 侧对 ok=false 不落任何状态（行保持 pending，前端轮询超时
   * 降级完成；上传本身已成功，绝不回滚）。
   */
  private async onAssetMaterializeRequest(
    payload: AssetMaterializeRequestPayload,
    requestId?: string,
  ): Promise<void> {
    const { assetId, contentHash, workspaceId } = payload;
    try {
      const cached = await this.assetCache.getOrFetch(contentHash, {
        workspaceIdHint: workspaceId,
        assetId,
        signal: AbortSignal.timeout(30_000),
      });
      this.ws.send(
        envelope('asset.materialize.reply', {
          assetId,
          contentHash,
          daemonId: this.config.daemon_id,
          ok: true,
        }, requestId),
      );
      // memory211/01 W3 轴D — the daemon owns the T3 ingestion for the files it
      // can read locally: md/txt/pkf chunk directly, pdf goes through the
      // bundled liteparse `lit`. Results land in the LOCAL chunk mirror first
      // (offline recall keeps working) and then ride the existing memory outbox
      // to the cloud authoritative `im_asset_chunks`. Fire-and-forget AFTER the
      // ack: a slow parse (OCR fallback) must never delay the upload receipt.
      const cachedBytes = await readFile(cached.localPath);
      void this.ingestAssetChunks({ workspaceId, assetId, contentHash, bytes: cachedBytes });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
      process.stderr.write(
        `[daemon] asset.materialize failed asset=${assetId} hash=${contentHash}: ${message}\n`,
      );
      try {
        this.ws.send(
          envelope('asset.materialize.reply', {
            assetId,
            contentHash,
            daemonId: this.config.daemon_id,
            ok: false,
            error: message,
          }, requestId),
        );
      } catch (sendErr) {
        // 断线窄窗口：失败回执也发不出去时不产生 unhandled rejection。
        process.stderr.write(
          `[daemon] asset.materialize error-ack send failed asset=${assetId}: ${(sendErr as Error).message}\n`,
        );
      }
    }
  }

  /**
   * memory211/01 W3 review B1 — attached-asset sizes for the extraction lanes.
   * Best-effort: an offline / un-indexed workspace yields {} and the deliverable
   * gate degrades to G9-only for that turn (never blocks extraction).
   */
  private async resolveAssetSizesForExtraction(
    workspaceId: string,
    assetIds: string[],
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (assetIds.length === 0) return out;
    const index = this.assetMetadataIndexes.get(workspaceId);
    if (!index) return out;
    for (const assetId of assetIds) {
      const row = index.resolveByAssetId(assetId);
      if (typeof row?.sizeBytes === 'number' && row.sizeBytes > 0) out[assetId] = row.sizeBytes;
    }
    return out;
  }

  /**
   * memory211/01 W3 轴D — chunk an uploaded asset into the local T3 mirror and
   * upload the rows via the memory outbox. Best-effort + never throws: the
   * materialize ack has already been sent, and an ingestion failure is a recall
   * gap, not an upload failure. No-op when this daemon has no memory store for
   * the workspace (CLI-only device).
   */
  private async ingestAssetChunks(input: {
    workspaceId: string;
    assetId: string;
    contentHash: string;
    bytes: Buffer;
  }): Promise<void> {
    const { workspaceId, assetId, contentHash, bytes } = input;
    try {
      const slot = this.memoryWiring?.runtime.peek(workspaceId);
      if (!slot) return;
      const index = await this.syncAssetMetadata(workspaceId, { force: false }).then(
        () => this.assetMetadataIndexes.get(workspaceId) ?? null,
      ).catch(() => null);
      const entry = index?.resolveByAssetId(assetId) ?? null;
      const filename = entry?.filename ?? null;
      await ingestAssetFile({
        store: slot.store,
        outbox: slot.outbox,
        assetId,
        contentHash,
        filename,
        bytes,
      });
      try {
        await this.memoryWiring?.worker?.flushNow?.();
      } catch {
        /* outbox flush retries on its own schedule */
      }
    } catch (err) {
      process.stderr.write(
        `[daemon] asset chunk ingest failed asset=${assetId}: ${(err as Error).message}
`,
      );
    }
  }

  /**
   * release203/08 WS-E — handle an out-of-band code-agent session control
   * frame (set_model / list_commands / rewind). Resolves the live
   * AdapterService for the target agent the SAME way the dispatch/cancel
   * paths reach a service (hosted agent's profiles → servicePool.peek), then
   * calls the optional contract member. Replies over WS with the request's
   * `_rpcId` so cloud's WsRpcService can settle the pending promise.
   *
   * Driver-only by nature: CodeAgentDriver implements setModel/listCommands/
   * revert. Non-driver adapters (hermes/openclaw) leave these optional members
   * undefined → we reply ok:false code='unsupported' (no-op), never throw.
   */
  private async onAgentSessionControl(
    kind: AgentSessionControlKind,
    rawPayload: unknown,
  ): Promise<void> {
    const payload = rawPayload as
      (AgentSessionSetModelPayload | AgentSessionListCommandsPayload | AgentSessionRewindPayload);
    const reply = await handleAgentSessionControl(kind, payload, (agentImUserId, controlKind) => {
      // Reach the live AdapterService for this agent the SAME way the cancel/
      // dispatch paths do: iterate the hosted agent's profiles → servicePool.
      // Prefer one that implements the requested optional control member; fall
      // back to any live service so the helper can return a precise
      // 'unsupported' (vs 'no_live_session').
      const hosted = this.hostedAgents.get(agentImUserId);
      if (!hosted) return undefined;
      let fallback: AdapterService | undefined;
      for (const [profileId] of hosted.profiles) {
        const svc = this.servicePool.peek(profileId);
        if (!svc) continue;
        if (controlKind === 'set_model' && typeof svc.setModel === 'function') return svc;
        if (controlKind === 'list_commands' && typeof svc.listCommands === 'function') return svc;
        if (controlKind === 'rewind' && typeof svc.revert === 'function') return svc;
        fallback ??= svc;
      }
      return fallback;
    });
    // Echo the reply (with `_rpcId`) back so cloud's WsRpcService.handleReply
    // correlates it. Mirrors webhook.dispatch.reply.
    this.ws.send(envelope('agent.session.reply', reply));
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
    // desktop205 R2 — same ownership gate as onTaskDispatch, on the OTHER
    // dispatch entrance (external channel / webhook). `null` is this path's
    // established "we can't run this here" answer.
    const quarantined = this.quarantineBlocking(undefined, agentImUserId);
    if (quarantined) {
      process.stderr.write(
        `[daemon] message dispatch refused agent=${agentImUserId} — profile ${quarantined.profileId} is quarantined (not owned by this account)\n`,
      );
      return null;
    }
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
          // desktop205/04 §4 (W13) — Tray descriptors. No scopeLabel here: the
          // external-channel path has no cloud-composed identityContext.
          agentName: this.hostedAgents.get(agentImUserId)?.name,
          kind: 'external',
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
              ...(input.workdir ? { workdir: input.workdir } : {}),
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
              uploadInlinePkfArchive: (input) => this.archiveInlinePkfBlocks(input),
              paths: this.paths,
              daemonId: this.config.daemon_id,
              signal: externalCtrl.signal,
              ensureService: (profile, adapter) => this.servicePool.ensureService(profile, adapter),
              dropService: (id) => this.servicePool.drop(id),
              invalidateService: (id, disposer) => this.servicePool.invalidate(id, disposer),
              consumeSkillDirty: (id) => this.skillDirtyProfiles.delete(id),
              // S5 §3.4-4b (specs/05 Task 6) — the skill-sync gateway kill is
              // busy-gated: a turn in flight means defer + re-arm the dirty flag
              // instead of vacating every session on the profile.
              markSkillDirty: (id) => this.skillDirtyProfiles.add(id),
              peekServiceBusy: (id) => {
                const svc = this.servicePool.peek(id);
                return svc instanceof HermesService && svc.busy;
              },
              resolveLocalProfile: ({ profileId, agentImUserId }) => {
                const profiles = this.loadAllProfiles();
                if (profileId) return profiles.find((p) => p.id === profileId) ?? null;
                if (!agentImUserId) return null;
                return profiles.find((p) => p.agentImUserId === agentImUserId) ?? null;
              },
              assetMetadataIndexes: this.assetMetadataIndexes,
              resolvePkfRuntimeCapability: (profile) => this.resolvePkfRuntimeCapability(profile),
              onProgress: () => {
                const running = this.runningTasks.get(input.taskId);
                if (running) running.lastProgressAt = Date.now();
              },
            },
          );
          // product210/03 W1-3 — carry the task-line-validated inline-PKF
          // contentBlocks (sentinel OR pkf_reply_inline marker origin) across
          // the bridge as metadata so message-dispatch can attach them to the
          // chat reply. handleDispatch already stripped the sentinel bytes
          // from output, so without this carrier the chat line loses BOTH
          // inline carriers (they only exist on the dispatch reply object —
          // the scratch path cannot be re-derived here).
          const bridgeMetadata: Record<string, unknown> = {};
          if (reply.assetIds?.length) bridgeMetadata.assetIds = reply.assetIds;
          if (reply.contentBlocks?.length) bridgeMetadata.inlineContentBlocks = reply.contentBlocks;
          return {
            ok: reply.ok,
            output: reply.output,
            error: reply.error,
            metrics: reply.metrics,
            metadata: Object.keys(bridgeMetadata).length > 0 ? bridgeMetadata : undefined,
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
          ...(payload.contentBlocks
            ? { messageContent: { contentBlocks: payload.contentBlocks } }
            : {}),
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
    const displayName = payload.fields.displayName;
    if (typeof displayName === 'string') a.name = displayName;
    if (Array.isArray(payload.fields.capabilities)) a.capabilities = payload.fields.capabilities;
    // B2 (SDK boundary wave2): offline-window rename convergence. A rename via
    // PATCH /agents/:id does NOT bump the profile version, so host.acked /
    // syncProfileFromCloud (the only other `agents.name` writer) never fires —
    // without this the new name lived in RAM only and a restart between the
    // rename and the next re-sync left declare/healthz/task-agentName on the
    // stale name. `agent.changed` is the only path that sees the rename, so it
    // is the single persistence point; username is NOT persisted (the local
    // `agents` table has no username column).
    if (typeof displayName === 'string') {
      this.db
        .prepare('UPDATE agents SET name = ?, dirty = 0 WHERE im_user_id = ?')
        .run(displayName, payload.agentImUserId);
    }
  }

  private async onAgentProfileChanged(payload: AgentProfileChangedPayload): Promise<void> {
    try {
      await this.servicePool.drop(payload.profileId);
      await this.syncProfileFromCloud(payload.profileId);
      // F16 (2026-05-20) — after pulling the new profile config, also refresh
      // the agent's skill files. Pre-F16 the skill set could only update at
      // the next task dispatch, so any cloud-side skill change was invisible
      // until somebody used the agent.
      let capabilityProfile: AgentProfile | undefined;
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
          capabilityProfile = profile;
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
          // S-B5 — this broadcast runs OUTSIDE the serial dispatch queue, so we
          // can't safely kill the gateway here (would murder an in-flight run).
          // Flag the profile; the next dispatch (serial, safe) consumes it and
          // re-spawns so the new/deleted skill is visible. Without this, the
          // gateway spawned by the prewarm above (before these files landed)
          // keeps serving a stale skill catalog.
          if (result.synced > 0 || (result.pruned ?? 0) > 0) {
            this.skillDirtyProfiles.add(profile.id);
          }
          // Note: the gateway prewarm is NOT triggered here — it runs inside
          // `syncProfileFromCloud` (called above), the single choke point that
          // also covers the `host.acked` catch-up path. Re-warming here would
          // double-spawn for the live-broadcast case.
        } catch (err) {
          process.stderr.write(
            `[daemon] skill sync (profile-changed) failed profile=${payload.profileId}: ${(err as Error).message}\n`,
          );
        }
      }
      if (capabilityProfile) {
        this.refreshPkfRuntimeCapability(capabilityProfile, 'profile-changed');
      }
      if (this.wsConnected) this.sendDeclare();
    } catch (err) {
      this.emit('sync-error', err);
    }
  }

  /**
   * Cold-start fix — eagerly warm a long-running adapter's service so the
   * gateway spawn + skill-catalog scan happens at agent-creation / profile-
   * change time, not lazily inside the first dispatch's `ensureService`.
   *
   * Non-blocking and best-effort by contract:
   *  - only long-running adapters have a service to warm (interactive adapters
   *    dispatch directly with no persistent gateway);
   *  - it goes through the same `servicePool.ensureService` the dispatch path
   *    uses, so a successful warm is transparently reused by the first dispatch
   *    (the pool dedupes per profile.id);
   *  - any failure is swallowed — the next dispatch falls back to the existing
   *    lazy warm, so the worst case is the pre-fix cold-start latency, never a
   *    broken dispatch.
   */
  private prewarmProfileService(profile: AgentProfile, adapter: AdapterDef): void {
    if (adapter.kind !== 'long-running' || !adapter.ensureService) {
      return;
    }
    void (async () => {
      const startedAt = Date.now();
      try {
        await this.servicePool.ensureService(profile, adapter);
        process.stdout.write(
          `[daemon] prewarm ok profile=${profile.id} adapter=${profile.adapterName} took=${Date.now() - startedAt}ms\n`,
        );
      } catch (err) {
        // Degrade gracefully to the lazy path — log, never propagate.
        process.stderr.write(
          `[daemon] prewarm skipped profile=${profile.id} adapter=${profile.adapterName}: ${(err as Error).message}\n`,
        );
      }
    })();
  }

  /**
   * desktop205 O15 / R2 — WHAT did the 404 actually mean?
   *
   * Three outcomes, because the caller must do three different things and a
   * boolean was collapsing two of them:
   *
   *   'gone'      our API, our envelope, `error.code === 'not_found'`
   *               ⇒ positive knowledge: the row is deleted. Delete locally.
   *   'not_owned' our API, our envelope, `error.code === 'forbidden'`
   *               ⇒ positive knowledge: the row EXISTS but the workspace
   *                 changed hands. Keep the rows, quarantine them.
   *   'unknown'   everything else — HTML from a proxy / captive portal, a
   *               non-JSON body, `{}`, a legacy code-less envelope, a
   *               different status, an unreachable host.
   *               ⇒ we know NOTHING. Change nothing.
   *
   * The distinction that matters is `not_owned` vs `unknown`: both keep the
   * rows, but only the first is a FACT about the profile. Quarantining on
   * `unknown` would take a healthy agent offline every time a reverse proxy
   * hiccups — which is why "keep, but do nothing else" stays the default.
   *
   * Re-reads the profile route with `fetchRaw` (which keeps the raw body that
   * `CloudClient.request` throws away behind a synthesized error code) — the
   * discriminating byte (`error.code`) only exists in the raw body. Costs one
   * extra request on the rare 404 path only.
   *
   * desktop205 O15 残留 — 「不是你的」不是「它没了」。The cloud route scopes its
   * lookup by `workspace.ownerImUserId`, so a workspace transfer / account
   * switch also answers 404 from OUR OWN envelope — the envelope check alone
   * cannot see the difference, and a permission change would keep executing as
   * a local delete. Cloud now discriminates in `error.code`
   * (`forbidden` = row exists, not yours · `not_found` = really gone;
   * src/im/api/agent-profiles.ts GET /:id), so the warrant here is POSITIVE:
   * only `not_found` deletes, and only `forbidden` quarantines.
   *
   * Version-skew note (deliberate): a cloud old enough to still answer the
   * legacy string body (`{ok:false, error:'Profile not found'}`) carries no
   * code ⇒ 'unknown' ⇒ rows are KEPT and NOT quarantined. That degradation is
   * bounded and recoverable (a dead profile lingers until the cloud upgrades,
   * and the ownership-blind `host.acked` tombstone path —
   * computeProfilesToDelete, which has no owner filter — still purges
   * genuinely deleted profiles). The opposite default is not recoverable:
   * deleting a live agent's rows, or silencing a live agent on proxy noise.
   */
  private async classifyProfile404(profileId: string): Promise<'gone' | 'not_owned' | 'unknown'> {
    try {
      const res = await this.cloud.fetchRaw(`/api/im/agent_profiles/${encodeURIComponent(profileId)}`, {
        headers: { Accept: 'application/json' },
        timeoutMs: 15_000,
      });
      if (res.status !== 404) return 'unknown';
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return 'unknown'; // HTML / plain-text 404 ⇒ not our API answering.
      }
      if (!body || typeof body !== 'object') return 'unknown';
      const envelope = body as { ok?: unknown; error?: unknown };
      if (envelope.ok !== false) return 'unknown';
      const err = envelope.error;
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      if (code === 'not_found') return 'gone';
      if (code === 'forbidden') return 'not_owned';
      return 'unknown';
    } catch {
      // Network failure / abort while classifying ⇒ we learned nothing.
      return 'unknown';
    }
  }

  /**
   * desktop205 R2 — stamp the durable quarantine bit and refresh the in-memory
   * projection. Idempotent: `AND quarantined_at IS NULL` keeps `since` pinned
   * to the FIRST time we learned it, so a repeated sync doesn't reset the age
   * a surface renders.
   *
   * Deliberately NOT a delete: ownership can come back, and a re-grant must
   * restore a working agent, not an empty one.
   */
  private quarantineProfile(profileId: string): void {
    const res = this.db
      .prepare('UPDATE agent_profiles SET quarantined_at = ? WHERE id = ? AND quarantined_at IS NULL')
      .run(Date.now(), profileId);
    if (res.changes > 0) {
      process.stderr.write(
        `[daemon] profile ${profileId} quarantined — cloud says it exists but is NOT owned by this account (workspace transfer / account switch); keeping local rows, refusing dispatch\n`,
      );
    }
    this.loadAgentsFromDb();
  }

  /**
   * desktop205 R2 — the dispatch gate. Returns the quarantine record that
   * forbids this dispatch, or undefined when it may proceed.
   *
   * Ownership is a fact about the WORKSPACE, not about one profile row: when a
   * workspace changes hands every profile under it stops being ours, and only
   * the ones we happened to re-sync carry the stamp. So an agent with ANY
   * quarantined profile is refused wholesale — including the `profileId: ''`
   * dispatches where the daemon would otherwise let `resolveProfile` pick "the
   * most recent profile" (which may well be the quarantined one).
   */
  private quarantineBlocking(
    profileId: string | undefined,
    agentImUserId: string | undefined,
  ): QuarantinedProfile | undefined {
    if (this.quarantinedProfiles.size === 0) return undefined;
    if (profileId) {
      const hit = this.quarantinedProfiles.get(profileId);
      if (hit) return hit;
    }
    if (!agentImUserId) return undefined;
    for (const q of this.quarantinedProfiles.values()) {
      if (q.agentImUserId === agentImUserId) return q;
    }
    return undefined;
  }

  private async syncProfileFromCloud(
    profileId: string,
    pkfCapabilityTrigger?: PkfRuntimeCapabilityTrigger,
  ): Promise<void> {
    let profile: AgentProfile;
    try {
      profile = await this.cloud.get<AgentProfile>(`/api/im/agent_profiles/${encodeURIComponent(profileId)}`);
    } catch (err) {
      if (err instanceof CloudError && err.status === 404) {
        // desktop205 O15 — a bare `status === 404` is too weak a warrant for a
        // DESTRUCTIVE local delete. Any intermediary can produce a 404 that has
        // nothing to do with the profile: a captive portal, a reverse proxy that
        // mis-routes, a rolling deploy where the route is briefly absent. And
        // `CloudError.code` cannot discriminate them — `CloudClient.request`
        // SYNTHESIZES `code:'not_found'` from the status whenever the body is
        // not our `{error:{code}}` object, which is exactly the case for an
        // nginx/Next.js HTML 404 (code-verified in src/auth.ts::request).
        //
        // So we require a POSITIVE confirmation from our own API before
        // deleting: re-read the same route raw and demand a 404 whose body is
        // OUR error envelope AND says `error.code === 'not_found'`
        // (src/im/api/agent-profiles.ts GET /:id).
        //
        // desktop205 R2 — that check now yields THREE verdicts, because
        // `forbidden` is knowledge, not noise:
        //   'not_owned' the row exists but the workspace changed hands.
        //               Keep the rows (ownership can come back and local state
        //               is not reconstructible) but QUARANTINE them: the
        //               dispatch gate stops sending work we know will be
        //               rejected, and /healthz makes the state visible instead
        //               of leaving the user with an agent that never answers.
        //   'unknown'   an HTML body, a non-JSON body, a `{}`, a legacy
        //               code-less envelope, a different status, a network
        //               failure. We learned nothing ⇒ change nothing (no
        //               delete, no quarantine). Worst case we keep a dead
        //               profile until the next sync, which is recoverable;
        //               deleting a live profile off a proxy's 404 — or
        //               silencing a live agent because a captive portal
        //               answered — is not.
        //   'gone'      falls through to the delete below.
        const verdict = await this.classifyProfile404(profileId);
        if (verdict === 'not_owned') {
          this.quarantineProfile(profileId);
          return;
        }
        if (verdict === 'unknown') {
          process.stderr.write(
            `[daemon] profile ${profileId} got a 404 we cannot interpret (not our envelope, or no discriminating error.code) — keeping local rows, no quarantine\n`,
          );
          return;
        }
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
          // desktop205 R2 — `quarantined_at` is listed explicitly as NULL so the
          // RECOVERY path is legible rather than incidental: a 200 from the
          // profile route is the cloud saying "this is yours again", which must
          // lift the quarantine and let dispatch resume. (INSERT OR REPLACE
          // would blank an unlisted column anyway; that is exactly the kind of
          // silent dependency this line exists to remove.)
          `INSERT OR REPLACE INTO agent_profiles
           (id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at, dirty, deleted_at, quarantined_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
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
    // Cold-start fix — warm the long-running adapter's service (the hermes
    // gateway: spawn + full skill-catalog scan, ~11-12s) NOW. This is the
    // single canonical choke point for every profile arrival: the live
    // `agent_profile.changed` broadcast (onAgentProfileChanged) AND the
    // `host.acked` catch-up sync that runs when a freshly-provisioned daemon
    // first connects (onHostAcked) — which is the dominant agent-creation
    // timing, since the agent-rt pod boots after the profile row is created.
    // The creation wizard's progress UI absorbs the warm, so the kickoff
    // message hits an already-warm gateway. Fire-and-forget + best-effort:
    // a failure degrades gracefully to the existing lazy ensureService at
    // first dispatch (the servicePool dedupes a successful warm).
    //
    // release203/10 §skill-dispatch-fix — warm with the per-agent device
    // skillsDir injected (same as the dispatch path does before ITS
    // ensureService). Without this the gateway spawns reading the profile dir
    // while skill-sync writes the device dir, so installed skills stay invisible
    // to the live hermes session. Routing prewarm through the same injection
    // makes the spawn dir match the sync dir.
    if (adapter) {
      const warmProfile = withPerAgentSkillsDir(profile, this.paths, this.config?.daemon_id);
      // release203/10 §skill-dispatch-fix finding#3 (cold-start root-cause) —
      // the hermes gateway's HermesSkillLoader fixes its skillsRoot at spawn
      // time from `profile.config.skillsDir`. If an earlier, un-injected start
      // already spawned the gateway reading the profile dir, ServicePool caches
      // it and every later prewarm (even with warmProfile) reuses that stale
      // service, so a just-installed skill stays invisible until the first
      // synced>0 dispatch drops+re-spawns it (finding#3's first-invoke miss).
      // Close the window HERE: when we actually injected a device skillsDir,
      // (1) sync the installed skills to that dir FIRST so the loader's initial
      // scan reads the complete set, then (2) drop any stale cached service so
      // prewarm re-spawns with warmProfile (device-dir loader). Only fires when
      // injection happened (daemon mode + hermes), so no churn otherwise.
      if (warmProfile !== profile && warmProfile.agentImUserId) {
        try {
          await syncInstalledSkillsForDispatch(
            warmProfile,
            warmProfile.agentImUserId,
            this.cloud,
            undefined,
            { paths: this.paths, daemonId: this.config?.daemon_id },
          );
        } catch (err) {
          process.stderr.write(
            `[daemon] pre-prewarm skill sync failed profile=${profile.id}: ${(err as Error).message}\n`,
          );
        }
        await this.servicePool.drop(profile.id);
      }
      this.prewarmProfileService(warmProfile, adapter);
    }
    // Fresh daemons often have zero local profiles when the initial background
    // startup audit runs. host.acked is the profile-arrival path, so its two
    // callers pass `startup` here and receive the same structured audit after
    // skills have actually landed. agent_profile.changed performs its explicit
    // post-sync audit in onAgentProfileChanged instead.
    if (pkfCapabilityTrigger) {
      this.refreshPkfRuntimeCapability(profile, pkfCapabilityTrigger);
    }
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

  /**
   * desktop202/17 Phase 9 — resolve a workspace's display name for the mirror
   * dir segment. Reads the local `workspaces` mirror (store.ts v1); returns
   * undefined when unknown so MirrorManager falls back to the workspaceId. Best
   * effort — a failed read just degrades the dir name, never throws.
   */
  private resolveWorkspaceName(workspaceId: string): string | undefined {
    try {
      const row = this.db
        .prepare('SELECT name FROM workspaces WHERE id = ?')
        .get(workspaceId) as { name?: string } | undefined;
      return typeof row?.name === 'string' && row.name.length > 0 ? row.name : undefined;
    } catch {
      return undefined;
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
    // desktop202/17 Phase 9 §4 — multi-device convergence. Only when the mirror
    // capability is on AND the asset is already materialized: drive an event-
    // driven refresh (订阅式拉取, NOT a watcher).未材化 → no-op (metadata-only,
    // handled by syncAssetState above). pinned + clean → atomic replace; localEdit
    // → conflict (§5). Idempotent by (assetId, revision).
    if (this.mirrorManager && payload.assetId) {
      const entry = this.mirrorManager.getEntry(payload.assetId);
      if (entry) {
        try {
          const result = await this.mirrorManager.refreshFromCloud(
            {
              assetId: payload.assetId,
              contentHash: payload.contentHash ?? entry.contentHash,
              filename: null, // path stays put; refresh replaces bytes in place
              folderPath: null,
              ...(typeof payload.revision === 'number' ? { revision: payload.revision } : {}),
            },
            {
              workspaceId: payload.workspaceId,
              ...(payload.operation ? { operation: payload.operation } : {}),
            },
          );
          if (result === 'conflict' || result === 'refreshed' || result === 'deleted') {
            process.stdout.write(
              `[daemon] mirror ${result} asset=${payload.assetId} rev=${payload.revision ?? '?'}\n`,
            );
          }
        } catch (err) {
          log.error(`mirror refresh failed asset=${payload.assetId}: ${(err as Error).message}`);
        }
      }
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
    this.pkfArchiveUpload = new DaemonAssetUploadClient({
      cloudApiBase: this.config.cloud_api_base,
      apiKey: this.config.api_key,
    });
    // desktop205/04 §4 (W13) — prime the Tray backlog counter immediately. A
    // backlog inherited from a PREVIOUS run (the 2026-07-26 cleanup found 4
    // dead-letter rows nobody knew about) must be visible before the first tick
    // completes, not only after something new gets enqueued.
    this.refreshAssetOutboxCounts();
    this.dropFolderAdapter = new DropFolderAdapter({ workspaceDir: workspaceRoot });
    this.dropFolderUploadRunner = new UploadRunner({
      outbox: this.assetOriginOutbox,
      cloud: new DaemonAssetUploadClient({ cloudApiBase: this.config.cloud_api_base, apiKey: this.config.api_key }),
      // desktop205 O14 — the SAME runner drains task artifacts. Before this,
      // `artifacts-watcher` uploaded them with a bare uploadAsset() and an
      // unreachable cloud simply threw at the caller: no queue, no retransmit
      // on reconnect (03-acceptance §3.3's artifact contract held for
      // drop-folder only). The adapter is stateless, so one instance suffices.
      adapters: {
        'drop-folder': this.dropFolderAdapter as OriginAdapter,
        'agent-gen': new AgentGenAdapter(),
      },
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
    // W13: the outbox is gone ⇒ we have NO reading, which is not the same fact
    // as "0 pending". Clear it so /healthz drops the field rather than freezing
    // the last sample forever.
    this.assetOutboxCounts = undefined;
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
      // desktop205/04 §4 (W13) — sample the backlog HERE, on the producer's own
      // 1s tick against a db it already has open, so /healthz stays zero-I/O.
      // In `finally` so a failed scan/drain still refreshes the number the user
      // sees (a stuck uploader is exactly when the backlog matters most).
      this.refreshAssetOutboxCounts();
    }
  }

  /**
   * desktop205/04 §4 (W13) — take one sample of the origin-outbox backlog into
   * `assetOutboxCounts` (which /healthz then reads from memory).
   *
   * Never throws: an unreadable/closed db must not take down the drop-folder
   * tick. On failure the last good sample is kept rather than being zeroed —
   * reporting 0 because we failed to count would be a lie in the one direction
   * that matters (it hides a backlog).
   */
  /**
   * product210/03 W1-3 (R12) — terminal silent archive of validated inline PKF
   * deliverable bytes as agent-output assets. Uploads from the ALREADY-VALIDATED
   * source (never re-extracts); the cloud dedupes by contentHash. Ids returned
   * here ride `reply.pkfArchiveAssetIds` (never `assetIds`) so chat does not
   * double-display them, while the deliverable ledger and G9 derived-from
   * pointers gain a stable artifact target.
   */
  private async archiveInlinePkfBlocks(input: {
    workspaceId: string;
    taskId: string;
    blocks: Array<{ title?: string | null; source: string }>;
  }): Promise<string[]> {
    this.pkfArchiveUpload ??= new DaemonAssetUploadClient({
      cloudApiBase: this.config.cloud_api_base,
      apiKey: this.config.api_key,
    });
    const ids: string[] = [];
    for (const [i, block] of input.blocks.entries()) {
      const bytes = Buffer.from(block.source, 'utf8');
      try {
        const res = await this.pkfArchiveUpload.uploadAsset({
          workspaceId: input.workspaceId,
          filename: `${input.taskId}-pkf-${i + 1}.pkf`,
          bytes,
          mime: 'application/vnd.prismer.pkf+html',
          size: bytes.length,
          kind: 'agent-output',
          metadata: { pkfArchive: true, sourceKind: 'deliverable', sourceTaskId: input.taskId },
          sourceTaskId: input.taskId,
          ...(block.title ? { description: block.title } : {}),
        });
        ids.push(res.assetId);
      } catch (err) {
        // A single failed archive must not fail the reply — the deliverable
        // itself already rode the wire as contentBlocks. Log loudly; the ledger
        // gap check (ruling A) surfaces the missing archive downstream.
        process.stderr.write(
          `[daemon] pkf archive upload failed task=${input.taskId} block=${i + 1}: ${(err as Error).message}\n`,
        );
      }
    }
    return ids;
  }

  private refreshAssetOutboxCounts(): void {
    const outbox = this.assetOriginOutbox;
    if (!outbox) return;
    try {
      this.assetOutboxCounts = snapshotOriginOutboxCounts(outbox);
    } catch (err) {
      process.stderr.write(`[daemon] asset outbox count sample failed: ${(err as Error).message}\n`);
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
    // Phase 8a / M2 (13 §7) — local IM gateway optimistic writes flow through
    // the OutboxWriter (POST cloud + ack remap + dirty clear). Only present when
    // the gateway is enabled; other resource types keep the path below.
    if (this.gatewayOutbox && (row.resource_type === 'im_message' || row.resource_type === 'task_mutation')) {
      return this.gatewayOutbox.flushRow(row);
    }
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

/**
 * product206/13 §4-R5 — periodic `agent.host.declare` cadence, and the unit the
 * DeclareGuard's whole backoff ladder is expressed in.
 *
 * 30s is the production value and the reason it exists (cloud sweepTimedOut is
 * 90s). `PRISMER_DECLARE_INTERVAL_MS` is an ops / integration-test knob: j48
 * compresses it so a ladder whose real steps are minutes can be observed in a
 * wall-clock-sane window. Defaults unchanged for every real daemon.
 */
function resolveDeclareTickMs(): number {
  return clampInt(process.env.PRISMER_DECLARE_INTERVAL_MS, 1_000, 300_000, 30_000);
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

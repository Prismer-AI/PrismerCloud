// @prismer/runtime — daemon runtime for Prismer Cloud agents.
//
// TypeScript-only adapter host. See docs/refactor/04-daemon-runtime.md
// and 05-adapter-contract.md for design.

// Adapter contract
export type {
  AdapterDef,
  AdapterKind,
  AdapterService,
  AgentProfile,
  HealthStatus,
  TaskInput,
  TaskResult,
  ValidationResult,
} from './adapters/contract.js';

export { AdapterRegistry } from './adapters/registry.js';

// Built-in adapters (m2: hermes only; claude-code lands m3)
export { hermesAdapter, type HermesProfileConfig } from './adapters/persistence/hermes/index.js';

// spec 11 / Task 4 — daemon-side transport for the `prismer` Hermes gateway
// platform plugin (local-only TCP JSON-lines bridge).
export {
  BridgeClient,
  buildInboundFrame,
  parseOutboundFrame,
  probeBridge,
  BRIDGE_DEFAULT_HOST,
  BRIDGE_DEFAULT_PORT,
  BRIDGE_DEFAULT_CONNECT_TIMEOUT_MS,
  BRIDGE_DEFAULT_RECONNECT_DELAY_MS,
  BRIDGE_MAX_LINE_CHARS,
  type BridgeClientOptions,
  type BridgeConnectionState,
  type BridgeFrameParse,
  type BridgeInboundFrame,
  type BridgeInboundInput,
  type BridgeOutboundFrame,
  type BridgeProbeOptions,
  type BridgeProbeResult,
  type BridgeSendResult,
} from './adapters/persistence/hermes/bridge-client.js';

// Desktop-202 Phase 7 — daemon-local LLM provider direct-connect (BYOK / Ollama).
// docs/desktop202/12. The daemon boot calls setLocalProviders(config.providers);
// electron main calls setKeyRefResolver(keychainBridge) in the second wave.
export {
  PROVIDER_PROFILE_TYPES,
  ProviderProfileSchema,
  effectiveBaseUrl,
  providerTypeRequiresKey,
  resolveKeyRef,
  setKeyRefResolver,
  keyRefEnvVar,
  setLocalProviders,
  getLocalProviders,
  resolveLocalProvider,
  LOCAL_PROVIDER_PREFIX,
  isLocalProviderSelector,
  localProviderProfileId,
  probeOllama,
  type ProviderProfile,
  type ProviderProfileType,
  type KeyRefResolver,
  type ResolvedLocalProvider,
  type OllamaProbeResult,
} from './adapters/shared/local-provider.js';

// Cloud WS transport
export { WS_CLOSE, WsClient, type WsClientOptions } from './daemon/ws-client.js';

// Local SQLite mirror + sync queue
export {
  TARGET_SCHEMA_VERSION,
  currentSchemaVersion,
  openLocalDb,
  runMigrations,
  type LocalDb,
} from './sync/store.js';
export {
  SyncQueue,
  nextBackoffMs,
  type SyncOperation,
  type SyncQueueRow,
  type SyncResourceType,
  type SyncStatus,
} from './sync/sync-queue.js';
export {
  SyncWorker,
  type FlushFn,
  type FlushResult,
  type SyncWorkerOptions,
} from './sync/sync-worker.js';

// Built-in role templates (m3 CLI consumes via `prismer profile create --from-template`)
export {
  BUILTIN_ROLE_TEMPLATES,
  getRoleTemplate,
  listRoleTemplates,
  type RoleTemplate,
} from './templates/index.js';

// m3 — config, auth, runner, dispatch, asset cache, URI resolver, pair, CLI
export {
  ConfigSchema,
  configExists,
  deriveWsUrl,
  loadConfig,
  resolvePaths,
  saveConfig,
  type Config,
  type ConfigPaths,
} from './config.js';
export { isDaemonId, newDaemonId } from './daemon-id.js';
export { CloudClient, CloudError, type CloudClientOptions, type CloudResponse } from './auth.js';
export { envelope, type Envelope } from './envelope.js';
export { AssetCache, type AssetCacheOptions, type CachedAsset } from './asset-cache.js';
// Wave-54: daemon-side asset coordination (mirror + parse claim).
export {
  WorkspaceMirror,
  type WorkspaceMirrorOptions,
  type WorkspaceFileBinding,
} from './daemon/asset/mirror.js';
export {
  ParseClaimController,
  type ParseClaimControllerOptions,
  type ParseClaim,
  type AcquireResult,
} from './daemon/asset/parse-claim.js';
// desktop202/17 Phase 9 — local asset mirror (named ~/Prismer dir + index +
// materialize / edit-roundtrip / conflict / multi-device refresh). Capability
// bit, default OFF (desktop daemon only).
export {
  MirrorManager,
  sanitizeSegment,
  type MirrorEntry,
  type MirrorAssetDescriptor,
  type MirrorManagerOptions,
  type MaterializeResult,
  type EditCheckResult,
  type WorkspaceNameResolver,
} from './daemon/asset/mirror-manager.js';
export { attachMirrorRpc, type AttachMirrorRpcOptions } from './daemon/asset/mirror-rpc.js';
export { UriResolver, parseUris, extractHttpUrls, type ParsedPrismerUri, type PrismerUriType, type UriResolverOptions, type UrlResolution } from './uri-resolver.js';
export { handleDispatch, composePrompt, type DispatchDeps } from './daemon/dispatch.js';
export {
  handleAgentMessageDispatch,
  type MessageDispatchAgent,
  type MessageDispatchDeps,
  type MessageDispatchHandle,
  type MessageDispatchTaskInput,
} from './daemon/message-dispatch.js';
export { ServicePool } from './daemon/service-pool.js';
export { LocalServer, type LocalServerOptions, type LocalServerState } from './daemon/local-server.js';
export {
  attachAdminObservabilityRpc,
  ADMIN_OBSERVABILITY_REQUEST_MAX_BYTES,
  ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES,
  type AttachAdminObservabilityRpcOptions,
} from './daemon/admin-observability/rpc.js';
export {
  takeAdminObservabilityCloud,
  type TakeAdminObservabilityCloudInput,
} from './daemon/admin-observability/credential.js';
// Phase 6 / M1 — local IM gateway (docs/desktop202/13). Capability bit, default OFF.
export {
  openReadModel,
  RM_SCHEMA_VERSION,
  type RmDomain,
  type RmSyncStatus,
} from './daemon/gateway/read-model.js';
export { LocalRelay, type LocalSyncEvent } from './daemon/gateway/local-relay.js';
export { Materializer, type MaterializerDeps, type RawWsEvent } from './daemon/gateway/materializer.js';
export {
  LocalGateway,
  resolveGatewayConfig,
  SWR_TTL_MS,
  type GatewayConfig,
  type GatewayDeps,
} from './daemon/gateway/gateway.js';
export { Runner, type RunnerOptions } from './daemon/runner.js';
export {
  gitRpc,
  GitRpcError,
  resolveGitCwd,
  runGitExecRequest,
  remoteAllowlistFromEnv,
  DEFAULT_REMOTE_ALLOWLIST,
  GIT_RPC_OPS,
  type GitRpcRequest,
  type GitRpcResult,
  type GitRpcOp,
  type GitRpcErrorCode,
  type GitExecPayload,
  type GitExecReply,
} from './daemon/git-rpc.js';
export { pair, type PairOptions, type PairResult } from './pair.js';
export { claudeCodeAdapter, type ClaudeCodeConfig } from './adapters/coding/claude-code/index.js';
export { codexAdapter, type CodexConfig, parseCodexOutput } from './adapters/coding/codex/index.js';
export {
  piCoreAdapter,
  createPiCoreAdapter,
  type PiCoreConfig,
} from './adapters/runtime-engine/pi-core/index.js';
export {
  PiAgentCoreClient,
  PiAgentCoreSession,
  PI_CORE_PROVIDER,
  DEFAULT_PI_GATEWAY_MODEL,
  DEFAULT_PI_GATEWAY_PROVIDER,
  type PiAgentCoreClientOptions,
} from './adapters/runtime-engine/pi-core/agent.js';
export { buildProgram, runCli } from './cli/index.js';

// Wire-protocol payload types (mirror of cloud + SDK)
export type {
  AgentDispatchReplyAttachment,
  AgentDispatchReplyContentBlockInput,
  AgentDispatchReplyPkfContentBlock,
  AgentDispatchReplyPkfContentBlockInput,
  AgentDispatchReplyPayload,
  AgentDispatchReplyStatus,
  AgentDispatchRequest,
  AgentDispatchResponse,
  NormalizedContent,
} from './wire/dispatch-types.js';

export type {
  AgentDispatchReplyContentBlockToolResultInput,
  AgentDispatchReplyPkfContentBlockInput as RuntimePkfContentBlockInput,
} from './types/content-block.js';

export type {
  AgentChangedPayload,
  AgentHostDeclarePayload,
  AgentProfileChangedPayload,
  AgentStatusChangedPayload,
  HostAckedPayload,
  HostedAgentDeclaration,
  IMAgentStatus,
  IMWSMessage,
  RejectedHostedAgent,
  AssetChangedPayload,
  AssetDispatchObservation,
  AssetDispatchStrategy,
  AssetRef,
  TaskCancelPayload,
  TaskDispatchContextEntry,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskDispatchRequestPayload,
  WorkspaceChangedPayload,
  WorkspaceFileChangedPayload,
} from './types/im-events.js';

// ConfigDelivery — runtime bootstrap bundle types (docs/product209/07 §3.3)
export type {
  RuntimeConfigBundle,
  HermesProviderConfig,
  HermesBundleConfig,
  BootstrapRequest,
  BootstrapResponse,
  ConfigApplyState,
} from './types/runtime-bootstrap.js';
export { BOOTSTRAP_BACKOFF_MS, nextBootstrapBackoffMs } from './types/runtime-bootstrap.js';

// ConfigDelivery — daemon bundle fetch + apply (docs/product209/07 §3.4)
export {
  fetchBootstrapBundle,
  applyBundle,
  isValidBundle,
  createBootstrapState,
  resetBootstrapStopped,
  computeBootstrapErrorAction,
  toApplyState,
  type BootstrapFetchOptions,
  type BootstrapFetchResult,
  type BundleApplyResult,
  type BootstrapState,
  drainBeforeGatewayKill,
  type DrainBeforeKillOptions,
  type DrainBeforeKillResult,
  type BootstrapStopReason,
} from './daemon/config-bootstrap.js';

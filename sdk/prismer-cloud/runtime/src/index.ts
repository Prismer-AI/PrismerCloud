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
export { hermesAdapter, type HermesProfileConfig } from './adapters/hermes/index.js';
export { openclawAdapter, type OpenClawProfileConfig } from './adapters/openclaw/index.js';

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
export { Runner, type RunnerOptions } from './daemon/runner.js';
export { pair, type PairOptions, type PairResult } from './pair.js';
export { claudeCodeAdapter, type ClaudeCodeConfig } from './adapters/claude-code/index.js';
export { codexAdapter, type CodexConfig, parseCodexOutput } from './adapters/codex/index.js';
export { buildProgram, runCli } from './cli/index.js';

// Wire-protocol payload types (mirror of cloud + SDK)
export type {
  AgentDispatchReplyAttachment,
  AgentDispatchReplyPayload,
  AgentDispatchReplyStatus,
  AgentDispatchRequest,
  AgentDispatchResponse,
  NormalizedContent,
} from './wire/dispatch-types.js';

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

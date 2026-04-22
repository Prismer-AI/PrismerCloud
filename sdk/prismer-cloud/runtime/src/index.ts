// Barrel re-export for the @prismer/runtime daemon library API.

export const RUNTIME_VERSION = '1.9.0';

export {
  DaemonProcess,
  DaemonAlreadyRunningError,
} from './daemon-process.js';

export type {
  DaemonState,
  DaemonOptions,
  ShutdownHandler,
} from './daemon-process.js';

export {
  EventBus,
} from './event-bus.js';

export type {
  EventBusEnvelope,
  SubscriptionHandler,
  Subscription,
  EventBusOptions,
} from './event-bus.js';

export {
  AgentSupervisor,
} from './agent-supervisor.js';

export type {
  AgentState,
  AgentDescriptor,
  AgentStatus,
  SupervisorOptions,
} from './agent-supervisor.js';

// Sprint A3 — AdapterRegistry / DispatchMux (D4)
export { AdapterRegistry } from './adapter-registry.js';
export type {
  AdapterDescriptor,
  AdapterDispatchInput,
  AdapterDispatchResult,
  AdapterImpl,
} from './adapter-registry.js';
export { DispatchMux } from './dispatch-mux.js';
export type { DispatchMuxRequest, DispatchMuxResult } from './dispatch-mux.js';

export {
  DaemonHttpServer,
} from './daemon-http.js';

export type {
  DaemonHttpOptions,
  AuthenticatedIdentity,
  RouteHandler,
} from './daemon-http.js';

export {
  EvolutionGatewayHttpHandler,
} from './evolution-gateway.js';

export type {
  EvolutionGatewayOptions,
  SignalExtractionRequest,
  AnalyzeRequest,
  RecordRequest,
  CreateGeneRequest,
  DistillationRequest,
} from './evolution-gateway.js';

export {
  TaskRouter,
  TaskRouteState,
} from './task-router.js';

export type {
  TaskRouterOptions,
  TaskInfo,
  RouteTaskRequest,
  RouteTaskResponse,
  AssignTaskRequest,
  StepCompletedRequest,
  CancelTaskRequest,
  StepFailedRequest,
  StepTimeoutRequest,
} from './task-router.js';

export {
  LLMDispatcher,
  AllProvidersFailedError,
} from './llm-dispatcher.js';

export type {
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMProvider,
  RoutingPolicy,
  ProviderStats,
} from './llm-dispatcher.js';

export {
  Keychain,
  NoKeychainBackendError,
  KeychainOperationError,
} from './keychain.js';

export type {
  KeychainBackend,
  KeychainAdapter,
  KeychainOptions,
} from './keychain.js';

export {
  loadConfig,
  writeConfig,
  parseKeyringPlaceholder,
  ConfigError,
} from './config.js';

export type {
  PrismerConfig,
  LoadConfigOptions,
} from './config.js';

export {
  migrateSecrets,
} from './commands/migrate-secrets.js';

export {
  startDaemonRunner,
} from './daemon/runner.js';

export type {
  DaemonRunnerOptions,
  DaemonRunnerHandle,
} from './daemon/runner.js';

export type {
  MigrateSecretsOptions,
  MigrateSecretsResult,
} from './commands/migrate-secrets.js';

export {
  UI,
  getUI,
  setUI,
  applyCommonFlags,
  assertBrandVoice,
} from './cli/ui.js';

export type {
  OutputMode,
  UIOptions,
  TableRow,
  TableOptions,
} from './cli/ui.js';

export {
  createCliContext,
} from './cli/context.js';

export type {
  CliContext,
} from './cli/context.js';

export {
  AGENT_CATALOG,
  getAgent,
} from './agents/registry.js';

export type {
  AgentCatalogEntry,
} from './agents/registry.js';

export {
  mergeHooks,
  readHookConfig,
  writeHookConfig,
  installHooks,
  rollbackHooks,
} from './agents/hooks.js';

export type {
  HookFormat,
  HookConfig,
  HookEntry,
  MergeResult,
  MergeOptions,
} from './agents/hooks.js';

export type {
  PairOffer,
  PairedDevice,
} from './commands/pair.js';

export type {
  MigrateOptions,
  MigrateResult,
} from './commands/migrate.js';

export {
  MemoryDB,
  type MemoryFile,
  type MemoryFileVersion,
  type DreamCompaction,
  getMemoryDB,
  closeMemoryDB,
  type EncryptionConfig,
  encrypt,
  decrypt,
  deriveKey,
  generateSalt,
} from './memory-db.js';

export {
  type WriteMemoryRequest,
  type RecallRequest,
  type ListMemoryRequest,
  type MemoryResponse,
} from './memory-gateway.js';

export {
  DreamScheduler,
  createDreamScheduler,
  runDream,
  type DreamResult,
  type DreamSchedulerOptions,
} from './memory-dream-runtime.js';

// PARA L8 Session Export — trace writer + manager
// See docs/version190/03-para-spec.md §4.2 L8
export {
  TraceWriter,
  TraceWriterManager,
} from './trace-writer.js';

export type {
  TraceWriterOptions,
  TraceWriterManagerOptions,
} from './trace-writer.js';

// Event bus integration for runtime package (requires wire package exports)
// @ts-ignore - Cannot find module './event-bus.js' in wire package, skip for now
// Temporarily commented out to unblock build
// export {
//   EventBus,
//   Subscription,
//   SubscriptionHandler,
//   EventBusEnvelope,
//   EventBusOptions,
// } from './event-bus.js';

// E2EE Crypto exports (v1.9.0) — exported separately to avoid conflict with memory-db encrypt/decrypt
export {
  generateKeyPair as generateE2EEKeyPair,
  deriveSharedSecret,
  deriveSessionKeys,
  createE2EEContext,
  encryptMessage,
  decryptMessage,
  deserializeEnvelope,
  serializeEnvelope,
} from './e2ee-crypto.js';

export type {
  KeyPair as E2EEKeyPair,
  E2EEContext,
  EncryptedEnvelope,
} from './e2ee-crypto.js';

// E2EE Key Storage exports (v1.9.0)
export {
  E2EEKeyStorage,
  createKeyEntry,
  generateSessionId,
  parseSessionId,
} from './e2ee-key-storage.js';

export type {
  E2EEKeyEntry,
  E2EEStorageStats,
} from './e2ee-key-storage.js';

// v1.9.0: Team Memory sync (delta push + secret scanning)
// Design: docs/version190/14e-memory-cc-compat.md §8.5
export {
  scanForSecrets,
  hasBlockingSecret,
} from './secret-scan.js';

export type {
  SecretHit,
} from './secret-scan.js';

export {
  syncTeamMemory,
  resetTeamSyncState,
  listMarkdownFiles,
  LAST_SYNC_FILE,
  MEMORY_TEAM_SYNC_MAX_BYTES,
} from './memory-team-sync.js';

export type {
  SyncTeamMemoryOptions,
  SyncTeamMemoryResult,
} from './memory-team-sync.js';

// v1.9.0: Shamir secret sharing for MEMORY_ENCRYPTION_SECRET key recovery.
// Design: docs/version190/14d-memory-infra.md §9.3
export {
  splitSecret,
  combineShares,
  encodeShareAsMnemonic,
  decodeShareFromMnemonic,
  unsafeAsShamirShare,
} from './shamir.js';

export type {
  ShamirShare,
} from './shamir.js';

// v1.9.0: Daemon-side outbox + timeline for disconnect compensation (§5.6.5).
// Paired with cloud relay-handler OPCODE 0x05/0x06 backfill protocol.
export { DaemonOutbox, frameFromParts } from './daemon-outbox.js';
export type {
  DaemonOutboxOptions,
  TimelineEntry,
  OutboxEntry,
} from './daemon-outbox.js';

export { RelayClient, OPCODE } from './relay-client.js';
export type { RelayClientOptions, RelayState, RemoteCommand } from './relay-client.js';

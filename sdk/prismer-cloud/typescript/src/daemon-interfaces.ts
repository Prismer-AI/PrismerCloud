/**
 * Prismer Daemon Extension Interfaces
 *
 * Phase 1: Define interfaces only. Minimal implementations per interface.
 * Full implementations deferred to subsequent phases.
 */

// --- LLM Dispatcher ---

export interface LLMBackend {
  type: 'claude-api' | 'openai-api' | 'ollama' | 'ide-agent';
  available: boolean;
  costPerToken: number;
  latencyMs: number;
  capabilities: string[];
}

export interface LLMTask {
  type: 'memory-dream' | 'evolution-distill' | 'context-summarize' | 'task-execute';
  prompt: string;
  maxTokens: number;
  priority: 'background' | 'interactive';
}

export interface LLMResult {
  content: string;
  tokensUsed: number;
  backend: string;
}

export interface LLMDispatcher {
  availableBackends(): LLMBackend[];
  dispatch(task: LLMTask): Promise<LLMResult>;
}

// --- Notification Sink ---

export interface PrismerEvent {
  type: string;
  source: 'im' | 'community' | 'evolution' | 'billing';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationSink {
  type: 'desktop' | 'ide-status' | 'file-log' | 'webhook';
  notify(event: PrismerEvent): Promise<void>;
}

// --- Task Executor ---

export interface ExecutionPolicy {
  autoExecute: boolean;
  maxConcurrent: number;
  allowedHours: [number, number];
  requireConfirmation: 'always' | 'high-risk' | 'never';
  maxCostCredits: number;
}

export interface QueuedTask {
  id: string;
  type: 'bounty' | 'maintenance' | 'dream' | 'distill';
  priority: number;
  estimatedCredits: number;
  estimatedDurationMs: number;
  payload: unknown;
}

export interface TaskResult {
  taskId: string;
  outcome: 'success' | 'failed' | 'cancelled';
  summary: string;
  creditsUsed: number;
}

export interface TaskExecutor {
  enqueue(task: QueuedTask): Promise<void>;
  poll(): Promise<QueuedTask[]>;
  execute(task: QueuedTask): Promise<TaskResult>;
}

// --- Cache Manager ---

export interface CacheManager {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  stats(): { entries: number; sizeBytes: number };
}

// --- Key Manager ---

export interface KeyManager {
  getIdentityKey(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }>;
  sign(data: Uint8Array): Promise<Uint8Array>;
  getDIDDocument(): Promise<Record<string, unknown>>;
}

// --- Daemon Control Plane ---

export interface ControlCommand {
  type: 'trigger-dream' | 'clear-cache' | 'update-config' | 'get-logs';
  payload?: Record<string, unknown>;
  requestId: string;
}

export interface CommandResult {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface DaemonControlPlane {
  reportStatus(): Promise<void>;
  onCommand(handler: (cmd: ControlCommand) => Promise<CommandResult>): void;
}

// ============================================================================
// Remote Control (Track 3 / v1.9.0)
//
// The canonical types live in `./remote.ts` and match the HTTP contract
// exactly. Re-exported here so existing `from '@prismer/sdk'` imports keep
// working, and legacy aliases are kept with @deprecated markers.
// ============================================================================

export type {
  DesktopBinding,
  OfferCandidate,
  QrInitRequest,
  QrInitResponse,
  QrConfirmRequest,
  QrConfirmResponse,
  ApiKeyBindRequest,
  ApiKeyBindResponse,
  RemoteCommand,
  RemoteCommandStatus,
  SendCommandRequest,
  QuickDecisionRequest,
  RegisterPushTokenRequest,
  PushToken,
  FsOp,
  FsReadRequest,
  FsReadResponse,
  FsWriteRequest,
  FsWriteResponse,
  FsDeleteRequest,
  FsDeleteResponse,
  FsEditRequest,
  FsEditResponse,
  FsListRequest,
  FsListResponse,
  FsListEntry,
  FsSearchRequest,
  FsSearchResponse,
  FsSearchMatch,
} from './remote';

// Legacy aliases — pre-v1.9.0 names used by older callers. Keep as type
// aliases so `import { PairingOffer } from '@prismer/sdk'` still type-checks,
// but the actual runtime shape is the corrected one from `./remote.ts`.

import type {
  QrInitResponse as _QrInitResponse,
  QrConfirmResponse as _QrConfirmResponse,
  SendCommandRequest as _SendCommandRequest,
  RegisterPushTokenRequest as _RegisterPushTokenRequest,
} from './remote';

/** @deprecated Use `QrInitResponse` (v1.9.0 shape: `{offerId, expiresAt}`). */
export type PairingOffer = _QrInitResponse;

/** @deprecated Use `QrConfirmResponse` (v1.9.0 shape: `{bindingId, daemonId}`). */
export type PairConfirmResult = _QrConfirmResponse;

/** @deprecated Use `SendCommandRequest` (field renamed `payload` → `envelope`). */
export type SendCommandOptions = _SendCommandRequest;

/** @deprecated Use `RegisterPushTokenRequest`. */
export type PushTokenRegisterOptions = _RegisterPushTokenRequest;

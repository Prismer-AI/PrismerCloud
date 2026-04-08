/**
 * Prismer Cloud SDK — Type definitions
 */

import type { StorageAdapter } from './storage';

// ============================================================================
// Environment
// ============================================================================

export type Environment = 'production';

export const ENVIRONMENTS: Record<Environment, string> = {
  production: 'https://prismer.cloud',
} as const;

// ============================================================================
// Config
// ============================================================================

export interface PrismerConfig {
  /** API Key (starts with sk-prismer-) or IM JWT token. Optional for anonymous IM registration. */
  apiKey?: string;
  /** Environment preset (default: 'production'). Sets the base URL automatically. */
  environment?: Environment;
  /** Base URL override. Takes priority over `environment` if both are set. */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
  /** Default X-IM-Agent header for IM requests (select which agent identity to use) */
  imAgent?: string;
  /** Enable offline-first mode for IM with local persistence and sync */
  offline?: OfflineConfig;
  /**
   * AIP identity for automatic message signing (v1.8.0 S1).
   * - `'auto'`: derive Ed25519 key from apiKey via SHA-256
   * - `{ privateKey: string }`: Base64-encoded Ed25519 private key
   * When set, all IM send requests auto-include senderDid + signature.
   */
  identity?: 'auto' | { privateKey: string };
  /** v1.8.0 CommunityHub cache tuning (`im.community`) */
  community?: CommunityHubConfig;
}

/** Options for `CommunityHub` (see `community-hub.ts`) */
export interface CommunityHubConfig {
  feedTTLMs?: number;
  statsTTLMs?: number;
}

// ============================================================================
// Context API Types
// ============================================================================

export interface LoadOptions {
  inputType?: 'auto' | 'url' | 'urls' | 'query';
  processUncached?: boolean;
  search?: { topK?: number };
  processing?: { strategy?: 'auto' | 'fast' | 'quality'; maxConcurrent?: number };
  return?: { format?: 'hqcc' | 'raw' | 'both'; topK?: number };
  ranking?: {
    preset?: 'cache_first' | 'relevance_first' | 'balanced';
    custom?: { cacheHit?: number; relevance?: number; freshness?: number; quality?: number };
  };
}

export interface RankingFactors {
  cache: number;
  relevance: number;
  freshness: number;
  quality: number;
}

export interface LoadResultItem {
  rank?: number;
  url: string;
  title?: string;
  hqcc?: string | null;
  raw?: string;
  cached: boolean;
  cachedAt?: string;
  processed?: boolean;
  found?: boolean;
  error?: string;
  ranking?: { score: number; factors: RankingFactors };
  meta?: Record<string, any>;
}

export interface SingleUrlCost { credits: number; cached: boolean }
export interface BatchUrlCost { credits: number; cached: number }
export interface QueryCost { searchCredits: number; compressionCredits: number; totalCredits: number; savedByCache: number }

export interface BatchSummary { total: number; found: number; notFound: number; cached: number; processed: number }
export interface QuerySummary { query: string; searched: number; cacheHits: number; compressed: number; returned: number }

export interface LoadResult {
  success: boolean;
  requestId?: string;
  mode?: 'single_url' | 'batch_urls' | 'query';
  result?: LoadResultItem;
  results?: LoadResultItem[];
  summary?: BatchSummary | QuerySummary;
  cost?: SingleUrlCost | BatchUrlCost | QueryCost;
  processingTime?: number;
  error?: { code: string; message: string };
}

export interface SaveOptions {
  url: string;
  hqcc: string;
  raw?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  meta?: Record<string, any>;
}

export interface SaveBatchOptions {
  items: SaveOptions[];
}

export interface SaveResult {
  success: boolean;
  status?: string;
  url?: string;
  content_uri?: string;
  visibility?: string;
  results?: Array<{ url: string; status: string; content_uri?: string }>;
  summary?: { total: number; created: number; updated?: number; failed?: number; exists?: number };
  error?: { code: string; message: string };
}

// ============================================================================
// Parse API Types
// ============================================================================

export interface ParseOptions {
  url?: string;
  base64?: string;
  filename?: string;
  mode?: 'fast' | 'hires' | 'auto';
  output?: 'markdown' | 'json';
  image_mode?: 'embedded' | 's3';
  wait?: boolean;
}

export interface ParseDocumentImage {
  page: number;
  url: string;
  caption?: string;
}

export interface ParseDocument {
  markdown?: string;
  text?: string;
  pageCount: number;
  metadata?: { title?: string; author?: string; [key: string]: any };
  images?: ParseDocumentImage[];
  estimatedTime?: number;
}

export interface ParseUsage {
  inputPages: number;
  inputImages: number;
  outputChars: number;
  outputTokens: number;
}

export interface ParseCostBreakdown {
  pages: number;
  images: number;
}

export interface ParseCost {
  credits: number;
  breakdown?: ParseCostBreakdown;
}

export interface ParseResult {
  success: boolean;
  requestId?: string;
  mode?: string;
  async?: boolean;
  document?: ParseDocument;
  usage?: ParseUsage;
  cost?: ParseCost;
  taskId?: string;
  status?: string;
  endpoints?: { status: string; result: string; stream: string };
  processingTime?: number;
  error?: { code: string; message: string };
}

// ============================================================================
// IM API Types
// ============================================================================

export interface IMRegisterOptions {
  type: 'agent' | 'human';
  username: string;
  displayName: string;
  agentType?: 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';
  capabilities?: string[];
  description?: string;
  endpoint?: string;
}

export interface IMRegisterData {
  imUserId: string;
  username: string;
  displayName: string;
  role: string;
  token: string;
  expiresIn: string;
  capabilities?: string[];
  isNew: boolean;
}

export interface IMUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string;
}

export interface IMAgentCard {
  agentType: string;
  capabilities: string[];
  description?: string;
  status: string;
}

export interface IMMeData {
  user: IMUser;
  agentCard?: IMAgentCard;
  stats: { conversationCount: number; directCount?: number; groupCount?: number; contactCount: number; messagesSent: number; unreadCount: number };
  bindings: Array<{ platform: string; status: string; externalName?: string }>;
  credits: { balance: number; totalSpent: number };
}

export interface IMTokenData {
  token: string;
  expiresIn: string;
}

export interface IMMessage {
  id: string;
  conversationId?: string;
  content: string;
  type: string;
  senderId: string;
  parentId?: string | null;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, any> | string;
}

export interface IMRouting {
  mode: string;
  targets: Array<{ userId: string; username?: string }>;
}

export interface IMMessageData {
  conversationId: string;
  message: IMMessage;
  routing?: IMRouting;
}

export interface IMGroupMember {
  userId: string;
  username: string;
  displayName?: string;
  role: string;
}

export interface IMGroupData {
  groupId: string;
  title: string;
  description?: string;
  members: IMGroupMember[];
}

export interface IMContact {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
  isAgent?: boolean;
  institution?: string;
  lastSeenAt?: string;
  remark?: string;
  addedAt?: string;
  lastMessageAt?: string;
  lastMessage?: string;
  unreadCount: number;
  conversationId: string;
  conversationType?: string;
}

export interface IMUserProfile {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
  status?: string;
  isAgent?: boolean;
  agentType?: string;
  capabilities?: string[];
  description?: string;
  institution?: string;
  did?: string;
  isContact?: boolean;
  lastSeenAt?: string;
}

export interface IMFriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  reason?: string;
  source?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
  updatedAt: string;
  fromUser?: { username: string; displayName: string; avatarUrl?: string };
  toUser?: { username: string; displayName: string; avatarUrl?: string };
}

export interface IMBlockedUser {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  reason?: string;
  blockedAt: string;
}

export interface IMDiscoverAgent {
  username: string;
  displayName: string;
  agentType?: string;
  capabilities?: string[];
  status: string;
}

export interface IMBindingData {
  bindingId: string;
  platform: string;
  status: string;
  verificationCode: string;
}

export interface IMBinding {
  bindingId: string;
  platform: string;
  status: string;
  externalName?: string;
}

export interface IMCreditsData {
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

export interface IMTransaction {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

export interface IMConversation {
  id: string;
  type: string;
  title?: string;
  lastMessage?: IMMessage;
  unreadCount?: number;
  members?: IMGroupMember[];
  pinned?: boolean;
  muted?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface IMWorkspaceData {
  workspaceId?: string;
  conversationId: string;
  user?: { imUserId: string; token: string };
  agent?: any;
}

export interface IMWorkspaceInitOptions {
  workspaceId: string;
  userId: string;
  userDisplayName: string;
}

export interface IMWorkspaceInitGroupOptions {
  workspaceId: string;
  title: string;
  users: Array<{ userId: string; displayName: string }>;
}

export interface IMAutocompleteResult {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

export interface IMCreateGroupOptions {
  title: string;
  description?: string;
  members?: string[];
  metadata?: Record<string, any>;
}

export interface IMCreateBindingOptions {
  platform: 'telegram' | 'discord' | 'slack' | 'wechat' | 'x' | 'line';
  botToken: string;
  chatId?: string;
  channelId?: string;
}

export interface IMSendOptions {
  type?: 'text' | 'markdown' | 'code' | 'image' | 'file' | 'tool_call' | 'tool_result' | 'system_event' | 'thinking';
  metadata?: Record<string, any>;
  parentId?: string;
  /** Override auto-signing for this message (e.g., skip signing for system_event) */
  skipSigning?: boolean;
}

export interface IMPaginationOptions {
  limit?: number;
  offset?: number;
}

export interface IMConversationsOptions {
  withUnread?: boolean;
  unreadOnly?: boolean;
}

export interface IMDiscoverOptions {
  type?: string;
  capability?: string;
}

// ── File Upload ─────────────────────────────────────────────

export interface IMPresignOptions {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface IMPresignResult {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface IMConfirmResult {
  uploadId: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string | null;
  cost: number;
}

export interface IMFileQuota {
  used: number;
  limit: number;
  tier: string;
  fileCount: number;
}

// ── File Upload (high-level) ─────────────────────────────

/** Input source for upload() — polymorphic across Node.js and browser */
export type FileInput = File | Blob | Buffer | Uint8Array | string;

export interface UploadOptions {
  /** File name (required if input is Buffer/Uint8Array/Blob without name) */
  fileName?: string;
  /** MIME type (auto-detected from fileName extension if not provided) */
  mimeType?: string;
  /** Progress callback */
  onProgress?: (uploaded: number, total: number) => void;
}

export interface UploadResult {
  uploadId: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string | null;
  cost: number;
}

export interface SendFileOptions extends UploadOptions {
  /** Message content (defaults to fileName) */
  content?: string;
  /** Parent message ID for threading */
  parentId?: string;
}

export interface SendFileResult {
  upload: UploadResult;
  message: any;
}

export interface IMMultipartInitResult {
  uploadId: string;
  parts: Array<{ partNumber: number; url: string }>;
  expiresAt: string;
}

/** Generic IM API response wrapper */
export interface IMResult<T = any> {
  ok: boolean;
  data?: T;
  meta?: { total?: number; pageSize?: number };
  error?: { code: string; message: string };
}

// ── Offline Configuration ──────────────────────────────────────

export interface OfflineConfig {
  /** Storage adapter implementation (IndexedDBStorage, MemoryStorage, SQLiteStorage) */
  storage: StorageAdapter;
  /** Auto-sync on reconnect (default: true) */
  syncOnConnect?: boolean;
  /** Max retries per outbox operation (default: 5) */
  outboxRetryLimit?: number;
  /** Outbox flush interval in ms (default: 1000) */
  outboxFlushInterval?: number;
  /** Conflict strategy: 'server' = server wins, 'client' = client wins (default: 'server') */
  conflictStrategy?: 'server' | 'client';
  /** Custom conflict resolver — called when server and local message diverge */
  onConflict?: (local: import('./storage').StoredMessage, remote: { type: string; data: any; seq: number }) => 'keep_local' | 'accept_remote' | import('./storage').StoredMessage;
  /** Sync mode: 'push' = SSE continuous stream, 'poll' = periodic polling (default: 'push') */
  syncMode?: 'push' | 'poll';
  /** Enable multi-tab coordination via BroadcastChannel (default: true in browser, false in Node.js) */
  multiTab?: boolean;
  /** E2E encryption config */
  e2e?: {
    enabled: boolean;
    /** User passphrase for master key derivation (PBKDF2) */
    passphrase: string;
  };
  /** Storage quota config */
  quota?: {
    /** Max storage size in bytes (default: 500MB) */
    maxStorageBytes?: number;
    /** Warning threshold 0-1 (default: 0.9 = 90%) */
    warningThreshold?: number;
  };
}

// ============================================================================
// Tasks API Types
// ============================================================================

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ScheduleType = 'once' | 'interval' | 'cron';

export interface IMCreateTaskOptions {
  title: string;
  description?: string;
  capability?: string;
  input?: Record<string, unknown>;
  contextUri?: string;
  assigneeId?: string;
  scheduleType?: ScheduleType;
  scheduleAt?: string;
  scheduleCron?: string;
  intervalMs?: number;
  maxRuns?: number;
  timeoutMs?: number;
  deadline?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  budget?: number;
  metadata?: Record<string, unknown>;
}

export interface IMUpdateTaskOptions {
  assigneeId?: string;
  status?: TaskStatus;
  metadata?: Record<string, unknown>;
}

export interface IMTaskListOptions {
  status?: TaskStatus;
  capability?: string;
  assigneeId?: string;
  creatorId?: string;
  scheduleType?: ScheduleType;
  limit?: number;
  cursor?: string;
}

export interface IMCompleteTaskOptions {
  result?: unknown;
  resultUri?: string;
  cost?: number;
}

export interface IMTask {
  id: string;
  title: string;
  description: string | null;
  capability: string | null;
  input: Record<string, unknown>;
  contextUri: string | null;
  creatorId: string;
  assigneeId: string | null;
  status: TaskStatus;
  scheduleType: ScheduleType | null;
  scheduleCron: string | null;
  intervalMs: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  maxRuns: number | null;
  result: unknown | null;
  resultUri: string | null;
  error: string | null;
  budget: number | null;
  cost: number;
  timeoutMs: number;
  deadline: string | null;
  maxRetries: number;
  retryDelayMs: number;
  retryCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IMTaskLog {
  id: string;
  taskId: string;
  actorId: string | null;
  action: string;
  message: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IMTaskDetail {
  task: IMTask;
  logs: IMTaskLog[];
}

// ============================================================================
// Memory API Types
// ============================================================================

export interface IMCreateMemoryFileOptions {
  path: string;
  content: string;
  scope?: string;
  ownerType?: 'user' | 'agent';
}

export interface IMUpdateMemoryFileOptions {
  operation: 'append' | 'replace' | 'replace_section';
  content: string;
  section?: string;
  version?: number;
}

export interface IMCompactOptions {
  conversationId: string;
  summary: string;
  messageRangeStart?: string;
  messageRangeEnd?: string;
}

export interface IMMemoryFile {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'agent';
  scope: string;
  path: string;
  version: number;
  contentLength: number;
  createdAt: string;
  updatedAt: string;
}

export interface IMMemoryFileDetail extends IMMemoryFile {
  content: string;
}

export interface IMCompactionSummary {
  id: string;
  conversationId: string;
  summary: string;
  messageRangeStart: string | null;
  messageRangeEnd: string | null;
  tokenCount: number;
  createdAt: string;
}

export interface IMMemoryLoadResult {
  content: string | null;
  totalLines: number;
  totalBytes: number;
  version: number;
  id: string | null;
  scope: string;
  path: string;
  template: string;
}

// ============================================================================
// Knowledge Links API Types
// ============================================================================

export type KnowledgeLinkSource = 'memory' | 'gene' | 'capsule' | 'signal';
export type KnowledgeLinkType = 'related' | 'derived_from' | 'applied_in' | 'contradicts';

export interface IMKnowledgeLink {
  id: string;
  sourceType: KnowledgeLinkSource;
  sourceId: string;
  targetType: KnowledgeLinkSource;
  targetId: string;
  linkType: KnowledgeLinkType;
  strength: number;
  scope: string;
  createdAt: string;
}

export interface IMMemoryKnowledgeLinks {
  links: Array<{
    memoryId: string;
    memoryPath: string;
    genes: Array<{
      geneId: string;
      title: string;
      linkType: string;
      strength: number;
      successRate: number;
    }>;
  }>;
  unlinkedMemories: string[];
  totalLinks: number;
}

// ============================================================================
// Identity API Types
// ============================================================================

export type DerivationMode = 'generated' | 'derived' | 'imported';

export interface IMRegisterKeyOptions {
  publicKey: string;
  derivationMode?: DerivationMode;
}

export interface IMIdentityKey {
  imUserId: string;
  publicKey: string;
  keyId: string;
  attestation: string | null;
  derivationMode: DerivationMode;
  registeredAt: string;
  revokedAt: string | null;
  serverPublicKey?: string;
}

export interface IMKeyAuditEntry {
  id: number;
  imUserId: string;
  action: 'register' | 'rotate' | 'revoke';
  publicKey: string;
  keyId: string;
  attestation: string;
  prevLogHash: string | null;
  createdAt: string;
}

export interface IMKeyVerifyResult {
  valid: boolean;
  invalidAt?: number;
}

// ============================================================================
// Evolution API Types
// ============================================================================

export type GeneCategory = 'repair' | 'optimize' | 'innovate' | 'diagnostic';
export type GeneVisibility = 'private' | 'canary' | 'published' | 'quarantined' | 'seed';

/** v0.3.0 SignalTag — hierarchical label for a trigger dimension */
export interface SignalTag {
  type: string;
  provider?: string;
  stage?: string;
  severity?: string;
  [key: string]: string | undefined;
}

export interface IMCreateGeneOptions {
  category: GeneCategory;
  signals_match: string[] | SignalTag[];
  strategy: string[];
  title?: string;
  preconditions?: string[];
  constraints?: Record<string, unknown>;
}

export interface IMAnalyzeOptions {
  context?: string;
  signals?: string[] | SignalTag[];
  task_status?: string;
  task_capability?: string;
  error?: string;
  tags?: string[];
  custom_signals?: string[];
  provider?: string;
  stage?: string;
  severity?: string;
}

export interface IMRecordOutcomeOptions {
  gene_id: string;
  signals: string[] | SignalTag[];
  outcome: 'success' | 'failed';
  score?: number;
  summary: string;
  cost_credits?: number;
  metadata?: Record<string, unknown>;
  strategy_used?: string[];
}

export interface IMGene {
  type: string;
  id: string;
  category: GeneCategory;
  title?: string;
  description?: string;
  visibility?: GeneVisibility;
  signals_match: SignalTag[];
  preconditions: string[];
  strategy: string[];
  constraints: Record<string, unknown>;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  created_by: string;
  distilled_from?: string[];
  parentGeneId?: string | null;
  forkCount?: number;
  generation?: number;
}

export interface IMAnalyzeResult {
  action: 'apply_gene' | 'explore' | 'none' | 'create_suggested';
  gene_id?: string;
  gene?: IMGene;
  strategy?: string[];
  confidence: number;
  coverageScore?: number;
  signals: SignalTag[];
  alternatives?: Array<{ gene_id: string; confidence: number }>;
  reason?: string;
  suggestion?: {
    category: GeneCategory;
    signals_match: SignalTag[];
    title: string;
    description: string;
    similar_genes: Array<{ gene_id: string; title: string; similarity: number }>;
  };
}

export interface IMEvolutionStats {
  total_genes: number;
  total_capsules: number;
  avg_success_rate: number;
  active_agents: number;
}

export interface IMCapsule {
  id: string;
  gene_id: string;
  agent_id: string;
  signals: string[];
  outcome: string;
  score: number;
  summary: string;
  created_at: string;
}

export interface IMEvolutionEdge {
  signal_key: string;
  gene_id: string;
  success_count: number;
  failure_count: number;
  confidence: number;
  last_score: number | null;
  last_used_at: string | null;
}

export interface IMAgentPersonality {
  rigor: number;
  creativity: number;
  risk_tolerance: number;
}

export interface IMGeneListOptions {
  category?: GeneCategory;
  search?: string;
  sort?: 'newest' | 'most_used' | 'highest_success';
  page?: number;
  limit?: number;
}

export interface IMForkGeneOptions {
  gene_id: string;
  modifications?: Record<string, unknown>;
}

// ============================================================================
// Skill Ecosystem Types
// ============================================================================

export interface IMSkillInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  source: string;
  sourceUrl: string;
  installs: number;
  stars: number;
  status: string;
  version: string;
  compatibility: string[];
  signals: SignalTag[];
  geneId: string | null;
  hasPackage: boolean;
  fileCount: number;
}

export interface IMSkillInstallResult {
  agentSkill: { id: string; status: string; version: string; installedAt: string };
  gene: IMGene | null;
  skill: IMSkillInfo & { content: string };
  installGuide: Record<string, { auto?: string; manual?: string; command?: string; [key: string]: any }>;
}

export interface IMAgentSkillRecord {
  agentSkill: { id: string; skillId: string; geneId: string | null; status: string; version: string; installedAt: string };
  skill: IMSkillInfo;
  gene: IMGene | null;
}

export interface IMSkillContent {
  content: string;
  packageUrl: string | null;
  files: Array<{ path: string; size: number }>;
  checksum: string | null;
}

/** Internal request function type */
export type RequestFn = <T>(method: string, path: string, body?: unknown, query?: Record<string, string>) => Promise<T>;

// ============================================================================
// Evolution Mechanism Types (used by EvolutionCache, SignalEnrichment, Runtime)
// ============================================================================

export interface ExecutionContext {
  error?: string;
  provider?: string;
  stage?: string;
  severity?: string;
  taskStatus?: string;
  taskCapability?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface SignalEnrichmentConfig {
  mode: 'rules' | 'llm';
  llmExtract?: (ctx: ExecutionContext) => Promise<SignalTag[]>;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export interface GeneSelectionResult {
  action: 'apply_gene' | 'create_suggested' | 'none';
  gene_id?: string;
  gene?: IMGene;
  strategy?: string[];
  confidence: number;
  coverageScore?: number;
  alternatives?: Array<{ gene_id: string; confidence: number; title?: string }>;
  reason?: string;
  fromCache: boolean;
}

export interface EvolutionSyncSnapshot {
  genes: IMGene[];
  edges: IMEvolutionEdge[];
  globalPrior: Record<string, { alpha: number; beta: number }>;
  cursor: number;
}

export interface EvolutionSyncDelta {
  pulled: {
    genes: IMGene[];
    edges: IMEvolutionEdge[];
    globalPrior: Record<string, { alpha: number; beta: number }>;
    promotions: string[];
    quarantines: string[];
    cursor: number;
  };
}

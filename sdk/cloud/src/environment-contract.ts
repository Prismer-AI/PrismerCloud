/**
 * EaaS tenant bounded context — TS SDK mirror of the wire contract.
 *
 * ⚠️ SOURCE OF TRUTH: `src/tenant/contract.ts` (types + error codes) and
 * `src/tenant/errors.ts` (response envelope). This module deliberately does
 * NOT import cloud src/ — every field below is a hand-maintained mirror and
 * the two sides must stay field-identical. 改两头必须同步：any change to a
 * field, union member or error code on the server contract must be applied
 * here in the same change (the unit tests pin the error-code set exactly).
 *
 * No zod — plain interfaces + one lightweight guard. Subpath export:
 * `@prismer/sdk/environment-contract`.
 */

// ── Error codes（Global Constraint 5 精确集合，code → HTTP status）──────────
//
// `not_owned` carries 404（资源不存在与不属于本租户统一 404，零数据泄漏）；
// 403 留给 scope_denied；503 warm_capacity_unavailable 由调用方决定降级或重试，
// SDK 绝不自动转 cold（见 WarmPoolClient）。Gate B T5/T7 新码
// （invalid_session/publishable_key_invalid/session_expired/capability_denied）
// 由 `POST /api/v1/sessions` 与对话面发射——同步自 src/tenant/contract.ts（T19）。
export const EAAS_ERROR_CODES = {
  invalid_policy: 400,
  invalid_request: 400,
  invalid_token: 401,
  // Gate B T5 sessions face（publishable key / identityToken / principal token）。
  invalid_session: 401,
  publishable_key_invalid: 401,
  session_expired: 401,
  budget_exhausted: 402,
  scope_denied: 403,
  // Gate B T7 conversation face（匿名 principal 无 IM 会话宿主）。
  capability_denied: 403,
  // 多模态输入面：contentBlocks 引用的 image asset 不可读/不属于本 env（可见失败）。
  invalid_asset: 400,
  not_owned: 404,
  state_conflict: 409,
  idempotency_conflict: 409,
  revision_conflict: 412,
  template_unavailable: 422,
  capability_unavailable: 422,
  quota_exceeded: 429,
  rate_limited: 429,
  warm_capacity_unavailable: 503,
  provider_unavailable: 503,
  pricing_unavailable: 503,
  // Gate B+ Task 7：环境内 Runtime turn 面不可用（载体 daemon 未就绪 / bundle
  // turn 入口缺失 / exec 控制面失败 / exec 硬超时）。turn 是 fire-and-forget
  // 派发，故它只出现在 run 与线程内 status 事件面，不改变任何 HTTP 状态语义。
  runtime_unavailable: 503,
} as const;

export type EaasErrorCode = keyof typeof EAAS_ERROR_CODES;

// ── Response envelope（src/tenant/errors.ts 镜像）───────────────────────────
//
// 成功 { success:true, data, requestId }；失败 { success:false, error:{code,
// message, details}, requestId }。details 键恒存在（无详情 → null，T2-(e)），
// 因此这里保持 required 而非 optional——与线上形态逐字一致。

export interface EaasErrorBody {
  /** EAAS_ERROR_CODES key（服务端承诺精确集合；`string & {}` 容忍前向漂移）。 */
  code: EaasErrorCode | (string & {});
  message: string;
  details?: unknown;
  /**
   * 客户端预留字段——当前服务端不发射（429/503 的可重试信号走 `Retry-After`
   * **响应头**，不入 body）。保留仅为容忍未来 body 面扩展。
   */
  retryable?: boolean;
}

export interface EaasSuccessEnvelope<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface EaasFailEnvelope {
  success: false;
  error: EaasErrorBody;
  requestId: string;
}

/** EaaS `/api/v1/*` 统一响应壳（PkfApiEnvelope 同构、判别式更紧）。 */
export type EaasApiEnvelope<T> = EaasSuccessEnvelope<T> | EaasFailEnvelope;

/** 轻量 guard：判定任意值是否为 EaaS 失败 envelope。 */
export function isEaasErrorEnvelope(v: unknown): v is EaasFailEnvelope {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.success !== false) return false;
  const err = o.error;
  if (typeof err !== 'object' || err === null || Array.isArray(err)) return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'string' && e.code.length > 0 && typeof e.message === 'string';
}

// ── Protocol types（src/tenant/contract.ts 逐字镜像）────────────────────────

/** 创建 spec。project/template/profile 可由 project key 与服务端默认值推导。 */
export interface EnvironmentCreateSpec {
  projectId?: string;
  /** 官方模板名或不可变版本（`name@sha256:...` pin；pin 不符 → 422 template_unavailable）。 */
  template?: string;
  /** Registry profile ID; availability is determined by the selected server pool. */
  profile?: string;
  /** Advanced pool selection. Omitted means the server default pool. */
  poolId?: string;
  /** Advanced placement selection. Omitted means the server default placement. */
  placementId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
  /** 敏感值仅身份绑定后注入，不写事件或预热模板（spec §4）。 */
  env?: Record<string, string>;
  /** create 只能收紧项目策略：cold→fail 可以，fail→cold 拒 400（Global Constraint 8）。 */
  startup?: { onWarmMiss?: 'cold' | 'fail' };
}

export interface EaasProfileResources {
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
}

export interface EaasContextProjection {
  credential: {
    kind: 'machine' | 'legacy' | 'operator';
    keyId: string;
    scopes: string[];
    expiresAt: string | null;
  };
  tenant: {
    id: string;
    name: string | null;
  };
  project: {
    id: string;
    name: string;
  };
  defaults: {
    template: string;
    profile: string;
    ttlSeconds: number;
    poolId: string | null;
    placementId: string | null;
  };
  capabilities: {
    /** Identity discovery succeeded, but platform admission is unavailable. Never a write permit. */
    unavailableReason?: 'provider_unavailable' | 'pricing_unavailable';
    templates: string[];
    profiles: string[];
    /** Actions common to all enabled, allowed project placements and this key. */
    lifecycleActions: string[];
    delegation: boolean;
    placements: Array<{
      id: string;
      providerKind: string;
      region: string | null;
      revision: number;
    }>;
    pools: Array<{
      id: string;
      placementId: string;
      template: string;
      profile: string;
      mode: string;
      default: boolean;
      /** Absent on older servers; absence is not proof of availability. */
      available?: boolean;
      reason?: string | null;
      mappingRevision?: string;
      templateVersion?: string;
      profileRevision?: string;
      resources?: EaasProfileResources;
      networkPolicyRevision?: string;
      storagePolicyRevision?: string;
    }>;
  };
  limits: {
    maxTtlSeconds: number | null;
    observedAt: string;
  };
}

/** 环境状态投影（API 草案逐字；Global Constraint 14 状态机）。 */
export interface EnvironmentStatus {
  environmentId: string;
  state: 'pending' | 'provisioning' | 'running' | 'degraded' | 'paused' | 'stopping' | 'stopped' | 'errored';
  revision: number;
  epoch: number;
  readiness: { sandbox: boolean; services: boolean; agent: boolean | null };
  startupPath: 'warm' | 'cold' | 'wake' | 'restore' | null;
  templateVersion: string;
  mappingRevision?: string;
  profileRevision?: string;
  networkPolicyRevision?: string;
  storagePolicyRevision?: string;
  expiresAt: string;
  milestones: Array<{ name: string; at: string; durationMs?: number }>;
}

/** One preference in the project's full-replacement multi-pool policy. */
export interface PoolPreference {
  poolId: string;
  enabled: boolean;
  /** Integer 0..5; must not exceed maxReady. */
  minReady: number;
  /** Integer 0..5, bounded by the platform pool ceiling. */
  maxReady: number;
  /** Integer 0..1800. */
  idleRetentionSeconds: number;
  /** Integer 0..1000. */
  priority: number;
  onMiss: 'cold' | 'reject';
}

export interface ProjectPoolManagement {
  /** Shared project ceiling, integer 0..5. */
  maxReady: number;
  /** Decimal string <= 1e9 with at most six fractional digits. */
  dailyBudgetCredits: string;
  defaultPoolId: string;
  /** Ordered unique pool IDs, excluding the default. */
  fallbackPoolIds: string[];
  /** Full replacement, at most 100 preferences. */
  pools: PoolPreference[];
}

export interface PoolPolicyStatus {
  revision: number;
  observedRevision: number;
  configRevision: string;
  allowedPoolIds: string[];
  policy: ProjectPoolManagement;
}

export interface ProjectPoolStatus {
  poolId: string;
  placementId: string;
  providerKind: string;
  mode: 'cold' | 'warm' | 'provider-managed';
  default: boolean;
  available?: boolean;
  mappingRevision?: string;
  templateVersion?: string;
  profileRevision?: string;
  resources?: EaasProfileResources;
  networkPolicyRevision?: string;
  storagePolicyRevision?: string;
  desired: { minReady: number; maxReady: number };
  effectiveTarget: number | null;
  state: 'draining' | 'disabled' | 'unknown' | 'degraded' | 'reconciling' | 'ready';
  inventory: {
    known: boolean;
    source: 'eaas' | 'provider';
    ready: number | null;
    provisioning: number | null;
    terminating: number | null;
    observedAt: string | null;
  };
  retiredInventory: number;
  reason: 'budget_exhausted' | 'capacity_limited' | 'provider_inventory_unknown' |
    'mapping_not_activated' | 'template_binding_required' | 'pricing_unavailable' | null;
}

export interface ProjectPoolsPage {
  pools: ProjectPoolStatus[];
  nextCursor: string | null;
  activation: { desiredRevision: string | null; observedRevision: string | null; phase: string; freshUntil: string | null };
  policyRevision: number;
  observedAt: string;
}

/** Legacy default-pool preference and shared project budget. */
export interface WarmPoolPolicy {
  /** 目标可领取库存数。整数 0..5，默认 0。 */
  minReady: number;
  /** 含 provisioning+ready 的预热总上限。整数 minReady..5，默认 0。 */
  maxReady: number;
  /** 高于 minReady 的未领取库存保留窗口。整数 0..1800，默认 0。 */
  idleRetentionSeconds: number;
  /** 非负十进制定点数（UTC 日窗口）。默认 "0"。 */
  dailyBudgetCredits: string;
  /** 默认 cold；fail → 503 warm_capacity_unavailable。 */
  onMiss: 'cold' | 'fail';
}

/** GET/PATCH/dryRun 统一返回（API 草案逐字）。 */
export interface WarmPoolStatus {
  revision: number;
  observedRevision: number;
  desired: WarmPoolPolicy;
  effective: {
    state: 'disabled' | 'reconciling' | 'ready' | 'degraded';
    ready: number;
    provisioning: number;
    terminating: number;
    reason?: 'budget_exhausted' | 'quota_exceeded' | 'provider_unavailable' | 'template_changed';
  };
  cost: {
    rateVersion: string | null;
    estimatedHourlyCredits: string;
    spentTodayCredits: string;
    reservedCredits: string;
    remainingTodayCredits: string;
    periodStart: string;
    periodEnd: string;
  };
}

// ── 事件类型全集（src/tenant/events.ts 的 EVENT_TYPES 逐字镜像）──────────────

/**
 * 租户事件类型冻结集合（源：`src/tenant/events.ts` 的 `EVENT_TYPES`，`as const`）。
 *
 * 在此之前 SDK 侧只有 `EaasEventEnvelope.type: string` 这条裸串面——镜像集合由
 * 2026-09-21 的工具事件（`run.tool_started` / `run.tool_finished`，spec §3.4）
 * 补齐。与错误码同款纪律：单测**精确钉住**成员集合，服务端增删一个类型而这里没跟
 * 就是红（`tests/unit/environment-contract.test.ts`）。
 *
 * 前向兼容：`EaasEventEnvelope.type` 仍是 `string`，**不**收紧成这个 union——
 * 服务端先发新类型、SDK 后跟版本是常态，收紧会让「新服务端 + 旧 SDK」在类型层
 * 直接爆掉，而运行时本可容忍（spec §3.4：消费方按字符串匹配，未知类型忽略）。
 * 需要窄化判定的消费方自行 `EAAS_EVENT_TYPES.includes(...)`。
 */
export const EAAS_EVENT_TYPES = [
  'environment.created',
  'environment.state_changed',
  'environment.readiness_changed',
  'environment.deleted',
  'environment.warm_pool.updated',
  'environment.warm_pool.degraded',
  'usage.warning',
  'rate_table.updated',
  'quota_templates.updated',
  'tenant.quota_updated',
  'tenant.frozen',
  'tenant.unfrozen',
  'billing.usage_adjusted',
  // run 生命周期五类型（T3-2，spec 10 §3.4）。⚠️ 拼写与 spec 正文有一处偏差：
  // 服务端既有写入点与既有消费方（journey 终态帧匹配）用的都是 `run.canceled`，
  // 故镜像与数据源对齐（服务端注释同样标注，见 src/tenant/events.ts）。
  'run.started',
  'run.completed',
  'run.failed',
  'run.canceled',
  'run.awaiting_approval',
  'run.tool_started',
  'run.tool_finished',
] as const;

export type EaasEventType = (typeof EAAS_EVENT_TYPES)[number];

/**
 * `run.tool_started` payload（源：`src/tenant/tool-event-stream.ts` 的轮询器经
 * `agent-turn-runtime.ts` 双写；spec §3.4 表 + 摘要纪律）。
 *
 * ⚠️ 与 spec §3.4 表格的偏差（如实记录）：线上还带 `sandboxId`（载体 sandbox id，
 * events.ts 的 doc comment 已点名）——故这里是 optional，既不漏掉线上字段，也不把
 * 「尚未 promote 的旧形态」判成非法。摘要字段已由服务端按 500 字符截断（超长以
 * `…(+N chars)` 结尾），**绝不落 token / 凭据**；不可用时为 null（键恒存在）。
 */
export interface EaasRunToolStartedPayload {
  runId: string;
  turnId: string;
  environmentId: string;
  /** 工具名（本轮生产者为 `bash`；按 string 容忍前向扩展）。 */
  tool: string;
  /** 命令摘要（≤500 字符）；不可用时 null。 */
  argsSummary: string | null;
  /** 载体 sandbox id（轮询器 payload 附带；旧形态可能缺省）。 */
  sandboxId?: string | null;
}

/**
 * `run.tool_finished` payload（同源）。**与 started 不成对是合法形态**：取消 / 超时
 * 会留孤儿 started（spec §5 修5，事件是观察不是保证配对的流——消费方不得假设成对）。
 */
export interface EaasRunToolFinishedPayload {
  runId: string;
  turnId: string;
  environmentId: string;
  tool: string;
  /** 结果摘要（≤500 字符）；不可用时 null。 */
  resultSummary: string | null;
  /** 工具自身失败（非零退出 / 抛错）——承载面失败（runtime_unavailable 等）走 run 状态，不走这里。 */
  isError: boolean;
  /** 工具耗时（毫秒）；不可用时 null。 */
  durationMs: number | null;
  /** 载体 sandbox id（轮询器 payload 附带；旧形态可能缺省）。 */
  sandboxId?: string | null;
}

/** 事件 envelope（Global Constraint 13；eventId = `${tenantId}:${seq}`，cursor 为 seq 字符串）。 */
export interface EaasEventEnvelope {
  v: 1;
  eventId: string;
  cursor: string;
  /**
   * 类型名。**刻意保持 `string`**（不是 `EaasEventType`）：additive 扩展下旧消费方
   * 收到未知类型必须忽略而非崩（新工具事件 `run.tool_*` 即此形态的首次实战）。
   * 集合镜像见 `EAAS_EVENT_TYPES`。
   */
  type: string;
  at: string;
  environmentId?: string;
  projectId?: string;
  payload: Record<string, unknown>;
}

// ── SDK-side composite results / errors ─────────────────────────────────────

/** `list()` data 面（src/tenant/environments.ts ListEnvironmentsResult 镜像）。 */
export interface EnvironmentListPage {
  environments: EnvironmentStatus[];
  nextCursor: string | null;
}

/** lifecycle 面（pause/wake/suspend/delete/restore）data 镜像（LifecycleResult）。 */
export interface EaasLifecycleResult {
  environmentId: string;
  state: EnvironmentStatus['state'];
  epoch: number;
  revision: number;
  operationId: string | null;
}

/** `exec()` data 面（src/tenant/exec.ts ExecServiceResult body 镜像：同步窗或 A1 句柄）。 */
export type EaasExecView =
  | {
      execId: string;
      status: 'exited';
      exitCode: number;
      stdout: string;
      stderr: string;
      startedAt: string;
      finishedAt: string;
    }
  | { execId: string; status: 'running'; command: string[]; startedAt: string };

/** `getExec()` data 面（A1 句柄读；cursor=stdout 字节偏移，单响应 ≤64KB）。 */
export interface EaasExecReadView {
  execId: string;
  command: string[];
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  nextCursor: number | null;
}

/** `createSnapshot()` data 面（pending op 形；执行在 reconcile）。 */
export interface EaasSnapshotCreated {
  environmentId: string;
  snapshotId: string;
  state: 'pending';
  operationId: string;
}

/** `listSnapshots()` data 面（本环境 succeeded snapshot ops，createdAt asc）。 */
export interface EaasSnapshotList {
  environmentId: string;
  snapshots: Array<{ snapshotId: string; createdAt: string }>;
}

/** `listServices()` data 面（gatewayUrl = 授权 gateway URL（Gate B W5 签发面）；绝不暴露 Pod IP）。 */
export interface EaasServicesProjection {
  environmentId: string;
  services: Array<{ name: string; state: string; lastCheckedAt: string | null }>;
  /** HMAC 签名的 scoped gateway URL（token 内嵌 envId/principalId/exp）；Gateway 网关服务 Gate B+ 演进。 */
  gatewayUrl: string;
}

/** `usage()` 单行（src/tenant/budget.ts UsageItem 镜像；60s 网格账本行）。 */
export interface EaasUsageItem {
  /** 60s 网格区间起点（半开 `[start, start+60s)`）。 */
  intervalStart: string;
  /** 服务端 truth 是 `string`；现知值 `warm_compute` | `environment_compute`。 */
  dimension: string;
  seconds: number;
  /** 本行定点 credits。 */
  credits: string;
  rateVersion: string;
  resourceId: string;
  environmentId?: string;
}

/** `usage()` data 面（src/tenant/budget.ts UsagePage 镜像）。 */
export interface EaasUsagePage {
  items: EaasUsageItem[];
  /** 已扫描位置（末条自增 id 的 base64url）；耗尽 → null。 */
  nextCursor: string | null;
  rateVersion: string | null;
  periodSpent: { warmCredits: string; activeCredits: string };
}


/** `billing()` 单行（src/tenant/budget.ts BillingLineItem 镜像）。 */
export interface EaasBillingLineItem {
  usageId: string;
  settlementKey: string;
  status: 'unsettled' | 'settled' | 'refunded' | (string & {});
  intervalStart: string;
  dimension: string;
  seconds: number;
  credits: string;
  rateVersion: string;
  resourceId: string;
  environmentId?: string;
}

/** `billing()` data 面（usage-derived billing projection + credit ledger join）。 */
export interface EaasBillingPage {
  items: EaasBillingLineItem[];
  nextCursor: string | null;
  totals: { credits: string; warmCredits: string; activeCredits: string };
  settlement: { mode: 'usage_source_id'; status: 'credit_ledger_joined' | (string & {}) };
}

/** `getFile()` 结果：raw bytes + `X-Eaas-File-Sha256` 响应头；失败走 envelope。 */
export type EaasFileGetResult =
  | { success: true; bytes: Uint8Array; sha256: string }
  | EaasFailEnvelope;

/** `putFile()` data 面（src/tenant/files.ts PutFileResult 镜像）。 */
export interface EaasFilePutView {
  environmentId: string;
  path: string;
  size: number;
  sha256: string;
}


/** Principal budget view returned by `POST /api/v1/sessions`. */
export interface EaasPrincipalBudgetView {
  spentCredits: string;
  remainingCredits: string | null;
  limitCredits: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface EaasIssuedSession {
  token: string;
  expiresAt: string;
  principalId: string;
  effectiveScopes: string[];
  effectiveBudget: EaasPrincipalBudgetView;
}

export interface EaasIssuedAccessSession extends EaasIssuedSession {
  sessionId: string;
  environmentId: string;
  subject: string;
}

/**
 * `POST /api/v1/sessions` request body（wire 形；server truth
 * src/tenant/sessions.ts parseIssueBody：允许字段恰为下列四个，其余未知字段
 * 一律 400 `invalid_request`；`principalId` / `environmentIds` 被显式点名拒绝）。
 * provider 判别即字段本身：`anonymous: true`（literal true——false / 字符串
 * "true" 都不是受信验证器）或 `identityToken`，二选一（两者同发 / 都缺 400）。
 */
export interface EaasIssueSessionBody {
  /** 匿名 principal（服务端随机 `prn_` sub，丢失不可找回）。 */
  anonymous?: true;
  /** 平台 unified-login access token（绑定 im_users；同身份重发找回同一 principalId）。 */
  identityToken?: string;
  /** 客户端提名的绑定 environment（服务端按 key 归属校验后固化；null/缺省 = 未绑定）。 */
  environmentId?: string;
  /** 会话 TTL 秒（整数 60..604800，缺省 86400）。 */
  ttlSeconds?: number;
}

export interface EaasIssueAccessSessionBody {
  subject: string;
  ttlSeconds?: number;
  scopes?: string[];
}

export interface EaasConversationView {
  conversationId: string;
  agentImUserId: string;
  agentName: string;
  created: boolean;
}

export interface EaasConversationListItem {
  conversationId: string;
  agentImUserId: string;
  agentName: string;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
}

export interface EaasConversationList {
  environmentId: string;
  conversations: EaasConversationListItem[];
}

/** 多模态输入块（EaaS v1 wire 子集：text | image；对齐 server 端 src/tenant/message-content.ts）。 */
export type EaasContentBlockInput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; assetId: string; mediaType: string; alt?: string };

/** HITL 回答：对某条 pending agent_question 的选项选择或自由文本。 */
export interface EaasAnswerInput {
  questionId: string;
  optionId?: string;
}

export interface EaasPrincipalMessageView {
  id: string;
  role: 'principal' | 'agent' | 'system';
  content: string;
  createdAt: string;
  kind: string | null;
  model: string | null;
  /** 消息携带的多模态块（text/image 白名单投影；无块 = null）。 */
  contentBlocks: EaasContentBlockInput[] | null;
  /** agent_question 消息的结构化提问（其他消息为 null）。 */
  question: { questionId: string; text: string; options: Array<{ id: string; label: string }> } | null;
  /** principal_answer 消息钉住的回答（其他消息为 null）。 */
  answer: { questionId: string; optionId: string | null } | null;
  spans: {
    t6: number | null;
    t7: number | null;
    t8: number | null;
    t9: number | null;
    firstTokenMs: number | null;
  } | null;
}

export interface EaasMessageList {
  conversationId: string;
  messages: EaasPrincipalMessageView[];
  truncated: boolean;
}

export interface EaasSendMessageResult {
  conversationId: string;
  messageId: string;
  runId: string;
  deduplicated: boolean;
}

/** asset 上传结果（POST /api/v1/environments/:id/assets；contentHash 去重幂等）。 */
export interface EaasAssetUploadResult {
  assetId: string;
  contentHash: string;
  sizeBytes: number;
  mediaType: string;
  deduplicated: boolean;
}

/** PI counters are engine-reported, not billing receipts. Input/cache read/cache write are disjoint. */
export interface EaasTokenObservation {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface EaasRunObservation {
  version: 1;
  runtime: {
    version: 1;
    source: 'runtime';
    sessionInitMs: number | null;
    totalMs: number;
    droppedModelCalls: number;
    modelCalls: Array<{
      sequence: number;
      source: 'pi-engine';
      provider: string;
      model: string;
      startedAt: number | null;
      durationMs: number | null;
      firstTextMs: number | null;
      status: 'completed' | 'failed' | 'canceled';
      usage: EaasTokenObservation;
    }>;
    totals: EaasTokenObservation & { cacheReadRatio: number | null; complete: boolean };
  } | null;
  runtimeMissingReason: 'not_reported' | 'invalid' | null;
  cloudSteps: Array<{ name: string; durationMs: number }>;
}

export interface EaasRunView {
  /** Absent on older Cloud, null when this run has no measured Runtime result. */
  observation?: EaasRunObservation | null;
  runId: string;
  status: 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'canceled' | 'awaiting_input' | (string & {});
  recoveryState: 'none' | 'recovering' | 'needs_review' | 'unrecoverable';
  message: { conversationId: string | null; messageId: string | null };
  artifactRefs: Array<{ artifactId: string; filename: string; contentHash: string; sizeBytes: number; mime: string }>;
  durability: { terminal: boolean; artifactsConfirmed: boolean };
  usage: { promptTokens: number | null; completionTokens: number | null };
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EaasRunCancelResult {
  runId: string;
  status: string;
}

export interface EaasRunEventPage {
  events: Array<{ id: string; type: string; at: string; message: string | null; payload: unknown }>;
  nextCursor: string | null;
  truncated: boolean;
}

/** `listArtifacts()` 单行（src/tenant/artifacts.ts EaasArtifactView 镜像）。 */
export interface EaasArtifactView {
  artifactId: string;
  filename: string;
  mime: string;
  /** sha256 hex（内容寻址；下载面 hash header 同源值）。 */
  contentHash: string;
  sizeBytes: number;
  conversationId: string;
  messageId: string;
  createdAt: string;
}

/** `listArtifacts()` data 面（scoped 到 session 直绑 env ∧ 本 principal，旧→新；limit 1..200 缺省 50）。 */
export interface EaasArtifactList {
  environmentId: string;
  artifacts: EaasArtifactView[];
  truncated: boolean;
}

/** `getArtifact()` 结果：raw bytes + `X-Eaas-Artifact-Sha256` 响应头（与列表 contentHash 同源）；失败走 envelope。 */
export type EaasArtifactGetResult =
  | { success: true; bytes: Uint8Array; sha256: string }
  | EaasFailEnvelope;

/** `listEvents()` data 面（GET /api/v1/events JSON replay；nextCursor 为 seq 字符串——uint64 走 JSON number 不安全）。 */
export interface EaasEventReplayPage {
  events: EaasEventEnvelope[];
  nextCursor: string;
  truncated: boolean;
}

// ── Tenant-private skill catalog（src/tenant/skill-catalog.ts 镜像，Gate B T8）──

/** 管理面行投影（不含 content 全文——list 面零必要不回传）。 */
export interface EaasPrivateSkillView {
  skillId: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  license: string;
  status: 'private' | 'published';
  contentManifest: Array<Record<string, unknown>> | null;
  approvalId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `get()` data 面（list 投影 + content 全文）。 */
export interface EaasPrivateSkillDetail extends EaasPrivateSkillView {
  content: string;
}

/** `list()` data 面（createdAt desc，take 200）。 */
export interface EaasPrivateSkillList {
  skills: EaasPrivateSkillView[];
}

/** `create()` body（slug/name 必填；SK-11：content 与 contentManifest 至少其一非空，metadata-only 拒 400）。 */
export interface EaasPrivateSkillCreateBody {
  slug: string;
  name: string;
  description?: string;
  content?: string;
  contentManifest?: Array<Record<string, unknown>>;
  license?: string;
}

/** `update()` body（部分更新；动 content/contentManifest 后仍须过 SK-11）。 */
export interface EaasPrivateSkillUpdateBody {
  name?: string;
  description?: string;
  content?: string;
  contentManifest?: Array<Record<string, unknown>>;
  license?: string;
}

/** `delete()` data 面。 */
export interface EaasSkillDeleteResult {
  deleted: boolean;
}

/**
 * `publish()` data 面（A2 §4.3 人类授权门）：operator 成员请求 → 202
 * `pending_approval`（owner DM 审批，skill 保持 private）；owner 本人 → 200
 * passthrough 直翻；已 published → 幂等 200。
 */
export type EaasSkillPublishResult =
  | { status: 'published'; approvalId: null; alreadyPublished: boolean }
  | { status: 'pending_approval'; approvalId: string; skillStatus: 'private' };

export interface EaasPublishableKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  projectId: string;
  scopes: string[];
  version: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface EaasCreatedPublishableKey extends EaasPublishableKeyView {
  key: string;
}

export interface EaasPublishableKeyList {
  keys: EaasPublishableKeyView[];
}

export interface EaasPublishableKeyRevokeResult {
  id: string;
  revokedAt: string;
  version: number;
}

export interface EaasPrincipalSessionView {
  id: string;
  principalId: string;
  projectId: string;
  environmentId: string | null;
  provider: 'anonymous' | 'identity' | 'delegated';
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface EaasPrincipalSessionList {
  sessions: EaasPrincipalSessionView[];
  /** Absent on older servers; null when the final page has been reached. */
  nextCursor?: string | null;
}

export interface EaasPrincipalSessionRevokeResult {
  id: string;
  revokedAt: string;
}

/**
 * Client-side wait/error carrier for `waitUntilReady()`（及 stream 连接失败）。
 * `code` 取 EAAS_ERROR_CODES 键或 `'timeout'`。
 */
export class EaasClientError extends Error {
  constructor(
    public code: EaasErrorCode | 'timeout' | (string & {}),
    message: string,
  ) {
    super(message);
    this.name = 'EaasClientError';
  }
}

/** 幂等键原语：crypto.randomUUID()（Node ≥18 / 浏览器均有全局 crypto）。 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for exotic runtimes without crypto.randomUUID.
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
/** Tenant memory API. Workspace ownership is derived by the server. */
export interface EaasMemoryWriteBody { path: string; content: string; title?: string }
export interface EaasMemoryWriteResult { workspaceId: string; path: string; acked: string[]; conflicts: unknown[] }
export interface EaasMemorySearchResult {
  workspaceId: string;
  results: Array<{ pageId: string; workspaceId: string; path: string; title: string | null; snippet: string; sectionBody?: string; score: number }>;
}
export interface EaasMemoryGrantResult {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  grantId: string | null;
  status: 'active' | 'revoked' | 'absent';
}

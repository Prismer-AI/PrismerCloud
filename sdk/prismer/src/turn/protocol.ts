/**
 * TurnEnvelopeV1 / TurnEgressV1 / TurnResultV2 — 「一次 turn」的 in-pod 文件协议
 * （Gate B+ Task 7 design §2.4；MUST-1 起出口凭据走 `egress.json`；**v2** 起工具
 * 活动走同目录的 `events.jsonl`、结果带 `tools[]` 终态汇总）。
 *
 * 形态：cloud 侧把 envelope 写进 `<turnDir>/input.json`（0600，**不含密钥**）；
 * LLM 出口凭据写进同目录的 `egress.json`（0600，**turn 作用域短 TTL token**，不是
 * owner 凭据——pod 内没有 provider key，模型调用经 cloud 的出口端点代理），本 CLI
 * 跑完一轮后把 TurnResultV2 写进 `<output.json>`，turn 进行中逐行追加
 * `events.jsonl`（0600）。投递文件**读完即删**。**stdout 不是数据通道**——引擎日志
 * 会污染它；结果只走文件。
 *
 * exit code 契约（cloud 侧 exec 包装器按此判定）：
 *   0  = output.json 已写（turn 跑完；里面可能是 status:"error"）
 *   70 = 基建失败（bundle 缺 / node 崩 / 无 output）→ 端口映射 runtime_unavailable
 *
 * 命名：`TurnEnvelopeV1` / `TurnEgressV1` 是**形态族名**（v2 未改这两个文件的字节
 * 形态，改动的是版本常量与结果面）；`TurnResultV2` 与 `ToolEventV1` 是各自形态的
 * 版本——events 文件是 v2 新引入的产物，其行 schema 即该文件的首版（V1）。
 *
 * 校验纪律与 `src/tenant/contract.ts` 同族：手写 guard，违例抛
 * `TurnProtocolError`（不静默补默认值——坏输入必须可见）。
 */

/**
 * 协议版本（唯一合法值；不匹配 = 明确拒绝，不做兼容推断）。
 *
 * v2 = 工具事件（`events.jsonl` + `result.tools[]`）。旧 bundle（常量 = 1）收到 v2
 * envelope 会在 `parseTurnEnvelope` 明确拒绝（exit 70 + 可见错误），不静默降级。
 */
import { parseAssetIngestMaintenance, parseAssetIngestResult, type AssetIngestMaintenance, type AssetIngestResult } from './maintenance.js';
import { parseTenantComponentReferences, type TenantComponentReference } from '../components/tenant-runtime.js';

export const TURN_PROTOCOL_VERSION = 2;

/** CLI exit code：output.json 已写。 */
export const TURN_EXIT_OK = 0;
/** CLI exit code：基建失败（bundle 缺、node 崩、无 output）。 */
export const TURN_EXIT_INFRA = 70;

/** output.json 的读取字节上限（cloud 侧 readFile 预算同口径）。 */
export const TURN_OUTPUT_MAX_BYTES = 256 * 1024;

/** 工具事件流文件名（turn 目录内；写侧与 cloud 轮询器共认这一个约定）。 */
export const TURN_EVENTS_FILENAME = 'events.jsonl';

/** 每 turn 事件条数上限（修6）：达限**停写**，终态由 `output.json.tools[]` 兜底。 */
export const TURN_EVENTS_MAX_COUNT = 200;

/** events.jsonl 字节上限（修6）：与条数上限各自独立生效，先到先停。 */
export const TURN_EVENTS_MAX_BYTES = 512 * 1024;

/** 摘要字段字符上限（§3.2：argsSummary / resultSummary 各 ≤500，含截断标记）。 */
export const TOOL_SUMMARY_MAX_CHARS = 500;

/** 工具事件种类（§3.2：每工具调用两条）。 */
export type ToolEventKind = 'tool_started' | 'tool_finished';

/**
 * `events.jsonl` 的一行（§3.2 逐字段）。`seq` / `at` **由写侧赋值**：hook 只上报
 * 原始测量值（`ToolEventInput`），seq 是「文件里的第几行」——由唯一写者按追加顺序
 * 赋 1-based 单调值并打 ISO 时间戳，故 seq 顺序 ≡ 行序，轮询器据此去重。
 */
export interface ToolEventV1 {
  /**
   * 1-based 单调序号（写侧赋值）。写侧达上限即**整条停写**（不跳号），故文件里恒为
   * 连续 1..N；消费方仍按「≤ 已见 seq 即重复」去重（对重放/截断天然安全）。
   */
  seq: number;
  /** 事件落盘时刻（写侧打戳，ISO）。 */
  at: string;
  kind: ToolEventKind;
  /** 工具名（read / write / edit / bash）。 */
  name: string;
  /** 入参摘要（≤500 字符，已剥凭据）。 */
  argsSummary?: string;
  /** 结果摘要（≤500 字符，已剥凭据）。 */
  resultSummary?: string;
  isError?: boolean;
  durationMs?: number;
}

/** 引擎 hook 上报的原始测量值——`seq` / `at` 归写侧（见 {@link ToolEventV1}）。 */
export type ToolEventInput = Omit<ToolEventV1, 'seq' | 'at'>;

/** 工具事件 sink（引擎 → 写侧）；**只记录不拦截**，实现必须自吞异常。 */
export type ToolEventSink = (event: ToolEventInput) => void;

/**
 * `output.json` v2 的 `tools[]` 一行（§3.2：与 events.jsonl 同源，防轮询漏读）。
 * 孤儿 started（取消 / 超时，修5）**如实呈现**：只有 `startedAt`，无 `finishedAt`，
 * 不补写、不假装成对。
 */
export interface TurnToolSummary {
  name: string;
  argsSummary?: string;
  resultSummary?: string;
  isError?: boolean;
  durationMs?: number;
  /** 该工具调用开始时刻（ISO）。 */
  startedAt: string;
  /** 该工具调用结束时刻（ISO）；缺省 = 有 started 无 finished。 */
  finishedAt?: string;
}

/** image 块：path（in-pod 绝对路径，端口边界已逐字节落盘）与 dataUrl 同时携带。 */
export interface TurnImageBlockV1 {
  kind: 'image';
  assetId: string;
  /** `inputs/<assetId>.<ext>` 的 in-pod 绝对路径——字节真相的落点。 */
  path: string;
  mediaType: string;
  /** `data:<mediaType>;base64,…`（引擎直吃；与 path 的字节一致由端口保证）。 */
  dataUrl: string;
  alt?: string;
}

export interface TurnTextBlockV1 {
  kind: 'text';
  text: string;
}

export type TurnContentBlockV1 = TurnTextBlockV1 | TurnImageBlockV1;

export interface TurnHistoryEntryV1 {
  role: 'principal' | 'agent';
  content: string;
  contentBlocks?: TurnContentBlockV1[];
}

export interface TurnToolDeclarationV1 {
  name: string;
  kind: string;
  enabled: boolean;
  version?: string;
  source?: string;
  config?: Record<string, unknown>;
}

export interface TurnEnvelopeV1 {
  /** Selection only. Trusted host resolution and live authorization are independently required. */
  tenantComponents?: TenantComponentReference[];
  maintenance?: AssetIngestMaintenance;
  protocolVersion: typeof TURN_PROTOCOL_VERSION;
  /**
   * 本轮标识。cloud 端口用触发消息 id（`im_messages.id`）——端口契约
   * （`EaasAgentTurnInput`）不含 run id，故 turnId 是不透明审计串而非 run_*。
   * 用于 turn 目录命名、结果回带，并作为出口 token 的生命周期绑定键。
   */
  turnId: string;
  message: {
    text: string;
    /** No blocks means plain text; history entries may independently include blocks. */
    contentBlocks?: TurnContentBlockV1[];
  };
  history: TurnHistoryEntryV1[];
  /** cloud 组装：base system prompt + skill 段 + HITL eaas-question 协议。 */
  systemPrompt: string;
  /**
   * cloud 声明的本 turn 工具面。缺省 = 旧 cloud / 旧 bundle 兼容路径；当前 pi-core
   * 仍按内置工具绑定执行，T6-2 起 loader 会用该字段收窄实际工具集合。
   */
  tools?: TurnToolDeclarationV1[];
  /** agent 文件工具的落地根（EAAS_FILES_ROOT）。 */
  workdir: string;
  /** 本 turn 的软预算（引擎侧）。 */
  deadlineMs: number;
  /** 取消哨兵路径——包装器每秒轮询，命中 → TERM→KILL。 */
  cancelFile: string;
}

/**
 * LLM 出口面（MUST-1）：pod 内没有 provider key——模型调用打 cloud 的出口端点，
 * 由 cloud 验 token 后用**它自己的** provider 链调上游（owner 凭据不进 pod）。
 *
 * 有序 fallback 语义随之上移：链式重试发生在 cloud 侧出口（`proxyLlmRequest` 的
 * chain walker），pod 侧只剩单一出口目标。
 */
export interface TurnEgressV1 {
  protocolVersion: typeof TURN_PROTOCOL_VERSION;
  /** OpenAI baseURL（…`/api/eaas-turn-egress/v1`；SDK 自己拼 `/chat/completions`）。 */
  url: string;
  /**
   * turn 作用域短 TTL token。**原样进 `Authorization: Bearer`**——不补 `sk-` 前缀
   * （它是 cloud 出口面的凭据，不是 NewAPI 网关 token；前缀会改变验证输入）。
   */
  token: string;
  /** 本 turn 的模型（cloud 侧已按链首解析；请求体 model 与之一致）。 */
  model: string;
  /** 归因 id（恒 `cloud-egress`：具体源在 cloud 侧解析后才知道）。 */
  provider: string;
}

export type TurnErrorCode = 'provider_unreachable' | 'capability_denied' | 'timeout' | 'internal' | 'canceled';

/** 协议层错误（坏 JSON / 缺字段 / 未知 apiMode / 版本不符）。 */
export class TurnProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnProtocolError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new TurnProtocolError(`${where}.${key} must be a non-empty string`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TurnProtocolError(`${where}.${key} must be a finite number`);
  }
  return v;
}

/**
 * 凭据形态（§3.2「绝不落 token/凭据」的通用层）：`Authorization: Bearer <token>`
 * 与 sk- 前缀网关 token。字面量密钥（出口 token = `PRISMER_PI_API_KEY`）由产生侧
 * 用 `secrets` 逐值剥掉（见 `sanitizeToolSummary` 第二层）。
 */
const CREDENTIAL_PATTERNS: Array<readonly [RegExp, string]> = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[redacted]'],
  [/\bsk-[A-Za-z0-9._-]{6,}/gi, 'sk-[redacted]'],
];

/**
 * 摘要清洗（§3.2）：剥凭据 → 压平空白 → 截断 ≤{@link TOOL_SUMMARY_MAX_CHARS} 字符。
 *
 * 截断是**含标记的硬上限**：超长值保留前 `500 - 标记长度` 个字符并以
 * `…(+N chars)` 收尾，N = 实际丢弃的字符数，整串长度恰好 500。
 * 幂等：对已清洗过的值再跑一次结果不变（写侧 / 读侧各自跑一次是防御纵深）。
 */
export function sanitizeToolSummary(text: string, secrets?: readonly string[]): string {
  let out = text;
  for (const secret of secrets ?? []) {
    // 逐值剥字面量密钥：split/join 而非正则（密钥里的正则元字符不该被解释）。
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length <= TOOL_SUMMARY_MAX_CHARS) return out;
  // 标记长度与丢弃数互相依赖（N 的位数决定头部长度、头部长度又决定 N）——迭代到
  // 稳定，保证两个不变量同时成立：整串长度 = 500，且 `head.length + N = 原长度`
  // （N 是**实际**未显示的字符数，两位数/三位数边界处也不差 1）。
  let marker = '';
  let head = out;
  for (let guard = 0; guard < 4; guard += 1) {
    const dropped = out.length - head.length;
    const next = `…(+${dropped} chars)`;
    if (next === marker) break;
    marker = next;
    head = out.slice(0, Math.max(0, TOOL_SUMMARY_MAX_CHARS - marker.length));
  }
  return `${head}${marker}`;
}

/** 入参摘要：字符串原样、其余 JSON（不可序列化 → 字面量兜底），再走清洗。 */
export function summarizeToolArgs(args: unknown, secrets?: readonly string[]): string {
  if (typeof args === 'string') return sanitizeToolSummary(args, secrets);
  if (args === undefined) return '';
  try {
    const json = JSON.stringify(args);
    return sanitizeToolSummary(json ?? String(args), secrets);
  } catch {
    // 循环引用 / BigInt 等不可序列化入参：绝不因为记事件而抛（只记录不拦截）。
    return sanitizeToolSummary(String(args), secrets);
  }
}

/** 结果摘要：取 content 里的 text 块（pi 工具结果形态），其余退化到 JSON。 */
export function summarizeToolResult(result: unknown, secrets?: readonly string[]): string {
  if (typeof result === 'string') return sanitizeToolSummary(result, secrets);
  if (isPlainObject(result) && Array.isArray(result.content)) {
    const texts = result.content
      .filter(isPlainObject)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string);
    if (texts.length > 0) return sanitizeToolSummary(texts.join('\n'), secrets);
  }
  if (result === undefined || result === null) return '';
  try {
    const json = JSON.stringify(result);
    return sanitizeToolSummary(json ?? String(result), secrets);
  } catch {
    return sanitizeToolSummary(String(result), secrets);
  }
}

/**
 * 解析 `events.jsonl` 的一行（契约对称用；cloud 轮询器负责**半行不消费**——本函数
 * 只吃完整行，空行/坏行明确失败）。摘要字段读侧再清洗一次（防御纵深）。
 */
export function parseToolEventLine(line: string): ToolEventV1 {
  const trimmed = line.trim();
  if (trimmed.length === 0) throw new TurnProtocolError('tool event line is empty');
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed) as unknown;
  } catch (err) {
    throw new TurnProtocolError(`tool event line is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(raw)) throw new TurnProtocolError('tool event must be a JSON object');
  if (raw.kind !== 'tool_started' && raw.kind !== 'tool_finished') {
    throw new TurnProtocolError("tool event kind must be 'tool_started' | 'tool_finished'");
  }
  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 1) {
    throw new TurnProtocolError('tool event seq must be a positive integer');
  }
  const event: ToolEventV1 = {
    seq: raw.seq,
    at: requireString(raw, 'at', 'toolEvent'),
    kind: raw.kind,
    name: requireString(raw, 'name', 'toolEvent'),
  };
  if (typeof raw.argsSummary === 'string') event.argsSummary = sanitizeToolSummary(raw.argsSummary);
  if (typeof raw.resultSummary === 'string') event.resultSummary = sanitizeToolSummary(raw.resultSummary);
  if (typeof raw.isError === 'boolean') event.isError = raw.isError;
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) event.durationMs = raw.durationMs;
  return event;
}

/** `result.tools[]` 一行（读侧白名单投影 + 摘要再清洗）。 */
function parseToolSummary(raw: unknown, index: number): TurnToolSummary {
  const where = `result.tools[${index}]`;
  if (!isPlainObject(raw)) throw new TurnProtocolError(`${where} must be an object`);
  const summary: TurnToolSummary = {
    name: requireString(raw, 'name', where),
    startedAt: requireString(raw, 'startedAt', where),
  };
  if (typeof raw.argsSummary === 'string') summary.argsSummary = sanitizeToolSummary(raw.argsSummary);
  if (typeof raw.resultSummary === 'string') summary.resultSummary = sanitizeToolSummary(raw.resultSummary);
  if (typeof raw.isError === 'boolean') summary.isError = raw.isError;
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) summary.durationMs = raw.durationMs;
  if (typeof raw.finishedAt === 'string') summary.finishedAt = raw.finishedAt;
  return summary;
}

export interface TurnResultV2 {
  maintenanceResult?: AssetIngestResult;
  protocolVersion: typeof TURN_PROTOCOL_VERSION;
  turnId: string;
  /** canceled = 包装器命中取消哨兵后写下（引擎被 TERM/KILL，无回复）。 */
  status: 'ok' | 'error' | 'canceled';
  replyText?: string;
  usage?: { promptTokens: number | null; completionTokens: number | null };
  /** t7 = provider 请求发出；t8 = 首个非空可呈现 delta（无则 null）。 */
  spans?: { t7: number | null; t8: number | null };
  engine?: { adapter: string; version: string; model: string };
  providerSource?: string | null;
  error?: { code: TurnErrorCode; message: string };
  /**
   * 工具调用终态汇总（v2 新增；与 `events.jsonl` 同源）。缺省 = 本轮没有工具调用
   * （不是「有工具但没记上」——events 写失败时这里同样有空隙，见 §5 失败矩阵）。
   */
  tools?: TurnToolSummary[];
}

export const TURN_MAX_HISTORY_MESSAGES = 12;
export const TURN_MAX_IMAGES = 4;
export const TURN_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function parseContentBlock(raw: unknown, index: number): TurnContentBlockV1 {
  const where = `message.contentBlocks[${index}]`;
  if (!isPlainObject(raw)) throw new TurnProtocolError(`${where} must be an object`);
  if (raw.kind === 'text') {
    return { kind: 'text', text: requireString(raw, 'text', where) };
  }
  if (raw.kind === 'image') {
    const block: TurnImageBlockV1 = {
      kind: 'image',
      assetId: requireString(raw, 'assetId', where),
      path: requireString(raw, 'path', where),
      mediaType: requireString(raw, 'mediaType', where),
      dataUrl: requireString(raw, 'dataUrl', where),
    };
    if (block.dataUrl.length > Math.ceil(TURN_MAX_IMAGE_BYTES / 3) * 4 + 128) {
      throw new TurnProtocolError(`${where} exceeds image byte budget`);
    }
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(block.dataUrl);
    const encoded = match?.[2];
    if (!encoded || match?.[1] !== block.mediaType || encoded.length % 4 !== 0) {
      throw new TurnProtocolError(`${where} has invalid image data`);
    }
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.length / 4 * 3 - padding > TURN_MAX_IMAGE_BYTES) {
      throw new TurnProtocolError(`${where} exceeds image byte budget`);
    }
    if (typeof raw.alt === 'string') block.alt = raw.alt;
    return block;
  }
  throw new TurnProtocolError(`${where}.kind must be 'text' | 'image'`);
}

function parseToolDeclaration(raw: unknown, index: number): TurnToolDeclarationV1 {
  const where = `tools[${index}]`;
  if (!isPlainObject(raw)) throw new TurnProtocolError(`${where} must be an object`);
  if (raw.kind === 'tenant-component' && (
    typeof raw.enabled !== 'boolean' ||
    typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.name) ||
    Object.keys(raw).some(key => !['name', 'kind', 'enabled'].includes(key))
  )) throw new TurnProtocolError(`${where} invalid tenant tool declaration`);
  const declaration: TurnToolDeclarationV1 = {
    name: requireString(raw, 'name', where),
    kind: requireString(raw, 'kind', where),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
  };
  if (typeof raw.version === 'string') declaration.version = raw.version;
  if (typeof raw.source === 'string') declaration.source = raw.source;
  if (isPlainObject(raw.config)) declaration.config = raw.config;
  return declaration;
}

function parseEgress(raw: unknown): TurnEgressV1 {
  const where = 'egress';
  if (!isPlainObject(raw)) throw new TurnProtocolError('turn egress must be a JSON object');
  if (raw.protocolVersion !== TURN_PROTOCOL_VERSION) {
    throw new TurnProtocolError(
      `unsupported egress protocolVersion ${String(raw.protocolVersion)} (this runtime speaks ${TURN_PROTOCOL_VERSION})`,
    );
  }
  return {
    protocolVersion: TURN_PROTOCOL_VERSION,
    url: requireString(raw, 'url', where),
    token: requireString(raw, 'token', where),
    model: requireString(raw, 'model', where),
    provider: requireString(raw, 'provider', where),
  };
}

/** 校验并归一 egress.json（违例 → TurnProtocolError）。 */
export function parseTurnEgress(raw: unknown): TurnEgressV1 {
  return parseEgress(raw);
}

/** 校验并归一 input.json（违例 → TurnProtocolError）。 */
export function parseTurnEnvelope(raw: unknown): TurnEnvelopeV1 {
  if (!isPlainObject(raw)) throw new TurnProtocolError('turn envelope must be a JSON object');
  if (raw.protocolVersion !== TURN_PROTOCOL_VERSION) {
    throw new TurnProtocolError(
      `unsupported protocolVersion ${String(raw.protocolVersion)} (this runtime speaks ${TURN_PROTOCOL_VERSION})`,
    );
  }
  // 版本偏斜探针：provider 链块属于 MUST-1 之前的协议（云侧凭据进 pod 的旧形态）。
  // 收到它 = cloud 比 bundle 旧——明确拒绝而不是静默忽略（否则会在缺 egress.json 上
  // 以一个不相干的错误收场，真因被埋掉）。
  if (raw.providers !== undefined) {
    throw new TurnProtocolError(
      'envelope carries a legacy providers[] block (pre-egress protocol); the cloud side must be upgraded',
    );
  }
  const message = raw.message;
  if (!isPlainObject(message)) throw new TurnProtocolError('message must be an object');
  const text = typeof message.text === 'string' ? message.text : '';
  const envelope: TurnEnvelopeV1 = {
    protocolVersion: TURN_PROTOCOL_VERSION,
    turnId: requireString(raw, 'turnId', 'envelope'),
    message: { text },
    history: [],
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    workdir: requireString(raw, 'workdir', 'envelope'),
    deadlineMs: requireNumber(raw, 'deadlineMs', 'envelope'),
    cancelFile: requireString(raw, 'cancelFile', 'envelope'),
  };
  if (message.contentBlocks !== undefined) {
    if (!Array.isArray(message.contentBlocks)) throw new TurnProtocolError('message.contentBlocks must be an array');
    envelope.message.contentBlocks = message.contentBlocks.map(parseContentBlock);
  }
  if (raw.history !== undefined) {
    if (!Array.isArray(raw.history)) throw new TurnProtocolError('history must be an array');
    if (raw.history.length > TURN_MAX_HISTORY_MESSAGES) throw new TurnProtocolError('turn exceeds history window');
    envelope.history = raw.history.map((entry, i) => {
      const where = `history[${i}]`;
      if (!isPlainObject(entry)) throw new TurnProtocolError(`${where} must be an object`);
      const role = requireString(entry, 'role', where);
      if (role !== 'principal' && role !== 'agent') throw new TurnProtocolError(`${where}.role must be 'principal' | 'agent'`);
      if (entry.contentBlocks !== undefined && !Array.isArray(entry.contentBlocks))
        throw new TurnProtocolError(`${where}.contentBlocks must be an array`);
      return {
        role, content: typeof entry.content === 'string' ? entry.content : '',
        ...(Array.isArray(entry.contentBlocks) ? { contentBlocks: entry.contentBlocks.map(parseContentBlock) } : {}),
      };
    });
  }
  const images = [...envelope.history.flatMap(entry => entry.contentBlocks ?? []), ...(envelope.message.contentBlocks ?? [])].filter(block => block.kind === 'image');
  if (images.length > TURN_MAX_IMAGES) throw new TurnProtocolError('turn exceeds aggregate image budget');
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new TurnProtocolError('tools must be an array');
    envelope.tools = raw.tools.map(parseToolDeclaration);
  }
  if (raw.tenantComponents !== undefined) {
    try { envelope.tenantComponents = parseTenantComponentReferences(raw.tenantComponents); }
    catch { throw new TurnProtocolError('tenant component selection invalid'); }
  }
  if (raw.maintenance !== undefined) {
    envelope.maintenance = parseAssetIngestMaintenance(raw.maintenance, envelope.turnId);
    if (envelope.history.length || envelope.message.text || envelope.message.contentBlocks?.length || envelope.tools?.length || envelope.tenantComponents?.length) {
      throw new TurnProtocolError('maintenance cannot carry chat history, message content or tool grants');
    }
  }
  return envelope;
}

/**
 * 读回 output.json 的白名单投影（缺字段按缺省；坏形态 → TurnProtocolError）。
 * 摘要字段读侧再清洗一次（防御纵深，同 {@link parseToolEventLine}）。
 */
export function parseTurnResult(raw: unknown): TurnResultV2 {
  if (!isPlainObject(raw)) throw new TurnProtocolError('turn result must be a JSON object');
  if (raw.protocolVersion === 1) {
    // 版本偏斜探针（同 envelope 的 providers[] 先例）：v1 结果 = 写入方是 pre-v2
    // runtime（那里没有 tools[] 与 events.jsonl）。明确拒绝，不静默按 v2 读。
    throw new TurnProtocolError(
      'v1 result rejected: the writer is a pre-v2 runtime (no tools[] / events.jsonl there); this runtime speaks 2',
    );
  }
  if (raw.protocolVersion !== TURN_PROTOCOL_VERSION) {
    throw new TurnProtocolError(
      `unsupported result protocolVersion ${String(raw.protocolVersion)} (this runtime speaks ${TURN_PROTOCOL_VERSION})`,
    );
  }
  const status = raw.status;
  if (status !== 'ok' && status !== 'error' && status !== 'canceled') {
    throw new TurnProtocolError("result.status must be 'ok' | 'error' | 'canceled'");
  }
  const result: TurnResultV2 = {
    protocolVersion: TURN_PROTOCOL_VERSION,
    turnId: requireString(raw, 'turnId', 'result'),
    status,
  };
  if (raw.maintenanceResult !== undefined) {
    if (status !== 'ok') throw new TurnProtocolError('failed maintenance cannot publish products');
    result.maintenanceResult = parseAssetIngestResult(raw.maintenanceResult, result.turnId);
  }
  if (typeof raw.replyText === 'string') result.replyText = raw.replyText;
  const usage = raw.usage;
  if (isPlainObject(usage)) {
    result.usage = {
      promptTokens: typeof usage.promptTokens === 'number' ? usage.promptTokens : null,
      completionTokens: typeof usage.completionTokens === 'number' ? usage.completionTokens : null,
    };
  }
  const spans = raw.spans;
  if (isPlainObject(spans)) {
    result.spans = {
      t7: typeof spans.t7 === 'number' ? spans.t7 : null,
      t8: typeof spans.t8 === 'number' ? spans.t8 : null,
    };
  }
  const engine = raw.engine;
  if (isPlainObject(engine) && typeof engine.adapter === 'string') {
    result.engine = {
      adapter: engine.adapter,
      version: typeof engine.version === 'string' ? engine.version : '',
      model: typeof engine.model === 'string' ? engine.model : '',
    };
  }
  if (typeof raw.providerSource === 'string' || raw.providerSource === null) {
    result.providerSource = raw.providerSource ?? null;
  }
  const tools = raw.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new TurnProtocolError('result.tools must be an array');
    result.tools = tools.map(parseToolSummary);
  }
  const error = raw.error;
  if (isPlainObject(error)) {
    const code = typeof error.code === 'string' ? error.code : 'internal';
    result.error = {
      code: (['provider_unreachable', 'capability_denied', 'timeout', 'internal', 'canceled'] as const).includes(
        code as TurnErrorCode,
      )
        ? (code as TurnErrorCode)
        : 'internal',
      // 上游错误体不进结果文件（只留 ≤500 字符的单行摘要）。
      message: typeof error.message === 'string' ? collapseErrorMessage(error.message) : '',
    };
  }
  return result;
}

/**
 * `task_result` 契约：错误文本一律 ≤500 字符（与 §2.4 的 `error.message ≤500` 同口径），
 * 且不含换行——provider 的原始 body 可能带完整 HTML/JSON。
 */
export function collapseErrorMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

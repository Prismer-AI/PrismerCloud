/**
 * adapter.ts — 真实数据 → AgentMessageModel 纯函数 adapter（release201/32 §3.1 · P1）。
 *
 * SoT design: docs/release201/32-unified-agent-message-component.md §3.1（事件流真实字段表）。
 *
 * P0 把 <AgentMessage> 建成 mock-first（见 mock.ts）。P1（本文件）把真实
 * 三路数据喂给同一个渲染契约：
 *   1. IM message（content / contentBlocks / attachments / metadata）→ body / reasoning / attachments / mentions
 *   2. task timeline（ActivityTimelineStep.payloadJson）→ ActivityStep[]（解码）
 *   3. run 聚合 → RunMetrics + current + state
 *
 * ⚠️ 真实数据脏：`payloadJson` 形状不确定（string / object / null），`kind` 既可能是
 * §3.1 理想表里的 `tool`/`reasoning`，也可能是 inline-activity-strip 实际消费的
 * `tool_call` / `tool_result` / `reasoning_chunk` / `phase_change` / `progress` / `error`。
 * 解码全程防御性，归一到 types.ts 的 ActivityStepKind('tool'|'reasoning') + event。
 *
 * 纯函数 · 无 React · 无副作用。容器化在 AgentMessageContainer.tsx。
 */

import type { ActivityTimelineStep } from '../../lib/sync-api';
import { parseContentBlocks } from '../content-blocks/types';
import type {
  ActivityStep,
  AgentMessageModel,
  AgentMessageState,
  LinkedTask,
  MessageAsset,
  MessageSender,
  RunMetrics,
} from './types';

// ─── 最小化输入契约 ───────────────────────────────────────────────────────
// im-channel 的 MessageDTO 不 export（内部类型），这里声明一个结构兼容的
// 子集。字段名 mirror MessageDTO（im-channel.tsx:251）+ MessageAttachmentDTO
// （mutations.ts:264），保证 adapter 调用方可以直接把 message 传进来。

export interface AdapterAttachmentInput {
  assetId: string;
  filename?: string | null;
  title?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
}

export interface AdapterMessageInput {
  id: string;
  content?: string | null;
  /** 既可能是 parsed array，也可能是 JSON string，也可能 null（parseContentBlocks 三态）。 */
  contentBlocks?: unknown;
  contentBlocksJson?: unknown;
  /** string（JSON）或已 parse 的 object 或 undefined。 */
  metadata?: string | Record<string, unknown> | null;
  attachments?: AdapterAttachmentInput[] | null;
  createdAt?: string | null;
  streaming?: boolean;
}

// ─── payloadJson 防御性读取（照抄 inline-activity-strip 的三态处理思路） ──────

function asObject(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/** payloadJson 可能是 string(JSON) / object / null —— 归一成 object 再读。 */
function coercePayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return asObject(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return asObject(payload);
}

function readString(obj: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function readNumber(obj: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** 嵌套对象（如 payload.input / payload.args / payload.result）。 */
function readNestedObject(obj: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown> | null {
  if (!obj) return null;
  for (const k of keys) {
    const nested = asObject(obj[k]);
    if (nested) return nested;
  }
  return null;
}

// ─── 工具内容提取（真实 payload 形状，DB code-verified 2026-06-01） ─────────
// tool_call.payloadJson = { toolName, toolCallId, inputSummary } —— 没有 `input`
// 对象；`inputSummary` 是把入参 JSON.stringify 后**截断**的字符串，尾部带
// `…(+N chars)`。直接 JSON.parse 会因截断失败（正是「显示一坨 raw JSON」的根因）。
// 所以这里用「扫描式」按 key 抽值——即使被截断也能取到 command / code / path。

/** 去掉截断尾标 `…(+N chars)` / 末尾省略号。 */
function stripTruncation(s: string): string {
  return s
    .replace(/…\s*\(\+\s*\d+\s*chars?\)\s*$/i, '')
    .replace(/…+\s*$/, '')
    .trimEnd();
}

/** JSON 转义字符串还原（\n \t \" \\）。 */
function unescapeJsonish(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * 从（可能截断的）JSON-ish 串里抓 `"key":"..."` 的值。手写扫描而非 JSON.parse，
 * 截断也能取：找到 key→冒号→开引号，逐字读到未转义的闭引号（没有则读到末尾）。
 */
function scanStringValue(raw: string, key: string): string | null {
  const marker = `"${key}"`;
  const at = raw.indexOf(marker);
  if (at < 0) return null;
  let j = raw.indexOf(':', at + marker.length);
  if (j < 0) return null;
  j += 1;
  while (j < raw.length && /\s/.test(raw[j])) j += 1;
  if (raw[j] !== '"') return null; // 非字符串值
  j += 1;
  let out = '';
  while (j < raw.length) {
    const ch = raw[j];
    if (ch === '\\') {
      out += ch + (raw[j + 1] ?? '');
      j += 2;
      continue;
    }
    if (ch === '"') break; // 闭引号
    out += ch;
    j += 1;
  }
  return unescapeJsonish(out);
}

/** 首行 + 截断到 ~96 字（命令/路径/url 用）。 */
function firstLineClamp(s: string, max = 96): string {
  const line =
    s
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? s.trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** code 压成一行摘要：首个非空行 + 行数。 */
function codeSummary(code: string): string {
  const lines = code.split('\n');
  const head = firstLineClamp(code, 64);
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  return nonEmpty > 1 ? `${head}  (+${nonEmpty - 1} 行)` : head;
}

/** toolName → 该工具「实际内容」对应的入参 key 优先级。 */
const TOOL_CONTENT_KEYS: Record<string, string[]> = {
  terminal: ['command', 'cmd'],
  bash: ['command', 'cmd'],
  shell: ['command', 'cmd'],
  execute_code: ['code'],
  write_file: ['path', 'file', 'filePath'],
  edit_file: ['path', 'file', 'filePath'],
  read_file: ['path', 'file', 'filePath'],
  search_files: ['pattern', 'query'],
  grep: ['pattern', 'query'],
  browser_navigate: ['url'],
  fetch: ['url'],
  delegate_task: ['goal', 'title'],
  todo: [],
};

const CODE_CONTENT_TOOLS = new Set(['execute_code']);

/**
 * 抽「这步实际做了什么」当一行摘要。先从 inputSummary（截断 JSON 串）按 toolName
 * 扫 key；抽不到再走 result（命中数/退出码）；都没有返回 null。
 */
function extractToolContent(tool: string | undefined, payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;

  const raw = readString(payload, 'inputSummary', 'summary', 'preview');
  if (raw) {
    const cleaned = stripTruncation(raw);
    const keys = (tool && TOOL_CONTENT_KEYS[tool]) ?? [
      'command',
      'code',
      'path',
      'url',
      'query',
      'pattern',
      'goal',
      'name',
    ];
    for (const k of keys) {
      const v = scanStringValue(cleaned, k);
      if (v && v.trim()) {
        return k === 'code' || (tool && CODE_CONTENT_TOOLS.has(tool)) ? codeSummary(v) : firstLineClamp(v);
      }
    }
    // 不是 JSON-ish（不以 { 开头）→ 当人读摘要直接用；是 JSON 但抽不到已知 key → 不回吐 raw
    if (!cleaned.startsWith('{')) return firstLineClamp(cleaned);
  }

  // result 摘要（命中数 / 退出码 / 状态）
  const result = readNestedObject(payload, 'result', 'output');
  if (result) {
    const hits = readNumber(result, 'count', 'matches', 'hits');
    if (hits != null) return `命中 ${hits}`;
    const exitCode = readNumber(result, 'exitCode', 'code', 'status');
    if (exitCode != null) return `退出码 ${exitCode}`;
    const resStr = readString(result, 'summary', 'message', 'text');
    if (resStr) return firstLineClamp(resStr);
  }

  return null;
}

// ─── kind 归一 ───────────────────────────────────────────────────────────
// §3.1 理想表：kind ∈ {tool, reasoning}；真实 inline-activity-strip 消费的
// kind ∈ {tool_call, tool_result, reasoning_chunk, phase_change, progress, error}。
// 把后者归一到前者 + event（started/completed）。phase_change/progress/error
// 没有独立 ActivityStepKind，按语义归类：
//   - phase_change → reasoning（阶段叙述，无 tool）
//   - progress     → 上一条同语义，但本身归 tool（进度多伴随 tool 执行）
//   - error        → tool + completed（带错误摘要）

interface NormalizedKind {
  kind: ActivityStep['kind'];
  event?: ActivityStep['event'];
}

/** daemon phase 名 → 本地化标签（时间线阶段分隔用）。未知 phase 原样返回。 */
const PHASE_LABEL: Record<string, string> = {
  assigned: '已接收',
  thinking: '思考中',
  reasoning: '推理',
  tool_use: '调用工具',
  responding: '响应中',
  waiting_user: '等待用户',
  waiting_dep: '等待依赖',
  stuck: '受阻',
};

function phaseLabel(phase: string | null): string | undefined {
  if (!phase) return undefined;
  return PHASE_LABEL[phase] ?? phase;
}

function normalizeKind(rawKind: string, payload: Record<string, unknown> | null): NormalizedKind {
  switch (rawKind) {
    case 'tool':
    case 'tool_call':
    case 'tool_use': {
      // event 可能在 payload 里显式给（tool.started/tool.completed），
      // 否则按是否带 result 推断。
      const ev = readString(payload, 'event');
      if (ev === 'tool.started' || ev === 'tool.completed') return { kind: 'tool', event: ev };
      const hasResult = readNestedObject(payload, 'result', 'output') != null;
      return { kind: 'tool', event: hasResult ? 'tool.completed' : 'tool.started' };
    }
    case 'tool_result':
      return { kind: 'tool', event: 'tool.completed' };
    case 'reasoning':
    case 'reasoning_chunk':
      return { kind: 'reasoning' };
    case 'phase_change':
      return { kind: 'reasoning' };
    case 'progress':
      return { kind: 'tool' };
    case 'error':
      return { kind: 'tool', event: 'tool.completed' };
    default:
      // 未知 kind：保守归 tool（不丢，但不假定 reasoning）。
      return { kind: 'tool' };
  }
}

/**
 * decodeTimelineStep — 把 opaque ActivityTimelineStep 解码成 ActivityStep。
 *
 * 抽 event / tool / progress / actor / summary / reasoningText，原始 payloadJson
 * 原样带上（供 ▶ payload 披露 + 调试）。全程防御性。
 */
export function decodeTimelineStep(step: ActivityTimelineStep): ActivityStep {
  const payload = coercePayload(step.payloadJson);
  const { kind, event } = normalizeKind(step.kind, payload);

  // tool name: prefer explicit payload fields. Do NOT fall back to the raw
  // step.kind ('tool'/'tool_result' → generic 'tool'), which produced the
  // "Tool · tool" rows that never paired with their started sibling. Leave
  // undefined when unknown; ActivityDetail inherits the name from the paired
  // started row via toolCallId.
  const tool = readString(payload, 'tool', 'toolName', 'name') ?? undefined;

  // Stable pairing key. Real wire shape (inline-activity-strip verified): a
  // `tool_result` carries `toolCallSeq` pointing at its `tool_call`'s seq —
  // NOT a shared string id. So started keys on its own seq, completed keys on
  // the referenced seq; they meet at `seq:<n>`. Explicit toolCallId (if a
  // daemon ever emits one) still wins.
  const toolCallSeq = readNumber(payload, 'toolCallSeq');
  const explicitCallId = readString(payload, 'toolCallId', 'tool_call_id', 'callId');
  const toolCallId =
    explicitCallId ??
    (event === 'tool.completed' && toolCallSeq != null
      ? `seq:${toolCallSeq}`
      : event === 'tool.started'
        ? `seq:${step.seq}`
        : undefined);

  // progress：>1 视为百分比直给，<=1 视为比例 ×100（对齐 inline-activity-strip ProgressBar）。
  const rawProgress = readNumber(payload, 'progress', 'percent');
  const progress =
    rawProgress == null
      ? undefined
      : rawProgress > 1
        ? Math.min(100, Math.max(0, rawProgress))
        : Math.min(100, Math.max(0, rawProgress * 100));

  const actor = readString(payload, 'actor', 'daemonId', 'agentId') ?? undefined;

  // reasoning 文本只来自**真正的** reasoning / reasoning_chunk(有实际 text/content）。
  // phase_change 是阶段转换(thinking → running → tool_call)——其 `phase` 名不是
  // reasoning 内容。之前误把 phase 名当文本回退,导致 thinking 显示成
  // "thinking running tool_call tool_call…" 一串重复 phase 名(用户实测 bug）。
  const reasoningText =
    step.kind === 'reasoning' || step.kind === 'reasoning_chunk'
      ? (readString(payload, 'text', 'content', 'reasoning') ?? undefined)
      : undefined;

  // error 行：错误信息进 summary;phase_change：phase 名进 summary(时间线行的
  // 标签,而非 thinking 内容),保持时间线行有意义又不污染 thinking。
  const errorMsg = step.kind === 'error' ? readString(payload, 'message', 'error') : null;
  // phase_change 不进 summary（阶段标签不是「实际内容」）。
  const summary = errorMsg ?? extractToolContent(tool, payload) ?? undefined;

  // phase_change → 本地化阶段标签（思考中/调用工具/响应中…），渲染成时间线分隔，
  // 保留执行可见性；不再错标成空 Reasoning 行。
  const phase = step.kind === 'phase_change' ? phaseLabel(readString(payload, 'phase')) : undefined;

  return {
    id: step.id || String(step.seq),
    seq: step.seq,
    kind,
    event,
    toolCallId,
    tool,
    progress: progress ?? undefined,
    actor,
    summary,
    reasoningText: reasoningText ?? undefined,
    phase: phase ?? undefined,
    payloadJson: step.payloadJson,
    occurredAt: step.occurredAt,
    durationMs: step.durationMs,
  };
}

// ─── 指标聚合 ─────────────────────────────────────────────────────────────

export interface AggregateMetricsOptions {
  /** run 级 token 聚合 —— P4 后端缺口（§3.1 #5），P0/P1 由调用方传入或 0。 */
  tokens?: number;
  /** 附件数（从 message.attachments.length 传入，timeline 不含附件）。 */
  files?: number;
}

/**
 * aggregateMetrics — steps → RunMetrics。
 *   - steps：completed 计数（tool.completed 数；非 tool 行不计步）。
 *   - elapsedMs：优先累加各 step.durationMs；都缺则取首末 occurredAt 差。
 *   - files：opts.files（附件数），timeline 不带附件。
 *   - tokens：opts.tokens ?? 0（⚠️ P4 后端 run 级聚合缺口，§3.1 #5）。
 */
export function aggregateMetrics(steps: ActivityStep[], opts: AggregateMetricsOptions = {}): RunMetrics {
  let completed = 0;
  let durationSum = 0;
  let hasDuration = false;

  for (const s of steps) {
    if (s.kind === 'tool' && s.event === 'tool.completed') completed += 1;
    if (typeof s.durationMs === 'number' && Number.isFinite(s.durationMs)) {
      durationSum += s.durationMs;
      hasDuration = true;
    }
  }

  let elapsedMs = hasDuration ? durationSum : 0;
  if (!hasDuration && steps.length >= 2) {
    const first = Date.parse(steps[0].occurredAt);
    const last = Date.parse(steps[steps.length - 1].occurredAt);
    if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
      elapsedMs = last - first;
    }
  }

  return {
    steps: completed,
    tokens: opts.tokens ?? 0, // P4 后端 run 级 token 聚合缺口
    elapsedMs,
    files: opts.files ?? 0,
  };
}

// ─── 当前动作（status-card headline） ────────────────────────────────────

/**
 * deriveCurrent — 最近一条 step → current（semantic kind + tool + 内容摘要）。
 *
 * 不再返回 emoji icon 或假进度——daemon 只报 start/complete 两态，没有真实
 * 0..100 progress（见 doc 32 §3.1 #5）。kind 驱动 phase label + glow 色，
 * tool 驱动 lucide 图标（toolGlyph），summary 是该步的实际内容（命令 / 路径 /
 * url），由 extractSummary 从 payload 抽出，取代旧的 payload JSON 展示。
 */
export function deriveCurrent(steps: ActivityStep[]): AgentMessageModel['current'] {
  if (steps.length === 0) return undefined;
  const last = steps[steps.length - 1];

  if (last.kind === 'reasoning') {
    return {
      kind: 'reasoning',
      title: '思考',
      summary: last.reasoningText ?? last.summary ?? undefined,
    };
  }

  // tool 名可能缺（completed 泛态）——反向找最近一条带 tool 名的同 call step。
  let tool = last.tool;
  if (!tool && last.toolCallId) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].toolCallId === last.toolCallId && steps[i].tool) {
        tool = steps[i].tool;
        break;
      }
    }
  }

  return {
    kind: 'tool',
    tool,
    title: tool ?? '执行工具',
    summary: last.summary ?? undefined,
  };
}

// ─── 状态机映射 ───────────────────────────────────────────────────────────

export interface DeriveStateArgs {
  /** 最终回复 body 是否已落地（非空）。 */
  hasReply: boolean;
  /** 仍在流式输出。 */
  streaming?: boolean;
  /** task 已进 terminal phase（done/completed/failed/cancelled）。 */
  terminalPhase?: boolean;
  /** 等待人审（approval）—— sticky，优先级最高。 */
  awaitingApproval?: boolean;
  /** 执行失败。 */
  failed?: boolean;
}

/**
 * deriveState — 五态映射（types.ts AgentMessageState）。
 * 优先级：failed > needs-action > running(streaming) > done(hasReply) > received。
 */
export function deriveState(args: DeriveStateArgs): AgentMessageState {
  if (args.failed) return 'failed';
  if (args.awaitingApproval) return 'needs-action';
  if (args.streaming) return 'running';
  if (args.hasReply || args.terminalPhase) return 'done';
  return 'received';
}

// ─── 正文 / reasoning / 附件 / mentions 抽取 ────────────────────────────────

/** 从 message.content 或 ContentBlock text 块抽正文。 */
function extractBody(message: AdapterMessageInput): string {
  if (typeof message.content === 'string' && message.content.trim()) return message.content;
  const blocks = parseContentBlocks(message.contentBlocks ?? message.contentBlocksJson ?? null);
  if (!blocks) return '';
  return blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * 从 ContentBlock reasoning 块 + reasoning steps 抽 thinking 文本。
 * ContentBlock reasoning 优先（更完整）；timeline reasoning 行兜底。
 */
function extractReasoning(message: AdapterMessageInput, steps: ActivityStep[]): string | undefined {
  const blocks = parseContentBlocks(message.contentBlocks ?? message.contentBlocksJson ?? null);
  if (blocks) {
    const reasoning = blocks
      .filter((b): b is { kind: 'reasoning'; text: string; redacted?: boolean } => b.kind === 'reasoning')
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n')
      .trim();
    if (reasoning) return reasoning;
  }
  const fromSteps = steps
    .filter((s) => s.kind === 'reasoning' && s.reasoningText)
    .map((s) => s.reasoningText as string)
    .join('\n')
    .trim();
  return fromSteps || undefined;
}

/** message.attachments → MessageAsset[]（字段重映射）。 */
function extractAttachments(message: AdapterMessageInput): MessageAsset[] {
  const list = Array.isArray(message.attachments) ? message.attachments : [];
  return list.map((a) => ({
    id: a.assetId,
    mime: a.mime ?? null,
    sizeBytes: a.sizeBytes ?? null,
    filename: a.filename ?? a.title ?? null,
    thumbnailUrl: a.thumbnailUrl ?? null,
    previewUrls: a.previewUrls ?? null,
  }));
}

/** 从正文里正则抽 @mention（去重，保留出现顺序）。 */
function extractMentions(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Allow `-`/`.` so hyphenated usernames (custom-role-x) match the body chip;
  // lookbehind skips emails / mid-word `@`.
  const re = /(?<![A-Za-z0-9])@([A-Za-z0-9._-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────

export interface MessageToModelArgs {
  message: AdapterMessageInput;
  /** 已解码的 timeline steps（容器用 decodeTimelineStep 解码后传入）。 */
  steps: ActivityStep[];
  sender: MessageSender;
  /** 关联 kanban task（可选）。 */
  task?: LinkedTask;
  /** 等待人审。 */
  awaitingApproval?: boolean;
  /** 执行失败。 */
  failed?: boolean;
  /** task 已进 terminal phase。 */
  terminalPhase?: boolean;
  /** run 级 token（P0/P1 调用方给或缺省 0 —— §3.1 #5 后端缺口）。 */
  tokens?: number;
  /** @-mention 责任链（hopCount fan-out，ws/handler.ts:2042）。 */
  mentionChain?: string[];
}

/**
 * messageToModel — 真实数据组装入口。把 IM message + 解码后 steps + 身份/状态
 * 组装成完整 AgentMessageModel，直接喂 <AgentMessage>。
 *
 * 人类消息（sender.isAgent === false）走 'human' 子集（无 status-card / steps / metrics）。
 */
export function messageToModel(args: MessageToModelArgs): AgentMessageModel {
  const { message, steps, sender, task, mentionChain } = args;

  const body = extractBody(message);
  const attachments = extractAttachments(message);
  const mentions = extractMentions(body);
  const createdAt = message.createdAt ?? new Date().toISOString();
  // v2.0 §4.6 多模态：解码 ContentBlock[]（parseContentBlocks 吃 array/JSON-string/null）。
  const contentBlocks = parseContentBlocks(message.contentBlocks ?? message.contentBlocksJson);

  // 人类消息：trimmed subset。
  if (!sender.isAgent) {
    return {
      id: message.id,
      sender,
      state: 'human',
      createdAt,
      body,
      contentBlocks,
      attachments,
      steps: [],
      metrics: { steps: 0, tokens: 0, elapsedMs: 0, files: 0 },
      mentions: mentions.length ? mentions : undefined,
    };
  }

  const hasReply = body.trim().length > 0 || attachments.length > 0;
  const state = deriveState({
    hasReply,
    streaming: message.streaming,
    terminalPhase: args.terminalPhase,
    awaitingApproval: args.awaitingApproval,
    failed: args.failed,
  });

  const reasoning = extractReasoning(message, steps);
  const metrics = aggregateMetrics(steps, { tokens: args.tokens, files: attachments.length });
  const current = state === 'done' ? undefined : deriveCurrent(steps);

  return {
    id: message.id,
    sender,
    state,
    createdAt,
    body,
    contentBlocks,
    attachments,
    reasoning,
    steps,
    metrics,
    task,
    current,
    mentions: mentions.length ? mentions : undefined,
    mentionChain: mentionChain && mentionChain.length ? mentionChain : undefined,
  };
}

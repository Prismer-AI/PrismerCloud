/**
 * `turn run` 的执行体 —— 在环境内跑**一轮** agent 对话并把结果落 output.json
 * （Gate B+ Task 7 design §1.1 候选 (c)：每 turn 一个一次性进程）。
 *
 * 形态纪律：
 *   - 无状态、无端口：进程内建 pi-core agent，跑一轮后写结果文件退出；
 *   - 不碰 daemon 的 PRISMER_HOME 状态（不用 local.db/outbox）；
 *   - **pod 内没有 provider 凭据**（MUST-1）：模型调用打 cloud 的出口端点
 *     （`egress.json` 的 `{url, token, model, provider}`），token 是 turn 作用域
 *     短 TTL 凭据，**原样**进 `Authorization: Bearer`（不补 `sk-` 前缀——它不是
 *     NewAPI 网关 token，前缀会改变 cloud 出口面的验证输入）；读完即删；
 *   - 引擎装配与 daemon 侧同源（`PiAgentCoreClient` + provider-proxy 的
 *     `PRISMER_PI_*` 键族），故 pi-core 在 daemon 与 turn 两种承载下行为一致。
 *
 * 有序 fallback：MUST-1 起**上移到 cloud 侧出口**（出口端点内的 chain walker 按
 * provider 链重试），pod 侧只有单一出口目标——pod 内换源会重放已落盘的工具副作用，
 * cloud 侧换源则不会（每次 turn 的副作用都在 pod，重试发生在单次 HTTP 请求内）。
 */

import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INGEST_SYSTEM_PROMPT, ingestPrompt, ingestResult } from './maintenance.js';
import type { PiCoreToolPolicy } from '../adapters/runtime-engine/pi-core/agent.js';
import type { AgentUsage, ModelCallObservation } from '../adapters/coding/shared/agent-sdk-types.js';
import type { TenantComponentBinding, TenantComponentHost, TenantComponentSelection } from '../components/tenant-runtime.js';
import {
  TURN_EVENTS_FILENAME,
  TURN_EVENTS_MAX_BYTES,
  TURN_EVENTS_MAX_COUNT,
  TURN_EXIT_INFRA,
  TURN_EXIT_OK,
  TURN_PROTOCOL_VERSION,
  TurnProtocolError,
  collapseErrorMessage,
  parseTurnEgress,
  parseTurnEnvelope,
  sanitizeToolSummary,
  type ToolEventInput,
  type ToolEventSink,
  type ToolEventV1,
  type TurnEgressV1,
  type TurnEnvelopeV1,
  type TurnErrorCode,
  type TurnResultV2,
  type TurnObservation,
  type TurnToolSummary,
} from './protocol.js';

/** runtime 包版本：package.json 是运行时版本的单一来源（同 cli/util.ts 口径）。 */
function runtimeVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** runner 用到的 session 面（AgentSession 的窄投影，便于测试注入）。 */
export interface TurnSessionHandle {
  run(
    prompt: unknown,
    options?: { messageId?: string },
  ): Promise<{
    finalText: string;
    usage?: AgentUsage;
    timeline: Array<{ type: string }>;
    canceled?: boolean;
    servedModel?: string;
    servedProvider?: string;
  }>;
  subscribe(
    cb: (event: {
      type: string;
      deltaKind?: string;
      delta?: string;
      item?: { type?: string };
      startedAt?: number;
      call?: ModelCallObservation;
    }) => void,
  ): () => void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** 测试缝隙：注入 scripted session（不触网）。 */
export interface RunTurnDeps {
  /** Authenticated host adapter only; CLI disk inputs cannot install this authority. */
  resolveTenantComponents?: (selection: TenantComponentSelection) => Promise<TenantComponentHost>;
  createSession?: (args: {
    tenantComponents?: TenantComponentBinding;
    env: Record<string, string>;
    providerId: string;
    model: string;
    systemPrompt: string;
    tools?: TurnEnvelopeV1['tools'];
    history?: TurnEnvelopeV1['history'];
    workdir: string;
    /** 工具事件 sink（§3.2）：EaaS turn 恒传；缺省 undefined = 不产事件。 */
    onToolEvent?: (event: ToolEventInput) => void;
  }) => Promise<TurnSessionHandle>;
}

/**
 * `events.jsonl` 写入器（§3.2 / §3.3 写侧）。
 *
 * 三条纪律：
 *   1. **seq / at 由写侧赋值**——seq 是「文件里的第几行」（1-based 单调），行序 ≡
 *      seq 序，cloud 轮询器据此去重；hook 只上报原始测量值。
 *   2. **上限只影响流式粒度，不影响终态**（修6）：`tools[]` 汇总在内存里**无条件**
 *      折叠（不受条数/字节上限影响），超限只是停止向文件追加。
 *   3. **写失败绝不改 turn 结果**（§5 失败矩阵）：任何异常都在这里吞掉，只上 stderr。
 */
export interface ToolEventWriter {
  /** 收一条引擎事件：折叠终态 + （未超限时）追加一行。永不抛。 */
  record(event: ToolEventInput): void;
  /** 终态汇总（`output.json.tools[]` 的来源，与文件同源）。 */
  summaries(): TurnToolSummary[];
}

export function createToolEventWriter(options: {
  eventsPath: string;
  /** 覆盖默认条数上限（测试用；生产恒走 {@link TURN_EVENTS_MAX_COUNT}）。 */
  maxCount?: number;
  /** 覆盖默认字节上限（同上，{@link TURN_EVENTS_MAX_BYTES}）。 */
  maxBytes?: number;
}): ToolEventWriter {
  const maxCount = options.maxCount ?? TURN_EVENTS_MAX_COUNT;
  const maxBytes = options.maxBytes ?? TURN_EVENTS_MAX_BYTES;
  const summaries: TurnToolSummary[] = [];
  /** 未配对的 started 行栈（按工具名）——并行同名调用下与最近一条配对。 */
  const pending = new Map<string, TurnToolSummary[]>();
  let seq = 0;
  let bytes = 0;
  let stopped = maxCount <= 0 || maxBytes <= 0;

  const fold = (event: ToolEventInput, at: string): void => {
    if (event.kind === 'tool_started') {
      const row: TurnToolSummary = { name: event.name, startedAt: at };
      if (event.argsSummary !== undefined) row.argsSummary = event.argsSummary;
      summaries.push(row);
      const stack = pending.get(event.name);
      if (stack) stack.push(row);
      else pending.set(event.name, [row]);
      return;
    }
    const row = pending.get(event.name)?.pop();
    if (row) {
      row.finishedAt = at;
      if (event.resultSummary !== undefined) row.resultSummary = event.resultSummary;
      if (event.isError !== undefined) row.isError = event.isError;
      if (event.durationMs !== undefined) row.durationMs = event.durationMs;
      return;
    }
    // 无对应 started 的 finished：理论上不出现（折叠是无条件的），如实记成一行。
    summaries.push({
      name: event.name,
      startedAt: at,
      finishedAt: at,
      ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
      ...(event.isError !== undefined ? { isError: event.isError } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    });
  };

  return {
    record(input: ToolEventInput): void {
      const at = new Date().toISOString();
      const event: ToolEventInput = {
        kind: input.kind,
        name: input.name,
        ...(input.argsSummary !== undefined
          ? { argsSummary: sanitizeToolSummary(input.argsSummary) }
          : {}),
        ...(input.resultSummary !== undefined
          ? { resultSummary: sanitizeToolSummary(input.resultSummary) }
          : {}),
        ...(input.isError !== undefined ? { isError: input.isError } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      };
      try {
        fold(event, at);
      } catch {
        /* 折叠永不抛；保底以免污染 turn */
      }
      if (stopped) return;
      const line: ToolEventV1 = { seq: seq + 1, at, ...event };
      const text = `${JSON.stringify(line)}\n`;
      const lineBytes = Buffer.byteLength(text, 'utf8');
      if (seq + 1 > maxCount || bytes + lineBytes > maxBytes) {
        // 达限停写（修6）：不再追加，终态完整性由 summaries() 保证。
        stopped = true;
        return;
      }
      try {
        // mode 只在创建时生效：events.jsonl 首行落盘即 0600（turn 目录本身 700）。
        appendFileSync(options.eventsPath, text, { mode: 0o600 });
        seq += 1;
        bytes += lineBytes;
      } catch (err) {
        stopped = true;
        process.stderr.write(
          `[turn] tool event append failed (events stream stops, turn continues): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
    summaries(): TurnToolSummary[] {
      // 深拷贝：调用方拿到的是终态快照，不被后续 record 改写（含孤儿行的 finishedAt）。
      return summaries.map((row) => ({ ...row }));
    },
  };
}

/**
 * 把 envelope 的 message 投影成引擎 prompt：有 contentBlocks → 有序 parts
 * （text/image；image 的 dataUrl 载荷原样进 `data`，引擎直吃）；无块 → 纯文本。
 *
 * dataUrl 形态不合法（缺 `,`）→ 抛错（绝不静默丢图：接口宣称的输入必须真实进模型）。
 */
export function promptFromEnvelope(
  envelope: Pick<TurnEnvelopeV1, 'message'>,
): import('../adapters/runtime-engine/pi-core/agent.js').PiCoreHistoryEntry['content'] {
  const blocks = envelope.message.contentBlocks;
  if (!blocks || blocks.length === 0) return envelope.message.text;
  const parts: Exclude<import('../adapters/runtime-engine/pi-core/agent.js').PiCoreHistoryEntry['content'], string> =
    [{ type: 'text', text: envelope.message.text }];
  for (const block of blocks) {
    if (block.kind === 'text') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    const comma = block.dataUrl.indexOf(',');
    if (comma < 0) {
      throw new TurnProtocolError(`image block ${block.assetId} has a malformed dataUrl`);
    }
    parts.push({ type: 'image', data: block.dataUrl.slice(comma + 1), mimeType: block.mediaType });
  }
  return parts;
}

/** 出口面固定 wire：cloud 出口端点就是 OpenAI chat-completions（含 SSE）。 */
const EGRESS_PI_API = 'openai-completions';

/**
 * turn 承载的 pi-core 装配（**唯一**开 shell 的地方，§3.1 修1）：抽成单一来源，
 * 供契约测试直接钉住「EaaS turn 恒传 allowShell=true」，无需起真进程。
 *
 * daemon / engine registry 不走这里（`new PiAgentCoreClient(options)` /
 * `createPiCoreAdapter(options)`），缺省 `allowShell=false` ⇒ 工具面零变化。
 */
export function turnSessionClientOptions(
  onToolEvent?: ToolEventSink,
  tools?: TurnEnvelopeV1['tools'],
): {
  allowShell: true;
  toolPolicy: PiCoreToolPolicy;
  onToolEvent?: ToolEventSink;
} {
  // The envelope declares a per-turn tool surface, not a live ACL or approval.
  // Preserve legacy tools only when absent; an explicit [] permits no tools.
  const deny = new Set(tools?.filter(tool => tool.enabled === false).map(tool => tool.name) ?? []);
  const allow = tools === undefined
    ? ['read', 'write', 'edit', 'bash']
    : [...new Set(tools.filter(tool => tool.enabled !== false && !deny.has(tool.name)).map(tool => tool.name))];
  return {
    allowShell: true,
    toolPolicy: { allow, deny: [...deny] },
    ...(onToolEvent ? { onToolEvent } : {}),
  };
}

async function defaultCreateSession(args: {
  tenantComponents?: TenantComponentBinding;
  env: Record<string, string>;
  providerId: string;
  model: string;
  systemPrompt: string;
  tools?: TurnEnvelopeV1['tools'];
  history?: TurnEnvelopeV1['history'];
  workdir: string;
  onToolEvent?: (event: ToolEventInput) => void;
}): Promise<TurnSessionHandle> {
  const { PiAgentCoreClient } = await import('../adapters/runtime-engine/pi-core/agent.js');
  const client = new PiAgentCoreClient({
    tenantComponents: args.tenantComponents,
    ...turnSessionClientOptions(args.onToolEvent, args.tools),
    initialHistory: (args.history ?? []).map(entry => ({
      role: entry.role,
      content: promptFromEnvelope({ message: { text: entry.content, contentBlocks: entry.contentBlocks } }),
    })),
  });
  const session = await client.createSession(
    {
      provider: 'pi-core',
      cwd: args.workdir,
      systemPrompt: args.systemPrompt,
      model: args.model,
      ...(args.tools ? { runtimeTools: args.tools } : {}),
    },
    { env: args.env },
  );
  return session as unknown as TurnSessionHandle;
}

/**
 * 出口面 env 装配（键族与 daemon 侧 provider-proxy-env 的 pi-core 分支同源——承载方式
 * 不同、语义相同）。token **原样**进 `PRISMER_PI_API_KEY`：pi-ai 底下的 OpenAI SDK 只做
 * `Bearer ${apiKey}` 拼接，而 egress token 不是 `sk-` 形态的网关凭据，补前缀只会让
 * cloud 出口面的 HMAC 验证吃到不同的字符串（401）。
 */
export function egressSessionEnv(envelope: TurnEnvelopeV1, egress: TurnEgressV1): Record<string, string> {
  void envelope;
  return {
    PRISMER_PI_BASE_URL: egress.url,
    PRISMER_PI_PROVIDER: egress.provider,
    PRISMER_PI_API: EGRESS_PI_API,
    PRISMER_PI_MODEL: egress.model,
    PRISMER_PI_API_KEY: egress.token,
  };
}

/**
 * 错误归类（gateway 形态同族）：出口不可达（DNS/连接/超时）→ provider_unreachable；
 * 其余（4xx 语义拒绝等）→ internal。capability_denied 由 cloud 端口的视觉门负责
 * （runtime 侧不复制模型能力表——那是 cloud 的单一来源）。
 */
function classifyProviderError(message: string): TurnErrorCode {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i.test(message)
    ? 'provider_unreachable'
    : 'internal';
}

/**
 * 跑一轮 turn：单一出口目标，成功、超时或失败即定格结果。
 * 返回 TurnResultV2（status:'ok' | 'error'），不抛（除 promptFromEnvelope 的协议错误）。
 *
 * `onToolEvent` 是工具事件的观察面（§3.2）：引擎侧 hook 只上报、不拦截；不传 =
 * 本轮不产事件（sink 与 turn 结果解耦——事件面永远不改 turn 语义）。
 */
export async function runTurnOnce(
  envelope: TurnEnvelopeV1,
  egress: TurnEgressV1,
  deps: RunTurnDeps = {},
  onToolEvent?: (event: ToolEventInput) => void,
): Promise<TurnResultV2> {
  const started = performance.now();
  const observation: TurnObservation = { version: 1, source: 'runtime', sessionInitMs: null,
    totalMs: 0, modelCalls: [], droppedModelCalls: 0 };
  const result = await runTurnExecution(envelope, egress, deps, onToolEvent, observation);
  observation.totalMs = performance.now() - started;
  result.observation = observation;
  return result;
}

async function runTurnExecution(
  envelope: TurnEnvelopeV1,
  egress: TurnEgressV1,
  deps: RunTurnDeps,
  onToolEvent: ((event: ToolEventInput) => void) | undefined,
  observation: TurnObservation,
): Promise<TurnResultV2> {
  const createSession = deps.createSession ?? defaultCreateSession;
  const version = runtimeVersion();
  const env = egressSessionEnv(envelope, egress);
  const providerId = egress.provider;

  let session: TurnSessionHandle | null = null;
  let t8: number | null = null;
  let timedOut = false;
  let t7: number | null = null;
  let sawRequest = false;
  const initStarted = performance.now();
  try {
    let tenantComponents: TenantComponentBinding | undefined;
    if (envelope.tenantComponents?.length) {
      if (envelope.maintenance || !deps.resolveTenantComponents) throw new Error('tenant component authority unavailable');
      const selection = { turnId: envelope.turnId, components: structuredClone(envelope.tenantComponents) };
      try {
        tenantComponents = { ...selection, host: await deps.resolveTenantComponents(structuredClone(selection)) };
      } catch {
        // Resolver diagnostics may contain transport credentials; never put them in tenant output.
        throw new Error('tenant component authority unavailable');
      }
    }
    session = await createSession({
      tenantComponents,
      env,
      providerId,
      model: egress.model,
      systemPrompt: envelope.maintenance ? INGEST_SYSTEM_PROMPT : envelope.systemPrompt,
      history: envelope.history,
      ...(envelope.maintenance ? { tools: [] } : envelope.tools ? { tools: envelope.tools } : {}),
      workdir: envelope.workdir,
      ...(onToolEvent ? { onToolEvent } : {}),
    });
    session.subscribe((event) => {
      if (event.type === 'model_request_started' && !sawRequest && typeof event.startedAt === 'number') {
        t7 = event.startedAt;
        sawRequest = true;
      }
      if (event.type === 'model_call_observed' && event.call) {
        if (observation.modelCalls.length < 128) observation.modelCalls.push(event.call);
        else observation.droppedModelCalls += 1;
      }
      if (timedOut || t8 !== null) return;
      if (event.type === 'text_delta' && event.deltaKind === 'text' && event.delta) {
        // t8 = 首个非空可呈现 delta（协议 spec §5 的首 token 时点）。
        t8 = Date.now();
      }
    });
    observation.sessionInitMs = performance.now() - initStarted;
    const timer = setTimeout(() => {
      timedOut = true;
      void session?.interrupt().catch(() => undefined);
    }, Math.max(1, envelope.deadlineMs));
    let result: Awaited<ReturnType<TurnSessionHandle['run']>>;
    try {
      result = await session.run(envelope.maintenance ? ingestPrompt(envelope.maintenance) : promptFromEnvelope(envelope), { messageId: envelope.turnId });
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      return timeoutResult(envelope, egress.model, providerId, version, t7, t8);
    }
    const replyText = result.finalText ?? '';
    const usage = {
      promptTokens: result.usage?.inputTokens ?? null,
      completionTokens: result.usage?.outputTokens ?? null,
    };
    const engine = { adapter: 'pi-core', version, model: result.servedModel || egress.model };
    if (replyText.length === 0) {
      return errorResult(
        envelope,
        engine,
        providerId,
        t7,
        t8,
        usage,
        'provider_unreachable',
        `egress ${providerId} returned no presentable text`,
      );
    }
    return {
      protocolVersion: TURN_PROTOCOL_VERSION,
      turnId: envelope.turnId,
      status: 'ok',
      ...(!envelope.maintenance ? { replyText } : {}),
      ...(envelope.maintenance ? { maintenanceResult: ingestResult(envelope.maintenance, replyText) } : {}),
      usage,
      spans: { t7, t8 },
      engine,
      providerSource: result.servedProvider || providerId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 引擎在 abort 时不抛而是回 canceled —— 这里兜底同语义。
    if (timedOut) {
      return timeoutResult(envelope, egress.model, providerId, version, t7, t8);
    }
    return errorResult(
      envelope,
      { adapter: 'pi-core', version, model: egress.model },
      providerId,
      t7,
      t8,
      undefined,
      classifyProviderError(message),
      message,
    );
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}

function timeoutResult(
  envelope: TurnEnvelopeV1,
  model: string,
  providerId: string,
  version: string,
  t7: number | null,
  t8: number | null,
): TurnResultV2 {
  return errorResult(
    envelope,
    { adapter: 'pi-core', version, model },
    providerId,
    t7,
    t8,
    undefined,
    'timeout',
    `turn exceeded deadline ${envelope.deadlineMs}ms`,
  );
}

function errorResult(
  envelope: TurnEnvelopeV1,
  engine: { adapter: string; version: string; model: string },
  providerSource: string | null,
  t7: number | null,
  t8: number | null,
  usage: TurnResultV2['usage'] | undefined,
  code: TurnErrorCode,
  message: string,
): TurnResultV2 {
  return {
    protocolVersion: TURN_PROTOCOL_VERSION,
    turnId: envelope.turnId,
    status: 'error',
    ...(usage ? { usage } : {}),
    spans: { t7, t8 },
    engine,
    providerSource,
    error: { code, message: collapseErrorMessage(message) },
  };
}

export interface RunTurnFileOptions {
  inputPath: string;
  outputPath: string;
  /** egress.json 路径（turn 作用域出口凭据；读完即删）。 */
  egressFilePath: string;
  /** 覆盖 envelope 的 deadlineMs（CLI `--deadline-ms`）。 */
  deadlineMsOverride?: number;
  deps?: RunTurnDeps;
}

/**
 * CLI 入口：读 envelope + egress → 跑 → 写 output.json。返回进程 exit code
 * （0 = output.json 已写；70 = 基建失败）。
 *
 * egress 文件**读完即删**（凭据窗口 = turn 窗口；端口侧另有 0600 与 turn 目录清理兜底）。
 */
export async function runTurnFile(opts: RunTurnFileOptions): Promise<number> {
  // I-2：投递文件的删除必须在**最外层 finally**——envelope 解析失败（最早的 return
  // 路径）此前直接返回 70 而把凭据文件留在盘上，而 turn 目录在 agent 文件工具的 jail
  // 内，下一轮 turn 的模型可以读到并把它带进回复。
  try {
    return await runTurnFileInner(opts);
  } finally {
    try {
      rmSync(opts.egressFilePath, { force: true });
    } catch {
      /* best-effort：删除失败不阻断 turn（凭据窗口由端口侧 turn 目录清理兜底） */
    }
  }
}

async function runTurnFileInner(opts: RunTurnFileOptions): Promise<number> {
  let envelope: TurnEnvelopeV1;
  try {
    envelope = parseTurnEnvelope(JSON.parse(readFileSync(opts.inputPath, 'utf8')) as unknown);
  } catch (err) {
    return infraFailure(`input envelope rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  let egress: TurnEgressV1;
  try {
    egress = parseTurnEgress(JSON.parse(readFileSync(opts.egressFilePath, 'utf8')) as unknown);
  } catch (err) {
    return infraFailure(`turn egress file rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opts.deadlineMsOverride && opts.deadlineMsOverride > 0) {
    envelope.deadlineMs = opts.deadlineMsOverride;
  }

  // 工具事件流（v2）：turnDir = dirname(input)——cloud 端口按同一约定读 `events.jsonl`。
  // 文件**懒创建**：本轮没有工具调用 ⇒ 不落 events.jsonl（缺文件 = 零工具调用）。
  const eventsPath = join(dirname(opts.inputPath), TURN_EVENTS_FILENAME);
  const events = createToolEventWriter({ eventsPath });

  let result: TurnResultV2;
  try {
    result = await runTurnOnce(envelope, egress, opts.deps ?? {}, (event) => events.record(event));
  } catch (err) {
    return infraFailure(`turn crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  // 终态汇总进 output.json（§3.2 tools[]）：**无条件**（不受 events 上限影响）；
  // 空数组 = 本轮无工具调用 ⇒ 字段缺省（与协议「缺字段按缺省」一致）。
  const tools = events.summaries();
  if (tools.length > 0) result.tools = tools;
  try {
    writeFileSync(opts.outputPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  } catch (err) {
    return infraFailure(`output write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return TURN_EXIT_OK;
}

function infraFailure(message: string): number {
  // stdout 不是数据通道——诊断只上 stderr（包装器把两者都收进 pod log）。
  process.stderr.write(`[turn] ${message}\n`);
  return TURN_EXIT_INFRA;
}

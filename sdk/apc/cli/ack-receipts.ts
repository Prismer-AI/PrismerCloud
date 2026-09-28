/**
 * ack-receipts.ts — **层 1 回执的读取 / 校验侧**（apc/04 §2）。
 *
 * 回答的唯一问题：**「skill X 在这次 run（这个 task）里真的被调度了吗」**。
 * 判据是 DB 副作用行，不是聊天文本。
 *
 * ── 回执落在哪（对码，不是转述）──────────────────────────────────────
 *   生产者 `cloud skill ack`  → `sdk/cloud/src/commands/skill.ts:604`
 *                               `client.im.tasks.postEvent(taskId, {code:'SKILL_ACK', payload:{skillSlug,…}})`
 *   endpoint                 → `POST /api/im/tasks/:id/event`（`src/im/api/tasks.ts:2486`）
 *   落库                     → `src/im/api/tasks.ts:2517-2527`
 *                               `prisma.iMTaskLog.create({ action: code.toLowerCase(),  // → 'skill_ack'
 *                                                          actorId: user.imUserId,
 *                                                          metadata: JSON.stringify({code, ...payload}) })`
 *   读取                     → `GET /api/im/tasks/:id`（`tasks.ts:1732`）
 *                               → `taskService.getTaskWithLogs`（`task.service.ts:1443`）
 *                               → `taskModel.getLogsByTaskId`（`src/im/models/task.ts:441`）
 *   SDK                      → `client.im.tasks.get(taskId)` → `IMTaskDetail{task, logs}`
 *                               （`typescript/src/index.ts:847` / `types.ts:839,849`）
 *
 * **不新建服务端能力**：整条读取面就是既有的 `GET /tasks/:id`。
 *
 * ⚠️ 诚实边界（`src/im/models/task.ts:441`）：`getLogsByTaskId` 是
 * `orderBy createdAt desc, take 50` —— 回执窗口只有**最近 50 条 task log**。
 * 日志密集的 task 上，早期回执会被挤出窗口 ⇒ 本校验器的「缺失」判定在
 * `logsTruncated:true` 时**不是权威的**，输出里显式标出来，不许当成"没 ack"。
 *
 * 用法：
 *   apc skills ack-receipts <taskId> [--expect a,b,c] [--json]
 *   exit 0 = 读到了（带 --expect 时：期望的 slug 全部有回执）
 *        1 = --expect 有缺失，或请求失败
 *        2 = 用法错
 */
import { PrismerClient } from '../../cloud/src/index';

/** `code.toLowerCase()`（`tasks.ts:2517`）—— 回执行的 action 值。 */
export const ACK_LOG_ACTION = 'skill_ack';
/** 服务端 `getLogsByTaskId` 的默认 take（`src/im/models/task.ts:441`）。 */
export const TASK_LOG_WINDOW = 50;

export interface AckReceipt {
  skillSlug: string;
  taskId: string;
  /** `im_task_logs.actorId` —— 服务端从凭据解析的**权威** actor，非 payload 自称。 */
  actorId: string | null;
  /** payload 里 agent 自称的 id（可能缺）。与 actorId 不同源，故分开。 */
  claimedAgentId: string | null;
  createdAt: string;
}

/** 上游 log 行的最小形状（SDK `IMTaskLog` 的子集）。 */
export interface TaskLogLike {
  action: string;
  actorId?: string | null;
  metadata?: unknown;
  createdAt?: string;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  // `im_task_logs.metadata` 是 String(JSON) 列，但 SDK 类型标的是对象 —— 服务端
  // 是否在返回前 parse 取决于映射层。两种都接，别在 oracle 里赌一种。
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 纯函数：从 task logs 里筛出 ack 回执。 */
export function selectAckReceipts(logs: TaskLogLike[], taskId: string): AckReceipt[] {
  const out: AckReceipt[] = [];
  for (const log of logs) {
    if (log.action !== ACK_LOG_ACTION) continue;
    const md = parseMetadata(log.metadata);
    const slug = typeof md.skillSlug === 'string' ? md.skillSlug : '';
    if (!slug) continue; // 没有 skillSlug 的 skill_ack 行判定不了是哪个 skill
    out.push({
      skillSlug: slug,
      taskId: typeof md.taskId === 'string' ? md.taskId : taskId,
      actorId: log.actorId ?? null,
      claimedAgentId: typeof md.agentId === 'string' ? md.agentId : null,
      createdAt: typeof log.createdAt === 'string' ? log.createdAt : '',
    });
  }
  return out;
}

export interface AckVerdict {
  taskId: string;
  /** 该 task 上出现过回执的 skill slug（去重、按首次出现序）。 */
  acked: string[];
  receipts: AckReceipt[];
  /** `--expect` 里没拿到回执的 slug。非空 ⇒ 判红。 */
  missing: string[];
  /**
   * true = 上游 log 条数触到 50 条窗口上限 ⇒ **`missing` 不权威**
   * （早期回执可能已被挤出窗口）。
   */
  logsTruncated: boolean;
  ok: boolean;
}

/** 纯函数：给定 logs + 期望 slug 集合，算判词。 */
export function evaluateAck(logs: TaskLogLike[], taskId: string, expect: string[]): AckVerdict {
  const receipts = selectAckReceipts(logs, taskId);
  const acked: string[] = [];
  for (const r of receipts) if (!acked.includes(r.skillSlug)) acked.push(r.skillSlug);
  const missing = expect.filter((s) => !acked.includes(s));
  const logsTruncated = logs.length >= TASK_LOG_WINDOW;
  return { taskId, acked, receipts, missing, logsTruncated, ok: missing.length === 0 };
}

/**
 * APC 工具链的 cloud client。
 *
 * baseUrl 默认**本机**（apc/00 §3 不变量 4「本机优先」）—— SDK 自己的
 * `resolveBaseUrl`（`typescript/src/index.ts:74`）只认 `PRISMER_BASE_URL` 与
 * config.toml 的 `base_url` 键，而本机 `~/.prismer/config.toml` 写的是
 * `cloud_api_base`，解析不到就会**默默打 production**。所以这里显式给默认值。
 * apiKey 交给 SDK 的 `resolveApiKey`（env `PRISMER_API_KEY` → config.toml）。
 */
export function apcClient(): PrismerClient {
  const baseUrl = process.env.APC_CLOUD_BASE_URL || process.env.PRISMER_BASE_URL || 'http://127.0.0.1:3000';
  return new PrismerClient({ baseUrl, ...(process.env.APC_API_KEY ? { apiKey: process.env.APC_API_KEY } : {}) });
}

export async function fetchAckVerdict(taskId: string, expect: string[]): Promise<AckVerdict> {
  const res = await apcClient().im.tasks.get(taskId);
  if (!res.ok || !res.data) {
    throw new Error(`GET /api/im/tasks/${taskId} failed: ${res.error?.message ?? 'unknown error'}`);
  }
  const logs = (res.data.logs ?? []) as unknown as TaskLogLike[];
  return evaluateAck(logs, taskId, expect);
}

const USAGE = `apc skills ack-receipts <taskId> [--expect a,b,c] [--json]

读该 task 的 im_task_logs 回执行（action='skill_ack'），判定哪些 skill 在这次 run 里
真的被调度过（apc/04 §2 层1）。--expect 给出的 slug 若有缺失则 exit 1。

exit 0 ok · 1 缺失/请求失败 · 2 用法错
`;

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const expectArg = argv.find((a) => a.startsWith('--expect='));
  const expectIdx = argv.indexOf('--expect');
  const expectRaw = expectArg
    ? expectArg.slice('--expect='.length)
    : expectIdx >= 0
      ? (argv[expectIdx + 1] ?? '')
      : '';
  const expect = expectRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const positional = argv.filter((a, i) => !a.startsWith('--') && !(expectIdx >= 0 && i === expectIdx + 1));
  const taskId = positional[0];
  if (!taskId) {
    process.stderr.write(USAGE);
    return 2;
  }

  let verdict: AckVerdict;
  try {
    verdict = await fetchAckVerdict(taskId, expect);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    else process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  } else {
    process.stdout.write(`task ${verdict.taskId} — ${verdict.receipts.length} receipt(s)\n`);
    for (const r of verdict.receipts) {
      process.stdout.write(`  ${r.skillSlug}  actor=${r.actorId ?? '?'}  ${r.createdAt}\n`);
    }
    if (verdict.missing.length > 0) {
      process.stderr.write(`✗ no receipt for: ${verdict.missing.join(', ')}\n`);
    }
    if (verdict.logsTruncated) {
      process.stderr.write(
        `! task log window is full (${TASK_LOG_WINDOW}) — an absent receipt is NOT authoritative here\n`,
      );
    }
  }
  return verdict.ok ? 0 : 1;
}

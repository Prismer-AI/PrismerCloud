/**
 * ack-receipts.test.ts — 回执读取/校验侧验收。
 *
 * 两层：
 *   (a) 纯函数层用**真 log 行形状**（对码 `src/im/api/tasks.ts:2517-2527` 写进去的
 *       那一行）喂 fixture；
 *   (b) 传输层不 mock fetch —— 起真 `node:http` server + 真 `PrismerClient`
 *       走 global fetch（照 apc/11 §0.7 P0-1 的验证层级），oracle = server 实收的
 *       method/path + 退出码。
 *
 * 真栈（本机 cloud:3000 + MySQL:3307）的端到端在 `real-stack.e2e.ts`（独立 tsx 脚本，
 * 需要活的 cloud，不进 vitest 默认门）。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACK_LOG_ACTION,
  evaluateAck,
  fetchAckVerdict,
  selectAckReceipts,
  TASK_LOG_WINDOW,
  type TaskLogLike,
} from '../ack-receipts';

/** 服务端真正写进去的一行（`tasks.ts:2521-2527`）：action 是 code.toLowerCase()，metadata 是 JSON 串。 */
function ackRow(slug: string, opts: { actorId?: string; taskId?: string; agentId?: string } = {}): TaskLogLike {
  return {
    action: ACK_LOG_ACTION,
    actorId: opts.actorId ?? 'imuser_assignee',
    metadata: JSON.stringify({
      code: 'SKILL_ACK',
      skillSlug: slug,
      taskId: opts.taskId ?? 'task_1',
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ts: '2026-07-24T00:00:00.000Z',
    }),
    createdAt: '2026-07-24T00:00:00.000Z',
  };
}

describe('selectAckReceipts — 只认 action=skill_ack 且带 skillSlug 的行', () => {
  it('筛出回执，actorId（服务端权威）与 payload 自称 agentId 分开保留', () => {
    const logs: TaskLogLike[] = [
      { action: 'status_changed', metadata: '{}' },
      ackRow('git-ops', { actorId: 'imuser_A', agentId: 'claimed_B' }),
      { action: 'outbox_mime_mismatch', metadata: JSON.stringify({ code: 'X', skillSlug: 'git-ops' }) },
    ];
    const got = selectAckReceipts(logs, 'task_1');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ skillSlug: 'git-ops', actorId: 'imuser_A', claimedAgentId: 'claimed_B' });
  });

  it('metadata 是对象或 JSON 串都要吃（列是 String(JSON)，映射层是否 parse 不确定）', () => {
    const asObject: TaskLogLike = { action: ACK_LOG_ACTION, metadata: { code: 'SKILL_ACK', skillSlug: 'tdd' } };
    expect(selectAckReceipts([asObject], 't')).toHaveLength(1);
    expect(selectAckReceipts([ackRow('tdd')], 't')).toHaveLength(1);
  });

  it('负控：skill_ack 行没有 skillSlug → 判定不出是哪个 skill，不计回执', () => {
    const noSlug: TaskLogLike = { action: ACK_LOG_ACTION, metadata: JSON.stringify({ code: 'SKILL_ACK' }) };
    expect(selectAckReceipts([noSlug], 't')).toHaveLength(0);
  });

  it('负控：metadata 是坏 JSON → 不崩、不计回执', () => {
    expect(selectAckReceipts([{ action: ACK_LOG_ACTION, metadata: '{oops' }], 't')).toHaveLength(0);
  });
});

describe('evaluateAck — 判词', () => {
  it('期望全命中 → ok', () => {
    const v = evaluateAck([ackRow('git-ops'), ackRow('test-runner')], 'task_1', ['git-ops', 'test-runner']);
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.acked).toEqual(['git-ops', 'test-runner']);
  });

  it('负控：期望的 skill 没有回执 → ok=false 且列出缺失（"回执缺失即判红"）', () => {
    const v = evaluateAck([ackRow('git-ops')], 'task_1', ['git-ops', 'release-tag']);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['release-tag']);
  });

  it('负控：一条回执都没有 → 全部缺失', () => {
    const v = evaluateAck([{ action: 'status_changed' }], 'task_1', ['git-ops']);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['git-ops']);
  });

  it('log 触到 50 条窗口 → logsTruncated=true（缺失判定此时不权威）', () => {
    const logs = Array.from({ length: TASK_LOG_WINDOW }, () => ({ action: 'status_changed' }) as TaskLogLike);
    expect(evaluateAck(logs, 't', []).logsTruncated).toBe(true);
    expect(evaluateAck(logs.slice(1), 't', []).logsTruncated).toBe(false);
  });

  it('同一 skill 多次 ack → acked 去重，receipts 保留每一条', () => {
    const v = evaluateAck([ackRow('git-ops'), ackRow('git-ops')], 'task_1', ['git-ops']);
    expect(v.acked).toEqual(['git-ops']);
    expect(v.receipts).toHaveLength(2);
  });
});

describe('fetchAckVerdict — 真 http server + 真 PrismerClient（不 mock fetch）', () => {
  let server: Server | undefined;
  const calls: Array<{ method: string; url: string }> = [];

  afterEach(() => {
    server?.close();
    server = undefined;
    calls.length = 0;
    delete process.env.APC_CLOUD_BASE_URL;
    delete process.env.APC_API_KEY;
  });

  async function start(handler: (url: string) => { status: number; body: unknown }): Promise<void> {
    server = createServer((req, res) => {
      calls.push({ method: req.method!, url: req.url! });
      const out = handler(req.url!);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as { port: number }).port;
    process.env.APC_CLOUD_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.APC_API_KEY = 'sk-prismer-live-test';
  }

  it('打的是既有的 GET /api/im/tasks/:id（不新建服务端能力）', async () => {
    await start(() => ({ status: 200, body: { ok: true, data: { task: { id: 'task_9' }, logs: [ackRow('git-ops')] } } }));
    const v = await fetchAckVerdict('task_9', ['git-ops']);
    expect(calls).toEqual([{ method: 'GET', url: '/api/im/tasks/task_9' }]);
    expect(v.ok).toBe(true);
  });

  it('负控：服务端返回的 logs 里没有 skill_ack 行 → 判红（missing 非空）', async () => {
    await start(() => ({
      status: 200,
      body: { ok: true, data: { task: { id: 'task_9' }, logs: [{ action: 'status_changed', metadata: '{}' }] } },
    }));
    const v = await fetchAckVerdict('task_9', ['git-ops']);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['git-ops']);
  });

  it('负控：task 读不到（403/404）→ 抛，不许静默当成"没 ack"', async () => {
    await start(() => ({ status: 404, body: { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'task not found' } } }));
    await expect(fetchAckVerdict('task_missing', ['git-ops'])).rejects.toThrow(/failed/);
  });
});

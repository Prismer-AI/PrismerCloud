/**
 * h-contact-system-refactor §9-SDK / K 空腔闭合 B2 — `_request` 对
 * 202 ACTION_DEFERRED（跨台联系人审批等）的契约提升：
 *
 * 服务端 202 body = { ok: true, data: { deferred: true, approvalId, ... },
 * meta: { code: 'ACTION_DEFERRED' } }。之前 SDK 把它当普通成功返回——
 * offline.ts `if (result.ok)` 会 ack 掉 outbox op，重试义务永久丢失。
 * 提升后调用方在 IMResult 顶层拿到 deferred/approvalId 分支。
 *
 * 负控：普通 200 不带 deferred 标记（提升不得误伤成功路径）。
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerClient } from '../../src/index';

/** Create a mock Response-like object */
function mockResponse(status: number, body: unknown): Response {
  const bodyStr = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    text: () => Promise.resolve(bodyStr),
    clone: () => mockResponse(status, body),
  } as unknown as Response;
}

function deferredClient(response: Response): PrismerClient {
  return new PrismerClient({
    apiKey: 'sk-prismer-live-abc123',
    baseUrl: 'https://cloud.test',
    fetch: vi.fn().mockResolvedValue(response) as unknown as typeof fetch,
  });
}

describe('IM request 202 ACTION_DEFERRED promotion', () => {
  it('promotes deferred/approvalId to IMResult top level on 202', async () => {
    const client = deferredClient(
      mockResponse(202, {
        ok: true,
        data: { deferred: true, approvalId: 'ap-1', policyId: 'p-1', reason: 'cross-ws contact' },
        meta: { code: 'ACTION_DEFERRED' },
      }),
    );

    const res = await client.im.direct.send('peer-1', 'hello');

    expect(res.ok).toBe(true);
    expect(res.deferred).toBe(true);
    expect(res.approvalId).toBe('ap-1');
    // 原始 data 载荷不被吞掉
    expect((res.data as { reason?: string })?.reason).toBe('cross-ws contact');
  });

  it('200 success carries no deferred marker (negative control)', async () => {
    const client = deferredClient(
      mockResponse(200, { ok: true, data: { conversationId: 'c1' }, meta: { total: 1 } }),
    );

    const res = await client.im.direct.send('peer-1', 'hello');

    expect(res.ok).toBe(true);
    expect(res.deferred).toBeUndefined();
    expect(res.approvalId).toBeUndefined();
  });

  it('202 without deferred flag is left untouched (shape guard)', async () => {
    const client = deferredClient(mockResponse(202, { ok: true, data: { accepted: true } }));

    const res = await client.im.direct.send('peer-1', 'hello');

    expect(res.ok).toBe(true);
    expect(res.deferred).toBeUndefined();
    expect(res.approvalId).toBeUndefined();
  });
});

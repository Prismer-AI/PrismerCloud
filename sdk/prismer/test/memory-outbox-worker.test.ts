import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { MemoryOutboxWorker } from '../src/daemon/memory/outbox-worker.js';

let dir = '';
let runtime: MemoryRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-worker-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
});

afterEach(() => {
  runtime.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

function commonEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    workspaceId: 'ws_test',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    deviceId: 'dev_x',
    createdAt: new Date().toISOString(),
    idempotencyKey: `key_${randomUUID()}`,
    ...overrides,
  };
}

function pageUpsertEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return commonEvent({
    eventType: 'memory.page.upsert',
    pageId: `page_${randomUUID().slice(0, 8)}`,
    path: 'a.md',
    parentVersion: 0,
    contentHash: 'sha',
    payload: { kind: 'inline', content: 'x' },
    ...overrides,
  });
}

function pageDeleteEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return commonEvent({
    eventType: 'memory.page.delete',
    pageId: `page_${randomUUID().slice(0, 8)}`,
    parentVersion: 1,
    ...overrides,
  });
}

function mockCloud(fetchImpl: typeof fetch): CloudClient {
  return new CloudClient({ apiKey: 'sk-test', baseUrl: 'http://cloud.test', fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MemoryOutboxWorker', () => {
  it('flushNow: empty workspace pool returns zero counts', async () => {
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(vi.fn()) });
    const r = await worker.flushNow();
    expect(r).toEqual({
      workspaces: 0,
      flushed: 0,
      deadLettered: 0,
      pendingRemain: 0,
      transientFailures: 0,
    });
  });

  it('flushNow: cloud acks all events → all rows status=acked', async () => {
    const slot = runtime.resolve('ws_test');
    const e1 = pageUpsertEvent({ pageId: 'page_1' });
    const e2 = pageUpsertEvent({ pageId: 'page_2' });
    slot.outbox.enqueue(e1);
    slot.outbox.enqueue(e2);
    expect(slot.outbox.pendingCount()).toBe(2);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: { acked: [e1.eventId, e2.eventId], errors: [] },
      }),
    );
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock as unknown as typeof fetch) });

    const r = await worker.flushNow();
    expect(r.flushed).toBe(2);
    expect(r.deadLettered).toBe(0);
    expect(r.pendingRemain).toBe(0);
    expect(slot.outbox.pendingCount()).toBe(0);

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('http://cloud.test/api/im/memory/sync/inbox');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('preserves owned-agent authorship for Cloud per-event authorization instead of rewriting it to the owner', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_agent_authored',
      actorImUserId: 'agent_owned_by_daemon_owner',
      actorKind: 'agent',
    });
    slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.flushNow()).resolves.toMatchObject({ flushed: 1, deadLettered: 0 });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const posted = JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> };
    expect(posted.events).toEqual([
      expect.objectContaining({
        actorImUserId: 'agent_owned_by_daemon_owner',
        actorKind: 'agent',
      }),
    ]);
  });

  it('confirmPageReceipts: returns only after Cloud acks the exact Page receipt', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_authoritative',
      path: 'decisions/authoritative.pkf',
      contentHash: 'hash_authoritative',
    });
    const queued = slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } })
        : jsonResponse({
            ok: true,
            data: {
              id: 'page_authoritative',
              path: 'decisions/authoritative.pkf',
              version: 1,
              contentHash: 'hash_authoritative',
            },
          }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_authoritative',
      path: 'decisions/authoritative.pkf',
      version: 1,
      contentHash: 'hash_authoritative',
      authorityEventId: queued.id,
    }])).resolves.toEqual([{
      pageId: 'page_authoritative',
      path: 'decisions/authoritative.pkf',
      version: 1,
      contentHash: 'hash_authoritative',
      authority: 'cloud',
      authorityEventId: queued.id,
    }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slot.store.rawDb().prepare(
      "SELECT status FROM memory_outbox WHERE eventType = 'memory.page.upsert'",
    ).get()).toEqual({ status: 'acked' });
  });

  it('confirmPageReceipts: rejects pending authority instead of treating a local Page as persisted', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_pending',
      path: 'decisions/pending.pkf',
      contentHash: 'hash_pending',
    });
    const queued = slot.outbox.enqueue(event);
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(vi.fn(async () => jsonResponse({
        ok: false,
        error: { code: 'cloud_down', message: 'temporarily unavailable' },
      }, 503)) as unknown as typeof fetch),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_pending',
      path: 'decisions/pending.pkf',
      version: 1,
      contentHash: 'hash_pending',
      authorityEventId: queued.id,
    }])).rejects.toMatchObject({
      code: 'memory_authority_pending',
      retryable: true,
    });
  });

  it('confirmPageReceipts: accepts a receipt already returned by the cloud-authoritative section writer', async () => {
    runtime.resolve('ws_test');
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      data: {
        id: 'page_cloud',
        path: 'decisions/cloud.pkf',
        version: 5,
        contentHash: 'hash_cloud',
      },
    }));
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock) });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_cloud',
      path: 'decisions/cloud.pkf',
      version: 5,
      contentHash: 'hash_cloud',
      authority: 'cloud',
    }])).resolves.toEqual([{
      pageId: 'page_cloud',
      path: 'decisions/cloud.pkf',
      version: 5,
      contentHash: 'hash_cloud',
      authority: 'cloud',
    }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://cloud.test/api/im/memory/pages/page_cloud?workspaceId=ws_test&format=markdown',
    );
  });

  it('confirmPageReceipts: rejects an ACK whose authoritative Page cannot be read back exactly', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_mismatch',
      path: 'decisions/mismatch.pkf',
      contentHash: 'hash_expected',
    });
    const queued = slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } })
        : jsonResponse({
            ok: true,
            data: {
              id: 'page_mismatch',
              path: 'decisions/mismatch.pkf',
              version: 1,
              contentHash: 'hash_tampered',
            },
          }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_mismatch',
      path: 'decisions/mismatch.pkf',
      version: 1,
      contentHash: 'hash_expected',
      authorityEventId: queued.id,
    }])).rejects.toMatchObject({
      code: 'memory_authority_readback_mismatch',
      retryable: false,
    });
  });

  it('confirmPageReceipts: canonicalizes replica version drift from Cloud readback without weakening content identity', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_version_drift',
      path: 'decisions/version-drift.pkf',
      parentVersion: 7,
      contentHash: 'hash_same_content',
    });
    const queued = slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } })
        : jsonResponse({
            ok: true,
            data: {
              id: 'page_version_drift',
              path: 'decisions/version-drift.pkf',
              version: 5,
              contentHash: 'hash_same_content',
            },
          }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_version_drift',
      path: 'decisions/version-drift.pkf',
      version: 8,
      contentHash: 'hash_same_content',
      authorityEventId: queued.id,
    }])).resolves.toEqual([{
      pageId: 'page_version_drift',
      path: 'decisions/version-drift.pkf',
      version: 5,
      contentHash: 'hash_same_content',
      authority: 'cloud',
      authorityEventId: queued.id,
    }]);
  });

  it('confirmPageReceipts: a later legitimate write superseding the receipt (version forward, hash changed) acks with the cloud-authoritative current value', async () => {
    // 2026-09-07 jiuyou-dd 实测回归——hub 创建 → promote → Contents 重建三连写，
    // v1 的旧 receipt 在 readback 时 hash 恒不匹配且 retryable=false，整轮蒸馏
    // 被误判 terminal_failure（页面内容完好）。版本严格前进 = 已被后续写入覆盖。
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_superseded',
      path: 'projects/jiuyou-dd/overview.pkf',
      contentHash: 'hash_v1',
    });
    const queued = slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } })
        : jsonResponse({
            ok: true,
            data: {
              id: 'page_superseded',
              path: 'projects/jiuyou-dd/overview.pkf',
              version: 3,
              contentHash: 'hash_v3',
            },
          }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_superseded',
      path: 'projects/jiuyou-dd/overview.pkf',
      version: 1,
      contentHash: 'hash_v1',
      authorityEventId: queued.id,
    }])).resolves.toEqual([{
      pageId: 'page_superseded',
      path: 'projects/jiuyou-dd/overview.pkf',
      version: 3,
      contentHash: 'hash_v3',
      authority: 'cloud',
      // 弱确认标记——审计面区分 supersede-ack 与精确确认（评审 F1）
      superseded: true,
      authorityEventId: queued.id,
    }]);
  });

  it('confirmPageReceipts: superseded readback missing contentHash → mismatch (retryable), 不造自洽性谎言', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_superseded_nohash',
      path: 'projects/jiuyou-dd/overview.pkf',
      contentHash: 'hash_v1',
    });
    const queued = slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } })
        : jsonResponse({
            ok: true,
            data: {
              id: 'page_superseded_nohash',
              path: 'projects/jiuyou-dd/overview.pkf',
              version: 3,
              // contentHash 缺失
            },
          }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_superseded_nohash',
      path: 'projects/jiuyou-dd/overview.pkf',
      version: 1,
      contentHash: 'hash_v1',
      authorityEventId: queued.id,
    }])).rejects.toMatchObject({
      code: 'memory_authority_readback_mismatch',
      retryable: true,
    });
  });

  it('confirmPageReceipts: version 回退 + hash 不同 → 真异常维持 mismatch（不因回退方向放行）', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({
      pageId: 'page_regression',
      path: 'decisions/regression.pkf',
      parentVersion: 2, // envelope 匹配要求 parentVersion === receipt.version - 1
      contentHash: 'hash_new',
    });
    const queued = slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } })
        : jsonResponse({
            ok: true,
            data: {
              id: 'page_regression',
              path: 'decisions/regression.pkf',
              version: 1, // receipt 是 3 → 版本回退
              contentHash: 'hash_old',
            },
          }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
    });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_regression',
      path: 'decisions/regression.pkf',
      version: 3,
      contentHash: 'hash_new',
      authorityEventId: queued.id,
    }])).rejects.toMatchObject({
      code: 'memory_authority_readback_mismatch',
      retryable: false,
    });
  });

  it('flushNow: fires onWorkspaceFlushed once per workspace that flushed events', async () => {
    const slot = runtime.resolve('ws_test');
    const e1 = pageUpsertEvent({ pageId: 'page_1' });
    slot.outbox.enqueue(e1);

    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: { acked: [e1.eventId], errors: [] } }),
    );
    const flushed: Array<{ workspaceId: string; count: number }> = [];
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      onWorkspaceFlushed: (workspaceId, count) => flushed.push({ workspaceId, count }),
    });

    await worker.flushNow();
    expect(flushed).toEqual([{ workspaceId: 'ws_test', count: 1 }]);

    // A second flush with nothing pending must NOT fire the hook.
    await worker.flushNow();
    expect(flushed).toHaveLength(1);
  });

  it('flushNow: a throwing onWorkspaceFlushed never breaks the flush loop', async () => {
    const slot = runtime.resolve('ws_test');
    const e1 = pageUpsertEvent({ pageId: 'page_1' });
    slot.outbox.enqueue(e1);

    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: { acked: [e1.eventId], errors: [] } }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      onWorkspaceFlushed: () => {
        throw new Error('boom');
      },
    });

    const r = await worker.flushNow();
    expect(r.flushed).toBe(1);
    expect(slot.outbox.pendingCount()).toBe(0);
  });

  it('flushNow: per-event schema_invalid → dead-letter; others stay pending or get acked', async () => {
    const slot = runtime.resolve('ws_test');
    const e1 = pageUpsertEvent({ pageId: 'page_1' }); // will be acked
    const e2 = pageUpsertEvent({ pageId: 'page_2' }); // will be schema_invalid → DL
    const e3 = pageUpsertEvent({ pageId: 'page_3' }); // will be transient error → stay pending
    slot.outbox.enqueue(e1);
    slot.outbox.enqueue(e2);
    slot.outbox.enqueue(e3);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: {
          acked: [e1.eventId],
          errors: [
            { eventId: e2.eventId, code: 'schema_invalid', message: 'missing field' },
            { eventId: e3.eventId, code: 'internal', message: 'transient db hiccup' },
          ],
        },
      }),
    );
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock as unknown as typeof fetch) });

    const r = await worker.flushNow();
    expect(r.flushed).toBe(1);
    expect(r.deadLettered).toBe(1);
    expect(r.pendingRemain).toBe(1);
    expect(slot.outbox.pendingCount()).toBe(1);
    expect(slot.outbox.deadLetterCount()).toBe(1);
  });

  it('flushNow: structured retryable=false PKF conflict is dead-lettered exactly once', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageUpsertEvent({ pageId: 'page_conflict' });
    slot.outbox.enqueue(event);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: {
          acked: [],
          errors: [{
            eventId: event.eventId,
            code: 'PKF_MEMORY_WRITE_CONFLICT',
            message: 'same commit key, different content',
            retryable: false,
          }],
        },
      }),
    );
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock as unknown as typeof fetch) });

    const first = await worker.flushNow();
    const replay = await worker.flushNow();
    expect(first).toMatchObject({ deadLettered: 1, pendingRemain: 0 });
    expect(replay).toMatchObject({ deadLettered: 0, pendingRemain: 0 });
    expect(slot.outbox.deadLetterCount()).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('flushNow: retryable Page delete conflict stays pending and is retried instead of dead-lettered', async () => {
    const slot = runtime.resolve('ws_test');
    const event = pageDeleteEvent({ pageId: 'page_delete_conflict', parentVersion: 4 });
    slot.outbox.enqueue(event);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            acked: [],
            errors: [
              {
                eventId: event.eventId,
                code: 'MEMORY_PAGE_DELETE_CONFLICT',
                message: 'head advanced',
                retryable: true,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { acked: [event.eventId], errors: [] } }));
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock as unknown as typeof fetch) });

    expect(await worker.flushNow()).toMatchObject({ deadLettered: 0, pendingRemain: 1 });
    expect(slot.outbox.pendingCount()).toBe(1);
    expect(slot.outbox.deadLetterCount()).toBe(0);
    expect(await worker.flushNow()).toMatchObject({ flushed: 1, deadLettered: 0, pendingRemain: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('confirmPageReceipts: different workspaces flush concurrently under keyed locks', async () => {
    const a = runtime.resolve('ws_a');
    const b = runtime.resolve('ws_b');
    const eventA = pageUpsertEvent({ workspaceId: 'ws_a', pageId: 'page_a', path: 'a.pkf', contentHash: 'a'.repeat(64) });
    const eventB = pageUpsertEvent({ workspaceId: 'ws_b', pageId: 'page_b', path: 'b.pkf', contentHash: 'b'.repeat(64) });
    const queuedA = a.outbox.enqueue(eventA);
    const queuedB = b.outbox.enqueue(eventB);
    let postsStarted = 0;
    let releasePosts!: () => void;
    let bothStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePosts = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postsStarted += 1;
        if (postsStarted === 2) bothStarted();
        await blocked;
        const body = JSON.parse(String(init.body)) as { events: Array<{ eventId: string }> };
        return jsonResponse({ ok: true, data: { acked: body.events.map((event) => event.eventId), errors: [] } });
      }
      const pageA = String(input).includes('page_a');
      return jsonResponse({
        ok: true,
        data: {
          id: pageA ? 'page_a' : 'page_b',
          path: pageA ? 'a.pkf' : 'b.pkf',
          version: 1,
          contentHash: pageA ? 'a'.repeat(64) : 'b'.repeat(64),
        },
      });
    });
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock as unknown as typeof fetch) });

    const confirming = Promise.all([
      worker.confirmPageReceipts('ws_a', [{
        pageId: 'page_a', path: 'a.pkf', version: 1, contentHash: 'a'.repeat(64), authorityEventId: queuedA.id,
      }]),
      worker.confirmPageReceipts('ws_b', [{
        pageId: 'page_b', path: 'b.pkf', version: 1, contentHash: 'b'.repeat(64), authorityEventId: queuedB.id,
      }]),
    ]);
    await started;
    expect(postsStarted).toBe(2);
    releasePosts();
    await expect(confirming).resolves.toEqual([
      [expect.objectContaining({ pageId: 'page_a', authority: 'cloud' })],
      [expect.objectContaining({ pageId: 'page_b', authority: 'cloud' })],
    ]);
  });

  it('confirmPageReceipts: exact authorityEventId ignores a large historical outbox', async () => {
    const slot = runtime.resolve('ws_test');
    const target = pageUpsertEvent({
      pageId: 'page_exact', path: 'exact.pkf', contentHash: 'e'.repeat(64),
    });
    const queued = slot.outbox.enqueue(target);
    const db = slot.store.rawDb();
    const insert = db.prepare(
      `INSERT INTO memory_outbox (id, eventType, envelopeJson, idempotencyKey, status, createdAt)
       VALUES (?, 'memory.page.upsert', ?, ?, 'acked', ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`historical_${index}`, '{not-json', `history_${index}`, index);
      }
      db.prepare(`UPDATE memory_outbox SET status='acked', ackedAt=? WHERE id=?`).run(Date.now(), queued.id);
    })();
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      data: { id: 'page_exact', path: 'exact.pkf', version: 1, contentHash: 'e'.repeat(64) },
    }));
    const worker = new MemoryOutboxWorker({ runtime, cloud: mockCloud(fetchMock) });

    await expect(worker.confirmPageReceipts('ws_test', [{
      pageId: 'page_exact', path: 'exact.pkf', version: 1, contentHash: 'e'.repeat(64), authorityEventId: queued.id,
    }])).resolves.toEqual([
      expect.objectContaining({ pageId: 'page_exact', version: 1, authority: 'cloud' }),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('flushNow: 5xx response → all events stay pending, transientFailures bumped', async () => {
    const slot = runtime.resolve('ws_test');
    slot.outbox.enqueue(pageUpsertEvent());

    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code: 'cloud_down' } }, 503));
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const r = await worker.flushNow();
    expect(r.flushed).toBe(0);
    expect(r.deadLettered).toBe(0);
    expect(r.pendingRemain).toBe(1);
    expect(r.transientFailures).toBe(1);
    expect(slot.outbox.pendingCount()).toBe(1);
  });

  it('flushNow: 4xx whole-batch (e.g. 403 actor mismatch) → events stay pending + transient', async () => {
    const slot = runtime.resolve('ws_test');
    slot.outbox.enqueue(pageUpsertEvent());

    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: 'forbidden', message: 'actor mismatch' } }, 403),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const r = await worker.flushNow();
    expect(r.flushed).toBe(0);
    expect(r.pendingRemain).toBe(1);
    expect(r.transientFailures).toBe(1);
  });

  it('flushNow: network failure (status=0) → all stay pending; consecutive count rolls forward', async () => {
    const slot = runtime.resolve('ws_test');
    slot.outbox.enqueue(pageUpsertEvent());

    const fetchMock = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      maxConsecutiveFailures: 2,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const r1 = await worker.flushNow();
    const r2 = await worker.flushNow();
    expect(r1.transientFailures).toBe(1);
    expect(r2.transientFailures).toBe(1);
    expect(slot.outbox.pendingCount()).toBe(1);
  });

  it('start/stop: background tick fires + can be cancelled cleanly', async () => {
    const slot = runtime.resolve('ws_test');
    slot.outbox.enqueue(pageUpsertEvent());

    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: { acked: [], errors: [] } }),
    );
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      pollIntervalMs: 50,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    worker.start();
    await new Promise((r) => setTimeout(r, 130)); // ~2 ticks
    worker.stop();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('successful flush after consecutive failures resets the failure counter', async () => {
    const slot = runtime.resolve('ws_test');
    slot.outbox.enqueue(pageUpsertEvent());

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return jsonResponse({ ok: false, error: { code: 'cloud_down' } }, 503);
      return jsonResponse({ ok: true, data: { acked: [], errors: [] } });
    });
    const worker = new MemoryOutboxWorker({
      runtime,
      cloud: mockCloud(fetchMock as unknown as typeof fetch),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const r1 = await worker.flushNow();
    expect(r1.transientFailures).toBe(1);
    const r2 = await worker.flushNow();
    expect(r2.transientFailures).toBe(0);
  });
});

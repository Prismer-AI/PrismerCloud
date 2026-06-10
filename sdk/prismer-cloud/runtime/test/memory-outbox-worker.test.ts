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

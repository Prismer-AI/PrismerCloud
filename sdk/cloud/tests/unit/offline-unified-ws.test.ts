/**
 * release203/12 P3.1 — OfflineManager continuous sync over the unified single
 * WebSocket (`WS /ws/realtime`). Verifies the WS transport is preferred, frames
 * are demuxed (ch:'sync'), the cursor advances, control frames behave, and the
 * tasks channel is ignored — behaviour-preserving vs the legacy SSE path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStorage } from '../../src/storage';
import { OfflineManager } from '../../src/offline';
import type { RequestFn } from '../../src/types';

/** Minimal driveable WebSocket mock matching the browser surface offline.ts uses. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  // ── drivers ──
  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  frame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
}

function make() {
  MockWebSocket.instances = [];
  const storage = new MemoryStorage();
  const requestFn = vi.fn(async () => ({ ok: true, data: {} }));
  const offline = new OfflineManager(storage, requestFn as unknown as RequestFn, {
    syncOnConnect: false,
    outboxFlushInterval: 100_000,
    WebSocket: MockWebSocket as unknown as new (url: string) => WebSocket,
  });
  offline.tokenProvider = () => 'sk-prismer-test';
  return { storage, offline };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('OfflineManager — unified WS continuous sync', () => {
  let offline: OfflineManager;
  let storage: MemoryStorage;

  beforeEach(async () => {
    ({ offline, storage } = make());
    await offline.init();
  });
  afterEach(async () => {
    await offline.destroy();
  });

  it('prefers the WS transport and hits /ws/realtime with since=', async () => {
    await offline.startContinuousSync();
    expect(MockWebSocket.instances.length).toBe(1);
    const url = MockWebSocket.instances[0]!.url;
    expect(url).toContain('/ws/realtime');
    expect(url).toContain('token=sk-prismer-test');
    expect(url).toContain('since=0');
    expect(url.startsWith('ws')).toBe(true); // ws:// (http base → ws)
  });

  it('demuxes ch:sync frames → applies event + advances cursor + emits progress', async () => {
    const progress: number[] = [];
    offline.on('sync.progress', () => progress.push(1));
    await offline.startContinuousSync();
    const sock = MockWebSocket.instances[0]!;
    sock.fireOpen();
    sock.frame({
      ch: 'sync',
      name: 'sync',
      data: {
        seq: 42,
        type: 'message.new',
        conversationId: 'c1',
        data: { id: 'm1', conversationId: 'c1', content: 'hi', type: 'text', senderId: 'u2' },
      },
    });
    await tick();
    expect(progress.length).toBe(1);
    expect(await storage.getCursor('global_sync')).toBe('42');
  });

  it('caught_up emits sync.complete; heartbeat is ignored', async () => {
    let completed = false;
    offline.on('sync.complete', () => {
      completed = true;
    });
    await offline.startContinuousSync();
    const sock = MockWebSocket.instances[0]!;
    sock.fireOpen();
    sock.frame({ name: 'heartbeat' });
    await tick();
    expect(completed).toBe(false);
    sock.frame({ name: 'caught_up', cursor: 0 });
    await tick();
    expect(completed).toBe(true);
  });

  it('backfill.truncated jumps the cursor to newestSeq (no replay storm)', async () => {
    await offline.startContinuousSync();
    const sock = MockWebSocket.instances[0]!;
    sock.fireOpen();
    sock.frame({ ch: 'sync', name: 'sync', data: { type: 'sync.backfill.truncated', newestSeq: 500 } });
    await tick();
    expect(await storage.getCursor('global_sync')).toBe('500');
  });

  it('ignores the tasks channel (does not advance the sync cursor)', async () => {
    await offline.startContinuousSync();
    const sock = MockWebSocket.instances[0]!;
    sock.fireOpen();
    sock.frame({ ch: 'tasks', name: 'task.updated', data: { taskId: 't1', seq: 99 } });
    await tick();
    // cursor untouched (no global_sync cursor written yet → null)
    expect(await storage.getCursor('global_sync')).toBeNull();
  });

  it('falls back to SSE/polling path when unifiedWs is disabled', async () => {
    const storage2 = new MemoryStorage();
    const requestFn = vi.fn(async () => ({ ok: true, data: {} }));
    const off2 = new OfflineManager(storage2, requestFn as unknown as RequestFn, {
      syncOnConnect: false,
      outboxFlushInterval: 100_000,
      unifiedWs: false,
      WebSocket: MockWebSocket as unknown as new (url: string) => WebSocket,
    });
    off2.tokenProvider = () => 'sk-prismer-test';
    await off2.init();
    await off2.startContinuousSync();
    // unifiedWs:false → no WS opened (SSE undefined in Node → polled instead)
    expect(MockWebSocket.instances.length).toBe(0);
    await off2.destroy();
  });
});

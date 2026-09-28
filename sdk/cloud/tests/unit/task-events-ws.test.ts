/**
 * release203/12 P3.1 — IMRealtimeClient.subscribeTaskEvents over the unified
 * single WebSocket (`ch:'tasks'`). Verifies demux, control-frame + sync-channel
 * filtering, and that the ws(s) /ws/realtime URL is used.
 */
import { describe, it, expect, vi } from 'vitest';
import { IMRealtimeClient } from '../../src/index';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  frame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
}

describe('subscribeTaskEvents — unified WS', () => {
  it('demuxes ch:tasks frames, ignores control + sync, derives ws URL', async () => {
    MockWebSocket.instances = [];
    const client = new IMRealtimeClient('https://cloud.test');
    const got: Array<{ type: string; payload: unknown }> = [];

    const sub = await client.subscribeTaskEvents('sk-x', (e) => got.push(e), {
      WebSocket: MockWebSocket as unknown as new (url: string) => WebSocket,
    });

    expect(MockWebSocket.instances.length).toBe(1);
    const sock = MockWebSocket.instances[0]!;
    expect(sock.url).toContain('/ws/realtime');
    expect(sock.url.startsWith('wss://cloud.test')).toBe(true);
    expect(sock.url).toContain('token=sk-x');

    sock.frame({ name: 'heartbeat' });
    sock.frame({ ch: 'sync', name: 'sync', data: { seq: 1 } }); // ignored
    sock.frame({ ch: 'tasks', name: 'task.completed', data: { taskId: 't1' } });
    sock.frame({ ch: 'tasks', name: 'task.progress', data: { taskId: 't1', pct: 50 } });

    expect(got).toEqual([
      { type: 'task.completed', payload: { taskId: 't1' } },
      { type: 'task.progress', payload: { taskId: 't1', pct: 50 } },
    ]);

    sub.disconnect();
    expect(sock.closed).toBe(true);
  });

  it('falls back to SSE (fetch) when unifiedWs is disabled', async () => {
    MockWebSocket.instances = [];
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503, body: null });
    const client = new IMRealtimeClient('https://cloud.test', fetchFn as unknown as typeof fetch);

    await expect(
      client.subscribeTaskEvents('sk-x', () => {}, {
        unifiedWs: false,
        WebSocket: MockWebSocket as unknown as new (url: string) => WebSocket,
      }),
    ).rejects.toThrow();
    expect(MockWebSocket.instances.length).toBe(0); // WS not used
    expect(fetchFn).toHaveBeenCalledOnce(); // SSE path taken
  });
});

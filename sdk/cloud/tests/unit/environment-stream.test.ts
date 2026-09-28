/**
 * Unit tests for `connectEaasEvents` (`src/environment-stream.ts`).
 *
 * SSE: a mock fetch returns a ReadableStream feeding hand-built SSE frames —
 * asserts the Authorization header is sent (token never travels in the URL),
 * frames are parsed into envelopes, duplicate eventIds are deduped via the
 * 1024-entry LRU, and `eaas.resync` triggers onResync + the handle's
 * `resynced` promise.
 *
 * WS: a fake WebSocket constructor verifies the first-frame `{type:'auth'}`
 * handshake, the follow-up `subscribe` frame, and event delivery.
 *
 * Usage:
 *   cd sdk/cloud && npx vitest run tests/unit/environment-stream.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { connectEaasEvents } from '../../src/environment-stream';
import { EaasClientError } from '../../src/environment-contract';
import type { EaasEventEnvelope } from '../../src/environment-contract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(cursor: string, type = 'environment.ready'): EaasEventEnvelope {
  return {
    v: 1,
    eventId: `tnt_1:${cursor}`,
    cursor,
    type,
    at: '2026-09-08T00:00:00.000Z',
    environmentId: 'env_a',
    payload: { cursor },
  };
}

function sseFrame(env: EaasEventEnvelope): string {
  return `id: ${env.cursor}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** Wait until `pred()` is true (polling the microtask queue), else fail after ~2s. */
async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for stream condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Minimal fake WebSocket mirroring the DOM surface used by the client. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== cb));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closed = true;
    this.dispatch('close', {});
  }

  // -- test-side pumps -------------------------------------------------------

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  serverMessage(obj: unknown): void {
    this.dispatch('message', { data: JSON.stringify(obj) });
  }

  /** Server-side close with an application code (4401 revoke / 4404 FF off / …). */
  serverClose(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closed = true;
    this.dispatch('close', { code, reason });
  }

  private dispatch(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

// ---------------------------------------------------------------------------
// SSE transport
// ---------------------------------------------------------------------------

describe('connectEaasEvents — SSE', () => {
  it('connects with Authorization header + Accept text/event-stream and delivers parsed frames', async () => {
    const e1 = envelope('42', 'environment.created');
    const e2 = envelope('43', 'environment.ready');
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseFrame(e1), sseFrame(e2)]));
    const onEvent = vi.fn();

    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'sk-eaas-live-streamtoken',
      transport: 'sse',
      onEvent,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eaas.example.com/api/v1/events');
    const headers = init.headers as Record<string, string>;
    // Token travels in the Authorization header — never as a ?token= query param.
    expect(headers['Authorization']).toBe('Bearer sk-eaas-live-streamtoken');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(url).not.toContain('token=');

    await until(() => onEvent.mock.calls.length >= 2);
    expect(onEvent.mock.calls[0][0]).toEqual(e1);
    expect(onEvent.mock.calls[1][0]).toEqual(e2);
    handle.disconnect();
  });

  it('forwards cursor and filters as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com/',
      token: 'tok',
      transport: 'sse',
      cursor: '41',
      filters: { environmentIds: ['env_a', 'env_b'], projectIds: ['prj_1'] },
      onEvent: () => {},
      fetch: fetchMock as unknown as typeof fetch,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/events?');
    expect(url).toContain('cursor=41');
    expect(url).toContain('environmentIds=env_a%2Cenv_b');
    expect(url).toContain('projectIds=prj_1');
    handle.disconnect();
  });

  it('deduplicates repeated eventIds (LRU seen-set)', async () => {
    const e = envelope('44');
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseFrame(e), sseFrame(e), sseFrame(e)]));
    const onEvent = vi.fn();

    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'sse',
      onEvent,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await until(() => onEvent.mock.calls.length >= 1);
    // Give the reader a chance to process the duplicates before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toEqual(e);
    handle.disconnect();
  });

  it('eaas.resync frame triggers onResync and resolves handle.resynced', async () => {
    const resyncFrame = 'event: eaas.resync\ndata: {"code":"eaas.resync","lastSeq":"99"}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([resyncFrame]));
    const onResync = vi.fn();

    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'sse',
      cursor: '1000',
      onEvent: () => {},
      onResync,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await handle.resynced;
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledWith(expect.objectContaining({ code: 'eaas.resync', lastSeq: '99' }));
    handle.disconnect();
  });

  it('ignores heartbeat comments and retry hints without emitting events', async () => {
    const e = envelope('45');
    const frames = ['retry: 3000\n\n', ':ka\n\n', ':ka\n\n', sseFrame(e), ':ka\n\n'];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frames));
    const onEvent = vi.fn();

    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'sse',
      onEvent,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await until(() => onEvent.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(onEvent).toHaveBeenCalledTimes(1);
    handle.disconnect();
  });

  it('throws when the SSE response is not ok (e.g. FF off 404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    await expect(
      connectEaasEvents({
        baseUrl: 'https://eaas.example.com',
        token: 'tok',
        transport: 'sse',
        onEvent: () => {},
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// WS transport
// ---------------------------------------------------------------------------

describe('connectEaasEvents — WS', () => {
  it('auth-first handshake: {type:auth} on open, subscribe after authorized', async () => {
    FakeWebSocket.instances = [];
    const onEvent = vi.fn();

    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'sk-eaas-live-wstoken',
      transport: 'ws',
      cursor: '7',
      filters: { projectIds: ['prj_1'] },
      onEvent,
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws.url).toBe('wss://eaas.example.com/ws/eaas/v1');

    ws.serverOpen();
    // First frame must be auth with the raw token (not in the URL).
    expect(ws.sent[0]).toEqual({ type: 'auth', token: 'sk-eaas-live-wstoken' });
    expect(ws.url).not.toContain('token=');

    ws.serverMessage({ type: 'authorized', lastSeq: '7' });
    const handle = await pending;

    // Subscribe frame follows authorized, carrying cursor + filters.
    expect(ws.sent[1]).toEqual({ type: 'subscribe', cursor: '7', projectIds: ['prj_1'] });

    ws.serverMessage({ type: 'event', event: envelope('8', 'environment.warm') });
    await until(() => onEvent.mock.calls.length >= 1);
    expect(onEvent.mock.calls[0][0]).toEqual(envelope('8', 'environment.warm'));

    handle.disconnect();
    expect(ws.closed).toBe(true);
  });

  it('eaas.resync WS frame triggers onResync and resolves resynced', async () => {
    FakeWebSocket.instances = [];
    const onResync = vi.fn();

    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'ws',
      onEvent: () => {},
      onResync,
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.serverOpen();
    ws.serverMessage({ type: 'authorized', lastSeq: '1' });
    const handle = await pending;

    ws.serverMessage({ type: 'eaas.resync', lastSeq: '50' });
    await handle.resynced;
    expect(onResync).toHaveBeenCalledWith(expect.objectContaining({ lastSeq: '50' }));
    handle.disconnect();
  });

  it('rejects when the socket errors before authorized', async () => {
    FakeWebSocket.instances = [];
    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'ws',
      onEvent: () => {},
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.serverOpen();
    ws.dispatch('error', {});
    await expect(pending).rejects.toBeInstanceOf(EaasClientError);
    await expect(pending).rejects.toMatchObject({ code: 'ws_connect_failed' });
  });

  it('rejects close-before-authorized as EaasClientError with close details', async () => {
    FakeWebSocket.instances = [];
    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'ws',
      onEvent: () => {},
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.serverOpen();
    ws.serverClose(4401, 'invalid token');
    await expect(pending).rejects.toBeInstanceOf(EaasClientError);
    await expect(pending).rejects.toMatchObject({
      code: 'ws_authorization_failed',
      message: expect.stringContaining('4401'),
    });
  });
});

// ---------------------------------------------------------------------------
// Stream death must be visible — onEnd (fix round 1, review I1)
// ---------------------------------------------------------------------------

describe('connectEaasEvents — onEnd (stream death surfaced)', () => {
  it('WS close after authorized triggers onEnd carrying the close code (4401 revocation)', async () => {
    FakeWebSocket.instances = [];
    const onEnd = vi.fn();

    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'ws',
      onEvent: () => {},
      onEnd,
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.serverOpen();
    ws.serverMessage({ type: 'authorized', lastSeq: '1' });
    const handle = await pending;

    // Server kills the connection (token revocation → close 4401).
    ws.serverClose(4401, 'token revoked');
    await until(() => onEnd.mock.calls.length >= 1);
    expect(onEnd).toHaveBeenCalledWith({ transport: 'ws', code: 4401, reason: 'token revoked' });

    // disconnect() after an already-ended stream must not double-fire.
    handle.disconnect();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('WS transport error after authorized triggers onEnd', async () => {
    FakeWebSocket.instances = [];
    const onEnd = vi.fn();

    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'ws',
      onEvent: () => {},
      onEnd,
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.serverOpen();
    ws.serverMessage({ type: 'authorized', lastSeq: '1' });
    await pending;

    ws.dispatch('error', {});
    await until(() => onEnd.mock.calls.length >= 1);
    expect(onEnd).toHaveBeenCalledWith({ transport: 'ws', reason: 'connection error' });
  });

  it('WS error frame (subscribe rejected) surfaces through onEnd with the server message', async () => {
    FakeWebSocket.instances = [];
    const onEnd = vi.fn();

    const pending = connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'ws',
      onEvent: () => {},
      onEnd,
      WebSocket: FakeWebSocket as unknown as new (url: string) => WebSocket,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.serverOpen();
    ws.serverMessage({ type: 'authorized', lastSeq: '1' });
    await pending;

    ws.serverMessage({ type: 'error', message: 'subscribe rejected: scope_denied' });
    await until(() => onEnd.mock.calls.length >= 1);
    expect(onEnd).toHaveBeenCalledWith({ transport: 'ws', reason: 'subscribe rejected: scope_denied' });
  });

  it('SSE natural stream end triggers onEnd; caller disconnect does not double-fire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseFrame(envelope('46'))]));
    const onEnd = vi.fn();

    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'sse',
      onEvent: () => {},
      onEnd,
      fetch: fetchMock as unknown as typeof fetch,
    });

    // The mock stream closes right after its frames — onEnd must fire.
    await until(() => onEnd.mock.calls.length >= 1);
    expect(onEnd).toHaveBeenCalledWith({ transport: 'sse', reason: 'stream ended' });

    handle.disconnect();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('caller-initiated disconnect never triggers onEnd (silence is caller-own decision)', async () => {
    // A stream that would otherwise end naturally; we disconnect before that.
    let closeStream: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(':ka\n\n'));
        closeStream = () => controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);
    const onEnd = vi.fn();

    const handle = await connectEaasEvents({
      baseUrl: 'https://eaas.example.com',
      token: 'tok',
      transport: 'sse',
      onEvent: () => {},
      onEnd,
      fetch: fetchMock as unknown as typeof fetch,
    });

    handle.disconnect();
    closeStream!();
    await new Promise((r) => setTimeout(r, 30));
    expect(onEnd).not.toHaveBeenCalled();
  });
});

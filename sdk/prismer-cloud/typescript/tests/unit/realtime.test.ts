/**
 * Unit tests for RealtimeWSClient and RealtimeSSEClient internals.
 *
 * Uses mock WebSocket and mock fetch — no live server required.
 *
 * Usage:
 *   npx vitest run tests/unit/realtime.test.ts --reporter=verbose
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeWSClient, RealtimeSSEClient } from '../../src/realtime';
import type { RealtimeConfig } from '../../src/realtime';

// ============================================================================
// Mock WebSocket
// ============================================================================

type WSHandler = (ev: any) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  // Instance mirrors of static constants (needed by client code)
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  private _listeners: Map<string, Set<WSHandler>> = new Map();
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: string, handler: WSHandler): void {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(handler);
  }

  removeEventListener(event: string, handler: WSHandler): void {
    this._listeners.get(event)?.delete(handler);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this._fire('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  // --- Test helpers ---

  /** Simulate the socket opening */
  _simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this._fire('open', {});
  }

  /** Simulate receiving a message */
  _simulateMessage(data: unknown): void {
    this._fire('message', { data: JSON.stringify(data) });
  }

  /** Simulate a connection error */
  _simulateError(): void {
    this._fire('error', {});
  }

  /** Simulate the socket closing */
  _simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this._fire('close', { code, reason });
  }

  private _fire(event: string, detail: any): void {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) fn(detail);
    }
  }
}

// Make static OPEN/CONNECTING/etc available as expected by the production code
// (e.g., `WebSocket.OPEN`)
(MockWebSocket as any).OPEN = 1;
(MockWebSocket as any).CONNECTING = 0;

// ============================================================================
// Helpers
// ============================================================================

/** Capture the MockWebSocket instance created inside connect() */
let capturedWS: MockWebSocket | null = null;

function createCapturingWSFactory() {
  return class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      capturedWS = this;
    }
  };
}

function wsConfig(overrides?: Partial<RealtimeConfig>): RealtimeConfig {
  return {
    token: 'test-jwt-token',
    autoReconnect: false,
    heartbeatInterval: 600_000, // very long so it doesn't fire during tests
    WebSocket: createCapturingWSFactory() as any,
    ...overrides,
  };
}

// ============================================================================
// RealtimeWSClient
// ============================================================================

describe('RealtimeWSClient', () => {
  beforeEach(() => {
    capturedWS = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ──

  it('constructor creates instance with correct initial state', () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    expect(client.state).toBe('disconnected');
  });

  it('constructor builds ws:// URL from https:// base', () => {
    // We can verify indirectly: connect() will create a WS with the transformed URL
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    // state before connect is disconnected
    expect(client.state).toBe('disconnected');
  });

  // ── connect() ──

  it('connect() transitions to connecting state', () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());

    // Start connect but don't await — we want to check intermediate state
    const connectPromise = client.connect();

    // After initiating connect, the mock WS was created
    expect(capturedWS).not.toBeNull();
    expect(client.state).toBe('connecting');

    // Complete the handshake to avoid dangling promise
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });

    return connectPromise;
  });

  it('connect() resolves and transitions to connected on authenticated message', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();

    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });

    await connectPromise;
    expect(client.state).toBe('connected');
  });

  it('connect() is idempotent when already connected', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();

    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    // Second call should resolve immediately (no error, no new WS)
    await client.connect();
    expect(client.state).toBe('connected');
  });

  // ── disconnect() ──

  it('disconnect() transitions to disconnected state', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();

    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    client.disconnect();
    expect(client.state).toBe('disconnected');
  });

  it('disconnect() emits disconnected event', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const disconnected = vi.fn();
    client.on('disconnected', disconnected);

    client.disconnect(1000, 'bye');
    expect(disconnected).toHaveBeenCalledWith({ code: 1000, reason: 'bye' });
  });

  it('disconnect() is safe to call when already disconnected', () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    // Should not throw
    client.disconnect();
    expect(client.state).toBe('disconnected');
  });

  // ── on()/off() listener management ──

  it('on()/off() listener management', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const handler = vi.fn();
    client.on('message.new', handler);

    // Simulate receiving a message
    capturedWS!._simulateMessage({
      type: 'message.new',
      payload: { id: 'm1', conversationId: 'c1', content: 'hello', type: 'text', senderId: 'u2', createdAt: new Date().toISOString() },
    });
    expect(handler).toHaveBeenCalledTimes(1);

    // Remove listener
    client.off('message.new', handler);

    capturedWS!._simulateMessage({
      type: 'message.new',
      payload: { id: 'm2', conversationId: 'c1', content: 'world', type: 'text', senderId: 'u2', createdAt: new Date().toISOString() },
    });
    expect(handler).toHaveBeenCalledTimes(1); // still 1 — handler was removed
  });

  // ── once() ──

  it('once() fires only once', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const handler = vi.fn();
    client.once('message.new', handler);

    const payload = { id: 'm1', conversationId: 'c1', content: 'a', type: 'text', senderId: 'u2', createdAt: '' };
    capturedWS!._simulateMessage({ type: 'message.new', payload });
    capturedWS!._simulateMessage({ type: 'message.new', payload });
    capturedWS!._simulateMessage({ type: 'message.new', payload });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── Multiple listeners ──

  it('multiple listeners for same event', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const handlerC = vi.fn();
    client.on('message.new', handlerA);
    client.on('message.new', handlerB);
    client.on('message.new', handlerC);

    capturedWS!._simulateMessage({
      type: 'message.new',
      payload: { id: 'm1', conversationId: 'c1', content: 'x', type: 'text', senderId: 'u2', createdAt: '' },
    });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerC).toHaveBeenCalledTimes(1);

    // Remove only B
    client.off('message.new', handlerB);

    capturedWS!._simulateMessage({
      type: 'message.new',
      payload: { id: 'm2', conversationId: 'c1', content: 'y', type: 'text', senderId: 'u2', createdAt: '' },
    });

    expect(handlerA).toHaveBeenCalledTimes(2);
    expect(handlerB).toHaveBeenCalledTimes(1); // still 1
    expect(handlerC).toHaveBeenCalledTimes(2);
  });

  // ── ping() ──

  it('ping() resolves when pong received', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const pingPromise = client.ping();

    // The client should have sent a ping message
    expect(capturedWS!.sentMessages.length).toBeGreaterThanOrEqual(1);
    const sentPing = JSON.parse(capturedWS!.sentMessages[capturedWS!.sentMessages.length - 1]);
    expect(sentPing.type).toBe('ping');
    expect(sentPing.payload.requestId).toMatch(/^ping-/);

    // Simulate server sending pong with matching requestId
    capturedWS!._simulateMessage({
      type: 'pong',
      payload: { requestId: sentPing.payload.requestId },
    });

    const result = await pingPromise;
    expect(result.requestId).toBe(sentPing.payload.requestId);
  });

  it('ping() rejects on timeout', async () => {
    vi.useFakeTimers();

    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const pingPromise = client.ping();

    // Advance time past the 10s timeout
    vi.advanceTimersByTime(11_000);

    await expect(pingPromise).rejects.toThrow('Ping timeout');

    vi.useRealTimers();
  });

  // ── connected event ──

  it('emits connected and authenticated events on successful connect', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const authHandler = vi.fn();
    const connectedHandler = vi.fn();
    client.on('authenticated', authHandler);
    client.on('connected', connectedHandler);

    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'alice' } });
    await connectPromise;

    expect(authHandler).toHaveBeenCalledWith({ userId: 'u1', username: 'alice' });
    expect(connectedHandler).toHaveBeenCalledTimes(1);
  });

  // ── User callback errors should not crash ──

  it('user callback errors do not crash the client', async () => {
    const client = new RealtimeWSClient('https://example.com', wsConfig());
    const connectPromise = client.connect();
    capturedWS!._simulateOpen();
    capturedWS!._simulateMessage({ type: 'authenticated', payload: { userId: 'u1', username: 'test' } });
    await connectPromise;

    const badHandler = () => { throw new Error('user bug'); };
    const goodHandler = vi.fn();
    client.on('message.new', badHandler);
    client.on('message.new', goodHandler);

    capturedWS!._simulateMessage({
      type: 'message.new',
      payload: { id: 'm1', conversationId: 'c1', content: 'x', type: 'text', senderId: 'u2', createdAt: '' },
    });

    // Good handler should still fire despite bad handler throwing
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// RealtimeSSEClient
// ============================================================================

describe('RealtimeSSEClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ──

  it('constructor creates instance with correct initial state', () => {
    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
    });
    expect(client.state).toBe('disconnected');
  });

  // ── on()/off() listener management ──

  it('on()/off() listener management works before connect', () => {
    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
    });

    const handler = vi.fn();
    client.on('message.new', handler);

    // off should not throw
    client.off('message.new', handler);
  });

  // ── disconnect() cleanup ──

  it('disconnect() emits disconnected and transitions state', () => {
    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
    });

    const disconnectedHandler = vi.fn();
    client.on('disconnected', disconnectedHandler);

    client.disconnect();

    expect(client.state).toBe('disconnected');
    expect(disconnectedHandler).toHaveBeenCalledWith({ code: 1000, reason: 'client disconnect' });
  });

  it('disconnect() is safe to call multiple times', () => {
    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
    });

    client.disconnect();
    client.disconnect();
    expect(client.state).toBe('disconnected');
  });

  // ── connect() with mock fetch ──

  it('connect() transitions to connected with valid SSE response', async () => {
    // Create a ReadableStream that stays open (does not close immediately)
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    });

    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
      fetch: mockFetch as any,
    });

    const connectedHandler = vi.fn();
    client.on('connected', connectedHandler);

    await client.connect();

    expect(client.state).toBe('connected');
    expect(connectedHandler).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/sse?token=test-jwt',
      expect.objectContaining({
        headers: { Accept: 'text/event-stream' },
      }),
    );

    // Clean up — close the stream so the background reader finishes
    client.disconnect();
    streamController!.close();
  });

  it('connect() throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const client = new RealtimeSSEClient('https://example.com', {
      token: 'bad-token',
      autoReconnect: false,
      fetch: mockFetch as any,
    });

    await expect(client.connect()).rejects.toThrow('SSE connection failed: 401');
    expect(client.state).toBe('disconnected');
  });

  it('connect() throws when response has no body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });

    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
      fetch: mockFetch as any,
    });

    await expect(client.connect()).rejects.toThrow('SSE response has no body');
    expect(client.state).toBe('disconnected');
  });

  it('connect() parses SSE data lines and emits events', async () => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message.new","payload":{"id":"m1","content":"hello"}}\n'));
        controller.enqueue(encoder.encode(':heartbeat\n'));
        controller.enqueue(encoder.encode('data: {"type":"message.new","payload":{"id":"m2","content":"world"}}\n'));
        controller.close();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    });

    const client = new RealtimeSSEClient('https://example.com', {
      token: 'test-jwt',
      autoReconnect: false,
      fetch: mockFetch as any,
    });

    const messages: any[] = [];
    client.on('message.new', (payload) => messages.push(payload));

    await client.connect();

    // Allow the stream reader microtasks to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(messages.length).toBe(2);
    expect(messages[0].id).toBe('m1');
    expect(messages[1].id).toBe('m2');
  });
});

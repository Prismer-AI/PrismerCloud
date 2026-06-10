import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { WS_CLOSE, WsClient } from '../src/daemon/ws-client.js';

interface ServerHandle {
  port: number;
  close: () => Promise<void>;
  /** Resolves when the server has accepted at least one connection. */
  awaitConnection: () => Promise<WsServerSocket>;
  closeNextWith?: (code: number, reason?: string) => void;
}

async function startServer(): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      if (typeof addr === 'string' || !addr) return reject(new Error('no address'));
      const port = addr.port;

      const connections: WsServerSocket[] = [];
      const waiters: Array<(s: WsServerSocket) => void> = [];

      wss.on('connection', (sock) => {
        connections.push(sock);
        const w = waiters.shift();
        if (w) w(sock);
      });

      resolve({
        port,
        async close() {
          for (const c of connections) c.close();
          await new Promise<void>((r) => wss.close(() => r()));
        },
        awaitConnection() {
          const next = connections.shift();
          if (next) return Promise.resolve(next);
          return new Promise((r) => waiters.push(r));
        },
      });
    });
  });
}

describe('WsClient', () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('opens, receives a message, sends a message', async () => {
    const client = new WsClient({ url: `ws://127.0.0.1:${server.port}`, apiKey: 'k' });
    const opened = new Promise<void>((r) => client.once('open', () => r()));
    const messageReceived = new Promise<unknown>((r) => client.once('message', (m) => r(m)));

    client.start();
    await opened;
    const sock = await server.awaitConnection();

    const sentByServer: unknown[] = [];
    sock.on('message', (raw) => sentByServer.push(JSON.parse(raw.toString())));
    sock.send(JSON.stringify({ type: 'host.acked', payload: { workspaceId: 'ws_1' } }));
    expect(await messageReceived).toEqual({ type: 'host.acked', payload: { workspaceId: 'ws_1' } });

    client.send({ type: 'agent.host.declare', payload: { agents: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(sentByServer).toEqual([{ type: 'agent.host.declare', payload: { agents: [] } }]);

    client.close();
  });

  it('schedules a reconnect on abnormal close', async () => {
    const client = new WsClient({
      url: `ws://127.0.0.1:${server.port}`,
      apiKey: 'k',
      reconnectInitialMs: 50,
    });
    const opened = new Promise<void>((r) => client.once('open', () => r()));
    client.start();
    await opened;

    const sock = await server.awaitConnection();
    const reconnectScheduled = new Promise<number>((r) =>
      client.once('reconnect-scheduled', (ms) => r(ms as number)),
    );
    sock.close(1011); // server error — triggers reconnect path (1006 is reserved by ws spec)
    expect(await reconnectScheduled).toBe(50);

    client.close();
  });

  it('does NOT reconnect on auth-failed close (4001)', async () => {
    const client = new WsClient({
      url: `ws://127.0.0.1:${server.port}`,
      apiKey: 'k',
      reconnectInitialMs: 50,
    });
    const opened = new Promise<void>((r) => client.once('open', () => r()));
    client.start();
    await opened;

    const sock = await server.awaitConnection();
    let scheduled = false;
    client.on('reconnect-scheduled', () => {
      scheduled = true;
    });
    const authFailed = new Promise<void>((r) => client.once('auth-failed', () => r()));
    sock.close(WS_CLOSE.AUTH);
    await authFailed;
    await new Promise((r) => setTimeout(r, 100));
    expect(scheduled).toBe(false);
  });

  it('emits drop when send() called before open', () => {
    const client = new WsClient({ url: `ws://127.0.0.1:${server.port}`, apiKey: 'k' });
    const dropped: unknown[] = [];
    client.on('drop', (m) => dropped.push(m));
    client.send({ test: 1 });
    expect(dropped).toEqual([{ test: 1 }]);
  });

  it('emits error on invalid JSON received', async () => {
    const client = new WsClient({ url: `ws://127.0.0.1:${server.port}`, apiKey: 'k' });
    const opened = new Promise<void>((r) => client.once('open', () => r()));
    const errored = new Promise<Error>((r) => client.once('error', (e) => r(e as Error)));
    client.start();
    await opened;
    const sock = await server.awaitConnection();
    sock.send('not json');
    expect((await errored).message).toMatch(/Invalid JSON/);
    client.close();
  });

  it('explicit close() prevents auto-reconnect', async () => {
    const client = new WsClient({
      url: `ws://127.0.0.1:${server.port}`,
      apiKey: 'k',
      reconnectInitialMs: 30,
    });
    const opened = new Promise<void>((r) => client.once('open', () => r()));
    client.start();
    await opened;
    let scheduled = false;
    client.on('reconnect-scheduled', () => {
      scheduled = true;
    });
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(scheduled).toBe(false);
  });
});

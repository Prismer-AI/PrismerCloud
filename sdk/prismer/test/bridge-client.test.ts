// spec 11 / Task 4 — daemon bridge client (prismer Hermes gateway platform
// plugin, local TCP JSON-lines).
//
// The oracle is the wire: every test spins a real `net` server that speaks the
// plugin's protocol (adapter.py `_on_client` / `_on_inbound` / `send`) and
// asserts on the bytes it received plus the frames the client surfaced. No
// socket mocking — a mocked socket would prove nothing about the transport.
//
// 4.5 negative control lives in the last describe block: no process is
// listening on the port, and the client must answer with an explicit error
// rather than hanging or raising an unhandled rejection.
//
// `PRISMER_LOG_LEVEL=silent` only silences the transport's own warn lines — the
// non-silence contract is asserted through typed results / callbacks
// (`BridgeSendResult`, `BridgeProbeResult`, `onMalformed`, the
// `waitForConnected` rejection), never by scraping log text.

process.env.PRISMER_LOG_LEVEL = 'silent';

import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_DEFAULT_HOST,
  BridgeClient,
  buildInboundFrame,
  parseOutboundFrame,
  probeBridge,
  type BridgeOutboundFrame,
} from '../src/adapters/persistence/hermes/bridge-client.js';

// ---------------------------------------------------------------------------
// Harness — fake bridge mirroring plugins/prismer/adapter.py on the wire.
// ---------------------------------------------------------------------------

interface FakeBridge {
  port: number;
  /** One entry per accepted connection, in order. */
  connections: Socket[];
  /** Every newline-delimited line received, across all connections. */
  lines: string[];
  waitForLine(predicate: (line: string) => boolean, timeoutMs?: number): Promise<string>;
  waitForConnections(count: number, timeoutMs?: number): Promise<void>;
  dropAllConnections(): void;
  close(): Promise<void>;
}

interface Harness {
  bridge: FakeBridge;
  client: BridgeClient;
  outbound: BridgeOutboundFrame[];
  malformed: Array<{ raw: string; reason: string }>;
  states: string[];
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll instead of sleeping a fixed amount — loopback timing is not a contract. */
async function waitUntil(what: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

async function startFakeBridge(): Promise<FakeBridge> {
  const connections: Socket[] = [];
  const lines: string[] = [];

  const server: Server = createServer((socket: Socket) => {
    connections.push(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    // A dropped peer must not take the fake bridge down.
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, BRIDGE_DEFAULT_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake bridge has no port');
  const port = address.port;

  const bridge: FakeBridge = {
    port,
    connections,
    lines,
    async waitForLine(predicate, timeoutMs = 2_000) {
      await waitUntil('a matching line', () => lines.some(predicate), timeoutMs);
      const hit = lines.find(predicate);
      if (hit === undefined) throw new Error('unreachable');
      return hit;
    },
    async waitForConnections(count, timeoutMs = 2_000) {
      await waitUntil(`${count} connections`, () => connections.length >= count, timeoutMs);
    },
    dropAllConnections() {
      for (const socket of connections) socket.destroy();
    },
    async close() {
      bridge.dropAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  cleanup.push(() => bridge.close());
  return bridge;
}

/** Write one outbound frame exactly the way adapter.py::send does. */
function outboundLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    t: 'out',
    chat_id: 'conv-1',
    content: '你好',
    reply_to: null,
    metadata: {},
    message_id: 'mid-1',
    error: null,
    ...overrides,
  })}\n`;
}

/** A port nothing is listening on (bound, then released). */
async function reserveDeadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, BRIDGE_DEFAULT_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startHarness(opts: { autoReconnect?: boolean; reconnectDelayMs?: number } = {}): Promise<Harness> {
  const bridge = await startFakeBridge();
  const outbound: BridgeOutboundFrame[] = [];
  const malformed: Array<{ raw: string; reason: string }> = [];
  const states: string[] = [];
  const client = new BridgeClient({
    port: bridge.port,
    connectTimeoutMs: 500,
    reconnectDelayMs: opts.reconnectDelayMs ?? 40,
    autoReconnect: opts.autoReconnect ?? true,
    onOutbound: (frame) => outbound.push(frame),
    onMalformed: (raw, reason) => malformed.push({ raw, reason }),
    onStateChange: (state) => states.push(state),
  });
  cleanup.push(() => client.close());
  return { bridge, client, outbound, malformed, states };
}

/**
 * Start the client and wait until BOTH ends agree the socket is up. The
 * client's `connect` and the server's `connection` are not ordered, so a test
 * that touches `bridge.connections` must wait on the server side too.
 */
async function connectClient(bridge: FakeBridge, client: BridgeClient, timeoutMs = 2_000): Promise<void> {
  client.start();
  await client.waitForConnected(timeoutMs);
  await bridge.waitForConnections(1, timeoutMs);
}

// ---------------------------------------------------------------------------

describe('buildInboundFrame', () => {
  it('produces the exact wire shape adapter.py::_on_inbound reads', () => {
    const frame = buildInboundFrame({
      conversationId: 'conv-1',
      senderId: 'user-1',
      senderName: 'Winshare',
      text: '你好',
      messageId: 'mid-1',
      metadata: { kind: 'chat' },
    });
    expect(frame).toEqual({
      t: 'in',
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      sender_name: 'Winshare',
      text: '你好',
      message_id: 'mid-1',
      metadata: { kind: 'chat' },
    });
    // The plugin switches on `t` first and drops anything else silently.
    expect(Object.keys(frame)[0]).toBe('t');
  });

  it('mints a fresh dashless message_id and defaults metadata to {}', () => {
    const a = buildInboundFrame({ conversationId: 'c', senderId: 'u', senderName: 'n', text: 'x' });
    const b = buildInboundFrame({ conversationId: 'c', senderId: 'u', senderName: 'n', text: 'x' });
    expect(a.metadata).toEqual({});
    expect(a.message_id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.message_id).not.toBe(b.message_id);
  });
});

describe('parseOutboundFrame', () => {
  it('parses a full frame and preserves a null reply_to / null error', () => {
    const parsed = parseOutboundFrame(outboundLine().trim());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame).toEqual({
      t: 'out',
      chat_id: 'conv-1',
      content: '你好',
      reply_to: null,
      metadata: {},
      message_id: 'mid-1',
      error: null,
    });
  });

  it('transports reply_to verbatim — anchoring is the gateway’s to set', () => {
    const parsed = parseOutboundFrame(outboundLine({ reply_to: 'mid-earlier' }).trim());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.reply_to).toBe('mid-earlier');
  });

  it('passes a pairing-gate reply through untouched', () => {
    const content = 'hermes pairing approve prismer KX-7781';
    const parsed = parseOutboundFrame(outboundLine({ content }).trim());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.content).toBe(content);
  });

  it('surfaces a gateway-reported delivery failure as a non-null error', () => {
    // The gateway returns this to the *agent* when no daemon is attached; when
    // it does reach the wire it must not read as a healthy empty reply.
    const parsed = parseOutboundFrame(outboundLine({ error: 'no daemon bridge connected' }).trim());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.error).toBe('no daemon bridge connected');
  });

  it('normalises omitted optional fields instead of dropping the reply', () => {
    const parsed = parseOutboundFrame(JSON.stringify({ t: 'out', chat_id: 'c', content: 'x' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame).toEqual({
      t: 'out',
      chat_id: 'c',
      content: 'x',
      reply_to: null,
      metadata: {},
      message_id: '',
      error: null,
    });
  });

  it('rejects malformed lines with an explicit reason and never throws', () => {
    const cases: Array<[string, RegExp]> = [
      ['not json at all', /not JSON/],
      ['[1,2,3]', /not a JSON object/],
      ['"a string"', /not a JSON object/],
      [JSON.stringify({ t: 'in', chat_id: 'c', content: 'x' }), /unexpected t=/],
      [JSON.stringify({ t: 'out', content: 'x' }), /chat_id is not a string/],
      [JSON.stringify({ t: 'out', chat_id: 'c', content: 42 }), /content is not a string/],
      [JSON.stringify({ t: 'out', chat_id: 'c', content: 'x', reply_to: 7 }), /reply_to/],
      [JSON.stringify({ t: 'out', chat_id: 'c', content: 'x', error: 7 }), /error/],
    ];
    for (const [raw, reason] of cases) {
      const parsed = parseOutboundFrame(raw);
      expect(parsed.ok, raw).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error, raw).toMatch(reason);
    }
  });
});

describe('probeBridge', () => {
  it('reports a listening bridge as reachable with a latency', async () => {
    const bridge = await startFakeBridge();
    const result = await probeBridge({ port: bridge.port, timeoutMs: 500 });
    expect(result).toMatchObject({ reachable: true, host: BRIDGE_DEFAULT_HOST, code: null, error: null });
    expect(typeof result.latencyMs).toBe('number');
  });

  // 4.5 negative control — nothing is listening.
  it('resolves reachable:false with ECONNREFUSED against a dead port', async () => {
    const port = await reserveDeadPort();
    const result = await probeBridge({ port, timeoutMs: 500 });
    expect(result.reachable).toBe(false);
    expect(result.code).toBe('ECONNREFUSED');
    expect(result.error).toContain(`${BRIDGE_DEFAULT_HOST}:${port}`);
    expect(result.latencyMs).toBeNull();
  });
});

describe('BridgeClient — connect, send, receive', () => {
  it('connects, delivers an inbound frame byte-exact, and surfaces the reply', async () => {
    const { bridge, client, outbound, states } = await startHarness();
    await connectClient(bridge, client);
    expect(client.isConnected).toBe(true);

    const sent = client.sendInbound({
      conversationId: 'conv-1',
      senderId: 'user-1',
      senderName: 'Winshare',
      text: '你好，世界',
      messageId: 'mid-1',
    });
    expect(sent).toEqual({ ok: true, messageId: 'mid-1' });

    const line = await bridge.waitForLine((l) => l.includes('mid-1'));
    // UTF-8 on the wire, not \u-escaped, newline-terminated — adapter.py does
    // `json.loads(line)` per line and would choke on either deviation.
    expect(line).toContain('你好，世界');
    expect(line).not.toContain('\\u');
    expect(JSON.parse(line)).toEqual({
      t: 'in',
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      sender_name: 'Winshare',
      text: '你好，世界',
      message_id: 'mid-1',
      metadata: {},
    });

    bridge.connections[0]?.write(outboundLine({ reply_to: 'mid-1', content: '收到' }));
    await waitUntil('one outbound frame', () => outbound.length === 1);
    expect(outbound[0]).toMatchObject({ chat_id: 'conv-1', content: '收到', reply_to: 'mid-1', error: null });
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('reassembles a frame split mid multi-byte character across reads', async () => {
    const { bridge, client, outbound } = await startHarness();
    await connectClient(bridge, client);

    const payload = Buffer.from(outboundLine({ content: '中文' }), 'utf8');
    const cut = payload.indexOf(Buffer.from('中', 'utf8')) + 1; // inside a 3-byte char
    expect(cut).toBeGreaterThan(0);
    const socket = bridge.connections[0];
    expect(socket).toBeDefined();
    socket?.write(payload.subarray(0, cut));
    await delay(30);
    expect(outbound).toHaveLength(0); // a half line is never surfaced
    socket?.write(payload.subarray(cut));

    await waitUntil('the reassembled frame', () => outbound.length === 1);
    expect(outbound[0]?.content).toBe('中文');
  });

  it('delivers two frames coalesced into one read, in order', async () => {
    const { bridge, client, outbound } = await startHarness();
    await connectClient(bridge, client);
    bridge.connections[0]?.write(
      outboundLine({ content: '一', message_id: 'm1' }) + outboundLine({ content: '二', message_id: 'm2' }),
    );
    await waitUntil('two outbound frames', () => outbound.length === 2);
    expect(outbound.map((f) => f.message_id)).toEqual(['m1', 'm2']);
  });
});

describe('BridgeClient — reconnect', () => {
  it('reconnects after the gateway drops the socket and carries traffic again', async () => {
    const { bridge, client, states } = await startHarness({ reconnectDelayMs: 250 });
    await connectClient(bridge, client);
    expect(
      client.sendInbound({ conversationId: 'c', senderId: 'u', senderName: 'n', text: '一轮', messageId: 'mid-1' }),
    ).toEqual({ ok: true, messageId: 'mid-1' });
    await bridge.waitForLine((l) => l.includes('mid-1'));

    bridge.dropAllConnections();
    await waitUntil('the drop to register', () => !client.isConnected);
    // A send while detached fails loudly instead of buffering into the void.
    const detached = client.sendInbound({
      conversationId: 'c',
      senderId: 'u',
      senderName: 'n',
      text: '二轮',
      messageId: 'mid-2',
    });
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.error).toMatch(/not connected/);

    await bridge.waitForConnections(2, 3_000);
    await client.waitForConnected(3_000);
    expect(client.isConnected).toBe(true);
    expect(client.connectAttempts).toBeGreaterThanOrEqual(2);

    expect(
      client.sendInbound({ conversationId: 'c', senderId: 'u', senderName: 'n', text: '二轮', messageId: 'mid-2' }),
    ).toEqual({ ok: true, messageId: 'mid-2' });
    await bridge.waitForLine((l) => l.includes('mid-2'));
    expect(states).toEqual(['connecting', 'connected', 'connecting', 'connected']);
  });

  it('close() ends the reconnect loop for good', async () => {
    const { bridge, client } = await startHarness({ reconnectDelayMs: 250 });
    await connectClient(bridge, client);
    bridge.dropAllConnections();
    await waitUntil('the drop to register', () => !client.isConnected);
    await client.close();
    expect(client.connectionState).toBe('closed');

    await delay(400); // > reconnectDelayMs
    expect(bridge.connections.length).toBe(1);
    expect(client.connectionState).toBe('closed');
  });

  it('waitForConnected rejects when the client is closed while waiting', async () => {
    const { client } = await startHarness();
    const waiting = client.waitForConnected(2_000);
    await client.close();
    await expect(waiting).rejects.toThrow(/closed/);
  });
});

describe('BridgeClient — malformed frames', () => {
  it('reports each bad line, keeps the healthy ones, and stays connected', async () => {
    const { bridge, client, outbound, malformed } = await startHarness();
    await connectClient(bridge, client);

    const socket = bridge.connections[0];
    expect(socket).toBeDefined();
    socket?.write('}{ not json\n');
    socket?.write(outboundLine({ content: '好', message_id: 'm-ok' }));
    socket?.write(`${JSON.stringify({ t: 'out', content: 'no chat id' })}\n`);
    socket?.write('\n'); // blank line — ignored, not reported

    await waitUntil('the healthy frame', () => outbound.length === 1);
    expect(outbound.map((f) => f.message_id)).toEqual(['m-ok']);
    await waitUntil('both bad lines', () => malformed.length === 2);
    expect(malformed.map((m) => m.reason)).toEqual([
      expect.stringMatching(/not JSON/),
      expect.stringMatching(/chat_id is not a string/),
    ]);
    expect(malformed[0]?.raw).toBe('}{ not json');

    // The transport survived: still connected, still writable.
    expect(client.isConnected).toBe(true);
    expect(
      client.sendInbound({ conversationId: 'c', senderId: 'u', senderName: 'n', text: 'still here', messageId: 'mid-2' })
        .ok,
    ).toBe(true);
    await bridge.waitForLine((l) => l.includes('mid-2'));
  });

  it('rejects a blank-text send locally instead of letting the gateway drop it', async () => {
    const { bridge, client } = await startHarness();
    await connectClient(bridge, client);
    const result = client.sendInbound({ conversationId: 'c', senderId: 'u', senderName: 'n', text: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty text/);
    await delay(30);
    expect(bridge.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4.5 negative control — the bridge process does not exist.
// ---------------------------------------------------------------------------
describe('BridgeClient — negative control: no bridge process', () => {
  it('fails fast with an explicit error, never hangs, never raises unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const port = await reserveDeadPort();
      let fired = 0;
      const client = new BridgeClient({
        port,
        connectTimeoutMs: 300,
        reconnectDelayMs: 40,
        onOutbound: () => {
          fired += 1;
        },
      });
      cleanup.push(() => client.close());
      client.start();

      const startedAt = Date.now();
      await expect(client.waitForConnected(500)).rejects.toThrow(
        new RegExp(`${BRIDGE_DEFAULT_HOST}:${port}.*ECONNREFUSED`),
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(client.isConnected).toBe(false);
      expect(client.lastConnectError).toContain('ECONNREFUSED');
      // The retry loop keeps trying — a missing bridge is not a one-shot error.
      expect(client.connectAttempts).toBeGreaterThanOrEqual(1);

      const sent = client.sendInbound({ conversationId: 'c', senderId: 'u', senderName: 'n', text: 'hello' });
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.error).toMatch(/not connected/);
      expect(fired).toBe(0);

      await client.close();
      await delay(200);
      expect(client.connectionState).toBe('closed');
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('autoReconnect:false gives up after the first failed dial and reports closed', async () => {
    const port = await reserveDeadPort();
    const client = new BridgeClient({
      port,
      connectTimeoutMs: 300,
      autoReconnect: false,
      onOutbound: () => undefined,
    });
    cleanup.push(() => client.close());
    client.start();
    await expect(client.waitForConnected(500)).rejects.toThrow(/unreachable/);
    await delay(100);
    expect(client.connectionState).toBe('closed');
    expect(client.connectAttempts).toBe(1);
    expect(client.lastConnectError).toContain('ECONNREFUSED');
  });
});

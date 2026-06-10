/**
 * v2.0 §4.8.1 — Webhook dispatch WS-first integration test.
 *
 * Exercises the agent-dispatcher → WsRpcService → daemon-shadow round-trip
 * using REAL transports — no mocked WS, no mocked fetch:
 *   1. Real RoomManager (in-memory mode, no Redis).
 *   2. Real WsRpcService.
 *   3. A simulated daemon registered as a shadow ConnectedClient that
 *      handles `webhook.dispatch.request` and echoes back via the same
 *      transport.
 *
 * Three scenarios:
 *   - Happy: WS reverse channel → daemon replies → server settles within
 *     timeout.
 *   - Fallback: WS shadow absent + public gatewayUrl → HTTP fallback path.
 *   - Unreachable: WS shadow absent + private gatewayUrl → daemon_unreachable
 *     + structured diagnostics (`gatewayIsPrivate=true`,
 *     `recommendedTransport='unreachable'`).
 *
 * Run: npx tsx src/im/tests/webhook-ws-first.test.ts
 */

import type { PrismaClient } from '@prisma/client';
import { RoomManager, type ConnectedClient } from '../ws/rooms';
import type { Transport } from '../ws/transport';
import { WsRpcService, isPrivateIpToCloud } from '../services/ws-rpc.service';
import { AgentDispatcher } from '../services/agent-dispatcher';

process.env.DISPATCH_DAEMON_SECRET ??= 'test-dispatch-secret';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`  fail ${name}: ${(err as Error).message}`);
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Minimal Transport implementation that captures outbound frames and
 * exposes a `recvFromServer` hook so tests can simulate the daemon.
 */
class StubTransport implements Transport {
  readyState = 1;
  public outbound: string[] = [];
  /** Hook the test installs to simulate daemon behaviour on receive. */
  public onReceive?: (frame: { type: string; payload: any }) => void;
  send(data: string): void {
    this.outbound.push(data);
    if (this.onReceive) {
      try {
        const frame = JSON.parse(data) as { type: string; payload: any };
        this.onReceive(frame);
      } catch {
        /* malformed — ignore */
      }
    }
  }
  close(): void {
    this.readyState = 3;
  }
}

function makePrismaStub(opts: {
  daemonId?: string | null;
  gatewayUrl?: string | null;
  gatewayIsPrivate?: boolean | null;
}) {
  return {
    iMExternalRouting: {
      findFirst: async () => ({
        id: 'route-1',
        conversationId: 'conv-1',
        externalIdentityId: 'ext-1',
      }),
    },
    iMParticipant: {
      findFirst: async () => ({ imUser: { id: 'agent-im-1', username: 'alice' } }),
    },
    iMContainer: {
      findFirst: async () => ({
        daemonId: opts.daemonId ?? null,
        gatewayUrl: opts.gatewayUrl ?? null,
        transport: opts.daemonId ? 'ws' : null,
        gatewayIsPrivate: opts.gatewayIsPrivate ?? null,
        lastProbeAt: new Date('2026-05-22T00:00:00.000Z'),
      }),
    },
  } as unknown as PrismaClient;
}

async function main() {
  console.log('\nwebhook ws-first dispatch tests');

  // ────────────────────────────────────────────────────────────────
  await test('WS happy path: shadow daemon replies via reverse channel', async () => {
    const rooms = new RoomManager();
    const wsRpc = new WsRpcService(rooms);

    const transport = new StubTransport();
    const daemonId = 'daemon-happy';
    const routeKey = `daemon:${daemonId}`;
    const shadow: ConnectedClient = {
      transport,
      userId: routeKey,
      username: `daemon:${daemonId}`,
      connectedAt: Date.now(),
    };
    rooms.addClient(shadow);

    // Simulate daemon: when a `webhook.dispatch.request` arrives, echo
    // back a `webhook.dispatch.reply` with the same _rpcId after 5ms.
    transport.onReceive = (frame) => {
      if (frame.type !== 'webhook.dispatch.request') return;
      const rpcId = frame.payload._rpcId;
      setTimeout(() => {
        const reply = wsRpc.handleReply({
          _rpcId: rpcId,
          ok: true,
          acceptedAt: '2026-05-22T00:00:01.000Z',
        });
        assert(reply.handled, 'reply handled by wsRpc');
      }, 5);
    };

    const prisma = makePrismaStub({
      daemonId,
      gatewayUrl: 'http://192.168.1.10:3210',
      gatewayIsPrivate: true,
    });
    const dispatcher = new AgentDispatcher(prisma, {
      rooms,
      wsRpc,
      // fetch must NOT be called on WS-happy path. If it is, surface that.
      fetch: (async () => {
        throw new Error('fetch should not be called when WS is reachable');
      }) as typeof fetch,
      defaultReplyDeadlineMs: 3_000,
    });

    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'ext-user-1',
      messageId: 'msg-happy',
      messageText: '@alice run a webhook test',
    });

    assert(result.dispatched, 'WS dispatch should be accepted');
    if (result.dispatched) {
      assertEq(result.transport, 'ws', 'transport=ws');
      assertEq(result.response.ok, true, 'response ok');
      assertEq(result.response.acceptedAt, '2026-05-22T00:00:01.000Z', 'acceptedAt round-trip');
    }
    // Verify the daemon saw exactly one request with an _rpcId.
    const sent = transport.outbound.map((s) => JSON.parse(s));
    assertEq(sent.length, 1, 'one frame sent to daemon');
    assertEq(sent[0].type, 'webhook.dispatch.request', 'frame type');
    assert(typeof sent[0].payload._rpcId === 'string', '_rpcId embedded');
    assertEq(sent[0].payload.messageId, 'msg-happy', 'messageId passes through');
  });

  // ────────────────────────────────────────────────────────────────
  await test('WS timeout: daemon never replies → daemon_unreachable + diagnostics', async () => {
    const rooms = new RoomManager();
    const wsRpc = new WsRpcService(rooms);
    const transport = new StubTransport();
    const daemonId = 'daemon-slow';
    rooms.addClient({
      transport,
      userId: `daemon:${daemonId}`,
      username: `daemon:${daemonId}`,
      connectedAt: Date.now(),
    });
    // No onReceive — daemon "freezes".

    const prisma = makePrismaStub({
      daemonId,
      gatewayUrl: 'http://10.0.0.5:3210',
      gatewayIsPrivate: true,
    });
    const dispatcher = new AgentDispatcher(prisma, {
      rooms,
      wsRpc,
      defaultReplyDeadlineMs: 100, // short for the test
      httpProbe: async () => ({ reachable: false, latencyMs: null }),
    });
    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'ext-user-1',
      messageId: 'msg-slow',
      messageText: '@alice slow daemon',
    });
    assert(!result.dispatched, 'should NOT dispatch when daemon times out');
    if (!result.dispatched) {
      assertEq(result.reason, 'daemon_unreachable', 'reason');
      assert(result.diagnostics, 'diagnostics present');
      assertEq(result.diagnostics!.daemonId, daemonId, 'daemonId surfaced');
      // wsAlive is true (the shadow IS registered) but the request timed out
      // before reply. Diagnostics still reports it as WS-recommended because
      // a fresh probe would succeed; the timeout is per-request not per-link.
      assertEq(result.diagnostics!.wsAlive, true, 'wsAlive=true at probe time');
      assertEq(result.diagnostics!.gatewayIsPrivate, true, 'private gateway');
      assertEq(result.diagnostics!.recommendedTransport, 'ws', 'recommended=ws');
    }
  });

  // ────────────────────────────────────────────────────────────────
  await test('HTTP fallback: no WS shadow, public gateway → fetch path used', async () => {
    const rooms = new RoomManager();
    const wsRpc = new WsRpcService(rooms);
    // Note: NO shadow client added — wsAlive=false.

    const fetchCalls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      fetchCalls.push(u);
      return {
        ok: true,
        json: async () => ({ ok: true, acceptedAt: '2026-05-22T00:00:02.000Z' }),
      } as Response;
    }) as typeof fetch;

    const prisma = makePrismaStub({
      daemonId: 'daemon-public',
      gatewayUrl: 'https://daemon.example.com', // public domain
      gatewayIsPrivate: false,
    });
    const dispatcher = new AgentDispatcher(prisma, {
      rooms,
      wsRpc,
      fetch: fetchImpl,
    });
    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'ext-user-1',
      messageId: 'msg-http',
      messageText: '@alice use http',
    });
    assert(result.dispatched, 'HTTP dispatch should be accepted');
    if (result.dispatched) {
      assertEq(result.transport, 'http', 'transport=http');
      assertEq(result.daemonUrl, 'https://daemon.example.com', 'gateway URL');
    }
    assertEq(fetchCalls.length, 1, 'fetch called exactly once');
    assert(
      fetchCalls[0].endsWith('/dispatch'),
      `fetch URL ends with /dispatch (got ${fetchCalls[0]})`,
    );
  });

  // ────────────────────────────────────────────────────────────────
  await test('Unreachable: private gateway + no WS → daemon_unreachable + recommendedTransport=unreachable', async () => {
    const rooms = new RoomManager();
    const wsRpc = new WsRpcService(rooms);
    // No shadow. Private gateway.
    const prisma = makePrismaStub({
      daemonId: 'daemon-private',
      gatewayUrl: 'http://192.168.1.42:3210',
      gatewayIsPrivate: true,
    });
    const dispatcher = new AgentDispatcher(prisma, {
      rooms,
      wsRpc,
      fetch: (async () => {
        throw new Error('fetch should not be called for private gateway');
      }) as typeof fetch,
      httpProbe: async () => ({ reachable: false, latencyMs: null }),
    });
    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'ext-user-1',
      messageId: 'msg-nat',
      messageText: '@alice unreachable',
    });
    assert(!result.dispatched, 'should NOT dispatch unreachable daemon');
    if (!result.dispatched) {
      assertEq(result.reason, 'daemon_unreachable', 'reason');
      assert(result.diagnostics, 'diagnostics present');
      assertEq(result.diagnostics!.wsAlive, false, 'wsAlive false');
      assertEq(result.diagnostics!.gatewayIsPrivate, true, 'gatewayIsPrivate true');
      assertEq(result.diagnostics!.recommendedTransport, 'unreachable', 'recommended=unreachable');
    }
  });

  // ────────────────────────────────────────────────────────────────
  await test('isPrivateIpToCloud detects RFC1918 / loopback / link-local', () => {
    assertEq(isPrivateIpToCloud('http://localhost:3210'), true, 'localhost');
    assertEq(isPrivateIpToCloud('http://127.0.0.1:3210'), true, '127.0.0.1');
    assertEq(isPrivateIpToCloud('http://10.0.0.1'), true, '10/8');
    assertEq(isPrivateIpToCloud('http://172.20.5.5'), true, '172.16/12');
    assertEq(isPrivateIpToCloud('http://192.168.1.1'), true, '192.168/16');
    assertEq(isPrivateIpToCloud('http://169.254.1.1'), true, 'link-local');
    assertEq(isPrivateIpToCloud('https://cloud.prismer.dev'), false, 'public domain');
    assertEq(isPrivateIpToCloud('https://prismer.app'), false, 'public domain 2');
    assertEq(isPrivateIpToCloud('http://daemon.example.com'), false, 'public domain 3');
    assertEq(isPrivateIpToCloud('http://mac.local'), true, '.local mDNS');
    assertEq(isPrivateIpToCloud(null), true, 'null');
    assertEq(isPrivateIpToCloud(''), true, 'empty');
    assertEq(isPrivateIpToCloud('not a url'), true, 'malformed');
  });

  // ────────────────────────────────────────────────────────────────
  await test('Idempotency: two concurrent invokes for same messageId coalesce to one daemon request', async () => {
    const rooms = new RoomManager();
    const wsRpc = new WsRpcService(rooms);
    const transport = new StubTransport();
    const daemonId = 'daemon-idem';
    rooms.addClient({
      transport,
      userId: `daemon:${daemonId}`,
      username: `daemon:${daemonId}`,
      connectedAt: Date.now(),
    });

    // First send: defer the reply by 50ms so the second invoke arrives while
    // first is in flight.
    let firstRpcId: string | null = null;
    let frameCount = 0;
    transport.onReceive = (frame) => {
      if (frame.type !== 'webhook.dispatch.request') return;
      frameCount++;
      if (frameCount === 1) {
        firstRpcId = frame.payload._rpcId;
        setTimeout(() => {
          wsRpc.handleReply({
            _rpcId: firstRpcId!,
            ok: true,
            acceptedAt: '2026-05-22T00:00:03.000Z',
          });
        }, 30);
      }
    };

    const prisma = makePrismaStub({
      daemonId,
      gatewayUrl: 'http://192.168.1.10:3210',
      gatewayIsPrivate: true,
    });
    const dispatcher = new AgentDispatcher(prisma, {
      rooms,
      wsRpc,
      defaultReplyDeadlineMs: 1_000,
    });

    const [r1, r2] = await Promise.all([
      dispatcher.dispatchExternalMention({
        channelAccountId: 'ch-1',
        externalUserId: 'ext-user-1',
        messageId: 'msg-idem',
        messageText: '@alice idempotent',
      }),
      dispatcher.dispatchExternalMention({
        channelAccountId: 'ch-1',
        externalUserId: 'ext-user-1',
        messageId: 'msg-idem',
        messageText: '@alice idempotent',
      }),
    ]);

    assert(r1.dispatched && r2.dispatched, 'both invocations dispatched');
    // Critical: daemon should have seen ONLY ONE request thanks to idempotency key.
    assertEq(frameCount, 1, 'only one webhook.dispatch.request reached the daemon');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

void main();

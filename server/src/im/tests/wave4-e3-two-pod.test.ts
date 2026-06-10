/**
 * Wave-4 E3 — 2-Pod cross-Pod sendToUser integration test
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * Spins up TWO RoomManager instances in the same process, each backed by
 * its own RedisBackplane connection. They use different POD_IDs and
 * exchange events via Redis Streams — exactly the topology a multi-Pod
 * production deploy uses.
 *
 * Test flow:
 *   1. user-X authenticates on pod-B  →  SADD im:user:X:pods = {pod-B}
 *   2. pod-A calls rooms.sendToUser('X', evt)
 *   3. pod-A:
 *        • localSendToUser → no local conn for X → no-op
 *        • crossPodSendToUser → SMEMBERS → [pod-B] → backplane.sendToPod(pod-B)
 *   4. pod-B's registered handler fires → delivers locally to user-X
 *   5. user-X's mock transport receives the event
 *
 * Run: npx tsx src/im/tests/wave4-e3-two-pod.test.ts
 */

import Redis from 'ioredis';
import { RoomManager, type ConnectedClient } from '../ws/rooms';
import { RedisBackplane, userPodsKey } from '../backplane';
import type { Transport } from '../ws/transport';
import type { WSMessage } from '../types/index';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

class MockTransport implements Transport {
  readonly type = 'websocket' as const;
  readyState = 1;
  received: string[] = [];
  send(data: string) {
    this.received.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
async function waitFor<T>(cond: () => T | undefined | null | false, timeoutMs = 5000, interval = 50): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v) return v as T;
    await sleep(interval);
  }
  throw new Error('waitFor timeout');
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${name}\n    ${msg}`);
    failures.push(`${name}: ${msg}`);
    failed++;
  }
}

interface Pod {
  podId: string;
  redis: Redis;
  rooms: RoomManager;
  backplane: RedisBackplane;
}

async function startPod(idSuffix: string): Promise<Pod> {
  // Each Pod uses its own POD_ID. Set via the constructor-time env read.
  const podId = `wave4-pod-${idSuffix}-${process.pid}-${Date.now()}`;
  process.env.POD_ID = podId; // RoomManager reads this on construct.

  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect();
  // Wait until Redis reports ready — RoomManager defers setup until then.
  await new Promise<void>((resolve, reject) => {
    if (redis.status === 'ready') return resolve();
    redis.once('ready', () => resolve());
    redis.once('error', reject);
  });

  const backplane = new RedisBackplane(redis);
  const rooms = new RoomManager(redis);
  rooms.setBackplane(backplane);
  await rooms.registerPodChannel();

  return { podId, redis, rooms, backplane };
}

async function stopPod(pod: Pod) {
  await pod.backplane.close();
  await pod.redis.del(`pod-${pod.podId}:queue`).catch(() => undefined);
  await pod.redis.quit().catch(() => undefined);
}

// ─── Scenario 1: pod-A sendToUser(X) when X is on pod-B ──────────────

async function scenarioCrossPodUnicast() {
  const podA = await startPod('A');
  const podB = await startPod('B');
  try {
    // Sanity: both pods have distinct ids.
    if (podA.podId === podB.podId) throw new Error('pods share podId — env race');
    if (podA.rooms.getPodId() === podB.rooms.getPodId()) throw new Error('rooms read same podId');

    const userId = `u-${Date.now()}`;
    const transport = new MockTransport();
    const client: ConnectedClient = {
      transport,
      userId,
      username: 'tester',
      connectedAt: Date.now(),
    };
    // User authenticates on pod-B.
    podB.rooms.addClient(client);
    await podB.rooms.onClientConnected(userId);

    // Verify im:user:<userId>:pods SET contains pod-B.
    const members = await podA.redis.smembers(userPodsKey(userId));
    if (!members.includes(podB.podId)) {
      throw new Error(`expected pod-B in member set, got [${members.join(',')}]`);
    }

    // pod-A sends to user — user is NOT locally on pod-A, so it must go
    // via backplane.sendToPod(pod-B).
    const event = { type: 'message.new', payload: { id: 'm1', text: 'hi from pod-A' } } as WSMessage;
    podA.rooms.sendToUser(userId, event);

    // Wait for pod-B's local transport to receive it.
    await waitFor(() => transport.received.length > 0, 10_000);
    const got = JSON.parse(transport.received[0]);
    if (got.type !== 'message.new') throw new Error(`bad event ${transport.received[0]}`);
    if (got.payload?.id !== 'm1') throw new Error(`bad payload ${transport.received[0]}`);

    // Cleanup pod-B disconnect.
    podB.rooms.removeClient(client);
    await podB.rooms.onClientDisconnected(userId, true);
    const afterMembers = await podA.redis.smembers(userPodsKey(userId));
    if (afterMembers.includes(podB.podId)) {
      throw new Error(`expected pod-B removed after disconnect, got [${afterMembers.join(',')}]`);
    }
  } finally {
    await stopPod(podA);
    await stopPod(podB);
  }
}

// ─── Scenario 2: pod-A "restart" — user reconnects to pod-B ──────────
//
// Simulates: user sent message via pod-A which buffered it in ack-tracker
// (in-memory, Pod-local) AND wrote to im_ws_acks (durable). pod-A crashes;
// user's WS reconnects on pod-B. pod-B replays unacked DB rows on auth.

async function scenarioPersistentReplay() {
  const { WSAckPersistentService } = await import('../services/ws-ack-persistent.service');
  const svc = new WSAckPersistentService();

  const userId = `u-replay-${Date.now()}`;
  const ackId = `ack-replay-${Date.now()}`;

  // pod-A: simulate sending message.new with ackId — write to DB only
  // (mimics the rooms.setLocalSendHook → wsAckPersistent.trackOutbound path).
  await svc.trackOutbound(userId, ackId, {
    type: 'message.new',
    ackId,
    payload: { id: 'survivor-1' },
  });

  // pod-A goes down. Verify DB still has the pending row.
  const pending = await svc.getUnacked(userId);
  if (pending.length !== 1) throw new Error(`expected 1 pending, got ${pending.length}`);
  if (pending[0].ackId !== ackId) throw new Error(`wrong ackId ${pending[0].ackId}`);

  // pod-B: on user reconnect, query and replay. Mimic handler.ts logic.
  const rows = await svc.getUnacked(userId);
  if (rows.length !== 1) throw new Error('lost row across "pod restart"');
  // Client ACKs after replay.
  await svc.markAcked(userId, ackId);
  const after = await svc.getUnacked(userId);
  if (after.length !== 0) throw new Error(`expected 0 pending after ack, got ${after.length}`);

  // Cleanup.
  const prisma = (await import('../db')).default;
  await prisma.iMWSAck.deleteMany({ where: { userId } });
}

// ─── Scenario 3: Redis-down — local delivery still works ─────────────

async function scenarioRedisDownLocal() {
  // Build a RoomManager WITHOUT redis (memory-only single-pod).
  const rooms = new RoomManager();
  const userId = `u-localonly-${Date.now()}`;
  const transport = new MockTransport();
  rooms.addClient({ transport, userId, username: 'local', connectedAt: Date.now() });
  rooms.sendToUser(userId, { type: 'message.new', payload: { id: 'local-1' } } as WSMessage);
  if (transport.received.length !== 1) throw new Error('local delivery failed without redis');
  const got = JSON.parse(transport.received[0]);
  if (got.type !== 'message.new') throw new Error('wrong type');
}

// ─── Driver ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Wave-4 E3 — 2-Pod cross-Pod sendToUser ===\n');
  await test('S1. cross-Pod unicast: A.sendToUser → B.localSend', scenarioCrossPodUnicast);
  await test('S2. persistent replay: pod-A "crash" → pod-B replays from DB', scenarioPersistentReplay);
  await test('S3. Redis-down fallback: pure local delivery still works', scenarioRedisDownLocal);
  console.log(`\n=== ${passed} passed / ${failed} failed ===`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  • ' + f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});

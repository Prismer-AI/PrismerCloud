/**
 * Wave-4 E3 — Backplane + persistent ack integration test
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * Runs as a tsx standalone (no vitest) — same pattern as src/im/tests/sync-seq.test.ts.
 * Requires:
 *   • Docker MySQL on localhost:3307 (DATABASE_URL=mysql://prismer:devpass@localhost:3307/prismer_cloud)
 *   • Docker Redis on localhost:6380 (REDIS_URL=redis://localhost:6380)
 *
 * Coverage:
 *   1. InMemoryBackplane pub/sub round-trip
 *   2. InMemoryBackplane streams (enqueue → consume → ack)
 *   3. RedisBackplane pub/sub round-trip (real Redis)
 *   4. RedisBackplane streams (real Redis Streams + consumer group)
 *   5. Cross-Pod unicast simulation: pod-A sends to user on pod-B
 *   6. Persistent ack: trackOutbound → markAcked → getUnacked replay
 *   7. Redis-down resilience: backplane.publish must NOT throw
 *
 * Run: npx tsx src/im/tests/wave4-e3-backplane.test.ts
 */

import Redis from 'ioredis';
import {
  createBackplane,
  InMemoryBackplane,
  RedisBackplane,
  type Backplane,
} from '../backplane';
import {
  WSAckPersistentService,
  isHighPriorityEvent,
} from '../services/ws-ack-persistent.service';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) {
  console.log(`✓ ${name}`);
  passed++;
}
function bad(name: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ ${name}\n    ${msg}`);
  failures.push(`${name}: ${msg}`);
  failed++;
}
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
async function waitFor<T>(cond: () => T | undefined, timeoutMs = 5000, interval = 50): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await sleep(interval);
  }
  throw new Error('waitFor timeout');
}

// ─── 1. InMemoryBackplane pub/sub ───────────────────────────────────

async function testMemoryPubSub() {
  const bp = new InMemoryBackplane();
  let received: { channel: string; payload: string } | null = null;
  await bp.subscribe('test:chan', (ch, p) => {
    received = { channel: ch, payload: p };
  });
  await bp.publish('test:chan', 'hello');
  await waitFor(() => received);
  if (received!.payload !== 'hello') throw new Error(`expected hello got ${received!.payload}`);
  await bp.close();
}

// ─── 2. InMemoryBackplane streams ────────────────────────────────────

async function testMemoryStream() {
  const bp = new InMemoryBackplane();
  const seen: string[] = [];
  await bp.consume('s1', 'g1', 'c1', async (msg) => {
    seen.push(msg.payload);
    return true;
  });
  await bp.enqueue('s1', 'a');
  await bp.enqueue('s1', 'b');
  await waitFor(() => (seen.length === 2 ? seen : undefined));
  if (seen.join(',') !== 'a,b') throw new Error(`expected a,b got ${seen.join(',')}`);
  await bp.close();
}

// ─── 3. RedisBackplane pub/sub ───────────────────────────────────────

async function testRedisPubSub() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect();
  const bp = new RedisBackplane(redis);
  // Subscriber clients need a tick to settle SUBSCRIBE.
  let received: string | null = null;
  await bp.subscribe('wave4:test:chan', (_ch, p) => {
    received = p;
  });
  await sleep(100); // let SUBSCRIBE settle
  await bp.publish('wave4:test:chan', 'redis-hello');
  await waitFor(() => received);
  if (received !== 'redis-hello') throw new Error(`expected redis-hello got ${received}`);
  await bp.close();
  await redis.quit();
}

// ─── 4. RedisBackplane streams ───────────────────────────────────────

async function testRedisStream() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect();
  const streamKey = `wave4:test:stream:${Date.now()}`;
  // Pre-clean any existing residue.
  await redis.del(streamKey).catch(() => undefined);
  const bp = new RedisBackplane(redis);
  const seen: string[] = [];
  await bp.consume(streamKey, 'g1', 'c1', async (msg) => {
    seen.push(msg.payload);
    return true;
  });
  await sleep(150); // let consume loop start + XGROUP CREATE
  await bp.enqueue(streamKey, 'rs-a');
  await bp.enqueue(streamKey, 'rs-b');
  await waitFor(() => (seen.length === 2 ? seen : undefined), 10_000);
  if (seen.join(',') !== 'rs-a,rs-b') throw new Error(`expected rs-a,rs-b got ${seen.join(',')}`);
  await bp.close();
  await redis.del(streamKey).catch(() => undefined);
  await redis.quit();
}

// ─── 5. Cross-Pod unicast simulation ─────────────────────────────────
//
// Two RedisBackplane instances acting as pod-A and pod-B. pod-A unicasts
// to pod-B via sendToPod(podB) — pod-B's registered handler receives it.

async function testCrossPodUnicast() {
  const redisA = new Redis(REDIS_URL, { lazyConnect: true });
  const redisB = new Redis(REDIS_URL, { lazyConnect: true });
  await Promise.all([redisA.connect(), redisB.connect()]);

  const PODA = `pod-a-${process.pid}-${Date.now()}`;
  const PODB = `pod-b-${process.pid}-${Date.now()}`;

  const bpA: Backplane = new RedisBackplane(redisA);
  const bpB: Backplane = new RedisBackplane(redisB);

  let bReceived: string | null = null;
  await bpB.registerPodChannel(PODB, (raw) => {
    bReceived = raw;
  });
  await sleep(200); // let XGROUP CREATE + consume loop settle

  // pod-A unicasts to pod-B (typical: user is connected to pod-B; pod-A
  // generated a message.new for that user).
  const payload = JSON.stringify({ targetUserId: 'u-cross', event: { type: 'message.new', x: 1 } });
  await bpA.sendToPod(PODB, payload);

  await waitFor(() => bReceived, 10_000);
  const parsed = JSON.parse(bReceived!);
  if (parsed.targetUserId !== 'u-cross') throw new Error(`unexpected payload ${bReceived}`);

  await bpA.close();
  await bpB.close();
  // Clean up streams (best-effort).
  await redisA.del(`pod-${PODB}:queue`).catch(() => undefined);
  await redisA.quit();
  await redisB.quit();
}

// ─── 6. Persistent ack flow ──────────────────────────────────────────

async function testPersistentAck() {
  const svc = new WSAckPersistentService();
  const userId = `cmtest-${Date.now().toString(36)}`;
  const ackId1 = `ack-${Date.now()}-1`;
  const ackId2 = `ack-${Date.now()}-2`;

  // 1. Filter check: typing.indicator should NOT be persisted.
  if (isHighPriorityEvent({ type: 'typing.indicator' })) throw new Error('typing wrongly high-prio');
  if (!isHighPriorityEvent({ type: 'message.new' })) throw new Error('message.new should be high-prio');

  // 2. Track 2 events for user.
  await svc.trackOutbound(userId, ackId1, { type: 'message.new', id: 'm1', ackId: ackId1 });
  await svc.trackOutbound(userId, ackId2, { type: 'task.transitioned', id: 't1', ackId: ackId2 });

  // 3. Both should appear pending.
  const before = await svc.getUnacked(userId);
  if (before.length !== 2) throw new Error(`expected 2 pending got ${before.length}`);

  // 4. Ack one — only the other should remain.
  await svc.markAcked(userId, ackId1);
  const after = await svc.getUnacked(userId);
  if (after.length !== 1) throw new Error(`expected 1 pending got ${after.length}`);
  if (after[0].ackId !== ackId2) throw new Error(`expected ${ackId2} got ${after[0].ackId}`);

  // 5. Cleanup: delete this test's rows.
  const prisma = (await import('../db')).default;
  await prisma.iMWSAck.deleteMany({ where: { userId } });
}

// ─── 7. Redis-down resilience ────────────────────────────────────────
//
// Close the redis connection mid-flight and verify publish does NOT throw
// (sync.service.publishRetries pattern — failures are swallowed + logged).

async function testRedisDownResilience() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect();
  const bp = new RedisBackplane(redis);
  // Force-disconnect by quitting the redis client; publish should still
  // resolve (warns to console, doesn't throw).
  await redis.quit();
  // publish must not throw.
  await bp.publish('wave4:resilience', 'after-quit');
  // enqueue WILL throw (it's a critical write); caller is expected to retry.
  let threw = false;
  try {
    await bp.enqueue('wave4:resilience:stream', 'payload');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('enqueue should propagate Redis errors');
  await bp.close();
}

// ─── Driver ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Wave-4 E3 Backplane + Persistent Ack ===\n');
  await test('1. InMemoryBackplane pub/sub round-trip', testMemoryPubSub);
  await test('2. InMemoryBackplane streams enqueue→consume→ack', testMemoryStream);
  await test('3. RedisBackplane pub/sub round-trip', testRedisPubSub);
  await test('4. RedisBackplane streams enqueue→consume→ack', testRedisStream);
  await test('5. Cross-Pod unicast: pod-A sendToPod(pod-B)', testCrossPodUnicast);
  await test('6. Persistent ack: track / ack / getUnacked', testPersistentAck);
  await test('7. Redis-down resilience (publish swallows, enqueue throws)', testRedisDownResilience);

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

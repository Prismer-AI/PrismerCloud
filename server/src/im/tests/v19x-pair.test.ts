/**
 * Track C m3 — pair.service unit tests
 *
 * Pure-logic tests using a mock Prisma + mock Redis — no real DB connection
 * needed. Covers the full state machine: offer → approve → poll, plus
 * every error transition (expired, replay via wrong devicePub, double
 * approval, double poll consumption, missing approver cloud-account link,
 * Redis cache miss).
 *
 * Real e2e (Track B daemon prismer pair → cloud → mobile approve) is m4
 * territory.
 *
 * Usage: npx tsx src/im/tests/v19x-pair.test.ts
 */

import {
  PairService,
  PairOfferNotFoundError,
  PairOfferExpiredError,
  PairOfferAlreadyApprovedError,
  PairOfferConsumedError,
  PairDevicePubMismatchError,
  PairApproverNotLinkedError,
} from '../services/pair.service';
import { createPairRouter } from '../api/pair';

// ─── Test plumbing ───────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message || String(err)}`);
    console.log(`  ❌ ${name}: ${err.message || String(err)}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

async function expectThrow<E extends Error>(
  fn: () => Promise<unknown>,
  errorClass: new (...args: any[]) => E,
  label: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof errorClass) return;
    throw new Error(`${label}: wrong error type — got ${(err as Error).constructor.name}`);
  }
  throw new Error(`${label}: expected throw, got resolved`);
}

// ─── Mocks ───────────────────────────────────────────────────

interface OfferRow {
  nonce: string;
  devicePub: string;
  deviceName: string;
  approverImUserId: string | null;
  approvedAt: Date | null;
  apiKeyId: string | null;
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

class MockPrismaPairOffer {
  public rows = new Map<string, OfferRow>();

  async create({ data }: { data: Partial<OfferRow> & { nonce: string; expiresAt: Date } }) {
    const row: OfferRow = {
      nonce: data.nonce,
      devicePub: data.devicePub ?? '',
      deviceName: data.deviceName ?? '',
      approverImUserId: null,
      approvedAt: null,
      apiKeyId: null,
      consumedAt: null,
      expiresAt: data.expiresAt,
      createdAt: new Date(),
    };
    this.rows.set(data.nonce, row);
    return row;
  }

  async findUnique({ where }: { where: { nonce: string } }) {
    return this.rows.get(where.nonce) ?? null;
  }

  async update({ where, data }: { where: { nonce: string }; data: Partial<OfferRow> }) {
    const row = this.rows.get(where.nonce);
    if (!row) throw new Error('row not found');
    Object.assign(row, data);
    return row;
  }
}

class MockPrismaIMUser {
  constructor(
    private byId: Record<string, { userId: string | null; role: string }>,
    private byEmail: Record<string, { id: string; userId: string | null; role: string }> = {},
  ) {}
  async findUnique({ where, select: _ }: { where: { id: string }; select?: unknown }) {
    return this.byId[where.id] ?? null;
  }
  async findFirst({ where }: { where: { email?: string; role?: string }; select?: unknown }) {
    if (!where.email) return null;
    const row = this.byEmail[where.email];
    if (!row) return null;
    if (where.role && row.role !== where.role) return null;
    return row;
  }
}

class MockRedis {
  public store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, _mode: 'PX', ttlMs: number): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

/**
 * Replace the prisma module's pair-related and user-related namespaces
 * with mocks. Returns the install + an `uninstall` callback.
 */
function installPrismaMocks(opts: { pair: MockPrismaPairOffer; user: MockPrismaIMUser }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const prismaModule = require('../db');
  const real = prismaModule.default;
  const original = {
    iMPairingOffer: real.iMPairingOffer,
    iMUser: real.iMUser,
  };
  real.iMPairingOffer = opts.pair;
  real.iMUser = opts.user;
  return () => {
    real.iMPairingOffer = original.iMPairingOffer;
    real.iMUser = original.iMUser;
  };
}

// Standard fixture builder.
function makeService(opts: {
  pair?: MockPrismaPairOffer;
  user?: MockPrismaIMUser;
  redis?: MockRedis;
  now?: () => number;
  generateNonce?: () => string;
  /** Mock pc_api_keys creator — returns a fixed key plaintext + uuid id. */
  createApiKey?: (
    userId: number,
    label: string,
  ) => Promise<{ id: string; key: string; label: string; created: string; status: string }>;
}) {
  const pair = opts.pair ?? new MockPrismaPairOffer();
  const user =
    opts.user ??
    new MockPrismaIMUser({
      'imuser-alice': { userId: '42', role: 'human' },
    });
  const redis = opts.redis ?? new MockRedis();
  const uninstall = installPrismaMocks({ pair, user });
  const service = new PairService({
    redis: redis as unknown as import('ioredis').Redis,
    now: opts.now,
    generateNonce: opts.generateNonce,
    createApiKey:
      opts.createApiKey ??
      (async (userId, label) => ({
        id: `key-${userId}`,
        key: 'sk-prismer-live-' + 'a'.repeat(64),
        label,
        created: new Date().toISOString(),
        status: 'ACTIVE',
      })),
  });
  return { service, pair, user, redis, uninstall };
}

// ─── Suite ───────────────────────────────────────────────────

(async () => {
  console.log('\n🔹 PairService — m3 v1.9.3');

  await test('createOffer returns nonce + qrUrl + expiresAt', async () => {
    const { service, uninstall } = makeService({ generateNonce: () => 'nonce-fixed-1' });
    try {
      const result = await service.createOffer({ devicePub: 'pub-abc', deviceName: 'mac' });
      assertEq(result.nonce, 'nonce-fixed-1', 'nonce');
      if (!result.qrUrl.startsWith('prismer://pair?nonce=nonce-fixed-1&pub=pub-abc')) {
        throw new Error(`qrUrl mismatch: ${result.qrUrl}`);
      }
      if (!(result.expiresAt instanceof Date)) throw new Error('expiresAt not a Date');
    } finally {
      uninstall();
    }
  });

  await test('approve → poll happy path returns the API key once', async () => {
    const { service, uninstall, redis } = makeService({ generateNonce: () => 'nonce-happy' });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      const approveResult = await service.approveOffer('nonce-happy', 'imuser-alice');
      if (!approveResult.apiKey.startsWith('sk-prismer-live-')) {
        throw new Error('approve did not return plaintext key');
      }
      const pollResult = await service.pollOffer('nonce-happy', 'pub-1');
      assertEq(pollResult?.apiKey, approveResult.apiKey, 'poll returns same key');
      // Redis cache should be wiped on consume.
      assertEq(redis.store.size, 0, 'redis cache cleared');
    } finally {
      uninstall();
    }
  });

  await test('poll before approval returns null (caller maps to 202 pending)', async () => {
    const { service, uninstall } = makeService({ generateNonce: () => 'nonce-pending' });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      const result = await service.pollOffer('nonce-pending', 'pub-1');
      assertEq(result, null, 'poll pending');
    } finally {
      uninstall();
    }
  });

  await test('second poll after consume throws PairOfferConsumedError', async () => {
    const { service, uninstall } = makeService({ generateNonce: () => 'nonce-double' });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      await service.approveOffer('nonce-double', 'imuser-alice');
      await service.pollOffer('nonce-double', 'pub-1'); // first poll consumes
      await expectThrow(() => service.pollOffer('nonce-double', 'pub-1'), PairOfferConsumedError, 'second poll');
    } finally {
      uninstall();
    }
  });

  await test('poll with mismatched devicePub throws (replay protection)', async () => {
    const { service, uninstall } = makeService({ generateNonce: () => 'nonce-replay' });
    try {
      await service.createOffer({ devicePub: 'pub-genuine', deviceName: 'mac' });
      await service.approveOffer('nonce-replay', 'imuser-alice');
      await expectThrow(
        () => service.pollOffer('nonce-replay', 'pub-attacker'),
        PairDevicePubMismatchError,
        'replay rejected',
      );
    } finally {
      uninstall();
    }
  });

  await test('approve on expired offer throws PairOfferExpiredError', async () => {
    let clock = 1_000_000;
    const { service, uninstall } = makeService({
      generateNonce: () => 'nonce-expire',
      now: () => clock,
    });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      // Advance past the 5-minute TTL.
      clock += 6 * 60 * 1000;
      await expectThrow(
        () => service.approveOffer('nonce-expire', 'imuser-alice'),
        PairOfferExpiredError,
        'approve expired',
      );
    } finally {
      uninstall();
    }
  });

  await test('poll on expired offer throws even if previously approved', async () => {
    let clock = 1_000_000;
    const { service, uninstall } = makeService({
      generateNonce: () => 'nonce-exp-poll',
      now: () => clock,
    });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      await service.approveOffer('nonce-exp-poll', 'imuser-alice');
      clock += 6 * 60 * 1000;
      await expectThrow(() => service.pollOffer('nonce-exp-poll', 'pub-1'), PairOfferExpiredError, 'poll expired');
    } finally {
      uninstall();
    }
  });

  await test('double approve throws PairOfferAlreadyApprovedError', async () => {
    const { service, uninstall } = makeService({ generateNonce: () => 'nonce-double-approve' });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      await service.approveOffer('nonce-double-approve', 'imuser-alice');
      await expectThrow(
        () => service.approveOffer('nonce-double-approve', 'imuser-alice'),
        PairOfferAlreadyApprovedError,
        'second approve',
      );
    } finally {
      uninstall();
    }
  });

  await test('approver without linked cloud account is rejected', async () => {
    const user = new MockPrismaIMUser({
      'imuser-orphan': { userId: null, role: 'human' },
    });
    const { service, uninstall } = makeService({
      user,
      generateNonce: () => 'nonce-orphan',
    });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      await expectThrow(
        () => service.approveOffer('nonce-orphan', 'imuser-orphan'),
        PairApproverNotLinkedError,
        'approver not linked',
      );
    } finally {
      uninstall();
    }
  });

  await test('unknown nonce throws PairOfferNotFoundError on approve', async () => {
    const { service, uninstall } = makeService({});
    try {
      await expectThrow(
        () => service.approveOffer('nonce-bogus', 'imuser-alice'),
        PairOfferNotFoundError,
        'bogus nonce',
      );
    } finally {
      uninstall();
    }
  });

  await test('Redis cache evicted between approve + poll → consumed (recovery path)', async () => {
    const { service, uninstall, redis, pair } = makeService({ generateNonce: () => 'nonce-r-evict' });
    try {
      await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
      await service.approveOffer('nonce-r-evict', 'imuser-alice');
      // Evict cached plaintext (simulates a Redis flush).
      redis.store.clear();
      await expectThrow(
        () => service.pollOffer('nonce-r-evict', 'pub-1'),
        PairOfferConsumedError,
        'cache miss → consumed',
      );
      // Offer should be marked consumed so daemon doesn't loop.
      const row = pair.rows.get('nonce-r-evict');
      if (!row?.consumedAt) throw new Error('consumedAt not stamped on cache miss');
    } finally {
      uninstall();
    }
  });

  // ─── Route: POST /local-only-approve (Wave-6 α LAN-dev gate) ───
  //
  // Saves and restores LOCAL_ONLY / NODE_ENV around each test so the
  // suite remains hermetic regardless of the parent process env.
  console.log('\n🔹 PairRouter — POST /local-only-approve');

  async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const original: Record<string, string | undefined> = {};
    for (const k of Object.keys(overrides)) original[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await fn();
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  await test('local-only-approve → 403 when LOCAL_ONLY env not set', async () => {
    await withEnv({ LOCAL_ONLY: undefined, NODE_ENV: 'development' }, async () => {
      const user = new MockPrismaIMUser(
        { 'imuser-alice': { userId: '42', role: 'human' } },
        { 'admintest1@local.test': { id: 'imuser-alice', userId: '42', role: 'human' } },
      );
      const { service, uninstall } = makeService({ user, generateNonce: () => 'nonce-403' });
      try {
        await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
        const router = createPairRouter(service);
        const res = await router.fetch(
          new Request('http://localhost/local-only-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: 'nonce-403', asUserEmail: 'admintest1@local.test' }),
          }),
        );
        assertEq(res.status, 403, 'status');
        const body = (await res.json()) as { ok: boolean; error?: { code?: string } };
        assertEq(body.ok, false, 'envelope ok');
        assertEq(body.error?.code, 'LOCAL_ONLY_DISABLED', 'error code');
      } finally {
        uninstall();
      }
    });
  });

  await test('local-only-approve → 403 when NODE_ENV=production even with LOCAL_ONLY=1', async () => {
    await withEnv({ LOCAL_ONLY: '1', NODE_ENV: 'production' }, async () => {
      const { service, uninstall } = makeService({ generateNonce: () => 'nonce-prod' });
      try {
        await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
        const router = createPairRouter(service);
        const res = await router.fetch(
          new Request('http://localhost/local-only-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: 'nonce-prod', asUserEmail: 'admintest1@local.test' }),
          }),
        );
        assertEq(res.status, 403, 'status — prod NODE_ENV must refuse bypass');
      } finally {
        uninstall();
      }
    });
  });

  await test('local-only-approve → 200 when LOCAL_ONLY=1 + valid email', async () => {
    await withEnv({ LOCAL_ONLY: '1', NODE_ENV: 'development' }, async () => {
      const user = new MockPrismaIMUser(
        { 'imuser-alice': { userId: '42', role: 'human' } },
        { 'admintest1@local.test': { id: 'imuser-alice', userId: '42', role: 'human' } },
      );
      const { service, uninstall, pair } = makeService({ user, generateNonce: () => 'nonce-ok' });
      try {
        await service.createOffer({ devicePub: 'pub-ok', deviceName: 'mac' });
        const router = createPairRouter(service);
        const res = await router.fetch(
          new Request('http://localhost/local-only-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: 'nonce-ok', asUserEmail: 'admintest1@local.test' }),
          }),
        );
        assertEq(res.status, 200, 'status');
        const body = (await res.json()) as { ok: boolean };
        assertEq(body.ok, true, 'envelope ok');
        // Offer should now be marked approved by imuser-alice.
        const row = pair.rows.get('nonce-ok');
        if (!row?.approvedAt) throw new Error('approvedAt not stamped');
        assertEq(row?.approverImUserId, 'imuser-alice', 'approver stamped');
        // Daemon can now poll and pick up the api key.
        const pollRes = await service.pollOffer('nonce-ok', 'pub-ok');
        if (!pollRes?.apiKey?.startsWith('sk-prismer-live-')) {
          throw new Error('poll did not return plaintext key after local-only approve');
        }
      } finally {
        uninstall();
      }
    });
  });

  await test('local-only-approve → 404 when email does not match a human IMUser', async () => {
    await withEnv({ LOCAL_ONLY: '1', NODE_ENV: 'development' }, async () => {
      const user = new MockPrismaIMUser({ 'imuser-alice': { userId: '42', role: 'human' } });
      // No byEmail entry — lookup will return null.
      const { service, uninstall } = makeService({ user, generateNonce: () => 'nonce-404' });
      try {
        await service.createOffer({ devicePub: 'pub-1', deviceName: 'mac' });
        const router = createPairRouter(service);
        const res = await router.fetch(
          new Request('http://localhost/local-only-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: 'nonce-404', asUserEmail: 'ghost@local.test' }),
          }),
        );
        assertEq(res.status, 404, 'status');
        const body = (await res.json()) as { error?: { code?: string } };
        assertEq(body.error?.code, 'AS_USER_NOT_FOUND', 'error code');
      } finally {
        uninstall();
      }
    });
  });

  await test('local-only-approve → 400 on missing nonce or asUserEmail', async () => {
    await withEnv({ LOCAL_ONLY: '1', NODE_ENV: 'development' }, async () => {
      const { service, uninstall } = makeService({});
      try {
        const router = createPairRouter(service);
        const noNonce = await router.fetch(
          new Request('http://localhost/local-only-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asUserEmail: 'a@b.com' }),
          }),
        );
        assertEq(noNonce.status, 400, 'no nonce');
        const noEmail = await router.fetch(
          new Request('http://localhost/local-only-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: 'x' }),
          }),
        );
        assertEq(noEmail.status, 400, 'no asUserEmail');
      } finally {
        uninstall();
      }
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();

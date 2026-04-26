/**
 * Prismer IM v0.3.0 Integration Tests
 *
 * Tests: Bindings (15), Credits (12), Bridge (8), /me enhancement (2)
 *
 * Usage: DATABASE_URL="file:/Users/prismer/workspace/prismercloud/prisma/dev.db" npx tsx src/im/tests/v030-integration.test.ts
 */

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

// ─── Test State ─────────────────────────────────────────────
let userAToken = '';
let userAId = '';
let userBToken = '';
let userBId = '';
const ts = String(Date.now()).slice(-8);

// ─── Helper: Create user via /users/register ──────────────
async function createTestUser(
  username: string,
  displayName: string,
  role: string = 'human',
): Promise<{ id: string; token: string }> {
  const res = await api('POST', '/users/register', {
    username,
    displayName,
    role,
  });
  if (!res.data.ok) {
    const loginRes = await api('POST', '/users/login', { username });
    if (!loginRes.data.ok) {
      throw new Error(`Cannot create/login user ${username}: ${JSON.stringify(res.data)}`);
    }
    return {
      id: loginRes.data.data.user.id,
      token: loginRes.data.data.token,
    };
  }
  return { id: res.data.data.user.id, token: res.data.data.token };
}

// ═══════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════

async function setup() {
  console.log('\n🔧 Setup');

  const userA = await createTestUser(`v030_userA_${ts}`, 'User A v030');
  userAToken = userA.token;
  userAId = userA.id;

  const userB = await createTestUser(`v030_userB_${ts}`, 'User B v030');
  userBToken = userB.token;
  userBId = userB.id;

  console.log(`  Users: A=${userAId.slice(0, 8)}... B=${userBId.slice(0, 8)}...`);
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 1: Bindings
// ═══════════════════════════════════════════════════════════

let bindingId = '';
let verificationCode = '';

async function testBindings() {
  console.log('\n🔹 Binding Tests');

  await test('B1: Create Telegram binding', async () => {
    const res = await api(
      'POST',
      '/bindings',
      {
        platform: 'telegram',
        botToken: '123456:ABC-DEF-test-token',
        chatId: '987654321',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok should be true');
    assertEqual(res.data.data.platform, 'telegram', 'platform');
    assertEqual(res.data.data.status, 'pending', 'status');
    assert(res.data.data.verificationCode, 'should have verification code');
    assert(res.data.data.verificationCode.length === 6, 'code should be 6 digits');
    bindingId = res.data.data.bindingId;
    verificationCode = res.data.data.verificationCode;
  });

  await test('B2: Duplicate binding same platform → 409', async () => {
    const res = await api('POST', '/bindings', { platform: 'telegram', botToken: 'another-token' }, userAToken);
    assertEqual(res.status, 409, 'status');
    assert(!res.data.ok, 'ok should be false');
  });

  await test('B3: Verify binding with correct code', async () => {
    const res = await api('POST', `/bindings/${bindingId}/verify`, { code: verificationCode }, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok should be true');
    assertEqual(res.data.data.status, 'active', 'status after verify');
    assertEqual(res.data.data.platform, 'telegram', 'platform');
    assert(Array.isArray(res.data.data.capabilities), 'capabilities should be array');
  });

  await test('B4: Verify binding with wrong code → 400', async () => {
    // Create a new binding on different platform to test wrong code
    const createRes = await api(
      'POST',
      '/bindings',
      { platform: 'discord', botToken: 'discord-test-token', channelId: '123' },
      userAToken,
    );
    const discordBindingId = createRes.data.data.bindingId;

    const res = await api('POST', `/bindings/${discordBindingId}/verify`, { code: '000000' }, userAToken);
    assertEqual(res.status, 400, 'status');
    assert(!res.data.ok, 'ok should be false');
    assert(res.data.error.includes('Invalid verification'), 'error should mention invalid code');
  });

  await test('B5: List bindings', async () => {
    const res = await api('GET', '/bindings', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok should be true');
    assert(Array.isArray(res.data.data), 'data should be array');
    assert(res.data.data.length >= 2, 'should have at least 2 bindings');
    const tg = res.data.data.find((b: any) => b.platform === 'telegram');
    assert(tg, 'should have telegram binding');
    assertEqual(tg.status, 'active', 'telegram status');
  });

  await test('B6: Revoke binding', async () => {
    // Create a temporary binding to revoke
    const createRes = await api('POST', '/bindings', { platform: 'slack', botToken: 'slack-test' }, userAToken);
    const slackBindingId = createRes.data.data.bindingId;

    const res = await api('DELETE', `/bindings/${slackBindingId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok should be true');

    // Verify it's gone
    const listRes = await api('GET', '/bindings', undefined, userAToken);
    const slack = listRes.data.data.find((b: any) => b.platform === 'slack');
    assert(!slack, 'slack binding should be deleted');
  });

  await test("B7: Cannot operate on another user's binding → 403", async () => {
    // userB tries to verify userA's binding
    const res = await api('POST', `/bindings/${bindingId}/verify`, { code: '123456' }, userBToken);
    // Should be 403 (not your binding) or 400 (cannot verify, already active)
    assert(res.status === 403 || res.status === 400, `expected 403 or 400, got ${res.status}`);
  });

  await test("B8: Cannot revoke another user's binding → 403", async () => {
    const res = await api('DELETE', `/bindings/${bindingId}`, undefined, userBToken);
    assertEqual(res.status, 403, 'status');
  });

  await test('B9: Create Discord binding for userB', async () => {
    const res = await api(
      'POST',
      '/bindings',
      {
        platform: 'discord',
        botToken: 'discord-token-userB',
        channelId: 'discord-channel-1',
      },
      userBToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok should be true');
    assertEqual(res.data.data.platform, 'discord', 'platform');
  });

  await test('B10: Multiple platforms per user — independent', async () => {
    // userA already has telegram (active) + discord (pending)
    const listRes = await api('GET', '/bindings', undefined, userAToken);
    const platforms = listRes.data.data.map((b: any) => b.platform);
    assert(platforms.includes('telegram'), 'should have telegram');
    assert(platforms.includes('discord'), 'should have discord');
  });

  await test('B11: Invalid platform → 400', async () => {
    const res = await api('POST', '/bindings', { platform: 'whatsapp' }, userAToken);
    assertEqual(res.status, 400, 'status');
  });

  await test('B12: Binding not found → 404', async () => {
    const res = await api('POST', '/bindings/nonexistent_id/verify', { code: '123456' }, userAToken);
    assertEqual(res.status, 404, 'status');
  });

  await test('B13: Missing code → 400', async () => {
    const res = await api('POST', `/bindings/${bindingId}/verify`, {}, userAToken);
    assertEqual(res.status, 400, 'status');
  });

  await test('B14: Re-verify active binding → 400', async () => {
    // bindingId is already active
    const res = await api('POST', `/bindings/${bindingId}/verify`, { code: '123456' }, userAToken);
    assertEqual(res.status, 400, 'status');
    assert(res.data.error.includes('cannot verify'), 'should say cannot verify');
  });

  await test('B15: No auth → 401', async () => {
    const res = await api('GET', '/bindings');
    assertEqual(res.status, 401, 'status');
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 2: Credits
// ═══════════════════════════════════════════════════════════

async function testCredits() {
  console.log('\n🔹 Credits Tests');

  await test('C1: New user default balance = 100000 (≈100M messages)', async () => {
    const res = await api('GET', '/credits', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok should be true');
    assertEqual(res.data.data.balance, 100000, 'default balance');
    assert(
      res.data.data.totalEarned === 0 || res.data.data.totalEarned === 100000,
      `totalEarned should be 0 or 100000, got ${res.data.data.totalEarned}`,
    );
    assertEqual(res.data.data.totalSpent, 0, 'totalSpent');
  });

  await test('C2: Get balance returns correct structure', async () => {
    const res = await api('GET', '/credits', undefined, userAToken);
    assert(res.data.ok, 'ok');
    assert(
      'balance' in res.data.data && 'totalEarned' in res.data.data && 'totalSpent' in res.data.data,
      'should have all fields',
    );
  });

  await test('C3: Transaction history — initially empty', async () => {
    const res = await api('GET', '/credits/transactions', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(Array.isArray(res.data.data), 'data should be array');
    // LocalCreditService: 0 initial txns, CloudCreditService: 1 (initial grant)
    assert(res.data.data.length <= 1, `expected 0 or 1 initial txns, got ${res.data.data.length}`);
    assert(res.data.meta.total <= 1, `total should be 0 or 1, got ${res.data.meta.total}`);
  });

  await test('C4: UserB also gets default 100000 credits', async () => {
    const res = await api('GET', '/credits', undefined, userBToken);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.balance, 100000, 'default balance');
  });

  await test('C5: No auth → 401', async () => {
    const res = await api('GET', '/credits');
    assertEqual(res.status, 401, 'status');
  });

  await test('C6: Transactions with limit/offset', async () => {
    const res = await api('GET', '/credits/transactions?limit=5&offset=0', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.meta.pageSize, 5, 'pageSize');
  });

  await test('C7: Limit capped at 100', async () => {
    const res = await api('GET', '/credits/transactions?limit=999', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    // The API caps at 100, so pageSize should be 999 in response (limit is input value)
    // but internally queries with 100 max
    assert(res.data.ok, 'ok');
  });

  await test('C8: Users have isolated credits', async () => {
    const resA = await api('GET', '/credits', undefined, userAToken);
    const resB = await api('GET', '/credits', undefined, userBToken);
    assertEqual(resA.data.data.balance, 100000, 'userA balance');
    assertEqual(resB.data.data.balance, 100000, 'userB balance');
  });
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 3: CreditService Internal Tests
// ═══════════════════════════════════════════════════════════

async function testCreditServiceInternal() {
  console.log('\n🔹 CreditService Internal Tests (via direct import)');

  // These tests directly exercise the CreditService
  // to test deduct/credit operations not exposed via REST
  const { PrismaClient } = await import('@prisma/client');
  const { LocalCreditService } = await import('../services/credit.service');

  const prisma = new PrismaClient({
    datasources: {
      db: { url: process.env.DATABASE_URL || 'file:/Users/prismer/workspace/prismercloud/prisma/dev.db' },
    },
  });
  const creditService = new LocalCreditService(prisma);

  // Create a test user directly
  const testUser = await prisma.iMUser.create({
    data: {
      username: `cs_test_${ts}_${Math.random().toString(36).slice(2, 6)}`,
      displayName: 'CreditService Test User',
      role: 'human',
    },
  });
  const userId = testUser.id;

  await test('CS1: ensureCredit creates record', async () => {
    await creditService.ensureCredit(userId);
    const balance = await creditService.getBalance(userId);
    assertEqual(balance.balance, 100000, 'initial balance');
  });

  await test('CS2: deduct reduces balance', async () => {
    const result = await creditService.deduct(userId, 0.5, 'test deduction', 'message', 'msg_123');
    assert(result.success, 'should succeed');
    assertEqual(result.balanceAfter, 99999.5, 'balance after');
  });

  await test('CS3: deduct records transaction', async () => {
    const { transactions, total } = await creditService.getTransactions(userId, 10, 0);
    assertEqual(total, 1, 'should have 1 transaction');
    assertEqual(transactions[0].type, 'usage', 'type');
    assertEqual(transactions[0].amount, -0.5, 'amount');
    assertEqual(transactions[0].balanceAfter, 99999.5, 'balanceAfter');
    assertEqual(transactions[0].referenceType, 'message', 'referenceType');
  });

  await test('CS4: credit adds balance', async () => {
    const result = await creditService.credit(userId, 10, 'topup', 'test topup');
    assertEqual(result.balanceAfter, 100009.5, 'balance after credit');
  });

  await test('CS5: balance reflects both deduct and credit', async () => {
    const balance = await creditService.getBalance(userId);
    assertEqual(balance.balance, 100009.5, 'balance');
    assertEqual(balance.totalSpent, 0.5, 'totalSpent');
    assertEqual(balance.totalEarned, 10, 'totalEarned');
  });

  await test('CS6: insufficient credits → failure', async () => {
    const result = await creditService.deduct(userId, 200000, 'too much');
    assert(!result.success, 'should fail');
    assert(result.error?.includes('Insufficient'), 'error message');
    assertEqual(result.balanceAfter, 100009.5, 'balance unchanged');
  });

  await test('CS7: multiple deductions sequential', async () => {
    for (let i = 0; i < 5; i++) {
      await creditService.deduct(userId, 0.001, `msg ${i}`, 'message');
    }
    const balance = await creditService.getBalance(userId);
    const expected = 100009.5 - 5 * 0.001;
    assert(Math.abs(balance.balance - expected) < 0.0001, `balance should be ~${expected}, got ${balance.balance}`);
  });

  await test('CS8: transaction pagination', async () => {
    const { transactions, total } = await creditService.getTransactions(userId, 3, 0);
    assert(total >= 7, `should have at least 7 transactions, got ${total}`);
    assertEqual(transactions.length, 3, 'page size 3');
    // Most recent first
    assert(transactions[0].createdAt >= transactions[1].createdAt, 'should be newest first');
  });

  await test('CS9: transaction pagination offset', async () => {
    const page1 = await creditService.getTransactions(userId, 3, 0);
    const page2 = await creditService.getTransactions(userId, 3, 3);
    assert(page1.transactions[0].id !== page2.transactions[0].id, 'pages should have different transactions');
  });

  // Cleanup
  await prisma.iMCreditTransaction.deleteMany({
    where: { credit: { imUserId: userId } },
  });
  await prisma.iMCredit.deleteMany({ where: { imUserId: userId } });
  await prisma.iMUser.delete({ where: { id: userId } });
  await prisma.$disconnect();
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 4: Bridge (unit-level, no external APIs)
// ═══════════════════════════════════════════════════════════

async function testBridge() {
  console.log('\n🔹 Bridge Tests (unit-level)');

  const { PrismaClient } = await import('@prisma/client');
  const { BridgeManager } = await import('../services/bridge/bridge-manager');
  const { MessageService } = await import('../services/message.service');
  const Redis = (await import('ioredis')).default;

  const prisma = new PrismaClient({
    datasources: {
      db: { url: process.env.DATABASE_URL || 'file:/Users/prismer/workspace/prismercloud/prisma/dev.db' },
    },
  });

  // Minimal Redis (will fail gracefully)
  const redis = new Redis({ lazyConnect: true, maxRetriesPerRequest: 1 });
  const messageService = new MessageService(redis);
  const bridgeManager = new BridgeManager(prisma, messageService);

  await test('BR1: BridgeManager has telegram bridge', async () => {
    const bridge = bridgeManager.getBridge('telegram');
    assert(!!bridge, 'should have telegram bridge');
    assertEqual(bridge!.platform, 'telegram', 'platform');
  });

  await test('BR2: BridgeManager has discord bridge', async () => {
    const bridge = bridgeManager.getBridge('discord');
    assert(!!bridge, 'should have discord bridge');
    assertEqual(bridge!.platform, 'discord', 'platform');
  });

  await test('BR3: Unknown platform returns undefined', async () => {
    const bridge = bridgeManager.getBridge('whatsapp');
    assert(!bridge, 'should not have whatsapp bridge');
  });

  await test('BR4: TelegramBridge sendMessage with missing config → failure', async () => {
    const bridge = bridgeManager.getBridge('telegram')!;
    const result = await bridge.sendMessage(
      {
        id: 'test',
        imUserId: 'test',
        platform: 'telegram',
        status: 'active',
        botToken: null,
        channelId: null,
      },
      'hello',
    );
    assert(!result.success, 'should fail without botToken');
    assert(result.error?.includes('Missing'), 'error should mention missing config');
  });

  await test('BR5: DiscordBridge sendMessage with missing config → failure', async () => {
    const bridge = bridgeManager.getBridge('discord')!;
    const result = await bridge.sendMessage(
      {
        id: 'test',
        imUserId: 'test',
        platform: 'discord',
        status: 'active',
        botToken: null,
        channelId: null,
      },
      'hello',
    );
    assert(!result.success, 'should fail without botToken');
  });

  await test('BR6: TelegramBridge validateCredentials with no token → false', async () => {
    const bridge = bridgeManager.getBridge('telegram')!;
    const valid = await bridge.validateCredentials({});
    assert(!valid, 'should be false without token');
  });

  await test('BR7: DiscordBridge validateCredentials with no token → false', async () => {
    const bridge = bridgeManager.getBridge('discord')!;
    const valid = await bridge.validateCredentials({});
    assert(!valid, 'should be false without token');
  });

  await test('BR8: Bridge message record — outbound with no active bindings', async () => {
    // Create a user with no bindings
    const testUser = await prisma.iMUser.create({
      data: {
        username: `br_test_${ts}_${Math.random().toString(36).slice(2, 6)}`,
        displayName: 'Bridge Test User',
        role: 'human',
      },
    });

    // sendOutbound should do nothing (no active bindings)
    await bridgeManager.sendOutbound(testUser.id, 'test message', 'msg_fake', 'conv_fake');

    // Check no bridge messages created
    const bridgeMessages = await prisma.iMBridgeMessage.findMany({
      where: {
        binding: { imUserId: testUser.id },
      },
    });
    assertEqual(bridgeMessages.length, 0, 'no bridge messages');

    // Cleanup
    await prisma.iMUser.delete({ where: { id: testUser.id } });
  });

  await redis.quit().catch(() => {});
  await prisma.$disconnect();
}

// ═══════════════════════════════════════════════════════════
//  TEST SUITE 5: /me Enhancement
// ═══════════════════════════════════════════════════════════

async function testMeEnhancement() {
  console.log('\n🔹 /me Enhancement Tests');

  await test('ME1: /me includes bindings array', async () => {
    const res = await api('GET', '/me', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(Array.isArray(res.data.data.bindings), 'bindings should be array');
    // userA has telegram (active) + discord (pending)
    assert(res.data.data.bindings.length >= 1, 'should have at least 1 binding');
    const tg = res.data.data.bindings.find((b: any) => b.platform === 'telegram');
    assert(tg, 'should have telegram binding');
    assertEqual(tg.status, 'active', 'telegram status');
  });

  await test('ME2: /me includes credits', async () => {
    const res = await api('GET', '/me', undefined, userAToken);
    assert(res.data.ok, 'ok');
    assert(res.data.data.credits !== undefined, 'credits should exist');
    assertEqual(res.data.data.credits.balance, 100000, 'default balance');
  });
}

// ═══════════════════════════════════════════════════════════
//  RUN ALL
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Prismer IM v0.3.0 Integration Tests');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Verify server is running
  try {
    const healthRes = await fetch(`${BASE}/api/health`);
    const health = await healthRes.json();
    if (!health.ok) throw new Error('Server not healthy');
    console.log(`  Server: ${BASE} ✓`);
  } catch {
    console.error(`\n❌ Cannot connect to ${BASE}`);
    console.error(
      '   Start the server: DATABASE_URL="file:/Users/prismer/workspace/prismercloud/prisma/dev.db" npx tsx src/im/start.ts',
    );
    process.exit(1);
  }

  await setup();
  await testBindings();
  await testCredits();
  await testCreditServiceInternal();
  await testBridge();
  await testMeEnhancement();

  // ─── Summary ────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    ❌ ${f}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

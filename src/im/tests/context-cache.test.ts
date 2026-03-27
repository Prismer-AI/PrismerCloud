/**
 * Context Cache Service — Unit Tests
 *
 * Tests the Prisma-first context cache (v1.6.0).
 * Runs directly against SQLite dev.db — no server needed.
 *
 * Usage:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/context-cache.test.ts
 */

import { ContextCacheService, computeRawLinkHash } from '@/lib/context-cache.service';
import prisma from '@/lib/prisma';

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];
const TS = String(Date.now()).slice(-8);

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// ─── Setup ──────────────────────────────────────────────────

const service = new ContextCacheService();
const USER_A = `test_user_a_${TS}`;
const USER_B = `test_user_b_${TS}`;

// Clean up test entries on exit
async function cleanup() {
  try {
    await prisma.contextCache.deleteMany({
      where: {
        userId: { in: [USER_A, USER_B] }
      }
    });
    console.log('\n  🧹 Cleaned up test entries');
  } catch {
    // ignore cleanup errors
  }
}

// ─── Tests ──────────────────────────────────────────────────

async function runTests() {
  console.log('\n📦 Context Cache Service Tests\n');
  console.log(`  Users: ${USER_A}, ${USER_B}`);
  console.log('');

  // ── 1. computeRawLinkHash ─────────────────────────────────
  await test('1. computeRawLinkHash returns consistent SHA-256 hex', () => {
    const hash1 = computeRawLinkHash('https://example.com/test');
    const hash2 = computeRawLinkHash('https://example.com/test');
    assert(hash1 === hash2, 'Hashes should be equal for same input');
    assert(hash1.length === 64, `Expected 64-char hex, got ${hash1.length}`);
    assert(/^[0-9a-f]+$/.test(hash1), 'Should be lowercase hex');
  });

  await test('2. computeRawLinkHash differs for different inputs', () => {
    const hash1 = computeRawLinkHash('https://example.com/a');
    const hash2 = computeRawLinkHash('https://example.com/b');
    assert(hash1 !== hash2, 'Different inputs should produce different hashes');
  });

  // ── 2. Deposit + Withdraw (happy path) ────────────────────
  const testUrl1 = `https://example.com/test-${TS}-1`;

  await test('3. deposit() creates new entry', async () => {
    const result = await service.deposit({
      userId: USER_A,
      rawLink: testUrl1,
      hqccContent: 'This is HQCC content for test 1',
      intrContent: 'This is raw/intermediate content',
      visibility: 'public',
      meta: { source: 'test', version: '1.6.0' },
    });
    assert(result.status === 'created', `Expected status 'created', got '${result.status}'`);
    assert(result.rawLinkHash.length === 64, 'Should have rawLinkHash');
    assert(result.id.length > 0, 'Should have id');
  });

  await test('4. withdraw() returns deposited content (default format=hqcc)', async () => {
    const result = await service.withdraw({ rawLink: testUrl1 }, USER_A);
    assert(result.found === true, 'Should be found');
    assert(result.hqcc_content === 'This is HQCC content for test 1', 'HQCC should match');
    // Default format is 'hqcc', so intr_content is omitted
    assert(result.intr_content === undefined, 'INTR should be omitted with default format');
    assert(result.visibility === 'public', 'Visibility should be public');
    assert(result.raw_link === testUrl1, 'raw_link should match');
  });

  await test('5. withdraw() with format=hqcc omits intr_content', async () => {
    const result = await service.withdraw({ rawLink: testUrl1, format: 'hqcc' }, USER_A);
    assert(result.found === true, 'Should be found');
    assert(result.hqcc_content !== undefined, 'HQCC should be present');
    assert(result.intr_content === undefined, 'INTR should be omitted');
  });

  await test('6. withdraw() with format=intr omits hqcc_content', async () => {
    const result = await service.withdraw({ rawLink: testUrl1, format: 'intr' }, USER_A);
    assert(result.found === true, 'Should be found');
    assert(result.hqcc_content === undefined, 'HQCC should be omitted');
    assert(result.intr_content !== undefined, 'INTR should be present');
  });

  await test('7. withdraw() with format=both returns both', async () => {
    const result = await service.withdraw({ rawLink: testUrl1, format: 'both' }, USER_A);
    assert(result.found === true, 'Should be found');
    assert(result.hqcc_content !== undefined, 'HQCC should be present');
    assert(result.intr_content !== undefined, 'INTR should be present');
  });

  // ── 3. Visibility enforcement ─────────────────────────────
  const privateUrl = `https://example.com/private-${TS}`;

  await test('8. Private: owner can read', async () => {
    await service.deposit({
      userId: USER_A,
      rawLink: privateUrl,
      hqccContent: 'Secret content',
      visibility: 'private',
    });
    const result = await service.withdraw({ rawLink: privateUrl }, USER_A);
    assert(result.found === true, 'Owner should see private entry');
    assert(result.hqcc_content === 'Secret content', 'Content should match');
  });

  await test('9. Private: non-owner gets found=false', async () => {
    const result = await service.withdraw({ rawLink: privateUrl }, USER_B);
    assert(result.found === false, 'Non-owner should NOT see private entry');
  });

  await test('10. Public: non-owner CAN read', async () => {
    const result = await service.withdraw({ rawLink: testUrl1 }, USER_B);
    assert(result.found === true, 'Non-owner should see public entry');
  });

  // ── 4. Upsert (same URL, deposit twice) ───────────────────
  await test('11. deposit() updates existing entry (upsert)', async () => {
    const result = await service.deposit({
      userId: USER_A,
      rawLink: testUrl1,
      hqccContent: 'Updated HQCC content',
      visibility: 'public',
      meta: { source: 'test', version: '1.6.0', updated: true },
    });
    assert(result.status === 'updated', `Expected 'updated', got '${result.status}'`);

    const check = await service.withdraw({ rawLink: testUrl1 }, USER_A);
    assert(check.hqcc_content === 'Updated HQCC content', 'Content should be updated');
  });

  // ── 5. Private update permission ──────────────────────────
  await test('12. Non-owner cannot update private entry', async () => {
    try {
      await service.deposit({
        userId: USER_B,
        rawLink: privateUrl,
        hqccContent: 'Trying to overwrite',
        visibility: 'private',
      });
      assert(false, 'Should have thrown permission error');
    } catch (err: any) {
      assert(err.message.includes('Permission denied'), `Expected permission error, got: ${err.message}`);
    }
  });

  // ── 6. Batch withdraw ─────────────────────────────────────
  const batchUrl2 = `https://example.com/batch-${TS}-2`;
  const batchUrl3 = `https://example.com/batch-${TS}-3`;

  await test('13. withdrawBatch() returns mixed results', async () => {
    // Deposit one more public entry
    await service.deposit({
      userId: USER_A,
      rawLink: batchUrl2,
      hqccContent: 'Batch content 2',
      visibility: 'public',
    });

    const result = await service.withdrawBatch(
      [testUrl1, batchUrl2, batchUrl3], // batchUrl3 doesn't exist
      USER_A
    );
    assert(result.results.length === 3, `Expected 3 results, got ${result.results.length}`);
    assert(result.summary.total === 3, 'Total should be 3');
    assert(result.summary.found === 2, `Found should be 2, got ${result.summary.found}`);
    assert(result.summary.not_found === 1, 'Not found should be 1');

    // Check individual results
    const r1 = result.results.find(r => r.raw_link === testUrl1);
    assert(r1?.found === true, 'testUrl1 should be found');
    assert(r1?.hqcc_content === 'Updated HQCC content', 'testUrl1 content should match');

    const r3 = result.results.find(r => r.raw_link === batchUrl3);
    assert(r3?.found === false, 'batchUrl3 should not be found');
  });

  await test('14. withdrawBatch() respects visibility (private hidden from non-owner)', async () => {
    const result = await service.withdrawBatch(
      [testUrl1, privateUrl], // testUrl1=public, privateUrl=private to USER_A
      USER_B // USER_B is NOT the owner
    );
    assert(result.summary.found === 1, `USER_B should only see public entry, got found=${result.summary.found}`);
  });

  // ── 7. 100MB size gate ────────────────────────────────────
  await test('15. 100MB+ content is rejected', async () => {
    const hugeContent = 'x'.repeat(101 * 1024 * 1024); // 101MB
    try {
      await service.deposit({
        userId: USER_A,
        rawLink: `https://example.com/huge-${TS}`,
        hqccContent: hugeContent,
      });
      assert(false, 'Should have thrown size error');
    } catch (err: any) {
      assert(err.message.includes('100MB'), `Expected 100MB error, got: ${err.message}`);
    }
  });

  // ── 8. Delete ─────────────────────────────────────────────
  await test('16. delete() by owner succeeds', async () => {
    const deleted = await service.delete(batchUrl2, USER_A);
    assert(deleted === true, 'Should return true for owner delete');

    const check = await service.withdraw({ rawLink: batchUrl2 }, USER_A);
    assert(check.found === false, 'Should not find deleted entry');
  });

  await test('17. delete() by non-owner fails', async () => {
    const deleted = await service.delete(testUrl1, USER_B);
    assert(deleted === false, 'Non-owner should not be able to delete');

    const check = await service.withdraw({ rawLink: testUrl1 }, USER_A);
    assert(check.found === true, 'Entry should still exist');
  });

  // ── 9. withdraw by rawLinkHash ────────────────────────────
  await test('18. withdraw() by rawLinkHash works', async () => {
    const hash = computeRawLinkHash(testUrl1);
    const result = await service.withdraw({ rawLinkHash: hash }, USER_A);
    assert(result.found === true, 'Should find by hash');
    assert(result.raw_link === testUrl1, 'raw_link should match');
  });

  // ── 10. Meta parsing ──────────────────────────────────────
  await test('19. meta is stored and retrieved as object', async () => {
    const result = await service.withdraw({ rawLink: testUrl1 }, USER_A);
    assert(result.found === true, 'Should be found');
    assert(typeof result.meta === 'object', 'Meta should be an object');
    assert(result.meta?.source === 'test', 'Meta.source should be "test"');
  });

  // ── 11. Missing input returns found:false ─────────────────
  await test('20. withdraw() with no rawLink and no hash returns found:false', async () => {
    const result = await service.withdraw({}, USER_A);
    assert(result.found === false, 'Should return found:false for empty input');
  });

  // ── Summary ───────────────────────────────────────────────
  await cleanup();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    ❌ ${f}`));
  }
  console.log(`${'═'.repeat(50)}\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

// Run
runTests().catch(async (err) => {
  console.error('\n💥 Fatal error:', err);
  await cleanup();
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * X-movx9sup Smoke Test Suite
 *
 * Tests the M3/M4 mixed-daemon work_item dispatch functionality
 *
 * Usage: npx tsx src/im/tests/x-movx9sup.test.ts
 */

import {
  executeXmovx9supSmoke,
  validateXmovx9supOutput,
  getXmovx9supMetadata,
  completeXmovx9supSync,
} from '../../lib/x-movx9sup';

// Simple test runner
interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}

const tests: TestCase[] = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

function assertEqual(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(value: boolean, message?: string) {
  if (!value) {
    throw new Error(message || 'Expected true, got false');
  }
}

// Test cases
test('executeXmovx9supSmoke returns success result', async () => {
  const result = await executeXmovx9supSmoke();

  assertEqual(result.success, true, 'Result should be successful');
  assertEqual(result.tag, 'movx9sup', 'Tag should be movx9sup');
  assertEqual(result.mode, 'engineer-token-complete-agent-run', 'Mode should be engineer-token-complete-agent-run');
  assertTrue(result.output.includes('M4OK-movx9sup'), 'Output should contain M4OK-movx9sup');
  assertTrue(validateXmovx9supOutput(result.output), 'Output should pass validation');
});

test('executeXmovx9supSmoke with forceFail returns failure', async () => {
  const result = await executeXmovx9supSmoke({ forceFail: true });

  assertEqual(result.success, false, 'Result should be unsuccessful when forceFail is true');
  assertTrue(result.output.includes('M4FAIL-movx9sup'), 'Output should contain M4FAIL-movx9sup');
});

test('validateXmovx9supOutput validates correct output', () => {
  const validOutput = 'M4OK-movx9sup: Engineer completed the deterministic M4 smoke run.';
  assertTrue(validateXmovx9supOutput(validOutput), 'Should validate correct output');
});

test('validateXmovx9supOutput rejects invalid output', () => {
  const invalidOutput = 'Some random output';
  assertEqual(validateXmovx9supOutput(invalidOutput), false, 'Should reject invalid output');
});

test('getXmovx9supMetadata returns correct metadata', () => {
  const metadata = getXmovx9supMetadata();

  assertEqual(metadata.id, 'X-movx9sup', 'ID should be X-movx9sup');
  assertEqual(metadata.mvp, 'm3', 'MVP should be m3');
  assertEqual(metadata.tag, 'movx9sup', 'Tag should be movx9sup');
  assertEqual(metadata.engineerId, 'bhb0hfnw05f', 'Engineer ID should match');
});

test('completeXmovx9supSync returns immediate result', () => {
  const result = completeXmovx9supSync();

  assertEqual(result.success, true, 'Sync result should be successful');
  assertTrue(result.output.includes('M4OK-movx9sup'), 'Sync output should contain M4OK-movx9sup');
  assertTrue(result.timestamp !== undefined, 'Sync result should have timestamp');
});

test('executeXmovx9supSmoke respects custom assignee', async () => {
  const customAssignee = 'custom-engineer-id';
  const result = await executeXmovx9supSmoke({ assigneeImUserId: customAssignee });

  assertEqual(result.metadata.assignee, customAssignee, 'Should use custom assignee ID');
});

// Run tests
async function runTests() {
  console.log('========================================');
  console.log('X-movx9sup Smoke Test Suite');
  console.log('========================================\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (error) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================');

  // Return the expected M4OK output for smoke test verification
  console.log('\n📝 Smoke Test Output:');
  const result = completeXmovx9supSync();
  console.log(result.output);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();

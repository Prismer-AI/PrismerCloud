/**
 * Unit test for TaskAcceptanceService (release201/10 rev 2 — pure functions only).
 *
 * Run:
 *   npx tsx src/im/services/__tests__/task-acceptance.rev2.test.ts
 *
 * Covers:
 *   - recomputeAcceptanceStatus 5 paths (none / pending / partial / passed / failed)
 *   - extractEvidenceAssetIds — string + entry forms + crossTaskConfirmed
 */

import { strict as assert } from 'node:assert';
import { recomputeAcceptanceStatus, extractEvidenceAssetIds, type Criterion } from '../task-acceptance.service';

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    process.stdout.write(`✓ ${name}\n`);
  } catch (err) {
    fail++;
    process.stderr.write(`✗ ${name}\n   ${(err as Error).message}\n`);
  }
}

function c(status: Criterion['status']): Criterion {
  return {
    id: 'c' + status,
    verifyMode: 'manual',
    expectation: 'x',
    verifierAgentId: null,
    status,
    required: true,
    evidenceRefs: [],
    weight: 1,
  };
}

test('recompute — empty criteria → none', () => {
  assert.equal(recomputeAcceptanceStatus([]), 'none');
});

test('recompute — all passed → passed', () => {
  assert.equal(recomputeAcceptanceStatus([c('passed'), c('passed')]), 'passed');
});

test('recompute — passed + n/a → passed (n/a is non-blocking)', () => {
  assert.equal(recomputeAcceptanceStatus([c('passed'), c('n/a')]), 'passed');
});

test('recompute — passed + waived → passed (waived counts as n/a)', () => {
  assert.equal(recomputeAcceptanceStatus([c('passed'), c('waived')]), 'passed');
});

test('recompute — any failed → failed', () => {
  assert.equal(recomputeAcceptanceStatus([c('passed'), c('failed'), c('pending')]), 'failed');
});

test('recompute — mixed passed+pending → partial', () => {
  assert.equal(recomputeAcceptanceStatus([c('passed'), c('pending')]), 'partial');
});

test('recompute — all pending → pending', () => {
  assert.equal(recomputeAcceptanceStatus([c('pending'), c('pending')]), 'pending');
});

test('extractEvidenceAssetIds — string refs (asset:<id>)', () => {
  const out = extractEvidenceAssetIds(['asset:abc123', 'url:https://x', 'asset:def456']);
  assert.deepEqual(out, [
    { assetId: 'abc123', crossTaskConfirmed: false },
    { assetId: 'def456', crossTaskConfirmed: false },
  ]);
});

test('extractEvidenceAssetIds — entry form with crossTaskConfirmed', () => {
  const out = extractEvidenceAssetIds([
    { ref: 'asset:xyz', crossTaskConfirmed: true },
    { ref: 'asset:abc' },
    { ref: 'url:y' },
  ]);
  assert.deepEqual(out, [
    { assetId: 'xyz', crossTaskConfirmed: true },
    { assetId: 'abc', crossTaskConfirmed: false },
  ]);
});

test('extractEvidenceAssetIds — empty / undefined → []', () => {
  assert.deepEqual(extractEvidenceAssetIds(undefined), []);
  assert.deepEqual(extractEvidenceAssetIds([]), []);
});

if (fail > 0) {
  process.stderr.write(`\nFAILED — ${fail}/${pass + fail}\n`);
  process.exit(1);
}
process.stdout.write(`\nOK — ${pass}/${pass + fail}\n`);

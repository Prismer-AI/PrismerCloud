/**
 * Unit test for TodoService (release201/10 rev 2 §5.3 DoD).
 *
 * Run:
 *   npx tsx src/im/services/__tests__/todo.service.test.ts
 *
 * Pure in-process. Covers the parser/serialiser round-trip + tick semantics.
 * Does NOT touch the DB (those paths require a live MySQL).
 */

import { strict as assert } from 'node:assert';
import { parseTodoMarkdown, serialiseTodoMarkdown } from '../todo.service';

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

test('parseTodoMarkdown — empty returns []', () => {
  assert.deepEqual(parseTodoMarkdown(''), []);
});

test('parseTodoMarkdown — single pending item', () => {
  const items = parseTodoMarkdown('- [ ] step one');
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, 'step one');
  assert.equal(items[0]?.status, 'pending');
  assert.equal(items[0]?.depth, 0);
});

test('parseTodoMarkdown — done + uppercase X both supported', () => {
  const items = parseTodoMarkdown('- [x] lower\n- [X] upper');
  assert.equal(items.length, 2);
  assert.equal(items[0]?.status, 'done');
  assert.equal(items[1]?.status, 'done');
});

test('parseTodoMarkdown — depth from leading-spaces / 2 capped at 3', () => {
  const md = '- [ ] root\n  - [ ] level1\n    - [ ] level2\n        - [ ] level4_capped_to_3';
  const items = parseTodoMarkdown(md);
  assert.equal(items.length, 4);
  assert.equal(items[0]?.depth, 0);
  assert.equal(items[1]?.depth, 1);
  assert.equal(items[2]?.depth, 2);
  assert.equal(items[3]?.depth, 3); // capped
});

test('parseTodoMarkdown — non-checkbox lines are excluded from items', () => {
  const md = '# TODO heading\nfree paragraph\n- [ ] one\n# nested heading\n- [x] two';
  const items = parseTodoMarkdown(md);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.text, 'one');
  assert.equal(items[1]?.text, 'two');
});

test('serialiseTodoMarkdown — round-trip preserves text + status + depth', () => {
  const items = [
    { index: 0, depth: 0, status: 'pending' as const, text: 'a' },
    { index: 1, depth: 1, status: 'done' as const, text: 'b' },
    { index: 2, depth: 0, status: 'pending' as const, text: 'c' },
  ];
  const md = serialiseTodoMarkdown(items);
  const reparsed = parseTodoMarkdown(md);
  assert.equal(reparsed.length, 3);
  assert.equal(reparsed[0]?.status, 'pending');
  assert.equal(reparsed[1]?.status, 'done');
  assert.equal(reparsed[1]?.depth, 1);
  assert.equal(reparsed[2]?.text, 'c');
});

test('serialiseTodoMarkdown — header prepended cleanly when supplied', () => {
  const md = serialiseTodoMarkdown(
    [{ index: 0, depth: 0, status: 'pending' as const, text: 'step' }],
    '# TODO — checkout',
  );
  assert.ok(md.startsWith('# TODO — checkout'));
  assert.ok(md.includes('- [ ] step'));
});

if (fail > 0) {
  process.stderr.write(`\nFAILED — ${fail}/${pass + fail}\n`);
  process.exit(1);
}
process.stdout.write(`\nOK — ${pass}/${pass + fail}\n`);

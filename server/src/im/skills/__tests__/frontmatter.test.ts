/**
 * Unit test for src/im/skills/frontmatter.ts.
 *
 * Run:
 *   npx tsx src/im/skills/__tests__/frontmatter.test.ts
 *
 * Pure in-process — no DB, no network. Asserts agentskills.io frontmatter
 * compliance: name regex / description ≤ 1024 / metadata mapping /
 * compatibility string|array / allowed-tools / name-vs-dir.
 */

import {
  parseFrontmatter,
  validateAgainstDirName,
  NAME_PATTERN,
  DESCRIPTION_MAX_LENGTH,
} from '../frontmatter';

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`);
  }
}

function truthy(label: string, value: unknown) {
  if (value) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label} (expected truthy, got ${JSON.stringify(value)})`);
  }
}

function falsy(label: string, value: unknown) {
  if (!value) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label} (expected falsy, got ${JSON.stringify(value)})`);
  }
}

function group(name: string, fn: () => void) {
  console.log(`\n• ${name}`);
  fn();
}

// ─── Tests ───────────────────────────────────────────────────────────────

group('NAME_PATTERN regex', () => {
  eq('accepts single char "a"', NAME_PATTERN.test('a'), true);
  eq('accepts "tasks"', NAME_PATTERN.test('tasks'), true);
  eq('accepts "agent-coordination"', NAME_PATTERN.test('agent-coordination'), true);
  eq('accepts ending in digit "v1"', NAME_PATTERN.test('v1'), true);
  eq('accepts complex "theme-factory"', NAME_PATTERN.test('theme-factory'), true);
  eq('rejects starting digit "1abc"', NAME_PATTERN.test('1abc'), false);
  eq('rejects ending hyphen "abc-"', NAME_PATTERN.test('abc-'), false);
  eq('rejects uppercase "Abc"', NAME_PATTERN.test('Abc'), false);
  eq('rejects underscore "ab_c"', NAME_PATTERN.test('ab_c'), false);
  eq('rejects 65-char name', NAME_PATTERN.test('a' + 'b'.repeat(63) + 'c'), false);
  eq('accepts 64-char name', NAME_PATTERN.test('a' + 'b'.repeat(62) + 'c'), true);
});

group('parseFrontmatter — no frontmatter at all', () => {
  const r = parseFrontmatter('# Hello\nbody text');
  eq('body kept verbatim', r.body, '# Hello\nbody text');
  eq('no fm fields', r.fm.name, undefined);
  eq('no errors', r.errors, []);
});

group('parseFrontmatter — happy path with name+description', () => {
  const r = parseFrontmatter('---\nname: tasks\ndescription: Manage tasks\n---\n# Body\n');
  eq('name', r.fm.name, 'tasks');
  eq('description', r.fm.description, 'Manage tasks');
  eq('body strip ok', r.body, '# Body\n');
  eq('no errors', r.errors, []);
});

group('parseFrontmatter — full agentskills.io fields', () => {
  const src = [
    '---',
    'name: theme-factory',
    'description: Toolkit for styling artifacts.',
    'license: Complete terms in LICENSE.txt',
    'compatibility:',
    '  - claude-code',
    '  - prismer-sdk',
    'metadata:',
    '  prismer:',
    '    category: ui',
    'allowed-tools:',
    '  - Read',
    '  - Bash(npm:*)',
    '---',
    '# body',
    '',
  ].join('\n');
  const r = parseFrontmatter(src);
  eq('errors empty', r.errors, []);
  eq('name', r.fm.name, 'theme-factory');
  eq('description', r.fm.description, 'Toolkit for styling artifacts.');
  eq('license', r.fm.license, 'Complete terms in LICENSE.txt');
  eq('compatibility array', r.fm.compatibility, ['claude-code', 'prismer-sdk']);
  eq('metadata object', r.fm.metadata as any, { prismer: { category: 'ui' } });
  eq('allowed-tools array', r.fm['allowed-tools'], ['Read', 'Bash(npm:*)']);
});

group('parseFrontmatter — invalid name regex caught', () => {
  const r = parseFrontmatter('---\nname: BadName\ndescription: x\n---\n');
  eq('name still parsed', r.fm.name, 'BadName');
  truthy('error reported', r.errors.some((e) => e.includes('lowercase')));
});

group('parseFrontmatter — description too long', () => {
  const long = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 5);
  const r = parseFrontmatter(`---\nname: a\ndescription: ${long}\n---\n`);
  truthy('errors length', r.errors.some((e) => e.includes('≤ 1024')));
});

group('parseFrontmatter — metadata array rejected', () => {
  const r = parseFrontmatter('---\nname: a\nmetadata:\n  - x\n  - y\n---\n');
  truthy('error', r.errors.some((e) => e.includes('metadata must be a YAML mapping')));
});

group('parseFrontmatter — license as non-string rejected', () => {
  const r = parseFrontmatter('---\nname: a\nlicense:\n  - MIT\n---\n');
  truthy('error', r.errors.some((e) => e.includes('license must be a string')));
});

group('parseFrontmatter — compatibility as string accepted', () => {
  const r = parseFrontmatter('---\nname: a\ncompatibility: claude-code\n---\n');
  eq('compatibility scalar', r.fm.compatibility, 'claude-code');
  eq('no errors', r.errors, []);
});

group('parseFrontmatter — malformed YAML (top-level scalar)', () => {
  // YAML lib accepts loose mapping syntax; only top-level non-mapping yields an error.
  const r = parseFrontmatter('---\njust-a-string-no-map\n---\n');
  truthy('errors not empty', r.errors.length > 0);
});

group('parseFrontmatter — CRLF line endings', () => {
  const r = parseFrontmatter('---\r\nname: tasks\r\ndescription: x\r\n---\r\nbody\r\n');
  eq('name parsed', r.fm.name, 'tasks');
  eq('body parsed', r.body, 'body\r\n');
});

group('parseFrontmatter — empty frontmatter block', () => {
  const r = parseFrontmatter('---\n\n---\n# body\n');
  eq('no name', r.fm.name, undefined);
  eq('body kept', r.body, '# body\n');
  eq('no errors', r.errors, []);
});

group('validateAgainstDirName — match', () => {
  const r = parseFrontmatter('---\nname: tasks\n---\n');
  eq('no err', validateAgainstDirName(r.fm, 'tasks'), []);
});

group('validateAgainstDirName — mismatch', () => {
  const r = parseFrontmatter('---\nname: tasks\n---\n');
  const errs = validateAgainstDirName(r.fm, 'task');
  truthy('mismatch err raised', errs.some((e) => e.includes('must equal')));
});

group('validateAgainstDirName — missing name', () => {
  const errs = validateAgainstDirName({}, 'whatever');
  truthy('missing name err', errs.some((e) => e.includes('missing')));
});

// ─── Report ──────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} assertions; ${passed} passed; ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

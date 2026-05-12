/**
 * Asset manifest renderer unit tests (doc 27 rev 5 §3 + §7 MA-S1).
 *
 * Pure-function tests — no IM server boot required.
 *
 * Usage: npx tsx src/im/tests/asset-manifest.test.ts
 */

import {
  renderAssetManifestMarkdown,
  humanBytes,
  type AssetManifestRow,
} from '../api/asset-manifest';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function row(overrides: Partial<AssetManifestRow> = {}): AssetManifestRow {
  return {
    filename: 'test.txt',
    folderPath: null,
    mime: 'text/plain',
    sizeBytes: BigInt(42),
    contentHash: 'a'.repeat(64),
    createdAt: new Date('2026-04-15T10:30:00Z'),
    description: null,
    ...overrides,
  };
}

console.log('\n── Asset Manifest renderer ──');

test('empty list renders header + count', () => {
  const out = renderAssetManifestMarkdown('ws_x', []);
  assert(out.includes('# Workspace ws_x — asset manifest'), 'missing header');
  assert(out.includes('0 assets indexed'), `expected "0 assets indexed", got: ${out}`);
});

test('singular vs plural noun for one row', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row()]);
  assert(out.includes('1 asset indexed'), `expected "1 asset indexed", got: ${out}`);
});

test('row appears with prismer:// URI keyed on contentHash', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row({ contentHash: 'abc123' })]);
  assert(out.includes('prismer://workspace/ws_x/asset/abc123'), `URI missing in: ${out}`);
});

test('rows group by folderPath then mime, deterministic alpha order', () => {
  const rows: AssetManifestRow[] = [
    row({ filename: 'b.txt', folderPath: '/notes', mime: 'text/plain' }),
    row({ filename: 'a.txt', folderPath: '/notes', mime: 'text/plain' }),
    row({ filename: 'c.csv', folderPath: '/data', mime: 'text/csv' }),
    row({ filename: 'd.json', folderPath: '/data', mime: 'application/json' }),
  ];
  const out = renderAssetManifestMarkdown('ws_x', rows);
  // /data folder appears before /notes (alpha).
  const dataIdx = out.indexOf('## /data');
  const notesIdx = out.indexOf('## /notes');
  assert(dataIdx >= 0 && notesIdx >= 0, 'both folders missing');
  assert(dataIdx < notesIdx, '/data should sort before /notes');
  // Within /data: application/json (alpha) before text/csv.
  const jsonIdx = out.indexOf('### application/json');
  const csvIdx = out.indexOf('### text/csv');
  assert(jsonIdx >= 0 && csvIdx >= 0, 'mime sub-buckets missing');
  assert(jsonIdx < csvIdx, 'application/json should sort before text/csv');
});

test('null folderPath is bucketed under (root)', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row({ folderPath: null })]);
  assert(out.includes('## (root)'), `expected "(root)" group, got: ${out}`);
});

test('null mime is bucketed under (unknown mime)', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row({ mime: null })]);
  assert(out.includes('### (unknown mime)'), `expected "(unknown mime)" group, got: ${out}`);
});

test('description is appended to the row when present', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row({ description: 'Q1 sales' })]);
  assert(out.includes(' — Q1 sales'), `description missing in: ${out}`);
});

test('description omitted cleanly when null', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row({ description: null })]);
  // No double em-dash separator.
  assert(!out.includes(' —  — '), `unexpected blank description in: ${out}`);
});

test('does NOT contain content / HQCC fields (rev 5 §1 invariant)', () => {
  const out = renderAssetManifestMarkdown('ws_x', [row()]);
  assert(!/hqcc/i.test(out), 'manifest must not include HQCC');
  assert(!/intrcontent/i.test(out), 'manifest must not include INTR content');
});

test('humanBytes thresholds', () => {
  assert(humanBytes(null) === '? B', 'null → ? B');
  assert(humanBytes(BigInt(0)) === '0 B', '0 → 0 B');
  assert(humanBytes(BigInt(1023)) === '1023 B', '1023 → 1023 B');
  assert(humanBytes(BigInt(1024)) === '1.0 KB', '1024 → 1.0 KB');
  assert(humanBytes(BigInt(1024 * 1024)) === '1.0 MB', '1MB');
  assert(humanBytes(BigInt(1024 * 1024 * 1024)) === '1.00 GB', '1GB');
});

test('MA-S1: 50-row burst → 50 entries, no memory page references', () => {
  const rows: AssetManifestRow[] = Array.from({ length: 50 }, (_, i) =>
    row({
      filename: `burst-${i}.txt`,
      contentHash: `hash${i.toString().padStart(60, '0')}`,
    }),
  );
  const out = renderAssetManifestMarkdown('ws_x', rows);
  // 50 row markers (`- [filename]`).
  const matches = out.match(/^- \[/gm) ?? [];
  assert(matches.length === 50, `expected 50 row entries, got ${matches.length}`);
  assert(out.includes('50 assets indexed'), '50 header missing');
  // No language implying daemon ran an LLM on the contents.
  assert(!/summary|abstract|extracted/i.test(out), 'manifest must not include LLM-derived summary');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

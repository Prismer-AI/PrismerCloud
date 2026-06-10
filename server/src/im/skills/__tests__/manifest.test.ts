/**
 * Unit test for src/im/skills/manifest.ts — single-source manifest builder
 * used by built-in skills, evolution export-skill, and user-create.
 *
 * Run:
 *   npx tsx src/im/skills/__tests__/manifest.test.ts
 *
 * Asserts the §A.7 wire shape: each file has {path, sha256, size, inline} +
 * exactly one of {content, url}; merkle revision is `sha256` of sorted
 * `path:sha256` lines joined by "\n"; single-file shortcut matches the SQL
 * backfill (`SHA2(CONCAT('SKILL.md:', SHA2(content,256)),256)`).
 */

import {
  buildSingleFileManifest,
  buildManifest,
  computeManifestRevision,
  sha256Hex,
  getInlineThresholdBytes,
  DEFAULT_INLINE_THRESHOLD_BYTES,
} from '../manifest';

let passed = 0;
let failed = 0;

function eq(label: string, a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${y}\n    actual:   ${x}`);
  }
}
function truthy(label: string, v: unknown) {
  if (v) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label} (expected truthy)`);
  }
}
function group(label: string, fn: () => void | Promise<void>) {
  console.log(`\n• ${label}`);
  return fn();
}

(async () => {
  await group('buildSingleFileManifest — shape', async () => {
    const text = '---\nname: x\n---\n# body';
    const m = buildSingleFileManifest(text);
    eq('1 file', m.files.length, 1);
    eq('path SKILL.md', m.files[0]!.path, 'SKILL.md');
    eq('inline true', m.files[0]!.inline, true);
    eq('size matches utf-8 bytelen', m.files[0]!.size, Buffer.byteLength(text, 'utf8'));
    eq('sha256 of content', m.files[0]!.sha256, sha256Hex(text));
    eq(
      'content is base64 of utf-8',
      m.files[0]!.content,
      Buffer.from(text, 'utf8').toString('base64'),
    );
    // Revision must match the SQL backfill shape:
    //   SHA2(CONCAT('SKILL.md:', SHA2(content,256)), 256)
    eq('revision matches single-file SQL shape', m.revision, sha256Hex(`SKILL.md:${sha256Hex(text)}`));
  });

  await group('buildManifest — no uploadLarge → all inline', async () => {
    const m = await buildManifest([
      { path: 'SKILL.md', bytes: Buffer.from('hi') },
      { path: 'scripts/a.sh', bytes: Buffer.alloc(5_000_000, 0x42) }, // 5M
    ]);
    eq('both inline (no uploader)', m.files.every((f) => f.inline), true);
  });

  await group('buildManifest — explicit threshold', async () => {
    const m = await buildManifest(
      [
        { path: 'a.bin', bytes: Buffer.alloc(50) },
        { path: 'b.bin', bytes: Buffer.alloc(200) },
      ],
      {
        inlineThresholdBytes: 100,
        uploadLarge: async (file, hash) => ({
          url: `s3://bucket/skills/${hash}/${file.path}`,
          s3Key: `skills/${hash}/${file.path}`,
        }),
      },
    );
    const a = m.files.find((f) => f.path === 'a.bin')!;
    const b = m.files.find((f) => f.path === 'b.bin')!;
    eq('small inline', a.inline, true);
    eq('big not inline', b.inline, false);
    truthy('big has url', b.url?.startsWith('s3://'));
  });

  await group('computeManifestRevision — empty list', () => {
    const r = computeManifestRevision([]);
    eq('sha256 of empty string', r, sha256Hex(''));
  });

  await group('getInlineThresholdBytes — env override', () => {
    const prev = process.env.PRISMER_SKILL_INLINE_THRESHOLD_BYTES;
    process.env.PRISMER_SKILL_INLINE_THRESHOLD_BYTES = '50000';
    eq('reads env', getInlineThresholdBytes(), 50000);
    delete process.env.PRISMER_SKILL_INLINE_THRESHOLD_BYTES;
    eq('default fallback', getInlineThresholdBytes(), DEFAULT_INLINE_THRESHOLD_BYTES);
    if (prev !== undefined) process.env.PRISMER_SKILL_INLINE_THRESHOLD_BYTES = prev;
  });

  console.log(`\n${passed + failed} assertions; ${passed} passed; ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

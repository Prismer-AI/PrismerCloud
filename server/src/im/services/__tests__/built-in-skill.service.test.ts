/**
 * Unit test for built-in-skill.service.ts (manifest construction layer).
 *
 * Run:
 *   npx tsx src/im/services/__tests__/built-in-skill.service.test.ts
 *
 * Pure in-process, no DB. Exercises:
 *   • single-file SKILL.md → 1-entry manifest, revision matches sha256
 *   • multi-file (scripts/, references/) → N-entry manifest, sorted paths,
 *     stable revision across runs
 *   • binary asset (PNG bytes) → still inlined when ≤ threshold
 *   • > threshold file → goes to uploadLarge stub (proves the S3 branch
 *     wires through without needing real S3)
 *   • LICENSE.txt / .DS_Store / dotfile exclusion
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BuiltInSkillService, collectSkillFiles } from '../built-in-skill.service';
import { buildManifest, computeManifestRevision, sha256Hex } from '../../skills/manifest';

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${b}\n    actual:   ${a}`);
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
function group(name: string, fn: () => Promise<void>) {
  return (async () => {
    console.log(`\n• ${name}`);
    await fn();
  })();
}

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pc-skill-test-'));
}

async function main() {
  // ─── 1. Single-file SKILL.md only ────────────────────────────────────
  await group('readBuiltInSkillResources — single-file skill', async () => {
    const root = await makeTmpDir();
    const dir = path.join(root, 'tasks');
    await fs.mkdir(dir, { recursive: true });
    const skillMd = '---\nname: tasks\ndescription: Manage tasks\n---\n# Tasks\nbody\n';
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd);

    const svc = new BuiltInSkillService({} as any);
    const resources = await svc.readBuiltInSkillResources(root);
    eq('1 resource', resources.length, 1);
    const r = resources[0]!;
    eq('slug', r.slug, 'tasks');
    eq('fileCount', r.fileCount, 1);
    eq('manifest length', r.manifest.files.length, 1);
    eq('first path', r.manifest.files[0]!.path, 'SKILL.md');
    eq('inline', r.manifest.files[0]!.inline, true);
    truthy('has base64 content', typeof r.manifest.files[0]!.content === 'string');
    const expectedRevision = sha256Hex(`SKILL.md:${sha256Hex(skillMd)}`);
    eq('revision matches single-file shape', r.manifest.revision, expectedRevision);
    eq('fmErrors empty', r.fmErrors, []);
    eq('fm.name', r.fm.name, 'tasks');
    eq('fm.description', r.fm.description, 'Manage tasks');
  });

  // ─── 2. Multi-file with scripts/ + references/ ────────────────────────
  await group('readBuiltInSkillResources — multi-file skill', async () => {
    const root = await makeTmpDir();
    const dir = path.join(root, 'multi-file-smoke');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: multi-file-smoke\ndescription: Multi-file probe\nlicense: MIT\n---\n# Multi\n',
    );
    await fs.writeFile(path.join(dir, 'scripts', 'hello.sh'), '#!/bin/sh\necho hi\n');
    await fs.writeFile(path.join(dir, 'references', 'notes.md'), '# notes\nstuff\n');
    // Excluded files:
    await fs.writeFile(path.join(dir, 'LICENSE.txt'), 'MIT license body...');
    await fs.writeFile(path.join(dir, '.DS_Store'), 'mac junk');
    await fs.writeFile(path.join(dir, '.gitignore'), 'irrelevant');

    const svc = new BuiltInSkillService({} as any);
    const resources = await svc.readBuiltInSkillResources(root);
    const r = resources[0]!;
    eq('slug', r.slug, 'multi-file-smoke');
    eq('fileCount', r.fileCount, 3);
    const paths = r.manifest.files.map((f) => f.path).sort();
    eq('paths sorted', paths, ['SKILL.md', 'references/notes.md', 'scripts/hello.sh']);
    truthy('LICENSE.txt excluded', !paths.includes('LICENSE.txt'));
    truthy('.DS_Store excluded', !paths.includes('.DS_Store'));
    truthy('.gitignore excluded', !paths.includes('.gitignore'));
    eq('all inline', r.manifest.files.every((f) => f.inline), true);
    eq('license parsed', r.fm.license, 'MIT');

    // Revision is deterministic — re-running over the same dir yields the
    // same merkle root.
    const resources2 = await svc.readBuiltInSkillResources(root);
    eq('revision stable across reads', resources2[0]!.manifest.revision, r.manifest.revision);
  });

  // ─── 3. > threshold file goes through uploadLarge stub ───────────────
  await group('buildManifest — > threshold triggers uploadLarge', async () => {
    let calls = 0;
    const big = Buffer.alloc(200, 0x41); // 200B; threshold below.
    const small = Buffer.from('SKILL.md body');
    const inputs = [
      { path: 'SKILL.md', bytes: small },
      { path: 'assets/big.bin', bytes: big },
    ];
    const result = await buildManifest(inputs, {
      inlineThresholdBytes: 100,
      uploadLarge: async (file, hash) => {
        calls++;
        return { url: `https://s3.example.com/skills/${hash}/${path.basename(file.path)}`, s3Key: `skills/${hash}/x` };
      },
    });
    eq('uploadLarge called once', calls, 1);
    const bigFile = result.files.find((f) => f.path === 'assets/big.bin')!;
    eq('big file not inline', bigFile.inline, false);
    truthy('big file has url', !!bigFile.url);
    truthy('big file no content', bigFile.content === undefined);
    const smallFile = result.files.find((f) => f.path === 'SKILL.md')!;
    eq('small file inline', smallFile.inline, true);
    truthy('small file has content', !!smallFile.content);
  });

  // ─── 4. Binary asset inline encoding round-trip ──────────────────────
  await group('Binary asset round-trip (base64)', async () => {
    const root = await makeTmpDir();
    const dir = path.join(root, 'binary-skill');
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: binary-skill\n---\nbody\n');
    // Synthetic 16-byte "binary" payload (not a real PNG, but bytes are bytes)
    const binary = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await fs.writeFile(path.join(dir, 'assets', 'icon.png'), binary);

    const svc = new BuiltInSkillService({} as any);
    const r = (await svc.readBuiltInSkillResources(root))[0]!;
    const png = r.manifest.files.find((f) => f.path === 'assets/icon.png')!;
    eq('size', png.size, 16);
    eq('sha256', png.sha256, sha256Hex(binary));
    truthy('inline', png.inline);
    const roundTrip = Buffer.from(png.content!, 'base64');
    eq('bytes round-trip', roundTrip.toString('hex'), binary.toString('hex'));
  });

  // ─── 5. computeManifestRevision determinism + sort stability ──────────
  await group('computeManifestRevision — order independence', async () => {
    const a = [
      { path: 'SKILL.md', sha256: 'aaa' },
      { path: 'scripts/x.sh', sha256: 'bbb' },
    ];
    const b = [
      { path: 'scripts/x.sh', sha256: 'bbb' },
      { path: 'SKILL.md', sha256: 'aaa' },
    ];
    eq('order-independent revision', computeManifestRevision(a), computeManifestRevision(b));
    truthy(
      'different content → different revision',
      computeManifestRevision(a) !== computeManifestRevision([{ path: 'SKILL.md', sha256: 'ccc' }]),
    );
  });

  // ─── 6. Skill dir without SKILL.md is skipped ────────────────────────
  await group('Skill dir without SKILL.md is skipped silently', async () => {
    const root = await makeTmpDir();
    await fs.mkdir(path.join(root, 'orphan'), { recursive: true });
    await fs.writeFile(path.join(root, 'orphan', 'README.md'), 'no skill manifest here');
    const svc = new BuiltInSkillService({} as any);
    const resources = await svc.readBuiltInSkillResources(root);
    eq('zero resources', resources.length, 0);
  });

  // ─── 7. collectSkillFiles excluded basenames ─────────────────────────
  await group('collectSkillFiles — excludes', async () => {
    const root = await makeTmpDir();
    await fs.writeFile(path.join(root, 'SKILL.md'), 'x');
    await fs.writeFile(path.join(root, 'LICENSE.txt'), 'y');
    await fs.writeFile(path.join(root, 'Thumbs.db'), 'z');
    await fs.writeFile(path.join(root, 'real.py'), 'print(1)');
    const out = await collectSkillFiles(root);
    eq('only 2 files kept', out.length, 2);
    eq('sorted paths', out.map((f) => f.path).sort(), ['SKILL.md', 'real.py']);
  });

  console.log(`\n${passed + failed} assertions; ${passed} passed; ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST RUN ERROR', err);
  process.exit(2);
});

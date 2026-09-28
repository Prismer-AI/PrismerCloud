// apc-skill-distribution.test.ts — desktop205 D8.
//
// The bug this pins: `sdk/apc/skills/` existed ONLY in the repo working tree.
// `resolveApcSkillsRoot()` walks up from the running module, so on every
// non-repo host (OTA bundle, npm-installed daemon, desktop resources/runtime)
// it returned null → `installPlatformApcSkills()` returned null → nothing was
// ever installed. A second silent gate, independent of the platform gate.
//
// The assertions here are deliberately about SIDE EFFECTS, not intentions:
//
//   正控  — stage a bundle layout in a temp dir OUTSIDE the repo, bundle the
//           REAL coding-skill-set module into it with esbuild (so
//           `import.meta.url` genuinely points inside that layout), import it,
//           and assert `resolveApcSkillsRoot()` returns an existing path that
//           lives under the temp bundle. "I copied files" is not the claim;
//           "the function resolves" is.
//   负控  — delete `apc/skills` from that same bundle and assert BOTH that the
//           resolver goes null AND that `isValidBundleDir()` rejects the
//           bundle. If the OTA validity gate did not actually look at
//           apc/skills, this half stays green and the test fails.
//   drift — BUNDLE_REQUIRED_ENTRIES (runtime, loader side) and
//           REQUIRED_ENTRIES_BY_KIND.daemon (desktop, loader side) are declared
//           mirrors of each other; both packers must verify at least what the
//           loaders demand. Any future one-sided edit turns this red.
//
// This is the same failure shape as the 2026-07-19 "bundle packed without
// plugins/ ⇒ agent memory layer went dark" incident; the fix follows that
// precedent (packer + REQUIRED_ENTRIES together, never one alone).

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { BUNDLE_REQUIRED_ENTRIES, isValidBundleDir } from '../src/daemon/ota/bundle-store.js';

const runtimeRoot = resolve(__dirname, '..');
const repoRoot = resolve(runtimeRoot, '..', '..');
const apcSource = join(repoRoot, 'sdk', 'apc', 'skills');

const DESKTOP_BUNDLE_MANAGER = join(repoRoot, 'apps', 'desktop', 'electron', 'bundle-manager.ts');
const DESKTOP_PACKER = join(repoRoot, 'apps', 'desktop', 'scripts', 'build-daemon-bundle.cjs');
const K8S_PACKER = join(repoRoot, 'scripts', 'ops', 'build-daemon-runtime-bundle.ts');
const REQUIRED_ENTRIES_MANIFEST = join(runtimeRoot, 'src', 'daemon', 'ota', 'runtime-required-entries.json');

/** Strip `//` line comments, then pull every single-quoted literal. */
function quotedLiterals(block: string): string[] {
  const withoutComments = block
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function extractArray(file: string, pattern: RegExp): string[] {
  const src = readFileSync(file, 'utf8');
  const m = src.match(pattern);
  if (!m) throw new Error(`could not locate array in ${file} with ${pattern}`);
  return quotedLiterals(m[1]);
}

// ── fixture: a bundle layout OUTSIDE the repo ────────────────────────────────

let tmpRoot: string;
let bundle: string;
let probeUrl: string;

beforeAll(async () => {
  // `npm run prebuild` materialises these mirrors before Vitest starts. This
  // test must not run the real prebuild script itself: that script deletes and
  // recreates runtimeRoot/built-in-skills, which races with other parallel test
  // files that read the mirror during collection/execution.
  for (const required of [
    join(runtimeRoot, 'apc', 'skills'),
    join(runtimeRoot, 'built-in-skills', 'pkf-writing', 'SKILL.md'),
    join(runtimeRoot, 'built-in-skills', 'pkf-svg', 'SKILL.md'),
  ]) {
    if (!existsSync(required)) {
      throw new Error(`runtime prebuild mirror missing before tests: ${required}. Run npm run prebuild in sdk/prismer first.`);
    }
  }

  // realpath: on macOS tmpdir() is the /var → /private/var symlink, and the
  // resolver reports the real path it walked. Comparing the two forms would
  // fail for a reason that has nothing to do with what we're testing.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'prismer-apc-dist-')));
  bundle = join(tmpRoot, 'bundles', 'daemon', '9.9.9');
  mkdirSync(join(bundle, 'dist'), { recursive: true });

  // Exactly what the packers stage, from the SAME mirrored source they stage
  // from. Deliberately NOT fatal when absent: a broken mirror must surface as a
  // red assertion below ("resolver found nothing"), not as an opaque setup
  // crash that reports the whole file as skipped.
  if (existsSync(join(runtimeRoot, 'apc'))) {
    cpSync(join(runtimeRoot, 'apc'), join(bundle, 'apc'), { recursive: true });
  }
  mkdirSync(join(bundle, 'plugins', 'memory', 'prismer'), { recursive: true });
  writeFileSync(join(bundle, 'plugins', 'memory', 'prismer', '__init__.py'), '');
  for (const slug of ['pkf-writing', 'pkf-svg']) {
    mkdirSync(join(bundle, 'built-in-skills', slug), { recursive: true });
    cpSync(
      join(runtimeRoot, 'built-in-skills', slug, 'SKILL.md'),
      join(bundle, 'built-in-skills', slug, 'SKILL.md'),
    );
  }
  mkdirSync(join(bundle, 'node_modules', '@prismer', 'pkf'), { recursive: true });
  writeFileSync(
    join(bundle, 'node_modules', '@prismer', 'pkf', 'package.json'),
    JSON.stringify({ name: '@prismer/pkf', version: '0.3.0' }),
  );
  mkdirSync(join(bundle, 'node_modules', '@prismer', 'sdk'), { recursive: true });
  writeFileSync(
    join(bundle, 'node_modules', '@prismer', 'sdk', 'package.json'),
    JSON.stringify({ name: '@prismer/sdk', version: '9.9.9' }),
  );
  mkdirSync(join(bundle, 'node_modules', '@prismer', 'sdk', 'dist'), { recursive: true });
  writeFileSync(
    join(bundle, 'node_modules', '@prismer', 'sdk', 'dist', 'cli.js'),
    '#!/usr/bin/env node\n',
  );
  mkdirSync(join(bundle, 'node_modules', '@earendil-works', 'pi-agent-core'), { recursive: true });
  writeFileSync(
    join(bundle, 'node_modules', '@earendil-works', 'pi-agent-core', 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-agent-core', version: '0.84.2' }),
  );
  mkdirSync(join(bundle, 'node_modules', '@earendil-works', 'pi-ai'), { recursive: true });
  writeFileSync(
    join(bundle, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.84.2' }),
  );
  mkdirSync(join(bundle, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(bundle, 'node_modules', '.bin', 'cloud'), '#!/usr/bin/env node\n');
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9', type: 'module' }));

  // dist/cli.js — the real module, bundled the way tsup bundles it, so
  // `import.meta.url` inside it resolves to the temp bundle's dist/.
  await build({
    entryPoints: [join(runtimeRoot, 'src', 'adapters', 'coding', 'shared', 'coding-skill-set.ts')],
    outfile: join(bundle, 'dist', 'cli.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  });
  probeUrl = pathToFileURL(join(bundle, 'dist', 'cli.js')).href;

  // The env override is authoritative when set; it must not mask the walk.
  delete process.env.PRISMER_APC_SKILLS_ROOT;
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

type Probe = { resolveApcSkillsRoot: () => string | null; resolveApcSkillSet: (root: string) => unknown[] };

async function loadProbe(tag: string): Promise<Probe> {
  return (await import(`${probeUrl}?v=${tag}`)) as unknown as Probe;
}

// ── source of truth ──────────────────────────────────────────────────────────

describe('sdk/apc/skills is a real, non-empty source', () => {
  it('exists in the repo with SKILL.md-bearing dirs', () => {
    expect(existsSync(apcSource)).toBe(true);
    const skills = readdirSync(apcSource, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(apcSource, e.name, 'SKILL.md')))
      .map((e) => e.name);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('the prebuild hook mirrors it into the package root (what npm `files` ships)', () => {
    const mirrored = join(runtimeRoot, 'apc', 'skills');
    expect(existsSync(mirrored)).toBe(true);
    const src = readdirSync(apcSource).sort();
    expect(readdirSync(mirrored).sort()).toEqual(src);
  });

  it('runtime package.json ships apc/ via `files`', () => {
    const pkg = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('apc');
  });
});

// ── 正控 / 负控 ───────────────────────────────────────────────────────────────

describe('resolveApcSkillsRoot in a non-repo bundle layout', () => {
  it('正控: resolves to an EXISTING path inside the bundle (not the repo)', async () => {
    const { resolveApcSkillsRoot, resolveApcSkillSet } = await loadProbe('positive');
    const found = resolveApcSkillsRoot();

    expect(found).not.toBeNull();
    expect(existsSync(found!)).toBe(true);
    // Inside the temp bundle — proving it did NOT fall back to this checkout.
    expect(found!.startsWith(bundle)).toBe(true);
    expect(found!.startsWith(repoRoot)).toBe(false);
    // And the resolved root actually yields installable skills.
    expect(resolveApcSkillSet(found!).length).toBeGreaterThan(0);
  });

  it('正控: the same bundle passes the OTA validity gate', () => {
    expect(isValidBundleDir(bundle)).toBe(true);
  });

  it('负控: removing apc/skills makes the resolver null AND the bundle unusable', async () => {
    const apcDir = join(bundle, 'apc');
    const stash = join(tmpRoot, 'stash-apc');
    cpSync(apcDir, stash, { recursive: true });
    rmSync(apcDir, { recursive: true, force: true });
    try {
      const { resolveApcSkillsRoot } = await loadProbe('negative');
      expect(resolveApcSkillsRoot()).toBeNull();
      // The gate must SEE the omission — otherwise the packer fix is unenforced
      // and a future bundle can silently ship without APC again.
      expect(isValidBundleDir(bundle)).toBe(false);
    } finally {
      cpSync(stash, apcDir, { recursive: true });
      rmSync(stash, { recursive: true, force: true });
    }
  });
});

// ── drift gate ───────────────────────────────────────────────────────────────

describe('REQUIRED_ENTRIES must not drift across the four declaration sites', () => {
  it('runtime required-entry manifest drives BUNDLE_REQUIRED_ENTRIES and demands apc/skills', () => {
    const manifest = JSON.parse(readFileSync(REQUIRED_ENTRIES_MANIFEST, 'utf8')) as {
      daemonBundle: string[];
      k8sPackerExtra: string[];
      embeddedRuntimeExtra: string[];
    };
    expect(manifest.daemonBundle).toEqual([...BUNDLE_REQUIRED_ENTRIES]);
    expect(BUNDLE_REQUIRED_ENTRIES).toContain('apc/skills');
  });

  it('desktop REQUIRED_ENTRIES_BY_KIND.daemon is byte-for-byte the same list', () => {
    const desktop = extractArray(DESKTOP_BUNDLE_MANAGER, /daemon:\s*\[([\s\S]*?)\],/);
    expect(desktop).toEqual([...BUNDLE_REQUIRED_ENTRIES]);
  });

  // (The launchd boot shim, daemon-boot.cjs, used to be a THIRD loader-side
  // declaration and was pinned here — it had drifted to cli.js + package.json
  // only, so launchd could boot a bundle bundle-manager.ts rejects, which is the
  // memory-blackout shape. desktop205/04 §3.3-b deleted the shim along with
  // launchd residency, so there are two loader-side lists again, not three.
  //
  // Its OTHER pinned property — the built-in floor is held to a WEAKER,
  // startable-only contract, because refusing the floor turns "degraded daemon"
  // into "no daemon" — survives in the code it always described:
  // bundle-manager.resolveDaemonBundlePath() returns builtinRuntimeDir() WITHOUT
  // validating it. It is now asserted as a side effect instead of as a literal,
  // by scripts/desktop/fork-ota-e2e.ts NC-A/NC-B: a bundle missing a required
  // entry falls back to the floor AND the daemon still comes up.)

  it('both packers read the shared runtime required-entry manifest', () => {
    const desktopPacker = readFileSync(DESKTOP_PACKER, 'utf8');
    const k8sPacker = readFileSync(K8S_PACKER, 'utf8');
    expect(desktopPacker).toContain('runtime-required-entries.json');
    expect(desktopPacker).toContain('daemonBundle');
    expect(k8sPacker).toContain('runtime-required-entries.json');
    expect(k8sPacker).toContain('daemonBundle');
    expect(k8sPacker).toContain('k8sPackerExtra');
  });

  it('every packer stages apc/ — a required entry nobody copies would brick all bundles', () => {
    for (const file of [DESKTOP_PACKER, K8S_PACKER]) {
      const src = readFileSync(file, 'utf8');
      const m = src.match(/for \(const item of \[([^\]]*)\]\)/);
      expect(m, `no stage list in ${file}`).not.toBeNull();
      expect(quotedLiterals(m![1]), `stage list in ${file}`).toContain('apc');
    }
    // The desktop BUILT-IN floor is the fallback target when a bundle fails the
    // gate, and resolveDaemonBundlePath() returns it WITHOUT validating it. So
    // the floor must stage every required entry, else rejection degrades to an
    // equally-crippled runtime rather than a safe one.
    const assemble = readFileSync(join(repoRoot, 'apps', 'desktop', 'scripts', 'assemble-runtime.sh'), 'utf8');
    expect(assemble).toMatch(/cp -R "\$RUNTIME_SRC\/apc"/);
    expect(assemble).toMatch(/cp -R "\$RUNTIME_SRC\/plugins"/);
  });
});

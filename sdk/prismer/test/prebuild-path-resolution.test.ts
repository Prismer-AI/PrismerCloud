import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveMirrorSources, syncMirrors } = require('../scripts/prebuild-copy-built-in-skills.cjs') as {
  resolveMirrorSources: (runtimeRoot?: string) => {
    sdkRoot: string;
    builtInSource: string;
    apcSource: string;
  };
  syncMirrors: (runtimeRoot?: string) => void;
};

const temporaryRoots: string[] = [];

function createLayout(...directories: string[]): { root: string; runtimeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'prismer-prebuild-paths-'));
  temporaryRoots.push(root);
  const runtimeRoot = join(root, 'sdk', 'prismer');
  mkdirSync(runtimeRoot, { recursive: true });
  for (const directory of directories) mkdirSync(join(root, directory), { recursive: true });
  return { root, runtimeRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime prebuild source resolution', () => {
  it('resolves the Cloud-owned catalog and sdk-level APC source', () => {
    const { root, runtimeRoot } = createLayout('sdk/cloud/catalog/skills', 'sdk/apc/skills');

    expect(resolveMirrorSources(runtimeRoot)).toEqual({
      sdkRoot: join(root, 'sdk'),
      builtInSource: join(root, 'sdk', 'cloud', 'catalog', 'skills'),
      apcSource: join(root, 'sdk', 'apc', 'skills'),
    });
  });

  it('rejects the old broken sdk/built-in-skills and repository apc/skills roots', () => {
    const { runtimeRoot } = createLayout('sdk/built-in-skills', 'apc/skills');

    expect(() => resolveMirrorSources(runtimeRoot)).toThrow('source missing');
  });

  it('rejects the retired umbrella catalog even when APC exists', () => {
    const { runtimeRoot } = createLayout('sdk/prismer-cloud' + '/built-in-skills', 'sdk/apc/skills');

    expect(() => resolveMirrorSources(runtimeRoot)).toThrow('source missing');
  });

  it('resolves the checked-out final catalog layout', () => {
    const checkedOutRuntimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const sources = resolveMirrorSources(checkedOutRuntimeRoot);

    expect(sources.sdkRoot).toBe(resolve(checkedOutRuntimeRoot, '..'));
    expect(sources.builtInSource).toBe(resolve(checkedOutRuntimeRoot, '..', 'cloud', 'catalog', 'skills'));
    expect(sources.apcSource).toBe(resolve(checkedOutRuntimeRoot, '..', 'apc', 'skills'));
  });

  it('replaces stale legacy Remotion mirrors with the single canonical skill', () => {
    const { root, runtimeRoot } = createLayout(
      'sdk/cloud/catalog/skills/remotion',
      'sdk/apc/skills',
      'sdk/prismer/built-in-skills/remotion-create',
    );
    writeFileSync(join(root, 'sdk/cloud/catalog/skills/remotion/SKILL.md'), '# Remotion\n');

    syncMirrors(runtimeRoot);

    const mirroredRemotionDirs = readdirSync(join(runtimeRoot, 'built-in-skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('remotion'))
      .map((entry) => entry.name);
    expect(mirroredRemotionDirs).toEqual(['remotion']);
  });

  it('keeps checked-out canonical skill mirrors byte-identical', () => {
    const checkedOutRuntimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const catalogRoot = resolve(checkedOutRuntimeRoot, '..', 'cloud', 'catalog', 'skills');
    const bundledRoot = resolve(checkedOutRuntimeRoot, 'built-in-skills');

    for (const slug of ['pkf-writing', 'pkf-svg', 'remotion']) {
      const source = join(catalogRoot, slug, 'SKILL.md');
      const bundled = join(bundledRoot, slug, 'SKILL.md');
      expect(existsSync(source), `${slug} catalog source`).toBe(true);
      expect(existsSync(bundled), `${slug} runtime mirror`).toBe(true);
      expect(readFileSync(bundled, 'utf8'), `${slug} mirror bytes`).toBe(readFileSync(source, 'utf8'));
    }
    expect(existsSync(join(catalogRoot, 'pkf-visual'))).toBe(false);
    expect(existsSync(join(bundledRoot, 'pkf-visual'))).toBe(false);
  });
});

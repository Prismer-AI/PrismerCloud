import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..', '..');
const GENERATORS = [
  ['pkf-writing', join(REPO, 'sdk/cloud/scripts/gen-pkf-writing-skill.ts')],
  ['pkf-svg', join(REPO, 'sdk/cloud/scripts/gen-pkf-svg-skill.ts')],
] as const;

describe('PKF skill generator → catalog → Runtime mirror', () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it.each(GENERATORS)('%s generator writes byte-identical catalog and Runtime artifacts', (slug, generator) => {
    const root = mkdtempSync(join(tmpdir(), `prismer-${slug}-gen-`));
    cleanup.push(root);
    const catalogRoot = join(root, 'catalog');
    const runtimeRoot = join(root, 'runtime');
    execFileSync('npx', ['tsx', generator], {
      cwd: REPO,
      env: {
        ...process.env,
        PKF_SKILL_CATALOG_ROOT: catalogRoot,
        PKF_SKILL_RUNTIME_ROOT: runtimeRoot,
      },
      stdio: 'pipe',
    });

    const catalog = join(catalogRoot, slug, 'SKILL.md');
    const runtime = join(runtimeRoot, slug, 'SKILL.md');
    expect(existsSync(catalog)).toBe(true);
    expect(existsSync(runtime)).toBe(true);
    expect(readFileSync(runtime)).toEqual(readFileSync(catalog));
  });

  it.each(GENERATORS)('%s TAMPER gate writes neither side', (slug, generator) => {
    const root = mkdtempSync(join(tmpdir(), `prismer-${slug}-tamper-`));
    cleanup.push(root);
    const catalogRoot = join(root, 'catalog');
    const runtimeRoot = join(root, 'runtime');
    const result = spawnSync('npx', ['tsx', generator], {
      cwd: REPO,
      env: {
        ...process.env,
        TAMPER: '1',
        PKF_SKILL_CATALOG_ROOT: catalogRoot,
        PKF_SKILL_RUNTIME_ROOT: runtimeRoot,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(join(catalogRoot, slug, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(runtimeRoot, slug, 'SKILL.md'))).toBe(false);
  });
});

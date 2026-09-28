// @ts-nocheck -- exercises the shipped zero-dependency .mjs harness directly.
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LibraryImportError,
  loadLibraryImportConfig,
  runLibraryImport,
} from '../catalog/skills/skill-creator/scripts/import-library.mjs';

const roots: string[] = [];

function skillDocument(slug: string) {
  return `---\nname: ${slug}\ndescription: |\n  用于验证外部技能库的批量导入、失败恢复和规范化回读行为。\n---\n\n# ${slug}\n`;
}

function skillReadback(slug: string) {
  const content = skillDocument(slug);
  return {
    content,
    files: [
      {
        path: 'SKILL.md',
        size: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function library(skills: Array<{ dir: string; slug: string }>) {
  const root = mkdtempSync(join(tmpdir(), 'skill-library-'));
  roots.push(root);
  for (const skill of skills) {
    const directory = join(root, skill.dir);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), skillDocument(skill.slug));
  }
  return root;
}

function config(root: string, extra: Record<string, string> = {}) {
  return loadLibraryImportConfig(['--json'], {
    PRISMER_SKILL_LIBRARY_ROOT: root,
    PRISMER_IMPORT_LEDGER: join(root, 'ledger.json'),
    PRISMER_CLOUD_BASE: 'http://127.0.0.1:3000',
    PRISMER_API_KEY: 'fixture-only-skill-import-key',
    ...extra,
  });
}

describe('skill-library import harness', () => {
  it('negative control: rejects secret flags and remote writes locally', () => {
    const root = library([{ dir: 'zh/legal', slug: 'legal' }]);
    let caught: unknown;
    try {
      loadLibraryImportConfig(['--token=must-never-appear'], {
        PRISMER_SKILL_LIBRARY_ROOT: root,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LibraryImportError);
    expect(String((caught as Error).message)).not.toContain('must-never-appear');
    expect(() =>
      loadLibraryImportConfig([], {
        PRISMER_SKILL_LIBRARY_ROOT: root,
        PRISMER_CLOUD_BASE: 'https://example.invalid',
      }),
    ).toThrowError(/remote mutation is blocked/);
  });

  it('validates the complete selection before the first create mutation', async () => {
    const root = library([
      { dir: 'a', slug: 'skill-a' },
      { dir: 'b', slug: 'skill-b' },
    ]);
    const calls: string[][] = [];
    const runCloud = vi.fn(async (_config, args: string[]) => {
      calls.push(args);
      if (args[1] === 'validate') {
        const slug = args[2].endsWith('/a') ? 'skill-a' : 'skill-b';
        return slug === 'skill-b'
          ? { ok: false, status: 1, stdout: JSON.stringify({ ok: false, slug }), stderr: 'invalid' }
          : { ok: true, status: 0, stdout: JSON.stringify({ ok: true, slug }), stderr: '' };
      }
      throw new Error('mutation must not run');
    });

    await expect(runLibraryImport(config(root), runCloud)).rejects.toMatchObject({
      code: 'LIBRARY_VALIDATION_FAILED',
    });
    expect(calls.filter((args) => args[1] === 'validate')).toHaveLength(2);
    expect(calls.some((args) => args[1] === 'create')).toBe(false);
  });

  it('fails closed on mirror slug collisions before create', async () => {
    const root = library([
      { dir: 'zh/legal', slug: 'legal' },
      { dir: 'en/legal', slug: 'legal' },
    ]);
    const runCloud = vi.fn(async () => ({
      ok: true,
      status: 0,
      stdout: JSON.stringify({ ok: true, slug: 'legal' }),
      stderr: '',
    }));

    await expect(runLibraryImport(config(root), runCloud)).rejects.toMatchObject({
      code: 'DUPLICATE_SOURCE_SLUGS',
    });
    expect(runCloud.mock.calls.some(([, args]) => args[1] === 'create')).toBe(false);
  });

  it('creates, owner-readbacks, and emits canonical role skill requirements', async () => {
    const root = library([
      { dir: 'a', slug: 'skill-a' },
      { dir: 'b', slug: 'skill-b' },
    ]);
    const runCloud = vi.fn(async (_config, args: string[]) => {
      if (args[1] === 'validate') {
        const slug = args[2].endsWith('/a') ? 'skill-a' : 'skill-b';
        return { ok: true, status: 0, stdout: JSON.stringify({ ok: true, slug }), stderr: '' };
      }
      if (args[1] === 'create') {
        const requested = args[2].endsWith('/a') ? 'skill-a' : 'skill-b';
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({
            id: `id-${requested}`,
            slug: `community-${requested}`,
            publishScope: 'workspace',
            status: 'active',
          }),
          stderr: '',
        };
      }
      if (args[1] === 'show') {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify(skillReadback(args[2].replace(/^community-/, ''))),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    const result = await runLibraryImport(config(root), runCloud);

    expect(result.stage).toBe('completed');
    expect(result.rows.every((row) => row.stage === 'verified')).toBe(true);
    expect(result.requiredSkills).toEqual([
      { skillSlug: 'community-skill-a', required: true },
      { skillSlug: 'community-skill-b', required: true },
    ]);
    expect(runCloud.mock.calls.filter(([, args]) => args[1] === 'show')).toHaveLength(2);

    const resumedRunner = vi.fn(async (_config, args: string[]) => {
      expect(args[1]).toBe('show');
      return {
        ok: true,
        status: 0,
        stdout: JSON.stringify(skillReadback(args[2].replace(/^community-/, ''))),
        stderr: '',
      };
    });
    const resumed = await runLibraryImport(config(root), resumedRunner);
    expect(resumed.stage).toBe('completed');
    expect(resumed.rows.every((row) => row.stage === 'verified')).toBe(true);
    expect(resumed.requiredSkills).toEqual(result.requiredSkills);
    expect(resumedRunner.mock.calls.map(([, args]) => args)).toEqual([
      ['skill', 'show', 'community-skill-a', '--content', '--json'],
      ['skill', 'show', 'community-skill-b', '--content', '--json'],
    ]);
  });

  it('recovers the commit-before-ledger crash window only after byte-identical owner readback', async () => {
    const root = library([{ dir: 'legal', slug: 'legal' }]);
    const runCloud = vi.fn(async (_config, args: string[]) => {
      if (args[1] === 'validate') {
        return { ok: true, status: 0, stdout: JSON.stringify({ ok: true, slug: 'legal' }), stderr: '' };
      }
      if (args[1] === 'create') {
        return { ok: false, status: 1, stdout: '', stderr: 'slug collision' };
      }
      if (args[1] === 'show') {
        return { ok: true, status: 0, stdout: JSON.stringify(skillReadback('legal')), stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    const result = await runLibraryImport(config(root), runCloud);

    expect(result.stage).toBe('completed');
    expect(result.rows[0]).toMatchObject({
      stage: 'verified',
      canonicalSlug: 'community-legal',
      recoveredAfterCreateFailure: true,
    });
  });
});

// @ts-nocheck -- exercises the shipped zero-dependency .mjs harness directly.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRoleAuthoringConfig,
  RoleAuthoringError,
  runRoleAuthoring,
} from '../catalog/skills/role-builder/scripts/author-role.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'role-author-'));
  roots.push(root);
  const bundle = join(root, 'legal-expert');
  mkdirSync(bundle);
  writeFileSync(
    join(bundle, 'role.json'),
    JSON.stringify({
      slug: 'legal-expert',
      agentType: 'specialist',
      requiredSkills: [{ skillSlug: 'community-legal-research', required: true }],
    }),
  );
  writeFileSync(join(bundle, 'SOUL.md'), '# Legal Expert\n');
  return { root, bundle };
}

function config(root: string, bundle: string, argv: string[] = []) {
  return loadRoleAuthoringConfig(argv, {
    PRISMER_ROLE_BUNDLE: bundle,
    PRISMER_ROLE_AUTHORING_LEDGER: join(root, 'ledger.json'),
    PRISMER_CLOUD_BASE: 'http://127.0.0.1:3000',
    PRISMER_API_KEY: 'fixture-only-role-authoring-key',
  });
}

describe('role authoring harness', () => {
  it('negative control: secret flags and remote writes fail locally', () => {
    const { bundle } = fixture();
    let caught: unknown;
    try {
      loadRoleAuthoringConfig(['--api-key=must-never-appear'], { PRISMER_ROLE_BUNDLE: bundle });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RoleAuthoringError);
    expect(String((caught as Error).message)).not.toContain('must-never-appear');
    expect(() =>
      loadRoleAuthoringConfig([], {
        PRISMER_ROLE_BUNDLE: bundle,
        PRISMER_CLOUD_BASE: 'https://example.invalid',
      }),
    ).toThrowError(/remote mutation is blocked/);
  });

  it('does not create when required Skill preflight fails', async () => {
    const { root, bundle } = fixture();
    const runCloud = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 0,
        stdout: JSON.stringify({ ok: true, slug: 'legal-expert' }),
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: false, status: 1, stdout: '', stderr: 'required skill unavailable' });

    await expect(runRoleAuthoring(config(root, bundle), runCloud)).rejects.toMatchObject({
      code: 'ROLE_PREFLIGHT_FAILED',
    });
    expect(runCloud).toHaveBeenCalledTimes(2);
    expect(runCloud.mock.calls.some(([, args]) => args[1] === 'create')).toBe(false);
  });

  it('runs validate, dependency preflight, private create, and owner readback in order', async () => {
    const { root, bundle } = fixture();
    const runCloud = vi.fn(async (_config, args: string[]) => {
      if (args[1] === 'validate') {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({ ok: true, slug: 'legal-expert' }),
          stderr: '',
        };
      }
      if (args[1] === 'test') {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({ ok: true, slug: 'legal-expert', skills: [] }),
          stderr: '',
        };
      }
      if (args[1] === 'create') {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({ slug: 'legal-expert', domain: 'workspace' }),
          stderr: '',
        };
      }
      if (args[1] === 'show') {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({ slug: 'legal-expert', effectiveSkills: [] }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    const result = await runRoleAuthoring(config(root, bundle), runCloud);

    expect(result.stage).toBe('completed');
    expect(runCloud.mock.calls.map(([, args]) => args[1])).toEqual(['validate', 'test', 'create', 'show']);
    expect(runCloud.mock.calls[2][1]).toEqual(expect.arrayContaining(['role', 'create', bundle, '--mine', '--json']));
  });

  it('reuses a completed same-revision ledger without another role push', async () => {
    const { root, bundle } = fixture();
    const firstRunner = vi.fn(async (_config, args: string[]) => {
      const command = args[1];
      if (command === 'validate') {
        return { ok: true, status: 0, stdout: JSON.stringify({ ok: true, slug: 'legal-expert' }), stderr: '' };
      }
      if (command === 'test') {
        return { ok: true, status: 0, stdout: JSON.stringify({ ok: true, slug: 'legal-expert' }), stderr: '' };
      }
      if (command === 'create') {
        return { ok: true, status: 0, stdout: JSON.stringify({ slug: 'legal-expert' }), stderr: '' };
      }
      return { ok: true, status: 0, stdout: JSON.stringify({ slug: 'legal-expert' }), stderr: '' };
    });
    const loaded = config(root, bundle);
    const first = await runRoleAuthoring(loaded, firstRunner);
    const freshReadback = { slug: 'legal-expert', version: '1.0.2', effectiveSkills: [] };
    const secondRunner = vi.fn(async () => ({
      ok: true,
      status: 0,
      stdout: JSON.stringify(freshReadback),
      stderr: '',
    }));

    const second = await runRoleAuthoring(loaded, secondRunner);

    expect(first.stage).toBe('completed');
    expect(second.stage).toBe('completed');
    expect(secondRunner).toHaveBeenCalledTimes(1);
    expect(secondRunner.mock.calls[0][1]).toEqual(['role', 'show', 'legal-expert', '--json']);
    expect(second.readback).toEqual(freshReadback);
  });

  it('resumes a recorded create at readback without a second version-bumping push', async () => {
    const { root, bundle } = fixture();
    const loaded = config(root, bundle);
    const firstRunner = vi.fn(async (_config, args: string[]) => {
      const command = args[1];
      if (command === 'validate' || command === 'test') {
        return { ok: true, status: 0, stdout: JSON.stringify({ ok: true, slug: 'legal-expert' }), stderr: '' };
      }
      if (command === 'create') {
        return { ok: true, status: 0, stdout: JSON.stringify({ slug: 'legal-expert' }), stderr: '' };
      }
      return { ok: false, status: 503, stdout: '', stderr: 'readback unavailable' };
    });

    await expect(runRoleAuthoring(loaded, firstRunner)).rejects.toMatchObject({ code: 'ROLE_READBACK_FAILED' });

    const resumedRunner = vi.fn(async (_config, args: string[]) => ({
      ok: true,
      status: 0,
      stdout: JSON.stringify({ slug: args[2], version: '1.0.1' }),
      stderr: '',
    }));
    const resumed = await runRoleAuthoring(loaded, resumedRunner);

    expect(resumed.stage).toBe('completed');
    expect(resumedRunner).toHaveBeenCalledTimes(1);
    expect(resumedRunner.mock.calls[0][1][1]).toBe('show');
  });
});

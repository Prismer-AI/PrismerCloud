// release203/16 — CLI surface for the new lifecycle verbs (skill validate/package/test,
// role validate). Exercises the command tree + the local (no-network) verbs end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/auth.js', () => ({
  CloudClient: vi.fn().mockImplementation(() => ({ get: vi.fn(), request: vi.fn() })),
}));
vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({ api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'd1' })),
  resolvePaths: vi.fn(() => ({ root: '/tmp/prismer', localDb: '/tmp/prismer/local.db' })),
}));

import { buildSkillCommand } from '../src/cli/commands/skill.js';
import { buildRoleCommand } from '../src/cli/commands/role.js';
import { setUI, UI, __resetUIForTests } from '../src/cli/ui.js';

let root: string;
let stdout = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-lc-'));
  stdout = '';
  setUI(new UI({ mode: 'json', color: false }));
  vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    stdout += String(c);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}`);
  }) as never);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  __resetUIForTests();
});

// process.exit is mocked to throw, so an action that prints-then-exits emits its
// result JSON AND a second `exitWithError` envelope (runAction catches the throw).
// In the real CLI process.exit terminates, so only the first object prints. Parse
// the first top-level JSON object to assert on the real payload.
function firstJson(s: string): any {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  return JSON.parse(s);
}

function mkBundle(name: string, skillMd: string, extra?: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd);
  for (const [rel, c] of Object.entries(extra ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  return dir;
}

const GOOD = `---
name: hello-skill
description: A friendly demo skill that greets the user by name and returns a short welcome message.
category: demo
---
# Hello
`;

describe('command tree', () => {
  it('skill exposes validate/package/test/create', () => {
    const names = buildSkillCommand().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['validate', 'package', 'test', 'create']));
  });
  it('role exposes validate', () => {
    const names = buildRoleCommand().commands.map((c) => c.name());
    expect(names).toContain('validate');
  });
});

describe('cloud skill validate', () => {
  it('passes a valid bundle (exit 0, ok:true)', async () => {
    const dir = mkBundle('good', GOOD);
    await buildSkillCommand().parseAsync(['validate', dir, '--json'], { from: 'user' });
    expect(firstJson(stdout).ok).toBe(true);
  });

  it('fails an invalid bundle (exit 1, ok:false)', async () => {
    const dir = mkBundle('bad', '---\ndescription: x\n---\nb'); // no name
    await expect(
      buildSkillCommand().parseAsync(['validate', dir, '--json'], { from: 'user' }),
    ).rejects.toThrow(/__exit_1/);
    expect(firstJson(stdout).ok).toBe(false);
  });
});

describe('cloud skill package', () => {
  it('writes a tarball and prints merkle', async () => {
    const dir = mkBundle('pkg', GOOD, { 'scripts/x.sh': 'echo hi\n' });
    const out = join(root, 'pkg.tgz');
    await buildSkillCommand().parseAsync(['package', dir, '-o', out, '--json'], { from: 'user' });
    const res = firstJson(stdout);
    expect(existsSync(out)).toBe(true);
    expect(res.rev).toMatch(/^[0-9a-f]{64}$/);
    expect(res.files).toBe(2);
  });
});

describe('cloud skill test', () => {
  it('skips cleanly when skill.json has no sampleTasks', async () => {
    const dir = mkBundle('notest', GOOD);
    await buildSkillCommand().parseAsync(
      ['test', dir, '--agent', 'im-1', '--json'],
      { from: 'user' },
    );
    expect(firstJson(stdout).skipped).toBe(true);
  });
});

describe('cloud role validate', () => {
  it('passes a valid role.json', async () => {
    const f = join(root, 'role.json');
    writeFileSync(f, JSON.stringify({ slug: 'analyst', operatingPrinciples: 'be rigorous' }));
    await buildRoleCommand().parseAsync(['validate', f, '--json'], { from: 'user' });
    expect(firstJson(stdout).ok).toBe(true);
  });

  it('fails an invalid role.json (bad slug, exit 1)', async () => {
    const f = join(root, 'bad.json');
    writeFileSync(f, JSON.stringify({ slug: 'Bad Slug' }));
    await expect(
      buildRoleCommand().parseAsync(['validate', f, '--json'], { from: 'user' }),
    ).rejects.toThrow(/__exit_1/);
    expect(firstJson(stdout).ok).toBe(false);
  });

  it('passes a role DIRECTORY bundle (role.json + SOUL.md)', async () => {
    const dir = join(root, 'growth-role');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'role.json'), JSON.stringify({ slug: 'growth' }));
    writeFileSync(join(dir, 'SOUL.md'), '# Persona\nBe rigorous.');
    await buildRoleCommand().parseAsync(['validate', dir, '--json'], { from: 'user' });
    const out = firstJson(stdout);
    expect(out.ok).toBe(true);
    expect(out.bundleDir).toBe(true);
    expect(out.soul).toBe(true);
  });

  it('fails a role DIRECTORY missing role.json (exit 1)', async () => {
    const dir = join(root, 'no-rolejson');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SOUL.md'), 'persona only');
    await expect(
      buildRoleCommand().parseAsync(['validate', dir, '--json'], { from: 'user' }),
    ).rejects.toThrow(/__exit_1/);
    expect(firstJson(stdout).ok).toBe(false);
  });
});

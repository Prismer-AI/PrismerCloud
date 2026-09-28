import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { parseFrontmatter } from '../src/internal/bundle/index';
import { register as registerRole } from '../src/commands/role';
import { register as registerSkill } from '../src/commands/skill';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cloud-authoring-'));
  roots.push(root);
  return root;
}

function commandTree(client: unknown): Command {
  const root = new Command();
  registerSkill(root, () => client as never, () => client as never);
  registerRole(root, () => client as never, () => client as never);
  root.exitOverride();
  return root;
}

describe('skill/role authoring CLI closure', () => {
  it('parses standard YAML block scalar descriptions without rewriting source skills', () => {
    const parsed = parseFrontmatter(`---\nname: legal-research\ndescription: |\n  第一行法律研究说明。\n  第二行继续说明触发条件。\n---\n\n# Legal Research\n`);

    expect(parsed.fm.description).toBe('第一行法律研究说明。\n第二行继续说明触发条件。\n');
  });

  it('exposes the documented authoring and non-mutating verification commands', () => {
    const root = commandTree({ im: {} });
    const skill = root.commands.find((command) => command.name() === 'skill')!;
    const role = root.commands.find((command) => command.name() === 'role')!;

    expect(skill.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['create', 'mine', 'show']));
    expect(role.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['create', 'test', 'edit', 'show']),
    );
  });

  it('creates a skill through cloud CLI and reports the canonical server slug', async () => {
    const rootDir = tempDir();
    const bundle = join(rootDir, 'legal-research');
    mkdirSync(bundle);
    writeFileSync(
      join(bundle, 'SKILL.md'),
      `---\nname: legal-research\ndescription: |\n  用于法律研究和法条检索，在用户要求核验法律依据、检索规范或分析法律问题时触发。\n---\n\n# Legal Research\n\nFollow the source.\n`,
    );
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/im/skills');
      expect(body).toMatchObject({ name: 'legal-research' });
      return { ok: true, data: { id: 'skill_1', slug: 'community-legal-research' } };
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = commandTree({ im: { request } });

    await root.parseAsync(['node', 'cloud', 'skill', 'create', bundle, '--json']);

    expect(output.mock.calls.flat().join('')).toContain('community-legal-research');
  });

  it('tests every required skill without applying or mutating an agent profile', async () => {
    const rootDir = tempDir();
    const roleDir = join(rootDir, 'legal-expert');
    mkdirSync(roleDir);
    writeFileSync(
      join(roleDir, 'role.json'),
      JSON.stringify({
        slug: 'legal-expert',
        agentType: 'specialist',
        requiredSkills: [{ skillSlug: 'community-legal-research', required: true }],
      }),
    );
    writeFileSync(join(roleDir, 'SOUL.md'), '# Legal Expert\n\nReview legal work carefully.\n');
    const request = vi.fn(async (method: string, path: string) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/im/skills/community-legal-research');
      return { ok: true, data: { slug: 'community-legal-research' } };
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const root = commandTree({ im: { request } });

    await root.parseAsync(['node', 'cloud', 'role', 'test', roleDir, '--json']);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([method]) => method !== 'GET')).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HermesSkillLoader } from '../src/adapters/persistence/hermes/skill-loader.js';

const roots: string[] = [];

function makeLoader(): HermesSkillLoader {
  const root = mkdtempSync(join(tmpdir(), 'prismer-hermes-slash-'));
  roots.push(root);
  mkdirSync(join(root, 'research-notes'), { recursive: true });
  writeFileSync(
    join(root, 'research-notes', 'SKILL.md'),
    [
      '---',
      'name: research-notes',
      'description: Build cited research notes from supplied sources.',
      'scope: persistence',
      '---',
      '',
      '# Research Notes',
      '',
      'Always preserve citations.',
    ].join('\n'),
    'utf8',
  );
  return new HermesSkillLoader(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hermes skill slash catalog', () => {
  it('lets profile dotenv override an empty inherited credential', async () => {
    const previous = process.env.CURATION_TEST_PRIVATE_TOKEN;
    process.env.CURATION_TEST_PRIVATE_TOKEN = '';
    try {
      const root = makeLoader().getSkillsRoot();
      writeFileSync(join(root, 'research-notes/SKILL.md'), '---\nname: research-notes\nprerequisites:\n  env_vars: [CURATION_TEST_PRIVATE_TOKEN]\n---\nBody');
      writeFileSync(join(root, '.env'), 'export CURATION_TEST_PRIVATE_TOKEN="fixture"\n');
      expect((await new HermesSkillLoader(root, join(root, 'config.yaml')).listCommands()).map((entry) => entry.name)).toEqual(['research-notes']);
    } finally {
      if (previous === undefined) delete process.env.CURATION_TEST_PRIVATE_TOKEN;
      else process.env.CURATION_TEST_PRIVATE_TOKEN = previous;
    }
  });
  it('checks profile-injected credentials without requiring them in the parent daemon', async () => {
    const root = makeLoader().getSkillsRoot();
    writeFileSync(join(root, 'research-notes', 'SKILL.md'), '---\nname: research-notes\ndescription: Research\nprerequisites:\n  env_vars: [CURATION_TEST_PRIVATE_TOKEN]\n---\nBody');
    const config = join(root, 'profile.yaml');
    const loader = new HermesSkillLoader(root, config);
    expect(await loader.listCommands()).toEqual([]);
    writeFileSync(join(root, '.env'), 'CURATION_TEST_PRIVATE_TOKEN=test-only-value\n');
    expect((await loader.listCommands()).map((entry) => entry.name)).toEqual(['research-notes']);
  });
  it('reads explicit profile config even when skills live in the per-agent directory', async () => {
    const loader = makeLoader();
    const root = loader.getSkillsRoot();
    const config = join(root, 'separate-config.yaml');
    writeFileSync(config, 'skills:\n  disabled: [research-notes]\n');
    const actual = new HermesSkillLoader(root, config);
    expect(await actual.listCommands()).toEqual([]);
    expect(await actual.expandSlashInvocation('/research-notes test')).toBeNull();
  });
  it('exposes installed SKILL.md entries as skill commands', async () => {
    const commands = await makeLoader().listCommands();
    expect(commands).toEqual([
      {
        name: 'research-notes',
        description: 'Build cited research notes from supplied sources.',
        argumentHint: '[instruction]',
        kind: 'skill',
      },
    ]);
  });

  it('expands an exact slash invocation into deterministic skill instructions', async () => {
    const expanded = await makeLoader().expandSlashInvocation('/research_notes compare A and B');
    expect(expanded).toContain('The user invoked the "research-notes" skill');
    expect(expanded).toContain('Always preserve citations.');
    expect(expanded).toContain('User instruction: compare A and B');
  });

  it('does not capture unknown commands or slash-like prose', async () => {
    const loader = makeLoader();
    await expect(loader.expandSlashInvocation('/unknown do work')).resolves.toBeNull();
    await expect(loader.expandSlashInvocation('/research-notes/child')).resolves.toBeNull();
  });
});

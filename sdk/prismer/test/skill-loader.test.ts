import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSystemSkillLoader, renderSkillsSystemPrompt } from '../src/daemon/skill-loader.js';
import type { AgentProfile } from '../src/adapters/contract.js';

describe('FileSystemSkillLoader', () => {
  it('loads SKILL.md files from a skills root for dispatch injection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prismer-skill-loader-'));
    try {
      mkdirSync(join(root, 'alpha'), { recursive: true });
      mkdirSync(join(root, 'beta'), { recursive: true });
      writeFileSync(join(root, 'alpha', 'SKILL.md'), '# Alpha\n\nUse alpha.', 'utf8');
      writeFileSync(join(root, 'beta', 'SKILL.md'), '# Beta\n\nUse beta.', 'utf8');

      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch();
      const prompt = renderSkillsSystemPrompt(skills);

      expect(loader.getSkillsRoot()).toBe(root);
      expect(skills.map((skill) => skill.slug)).toEqual(['alpha', 'beta']);
      expect(prompt).toContain('[Installed Skills]');
      expect(prompt).toContain('# Alpha');
      expect(prompt).toContain('# Beta');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// doc release203/09 §7.6.3 — category-aware skill filtering.
describe('FileSystemSkillLoader category filtering', () => {
  const stubProfile = (adapterName: string): AgentProfile =>
    ({ adapterName }) as unknown as AgentProfile;

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'prismer-skill-scope-'));
    const write = (slug: string, fm: string) => {
      mkdirSync(join(root, slug), { recursive: true });
      writeFileSync(join(root, slug, 'SKILL.md'), fm, 'utf8');
    };
    write('c-skill', '---\nname: c-skill\nscope: common\n---\n\n# Common');
    write('p-skill', '---\nname: p-skill\nscope: persistence\n---\n\n# Persistence');
    write('x-skill', '---\nname: x-skill\nscope: coding\n---\n\n# Coding');
    // No scope field → default 'common'.
    write('n-skill', '---\nname: n-skill\ndescription: "no scope here"\n---\n\n# NoScope');
    return root;
  }

  it('persistence adapter loads common + persistence + no-scope (default common), excludes coding', async () => {
    const root = makeRoot();
    try {
      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch(stubProfile('hermes'));
      expect(skills.map((s) => s.slug)).toEqual(['c-skill', 'n-skill', 'p-skill']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('coding adapter loads common + coding + no-scope, excludes persistence', async () => {
    const root = makeRoot();
    try {
      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch(stubProfile('claude-code'));
      expect(skills.map((s) => s.slug)).toEqual(['c-skill', 'n-skill', 'x-skill']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runtime-engine adapter (pi-core) loads common + runtime-engine only — coding/persistence scopes excluded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prismer-skill-re-'));
    try {
      const write = (slug: string, fm: string) => {
        mkdirSync(join(root, slug), { recursive: true });
        writeFileSync(join(root, slug, 'SKILL.md'), fm, 'utf8');
      };
      write('c-skill', '---\nname: c-skill\nscope: common\n---\n\n# Common');
      write('p-skill', '---\nname: p-skill\nscope: persistence\n---\n\n# Persistence');
      write('x-skill', '---\nname: x-skill\nscope: coding\n---\n\n# Coding');
      write('r-skill', '---\nname: r-skill\nscope: runtime-engine\n---\n\n# RuntimeEngine');
      write('n-skill', '---\nname: n-skill\ndescription: "no scope"\n---\n\n# NoScope');
      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch(stubProfile('pi-core'));
      expect(skills.map((s) => s.slug)).toEqual(['c-skill', 'n-skill', 'r-skill']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unknown adapter returns all skills (no filtering)', async () => {
    const root = makeRoot();
    try {
      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch(stubProfile('mystery-adapter'));
      expect(skills.map((s) => s.slug)).toEqual(['c-skill', 'n-skill', 'p-skill', 'x-skill']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('undefined profile returns all skills (no filtering)', async () => {
    const root = makeRoot();
    try {
      const loader = new FileSystemSkillLoader(root);
      const skills = await loader.loadForDispatch(undefined);
      expect(skills.map((s) => s.slug)).toEqual(['c-skill', 'n-skill', 'p-skill', 'x-skill']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

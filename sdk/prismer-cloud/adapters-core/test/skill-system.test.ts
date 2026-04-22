import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSkillMarkdown } from '../src/skill-system/frontmatter.js';
import { discoverSkills, findSkill, loadSkillBody } from '../src/skill-system/loader.js';
import { ProgressiveSkillLoader } from '../src/skill-system/progressive.js';
import { parseSkillRef, resolveSkillRef } from '../src/skill-system/registry.js';

describe('parseSkillMarkdown', () => {
  it('parses a minimal skill with scalars', () => {
    const src = `---
name: deploy-prod
description: Deploy to production
version: 1.2.0
---

# Body
Content here.`;
    const { frontmatter, body } = parseSkillMarkdown(src);
    expect(frontmatter['name']).toBe('deploy-prod');
    expect(frontmatter['description']).toBe('Deploy to production');
    expect(frontmatter['version']).toBe('1.2.0');
    expect(body.trim()).toBe('# Body\nContent here.');
  });

  it('parses flow arrays', () => {
    const src = `---
name: x
allowed-tools: [Bash, Edit, "Read(src/**)"]
---
body`;
    const { frontmatter } = parseSkillMarkdown(src);
    expect(frontmatter['allowed-tools']).toEqual(['Bash', 'Edit', 'Read(src/**)']);
  });

  it('parses nested maps', () => {
    const src = `---
name: x
requires:
  os: [macos, linux]
  bins: [git]
metadata:
  prismer:
    skill_family: deployment
---
body`;
    const { frontmatter } = parseSkillMarkdown(src);
    const requires = frontmatter['requires'] as Record<string, unknown>;
    expect(requires['os']).toEqual(['macos', 'linux']);
    const meta = frontmatter['metadata'] as Record<string, unknown>;
    const prismer = meta['prismer'] as Record<string, unknown>;
    expect(prismer['skill_family']).toBe('deployment');
  });

  it('parses booleans, numbers, and null', () => {
    const src = `---
name: x
disable-model-invocation: false
priority: 7
unset: null
---
body`;
    const { frontmatter } = parseSkillMarkdown(src);
    expect(frontmatter['disable-model-invocation']).toBe(false);
    expect(frontmatter['priority']).toBe(7);
    expect(frontmatter['unset']).toBeNull();
  });

  it('strips comments outside strings', () => {
    const src = `---
name: x  # inline comment
# full-line comment
description: "hashes # inside strings stay"
---
body`;
    const { frontmatter } = parseSkillMarkdown(src);
    expect(frontmatter['name']).toBe('x');
    expect(frontmatter['description']).toBe('hashes # inside strings stay');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseSkillMarkdown('no frontmatter here')).toThrow();
  });
});

describe('Skill loader — 6-level priority', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string, description: string): void {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
      'utf-8',
    );
  }

  it('discovers skills from the workspace root', () => {
    writeSkill(path.join(tmpDir, 'skills'), 'deploy', 'workspace deploy');
    const skills = discoverSkills({ workspace: tmpDir, home: tmpDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy');
    expect(skills[0].source.kind).toBe('workspace');
  });

  it('workspace source beats project source on name conflict', () => {
    writeSkill(path.join(tmpDir, 'skills'), 'deploy', 'workspace version');
    writeSkill(path.join(tmpDir, '.prismer', 'skills'), 'deploy', 'project version');
    const skills = discoverSkills({ workspace: tmpDir, home: tmpDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].frontmatter['description']).toBe('workspace version');
  });

  it('plugin skills are namespaced', () => {
    const pluginRoot = path.join(tmpDir, 'plugin-a');
    writeSkill(path.join(pluginRoot, 'skills'), 'deploy', 'plugin deploy');
    writeSkill(path.join(tmpDir, 'skills'), 'deploy', 'workspace deploy');

    const skills = discoverSkills({
      workspace: tmpDir,
      home: tmpDir,
      pluginRoots: [pluginRoot],
    });
    const names = skills.map((s) => s.qualifiedName).sort();
    expect(names).toEqual(['deploy', 'plugin-a:deploy']);
  });

  it('findSkill resolves by qualified name', () => {
    writeSkill(path.join(tmpDir, 'skills'), 'deploy', 'workspace deploy');
    const found = findSkill('deploy', { workspace: tmpDir, home: tmpDir });
    expect(found).not.toBeNull();
    expect(found!.name).toBe('deploy');
  });

  it('loadSkillBody returns the body', () => {
    writeSkill(path.join(tmpDir, 'skills'), 'deploy', 'd');
    const skill = findSkill('deploy', { workspace: tmpDir, home: tmpDir });
    expect(loadSkillBody(skill!).trim()).toBe('body');
  });
});

describe('ProgressiveSkillLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-prog-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSkill(name: string, bodySize: number): import('../src/skill-system/loader.js').SkillDescriptor {
    const dir = path.join(tmpDir, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const body = 'x'.repeat(bodySize);
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`,
      'utf-8',
    );
    return {
      name,
      qualifiedName: name,
      source: { kind: 'workspace', root: path.join(tmpDir, 'skills') },
      filePath: path.join(dir, 'SKILL.md'),
      frontmatter: { name, description: `${name} desc` },
    };
  }

  it('loads body on activate and bumps LRU on re-activate', () => {
    const loader = new ProgressiveSkillLoader({ budgetTokens: 100 });
    const skill = makeSkill('s1', 40);
    const first = loader.activate(skill);
    expect(first.bodyTokens).toBeGreaterThan(0);
    const second = loader.activate(skill);
    expect(second).toBe(first);
  });

  it('evicts LRU when budget exceeded', () => {
    const loader = new ProgressiveSkillLoader({ budgetTokens: 25 });
    // 100 chars ≈ 25 tokens each
    const a = makeSkill('a', 100);
    const b = makeSkill('b', 100);
    loader.activate(a);
    loader.activate(b);
    // a should have been evicted to fit budget
    const active = loader.active();
    expect(active.map((s) => s.descriptor.name)).toEqual(['b']);
  });

  it('metadata works without loading body', () => {
    const loader = new ProgressiveSkillLoader();
    const skill = makeSkill('a', 10);
    const meta = loader.metadata(skill);
    expect(meta.description).toBe('a desc');
    expect(loader.active()).toHaveLength(0);
  });
});

describe('Skill registry ref parsing', () => {
  it('parses prismer refs', () => {
    expect(parseSkillRef('prismer:deploy-prod')).toEqual({ kind: 'prismer', body: 'deploy-prod' });
  });

  it('parses github refs', () => {
    expect(parseSkillRef('github:anthropics/skills')).toEqual({
      kind: 'github',
      body: 'anthropics/skills',
    });
  });

  it('parses well-known refs', () => {
    expect(parseSkillRef('well-known:https://x.com/.well-known/skills/m')).toEqual({
      kind: 'well-known',
      body: 'https://x.com/.well-known/skills/m',
    });
  });

  it('rejects unknown prefixes', () => {
    expect(() => parseSkillRef('unknown:foo')).toThrow();
    expect(() => parseSkillRef('no-prefix')).toThrow();
  });

  it('resolves github ref without network', async () => {
    const resolved = await resolveSkillRef('github:owner/repo@main');
    expect(resolved.registry).toBe('github');
    expect(resolved.tarballUrl).toContain('codeload.github.com');
    expect(resolved.tarballUrl).toContain('main');
  });
});

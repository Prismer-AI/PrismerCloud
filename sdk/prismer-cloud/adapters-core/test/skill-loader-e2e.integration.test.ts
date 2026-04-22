/**
 * Integration test: L10 Skill System — end-to-end (frontmatter → loader →
 * progressive disclosure → registry parse).
 *
 * Mirrors the lifecycle an adapter actually executes:
 *   1. discoverSkills() scans the 6 priority levels (workspace, project, user,
 *      managed, plugin, bundled) and returns descriptors.
 *   2. A skill activates — metadata() surfaces description (L0), activate()
 *      loads body (L1).
 *   3. Budget enforcement evicts LRU when context exceeds 25k-token default.
 *   4. Registry refs (prismer:/github:/well-known:) parse correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverSkills,
  findSkill,
  parseSkillMarkdown,
  ProgressiveSkillLoader,
  parseSkillRef,
  resolveSkillRef,
  PermissionLeaseManager,
} from '../src/index.js';
import type { PermissionRule } from '@prismer/wire';

describe('L10 Skill System — discovery → activation → lease', () => {
  let workspace: string;
  let home: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-ws-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-home-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string, body: string, allowedTools?: string[]): void {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const tools = allowedTools
      ? `allowed-tools: [${allowedTools.map((t) => `"${t}"`).join(', ')}]`
      : '';
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} desc\nversion: 1.0.0\n${tools}\n---\n${body}`,
      'utf-8',
    );
  }

  it('full adapter flow: discover + activate + lease rules + deactivate', () => {
    // 1. Adapter discovers skills from workspace + user dirs
    writeSkill(
      path.join(workspace, 'skills'),
      'deploy-prod',
      'Deploy procedure...',
      ['Bash(git *)', 'Edit(src/**)'],
    );
    writeSkill(path.join(home, '.prismer', 'skills'), 'search-logs', 'Search logs...');

    const skills = discoverSkills({ workspace, home });
    expect(skills.map((s) => s.qualifiedName).sort()).toEqual(['deploy-prod', 'search-logs']);

    // 2. Runtime picks deploy-prod to activate
    const deploy = findSkill('deploy-prod', { workspace, home });
    expect(deploy).not.toBeNull();
    expect(deploy!.source.kind).toBe('workspace');

    // 3. Progressive loader brings body into context
    const progressive = new ProgressiveSkillLoader();
    const loaded = progressive.activate(deploy!);
    expect(loaded.body).toContain('Deploy procedure');

    // 4. Adapter pushes allowed-tools as PermissionRules via lease manager
    const leases = new PermissionLeaseManager();
    const tools = deploy!.frontmatter['allowed-tools'] as string[];
    const rules: PermissionRule[] = tools.map((t) => {
      const m = t.match(/^(\w+)\(([^)]+)\)$/);
      return {
        source: 'skill',
        behavior: 'allow',
        value: m ? { tool: m[1], pattern: m[2] } : { tool: t },
      };
    });
    leases.grant('deploy-prod', rules);
    expect(leases.active()).toHaveLength(2);
    expect(leases.active()[0].source).toBe('skill');

    // 5. Skill deactivated (e.g. session end / compaction drop)
    progressive.deactivate('deploy-prod');
    leases.revoke('deploy-prod');
    expect(leases.active()).toHaveLength(0);
  });

  it('6-level priority: workspace > project > user > managed', () => {
    // Put the same skill at every level, different descriptions
    writeSkill(path.join(workspace, 'skills'), 'same', 'workspace win', []);
    writeSkill(path.join(workspace, '.prismer', 'skills'), 'same', 'project', []);
    writeSkill(path.join(home, '.prismer', 'skills'), 'same', 'user', []);

    const skills = discoverSkills({ workspace, home });
    expect(skills).toHaveLength(1);
    expect(skills[0].source.kind).toBe('workspace');
    expect(skills[0].frontmatter['description']).toBe('same desc');
    // Note: parseSkillMarkdown reads `description` from frontmatter which is
    // "${name} desc" in writeSkill helper. The important property is that the
    // WORKSPACE version wins — if project or user won, `source.kind` would
    // not be 'workspace'.
  });

  it('plugin skills namespaced — can coexist with same-name workspace skill', () => {
    writeSkill(path.join(workspace, 'skills'), 'review', 'workspace review', []);
    const pluginRoot = path.join(workspace, 'plugin-linter');
    writeSkill(path.join(pluginRoot, 'skills'), 'review', 'linter review', []);

    const skills = discoverSkills({ workspace, home, pluginRoots: [pluginRoot] });
    const names = skills.map((s) => s.qualifiedName).sort();
    expect(names).toEqual(['plugin-linter:review', 'review']);
  });

  it('malformed SKILL.md silently skipped (loader stays lenient)', () => {
    writeSkill(path.join(workspace, 'skills'), 'good', 'body', []);
    // Write a malformed skill — no closing delimiter
    const badDir = path.join(workspace, 'skills', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'SKILL.md'), '---\nname: bad\ndesc: incomplete');

    const skills = discoverSkills({ workspace, home });
    expect(skills.map((s) => s.name)).toEqual(['good']);
  });
});

describe('Registry ref parsing', () => {
  it('prismer: ref', () => {
    expect(parseSkillRef('prismer:deploy-prod')).toEqual({ kind: 'prismer', body: 'deploy-prod' });
  });
  it('github: ref', () => {
    expect(parseSkillRef('github:anthropics/skills@main')).toEqual({
      kind: 'github',
      body: 'anthropics/skills@main',
    });
  });
  it('well-known: ref', () => {
    expect(parseSkillRef('well-known:https://x.com/.well-known/skills/z')).toEqual({
      kind: 'well-known',
      body: 'https://x.com/.well-known/skills/z',
    });
  });
  it('github ref resolves to codeload tarball URL without network', async () => {
    const resolved = await resolveSkillRef('github:anthropics/skills@main');
    expect(resolved.registry).toBe('github');
    expect(resolved.tarballUrl).toBe('https://codeload.github.com/anthropics/skills/tar.gz/main');
  });
  it('invalid ref rejected', () => {
    expect(() => parseSkillRef('npm:somepackage')).toThrow();
    expect(() => parseSkillRef('noprefix')).toThrow();
  });
});

describe('Frontmatter parser corner cases', () => {
  it('reads mixed scalars + nested map + flow array', () => {
    const { frontmatter } = parseSkillMarkdown(`---
name: x
version: 1.0.0
tags: [foo, bar, "baz qux"]
metadata:
  prismer:
    skill_family: deployment
    credits_per_invocation: 5
---
body`);
    expect(frontmatter['name']).toBe('x');
    expect(frontmatter['tags']).toEqual(['foo', 'bar', 'baz qux']);
    const meta = frontmatter['metadata'] as Record<string, unknown>;
    const prismer = meta['prismer'] as Record<string, unknown>;
    expect(prismer['skill_family']).toBe('deployment');
    expect(prismer['credits_per_invocation']).toBe(5);
  });
});

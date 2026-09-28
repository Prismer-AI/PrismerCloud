import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installHermesBundledSkill,
  projectHermesSkillRoot,
} from '../src/adapters/persistence/hermes/native-skill-projection.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-projection-'));
  roots.push(root);
  const source = join(root, 'source'),
    target = join(root, 'profile/skills');
  mkdirSync(join(source, 'memory/references'), { recursive: true });
  writeFileSync(join(source, 'memory/SKILL.md'), '---\nname: memory\n---\nBody');
  writeFileSync(join(source, 'memory/references/full.md'), 'resource');
  writeFileSync(join(source, 'memory/LICENSE'), 'license');
  return { root, source, target };
}
describe('Hermes native managed delivery', () => {
  it('bootstraps the full directory and replaces its managed copy with one pinned projection', () => {
    const { source, target } = fixture();
    installHermesBundledSkill(join(source, 'memory'), join(target, 'memory'));
    expect(readFileSync(join(target, 'memory/references/full.md'), 'utf8')).toBe('resource');
    projectHermesSkillRoot(source, target);
    expect(lstatSync(join(target, 'memory')).isSymbolicLink()).toBe(true);
    installHermesBundledSkill(join(source, 'memory'), join(target, 'memory'));
    expect(readFileSync(join(target, 'memory/LICENSE'), 'utf8')).toBe('license');
    projectHermesSkillRoot(source, target);
  });
  it('preserves user directories and rejects different content without overwriting', () => {
    const { source, target } = fixture();
    mkdirSync(join(target, 'memory'), { recursive: true });
    writeFileSync(join(target, 'memory/SKILL.md'), 'user content');
    expect(() => projectHermesSkillRoot(source, target)).toThrow(/unmanaged/);
    expect(readFileSync(join(target, 'memory/SKILL.md'), 'utf8')).toBe('user content');
  });
  it('preserves edits inside a previously managed bootstrap', () => {
    const { source, target } = fixture();
    installHermesBundledSkill(join(source, 'memory'), join(target, 'memory'));
    writeFileSync(join(target, 'memory/references/full.md'), 'user edit');
    expect(() => projectHermesSkillRoot(source, target)).toThrow(/User-modified/);
    expect(readFileSync(join(target, 'memory/references/full.md'), 'utf8')).toBe('user edit');
  });
  it('prunes only its own links when grants disappear', () => {
    const { source, target } = fixture();
    projectHermesSkillRoot(source, target);
    mkdirSync(join(target, 'user'), { recursive: true });
    rmSync(join(source, 'memory'), { recursive: true });
    projectHermesSkillRoot(source, target);
    expect(existsSync(join(target, 'memory'))).toBe(false);
    expect(existsSync(join(target, 'user'))).toBe(true);
  });
  it('repairs legacy entrypoint-only bootstrap without overwriting user resources', () => {
    const { source, target } = fixture();
    mkdirSync(join(target, 'memory'), { recursive: true });
    writeFileSync(join(target, 'memory/SKILL.md'), readFileSync(join(source, 'memory/SKILL.md')));
    writeFileSync(join(target, 'memory/user.txt'), 'keep');
    installHermesBundledSkill(join(source, 'memory'), join(target, 'memory'));
    expect(readFileSync(join(target, 'memory/references/full.md'), 'utf8')).toBe('resource');
    expect(readFileSync(join(target, 'memory/user.txt'), 'utf8')).toBe('keep');
  });
});

// release203/16 P1+P2 — bundle lib: validate / manifest / package / role-validate
// + the skill-test acceptance matcher (P2 pure logic). No network.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import {
  buildSkillCreateBody,
  computeBundleManifest,
  matchAcceptanceCriteria,
  matchCriterion,
  packageBundle,
  readBundle,
  readRoleBundle,
  validateBundle,
  validateRole,
  validateRoleBundle,
  BundleError,
} from '../src/bundle/index.js';

// Cross-side parity target: cloud manifest merkle MUST equal ours.
import { computeManifestRevision, sha256Hex } from '../../../src/im/skills/manifest.js';

let root: string;

function makeBundle(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const VALID_SKILL_MD = `---
name: hello-skill
description: A friendly greeting skill that welcomes users and says hello politely and clearly
category: demo
---
# Hello
Body text here.
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bundle-test-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validateBundle — pass', () => {
  it('accepts a well-formed single-file bundle', () => {
    const dir = makeBundle('ok', { 'SKILL.md': VALID_SKILL_MD });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('accepts a multi-file bundle', () => {
    const dir = makeBundle('ok-multi', {
      'SKILL.md': VALID_SKILL_MD,
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
      'references/notes.md': '# notes\n',
    });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(true);
  });
});

describe('validateBundle — each failure mode', () => {
  it('fails when SKILL.md is missing', () => {
    const dir = makeBundle('no-skillmd', { 'scripts/x.sh': 'x' });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/SKILL\.md not found/);
  });

  it('fails when frontmatter.name is missing', () => {
    const dir = makeBundle('no-name', { 'SKILL.md': '---\ndescription: x\n---\nbody' });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/name is required/);
  });

  it('fails when frontmatter.name is invalid (uppercase)', () => {
    const dir = makeBundle('bad-name', { 'SKILL.md': '---\nname: BadName\ndescription: x\n---\nb' });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/name invalid/);
  });

  it('fails when description is missing', () => {
    const dir = makeBundle('no-desc', { 'SKILL.md': '---\nname: ok-name\n---\nbody' });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/description is required/);
  });

  it('warns (not fails) when category absent', () => {
    const dir = makeBundle('no-cat', {
      'SKILL.md':
        '---\nname: ok-name\ndescription: A sufficiently long description that clears the fifty-character floor\n---\nb',
    });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/category absent/);
  });

  // product204/30 A4 — 50 quality-unit floor; non-ASCII code points count as
  // two so concise CJK trigger descriptions are not forced to add filler.
  it('fails when description carries fewer than 50 quality units', () => {
    const dir = makeBundle('short-desc', {
      'SKILL.md': '---\nname: ok-name\ndescription: too short\ncategory: demo\n---\nbody',
    });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/description must carry ≥ 50 quality units/);
  });

  it('accepts a concise CJK block-scalar description without rewriting the source bundle', () => {
    const dir = makeBundle('cjk-desc', {
      'SKILL.md':
        '---\nname: cjk-desc\ndescription: |\n  从许可资质、监管法规遵循及历史处罚记录四个维度评估企业处罚风险。\ncategory: legal\n---\nbody',
    });
    const bundle = readBundle(dir);
    const v = validateBundle(bundle);
    expect(v.ok).toBe(true);
    expect(bundle.frontmatter.description).toBe(
      '从许可资质、监管法规遵循及历史处罚记录四个维度评估企业处罚风险。\n',
    );
  });

  it('fails when description is longer than 1024 chars', () => {
    const dir = makeBundle('long-desc', {
      'SKILL.md': `---\nname: ok-name\ndescription: ${'x'.repeat(1025)}\ncategory: demo\n---\nbody`,
    });
    const v = validateBundle(readBundle(dir));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/description must be ≤ 1024 characters/);
  });
});

describe('readBundle — errors throw BundleError', () => {
  it('throws on a missing directory', () => {
    expect(() => readBundle(join(root, 'does-not-exist'))).toThrowError(/not found/);
  });
});

describe('computeBundleManifest — merkle byte-identical to cloud', () => {
  it('single-file merkle matches cloud computeManifestRevision', () => {
    const dir = makeBundle('merkle-1', { 'SKILL.md': VALID_SKILL_MD });
    const bundle = readBundle(dir);
    const ours = computeBundleManifest(bundle.files);
    const cloud = computeManifestRevision(ours.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
    expect(ours.revision).toBe(cloud);
    // And matches the single-file SQL shape directly.
    expect(ours.revision).toBe(sha256Hex(`SKILL.md:${sha256Hex(VALID_SKILL_MD)}`));
  });

  it('multi-file merkle matches cloud (order-independent)', () => {
    const dir = makeBundle('merkle-2', {
      'SKILL.md': VALID_SKILL_MD,
      'scripts/z.sh': 'z',
      'scripts/a.sh': 'a',
    });
    const bundle = readBundle(dir);
    const ours = computeBundleManifest(bundle.files);
    const cloud = computeManifestRevision(ours.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
    expect(ours.revision).toBe(cloud);
  });

  it('is reproducible across two reads of the same dir', () => {
    const dir = makeBundle('repro', { 'SKILL.md': VALID_SKILL_MD, 'scripts/x.sh': 'x' });
    const a = computeBundleManifest(readBundle(dir).files);
    const b = computeBundleManifest(readBundle(dir).files);
    expect(a.revision).toBe(b.revision);
  });
});

describe('buildSkillCreateBody — parity with legacy shape', () => {
  it('single-file omits contentManifest', () => {
    const dir = makeBundle('cb-single', { 'SKILL.md': VALID_SKILL_MD });
    const out = buildSkillCreateBody(readBundle(dir));
    expect(out.slug).toBe('hello-skill');
    expect(out.fileCount).toBe(1);
    expect(out.createBody.contentManifest).toBeUndefined();
    expect(out.createBody.content).toContain('# Hello');
  });

  it('multi-file includes contentManifest + revision', () => {
    const dir = makeBundle('cb-multi', { 'SKILL.md': VALID_SKILL_MD, 'scripts/x.sh': 'x' });
    const out = buildSkillCreateBody(readBundle(dir));
    expect(out.fileCount).toBe(2);
    expect(out.createBody.contentManifest).toBeDefined();
    expect(out.createBody.contentManifestRevision).toBe(out.revision);
  });
});

describe('packageBundle — tarball + reproducible merkle', () => {
  it('produces a non-empty gzip whose merkle matches the manifest', () => {
    const dir = makeBundle('pkg', { 'SKILL.md': VALID_SKILL_MD, 'scripts/x.sh': 'echo hi\n' });
    const bundle = readBundle(dir);
    const pkg = packageBundle(bundle);
    expect(pkg.bytes.byteLength).toBeGreaterThan(0);
    expect(pkg.fileCount).toBe(2);
    // gzip magic bytes
    expect(pkg.bytes[0]).toBe(0x1f);
    expect(pkg.bytes[1]).toBe(0x8b);
    // merkle equals the standalone manifest
    expect(pkg.revision).toBe(computeBundleManifest(bundle.files).revision);
  });

  it('is byte-deterministic across two packagings (same tar payload)', () => {
    const dir = makeBundle('pkg-det', { 'SKILL.md': VALID_SKILL_MD, 'scripts/x.sh': 'echo hi\n' });
    const bundle = readBundle(dir);
    const a = gunzipSync(packageBundle(bundle).bytes);
    const b = gunzipSync(packageBundle(bundle).bytes);
    expect(a.equals(b)).toBe(true);
  });

  it('tar contains both file paths in USTAR headers', () => {
    const dir = makeBundle('pkg-paths', { 'SKILL.md': VALID_SKILL_MD, 'scripts/x.sh': 'echo hi\n' });
    const tar = gunzipSync(packageBundle(readBundle(dir)).bytes).toString('binary');
    expect(tar).toContain('SKILL.md');
    expect(tar).toContain('scripts/x.sh');
  });
});

describe('validateRole', () => {
  it('passes a well-formed role', () => {
    const v = validateRole({
      slug: 'data-analyst',
      requiredSkills: [{ skillSlug: 'pandas', required: true }],
      operatingPrinciples: '# Persona\nBe rigorous.',
    });
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
  });

  it('fails when slug is missing', () => {
    const v = validateRole({});
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/slug is required/);
  });

  it('fails when slug is invalid (uppercase/space)', () => {
    const v = validateRole({ slug: 'Data Analyst' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/slug invalid/);
  });

  it('fails when requiredSkills is not an array', () => {
    const v = validateRole({ slug: 'x', requiredSkills: { skillSlug: 'a' } });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/requiredSkills must be an array/);
  });

  it('fails when a requiredSkills entry lacks skillSlug', () => {
    const v = validateRole({ slug: 'x', requiredSkills: [{ required: true }] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/skillSlug must be a non-empty string/);
  });

  it('warns when operatingPrinciples absent', () => {
    const v = validateRole({ slug: 'x' });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/operatingPrinciples absent/);
  });

  // Track2 (product204) — wrong-sample防呆: a role.json copied from the
  // PROFILE-CONFIG template (roles/ceo.json: fields nested under
  // configSchema.roleTemplate) instead of the SS-02 top-level exemplar
  // (catalog/ceo.json) gets a NAMED error, not a bare "slug is required".
  it('names the wrong-sample mistake (fields buried under configSchema.roleTemplate)', () => {
    const v = validateRole({
      templateName: 'ceo',
      configSchema: { roleTemplate: { slug: 'ceo', agentType: 'orchestrator' } },
    } as any);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/wrong sample/);
    expect(v.errors.join(' ')).toMatch(/catalog\/ceo\.json/);
    // negative control: a real top-level role (slug + agentType at root) does NOT
    // trip the wrong-sample branch.
    const ok = validateRole({ slug: 'ceo', agentType: 'orchestrator', operatingPrinciples: 'Lead.' } as any);
    expect(ok.ok).toBe(true);
  });
});

describe('readRoleBundle — file vs directory (P4, doc 16 §5.4)', () => {
  function makeRoleDir(name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
    return dir;
  }

  it('reads a single role.json (legacy, isDir=false)', () => {
    const f = join(root, 'solo-role.json');
    writeFileSync(f, JSON.stringify({ slug: 'solo', operatingPrinciples: { en: 'json persona' } }));
    const b = readRoleBundle(f);
    expect(b.isDir).toBe(false);
    expect(b.soulMd).toBeUndefined();
    expect(b.role.slug).toBe('solo');
    expect(b.role.operatingPrinciples).toEqual({ en: 'json persona' });
  });

  it('reads a dir bundle: SOUL.md markdown overrides operatingPrinciples', () => {
    const dir = makeRoleDir('role-bundle', {
      'role.json': JSON.stringify({ slug: 'growth', operatingPrinciples: { en: 'old' } }),
      'SOUL.md': '# Persona\nBe bold.',
    });
    const b = readRoleBundle(dir);
    expect(b.isDir).toBe(true);
    expect(b.soulMd).toBe('# Persona\nBe bold.');
    expect(b.role.operatingPrinciples).toBe('# Persona\nBe bold.');
  });

  it('dir bundle without SOUL.md keeps role.json operatingPrinciples', () => {
    const dir = makeRoleDir('role-nosoul', {
      'role.json': JSON.stringify({ slug: 'plain', operatingPrinciples: { en: 'kept' } }),
    });
    const b = readRoleBundle(dir);
    expect(b.isDir).toBe(true);
    expect(b.soulMd).toBeUndefined();
    expect(b.role.operatingPrinciples).toEqual({ en: 'kept' });
  });

  it('dir bundle with empty SOUL.md does not override', () => {
    const dir = makeRoleDir('role-emptysoul', {
      'role.json': JSON.stringify({ slug: 'e', operatingPrinciples: { en: 'kept' } }),
      'SOUL.md': '   \n  ',
    });
    const b = readRoleBundle(dir);
    expect(b.soulMd).toBeUndefined();
    expect(b.role.operatingPrinciples).toEqual({ en: 'kept' });
  });

  it('throws role_json_missing when dir lacks role.json', () => {
    const dir = makeRoleDir('role-noroll', { 'SOUL.md': 'persona' });
    expect(() => readRoleBundle(dir)).toThrowError(BundleError);
    try {
      readRoleBundle(dir);
    } catch (e) {
      expect((e as BundleError).code).toBe('role_json_missing');
    }
  });

  it('throws role_path_missing for a nonexistent path', () => {
    try {
      readRoleBundle(join(root, 'does-not-exist'));
    } catch (e) {
      expect((e as BundleError).code).toBe('role_path_missing');
    }
  });

  it('validateRoleBundle drops the operatingPrinciples-absent warning for a dir+SOUL', () => {
    const dir = makeRoleDir('role-valid', {
      'role.json': JSON.stringify({ slug: 'ok' }),
      'SOUL.md': '# Persona',
    });
    const b = readRoleBundle(dir);
    const v = validateRoleBundle(b);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).not.toMatch(/operatingPrinciples absent/);
  });
});

describe('matchCriterion — substring vs regex (P2 pure)', () => {
  const output = 'The total is 42 widgets, status: OK.';

  it('substring hit', () => {
    expect(matchCriterion({ match: '42 widgets' }, output).pass).toBe(true);
  });

  it('substring miss', () => {
    expect(matchCriterion({ match: 'error' }, output).pass).toBe(false);
  });

  it('substring is case-sensitive', () => {
    expect(matchCriterion({ match: 'ok.' }, output).pass).toBe(false);
    expect(matchCriterion({ match: 'OK.' }, output).pass).toBe(true);
  });

  it('regex hit (default flag i)', () => {
    expect(matchCriterion({ match: 'status:\\s*ok', type: 'regex' }, output).pass).toBe(true);
  });

  it('regex miss', () => {
    expect(matchCriterion({ match: '^\\d+$', type: 'regex' }, output).pass).toBe(false);
  });

  it('regex with explicit flags', () => {
    expect(matchCriterion({ match: 'TOTAL', type: 'regex', flags: 'i' }, output).pass).toBe(true);
    expect(matchCriterion({ match: 'TOTAL', type: 'regex', flags: '' }, output).pass).toBe(false);
  });

  it('invalid regex → pass false + error', () => {
    const r = matchCriterion({ match: '[unterminated', type: 'regex' }, output);
    expect(r.pass).toBe(false);
    expect(r.error).toMatch(/invalid regex/);
  });
});

describe('matchAcceptanceCriteria — required gates verdict', () => {
  const output = 'hello world';

  it('ok when all required pass', () => {
    const r = matchAcceptanceCriteria([{ match: 'hello' }, { match: 'world' }], output);
    expect(r.ok).toBe(true);
  });

  it('not ok when a required criterion misses', () => {
    const r = matchAcceptanceCriteria([{ match: 'hello' }, { match: 'missing' }], output);
    expect(r.ok).toBe(false);
  });

  it('ok when only an optional criterion misses', () => {
    const r = matchAcceptanceCriteria([{ match: 'hello' }, { match: 'missing', required: false }], output);
    expect(r.ok).toBe(true);
    expect(r.results[1]!.pass).toBe(false);
  });
});

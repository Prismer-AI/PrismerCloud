import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderPkfRuntimeCapabilityDirective,
  validatePkfRuntimeCapability,
} from '../src/daemon/pkf-runtime-capability.js';

const REQUIRED_TOOLS = ['pkf_mint_sids', 'pkf_validate', 'pkf_outline', 'pkf_search', 'pkf_read', 'pkf_bundle_commit'];
const REQUIRED_SKILLS = ['pkf-writing', 'pkf-svg'];

describe('host-verified PKF Runtime capability receipt', () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('startup reports the exact six native tools, two discovered skills, core and Cloud CLI as available', () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'prismer-pkf-cap-'));
    cleanup.push(skillsRoot);
    for (const slug of REQUIRED_SKILLS) {
      mkdirSync(join(skillsRoot, slug), { recursive: true });
      writeFileSync(join(skillsRoot, slug, 'SKILL.md'), `---\nname: ${slug}\n---\n`);
    }
    const report = validatePkfRuntimeCapability({
      trigger: 'startup',
      availableNativeTools: [...REQUIRED_TOOLS, 'memory_search'],
      skillsRoot,
      pkfCoreAvailable: true,
      cloudCliAvailable: true,
      catalogSkillSlugs: REQUIRED_SKILLS,
      installedSkillSlugs: REQUIRED_SKILLS,
      hermesNativeSkills: { status: 'listed', slugs: REQUIRED_SKILLS },
      promptFragment: ['[Installed Skills]', '## pkf-writing', '## pkf-svg'].join('\n\n'),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      trigger: 'startup',
      status: 'available',
      nativeTools: { required: REQUIRED_TOOLS, missing: [] },
      skills: { required: REQUIRED_SKILLS, missing: [] },
      pkfCore: 'available',
      cloudCli: 'available',
      doctor: {
        ok: true,
        state: 'ok',
        required: REQUIRED_SKILLS,
      },
    });
    expect(report.doctor?.checks.map((check) => [check.name, check.state])).toEqual([
      ['cloudCatalog', 'ok'],
      ['agentInstalledLedger', 'ok'],
      ['daemonSkillsRoot', 'ok'],
      ['hermesNativeRegistry', 'ok'],
      ['promptFragment', 'ok'],
    ]);
  });

  it('profile change fails closed and produces an explicit no-probe directive when any capability is missing', () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'prismer-pkf-cap-tamper-'));
    cleanup.push(skillsRoot);
    mkdirSync(join(skillsRoot, 'pkf-writing'), { recursive: true });
    writeFileSync(join(skillsRoot, 'pkf-writing', 'SKILL.md'), '---\nname: pkf-writing\n---\n');
    const report = validatePkfRuntimeCapability({
      trigger: 'profile-changed',
      profileId: 'profile-1',
      availableNativeTools: REQUIRED_TOOLS.filter((name) => name !== 'pkf_validate'),
      skillsRoot,
      pkfCoreAvailable: true,
      cloudCliAvailable: false,
      catalogSkillSlugs: REQUIRED_SKILLS,
      installedSkillSlugs: ['pkf-writing'],
      hermesNativeSkills: { status: 'listed', slugs: ['pkf-writing'] },
      promptFragment: ['[Installed Skills]', '## pkf-writing'].join('\n\n'),
    });
    const directive = renderPkfRuntimeCapabilityDirective(report);

    expect(report.status).toBe('unavailable');
    expect(report.nativeTools.missing).toEqual(['pkf_validate']);
    expect(report.skills.missing).toEqual(['pkf-svg']);
    expect(report.doctor?.ok).toBe(false);
    expect(report.doctor?.checks.find((check) => check.name === 'agentInstalledLedger')).toMatchObject({
      state: 'error',
      missing: ['pkf-svg'],
      remediation: expect.stringMatching(/install-builtins/),
    });
    expect(report.doctor?.checks.find((check) => check.name === 'hermesNativeRegistry')).toMatchObject({
      state: 'error',
      missing: ['pkf-svg'],
    });
    expect(report.doctor?.checks.find((check) => check.name === 'promptFragment')).toMatchObject({
      state: 'error',
      missing: ['pkf-svg'],
    });
    expect(directive).toContain('status: unavailable');
    expect(directive).toContain('doctor: error');
    expect(directive).toContain('agentInstalledLedger=error');
    expect(directive).toContain('promptFragment=error');
    expect(directive).toContain('pkf_validate');
    expect(directive).toContain('pkf-svg');
    expect(directive).toMatch(/do not run `command -v`|never run `command -v`/i);
    expect(directive).toMatch(/Python/i);
  });

  it('treats Hermes native registry probe gaps as warn unless a required slug is listed missing', () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'prismer-pkf-cap-native-'));
    cleanup.push(skillsRoot);
    for (const slug of REQUIRED_SKILLS) {
      mkdirSync(join(skillsRoot, slug), { recursive: true });
      writeFileSync(join(skillsRoot, slug, 'SKILL.md'), `---\nname: ${slug}\n---\n`);
    }

    const skipped = validatePkfRuntimeCapability({
      trigger: 'startup',
      availableNativeTools: REQUIRED_TOOLS,
      skillsRoot,
      pkfCoreAvailable: true,
      cloudCliAvailable: true,
      catalogSkillSlugs: REQUIRED_SKILLS,
      installedSkillSlugs: REQUIRED_SKILLS,
      hermesNativeSkills: { status: 'skipped', reason: 'skills_api_skipped' },
      promptFragment: ['[Installed Skills]', '## pkf-writing', '## pkf-svg'].join('\n\n'),
    });
    expect(skipped.doctor?.ok).toBe(true);
    expect(skipped.doctor?.state).toBe('warn');
    expect(skipped.doctor?.checks.find((check) => check.name === 'hermesNativeRegistry')).toMatchObject({
      state: 'warn',
      reason: 'skills_api_skipped',
    });

    const missing = validatePkfRuntimeCapability({
      trigger: 'startup',
      availableNativeTools: REQUIRED_TOOLS,
      skillsRoot,
      pkfCoreAvailable: true,
      cloudCliAvailable: true,
      catalogSkillSlugs: REQUIRED_SKILLS,
      installedSkillSlugs: REQUIRED_SKILLS,
      hermesNativeSkills: { status: 'listed', slugs: ['pkf-writing'] },
      promptFragment: ['[Installed Skills]', '## pkf-writing', '## pkf-svg'].join('\n\n'),
    });
    expect(missing.doctor?.ok).toBe(false);
    expect(missing.doctor?.checks.find((check) => check.name === 'hermesNativeRegistry')).toMatchObject({
      state: 'error',
      missing: ['pkf-svg'],
    });
  });
});

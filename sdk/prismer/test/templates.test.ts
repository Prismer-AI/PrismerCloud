import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_TEMPLATES, getRoleTemplate, listRoleTemplates } from '../src/templates/index.js';

describe('built-in role templates', () => {
  it('exposes 6 templates', () => {
    expect(BUILTIN_ROLE_TEMPLATES).toHaveLength(6);
    const names = BUILTIN_ROLE_TEMPLATES.map((t) => t.templateName);
    expect(names.sort()).toEqual([
      'engineer',
      'personal-assistant',
      'product-manager',
      'researcher',
      'skill-author',
      'team-manager',
    ]);
  });

  it('each template has the required shape', () => {
    for (const t of BUILTIN_ROLE_TEMPLATES) {
      expect(typeof t.templateName).toBe('string');
      expect(typeof t.displayName).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(Array.isArray(t.applicableAdapters)).toBe(true);
      expect(t.applicableAdapters.length).toBeGreaterThan(0);
      expect(typeof t.configSchema).toBe('object');
    }
  });

  it('all templates declare hermes / claude-code as applicable', () => {
    for (const t of BUILTIN_ROLE_TEMPLATES) {
      expect(t.applicableAdapters).toContain('hermes');
      expect(t.applicableAdapters).toContain('claude-code');
    }
  });

  it('getRoleTemplate returns matching template or undefined', () => {
    expect(getRoleTemplate('engineer')?.displayName).toBe('Software Engineer');
    expect(getRoleTemplate('does-not-exist')).toBeUndefined();
  });

  it('listRoleTemplates returns name/displayName/description triples', () => {
    const list = listRoleTemplates();
    expect(list).toHaveLength(6);
    expect(list[0]).toHaveProperty('name');
    expect(list[0]).toHaveProperty('displayName');
    expect(list[0]).toHaveProperty('description');
  });

  it('personal-assistant template is registered with PKF report delivery skills', () => {
    const assistant = getRoleTemplate('personal-assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.displayName).toBe('Personal Assistant');
    const rt = (assistant!.configSchema as any).roleTemplate as Record<string, any>;
    const requiredSkillSlugs = (rt.requiredSkills as Array<{ skillSlug: string }>).map((s) => s.skillSlug);
    expect(requiredSkillSlugs).toEqual(expect.arrayContaining(['pkf-writing', 'pkf-svg']));
    expect(assistant!.configSchema.systemPrompt as string).toContain('inline PKF');
    expect(assistant!.configSchema.systemPrompt as string).toContain('pkf_validate');
    expect(assistant!.configSchema.systemPrompt as string).toContain('pkf_reply_inline');
  });

  // release201/07 S24 — skill-author role template specific assertions.
  it('skill-author template parses + carries required release201/07 §6 fields', () => {
    const skillAuthor = getRoleTemplate('skill-author');
    expect(skillAuthor).toBeDefined();
    expect(skillAuthor!.displayName).toBe('Skill Author');

    const cfg = skillAuthor!.configSchema as Record<string, unknown>;
    // operatingPrinciples must be present (release201/07 §0.2.4 forbidden:
    // "skill-author role 无 operatingPrinciples")
    expect(Array.isArray((cfg as any).operatingPrinciples)).toBe(true);
    expect(((cfg as any).operatingPrinciples as string[]).length).toBeGreaterThan(0);

    // roleTemplate sub-block carries the SDK-side spec fields
    const rt = (cfg as any).roleTemplate as Record<string, any>;
    expect(rt).toBeDefined();
    expect(rt.slug).toBe('skill-author');
    expect(rt.agentType).toBe('specialist');
    // release201/07 §0.2.4 forbidden: "skill-author role 用 baseSkillSet 非
    // 'prismer-base'". Lock to prismer-base.
    expect(rt.baseSkillSet).toBe('prismer-base');
    // Required skills must include the 4 from release201/07 §0.1
    const requiredSkillSlugs = (rt.requiredSkills as Array<{ skillSlug: string }>).map(
      (s) => s.skillSlug,
    );
    expect(requiredSkillSlugs).toContain('skill-creator');
    expect(requiredSkillSlugs).toContain('ingest');
    expect(requiredSkillSlugs).toContain('assets');
    expect(requiredSkillSlugs).toContain('agent-coordination');
    // release203 — persistence agents are fully autonomous (no approval
    // gating). Auto-publish is still prevented by the SKILL prompt + the
    // publish-time approval gate, NOT by the agent's approvalPolicy.
    expect(rt.approvalPolicy).toBe('autonomous');
    expect(rt.taskAuthority).toBe('executor');
  });
});

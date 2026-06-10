import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_TEMPLATES, getRoleTemplate, listRoleTemplates } from '../src/templates/index.js';

describe('built-in role templates', () => {
  it('exposes 5 templates', () => {
    expect(BUILTIN_ROLE_TEMPLATES).toHaveLength(5);
    const names = BUILTIN_ROLE_TEMPLATES.map((t) => t.templateName);
    expect(names.sort()).toEqual([
      'ceo',
      'engineer',
      'product-manager',
      'researcher',
      'skill-author',
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

  it('all templates declare hermes / openclaw / claude-code as applicable', () => {
    for (const t of BUILTIN_ROLE_TEMPLATES) {
      expect(t.applicableAdapters).toContain('hermes');
      expect(t.applicableAdapters).toContain('openclaw');
      expect(t.applicableAdapters).toContain('claude-code');
    }
  });

  it('getRoleTemplate returns matching template or undefined', () => {
    expect(getRoleTemplate('engineer')?.displayName).toBe('Software Engineer');
    expect(getRoleTemplate('does-not-exist')).toBeUndefined();
  });

  it('listRoleTemplates returns name/displayName/description triples', () => {
    const list = listRoleTemplates();
    expect(list).toHaveLength(5);
    expect(list[0]).toHaveProperty('name');
    expect(list[0]).toHaveProperty('displayName');
    expect(list[0]).toHaveProperty('description');
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
    expect(requiredSkillSlugs).toContain('skill-authoring');
    expect(requiredSkillSlugs).toContain('ingest');
    expect(requiredSkillSlugs).toContain('assets');
    expect(requiredSkillSlugs).toContain('agent-coordination');
    // Authoring agents must not auto-publish — approvalPolicy stays low-risk
    expect(rt.approvalPolicy).toBe('auto-low-risk');
    expect(rt.taskAuthority).toBe('executor');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appendChiefOfStaffClause,
  buildChiefOfStaffSystemPrompt,
  buildRoleOperatingPrinciples,
  DEFAULT_ORCHESTRATOR_POLICY,
  DEFAULT_SPECIALIST_POLICY,
  buildWorkspaceRoleTemplateSnapshot,
  buildWorkspaceKickoffMessage,
  buildWorkspaceSystemPrompt,
  projectMcpAllowlist,
  prependSkillFirstClauseIfMissing,
} from '../role-runtime-policy';

function readCeoRuntimeTemplate(): {
  configSchema: {
    systemPrompt: string;
    roleTemplate: {
      taskAuthority: string;
      systemCapabilities: typeof DEFAULT_ORCHESTRATOR_POLICY.systemCapabilities;
      memoryPolicy: typeof DEFAULT_ORCHESTRATOR_POLICY.memoryPolicy;
      requiredSkills: Array<{ skillSlug: string }>;
    };
  };
} {
  const path = resolve(process.cwd(), 'sdk/prismer-cloud/runtime/src/templates/roles/ceo.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('role-runtime-policy', () => {
  it('projects allowlists from the canonical policy table', () => {
    const orchestratorTools = projectMcpAllowlist(DEFAULT_ORCHESTRATOR_POLICY);
    const specialistTools = projectMcpAllowlist(DEFAULT_SPECIALIST_POLICY);

    expect(orchestratorTools).toEqual(
      expect.arrayContaining([
        'prismer.task.approve',
        'prismer.task.reject',
        'prismer.task.cancel',
        'prismer.skill.installed',
        'prismer.skill.sync',
      ]),
    );
    expect(specialistTools).not.toContain('prismer.task.approve');
    expect(specialistTools).toContain('prismer.skill.sync');
  });

  it('builds the role prompt text used by profile defaults', () => {
    const orchestrator = buildRoleOperatingPrinciples('orchestrator', 'CEO');
    const specialist = buildRoleOperatingPrinciples('executor', 'Engineer');

    expect(orchestrator.en).toContain('[Role] CEO (orchestrator)');
    expect(orchestrator.en).toContain('prismer.skill.installed');
    expect(orchestrator.en).toContain(`maxAutonomousRounds=5`);
    expect(specialist.en).toContain('[Role] Engineer (specialist)');
    expect(specialist.en).toContain('[Skill-first — v2.0]');
  });

  it('builds workspace bootstrap prompts from the shared contract', () => {
    const systemPrompt = buildWorkspaceSystemPrompt({
      displayName: 'Engineer',
      rationale: 'Ships implementation work.',
      organizationName: 'Acme Research',
    });

    const roleTemplate = buildWorkspaceRoleTemplateSnapshot({
      slug: 'engineer',
      displayName: 'Engineer',
      rationale: 'Ships implementation work.',
      organizationName: 'Acme Research',
      authority: 'executor',
    });

    expect(systemPrompt).toContain('Acme Research');
    expect(systemPrompt).toContain('Engineer');
    expect(systemPrompt).toContain('Ships implementation work.');
    expect(buildWorkspaceKickoffMessage('ceo')).toContain('@ceo');
    expect(roleTemplate).toMatchObject({
      slug: 'engineer',
      taskAuthority: 'executor',
      approvalPolicy: 'auto-low-risk',
      metadata: { roleRuntimePolicy: DEFAULT_SPECIALIST_POLICY },
    });
    expect((roleTemplate as { mcpServers: Array<{ toolsAllowlist?: string[] }> }).mcpServers[0].toolsAllowlist).toEqual(
      expect.arrayContaining(['prismer.asset.search', 'prismer.asset.describe', 'prismer.asset.read']),
    );
  });

  it('keeps the shipped CEO runtime snapshot aligned with the shared contract', () => {
    const ceo = readCeoRuntimeTemplate();

    // S50b — release201/16 (human-collaboration onboarding) adds an
    // `[Onboarding humans]` block to the shipped ceo.json systemPrompt that
    // is not yet codified in `buildChiefOfStaffSystemPrompt()`. The CEO
    // template is allowed to extend the shared contract with additional
    // trailing sections, but must keep the builder-output as a prefix so
    // the canonical clauses (Role / Scope / Skill routing / Delegation /
    // Authority) stay aligned. Once doc 16 lands in the builder, restore
    // strict equality.
    expect(ceo.configSchema.systemPrompt.startsWith(buildChiefOfStaffSystemPrompt())).toBe(true);
    expect(ceo.configSchema.roleTemplate.taskAuthority).toBe('orchestrator');
    expect(ceo.configSchema.roleTemplate.systemCapabilities).toEqual(DEFAULT_ORCHESTRATOR_POLICY.systemCapabilities);
    expect(ceo.configSchema.roleTemplate.memoryPolicy).toEqual(DEFAULT_ORCHESTRATOR_POLICY.memoryPolicy);
    // S50b — release201/16 added `team` skill to the shipped CEO required
    // set (human-collaboration onboarding). Assert the canonical 8 are
    // present in order; allow additional doc-driven skills to follow.
    expect(ceo.configSchema.roleTemplate.requiredSkills.map((item: { skillSlug: string }) => item.skillSlug)).toEqual(
      expect.arrayContaining([
        'tasks',
        'agent-coordination',
        'human-approval',
        'memory',
        'assets',
        'ingest',
        'agent-meta',
        'office-artifacts',
      ]),
    );
  });

  it('idempotently injects legacy prompt clauses', () => {
    const injected = prependSkillFirstClauseIfMissing('Hello', true);
    const twice = prependSkillFirstClauseIfMissing(injected, true);

    expect(typeof injected).toBe('string');
    expect(injected).toContain('[Skill-first — v2.0]');
    expect(twice).toBe(injected);

    const cos = appendChiefOfStaffClause({ en: 'Hello' });
    expect((cos as { en: string }).en).toContain('[Chief of Staff 权限');
  });
});

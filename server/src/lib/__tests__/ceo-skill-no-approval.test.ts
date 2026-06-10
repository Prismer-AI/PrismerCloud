import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

interface CeoTemplate {
  configSchema: {
    systemPrompt: string;
    roleTemplate: {
      hermesConfig: { agents: string; soul: string };
      openclawConfig: { agents: string };
      operatingPrinciples: { en: string; zh: string };
    };
  };
}

function readCeoTemplate(): CeoTemplate {
  const path = resolve(process.cwd(), 'sdk/prismer-cloud/runtime/src/templates/roles/ceo.json');
  return JSON.parse(readFileSync(path, 'utf8')) as CeoTemplate;
}

describe('CEO skill drafting — no approval required (Bug 3)', () => {
  const ceoTemplate = readCeoTemplate();
  const sections: Record<string, string> = {
    systemPrompt: ceoTemplate.configSchema.systemPrompt,
    'hermesConfig.soul': ceoTemplate.configSchema.roleTemplate.hermesConfig.soul,
    'hermesConfig.agents': ceoTemplate.configSchema.roleTemplate.hermesConfig.agents,
    'openclawConfig.agents': ceoTemplate.configSchema.roleTemplate.openclawConfig.agents,
    'operatingPrinciples.en': ceoTemplate.configSchema.roleTemplate.operatingPrinciples.en,
    'operatingPrinciples.zh': ceoTemplate.configSchema.roleTemplate.operatingPrinciples.zh,
  };

  for (const [name, body] of Object.entries(sections)) {
    test(`${name} explicitly states skill drafting does not need approval`, () => {
      const lower = body.toLowerCase();
      // Strip markdown emphasis markers so "**不**需要人工审批" matches "不需要人工审批".
      const stripped = lower.replace(/\*+/g, '');
      const hasNoApprovalLanguage =
        stripped.includes('does not require human approval') ||
        stripped.includes('do not request human approval') ||
        stripped.includes('不需要人工审批') ||
        stripped.includes('不需要审批');
      const mentionsSkillContext =
        stripped.includes('skill') ||
        stripped.includes('技能') ||
        stripped.includes('草稿') ||
        stripped.includes('drafting');
      expect(hasNoApprovalLanguage && mentionsSkillContext).toBe(true);
    });
  }
});

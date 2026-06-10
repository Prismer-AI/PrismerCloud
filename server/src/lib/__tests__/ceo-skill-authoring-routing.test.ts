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

describe('CEO operatingPrinciples — skill-authoring capability routing (G3)', () => {
  const ceoTemplate = readCeoTemplate();
  const sections: Record<string, string> = {
    systemPrompt: ceoTemplate.configSchema.systemPrompt,
    'roleTemplate.hermesConfig.agents': ceoTemplate.configSchema.roleTemplate.hermesConfig.agents,
    'roleTemplate.hermesConfig.soul': ceoTemplate.configSchema.roleTemplate.hermesConfig.soul,
    'roleTemplate.openclawConfig.agents': ceoTemplate.configSchema.roleTemplate.openclawConfig.agents,
    'roleTemplate.operatingPrinciples.en': ceoTemplate.configSchema.roleTemplate.operatingPrinciples.en,
    'roleTemplate.operatingPrinciples.zh': ceoTemplate.configSchema.roleTemplate.operatingPrinciples.zh,
  };

  for (const [name, body] of Object.entries(sections)) {
    test(`${name} mentions skill-authoring routing`, () => {
      const lower = body.toLowerCase();
      expect(lower.includes('skill-authoring') && (lower.includes('skill') || lower.includes('技能'))).toBe(true);
    });
  }
});

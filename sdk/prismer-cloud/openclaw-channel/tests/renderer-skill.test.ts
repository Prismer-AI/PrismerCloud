// OpenClaw renderer — verifies the always-on memory-curation skill
// (doc 27 §3) is included in every workspace projection.

import { describe, expect, it } from 'vitest';
import { renderForOpenClaw } from '../src/renderer';
import {
  MEMORY_CURATION_SKILL_NAME,
  MEMORY_CURATION_SKILL_TEXT,
} from '../src/memory-curation-skill';

describe('OpenClaw renderer — memory-curation always-on skill', () => {
  it('includes skills/memory-curation/SKILL.md when no strategies are present', () => {
    const files = renderForOpenClaw({ scope: 'global' });
    const skill = files.find(
      (f) => f.relativePath === `skills/${MEMORY_CURATION_SKILL_NAME}/SKILL.md`,
    );
    expect(skill, 'memory-curation skill missing from rendered files').toBeDefined();
    expect(skill?.content).toBe(MEMORY_CURATION_SKILL_TEXT);
    expect(skill?.meta.sourceSlot).toBe('builtin-skills');
  });

  it('coexists with strategy-derived skills', () => {
    const files = renderForOpenClaw({
      scope: 'global',
      strategies: [
        {
          gene: { id: 'gene-1', title: 'Test Gene', description: 'A test', strategy: '[]' },
          successRate: 0.8,
          executions: 10,
        },
      ],
    });
    const skillFiles = files.filter((f) => f.relativePath.startsWith('skills/'));
    const builtin = skillFiles.find(
      (f) => f.relativePath === `skills/${MEMORY_CURATION_SKILL_NAME}/SKILL.md`,
    );
    const strategy = skillFiles.find((f) => f.relativePath === 'skills/test-gene/SKILL.md');
    expect(builtin).toBeDefined();
    expect(strategy).toBeDefined();
  });
});

// Codex adapter — verifies the memory-curation skill (doc 27 §3) is injected
// into the prompt preamble. Pure-function test — no spawn.

import { describe, expect, it } from 'vitest';
import { buildCodexPrompt } from '../src/adapters/codex/index.js';
import {
  MEMORY_CURATION_SKILL_NAME,
  MEMORY_CURATION_SKILL_TEXT,
} from '../src/skills/memory-curation.js';

const baseConfig = {
  cwd: '/tmp',
  model: 'codex-mini-latest',
  sandbox: 'workspace-write' as const,
  apiKeyEnv: 'OPENAI_API_KEY',
};

describe('Codex adapter — skill injection', () => {
  it('prepends the memory-curation skill to the task prompt', () => {
    const prompt = buildCodexPrompt(baseConfig, 'do thing X');
    expect(prompt.startsWith(MEMORY_CURATION_SKILL_TEXT)).toBe(true);
    expect(prompt.endsWith('do thing X')).toBe(true);
  });

  it('preserves a workspace-configured systemPrompt between skills and task', () => {
    const prompt = buildCodexPrompt(
      { ...baseConfig, systemPrompt: 'You are an editor.' },
      'rewrite the file',
    );
    const skillIdx = prompt.indexOf(MEMORY_CURATION_SKILL_TEXT);
    const sysIdx = prompt.indexOf('You are an editor.');
    const taskIdx = prompt.indexOf('rewrite the file');
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(sysIdx).toBeGreaterThan(skillIdx);
    expect(taskIdx).toBeGreaterThan(sysIdx);
  });

  it('omits an empty systemPrompt cleanly (no double blank line)', () => {
    const prompt = buildCodexPrompt({ ...baseConfig, systemPrompt: '   ' }, 'task');
    // Three blank lines in a row (\n\n\n) means we hallucinated an empty section.
    expect(prompt).not.toMatch(/\n\n\n/);
  });

  it('skill constant exposes the documented name and version', () => {
    expect(MEMORY_CURATION_SKILL_NAME).toBe('memory-curation');
  });
});

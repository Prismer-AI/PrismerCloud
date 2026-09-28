// Codex adapter prompt assembly (product209/15 PKF-C2).
//
// The deprecated full-text `memory-curation` skill preamble is GONE — Codex
// discovers skill text through standard skill delivery (remote → verified LKG
// → bundled fallback) like every other adapter. This test is the prompt
// snapshot proving the injection no longer happens; it preserves the
// systemPrompt-ordering + no-double-blank-line compatibility acceptance of
// the old test.

import { describe, expect, it } from 'vitest';
import { buildCodexPrompt } from '../src/adapters/coding/codex/index.js';

const baseConfig = {
  cwd: '/tmp',
  model: 'codex-mini-latest',
  sandbox: 'workspace-write' as const,
  apiKeyEnv: 'OPENAI_API_KEY',
};

describe('Codex adapter — prompt assembly (no deprecated skill preamble)', () => {
  it('no longer injects any memory-curation preamble text', () => {
    const prompt = buildCodexPrompt(baseConfig, 'do thing X');
    expect(prompt.toLowerCase()).not.toContain('memory-curation');
    expect(prompt).toBe('do thing X');
  });

  it('keeps the dispatch-supplied systemPrompt before the task', () => {
    const prompt = buildCodexPrompt(
      { ...baseConfig, systemPrompt: 'You are an editor.' },
      'rewrite the file',
    );
    const sysIdx = prompt.indexOf('You are an editor.');
    const taskIdx = prompt.indexOf('rewrite the file');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(sysIdx);
  });

  it('omits an empty systemPrompt cleanly (no double blank line)', () => {
    const prompt = buildCodexPrompt({ ...baseConfig, systemPrompt: '   ' }, 'task');
    expect(prompt).not.toMatch(/\n\n\n/);
    expect(prompt).toBe('task');
  });
});

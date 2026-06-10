// F18 / release202/04 §3.1 — `appendArtifactsInstruction` per-task file
// directory contract (renamed from appendOutboxInstruction).
//
// Pre-F18: single artifacts dir, prompt mentioned only one path, LLM that
// used relative paths fell back to hermes process cwd (= daemon cwd =
// user's shell cwd) → real incident where 5 agent-generated .py files
// landed in `prismercloud/` source tree.
//
// Post-F18 / release202/04: two directories surfaced to the LLM:
//   • artifactsDir (uploaded as chat attachments)
//   • scratchDir   (intermediate, not uploaded)
// Both absolute; instruction is mandatory; relative paths discouraged
// loudly so the file-system isn't a footgun.

import { describe, expect, it } from 'vitest';
import { appendArtifactsInstruction } from '../src/daemon/dispatch.js';

const PROMPT = 'Draw a chart of the data and send it back.';
const ARTIFACTS = '/Users/x/.prismer/workspaces/w/projects/_unscoped/tasks/task-abc/artifacts';
const SCRATCH = '/Users/x/.prismer/workspaces/w/projects/_unscoped/tasks/task-abc/scratch';

describe('appendArtifactsInstruction (release202/04)', () => {
  it('returns prompt unchanged when no artifactsDir is given', () => {
    expect(appendArtifactsInstruction(PROMPT, null, undefined)).toBe(PROMPT);
  });

  it('returns prompt unchanged when profile disables hints', () => {
    expect(appendArtifactsInstruction(PROMPT, ARTIFACTS, { disableOutboxHints: true }, SCRATCH)).toBe(PROMPT);
  });

  it('emits MANDATORY absolute-path rules when given artifactsDir + scratchDir', () => {
    const result = appendArtifactsInstruction(PROMPT, ARTIFACTS, undefined, SCRATCH);
    expect(result).toContain('MANDATORY');
    expect(result).toContain(ARTIFACTS);
    expect(result).toContain(SCRATCH);
    expect(result).toContain('ALWAYS use absolute paths');
    expect(result).toContain('NEVER write files with relative paths');
    expect(result).toContain('Artifacts (auto-uploaded as chat attachments)');
    expect(result).toContain('Scratch (intermediate, NOT uploaded)');
    expect(result).toContain('PRISMER_ARTIFACTS_DIR and PRISMER_SCRATCH_DIR');
    // The user prompt must still come through after the rules block.
    expect(result.endsWith(PROMPT)).toBe(true);
  });

  it('forbids /tmp / home / cwd and routes scratch vs. deliverables (§3.2)', () => {
    const result = appendArtifactsInstruction(PROMPT, ARTIFACTS, undefined, SCRATCH);
    // /tmp-forbid rule (primary lever for long-running adapters).
    expect(result).toContain('/tmp');
    expect(result).toContain('NEVER write to /tmp');
    expect(result).toMatch(/home directory/i);
    // Explicit routing: intermediate → scratch, final → artifacts.
    expect(result).toMatch(/Intermediate \/ scratch files/);
    expect(result).toMatch(/Final deliverables/);
    expect(result.endsWith(PROMPT)).toBe(true);
  });

  it('still forbids /tmp even when scratchDir is null', () => {
    const result = appendArtifactsInstruction(PROMPT, ARTIFACTS, undefined, null);
    expect(result).toContain('NEVER write to /tmp');
    // Without a scratch dir there is no routing block, only the single-dir rule.
    expect(result).not.toMatch(/Intermediate \/ scratch files/);
    expect(result.endsWith(PROMPT)).toBe(true);
  });

  it('omits the scratch section but keeps artifacts rules when scratchDir is null', () => {
    const result = appendArtifactsInstruction(PROMPT, ARTIFACTS, undefined, null);
    expect(result).toContain(ARTIFACTS);
    expect(result).toContain('Artifacts (auto-uploaded as chat attachments)');
    expect(result).not.toContain('Scratch');
    expect(result).toContain('PRISMER_ARTIFACTS_DIR');
    expect(result).not.toContain('PRISMER_SCRATCH_DIR');
    expect(result.endsWith(PROMPT)).toBe(true);
  });

  it('warns that out-of-bounds relative paths pollute user workdir', () => {
    const result = appendArtifactsInstruction(PROMPT, ARTIFACTS, undefined, SCRATCH);
    expect(result).toMatch(/pollute the\s+user/i);
    expect(result).toMatch(/hard error/i);
  });
});

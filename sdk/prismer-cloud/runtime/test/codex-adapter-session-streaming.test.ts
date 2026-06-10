// release202/05 C1 (streaming progress) + C2 (session continuity) — pure-helper
// unit tests for the codex adapter. The mapper interaction + real resume are
// covered by the live e2e in the C-task report (needs a daemon DB + codex CLI),
// not unit-testable here.
//
// Fixtures are REAL `codex exec --json` JSONL lines captured from codex-cli
// 0.133.0 against the local gateway (2026-06-02).

import { describe, it, expect } from 'vitest';
import {
  parseCodexSessionId,
  codexJsonlToProgress,
  CodexConfigSchema,
} from '../src/adapters/codex/index.js';

// ---------------------------------------------------------------------------
// C2 — parseCodexSessionId
// ---------------------------------------------------------------------------

describe('parseCodexSessionId', () => {
  const realStdout = [
    '{"type":"thread.started","thread_id":"019e8739-49a4-7000-817c-caa3fc401623"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Acknowledged. I’ll remember 77."}}',
    '{"type":"turn.completed"}',
    '',
  ].join('\n');

  it('extracts the thread_id from a thread.started line', () => {
    expect(parseCodexSessionId(realStdout)).toBe('019e8739-49a4-7000-817c-caa3fc401623');
  });

  it('returns null when no thread.started line is present (e.g. ephemeral run)', () => {
    const stdout = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    expect(parseCodexSessionId(stdout)).toBeNull();
  });

  it('returns null on empty / non-JSON output', () => {
    expect(parseCodexSessionId('')).toBeNull();
    expect(parseCodexSessionId('not json at all\nthread.started but not json')).toBeNull();
  });

  it('ignores a thread.started without a thread_id', () => {
    expect(parseCodexSessionId('{"type":"thread.started"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C1 — codexJsonlToProgress
// ---------------------------------------------------------------------------

describe('codexJsonlToProgress', () => {
  it('maps a command_execution item.completed line to a progress message', () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'echo hello-from-codex\'","aggregated_output":"hello-from-codex\\n","exit_code":0,"status":"completed"}}';
    const ev = codexJsonlToProgress(line);
    expect(ev).not.toBeNull();
    expect(ev!.message).toContain('ran (exit 0)');
    expect(ev!.message).toContain('echo hello-from-codex');
    expect(ev!.detail.kind).toBe('command_execution');
    expect(ev!.detail.phase).toBe('completed');
    expect(ev!.detail.exitCode).toBe(0);
  });

  it('maps a command_execution item.started line to a "running:" message', () => {
    const line =
      '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'ls\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
    const ev = codexJsonlToProgress(line);
    expect(ev).not.toBeNull();
    expect(ev!.message).toContain('running:');
    expect(ev!.message).toContain('ls');
    expect(ev!.detail.phase).toBe('started');
  });

  it('maps an agent_message item.completed to its text', () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"all done"}}';
    const ev = codexJsonlToProgress(line);
    expect(ev).not.toBeNull();
    expect(ev!.message).toBe('all done');
    expect(ev!.detail.kind).toBe('agent_message');
  });

  it('returns null for unrelated lines (thread.started / turn.* / blank / non-JSON)', () => {
    expect(
      codexJsonlToProgress('{"type":"thread.started","thread_id":"019e8739-49a4-7000-817c-caa3fc401623"}'),
    ).toBeNull();
    expect(codexJsonlToProgress('{"type":"turn.started"}')).toBeNull();
    expect(codexJsonlToProgress('{"type":"turn.completed"}')).toBeNull();
    expect(codexJsonlToProgress('')).toBeNull();
    expect(codexJsonlToProgress('   ')).toBeNull();
    expect(codexJsonlToProgress('not json')).toBeNull();
    // an empty agent_message yields no progress
    expect(
      codexJsonlToProgress('{"type":"item.completed","item":{"type":"agent_message","text":""}}'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C2 — config field default
// ---------------------------------------------------------------------------

describe('CodexConfigSchema.sessionContinuity', () => {
  it('defaults to true', () => {
    const parsed = CodexConfigSchema.parse({ cwd: '/tmp/x' });
    expect(parsed.sessionContinuity).toBe(true);
  });

  it('can be disabled', () => {
    const parsed = CodexConfigSchema.parse({ cwd: '/tmp/x', sessionContinuity: false });
    expect(parsed.sessionContinuity).toBe(false);
  });
});

import { buildCodexArgs } from '../src/adapters/codex/index.js';

describe('buildCodexArgs — `--` separator (regression: --- prompt → unexpected argument)', () => {
  const base = { model: 'us-kimi-k2.6', spawnCwd: '/tmp/w', sandbox: 'read-only', prompt: '---\nname: x\n---\nhi' };
  it('fresh persisted run: -- immediately precedes the prompt, no --ephemeral', () => {
    const a = buildCodexArgs({ ...base, resumeId: null, sessionContinuity: true });
    expect(a).not.toContain('--ephemeral');
    expect(a[a.length - 2]).toBe('--');
    expect(a[a.length - 1]).toBe(base.prompt);
  });
  it('ephemeral (continuity off) keeps --ephemeral but still -- before prompt', () => {
    const a = buildCodexArgs({ ...base, resumeId: null, sessionContinuity: false });
    expect(a).toContain('--ephemeral');
    expect(a[a.length - 2]).toBe('--');
  });
  it('resume run: exec resume <id> -- <prompt>, no --sandbox/--cd', () => {
    const a = buildCodexArgs({ ...base, resumeId: '019e-thread', sessionContinuity: true });
    expect(a.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(a).toContain('019e-thread');
    expect(a).not.toContain('--sandbox');
    expect(a).not.toContain('--cd');
    expect(a[a.length - 2]).toBe('--');
    expect(a[a.length - 1]).toBe(base.prompt);
  });
});

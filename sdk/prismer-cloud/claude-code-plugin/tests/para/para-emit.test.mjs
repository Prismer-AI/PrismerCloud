/**
 * para-emit.test.mjs — Integration tests for hooks/para-emit.mjs
 *
 * For each tested CC hook name: construct a realistic CC payload,
 * pipe to para-emit.mjs, and verify the resulting JSONL line is a valid
 * PARA event via ParaEventSchema.parse().
 *
 * Tests 10 of the 26 CC hooks (most common):
 *   SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *   PostToolUseFailure, SubagentStart, Stop, StopFailure,
 *   PreCompact, PostCompact
 *
 * Para-emit writes to ~/.prismer/para/events.jsonl AND stdout when
 * PRISMER_PARA_STDOUT=1. We set that env var and capture stdout.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARA_EMIT = join(__dirname, '..', '..', 'hooks', 'para-emit.mjs');
const PLUGIN_ROOT = join(__dirname, '..', '..');

// Load ParaEventSchema from the plugin's node_modules
import { createRequire } from 'module';
const req = createRequire(join(PLUGIN_ROOT, 'package.json'));
let ParaEventSchema;
try {
  ParaEventSchema = req('@prismer/wire').ParaEventSchema;
} catch {
  // If wire not installed, skip schema validation
  ParaEventSchema = null;
}

// ─── Helper to run para-emit as a child process ────────────────────────────

let tmpHome;

function runParaEmit(hookName, payload = {}, extraEnv = {}) {
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync('node', [PARA_EMIT, hookName], {
      input,
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: tmpHome,
        PRISMER_PARA_STDOUT: '1',
        ...extraEnv,
      },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

/** Parse the first JSONL line from stdout (stripping _ts). */
function parseFirstLine(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  // May be multiple lines (e.g., SessionStart emits register + started)
  return lines.map((l) => JSON.parse(l));
}

/** Validate an event object via ParaEventSchema if available. */
function validateEvent(obj) {
  if (!ParaEventSchema) return true; // schema not loaded, skip validation
  const { _ts, ...rest } = obj;
  return ParaEventSchema.safeParse(rest).success;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  tmpHome = join(tmpdir(), `para-emit-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  // Clean up agent-descriptor between tests so register re-fires
  const descFile = join(tmpHome, '.prismer', 'para', 'agent-descriptor.json');
  if (existsSync(descFile)) rmSync(descFile);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('para-emit.mjs — CC hook translation', () => {
  it('exits 0 on all hook names (observation-only, never breaks CC)', () => {
    const { exitCode } = runParaEmit('SessionStart', { session_id: 'abc' });
    expect(exitCode).toBe(0);
  });

  it('SessionStart → agent.register + agent.session.started (first time)', () => {
    const { stdout, exitCode } = runParaEmit('SessionStart', { session_id: 'sess-001' });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    expect(lines).not.toBeNull();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const register = lines.find((l) => l.type === 'agent.register');
    expect(register).toBeDefined();
    expect(register.agent).toBeDefined();
    expect(register.agent.adapter).toBe('claude-code');
    expect(Array.isArray(register.agent.tiersSupported)).toBe(true);
    expect(register.agent.tiersSupported).toEqual(expect.arrayContaining([1, 2, 3, 7]));
    expect(validateEvent(register)).toBe(true);

    const started = lines.find((l) => l.type === 'agent.session.started');
    expect(started).toBeDefined();
    expect(started.sessionId).toBe('sess-001');
    expect(validateEvent(started)).toBe(true);
  });

  it('SessionStart (second time) → only agent.session.started (no register)', () => {
    // First call builds the cache
    runParaEmit('SessionStart', { session_id: 'sess-001' });
    // Second call should NOT re-register
    const { stdout } = runParaEmit('SessionStart', { session_id: 'sess-002' });
    const lines = parseFirstLine(stdout);
    const registers = lines.filter((l) => l.type === 'agent.register');
    expect(registers.length).toBe(0);
    const started = lines.find((l) => l.type === 'agent.session.started');
    expect(started).toBeDefined();
  });

  it('UserPromptSubmit → agent.prompt.submit', () => {
    const { stdout, exitCode } = runParaEmit('UserPromptSubmit', {
      session_id: 'sess-001',
      prompt: 'Fix the bug in auth.ts',
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.prompt.submit');
    expect(evt).toBeDefined();
    expect(evt.prompt).toBe('Fix the bug in auth.ts');
    expect(evt.source).toBe('user');
    expect(validateEvent(evt)).toBe(true);
  });

  it('PreToolUse → agent.tool.pre', () => {
    const { stdout, exitCode } = runParaEmit('PreToolUse', {
      tool_use_id: 'call-001',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.tool.pre');
    expect(evt).toBeDefined();
    expect(evt.tool).toBe('Bash');
    expect(evt.callId).toBe('call-001');
    expect(['low', 'mid', 'high']).toContain(evt.riskTag);
    expect(validateEvent(evt)).toBe(true);
  });

  it('PreToolUse Bash with rm → riskTag: high', () => {
    const { stdout } = runParaEmit('PreToolUse', {
      tool_use_id: 'call-002',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
    });
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.tool.pre');
    expect(evt.riskTag).toBe('high');
  });

  it('PostToolUse → agent.tool.post', () => {
    const { stdout, exitCode } = runParaEmit('PostToolUse', {
      tool_use_id: 'call-001',
      tool_name: 'Bash',
      tool_response: 'On branch main\nnothing to commit',
      success: true,
      duration_ms: 42,
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.tool.post');
    expect(evt).toBeDefined();
    expect(evt.ok).toBe(true);
    expect(typeof evt.durationMs).toBe('number');
    expect(typeof evt.summary).toBe('string');
    expect(validateEvent(evt)).toBe(true);
  });

  it('PostToolUseFailure → agent.tool.failure', () => {
    const { stdout, exitCode } = runParaEmit('PostToolUseFailure', {
      tool_use_id: 'call-003',
      error: 'Permission denied',
      is_interrupt: false,
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.tool.failure');
    expect(evt).toBeDefined();
    expect(evt.error).toBe('Permission denied');
    expect(validateEvent(evt)).toBe(true);
  });

  it('SubagentStart → agent.subagent.started', () => {
    const { stdout, exitCode } = runParaEmit('SubagentStart', {
      subagent_id: 'sub-001',
      parent_agent_id: 'parent-001',
      subagent_type: 'task',
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.subagent.started');
    expect(evt).toBeDefined();
    expect(evt.agentId).toBe('sub-001');
    expect(evt.subagentType).toBe('task');
    expect(validateEvent(evt)).toBe(true);
  });

  it('Stop → agent.turn.end', () => {
    const { stdout, exitCode } = runParaEmit('Stop', {
      session_id: 'sess-001',
      last_assistant_message: 'Done! The tests pass now.',
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.turn.end');
    expect(evt).toBeDefined();
    expect(evt.sessionId).toBe('sess-001');
    expect(evt.lastAssistantMessage).toContain('Done');
    expect(validateEvent(evt)).toBe(true);
  });

  it('StopFailure → agent.turn.failure', () => {
    const { stdout, exitCode } = runParaEmit('StopFailure', {
      session_id: 'sess-001',
      error_type: 'rate_limit',
      error_message: 'Rate limit exceeded (429)',
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.turn.failure');
    expect(evt).toBeDefined();
    expect(evt.errorType).toBe('rate_limit');
    expect(validateEvent(evt)).toBe(true);
  });

  it('PreCompact → agent.compact.pre', () => {
    const { stdout, exitCode } = runParaEmit('PreCompact', {
      session_id: 'sess-001',
      trigger: 'auto',
      message_count: 100,
      token_count: 150000,
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.compact.pre');
    expect(evt).toBeDefined();
    expect(evt.trigger).toBe('auto');
    expect(evt.messageCount).toBe(100);
    expect(evt.tokenCount).toBe(150000);
    expect(validateEvent(evt)).toBe(true);
  });

  it('PostCompact → agent.compact.post', () => {
    const { stdout, exitCode } = runParaEmit('PostCompact', {
      session_id: 'sess-001',
      compacted_count: 80,
      tokens_before: 150000,
      tokens_after: 25000,
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);
    const evt = lines.find((l) => l.type === 'agent.compact.post');
    expect(evt).toBeDefined();
    expect(evt.compactedCount).toBe(80);
    expect(evt.tokensBefore).toBe(150000);
    expect(evt.tokensAfter).toBe(25000);
    expect(validateEvent(evt)).toBe(true);
  });

  it('unknown hook name → exits 0 (never breaks CC)', () => {
    // para-emit writes to stderr via process.stderr.write, but when exit 0
    // execFileSync doesn't throw so stderr comes back empty. Just check exit code.
    const { exitCode } = runParaEmit('UnknownFutureHook', { session_id: 'x' });
    expect(exitCode).toBe(0);
  });

  it('invalid stdin JSON → exits 0 (never breaks CC)', () => {
    const scriptPath = PARA_EMIT;
    try {
      execFileSync('node', [scriptPath, 'Stop'], {
        input: 'not-json{{{',
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, HOME: tmpHome, PRISMER_PARA_STDOUT: '1' },
      });
      // Should not throw
    } catch (err) {
      expect(err.status).toBe(0);
    }
  });

  it('PostToolUse → agent.tool.post + agent.turn.step', () => {
    const { stdout, exitCode } = runParaEmit('PostToolUse', {
      session_id: 'sess-001',
      tool_name: 'Bash',
      tool_response: 'Command completed successfully',
      turn_id: 2,
    });
    expect(exitCode).toBe(0);
    const lines = parseFirstLine(stdout);

    // Should emit both agent.tool.post and agent.turn.step
    const toolPost = lines.find((l) => l.type === 'agent.tool.post');
    expect(toolPost).toBeDefined();
    expect(validateEvent(toolPost)).toBe(true);

    const turnStep = lines.find((l) => l.type === 'agent.turn.step');
    expect(turnStep).toBeDefined();
    expect(turnStep.sessionId).toBe('sess-001');
    expect(turnStep.iteration).toBe(2);
    expect(turnStep.toolNames).toEqual(['Bash']);
    expect(validateEvent(turnStep)).toBe(true);
  });
});

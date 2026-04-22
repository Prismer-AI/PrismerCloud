/**
 * agent-descriptor.test.mjs — Tests for AgentDescriptor cache behavior
 *
 * Verifies:
 *   1. SessionStart emits agent.register exactly once (first session)
 *   2. Second SessionStart emits only agent.session.started (no register)
 *   3. Cache file exists at expected path after first session
 *   4. AgentDescriptor has correct adapter/tiers/capabilityTags
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARA_EMIT = join(__dirname, '..', '..', 'hooks', 'para-emit.mjs');
const MULTI_SPAWN_TEST_TIMEOUT_MS = 15000;

let tmpHome;

function runParaEmit(hookName, payload = {}) {
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

function parseLines(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function agentDescriptorPath() {
  return join(tmpHome, '.prismer', 'para', 'agent-descriptor.json');
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `agent-desc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('AgentDescriptor cache behavior', () => {
  it('first SessionStart emits agent.register with correct fields', () => {
    const { stdout, exitCode } = runParaEmit('SessionStart', { session_id: 'first-session' });
    expect(exitCode).toBe(0);
    const lines = parseLines(stdout);
    const register = lines.find((l) => l.type === 'agent.register');
    expect(register).toBeDefined();
    expect(register.agent.adapter).toBe('claude-code');
    expect(register.agent.tiersSupported).toEqual(expect.arrayContaining([1, 2, 3, 7]));
    expect(register.agent.capabilityTags).toEqual(expect.arrayContaining(['code', 'shell', 'mcp']));
    expect(typeof register.agent.id).toBe('string');
    expect(register.agent.id.length).toBeGreaterThan(0);
    expect(typeof register.agent.workspace).toBe('string');
  });

  it('first SessionStart creates the descriptor cache file', () => {
    runParaEmit('SessionStart', { session_id: 'first-session' });
    expect(existsSync(agentDescriptorPath())).toBe(true);
  });

  it('descriptor cache file contains valid JSON with required fields', () => {
    runParaEmit('SessionStart', { session_id: 'first-session' });
    const raw = readFileSync(agentDescriptorPath(), 'utf-8');
    const desc = JSON.parse(raw);
    expect(desc.adapter).toBe('claude-code');
    expect(Array.isArray(desc.tiersSupported)).toBe(true);
    expect(desc.tiersSupported).toContain(1);
    expect(desc.tiersSupported).toContain(7);
    expect(typeof desc.id).toBe('string');
    expect(typeof desc.workspace).toBe('string');
    expect(typeof desc.version).toBe('string');
  });

  it('second SessionStart emits agent.session.started but NOT agent.register', { timeout: MULTI_SPAWN_TEST_TIMEOUT_MS }, () => {
    // First call: creates cache
    runParaEmit('SessionStart', { session_id: 'session-1' });
    // Second call: cache exists, should skip register
    const { stdout } = runParaEmit('SessionStart', { session_id: 'session-2' });
    const lines = parseLines(stdout);
    const registers = lines.filter((l) => l.type === 'agent.register');
    const started = lines.filter((l) => l.type === 'agent.session.started');
    expect(registers.length).toBe(0);
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started[0].sessionId).toBe('session-2');
  });

  it('stable ID is consistent across sessions (same workspace + hostname)', { timeout: MULTI_SPAWN_TEST_TIMEOUT_MS }, () => {
    runParaEmit('SessionStart', { session_id: 'session-1' });
    const desc1 = JSON.parse(readFileSync(agentDescriptorPath(), 'utf-8'));
    // Remove cache and regenerate
    rmSync(agentDescriptorPath());
    runParaEmit('SessionStart', { session_id: 'session-2' });
    const desc2 = JSON.parse(readFileSync(agentDescriptorPath(), 'utf-8'));
    // Same process.cwd() + hostname should produce same ID
    expect(desc1.id).toBe(desc2.id);
  });

  it('SessionStart with clear trigger emits additional agent.session.reset', () => {
    const { stdout } = runParaEmit('SessionStart', { session_id: 'sess', trigger: 'clear' });
    const lines = parseLines(stdout);
    const reset = lines.find((l) => l.type === 'agent.session.reset');
    expect(reset).toBeDefined();
    expect(reset.reason).toBe('clear');
  });

  it('agent.session.ended written to JSONL file', () => {
    const eventsFile = join(tmpHome, '.prismer', 'para', 'events.jsonl');
    runParaEmit('SessionEnd', { session_id: 'sess-end', reason: 'stop' });
    expect(existsSync(eventsFile)).toBe(true);
    const lines = readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
    const ended = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'agent.session.ended');
    expect(ended).toBeDefined();
    expect(ended.reason).toBe('stop');
  });
});

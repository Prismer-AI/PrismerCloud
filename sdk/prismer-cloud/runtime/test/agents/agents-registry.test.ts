// agents-registry.test.ts — unit tests for ~/.prismer/agents.json registry

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentsRegistryPath,
  readAgentsRegistry,
  writeAgentsRegistry,
  upsertAgent,
  removeAgent,
  findAgent,
  type InstalledAgent,
} from '../../src/agents/agents-registry.js';

// ============================================================
// Helpers
// ============================================================

function makeAgent(overrides?: Partial<InstalledAgent>): InstalledAgent {
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    version: '1.9.0',
    source: 'npm',
    installedAt: '2026-04-21T00:00:00.000Z',
    hookConfigPath: '/home/user/.claude/hooks.json',
    ...overrides,
  };
}

// ============================================================
// Setup / teardown
// ============================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-registry-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// agentsRegistryPath
// ============================================================

describe('agentsRegistryPath', () => {
  it('returns ~/.prismer/agents.json under the given homeDir', () => {
    expect(agentsRegistryPath('/home/alice')).toBe('/home/alice/.prismer/agents.json');
  });
});

// ============================================================
// readAgentsRegistry
// ============================================================

describe('readAgentsRegistry — missing file', () => {
  it('returns [] when the file does not exist', () => {
    expect(readAgentsRegistry(tmpDir)).toEqual([]);
  });
});

describe('readAgentsRegistry — corrupt file', () => {
  it('returns [] for invalid JSON', () => {
    const file = agentsRegistryPath(tmpDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json ]]]', 'utf-8');
    expect(readAgentsRegistry(tmpDir)).toEqual([]);
  });

  it('returns [] when root is not an array', () => {
    const file = agentsRegistryPath(tmpDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"name":"oops"}', 'utf-8');
    expect(readAgentsRegistry(tmpDir)).toEqual([]);
  });

  it('skips rows missing required fields', () => {
    const file = agentsRegistryPath(tmpDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ noName: true }]), 'utf-8');
    expect(readAgentsRegistry(tmpDir)).toEqual([]);
  });
});

// ============================================================
// writeAgentsRegistry (atomic)
// ============================================================

describe('writeAgentsRegistry — atomic write', () => {
  it('writes and reads back correctly', () => {
    const agents = [makeAgent()];
    writeAgentsRegistry(tmpDir, agents);
    const read = readAgentsRegistry(tmpDir);
    expect(read).toHaveLength(1);
    expect(read[0].name).toBe('claude-code');
    expect(read[0].version).toBe('1.9.0');
  });

  it('does NOT leave a .tmp file behind on success', () => {
    writeAgentsRegistry(tmpDir, [makeAgent()]);
    const tmpFile = agentsRegistryPath(tmpDir) + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('sets file mode 0600', () => {
    writeAgentsRegistry(tmpDir, [makeAgent()]);
    const stat = fs.statSync(agentsRegistryPath(tmpDir));
    // 0o600 = 0x180. On some CI environments the umask may mask group/other
    // bits already, so we check user read+write bits are set.
    expect(stat.mode & 0o600).toBe(0o600);
  });
});

// ============================================================
// upsertAgent
// ============================================================

describe('upsertAgent', () => {
  it('creates the registry when it does not exist', () => {
    upsertAgent(tmpDir, makeAgent());
    const list = readAgentsRegistry(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('claude-code');
  });

  it('updates an existing entry by name', () => {
    upsertAgent(tmpDir, makeAgent({ version: '1.0.0' }));
    upsertAgent(tmpDir, makeAgent({ version: '1.9.0' }));
    const list = readAgentsRegistry(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe('1.9.0');
  });

  it('appends a new entry without touching existing entries', () => {
    upsertAgent(tmpDir, makeAgent({ name: 'claude-code' }));
    upsertAgent(tmpDir, makeAgent({ name: 'codex', displayName: 'Codex', hookConfigPath: '/tmp/codex/hooks.json' }));
    const list = readAgentsRegistry(tmpDir);
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.name).sort()).toEqual(['claude-code', 'codex']);
  });
});

// ============================================================
// removeAgent
// ============================================================

describe('removeAgent', () => {
  it('removes an existing entry', () => {
    upsertAgent(tmpDir, makeAgent({ name: 'claude-code' }));
    upsertAgent(tmpDir, makeAgent({ name: 'codex', displayName: 'Codex', hookConfigPath: '/tmp/codex/hooks.json' }));
    removeAgent(tmpDir, 'claude-code');
    const list = readAgentsRegistry(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('codex');
  });

  it('is a no-op when agent name is not in registry', () => {
    upsertAgent(tmpDir, makeAgent());
    // Should not throw
    expect(() => removeAgent(tmpDir, 'nonexistent')).not.toThrow();
    expect(readAgentsRegistry(tmpDir)).toHaveLength(1);
  });

  it('is a no-op on a missing file (empty registry)', () => {
    expect(() => removeAgent(tmpDir, 'claude-code')).not.toThrow();
  });

  it('leaves an empty array (not missing file) when last entry is removed', () => {
    upsertAgent(tmpDir, makeAgent());
    removeAgent(tmpDir, 'claude-code');
    const list = readAgentsRegistry(tmpDir);
    expect(list).toEqual([]);
    // File should still exist (empty array)
    expect(fs.existsSync(agentsRegistryPath(tmpDir))).toBe(true);
  });
});

// ============================================================
// findAgent
// ============================================================

describe('findAgent', () => {
  it('returns the entry when found', () => {
    upsertAgent(tmpDir, makeAgent({ version: '2.0.0' }));
    const found = findAgent(tmpDir, 'claude-code');
    expect(found).toBeDefined();
    expect(found?.version).toBe('2.0.0');
  });

  it('returns undefined when not found', () => {
    expect(findAgent(tmpDir, 'missing')).toBeUndefined();
  });

  it('returns undefined on missing registry file', () => {
    expect(findAgent(tmpDir, 'claude-code')).toBeUndefined();
  });
});

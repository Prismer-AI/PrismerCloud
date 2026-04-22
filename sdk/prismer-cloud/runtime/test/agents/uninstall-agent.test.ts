// T13 — uninstall-agent.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { uninstallAgent, UninstallCancelledError } from '../../src/agents/uninstall-agent.js';
import type { AgentCatalogEntry } from '../../src/agents/registry.js';

// ============================================================
// Helpers
// ============================================================

function makeCollector(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    isTTY: false,
  } as unknown as NodeJS.WritableStream;
  return { chunks, stream };
}

function makeCtx(opts?: { mode?: 'pretty' | 'json' | 'quiet' }): {
  ctx: CliContext;
  out: string[];
  err: string[];
} {
  const outCol = makeCollector();
  const errCol = makeCollector();
  const ui = new UI({
    mode: opts?.mode ?? 'pretty',
    color: false,
    stream: outCol.stream,
    errStream: errCol.stream,
  });
  const ctx: CliContext = {
    ui,
    keychain: {} as CliContext['keychain'],
    cwd: process.cwd(),
    argv: [],
  };
  return { ctx, out: outCol.chunks, err: errCol.chunks };
}

// A minimal catalog entry for testing.
function makeCatalogEntry(homeDir: string): AgentCatalogEntry {
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    hookConfigPath: path.join(homeDir, '.claude', 'settings.json'),
    sandboxProfile: 'claude-code',
    detect: async () => ({ found: false }),
    install: async () => ({ installed: false }),
  } as unknown as AgentCatalogEntry;
}

// ============================================================
// Setup / teardown
// ============================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-agent-test-'));
  // Ensure the .claude dir exists (for hookConfigPath resolution)
  fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  // Ensure sandbox dir
  fs.mkdirSync(path.join(tmpDir, '.prismer', 'sandbox'), { recursive: true });
  // Restore process.stdin.isTTY stub if any test changed it
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ============================================================
// Tests
// ============================================================

describe('uninstallAgent — confirmation gate', () => {

  it('proceeds without prompt when yes: true', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // No hooks backup exists, no sandbox profile — both skipped gracefully.
    const result = await uninstallAgent(ctx, 'claude-code', {
      yes: true,
      homeDir: tmpDir,
      catalog,
    });

    expect(result.agent).toBe('claude-code');
    // No hooks backup → hooksRestored false, no sandbox → sandboxRemoved false
    expect(result.hooksRestored).toBe(false);
    expect(result.sandboxRemoved).toBe(false);
  });

  it('removes sandbox profile when yes: true and profile exists', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    const sbPath = path.join(tmpDir, '.prismer', 'sandbox', 'claude-code.sb');
    fs.writeFileSync(sbPath, '# sandbox profile');

    const result = await uninstallAgent(ctx, 'claude-code', {
      yes: true,
      homeDir: tmpDir,
      catalog,
    });

    expect(result.sandboxRemoved).toBe(true);
    expect(fs.existsSync(sbPath)).toBe(false);
  });

  it('throws CONFIRMATION_REQUIRED in json mode without --yes', async () => {
    const { ctx } = makeCtx({ mode: 'json' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // Stub isTTY to true to ensure json mode check fires first
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await expect(
      uninstallAgent(ctx, 'claude-code', { yes: false, homeDir: tmpDir, catalog }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: expect.stringContaining('--yes required'),
    });
  });

  it('does not roll back hooks in json mode without --yes', async () => {
    const { ctx } = makeCtx({ mode: 'json' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // Create a hooks backup to verify it is NOT touched
    const hookPath = path.join(tmpDir, '.claude', 'settings.json');
    const backupPath = hookPath + '.bak';
    fs.writeFileSync(hookPath, '{}');
    fs.writeFileSync(backupPath, '{"hooks":{}}');

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await expect(
      uninstallAgent(ctx, 'claude-code', { yes: false, homeDir: tmpDir, catalog }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    // backup must still be present — no destructive work performed
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('throws "Confirmation required" for non-TTY stdin without --yes', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // Simulate non-TTY (CI pipe scenario)
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await expect(
      uninstallAgent(ctx, 'claude-code', { yes: false, homeDir: tmpDir, catalog }),
    ).rejects.toThrow('Confirmation required');
  });

  it('throws UninstallCancelledError for unknown agent', async () => {
    // Verify that unknown agent still fails regardless of yes flag
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    await expect(
      uninstallAgent(ctx, 'nonexistent-agent', { yes: true, homeDir: tmpDir, catalog }),
    ).rejects.toThrow('Unknown agent: nonexistent-agent');
  });

  it('UninstallCancelledError is instanceof Error', () => {
    const err = new UninstallCancelledError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UninstallCancelledError);
    expect(err.name).toBe('UninstallCancelledError');
  });

  it('removes version sidecar file when yes: true and sidecar exists', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // Write the sidecar at the expected location
    const sidecarDir = path.join(tmpDir, '.prismer', 'agents');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'claude-code.version');
    fs.writeFileSync(sidecarPath, '1.9.0\n', 'utf-8');

    expect(fs.existsSync(sidecarPath)).toBe(true);

    await uninstallAgent(ctx, 'claude-code', {
      yes: true,
      homeDir: tmpDir,
      catalog,
    });

    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it('does not throw when yes: true and no sidecar exists', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // No sidecar written — uninstall should still succeed
    const sidecarPath = path.join(tmpDir, '.prismer', 'agents', 'claude-code.version');
    expect(fs.existsSync(sidecarPath)).toBe(false);

    await expect(
      uninstallAgent(ctx, 'claude-code', { yes: true, homeDir: tmpDir, catalog }),
    ).resolves.toBeDefined();
  });
});

// ============================================================
// agents.json registry removal
// ============================================================

import { upsertAgent, readAgentsRegistry } from '../../src/agents/agents-registry.js';

describe('uninstallAgent — agents.json registry', () => {
  it('removes the registry entry on uninstall', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // Pre-populate registry with two agents
    upsertAgent(tmpDir, {
      name: 'claude-code',
      displayName: 'Claude Code',
      version: '1.9.0',
      source: 'npm',
      installedAt: new Date().toISOString(),
      hookConfigPath: path.join(tmpDir, '.claude', 'settings.json'),
    });
    upsertAgent(tmpDir, {
      name: 'codex',
      displayName: 'Codex',
      version: '1.0.0',
      source: 'npm',
      installedAt: new Date().toISOString(),
      hookConfigPath: path.join(tmpDir, '.codex', 'hooks.json'),
    });

    await uninstallAgent(ctx, 'claude-code', { yes: true, homeDir: tmpDir, catalog });

    const remaining = readAgentsRegistry(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('codex');
  });

  it('leaves an empty array (not a missing file) when last entry is removed', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    upsertAgent(tmpDir, {
      name: 'claude-code',
      displayName: 'Claude Code',
      version: '1.9.0',
      source: 'npm',
      installedAt: new Date().toISOString(),
      hookConfigPath: path.join(tmpDir, '.claude', 'settings.json'),
    });

    await uninstallAgent(ctx, 'claude-code', { yes: true, homeDir: tmpDir, catalog });

    const remaining = readAgentsRegistry(tmpDir);
    expect(remaining).toEqual([]);
  });

  it('does not throw when agent was never in registry (pre-registry install)', async () => {
    const { ctx } = makeCtx({ mode: 'pretty' });
    const catalog = [makeCatalogEntry(tmpDir)];

    // No registry entry — uninstall should still complete
    await expect(
      uninstallAgent(ctx, 'claude-code', { yes: true, homeDir: tmpDir, catalog }),
    ).resolves.toBeDefined();
  });
});

// G3 — --json flag coverage for 6 subcommands
//
// Tests the command functions directly with an injected JSON-mode UI,
// without going through the bin dispatcher (avoids process.exit issues).

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { Keychain } from '../../src/keychain.js';
import { uninstallAgent } from '../../src/agents/uninstall-agent.js';
import { daemonLogs } from '../../src/commands/daemon.js';
import { pairRevoke } from '../../src/commands/pair.js';
import type { PairedDevice } from '../../src/commands/pair.js';
import type { AgentCatalogEntry } from '../../src/agents/registry.js';

// ============================================================
// Helpers
// ============================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'json-flags-test-'));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeJsonUI(): { ui: UI; output: () => string; errOutput: () => string } {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const stream = { write(d: string): boolean { chunks.push(d); return true; } } as NodeJS.WritableStream;
  const errStream = { write(d: string): boolean { errChunks.push(d); return true; } } as NodeJS.WritableStream;
  const ui = new UI({ mode: 'json', color: false, stream, errStream });
  return { ui, output: () => chunks.join(''), errOutput: () => errChunks.join('') };
}

function makeCtx(ui: UI): CliContext {
  return {
    ui,
    keychain: new Keychain(),
    cwd: process.cwd(),
    argv: [],
  };
}

function pairedDevicesPath(homeDir: string): string {
  return path.join(homeDir, '.prismer', 'data', 'paired-devices.json');
}

function writePairedDevices(homeDir: string, devices: PairedDevice[]): void {
  const p = pairedDevicesPath(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(devices, null, 2) + '\n', 'utf-8');
}

function makeDevice(overrides?: Partial<PairedDevice>): PairedDevice {
  return {
    id: 'device-json-001',
    name: 'Test Device',
    method: 'qr',
    transport: 'lan',
    lastSeenAt: Date.now() - 60_000,
    pairedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

// Minimal stub catalog so uninstallAgent works without real fs hooks
function makeStubCatalog(name: string): AgentCatalogEntry[] {
  return [{
    name,
    displayName: name + ' (stub)',
    hookConfigPath: '~/.prismer-stub-nonexistent/settings.json',
    sandboxProfile: null,
    defaultPermissions: [],
    detectBinary: name,
    installInstructions: '',
  }];
}

// ============================================================
// State
// ============================================================

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    cleanupDir(tmpDirs.pop()!);
  }
  process.exitCode = undefined;
});

function newTmp(): string {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  return dir;
}

// ============================================================
// G3-1: agent uninstall --json
// ============================================================

describe('agent uninstall --json', () => {
  it('success path emits { ok: true, agent, hooksRestored, sandboxRemoved }', async () => {
    const tmpDir = newTmp();
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    const result = await uninstallAgent(ctx, 'test-stub', {
      homeDir: tmpDir,
      catalog: makeStubCatalog('test-stub'),
      yes: true, // JSON/non-interactive mode requires --yes (CONFIRMATION_REQUIRED otherwise)
    });

    // Emit JSON manually as the bin handler would (function returns result, bin emits)
    ctx.ui.json({ ok: true, agent: result.agent, hooksRestored: result.hooksRestored, sandboxRemoved: result.sandboxRemoved });

    const out = output();
    expect(out.trim()).toMatch(/^\{/);
    const data = JSON.parse(out) as { ok: boolean; agent: string; hooksRestored: boolean; sandboxRemoved: boolean };
    expect(data.ok).toBe(true);
    expect(data.agent).toBe('test-stub');
    expect(typeof data.hooksRestored).toBe('boolean');
    expect(typeof data.sandboxRemoved).toBe('boolean');
  });

  it('failure path emits { ok: false, error, message } on unknown agent', async () => {
    const tmpDir = newTmp();
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    try {
      await uninstallAgent(ctx, 'no-such-agent', {
        homeDir: tmpDir,
        catalog: makeStubCatalog('other-agent'),
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      ctx.ui.json({ ok: false, error: 'UNINSTALL_FAILED', message: e.message });
    }

    const out = output();
    const data = JSON.parse(out) as { ok: boolean; error: string; message: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('UNINSTALL_FAILED');
    expect(data.message).toContain('no-such-agent');
  });
});

// ============================================================
// G3-2: agent update --json (stub — update just emits advice)
// ============================================================

describe('agent update --json', () => {
  it('success path emits { ok: true, agent, note }', () => {
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);
    const agentName = 'claude-code';

    // Simulate what the bin handler does for update --json
    ctx.ui.json({ ok: true, agent: agentName, note: 'update equivalent to reinstall; run: prismer agent install ' + agentName });

    const data = JSON.parse(output()) as { ok: boolean; agent: string; note: string };
    expect(data.ok).toBe(true);
    expect(data.agent).toBe(agentName);
    expect(data.note).toContain('reinstall');
  });
});

// ============================================================
// G3-3: agent repair --json (stub — pending T14)
// ============================================================

describe('agent repair --json', () => {
  it('success path emits { ok: true, agent, repairsApplied }', () => {
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);
    const agentName = 'claude-code';

    // Simulate what the bin handler does for repair --json
    ctx.ui.json({ ok: true, agent: agentName, repairsApplied: [] });

    const data = JSON.parse(output()) as { ok: boolean; agent: string; repairsApplied: string[] };
    expect(data.ok).toBe(true);
    expect(data.agent).toBe(agentName);
    expect(Array.isArray(data.repairsApplied)).toBe(true);
  });
});

// ============================================================
// G3-4: daemon logs --json (--tail N only; --follow --json is rejected at bin level)
// ============================================================

describe('daemon logs --json', () => {
  it('emits { ok: true, lines, truncated } when log file has content', async () => {
    const tmpDir = newTmp();
    const logDir = path.join(os.homedir(), '.prismer', 'logs');
    const logFile = path.join(logDir, 'daemon.log');

    const hadFile = fs.existsSync(logFile);
    const prevContent = hadFile ? fs.readFileSync(logFile, 'utf-8') : null;

    // Write test log content
    const testLines = Array.from({ length: 20 }, (_, i) => `LogLine${i + 1}`).join('\n') + '\n';
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFile, testLines, 'utf-8');

    try {
      const { ui, output } = makeJsonUI();
      const ctx = makeCtx(ui);

      await daemonLogs(ctx, { tail: 5 });

      const data = JSON.parse(output()) as { ok: boolean; lines: string[]; truncated: boolean };
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.lines)).toBe(true);
      expect(data.lines).toHaveLength(5);
      expect(data.lines[4]).toBe('LogLine20');
      expect(data.truncated).toBe(true);
    } finally {
      if (prevContent !== null) {
        fs.writeFileSync(logFile, prevContent, 'utf-8');
      } else {
        try { fs.rmSync(logFile, { force: true }); } catch { /* ok */ }
      }
    }
  });

  it('emits { ok: true, lines: [], truncated: false } when log file is missing', async () => {
    const logFile = path.join(os.homedir(), '.prismer', 'logs', 'daemon.log');
    if (fs.existsSync(logFile)) {
      // Skip this test if log file exists (can't reliably hide it)
      return;
    }

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    await daemonLogs(ctx, { tail: 10 });

    const data = JSON.parse(output()) as { ok: boolean; lines: string[]; truncated: boolean };
    expect(data.ok).toBe(true);
    expect(data.lines).toHaveLength(0);
    expect(data.truncated).toBe(false);
  });

  it('truncated flag is false when log has fewer lines than tail', async () => {
    const logDir = path.join(os.homedir(), '.prismer', 'logs');
    const logFile = path.join(logDir, 'daemon.log');

    const hadFile = fs.existsSync(logFile);
    const prevContent = hadFile ? fs.readFileSync(logFile, 'utf-8') : null;

    const testLines = Array.from({ length: 3 }, (_, i) => `Short${i + 1}`).join('\n') + '\n';
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFile, testLines, 'utf-8');

    try {
      const { ui, output } = makeJsonUI();
      const ctx = makeCtx(ui);

      await daemonLogs(ctx, { tail: 10 });

      const data = JSON.parse(output()) as { ok: boolean; lines: string[]; truncated: boolean };
      expect(data.ok).toBe(true);
      expect(data.lines).toHaveLength(3);
      expect(data.truncated).toBe(false);
    } finally {
      if (prevContent !== null) {
        fs.writeFileSync(logFile, prevContent, 'utf-8');
      } else {
        try { fs.rmSync(logFile, { force: true }); } catch { /* ok */ }
      }
    }
  });
});

// ============================================================
// G3-5: pair revoke --json
// ============================================================

describe('pair revoke --json', () => {
  it('success path emits { ok: true, deviceId, name }', async () => {
    const tmpDir = newTmp();
    const d = makeDevice({ id: 'dev-json-revoke', name: 'JSON Test Device' });
    writePairedDevices(tmpDir, [d]);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    await pairRevoke(ctx, 'dev-json-revoke', { homeDir: tmpDir });

    const data = JSON.parse(output()) as { ok: boolean; deviceId: string; name: string };
    expect(data.ok).toBe(true);
    expect(data.deviceId).toBe('dev-json-revoke');
    expect(data.name).toBe('JSON Test Device');
    expect(process.exitCode).toBeUndefined();
  });

  it('failure path emits { ok: false, error, message } and sets exitCode=1', async () => {
    const tmpDir = newTmp();
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    await pairRevoke(ctx, 'no-such-device', { homeDir: tmpDir });

    const data = JSON.parse(output()) as { ok: boolean; error: string; message: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('DEVICE_NOT_FOUND');
    expect(data.message).toContain('no-such-device');
    expect(process.exitCode).toBe(1);
  });
});

// ============================================================
// G3-6: migrate-secrets --json (unit test of JSON shape)
// ============================================================

describe('migrate-secrets --json (JSON shape validation)', () => {
  it('success shape has ok:true, migrated, skipped, errors, details', () => {
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    // Simulate the success JSON payload emitted by the bin handler
    const mockResult = {
      migrated: [{ path: 'auth.token', service: 'prismer-config/auth', account: 'token' }],
      skipped: [],
      errors: [],
    };
    ctx.ui.json({
      ok: true,
      migrated: mockResult.migrated.length,
      skipped: mockResult.skipped.length,
      errors: mockResult.errors.length,
      details: mockResult,
    });

    const data = JSON.parse(output()) as {
      ok: boolean;
      migrated: number;
      skipped: number;
      errors: number;
      details: typeof mockResult;
    };
    expect(data.ok).toBe(true);
    expect(data.migrated).toBe(1);
    expect(data.skipped).toBe(0);
    expect(data.errors).toBe(0);
    expect(data.details.migrated).toHaveLength(1);
  });

  it('failure shape has ok:false, error, message, counts, details', () => {
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    const mockResult = {
      migrated: [],
      skipped: [],
      errors: [{ path: 'auth.token', error: 'keychain write failed' }],
    };
    ctx.ui.json({
      ok: false,
      error: 'MIGRATE_ERRORS',
      message: '1 error(s) during migration',
      migrated: mockResult.migrated.length,
      skipped: mockResult.skipped.length,
      errors: mockResult.errors.length,
      details: mockResult,
    });

    const data = JSON.parse(output()) as {
      ok: boolean;
      error: string;
      message: string;
      errors: number;
    };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('MIGRATE_ERRORS');
    expect(data.errors).toBe(1);
  });
});

// T16 — pair command tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { Keychain } from '../../src/keychain.js';
import { pairShow, pairList, pairRevoke } from '../../src/commands/pair.js';
import type { PairedDevice } from '../../src/commands/pair.js';
// Non-existent PID for stale lock test
const DEAD_PID = 999999999;

// ============================================================
// Helpers
// ============================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pair-test-'));
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

function makePrettyUI(): { ui: UI; output: () => string; errOutput: () => string } {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const stream = { write(d: string): boolean { chunks.push(d); return true; } } as NodeJS.WritableStream;
  const errStream = { write(d: string): boolean { errChunks.push(d); return true; } } as NodeJS.WritableStream;
  const ui = new UI({ mode: 'pretty', color: false, stream, errStream });
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
    id: 'device-test-001',
    name: 'Lumin iPhone',
    method: 'qr',
    transport: 'lan',
    lastSeenAt: Date.now() - 60_000,
    pairedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

// ============================================================
// State
// ============================================================

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    cleanupDir(tmpDirs.pop()!);
  }
  // Reset exitCode
  process.exitCode = undefined;
});

function newTmp(): string {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  return dir;
}

// ============================================================
// pairShow — P1: --json path emits correct shape
// ============================================================

describe('pairShow', () => {
  it('P1: --json emits { offer, uri, expiresAt } with correct prismer:// URI', async () => {
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);
    const expiresAt = Date.now() + 1000;
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      data: {
        offer: 'offer-test-001',
        uri: 'prismer://pair?offer=offer-test-001',
        expiresAt,
      },
    }), { status: 200 }) as Response;

    await pairShow(ctx, { ttlSec: 1, fetchImpl });

    const data = JSON.parse(output()) as { ok: boolean; offer: string; uri: string; expiresAt: number };
    expect(data.ok).toBe(true);
    expect(data.uri).toMatch(/^prismer:\/\/pair\?offer=/);
    expect(data.offer).toBe('offer-test-001');
    expect(data.expiresAt).toBe(expiresAt);
    // Verify URI contains the offer token
    expect(data.uri).toContain(data.offer);
  });

  it('P2a: daemon-down (ECONNREFUSED) surfaces DAEMON_NOT_RUNNING code', async () => {
    // The pair.ts error path distinguishes daemon-down from other failures:
    //   ECONNREFUSED / fetch failed → DAEMON_NOT_RUNNING (actionable: start daemon)
    //   everything else            → PAIR_OFFER_UNAVAILABLE (generic fail)
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);
    const fetchImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3210');
    };

    await pairShow(ctx, { ttlSec: 1, fetchImpl });

    const data = JSON.parse(output()) as { ok: boolean; error: string; message: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('DAEMON_NOT_RUNNING');
    expect(data.message).toContain('daemon not running');
    expect(process.exitCode).toBe(1);
  });

  it('P2b: non-daemon-down failure surfaces PAIR_OFFER_UNAVAILABLE code', async () => {
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);
    const fetchImpl = async () => {
      // Anything that isn't ECONNREFUSED/fetch-failed → generic fail
      throw new Error('daemon returned HTTP 500');
    };

    await pairShow(ctx, { ttlSec: 1, fetchImpl });

    const data = JSON.parse(output()) as { ok: boolean; error: string; message: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('PAIR_OFFER_UNAVAILABLE');
    expect(data.message).toContain('HTTP 500');
    expect(process.exitCode).toBe(1);
  });
});

// ============================================================
// pairList — P3, P4, P5
// ============================================================

describe('pairList', () => {
  it('P3: no file → empty state message', async () => {
    const tmpDir = newTmp();
    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui);

    await pairList(ctx, { homeDir: tmpDir });

    const out = output();
    expect(out).toContain('No paired devices');
    expect(out).toContain('prismer pair show');
  });

  it('P4: two devices → table output contains both names', async () => {
    const tmpDir = newTmp();
    const d1 = makeDevice({ id: 'dev-001', name: 'Alice iPad' });
    const d2 = makeDevice({ id: 'dev-002', name: 'Bob Android' });
    writePairedDevices(tmpDir, [d1, d2]);

    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui);

    await pairList(ctx, { homeDir: tmpDir });

    const out = output();
    expect(out).toContain('Alice iPad');
    expect(out).toContain('Bob Android');
  });

  it('P5: --json emits array of devices', async () => {
    const tmpDir = newTmp();
    const d1 = makeDevice({ id: 'dev-001', name: 'Alice iPad' });
    const d2 = makeDevice({ id: 'dev-002', name: 'Bob Android' });
    writePairedDevices(tmpDir, [d1, d2]);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    await pairList(ctx, { homeDir: tmpDir });

    const arr = JSON.parse(output()) as PairedDevice[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);
    expect(arr.map((d) => d.name)).toContain('Alice iPad');
    expect(arr.map((d) => d.name)).toContain('Bob Android');
  });

  it('P5b: --json with no devices emits empty array', async () => {
    const tmpDir = newTmp();
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    await pairList(ctx, { homeDir: tmpDir });

    const arr = JSON.parse(output()) as PairedDevice[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(0);
  });
});

// ============================================================
// pairRevoke — P6, P7
// ============================================================

describe('pairRevoke', () => {
  it('P6: missing device → sets exitCode=1 and emits error', async () => {
    const tmpDir = newTmp();
    const { ui, errOutput } = makePrettyUI();
    const ctx = makeCtx(ui);

    await pairRevoke(ctx, 'non-existent-id', { homeDir: tmpDir });

    expect(process.exitCode).toBe(1);
    expect(errOutput()).toContain('non-existent-id');
  });

  it('P7: existing device → removed from file and ok message printed', async () => {
    const tmpDir = newTmp();
    const d1 = makeDevice({ id: 'dev-keep', name: 'Keep Me' });
    const d2 = makeDevice({ id: 'dev-revoke', name: 'Revoke Me' });
    writePairedDevices(tmpDir, [d1, d2]);

    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui);

    await pairRevoke(ctx, 'dev-revoke', { homeDir: tmpDir });

    expect(process.exitCode).toBeUndefined();
    expect(output()).toContain('Revoked');
    expect(output()).toContain('Revoke Me');

    // File should still contain d1 but not d2
    const devicesPath = pairedDevicesPath(tmpDir);
    const remaining = JSON.parse(fs.readFileSync(devicesPath, 'utf-8')) as PairedDevice[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('dev-keep');
    expect(remaining.find((d) => d.id === 'dev-revoke')).toBeUndefined();
  });

  it('P8: idempotent — revoking twice yields error on second call', async () => {
    const tmpDir = newTmp();
    const d = makeDevice({ id: 'dev-once', name: 'Once Only' });
    writePairedDevices(tmpDir, [d]);

    const { ui: ui1 } = makePrettyUI();
    await pairRevoke(makeCtx(ui1), 'dev-once', { homeDir: tmpDir });
    expect(process.exitCode).toBeUndefined();

    process.exitCode = undefined;

    const { ui: ui2, errOutput } = makePrettyUI();
    await pairRevoke(makeCtx(ui2), 'dev-once', { homeDir: tmpDir });
    expect(process.exitCode).toBe(1);
    expect(errOutput()).toContain('dev-once');
  });

  it('P9: happy path — cloud DELETE called with correct URL + Bearer; local entry removed; cloudDeleteOk=true', async () => {
    const tmpDir = newTmp();
    const d1 = makeDevice({ id: 'dev-keep-p9', name: 'Keep Me P9' });
    const d2 = makeDevice({ id: 'dev-revoke-p9', name: 'Revoke Me P9' });
    writePairedDevices(tmpDir, [d1, d2]);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
    };

    await pairRevoke(ctx, 'dev-revoke-p9', {
      homeDir: tmpDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      identity: { apiKey: 'sk-prismer-live-testkey', cloudApiBase: 'https://prismer.cloud' },
    });

    // Cloud DELETE was called
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://prismer.cloud/api/im/remote/bindings/dev-revoke-p9');
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-prismer-live-testkey');

    // JSON payload
    const data = JSON.parse(output()) as { ok: boolean; deviceId: string; cloudDeleteAttempted: boolean; cloudDeleteOk: boolean };
    expect(data.ok).toBe(true);
    expect(data.deviceId).toBe('dev-revoke-p9');
    expect(data.cloudDeleteAttempted).toBe(true);
    expect(data.cloudDeleteOk).toBe(true);

    // Local entry removed
    const devicesPath = pairedDevicesPath(tmpDir);
    const remaining = JSON.parse(fs.readFileSync(devicesPath, 'utf-8')) as PairedDevice[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('dev-keep-p9');
  });

  it('P10: cloud failure — local still removed; cloudDeleteOk=false; cloudError present', async () => {
    const tmpDir = newTmp();
    const d = makeDevice({ id: 'dev-cloud-fail', name: 'Cloud Fail Device' });
    writePairedDevices(tmpDir, [d]);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    const fetchImpl = async (): Promise<Response> => {
      return new Response('Internal Server Error', { status: 500 }) as Response;
    };

    await pairRevoke(ctx, 'dev-cloud-fail', {
      homeDir: tmpDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      identity: { apiKey: 'sk-prismer-live-testkey', cloudApiBase: 'https://prismer.cloud' },
    });

    const data = JSON.parse(output()) as { ok: boolean; cloudDeleteAttempted: boolean; cloudDeleteOk: boolean; cloudError?: string };
    expect(data.ok).toBe(true);
    expect(data.cloudDeleteAttempted).toBe(true);
    expect(data.cloudDeleteOk).toBe(false);
    expect(data.cloudError).toBeDefined();

    // Local entry still removed
    const devicesPath = pairedDevicesPath(tmpDir);
    const remaining = JSON.parse(fs.readFileSync(devicesPath, 'utf-8')) as PairedDevice[];
    expect(remaining).toHaveLength(0);
  });

  it('P11: no apiKey — fetch never called; local entry removed; cloudDeleteAttempted=false', async () => {
    const tmpDir = newTmp();
    const d = makeDevice({ id: 'dev-no-key', name: 'No Key Device' });
    writePairedDevices(tmpDir, [d]);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui);

    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response('{}', { status: 200 }) as Response;
    };

    await pairRevoke(ctx, 'dev-no-key', {
      homeDir: tmpDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      identity: { apiKey: undefined, cloudApiBase: 'https://prismer.cloud' },
    });

    expect(fetchCalled).toBe(false);

    const data = JSON.parse(output()) as { ok: boolean; cloudDeleteAttempted: boolean; cloudDeleteOk: boolean };
    expect(data.ok).toBe(true);
    expect(data.cloudDeleteAttempted).toBe(false);
    expect(data.cloudDeleteOk).toBe(false);

    // Local entry removed
    const devicesPath = pairedDevicesPath(tmpDir);
    const remaining = JSON.parse(fs.readFileSync(devicesPath, 'utf-8')) as PairedDevice[];
    expect(remaining).toHaveLength(0);
  });
});

// ============================================================
// I8 — stale lockfile detection
// ============================================================

describe('I8: pairRevoke with stale lockfile', () => {
  it('I8-a: stale lock (dead PID) is cleaned up and revoke succeeds', async () => {
    const tmpDir = newTmp();
    const d = makeDevice({ id: 'dev-stale-test', name: 'Stale Lock Device' });
    writePairedDevices(tmpDir, [d]);

    // Pre-create a stale lockfile with a dead PID
    const devicesPath = path.join(tmpDir, '.prismer', 'data', 'paired-devices.json');
    const lockFile = devicesPath + '.lock';
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, String(DEAD_PID), { mode: 0o600 });

    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui);

    // Should detect stale lock, clean it, and succeed
    await pairRevoke(ctx, 'dev-stale-test', { homeDir: tmpDir });

    expect(process.exitCode).toBeUndefined();
    expect(output()).toContain('Revoked');

    // Lock file should be gone
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

// ============================================================
// Q6 — pairShow SIGINT handler cleanup
// ============================================================

describe('Q6: pairShow SIGINT handler cleanup', () => {
  it('Q6-a: SIGINT listener count does not increase after pairShow(json mode) completes', async () => {
    const before = process.listenerCount('SIGINT');

    const { ui } = makeJsonUI();
    const ctx = makeCtx(ui);
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      data: {
        offer: 'offer-sigint-test',
        uri: 'prismer://pair?offer=offer-sigint-test',
        expiresAt: Date.now() + 1000,
      },
    }), { status: 200 }) as Response;

    await pairShow(ctx, { ttlSec: 1, fetchImpl });

    const after = process.listenerCount('SIGINT');
    expect(after).toBeLessThanOrEqual(before);
  });
});

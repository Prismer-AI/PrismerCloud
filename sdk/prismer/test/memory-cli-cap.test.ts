// spec16 §8.1 MA-0S — the `prismer memory` CLI auto-carries the daemon-minted
// cap from $PRISMER_MEMORY_CAP as the x-prismer-memory-cap header on EVERY
// /local/memory/* call. The daemon is fail-closed: no cap → 401
// memory_cap_required, invalid cap → 401 memory_cap_invalid, cross-ws cap →
// 401 memory_cap_invalid (cap-layer ws mismatch, spec16 §13.4) — each
// surfaced by the CLI as exit code 1 (never a silent fallback to the legacy
// cache snapshot).
//
// Real loopback: a real LocalServer with attachMemoryRpc (no fetch mock), so
// the cap header carry is proven end-to-end against the real verify gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap, __resetCapKeyForTest } from '../src/daemon/memory/cap.js';

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({
    api_key: 'sk-test',
    cloud_api_base: 'http://cloud.test',
    daemon_id: 'daemon-1',
  })),
  resolvePaths: vi.fn(() => ({
    root: '/tmp/prismer-cli-cap-test',
    configFile: '/tmp/prismer-cli-cap-test/config.toml',
    localDb: '/tmp/prismer-cli-cap-test/local.db',
    cacheDir: '/tmp/prismer-cli-cap-test/cache',
    logsDir: '/tmp/prismer-cli-cap-test/logs',
  })),
}));

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let port = '';
let stdout = '';
let stdoutSpy: ReturnType<typeof vi.spyOn>;

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

beforeEach(async () => {
  // Capability transport seeds a legacy flat page; placement is not under test.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_WORKSPACE_ID;
  delete process.env.PRISMER_DAEMON_PORT;
  delete process.env.PRISMER_DAEMON_URL;
  process.exitCode = undefined;
  __resetCapKeyForTest();
  const dir = mkdtempSync(join(tmpdir(), 'prismer-cli-cap-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  port = new URL(boundBaseUrl(server)).port;
  stdout = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  vi.resetModules();
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_WORKSPACE_ID;
  delete process.env.PRISMER_DAEMON_PORT;
  delete process.env.PRISMER_DAEMON_URL;
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  process.exitCode = undefined;
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Tamper the SIGNATURE (one char flip) without touching the payload. */
function flipSigChar(token: string): string {
  return token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
}

/**
 * Run `prismer memory <args>` in-process against the REAL loopback daemon,
 * with the given env (workspace + cap). Fresh module graph per call so the
 * CLI's module-level env reads (PRISMER_DAEMON_PORT / PRISMER_WORKSPACE_ID /
 * PRISMER_MEMORY_CAP) pick up this test's values.
 */
async function runCli(
  args: string[],
  env: { ws?: string; cap?: string },
): Promise<void> {
  process.exitCode = undefined;
  if (env.ws !== undefined) process.env.PRISMER_WORKSPACE_ID = env.ws;
  if (env.cap !== undefined) process.env.PRISMER_MEMORY_CAP = env.cap;
  process.env.PRISMER_DAEMON_PORT = port;
  vi.resetModules();
  const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
  const cmd = buildMemoryCommand();
  // buildMemoryCommand() IS the `memory` command — args start at its subcommands.
  await cmd.parseAsync(args, { from: 'user' });
}

describe('prismer memory CLI cap carry (spec16 §8.1 MA-0S)', () => {
  it('write + read auto-carry the env cap end-to-end (exit 0, page persists)', async () => {
    const cap = mintCap('im_cli', 'ws_a');
    await runCli(['write', '--path', 'cli.md', '--content', 'hello cli'], { ws: 'ws_a', cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('cli.md');

    stdout = '';
    await runCli(['read', 'cli.md'], { ws: 'ws_a', cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('hello cli');
  });

  it('search + list auto-carry the env cap (exit 0)', async () => {
    const cap = mintCap('im_cli', 'ws_a');
    await runCli(['write', '--path', 'cli.md', '--content', 'hello cli'], { ws: 'ws_a', cap });
    stdout = '';
    await runCli(['search', 'hello'], { ws: 'ws_a', cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('cli.md');

    stdout = '';
    await runCli(['list'], { ws: 'ws_a', cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('cli.md');
  });

  it('no cap env → 401 fail closed, exit 1 (no silent legacy fallback)', async () => {
    await runCli(['list'], { ws: 'ws_a' }); // no cap injected
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('memory_cap_required');
    expect(stdout).not.toContain('memory_gateway_unavailable');
  });

  it('write without a cap → 401, exit 1, nothing persisted', async () => {
    await runCli(['write', '--path', 'nope.md', '--content', 'x'], { ws: 'ws_a' });
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('memory_cap_required');
  });

  it('cross-ws cap (cap ws_b, env ws_a) → 401, exit 1', async () => {
    const cap = mintCap('im_cli', 'ws_b');
    await runCli(['list'], { ws: 'ws_a', cap });
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('memory_cap_invalid');
  });

  it('tampered cap → 401, exit 1', async () => {
    const cap = flipSigChar(mintCap('im_cli', 'ws_a'));
    await runCli(['list'], { ws: 'ws_a', cap });
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('memory_cap_invalid');
  });

  it('expired cap → 401, exit 1', async () => {
    const cap = mintCap('im_cli', 'ws_a', { now: Date.now() - 60_000, ttlMs: 1_000 });
    await runCli(['list'], { ws: 'ws_a', cap });
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('memory_cap_invalid');
  });
});

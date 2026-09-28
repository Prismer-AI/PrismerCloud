// memory211/01 §6.11 D11-2 (W7 item 3) — the CLI batch faces.
//
//   prismer memory search --queries '["a","b"]'   → one call, ≤8 queries, the
//                                                   daemon's resultsByQuery groups
//   prismer memory load-batch <path1> <path2> …   → ≤10 point loads, per-path
//                                                   verdicts (SKILL STAGE 3's
//                                                   "children → batch read")
//
// D11-2 measured the CLI as the recall surface with NO batch entry point
// (grep: 16 subcommands, none batch). End-to-end here means a REAL loopback
// daemon (LocalServer + attachMemoryRpc) answering the real CLI module graph —
// not a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';

const CLI_CONFIG_MOCK = {
  loadConfig: () => ({ api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' }),
  resolvePaths: () => ({
    root: '/tmp/prismer-cli-batch-test',
    configFile: '/tmp/prismer-cli-batch-test/config.toml',
    localDb: '/tmp/prismer-cli-batch-test/local.db',
    cacheDir: '/tmp/prismer-cli-batch-test/cache',
    logsDir: '/tmp/prismer-cli-batch-test/logs',
  }),
};

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let port = '';
let stdout = '';
let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined;

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
  // Placement is not under test here; keep the legacy flat-write posture.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  vi.resetModules();
  vi.doMock('../src/config.js', () => CLI_CONFIG_MOCK);
  process.exitCode = undefined;
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_WORKSPACE_ID;
  delete process.env.PRISMER_DAEMON_PORT;
  delete process.env.PRISMER_DAEMON_URL;
  stdout = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
  const dir = mkdtempSync(join(tmpdir(), 'prismer-cli-batch-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  port = new URL(boundBaseUrl(server)).port;
});

afterEach(async () => {
  stdoutSpy?.mockRestore();
  vi.resetModules();
  vi.doUnmock('../src/config.js');
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

async function seedPage(ws: string, cap: string, path: string, content: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/local/memory/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
    body: JSON.stringify({
      workspaceId: ws,
      path,
      content,
      pageType: 'hub',
      title: path,
      actorImUserId: 'im_seeder',
      actorKind: 'human',
    }),
  });
  expect(res.status).toBe(200);
}

async function runCli(args: string[], ws: string, cap: string): Promise<void> {
  process.exitCode = undefined;
  process.env.PRISMER_WORKSPACE_ID = ws;
  process.env.PRISMER_MEMORY_CAP = cap;
  process.env.PRISMER_DAEMON_PORT = port;
  vi.resetModules();
  const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
  await buildMemoryCommand().parseAsync(args, { from: 'user' });
}

describe('prismer memory batch faces (W7 item 3, D11-2)', () => {
  it('search --queries answers N queries in ONE call (resultsByQuery) end-to-end', async () => {
    const ws = 'ws_cli_batch';
    const cap = mintCap('im_cli', ws);
    await seedPage(ws, cap, 'aurora/index.md', '# aurora\n\nquorum rings order by lease age.');
    await seedPage(ws, cap, 'telemetry/index.md', '# telemetry\n\nsampling tiers keep cardinality bounded.');
    stdout = '';

    await runCli(['search', '--queries', '["quorum rings","sampling tiers"]'], ws, cap);
    expect(process.exitCode ?? 0).toBe(0);

    const printed = JSON.parse(stdout) as {
      ok: boolean;
      data?: {
        resultsByQuery?: Array<{ query: string; results: Array<{ path: string }> }>;
        results?: unknown[];
      };
    };
    expect(printed.ok).toBe(true);
    const groups = printed.data?.resultsByQuery ?? [];
    expect(groups.map((g) => g.query)).toEqual(['quorum rings', 'sampling tiers']);
    expect(groups[0]?.results.map((r) => r.path)).toContain('aurora/index.md');
    expect(groups[1]?.results.map((r) => r.path)).toContain('telemetry/index.md');
  });

  it('search --queries passes the list through: the daemon owns the ≤8 bound and its truncated flag', async () => {
    const ws = 'ws_cli_batch_cap';
    const cap = mintCap('im_cli', ws);
    await seedPage(ws, cap, 'INDEX.md', '# index\n\n- aurora/index.md');
    stdout = '';

    const ten = JSON.stringify(Array.from({ length: 10 }, (_, i) => `query${i}`));
    await runCli(['search', '--queries', ten], ws, cap);
    expect(process.exitCode ?? 0).toBe(0);

    const printed = JSON.parse(stdout) as {
      data?: { resultsByQuery?: Array<{ query: string }>; truncated?: boolean };
    };
    // The CLI does NOT pre-slice: the daemon cuts to its MAX_BATCH_QUERIES (8)
    // and flags the cut, so the agent sees that queries 9-10 were dropped
    // instead of silently losing them client-side.
    expect(printed.data?.resultsByQuery?.map((g) => g.query)).toEqual(
      Array.from({ length: 8 }, (_, i) => `query${i}`),
    );
    expect(printed.data?.truncated).toBe(true);
  });

  it('search --queries rejects a malformed payload with exit 1 (usage error, not a silent single query)', async () => {
    const ws = 'ws_cli_batch_bad';
    const cap = mintCap('im_cli', ws);
    stdout = '';
    await runCli(['search', '--queries', 'not-json'], ws, cap);
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('invalid_queries');
  });

  it('load-batch reads several pages in one call with per-path verdicts', async () => {
    const ws = 'ws_cli_loadbatch';
    const cap = mintCap('im_cli', ws);
    await seedPage(ws, cap, 'aurora/index.md', 'aurora body');
    await seedPage(ws, cap, 'telemetry/index.md', 'telemetry body');
    stdout = '';

    await runCli(['load-batch', 'aurora/index.md', 'telemetry/index.md'], ws, cap);
    expect(process.exitCode ?? 0).toBe(0);

    const printed = JSON.parse(stdout) as {
      ok: boolean;
      data?: { loaded: number; requested: number; results: Array<{ path: string; ok: boolean }> };
    };
    expect(printed.ok).toBe(true);
    expect(printed.data?.loaded).toBe(2);
    expect(printed.data?.requested).toBe(2);
    expect(printed.data?.results.map((r) => r.path)).toEqual([
      'aurora/index.md',
      'telemetry/index.md',
    ]);
    expect(printed.data?.results.every((r) => r.ok)).toBe(true);
  });

  it('load-batch reports a missing page per path (partial miss stays exit 0), a total miss exits 1', async () => {
    const ws = 'ws_cli_loadbatch_partial';
    const cap = mintCap('im_cli', ws);
    await seedPage(ws, cap, 'aurora/index.md', 'aurora body');
    stdout = '';

    await runCli(['load-batch', 'aurora/index.md', 'aurora/missing.md'], ws, cap);
    expect(process.exitCode ?? 0).toBe(0);
    const partial = JSON.parse(stdout) as {
      ok: boolean;
      data?: { loaded: number; results: Array<{ path: string; ok: boolean; error?: string }> };
    };
    expect(partial.data?.loaded).toBe(1);
    expect(partial.data?.results.find((r) => r.path === 'aurora/missing.md')).toMatchObject({
      ok: false,
      error: 'memory_page_not_found',
    });

    stdout = '';
    await runCli(['load-batch', 'aurora/missing.md'], ws, cap);
    expect(process.exitCode).toBe(1);
    const total = JSON.parse(stdout) as { ok: boolean };
    expect(total.ok).toBe(false);
  });

  it('load-batch caps the fan-out at 10 paths and reports what it dropped', async () => {
    const ws = 'ws_cli_loadbatch_cap';
    const cap = mintCap('im_cli', ws);
    await seedPage(ws, cap, 'INDEX.md', 'index body');
    stdout = '';

    // 12 paths where exactly one exists ⇒ the call still loads something, so
    // the cap (not a total miss) is what this assertion exercises.
    const twelve = ['INDEX.md', ...Array.from({ length: 11 }, (_, i) => `p${i}.md`)];
    await runCli(['load-batch', ...twelve], ws, cap);
    expect(process.exitCode ?? 0).toBe(0);
    const printed = JSON.parse(stdout) as {
      ok: boolean;
      data?: { requested: number; dropped?: number; results: Array<{ path: string; ok: boolean }> };
    };
    expect(printed.ok).toBe(true);
    expect(printed.data?.requested).toBe(10);
    expect(printed.data?.dropped).toBe(2);
    expect(printed.data?.results.length).toBe(10);
    expect(printed.data?.results.find((r) => r.path === 'INDEX.md')?.ok).toBe(true);
  });
});

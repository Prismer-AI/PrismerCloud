// memory211/01 §6.11 D11-1 (W7 item 2) — CLI recall telemetry.
//
// Before W7 `prismer memory recall/search` was the one recall surface with no
// observability at all (grep: this CLI had zero recall_pull/metric references),
// so the frontier clustering input and the M1 adoption aggregate never saw the
// CLI channel. Now every CLI recall enqueues ONE `recall_pull` into the SAME
// outbox channel the daemon uses, via the existing
// `POST /local/memory/observability/emit` pass-through, carrying
// `metadataJson.via = 'cli'`.
//
// Real loopback throughout (no fetch mock): a real LocalServer +
// attachMemoryRpc, and the real CLI module graph driven in-process so the
// module-level env reads ($PRISMER_DAEMON_PORT / $PRISMER_WORKSPACE_ID /
// $PRISMER_MEMORY_CAP) pick up this test's daemon.
//
// Acceptance (spec §6.11 item 2): the recall_pull row must APPEAR on a CLI
// recall and must NOT appear when the emit is intercepted. The negative control
// here is a REAL interception — a daemon whose observability/emit route answers
// 500 — after which the outbox holds no new recall_pull row ("拦截 emit 后行数
// 不增") while the recall itself still succeeds (telemetry is 旁路, never a
// failure mode for the recall it observed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';

const CLI_CONFIG_MOCK = {
  loadConfig: () => ({
    api_key: 'sk-test',
    cloud_api_base: 'http://cloud.test',
    daemon_id: 'daemon-1',
  }),
  resolvePaths: () => ({
    root: '/tmp/prismer-cli-telemetry-test',
    configFile: '/tmp/prismer-cli-telemetry-test/config.toml',
    localDb: '/tmp/prismer-cli-telemetry-test/local.db',
    cacheDir: '/tmp/prismer-cli-telemetry-test/cache',
    logsDir: '/tmp/prismer-cli-telemetry-test/logs',
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

interface Started {
  baseUrl: string;
}

/**
 * Boot the daemon. `blockEmit` intercepts ONLY the observability/emit route
 * (500) — the negative control's "拦截 emit" — while every other memory route
 * behaves normally.
 */
async function startDaemon(blockEmit: boolean): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-cli-telemetry-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  const inner = attachMemoryRpc({ runtime });
  const handler = blockEmit
    ? async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        if ((req.url ?? '').startsWith('/local/memory/observability/emit')) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'emit_intercepted' }));
          return true;
        }
        return inner(req, res);
      }
    : inner;
  server = new LocalServer({ port: 0, getState: () => baseState, attachMemory: handler });
  await server.start();
  port = new URL(boundBaseUrl(server)).port;
  return { baseUrl: boundBaseUrl(server) };
}

async function seedOnePage(ws: string, cap: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/local/memory/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
    body: JSON.stringify({
      workspaceId: ws,
      path: 'notes/telemetry.md',
      content: 'hello telemetry',
      pageType: 'hub',
      title: 'telemetry',
      actorImUserId: 'im_seeder',
      actorKind: 'human',
    }),
  });
  expect(res.status).toBe(200);
}

/** recall_pull rows currently pending in the workspace outbox. */
function recallPullRows(ws: string): Array<Record<string, unknown>> {
  const slot = runtime!.peek(ws);
  if (!slot) return [];
  const db = slot.store.rawDb();
  const rows = db
    .prepare(
      "SELECT envelopeJson FROM memory_outbox WHERE eventType = 'recall_pull' ORDER BY createdAt",
    )
    .all() as Array<{ envelopeJson: string }>;
  return rows.map((r) => JSON.parse(r.envelopeJson) as Record<string, unknown>);
}

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

async function runCli(args: string[], env: { ws: string; cap: string }): Promise<void> {
  process.exitCode = undefined;
  process.env.PRISMER_WORKSPACE_ID = env.ws;
  process.env.PRISMER_MEMORY_CAP = env.cap;
  process.env.PRISMER_DAEMON_PORT = port;
  vi.resetModules();
  const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
  await buildMemoryCommand().parseAsync(args, { from: 'user' });
}

describe('prismer memory CLI recall_pull telemetry (W7 item 2, D11-1)', () => {
  it('`memory recall` lands one recall_pull row with via=cli + the cap subject as actor', async () => {
    await startDaemon(false);
    const ws = 'ws_cli_tel';
    const cap = mintCap('im_cli_agent', ws);
    await seedOnePage(ws, cap);

    await runCli(['recall', 'telemetry'], { ws, cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('notes/telemetry.md');

    const rows = recallPullRows(ws);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row['eventType']).toBe('recall_pull');
    expect(row['actorImUserId']).toBe('im_cli_agent');
    expect(row['query']).toBe('telemetry');
    expect(row['metadataJson']).toMatchObject({ tool: 'memory_search', via: 'cli' });
    expect(row['metricsJson']).toMatchObject({ hitCount: 1, topK: 8 });
    expect(String(row['idempotencyKey'])).toContain('im_cli_agent');
  });

  it('`memory search` emits the same row (both CLI recall faces are covered)', async () => {
    await startDaemon(false);
    const ws = 'ws_cli_tel2';
    const cap = mintCap('im_cli_agent', ws);
    await seedOnePage(ws, cap);

    await runCli(['search', 'telemetry'], { ws, cap });
    expect(process.exitCode ?? 0).toBe(0);

    const rows = recallPullRows(ws);
    expect(rows.length).toBe(1);
    expect(rows[0]!['metadataJson']).toMatchObject({ tool: 'memory_search', via: 'cli' });
  });

  it('NEGATIVE CONTROL — intercepting the emit leaves the outbox with no new recall_pull row', async () => {
    await startDaemon(true);
    const ws = 'ws_cli_blocked';
    const cap = mintCap('im_cli_agent', ws);
    await seedOnePage(ws, cap);
    expect(recallPullRows(ws).length).toBe(0);

    // The recall still succeeds — telemetry must never become a failure mode.
    stdout = '';
    await runCli(['recall', 'telemetry'], { ws, cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('notes/telemetry.md');

    expect(recallPullRows(ws).length).toBe(0);
  });

  it('CONTROL — a non-recall CLI command (`list`) emits no recall_pull row', async () => {
    await startDaemon(false);
    const ws = 'ws_cli_noactor';
    const cap = mintCap('im_seeder', ws);
    await seedOnePage(ws, cap);

    await runCli(['list'], { ws, cap });
    expect(process.exitCode ?? 0).toBe(0);
    expect(recallPullRows(ws).length).toBe(0);
  });
});

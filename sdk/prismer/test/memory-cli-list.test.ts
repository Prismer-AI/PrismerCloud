// memory203/18 W4 — CLI gateway-detection fix (W2-gate item 3 FAIL).
// `prismer memory list` in an agent pod (no --workspace-id flag; identity comes
// from $PRISMER_WORKSPACE_ID) never even TRIED the modern /local/memory/list
// route — it only probed the legacy /memory/list + /api/memory/list paths,
// both 404 on a phase-0 daemon, and reported `memory_gateway_unavailable`
// against a live RPC. Every other subcommand (search/read/recall/write)
// already fell back to ENV_WS; list was the odd one out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({
    api_key: 'sk-test',
    cloud_api_base: 'http://cloud.test',
    daemon_id: 'daemon-1',
  })),
  resolvePaths: vi.fn(() => ({
    root: '/tmp/prismer-w4-test',
    configFile: '/tmp/prismer-w4-test/config.toml',
    localDb: '/tmp/prismer-w4-test/local.db',
    cacheDir: '/tmp/prismer-w4-test/cache',
    logsDir: '/tmp/prismer-w4-test/logs',
  })),
}));

describe('prismer memory list — pod env workspace fallback (memory203/18 W4)', () => {
  const origFetch = globalThis.fetch;
  let stdout = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    stdout = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    globalThis.fetch = origFetch;
    delete process.env.PRISMER_WORKSPACE_ID;
    delete process.env.PRISMER_DAEMON_PORT;
    process.exitCode = undefined;
  });

  it('with only $PRISMER_WORKSPACE_ID set, hits /local/memory/list FIRST and succeeds', async () => {
    process.env.PRISMER_WORKSPACE_ID = 'ws_pod';
    process.env.PRISMER_DAEMON_PORT = '7878';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/local/memory/list')) {
        return new Response(
          JSON.stringify({ ok: true, data: { pages: [{ path: 'memory/INDEX.pkf', pageType: 'hub' }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Legacy /memory/list + /api/memory/list are 404 on a phase-0 daemon.
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
    const cmd = buildMemoryCommand();
    await cmd.parseAsync(['list', '--page-type', 'hub'], { from: 'user' });

    // The modern route is tried FIRST, scoped to the pod's env workspace —
    // pre-fix, calls[0] was the legacy /memory/list (404) and the command
    // ended in memory_gateway_unavailable.
    expect(calls[0]).toContain('http://127.0.0.1:7878/local/memory/list?');
    expect(calls[0]).toContain('workspaceId=ws_pod');
    expect(calls[0]).toContain('pageType=hub');
    expect(stdout).toContain('INDEX.pkf');
    expect(stdout).not.toContain('memory_gateway_unavailable');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('explicit --workspace-id still wins over the env fallback', async () => {
    process.env.PRISMER_WORKSPACE_ID = 'ws_env';
    process.env.PRISMER_DAEMON_PORT = '7878';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, data: { pages: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
    const cmd = buildMemoryCommand();
    await cmd.parseAsync(['list', '--workspace-id', 'ws_flag'], { from: 'user' });

    expect(calls[0]).toContain('workspaceId=ws_flag');
    expect(calls[0]).not.toContain('ws_env');
  });
});

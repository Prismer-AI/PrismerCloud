// memory211/01 §6.9 裁决 5 (掉账 ②) — `prismer memory ingest` smoke.
//
// The ingest kill switch is a CLOUD setting (the ingest queue is cloud-side), so
// unlike every other `memory` subcommand this one leaves the daemon loopback and
// POSTes the cloud `/api/im/memory/ingest-settings` route. The suite pins the
// CLI face of that contract: the request shape it sends, the flag-conflict and
// no-workspace guards, and the exit code on a refused (403) toggle.
//
// The cloud route itself (merge-safety, owner/admin gate, 422 shape) is pinned
// server-side by src/im/tests/acp-memory-ingest-settings.test.ts — that is the
// cloud repo's surface, not this package's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({
    api_key: 'sk-test',
    cloud_api_base: 'http://cloud.test',
    daemon_id: 'daemon-1',
  })),
  resolvePaths: vi.fn(() => ({
    root: '/tmp/prismer-cli-ingest-test',
    configFile: '/tmp/prismer-cli-ingest-test/config.toml',
    localDb: '/tmp/prismer-cli-ingest-test/local.db',
    cacheDir: '/tmp/prismer-cli-ingest-test/cache',
    logsDir: '/tmp/prismer-cli-ingest-test/logs',
  })),
}));

describe('prismer memory ingest — the workspace ingest operational switch (§6.9 裁决 5)', () => {
  const origFetch = globalThis.fetch;
  let stdout = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let calls: Array<{ url: string; method: string; body: unknown }> = [];

  beforeEach(() => {
    vi.resetModules();
    stdout = '';
    calls = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    globalThis.fetch = origFetch;
    delete process.env.PRISMER_WORKSPACE_ID;
    process.exitCode = undefined;
  });

  function mockCloud(status: number, payload: unknown): void {
    globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  async function runCli(args: string[]): Promise<void> {
    process.exitCode = undefined;
    const { buildMemoryCommand } = await import('../src/cli/commands/memory.js');
    const cmd = buildMemoryCommand();
    await cmd.parseAsync(args, { from: 'user' });
  }

  it('no flags → a statusOnly probe (reads the switch, writes nothing)', async () => {
    process.env.PRISMER_WORKSPACE_ID = 'ws_pod';
    mockCloud(200, { ok: true, data: { ingestDisabled: false } });
    await runCli(['ingest']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://cloud.test/api/im/memory/ingest-settings');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ workspaceId: 'ws_pod', statusOnly: true });
    expect(stdout).toContain('"ingestDisabled": false');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--disable sends disabled:true to the cloud route', async () => {
    mockCloud(200, { ok: true, data: { ingestDisabled: true } });
    await runCli(['ingest', '--workspace-id', 'ws_x', '--disable']);
    expect(calls[0].body).toEqual({ workspaceId: 'ws_x', disabled: true });
    expect(stdout).toContain('"ingestDisabled": true');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--enable sends disabled:false', async () => {
    mockCloud(200, { ok: true, data: { ingestDisabled: false } });
    await runCli(['ingest', '--workspace-id', 'ws_x', '--enable']);
    expect(calls[0].body).toEqual({ workspaceId: 'ws_x', disabled: false });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('NEGATIVE CONTROL — --disable + --enable is a conflict, and NO request is sent', async () => {
    mockCloud(200, { ok: true, data: { ingestDisabled: false } });
    await runCli(['ingest', '--workspace-id', 'ws_x', '--disable', '--enable']);
    expect(calls).toHaveLength(0);
    expect(stdout).toContain('ingest_flag_conflict');
    expect(process.exitCode).toBe(1);
  });

  it('NEGATIVE CONTROL — no workspace in flag or env fails before any request', async () => {
    mockCloud(200, { ok: true, data: { ingestDisabled: false } });
    await runCli(['ingest']);
    expect(calls).toHaveLength(0);
    expect(stdout).toContain('workspace_required');
    expect(process.exitCode).toBe(1);
  });

  it('a refused toggle (403, non-owner) surfaces as exit 1 with the gate message', async () => {
    // CloudClient unwraps both the structured and the bare-string `error` field;
    // what must survive to the operator is the REASON, not a generic HTTP 403.
    mockCloud(403, { ok: false, error: 'Only workspace owner/admin can manage ingest' });
    await runCli(['ingest', '--workspace-id', 'ws_x', '--disable']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('Only workspace owner/admin can manage ingest');
    expect(stdout).toContain('"ok": false');
  });
});

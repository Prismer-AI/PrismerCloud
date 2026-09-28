import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxCommand } from '../src/cli/commands/sandbox.js';
import { resolvePaths, saveConfig } from '../src/config.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-sandbox-test-'));
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sandbox command', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('builds status/start/snapshot commands', () => {
    const cmd = buildSandboxCommand();
    expect(cmd.commands.map((c) => c.name())).toEqual(['list', 'create', 'status', 'start', 'stop', 'snapshot', 'runCmd', 'logs']);
  });

  it('status uses /api/sandboxes/:id', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        return mkResponse({
          container: {
            id: 'sb-1',
            podName: 'pod-1',
            status: 'running',
            liveStatus: 'running',
            workspaceId: 'ws-1',
          },
        });
      }) as unknown as typeof fetch,
    );

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await buildSandboxCommand().parseAsync(['status', 'sb-1'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }

    expect(calls[0]?.url).toBe('http://cloud.test/api/sandboxes/sb-1');
    expect(calls[0]?.method).toBe('GET');
    expect(out.join('')).toContain('Sandbox sb-1');
    expect(out.join('')).toContain('status: running');
  });

  it('start and snapshot use POST endpoints', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        if (url.endsWith('/start')) return mkResponse({ status: 'started' });
        return mkResponse({
          snapshot: {
            id: 'snap-1',
            containerId: 'sb-1',
            imageTag: 'v1',
            sizeBytes: 42,
            createdBy: 'agent-1',
          },
        }, 201);
      }) as unknown as typeof fetch,
    );

    await buildSandboxCommand().parseAsync(['start', 'sb-1'], { from: 'user' });
    await buildSandboxCommand().parseAsync(['snapshot', 'sb-1'], { from: 'user' });

    expect(calls).toEqual([
      { url: 'http://cloud.test/api/sandboxes/sb-1/start', method: 'POST' },
      { url: 'http://cloud.test/api/sandboxes/sb-1/snapshot', method: 'POST' },
    ]);
  });

  it('list and create use workspace-scoped endpoints', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body?.toString() });
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          return mkResponse({ container: { id: 'sb-new', workspaceId: 'ws-1', status: 'running' } }, 201);
        }
        return mkResponse({ containers: [{ id: 'sb-1', workspaceId: 'ws-1', status: 'running' }] });
      }) as unknown as typeof fetch,
    );

    await buildSandboxCommand().parseAsync(['list', '--workspace-id', 'ws-1', '--status', 'running', '--limit', '7', '--json'], { from: 'user' });
    await buildSandboxCommand().parseAsync(['create', '--workspace-id', 'ws-1', '--agent-id', 'agent-1', '--task-id', 'task-1', '--json'], { from: 'user' });

    expect(calls[0]?.url).toBe('http://cloud.test/api/sandboxes?workspaceId=ws-1&limit=7&status=running');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[1]?.url).toBe('http://cloud.test/api/sandboxes');
    expect(calls[1]?.method).toBe('POST');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      taskId: 'task-1',
    });
  });

  it('stop and runCmd use POST endpoints', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: input.toString(),
          method: (init?.method ?? 'GET').toUpperCase(),
          body: init?.body?.toString(),
        });
        return mkResponse({ status: 'ok' });
      }) as unknown as typeof fetch,
    );

    await buildSandboxCommand().parseAsync(['stop', 'sb-1', '--json'], { from: 'user' });
    await buildSandboxCommand().parseAsync(['runCmd', 'sb-1', '--timeout-ms', '1234', '--json', '--', 'echo', 'hi'], { from: 'user' });

    expect(calls[0]?.url).toBe('http://cloud.test/api/sandboxes/sb-1/stop');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[1]?.url).toBe('http://cloud.test/api/sandboxes/sb-1/runCmd');
    expect(calls[1]?.method).toBe('POST');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ command: ['echo', 'hi'], timeoutMs: 1234 });
  });
});

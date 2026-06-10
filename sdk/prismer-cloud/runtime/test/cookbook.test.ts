import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCookbookCommand } from '../src/cli/commands/cookbook.js';
import { buildProgram } from '../src/cli/index.js';
import { resolvePaths, saveConfig } from '../src/config.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-cookbook-test-'));
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('cookbook command', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is mounted on the root CLI', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('cookbook');
    expect(buildCookbookCommand().commands.map((c) => c.name())).toEqual(['run']);
  });

  it('runs status/im suites with API key bearer auth', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string; auth?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), auth: headers?.Authorization });
        if (url.endsWith('/api/health')) return mkResponse({ status: 'healthy' });
        if (url.endsWith('/api/im/me')) return mkResponse({ ok: true, data: { imUserId: 'human-1' } });
        if (url.endsWith('/api/im/workspaces')) return mkResponse({ ok: true, data: [{ id: 'ws-1' }] });
        if (url.endsWith('/api/im/me/agents')) return mkResponse({ ok: true, data: [] });
        if (url.endsWith('/api/im/groups')) return mkResponse({ ok: true, data: [] });
        return mkResponse({ ok: false, error: { message: 'unexpected' } }, 404);
      }) as unknown as typeof fetch,
    );

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await buildCookbookCommand().parseAsync(['run', '--suite', 'status,im', '--json'], { from: 'user' });

    expect(calls.map((c) => c.url)).toEqual([
      'http://cloud.test/api/health',
      'http://cloud.test/api/im/me',
      'http://cloud.test/api/im/workspaces',
      'http://cloud.test/api/im/me/agents',
      'http://cloud.test/api/im/groups',
    ]);
    expect(calls.slice(1).every((c) => c.auth === 'Bearer sk-test')).toBe(true);
    const summary = JSON.parse(out.join(''));
    expect(summary.ok).toBe(true);
    expect(summary.totals).toEqual({ pass: 5, fail: 0, skip: 0 });
  });

  it('marks optional checks skipped, and strict mode exits non-zero', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mkResponse({ ok: true, data: [] })) as unknown as typeof fetch,
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);

    await expect(
      buildCookbookCommand().parseAsync(['run', '--suite', 'task,sandbox', '--strict', '--json'], { from: 'user' }),
    ).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('creates and polls a task when agent and prompt are provided', async () => {
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
        calls.push({ url: input.toString(), method: (init?.method ?? 'GET').toUpperCase(), body: init?.body?.toString() });
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          return mkResponse({ ok: true, data: { id: 'task-1', status: 'pending' } }, 201);
        }
        return mkResponse({ ok: true, data: { task: { id: 'task-1', status: 'completed' } } });
      }) as unknown as typeof fetch,
    );

    await buildCookbookCommand().parseAsync([
      'run',
      '--suite',
      'task',
      '--agent-id',
      'agent-1',
      '--prompt',
      'say done',
      '--timeout-ms',
      '3000',
      '--json',
    ], { from: 'user' });

    expect(calls[0]?.url).toBe('http://cloud.test/api/im/tasks?view=board&kind=work_item,goal&limit=5');
    expect(calls[1]?.url).toBe('http://cloud.test/api/im/tasks');
    expect(calls[1]?.method).toBe('POST');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({
      assigneeId: 'agent-1',
      input: { prompt: 'say done' },
    });
    expect(calls[2]?.url).toBe('http://cloud.test/api/im/tasks/task-1');
  });
});

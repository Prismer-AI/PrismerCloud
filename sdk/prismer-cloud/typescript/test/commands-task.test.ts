/**
 * Unit tests for `cloud task ...` — focuses on the v2.0 / v1.9.x new flags
 * (priority, assignee-id, assignee-name, conversation-id, kind=goal, schedule-at,
 * reward, progress, status-message, approve, reject, cancel) noted in C11
 * of the joint review.
 *
 * Strategy: same Commander-driven pattern as `commands-asset.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { PrismerClient } from '../src/index';
import { register as registerTask } from '../src/commands/task';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; body?: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body });
    return handler(url, init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  return new PrismerClient({
    apiKey: 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
}

async function runTaskCli(client: PrismerClient, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerTask(program, () => client, () => client);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => { stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8')); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8')); return true; }) as typeof process.stderr.write;

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__exit_${exitCode}`); }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', 'task', ...argv]);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// ---------------------------------------------------------------------------
// task create — new flags
// ---------------------------------------------------------------------------

describe('cloud task create — v2.0 flags', () => {
  it('--priority + --assignee-id + --conversation-id + --reward → POST /tasks body fields', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/tasks') {
        return jsonResponse({
          ok: true,
          data: { id: 't-1', title: 'Ship CLI', status: 'pending', description: 'd' },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const res = await runTaskCli(client, [
      'create',
      '--title', 'Ship CLI',
      '--priority', 'high',
      '--assignee-id', 'usr-1',
      '--conversation-id', 'conv-1',
      '--reward', '5',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/api/im/tasks');
    expect(calls[0]?.method).toBe('POST');

    const body = JSON.parse(String(calls[0]?.body));
    expect(body.title).toBe('Ship CLI');
    expect(body.assigneeId).toBe('usr-1');
    expect(body.conversationId).toBe('conv-1');
    // --reward is an alias for --budget
    expect(body.budget).toBe(5);
    // metadata carries priority + kind=work_item (default)
    expect(body.metadata?.priority).toBe('high');
    expect(body.metadata?.kind).toBe('work_item');
    // conversationId also folds into metadata.context for downstream consumers
    expect(body.metadata?.context?.linkedConversationId).toBe('conv-1');
  });

  it('--kind goal stamps goal payload + intent=standing_objective', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({
      ok: true,
      data: { id: 'g-1', title: 'Achieve X', status: 'pending' },
    }));
    const client = makeClient(fetchFn);

    const res = await runTaskCli(client, [
      'create',
      '--title', 'Achieve X',
      '--kind', 'goal',
      '--conversation-id', 'conv-2',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.metadata?.kind).toBe('goal');
    expect(body.metadata?.intent).toBe('standing_objective');
    expect(body.metadata?.goal?.status).toBe('active');
    expect(body.metadata?.goal?.linkedConversationIds).toEqual(['conv-2']);
  });

  it('--schedule-at flips scheduleType to "once" and stamps scheduleAt', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({
      ok: true,
      data: { id: 't-2', title: 'Run later', status: 'pending' },
    }));
    const client = makeClient(fetchFn);

    const at = '2026-06-01T12:00:00Z';
    const res = await runTaskCli(client, [
      'create',
      '--title', 'Run later',
      '--schedule-at', at,
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.scheduleType).toBe('once');
    expect(body.scheduleAt).toBe(at);
  });

  it('rejects an invalid --priority', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: {} }));
    const client = makeClient(fetchFn);
    const res = await runTaskCli(client, [
      'create',
      '--title', 'Bad prio',
      '--priority', 'super-urgent',
    ]);
    expect(res.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(res.stderr).toContain('Invalid --priority');
  });

  it('--assignee-name resolves via discover when no id is given', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.startsWith('https://api.test/api/im/discover')) {
        return jsonResponse({
          ok: true,
          data: [{ userId: 'usr-bob', username: 'bob', displayName: 'Bob the Builder' }],
        });
      }
      if (url === 'https://api.test/api/im/tasks') {
        return jsonResponse({ ok: true, data: { id: 't-3', title: 'For Bob', status: 'pending' } });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const res = await runTaskCli(client, [
      'create',
      '--title', 'For Bob',
      '--assignee-name', 'bob',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    // 2 calls: discover then create
    expect(calls.map((c) => c.url).some((u) => u.startsWith('https://api.test/api/im/discover'))).toBe(true);
    const createCall = calls.find((c) => c.url === 'https://api.test/api/im/tasks');
    const body = JSON.parse(String(createCall?.body));
    expect(body.assigneeId).toBe('usr-bob');
  });
});

// ---------------------------------------------------------------------------
// task update — new flags
// ---------------------------------------------------------------------------

describe('cloud task update — progress + status-message', () => {
  it('--progress + --status-message → PATCH /tasks/:id body', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/tasks/t-1') {
        return jsonResponse({
          ok: true,
          data: { id: 't-1', title: 'in progress', status: 'running', progress: 0.42, statusMessage: 'halfway' },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runTaskCli(client, [
      'update', 't-1',
      '--progress', '0.42',
      '--status-message', 'halfway',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.method).toBe('PATCH');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.progress).toBe(0.42);
    expect(body.statusMessage).toBe('halfway');
  });
});

// ---------------------------------------------------------------------------
// task approve / reject / cancel
// ---------------------------------------------------------------------------

describe('cloud task lifecycle — approve / reject / cancel', () => {
  it('approve → POST /tasks/:id/approve', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({
      ok: true,
      data: { id: 't-1', title: 'done', status: 'completed' },
    }));
    const client = makeClient(fetchFn);
    const res = await runTaskCli(client, ['approve', 't-1', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/api/im/tasks/t-1/approve');
    expect(calls[0]?.method).toBe('POST');
  });

  it('reject --reason → POST /tasks/:id/reject with reason in body', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({
      ok: true,
      data: { id: 't-1', title: 'no', status: 'failed' },
    }));
    const client = makeClient(fetchFn);
    const res = await runTaskCli(client, ['reject', 't-1', '--reason', 'not enough tests', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/api/im/tasks/t-1/reject');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.reason).toBe('not enough tests');
  });

  it('cancel → DELETE /tasks/:id', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({
      ok: true,
      data: { id: 't-1', title: 'gone', status: 'cancelled' },
    }));
    const client = makeClient(fetchFn);
    const res = await runTaskCli(client, ['cancel', 't-1', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/api/im/tasks/t-1');
    expect(calls[0]?.method).toBe('DELETE');
  });
});

/**
 * Unit tests for `cloud approval request-human`.
 *
 * Strategy mirrors `commands-asset.test.ts`: register the `approval` Commander
 * sub-tree with a real PrismerClient (mocked fetch), then run sub-commands
 * via parseAsync.
 *
 * Covers C2 of the v2.0 joint review (approval CLI).
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { PrismerClient } from '../src/index';
import { register as registerApproval } from '../src/commands/approval';

// ---------------------------------------------------------------------------
// Shared helpers (mirrors commands-asset.test.ts)
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

async function runApprovalCli(client: PrismerClient, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerApproval(program, () => client, () => client);

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
    await program.parseAsync(['node', 'cloud', 'approval', ...argv]);
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
// approval request-human
// ---------------------------------------------------------------------------

describe('cloud approval request-human', () => {
  it('posts /api/im/approvals with composed context + default options when --task-id is given', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/approvals') {
        return jsonResponse({
          ok: true,
          data: {
            id: 'appr-1',
            workspaceId: 'ws-1',
            taskId: 'task-1',
            category: 'human-approval',
            title: 'delete prod db',
            status: 'pending',
            expiresAt: '2026-05-19T00:00:00Z',
            options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }],
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const res = await runApprovalCli(client, [
      'request-human',
      '--action', 'delete prod db',
      '--context', 'agent wants to drop the prod schema',
      '--risk', 'data loss; not reversible without a backup',
      '--task-id', 'task-1',
      '--workspace-id', 'ws-1',
    ]);

    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/api/im/approvals');
    expect(calls[0]?.method).toBe('POST');

    const body = JSON.parse(String(calls[0]?.body));
    expect(body.title).toBe('delete prod db');
    expect(body.context).toContain('agent wants to drop the prod schema');
    expect(body.context).toContain('Risk: data loss');
    expect(body.taskId).toBe('task-1');
    expect(body.workspaceId).toBe('ws-1');
    expect(body.category).toBe('human-approval');
    expect(body.metadata?.risk).toBe('data loss; not reversible without a backup');
    expect(body.metadata?.source).toBe('cli:prismer-approval-request-human');
    expect(body.options).toEqual([
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ]);

    // Summary JSON line goes to stdout; the "Submitted ..." message to stderr.
    expect(JSON.parse(res.stdout.trim()).approvalId).toBe('appr-1');
    expect(res.stderr).toContain('Submitted approval request appr-1');
  });

  it('exits non-zero when neither --task-id nor --conversation-id is provided', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: {} }));
    const client = makeClient(fetchFn);
    const res = await runApprovalCli(client, [
      'request-human',
      '--action', 'do thing',
      '--context', 'context here',
      '--risk', 'minor',
    ]);
    expect(res.exitCode).toBe(1);
    expect(calls).toHaveLength(0); // never reaches the network
    expect(res.stderr).toContain('--conversation-id or --task-id is required');
  });

  it('emits --json output and non-zero exit on cloud error', async () => {
    const { fetchFn } = makeFetchMock(() => jsonResponse({ ok: false, error: { code: 'bad_request', message: 'missing anchor' } }, 400));
    const client = makeClient(fetchFn);
    const res = await runApprovalCli(client, [
      'request-human',
      '--action', 'do thing',
      '--context', 'context here',
      '--risk', 'minor',
      '--task-id', 'task-1',
      '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.message).toBe('missing anchor');
  });
});

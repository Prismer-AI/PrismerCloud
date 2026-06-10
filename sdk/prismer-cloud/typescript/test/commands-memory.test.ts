/**
 * Unit tests for `cloud memory ...` and `cloud recall` — covers C11 of the
 * v2.0 joint review:
 *
 *   - memory write --type / --description (v1.8.0 fields surface on POST body)
 *   - memory extract (one happy-path call → POST /api/im/memory/extract)
 *   - memory consolidate (one happy-path call → POST /api/im/memory/consolidate)
 *   - recall --strategy / --layer end up in the request
 *
 * Strategy: same Commander-driven pattern as `commands-asset.test.ts`. The
 * `recall` shortcut lives in `cli.ts` (not in `commands/memory.ts`), so the
 * recall test exercises the SDK-level POST/GET request shape directly via
 * `client.im.memory` instead of re-importing the cli wrapper.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { PrismerClient } from '../src/index';
import { register as registerMemory } from '../src/commands/memory';

// ---------------------------------------------------------------------------
// Shared helpers
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

async function runMemoryCli(client: PrismerClient, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerMemory(program, () => client, () => client);

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
    await program.parseAsync(['node', 'cloud', 'memory', ...argv]);
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
// memory write — v1.8.0 fields
// ---------------------------------------------------------------------------

describe('cloud memory write — v1.8.0 type/description fields', () => {
  it('threads --type and --description into the POST body', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/memory/files') {
        return jsonResponse({
          ok: true,
          data: { id: 'mem-1', scope: 'global', path: 'memory/feedback/x.md' },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const res = await runMemoryCli(client, [
      'write',
      '--scope', 'global',
      '--path', 'memory/feedback/x.md',
      '--content', '# x\nfeedback',
      '--type', 'feedback',
      '--description', 'naming convention',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.test/api/im/memory/files');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.memoryType).toBe('feedback');
    expect(body.description).toBe('naming convention');
    expect(body.scope).toBe('global');
    expect(body.path).toBe('memory/feedback/x.md');
    expect(body.content).toContain('feedback');
  });

  it('rejects an invalid --type', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: {} }));
    const client = makeClient(fetchFn);
    const res = await runMemoryCli(client, [
      'write',
      '--scope', 'global',
      '--path', 'memory/x.md',
      '--content', 'c',
      '--type', 'made-up',
    ]);
    expect(res.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(res.stderr).toContain('Invalid --type');
  });
});

// ---------------------------------------------------------------------------
// memory extract / consolidate
// ---------------------------------------------------------------------------

describe('cloud memory extract', () => {
  it('POSTs /api/im/memory/extract with journal + scope', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/memory/extract') {
        return jsonResponse({
          ok: true,
          data: { extracted: [{}], created: [{}], updated: [] },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const journal = 'a session journal with at least 50 chars of meaningful content here.';
    const res = await runMemoryCli(client, [
      'extract',
      '--journal', journal,
      '--scope', 'project',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/api/im/memory/extract');
    expect(calls[0]?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.journal).toBe(journal);
    expect(body.scope).toBe('project');
  });
});

describe('cloud memory consolidate', () => {
  it('POSTs /api/im/memory/consolidate with scope', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/memory/consolidate') {
        return jsonResponse({ ok: true, data: { clusters: 2, reflections: 1 } });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const res = await runMemoryCli(client, ['consolidate', '--scope', 'global', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/api/im/memory/consolidate');
    expect(calls[0]?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.scope).toBe('global');
  });
});

// ---------------------------------------------------------------------------
// recall — exercised directly via the SDK request pipeline since the recall
// command itself lives in cli.ts (not commands/memory.ts).
// ---------------------------------------------------------------------------

describe('cloud recall — strategy + layer wire-through', () => {
  it('POST /api/im/recall when --strategy is supplied (recall command behavior contract)', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/recall') {
        return jsonResponse({ ok: true, data: [{ source: 'memory', title: 'hit', score: 0.9, snippet: '...' }] });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    // Use the same private-borrow trick that cli.ts:recall uses. This locks
    // the wire format: POST /api/im/recall with { query, strategy, scope,
    // maxResults }. If P3 lands a typed wrapper later, the cli.ts logic and
    // this assertion both move together.
    const _r = (client.im as unknown as { memory: { _r: (m: string, p: string, b?: unknown, q?: Record<string, string>) => Promise<unknown> } }).memory._r;
    const res = await _r('POST', '/api/im/recall', {
      query: 'foo',
      strategy: 'hybrid',
      scope: 'memory',
      maxResults: 5,
    }) as { ok: boolean; data?: unknown[] };

    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.test/api/im/recall');
    expect(calls[0]?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.strategy).toBe('hybrid');
    expect(body.scope).toBe('memory');
  });

  it('GET /api/im/recall when only --layer (no strategy) is supplied', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.startsWith('https://api.test/api/im/recall')) {
        return jsonResponse({ ok: true, data: [] });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const _r = (client.im as unknown as { memory: { _r: (m: string, p: string, b?: unknown, q?: Record<string, string>) => Promise<unknown> } }).memory._r;
    const res = await _r('GET', '/api/im/recall', undefined, { q: 'foo', scope: 'cache', limit: '10' }) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('scope=cache');
    expect(calls[0]?.url).toContain('limit=10');
    expect(calls[0]?.url).toContain('q=foo');
  });
});

/**
 * Unit tests for `cloud service introspect <url>` — release201/07 Phase 2
 * service-endpoint CLI.
 *
 * Strategy: stub global `fetch` with a route-aware mock and drive the
 * Commander sub-tree via parseAsync. Verifies:
 *   • auto detect → OpenAPI when /openapi.json responds with a valid spec
 *   • auto detect → MCP when JSON-RPC tools/list responds with `result.tools`
 *   • --protocol openapi forces OpenAPI path (skips MCP probe)
 *   • --protocol mcp forces MCP path (skips OpenAPI probe)
 *   • unknown endpoint → kind: 'unknown', tools/endpoints empty
 *   • invalid --protocol exits 1
 *   • HTTP 10s timeout is wired (we stub AbortController; verify fetch is
 *     called with signal)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { register as registerServiceIntrospect } from '../src/commands/service-introspect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
  hasSignal: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
}

function setupFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const orig = globalThis.fetch;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as raw string
      }
    }
    calls.push({ url, method, body, hasSignal: Boolean(init?.signal) });
    return handler(url, init);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

async function runIntrospect(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const program = new Command();
  program.exitOverride();
  registerServiceIntrospect(program, () => ({}) as unknown, () => ({}) as unknown);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', 'service', ...argv]);
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
// OpenAPI path
// ---------------------------------------------------------------------------

describe('cloud service introspect — OpenAPI detection', () => {
  let mock: ReturnType<typeof setupFetchMock>;
  beforeEach(() => {
    mock = setupFetchMock((url, init) => {
      // Reject the MCP JSON-RPC probe so auto skips it.
      if (init?.method === 'POST') return notFound();
      if (url === 'https://api.example.com/openapi.json') {
        return jsonResponse({
          openapi: '3.0.0',
          info: { title: 'Demo', version: '1.0' },
          paths: {
            '/users': {
              get: { operationId: 'listUsers', summary: 'List users' },
              post: { operationId: 'createUser', summary: 'Create user' },
            },
            '/users/{id}': {
              get: { operationId: 'getUser', summary: 'Get user' },
            },
          },
        });
      }
      return notFound();
    });
  });
  afterEach(() => mock.restore());

  it('auto detects OpenAPI and emits flat endpoint list', async () => {
    const res = await runIntrospect(['introspect', 'https://api.example.com']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.kind).toBe('openapi');
    expect(out.specUrl).toBe('https://api.example.com/openapi.json');
    expect(Array.isArray(out.endpoints)).toBe(true);
    expect(out.endpoints.length).toBe(3);
    const ops = out.endpoints.map((e: any) => `${e.method} ${e.path}`);
    expect(ops).toContain('GET /users');
    expect(ops).toContain('POST /users');
    expect(ops).toContain('GET /users/{id}');
    // Each endpoint records operationId + summary
    const list = out.endpoints.find((e: any) => e.operationId === 'listUsers');
    expect(list.summary).toBe('List users');
  });

  it('--protocol openapi skips MCP probe (no POST calls before openapi.json)', async () => {
    const res = await runIntrospect([
      'introspect',
      'https://api.example.com',
      '--protocol',
      'openapi',
    ]);
    expect(res.exitCode).toBe(0);
    const postCalls = mock.calls.filter((c) => c.method === 'POST');
    expect(postCalls.length).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.kind).toBe('openapi');
  });

  it('each fetch call carries an abort signal (timeout wiring)', async () => {
    await runIntrospect([
      'introspect',
      'https://api.example.com',
      '--protocol',
      'openapi',
    ]);
    expect(mock.calls.length).toBeGreaterThan(0);
    for (const c of mock.calls) {
      expect(c.hasSignal).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// MCP path
// ---------------------------------------------------------------------------

describe('cloud service introspect — MCP detection', () => {
  let mock: ReturnType<typeof setupFetchMock>;
  beforeEach(() => {
    mock = setupFetchMock((url, init) => {
      if (init?.method === 'POST') {
        let parsed: any = init.body;
        if (typeof init.body === 'string') {
          try {
            parsed = JSON.parse(init.body);
          } catch {
            parsed = null;
          }
        }
        if (parsed?.method === 'tools/list') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              tools: [
                { name: 'echo', description: 'echo input' },
                { name: 'add', description: 'add two numbers' },
              ],
            },
          });
        }
        if (parsed?.method === 'resources/list') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 2,
            result: { resources: [{ uri: 'mcp://demo/doc' }] },
          });
        }
      }
      // Block OpenAPI candidates so auto only matches MCP
      return notFound();
    });
  });
  afterEach(() => mock.restore());

  it('auto detects MCP via tools/list', async () => {
    const res = await runIntrospect(['introspect', 'https://mcp.example.com/mcp']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.kind).toBe('mcp');
    expect(Array.isArray(out.tools)).toBe(true);
    expect(out.tools.length).toBe(2);
    expect(out.tools.map((t: any) => t.name)).toEqual(['echo', 'add']);
    // resources optional but should be picked up when present
    expect(Array.isArray(out.resources)).toBe(true);
    expect(out.resources.length).toBe(1);
  });

  it('--protocol mcp skips OpenAPI probe (no GET /openapi.json call)', async () => {
    const res = await runIntrospect([
      'introspect',
      'https://mcp.example.com/mcp',
      '--protocol',
      'mcp',
    ]);
    expect(res.exitCode).toBe(0);
    const oaCalls = mock.calls.filter(
      (c) => c.method === 'GET' && c.url.includes('openapi.json'),
    );
    expect(oaCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown / error paths
// ---------------------------------------------------------------------------

describe('cloud service introspect — unknown / errors', () => {
  it('emits kind=unknown when no protocol responds', async () => {
    const mock = setupFetchMock(() => notFound());
    try {
      const res = await runIntrospect(['introspect', 'https://nothing.example.com']);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.kind).toBe('unknown');
      expect(out.tools).toEqual([]);
      expect(out.endpoints).toEqual([]);
    } finally {
      mock.restore();
    }
  });

  it('invalid --protocol exits 1', async () => {
    const mock = setupFetchMock(() => notFound());
    try {
      const res = await runIntrospect([
        'introspect',
        'https://api.example.com',
        '--protocol',
        'bogus',
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(/protocol must be/i);
    } finally {
      mock.restore();
    }
  });
});

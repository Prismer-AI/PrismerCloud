import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  buildMemoryToolImpls,
} from '../src/adapters/memory-tools.js';

let dir = '';
let runtime: MemoryRuntime | undefined;
let server: LocalServer | undefined;
let baseUrl = '';
// spec16 §8.1 — fail-closed RPC: the tool client reads $PRISMER_MEMORY_CAP
// from env; we inject the suite's cap there + on the seed writes.
let cap = '';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  pid: 0,
  startedAt: 0,
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

beforeEach(async () => {
  // Tool transport tests seed flat pages and do not exercise placement policy.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  dir = mkdtempSync(join(tmpdir(), 'prismer-tools-'));
  cap = mintCap('im_seed', 'ws_test');
  process.env.PRISMER_MEMORY_CAP = cap;
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  delete process.env.PRISMER_MEMORY_CAP;
  await server?.stop();
  runtime?.closeAll();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function seed(workspaceId: string, path: string, content: string): Promise<void> {
  await fetch(`${baseUrl}/local/memory/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
    body: JSON.stringify({
      workspaceId,
      path,
      content,
      pageType: 'leaf',
      actorImUserId: 'im_seed',
      actorKind: 'human',
    }),
  });
}

describe('shared memory tool spec', () => {
  it('exposes locked tool names + descriptions', () => {
    expect(MEMORY_SEARCH_TOOL.name).toBe('memory_search');
    expect(MEMORY_LOAD_TOOL.name).toBe('memory_load');
    expect(MEMORY_SEARCH_TOOL.description).toMatch(/Search workspace memory/);
    expect(MEMORY_LOAD_TOOL.description).toMatch(/Load a specific memory page/);
  });

  it('search() impl hits daemon /local/memory/search and returns ranked results', async () => {
    await seed('ws_test', 'auth.md', 'OAuth migration notes');
    await seed('ws_test', 'billing.md', 'Stripe billing setup');

    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_test' });
    const out = await tools.search({ query: 'OAuth' });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]?.path).toBe('auth.md');
  });

  it('load() impl resolves prismer:// URI', async () => {
    await seed('ws_test', 'decisions/auth.md', 'Decision: chose OAuth');
    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_test' });
    const out = await tools.load({ uri: 'prismer://workspace/ws_test/memory/decisions/auth.md' });
    expect(out.page.path).toBe('decisions/auth.md');
    expect(out.content).toBe('Decision: chose OAuth');
  });

  it('load() impl resolves workspaceId+path form', async () => {
    await seed('ws_test', 'a.md', 'hello');
    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_test' });
    const out = await tools.load({ workspaceId: 'ws_test', path: 'a.md' });
    expect(out.content).toBe('hello');
  });

  it('load() impl throws on missing page', async () => {
    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_test' });
    await expect(tools.load({ workspaceId: 'ws_test', path: 'missing.md' })).rejects.toThrow(
      /not found/,
    );
  });

  it('search() impl honors limit', async () => {
    for (let i = 0; i < 5; i++) {
      await seed('ws_test', `n${i}.md`, `decision number ${i}`);
    }
    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_test' });
    const out = await tools.search({ query: 'decision', limit: 2 });
    expect(out.results.length).toBe(2);
  });

  it('grant-aware search/load forward sourceWorkspaceId to the daemon RPC', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes('/search?')) {
        return new Response(JSON.stringify({ query: 'shared', results: [], resultsByQuery: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          page: { id: 'p1', path: 'shared.md', title: null, pageType: 'leaf', version: 1, contentHash: '' },
          content: 'shared body',
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const tools = buildMemoryToolImpls({ daemonUrl: 'http://127.0.0.1:3210', workspaceId: 'ws_target' });
      await tools.search({ query: 'shared', sourceWorkspaceId: 'ws_source' });
      await tools.load({ sourceWorkspaceId: 'ws_source', path: 'shared.md' });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const searchUrl = new URL(urls[0]!);
    expect(searchUrl.pathname).toBe('/local/memory/search');
    expect(searchUrl.searchParams.get('workspaceId')).toBe('ws_target');
    expect(searchUrl.searchParams.get('sourceWorkspaceId')).toBe('ws_source');

    const loadUrl = new URL(urls[1]!);
    expect(loadUrl.pathname).toBe('/local/memory/load');
    expect(loadUrl.searchParams.get('workspaceId')).toBe('ws_target');
    expect(loadUrl.searchParams.get('sourceWorkspaceId')).toBe('ws_source');
    expect(loadUrl.searchParams.get('path')).toBe('shared.md');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import {
  MEMORY_SEARCH_TOOL,
  MEMORY_LOAD_TOOL,
  buildMemoryToolImpls,
} from '../src/adapters/memory-tools.js';

let dir = '';
let runtime: MemoryRuntime | undefined;
let server: LocalServer | undefined;
let baseUrl = '';

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
  dir = mkdtempSync(join(tmpdir(), 'prismer-tools-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  const port = 38000 + Math.floor(Math.random() * 1000);
  server = new LocalServer({
    port,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
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
    headers: { 'Content-Type': 'application/json' },
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
});

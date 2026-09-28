// memory202/09 P0 §11 ⑨ — daemon GET /local/memory/load?section= integration.
//
// Drives the REAL daemon RPC: LocalServer + MemoryRuntime + on-disk SQLite store
// (same fixture as memory-rpc.test.ts). Proves `sliceSection` is wired into
// `handleLoad` for BOTH the `?section=` query param and the `#section` anchor
// embedded in `?uri=`, with full-page fallback on unmatched anchor. The pure
// slicer itself is covered byte-for-byte in memory-section.test.ts.
//
// Run:
//   cd sdk/prismer && npx vitest run test/memory-load-section.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
// spec16 §8.1 — fail-closed RPC: the helpers carry the suite's agent cap.
let cap = '';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

const PAGE = [
  '# Top',
  'intro',
  '',
  '## Alpha',
  'alpha body',
  '',
  '### Alpha child',
  'nested alpha',
  '',
  '## 部署流程',
  '中文部署正文',
].join('\n');

beforeEach(async () => {
  // Section slicing is independent of the new-page placement gate.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  const dir = mkdtempSync(join(tmpdir(), 'prismer-memory-load-section-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_alice', 'ws_test');
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
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-prismer-memory-cap': cap } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function seedPage(): Promise<void> {
  const w = await post('/local/memory/write', {
    workspaceId: 'ws_test',
    path: 'notes.md',
    content: PAGE,
    pageType: 'note',
    title: 'Notes',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  expect(w.status).toBe(200);
}

describe('daemon /local/memory/load?section= (⑨)', () => {
  it('?section=Alpha → sub-section (nested ### kept, stops before next ##), echoes section', async () => {
    await seedPage();
    const r = await get('/local/memory/load?workspaceId=ws_test&path=notes.md&section=Alpha');
    expect(r.status).toBe(200);
    const content: string = r.body.content;
    expect(content.startsWith('## Alpha')).toBe(true);
    expect(content).toContain('alpha body');
    expect(content).toContain('### Alpha child'); // ④ nested kept
    expect(content).toContain('nested alpha');
    expect(content).not.toContain('## 部署流程'); // ① stops at next same-level
    expect(content).not.toContain('中文部署正文');
    expect(r.body.section).toBe('Alpha');
  });

  it('?section=部署流程 → CJK sub-section to EOF (②)', async () => {
    await seedPage();
    const r = await get(
      '/local/memory/load?workspaceId=ws_test&path=notes.md&section=' + encodeURIComponent('部署流程'),
    );
    expect(r.status).toBe(200);
    const content: string = r.body.content;
    expect(content.startsWith('## 部署流程')).toBe(true);
    expect(content.endsWith('中文部署正文')).toBe(true);
    expect(content).not.toContain('## Alpha');
    expect(r.body.section).toBe('部署流程');
  });

  it('?uri=...#Alpha → anchor embedded in URI resolves the sub-section (⑦+⑨)', async () => {
    await seedPage();
    const r = await get(
      '/local/memory/load?uri=' +
        encodeURIComponent('prismer://workspace/ws_test/memory/notes.md#Alpha'),
    );
    expect(r.status).toBe(200);
    const content: string = r.body.content;
    expect(content.startsWith('## Alpha')).toBe(true);
    expect(content).not.toContain('## 部署流程');
    expect(r.body.section).toBe('Alpha');
  });

  it('?section=NonExistent → full page fallback, section echoed but content whole (③)', async () => {
    await seedPage();
    const r = await get('/local/memory/load?workspaceId=ws_test&path=notes.md&section=NonExistent');
    expect(r.status).toBe(200);
    expect(r.body.content).toBe(PAGE); // unmatched anchor → whole page
  });

  it('no section → full page (original behaviour), section=null (⑧)', async () => {
    await seedPage();
    const r = await get('/local/memory/load?workspaceId=ws_test&path=notes.md');
    expect(r.status).toBe(200);
    expect(r.body.content).toBe(PAGE);
    expect(r.body.section).toBeNull();
  });

  it('?uri without #anchor → whole page, section=null (⑧)', async () => {
    await seedPage();
    const r = await get(
      '/local/memory/load?uri=' + encodeURIComponent('prismer://workspace/ws_test/memory/notes.md'),
    );
    expect(r.status).toBe(200);
    expect(r.body.content).toBe(PAGE);
    expect(r.body.section).toBeNull();
  });
});

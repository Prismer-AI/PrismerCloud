import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { attachPkfRpc } from '../src/daemon/pkf/rpc.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';

const baseState: LocalServerState = {
  daemonId: 'dev_pkf',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: 'ws-1',
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

const SOURCE =
  '<script type="application/prismer+json">{"type":"note","title":"Redis","pkfVersion":"1.1"}</script>' +
  '<section><h2 id="redis" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">Redis</h2><p>单线程事件循环。</p></section>';

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('native PKF RPC (/local/pkf/*)', () => {
  let server: LocalServer | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    server = new LocalServer({ port: 0, getState: () => baseState, attachPkf: attachPkfRpc() });
    await server.start();
    baseUrl = boundBaseUrl(server);
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('validates PKF with the bundled core and returns structured diagnostics', async () => {
    const r = await post(baseUrl, '/local/pkf/validate', { source: SOURCE, level: 'structure' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, structureStatus: 'pass', strictOk: true });
    expect(r.body.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('mints canonical section identities without requiring source or workspace state', async () => {
    const r = await post(baseUrl, '/local/pkf/mint-sids', { count: 3 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sids).toEqual([
      expect.stringMatching(/^sec_[0-9a-hjkmnp-tv-z]{26}$/),
      expect.stringMatching(/^sec_[0-9a-hjkmnp-tv-z]{26}$/),
      expect.stringMatching(/^sec_[0-9a-hjkmnp-tv-z]{26}$/),
    ]);
    expect(new Set(r.body.sids as string[]).size).toBe(3);
  });

  it('exposes bounded outline/search/read operations', async () => {
    const outline = await post(baseUrl, '/local/pkf/outline', { source: SOURCE });
    expect(outline.status).toBe(200);
    expect(outline.body).toMatchObject({ ok: true });
    expect(outline.body.sections).toEqual(expect.any(Array));

    const search = await post(baseUrl, '/local/pkf/search', { source: SOURCE, query: '事件循环' });
    expect(search.status).toBe(200);
    expect(search.body.matches).toEqual(expect.any(Array));

    const read = await post(baseUrl, '/local/pkf/read', { source: SOURCE, sectionSid: 'sec_01k2f6m8v7q4x9a3b5c6d7e8f9' });
    expect(read.status).toBe(200);
    expect(read.body.content).toContain('单线程事件循环');
  });

  it('rejects missing source and oversized requests without crashing the local server', async () => {
    expect((await post(baseUrl, '/local/pkf/validate', {})).status).toBe(400);
    const oversized = await post(baseUrl, '/local/pkf/validate', { source: 'x'.repeat(5 * 1024 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error).toBe('pkf_source_too_large');
  });
});

// Integration test for the new POST /local/asset/write route on LocalServer.
// Confirms HTTP framing (status code, body envelope) wires to the agent-gen
// handler correctly. Acceptance: doc 26 §5 L2-T3 — agent calls RPC, daemon
// synchronously returns prismer:// URI.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { handleAssetWrite } from '../src/daemon/asset/origin/agent-gen.js';
import type { CloudUploadClient } from '../src/daemon/asset/origin/upload-runner.js';

let server: LocalServer | undefined;
let baseUrl = '';

const baseState: LocalServerState = {
  daemonId: 'dev_test',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

function fakeCloudClient(opts: { hash?: string; throwOnce?: boolean } = {}): CloudUploadClient {
  let throwOnceFlag = opts.throwOnce ?? false;
  return {
    async uploadAsset(req) {
      if (throwOnceFlag) {
        throwOnceFlag = false;
        throw new Error('synthetic cloud failure');
      }
      void req;
      return { assetId: 'as_42', contentHash: opts.hash ?? 'sha256-zz' };
    },
  };
}

beforeEach(async () => {
  const cloud = fakeCloudClient({ hash: 'sha256-aaa' });
  const port = 39000 + Math.floor(Math.random() * 1000);
  server = new LocalServer({
    port,
    getState: () => baseState,
    onAssetWrite: async (body) => {
      const result = await handleAssetWrite(body, { cloud });
      if (result.ok) return { status: result.status, body: result.body };
      return { status: result.status, body: { error: result.error } };
    },
  });
  await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await server?.stop();
});

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('POST /local/asset/write', () => {
  it('200 with prismer:// URI on a happy upload (L2-T3)', async () => {
    const r = await postJson('/local/asset/write', {
      workspaceId: 'ws_x',
      bytes: Buffer.from('hello').toString('base64'),
      filename: 'note.txt',
      mime: 'text/plain',
    });
    expect(r.status).toBe(200);
    const body = r.body as { assetId: string; contentHash: string; prismerUri: string };
    expect(body.assetId).toBe('as_42');
    expect(body.contentHash).toBe('sha256-aaa');
    expect(body.prismerUri).toBe('prismer://workspace/ws_x/asset/sha256-aaa');
  });

  it('400 on missing workspaceId', async () => {
    const r = await postJson('/local/asset/write', {
      bytes: Buffer.from('x').toString('base64'),
      filename: 'a.txt',
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/workspaceId/);
  });

  it('400 on invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/local/asset/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('501 when no onAssetWrite is wired', async () => {
    await server?.stop();
    const port = 40000 + Math.floor(Math.random() * 1000);
    server = new LocalServer({ port, getState: () => baseState }); // no onAssetWrite
    await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    const r = await postJson('/local/asset/write', { workspaceId: 'w', bytes: '', filename: 'f' });
    expect(r.status).toBe(501);
  });
});

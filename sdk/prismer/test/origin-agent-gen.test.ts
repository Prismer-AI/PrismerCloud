// Agent-gen Origin Adapter tests.
//
// Acceptance: doc 26 §5 L2-T3 — agent calls daemon RPC `POST
// /local/asset/write`, daemon synchronously returns prismer:// URI.

import { afterEach, describe, expect, it } from 'vitest';
import { handleAssetWrite } from '../src/daemon/asset/origin/agent-gen.js';
import type { CloudUploadClient, CloudUploadRequest } from '../src/daemon/asset/origin/upload-runner.js';

interface FakeCloudOpts {
  hash?: string;
}

function fakeCloud(opts: FakeCloudOpts = {}): {
  client: CloudUploadClient;
  calls: CloudUploadRequest[];
} {
  const calls: CloudUploadRequest[] = [];
  const client: CloudUploadClient = {
    async uploadAsset(req) {
      calls.push(req);
      return { assetId: `as_${calls.length}`, contentHash: opts.hash ?? 'sha256-fake' };
    },
  };
  return { client, calls };
}

describe('handleAssetWrite (agent-gen RPC)', () => {
  it('decodes base64 bytes, uploads, and returns the prismer:// URI', async () => {
    const { client, calls } = fakeCloud({ hash: 'sha256-abc' });
    const body = {
      workspaceId: 'ws_a',
      bytes: Buffer.from('hello world').toString('base64'),
      filename: 'greeting.txt',
      mime: 'text/plain',
    };
    const res = await handleAssetWrite(body, { cloud: client });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.assetId).toBe('as_1');
    expect(res.body.contentHash).toBe('sha256-abc');
    expect(res.body.prismerUri).toBe('prismer://workspace/ws_a/asset/sha256-abc');
    expect(calls).toHaveLength(1);
    expect(calls[0].workspaceId).toBe('ws_a');
    expect(calls[0].filename).toBe('greeting.txt');
    expect(calls[0].mime).toBe('text/plain');
    expect(calls[0].bytes.toString()).toBe('hello world');
    expect(calls[0].metadata.sourceKind).toBe('agent-gen');
    expect(calls[0].metadata.sourceRef).toMatch(/^agent:\/\//);
  });

  it('threads optional description, path, sourceAgentImUserId through metadata', async () => {
    const { client, calls } = fakeCloud();
    const body = {
      workspaceId: 'ws_b',
      bytes: Buffer.from('payload').toString('base64'),
      filename: 'report.md',
      path: 'reports/2026',
      description: 'Quarterly report (Q1)',
      sourceAgentImUserId: 'im_agent_xyz',
    };
    const res = await handleAssetWrite(body, { cloud: client });
    expect(res.ok).toBe(true);
    expect(calls[0].folderPath).toBe('reports/2026');
    expect(calls[0].metadata.description).toBe('Quarterly report (Q1)');
    expect(calls[0].metadata.sourceAgentImUserId).toBe('im_agent_xyz');
    expect(calls[0].mime).toBe('text/markdown');
  });

  // release202/09 P0: office docs + raster images are now ALLOWED agent
  // deliverables (the office-artifacts skill is built to produce them).
  it('allows agent-produced binary Office files', async () => {
    const { client, calls } = fakeCloud();
    const res = await handleAssetWrite(
      {
        workspaceId: 'ws_a',
        bytes: Buffer.from('fake docx').toString('base64'),
        filename: 'report.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { cloud: client },
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('allows agent-produced raster media', async () => {
    const { client, calls } = fakeCloud();
    const res = await handleAssetWrite(
      {
        workspaceId: 'ws_a',
        bytes: Buffer.from('fake png').toString('base64'),
        filename: 'chart.png',
        mime: 'image/png',
      },
      { cloud: client },
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('rejects missing workspaceId', async () => {
    const { client } = fakeCloud();
    const res = await handleAssetWrite({ bytes: '', filename: 'x' }, { cloud: client });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/workspaceId/);
  });

  it('rejects missing filename', async () => {
    const { client } = fakeCloud();
    const res = await handleAssetWrite(
      { workspaceId: 'ws_a', bytes: Buffer.from('x').toString('base64') },
      { cloud: client },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/filename/);
  });

  it('rejects missing bytes', async () => {
    const { client } = fakeCloud();
    const res = await handleAssetWrite({ workspaceId: 'ws_a', filename: 'x.txt' }, { cloud: client });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/bytes/);
  });

  it('rejects malformed base64 bytes (invalid characters)', async () => {
    const { client } = fakeCloud();
    const res = await handleAssetWrite(
      { workspaceId: 'ws_a', filename: 'x.txt', bytes: '%%not base64%%' },
      { cloud: client },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/base64|bytes/);
  });

  it('rejects base64 of non-multiple-of-4 length (silent-truncation guard)', async () => {
    // 'abc' is 3 chars — passes the alphabet regex but Buffer.from('abc','base64')
    // silently returns 2 bytes. Without the length check the server would
    // upload a truncated payload. With it, the agent gets a 400.
    const { client, calls } = fakeCloud();
    const res = await handleAssetWrite(
      { workspaceId: 'ws_a', filename: 'x.txt', bytes: 'abc' },
      { cloud: client },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/multiple of 4/);
    expect(calls).toHaveLength(0); // never reached cloud
  });

  it('rejects base64 with embedded invalid bytes that the alphabet regex misses', async () => {
    // The alphabet regex requires `={0,2}` only at the END. An `=` in the
    // middle would fail the regex. But "padding char in the middle of body"
    // is a class the regex catches; this test pins it.
    const { client } = fakeCloud();
    const res = await handleAssetWrite(
      { workspaceId: 'ws_a', filename: 'x.txt', bytes: 'AB=CD' },
      { cloud: client },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
  });

  it('accepts whitespace in base64 (line-wrapped agent payloads)', async () => {
    const { client, calls } = fakeCloud();
    const wrapped = Buffer.from('hello world').toString('base64').replace(/(.{4})/g, '$1\n');
    const res = await handleAssetWrite(
      { workspaceId: 'ws_a', filename: 'x.txt', bytes: wrapped },
      { cloud: client },
    );
    expect(res.ok).toBe(true);
    expect(calls[0].bytes.toString()).toBe('hello world');
  });

  it('propagates upstream upload errors as 502', async () => {
    const client: CloudUploadClient = {
      async uploadAsset() {
        throw new Error('cloud went boom');
      },
    };
    const res = await handleAssetWrite(
      {
        workspaceId: 'ws_a',
        filename: 'x.txt',
        bytes: Buffer.from('hi').toString('base64'),
      },
      { cloud: client },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/cloud went boom/);
  });
});

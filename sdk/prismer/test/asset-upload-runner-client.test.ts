import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DaemonAssetUploadClient } from '../src/daemon/asset/origin/upload-runner.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('DaemonAssetUploadClient', () => {
  it('uses direct upload first and completes with preserved metadata fields', async () => {
    const bytes = Buffer.from('hello direct');
    const digest = sha256Hex(bytes);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === 'http://cloud.test/api/im/assets/direct-upload/init') {
        return jsonResponse({
          ok: true,
          data: {
            mode: 'single',
            bucket: 'bucket',
            key: `assets/${digest}`,
            uploadUrl: 'http://s3.test/object',
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain', 'x-amz-meta-sha256': digest },
          },
        });
      }
      if (url === 'http://s3.test/object') {
        expect(init?.method).toBe('PUT');
        expect(Buffer.from((init?.body as Uint8Array) ?? []).toString()).toBe('hello direct');
        return new Response('', { status: 200 });
      }
      if (url === 'http://cloud.test/api/im/assets/direct-upload/complete') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.contentHash).toBe(digest);
        expect(body.metadata).toEqual({
          sourceRef: 'folder://ws-1/file.txt',
          sourceKind: 'drop-folder',
          description: 'Report',
          sourceAgentImUserId: 'im_agent_1',
        });
        expect(body.folderPath).toBe('reports');
        expect(body.description).toBe('Report');
        expect(body.sourceTaskId).toBe('task-1');
        expect(body.sourceAgentImUserId).toBe('im_agent_1');
        expect(body.sourceRef).toBe('folder://ws-1/file.txt');
        expect(body.sourceKind).toBe('drop-folder');
        return jsonResponse({ ok: true, data: { id: 'asset-direct', contentHash: digest } }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const client = new DaemonAssetUploadClient({
      cloudApiBase: 'http://cloud.test',
      apiKey: 'sk-test',
      fetchImpl,
    });

    const res = await client.uploadAsset({
      workspaceId: 'ws-1',
      filename: 'file.txt',
      bytes,
      mime: 'text/plain',
      size: bytes.length,
      kind: 'file',
      metadata: {
        sourceRef: 'folder://ws-1/file.txt',
        sourceKind: 'drop-folder',
        description: 'Report',
        sourceAgentImUserId: 'im_agent_1',
      },
      folderPath: 'reports',
      sourceTaskId: 'task-1',
    });

    expect(res).toEqual({ assetId: 'asset-direct', contentHash: digest });
    expect(calls.map((call) => call.url)).toEqual([
      'http://cloud.test/api/im/assets/direct-upload/init',
      'http://s3.test/object',
      'http://cloud.test/api/im/assets/direct-upload/complete',
    ]);
  });

  it('uploads signed multipart parts and sends ETags to complete', async () => {
    const bytes = Buffer.from('abcdef');
    const digest = sha256Hex(bytes);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/im/assets/direct-upload/init')) {
        return jsonResponse({
          ok: true,
          data: {
            mode: 'multipart',
            bucket: 'bucket',
            key: `assets/${digest}`,
            uploadId: 'upload-1',
            partSizeBytes: 3,
            parts: [
              { partNumber: 1, url: 'http://s3.test/part-1' },
              { partNumber: 2, url: 'http://s3.test/part-2' },
            ],
          },
        });
      }
      if (url === 'http://s3.test/part-1') {
        expect(Buffer.from((init?.body as Uint8Array) ?? []).toString()).toBe('abc');
        return new Response('', { status: 200, headers: { etag: '"etag-1"' } });
      }
      if (url === 'http://s3.test/part-2') {
        expect(Buffer.from((init?.body as Uint8Array) ?? []).toString()).toBe('def');
        return new Response('', { status: 200, headers: { etag: 'etag-2' } });
      }
      if (url.endsWith('/api/im/assets/direct-upload/complete')) {
        const body = JSON.parse(String(init?.body)) as { uploadId?: string; parts?: unknown };
        expect(body.uploadId).toBe('upload-1');
        expect(body.parts).toEqual([
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ]);
        return jsonResponse({ ok: true, data: { id: 'asset-multipart', contentHash: digest } }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const client = new DaemonAssetUploadClient({ cloudApiBase: 'http://cloud.test', apiKey: 'sk-test', fetchImpl });
    const res = await client.uploadAsset({
      workspaceId: 'ws-1',
      filename: 'parts.bin',
      bytes,
      mime: null,
      size: bytes.length,
      metadata: { sourceRef: 'agent://x/parts.bin', sourceKind: 'agent-gen' },
    });

    expect(res.assetId).toBe('asset-multipart');
  });

  it('falls back to multipart POST with SHA-256 header and form field', async () => {
    const bytes = Buffer.from('fallback body');
    const digest = sha256Hex(bytes);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/im/assets/direct-upload/init')) {
        return jsonResponse({ ok: false, error: 'unavailable' }, 503);
      }
      if (url.endsWith('/api/im/assets')) {
        expect((init?.headers as Record<string, string>)['X-Content-Sha256']).toBe(digest);
        const form = init?.body as FormData;
        expect(form.get('contentSha256')).toBe(digest);
        expect(form.get('workspaceId')).toBe('ws-1');
        expect(form.get('kind')).toBe('agent-output');
        expect(form.get('folderPath')).toBe('/tasks/task-1');
        expect(form.get('description')).toBe('Fallback report');
        expect(form.get('sourceTaskId')).toBe('task-1');
        expect(JSON.parse(String(form.get('metadata')))).toEqual({ taskId: 'task-1', description: 'Fallback report' });
        return jsonResponse({ ok: true, data: { id: 'asset-fallback', contentHash: digest } }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const client = new DaemonAssetUploadClient({ cloudApiBase: 'http://cloud.test', apiKey: 'sk-test', fetchImpl });
    const res = await client.uploadAsset({
      workspaceId: 'ws-1',
      filename: 'fallback.txt',
      bytes,
      mime: 'text/plain',
      size: bytes.length,
      kind: 'agent-output',
      metadata: { taskId: 'task-1', description: 'Fallback report' },
      folderPath: '/tasks/task-1',
    });

    expect(res).toEqual({ assetId: 'asset-fallback', contentHash: digest });
  });
});

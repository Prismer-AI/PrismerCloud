import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrismerClient } from '../../src/index';

type FetchCall = {
  url: string;
  method: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hashHex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('AssetsClient.upload', () => {
  it('uses direct upload and completes with SHA-256 metadata', async () => {
    const content = new TextEncoder().encode('hello direct asset');
    const sha256 = hashHex(content);
    const calls: FetchCall[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, headers: init?.headers, body: init?.body as BodyInit | null });

      if (url === 'https://api.test/api/im/assets/direct-upload/init') {
        return jsonResponse({
          ok: true,
          data: {
            mode: 'single',
            bucket: 'bucket',
            key: `assets/${sha256}`,
            uploadUrl: 'https://s3.test/upload',
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain', 'x-amz-meta-sha256': sha256 },
          },
        });
      }
      if (url === 'https://s3.test/upload') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://api.test/api/im/assets/direct-upload/complete') {
        return jsonResponse({
          ok: true,
          data: {
            id: 'asset-1',
            workspaceId: 'ws-1',
            contentHash: sha256,
            mime: 'text/plain',
            kind: 'file',
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'unexpected', message: url } }, 500);
    });
    const progress: Array<[number, number]> = [];
    const client = new PrismerClient({
      apiKey: 'eyJ.test.jwt',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.im.assets.upload(content, {
      workspaceId: 'ws-1',
      fileName: 'hello.txt',
      mimeType: 'text/plain',
      kind: 'file',
      metadata: { source: 'unit-test' },
      sourceTaskId: 'task-1',
      sourceAgentImUserId: 'agent-1',
      onProgress: (uploaded, total) => progress.push([uploaded, total]),
    });

    expect(result.ok).toBe(true);
    expect(result.data?.contentHash).toBe(sha256);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://api.test/api/im/assets/direct-upload/init'],
      ['PUT', 'https://s3.test/upload'],
      ['POST', 'https://api.test/api/im/assets/direct-upload/complete'],
    ]);

    const initBody = JSON.parse(String(calls[0]!.body));
    expect(initBody).toMatchObject({
      workspaceId: 'ws-1',
      filename: 'hello.txt',
      mime: 'text/plain',
      sizeBytes: content.byteLength,
      contentHash: sha256,
    });
    const completeBody = JSON.parse(String(calls[2]!.body));
    expect(completeBody).toMatchObject({
      workspaceId: 'ws-1',
      filename: 'hello.txt',
      contentHash: sha256,
      kind: 'file',
      sourceTaskId: 'task-1',
      sourceAgentImUserId: 'agent-1',
      bucket: 'bucket',
      key: `assets/${sha256}`,
      metadata: { source: 'unit-test' },
    });
    expect(progress).toContainEqual([content.byteLength, content.byteLength]);
  });

  it('falls back to multipart upload with hash headers when direct upload is unavailable', async () => {
    const content = new TextEncoder().encode('fallback bytes');
    const sha256 = hashHex(content);
    const calls: FetchCall[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, headers: init?.headers, body: init?.body as BodyInit | null });
      if (url === 'https://api.test/api/im/assets/direct-upload/init') {
        return jsonResponse({ ok: false, error: { code: 'asset_direct_upload_unavailable', message: 'local fs' } }, 503);
      }
      if (url === 'https://api.test/api/im/assets') {
        return jsonResponse({
          ok: true,
          data: { id: 'asset-fallback', workspaceId: 'ws-1', contentHash: sha256, mime: 'text/plain', kind: 'file' },
        }, 201);
      }
      return jsonResponse({ ok: false, error: { code: 'unexpected', message: url } }, 500);
    });
    const client = new PrismerClient({
      apiKey: 'eyJ.test.jwt',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.im.assets.upload(content, {
      workspaceId: 'ws-1',
      fileName: 'fallback.txt',
      mimeType: 'text/plain',
      metadata: { mode: 'fallback' },
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://api.test/api/im/assets/direct-upload/init'],
      ['POST', 'https://api.test/api/im/assets'],
    ]);
    expect((calls[1]!.headers as Record<string, string>)['X-Content-Sha256']).toBe(sha256);
    const form = calls[1]!.body as FormData;
    expect(form.get('workspaceId')).toBe('ws-1');
    expect(form.get('contentSha256')).toBe(sha256);
    expect(JSON.parse(String(form.get('metadata')))).toEqual({ mode: 'fallback' });
    const uploadedFile = form.get('file') as File;
    expect(uploadedFile.name).toBe('fallback.txt');
    expect(uploadedFile.type).toBe('text/plain');
  });

  it('uploads multipart direct parts and completes with ETags', async () => {
    const content = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const sha256 = hashHex(content);
    const calls: FetchCall[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, headers: init?.headers, body: init?.body as BodyInit | null });
      if (url === 'https://api.test/api/im/assets/direct-upload/init') {
        return jsonResponse({
          ok: true,
          data: {
            mode: 'multipart',
            bucket: 'bucket',
            key: `assets/${sha256}`,
            uploadId: 'upload-1',
            partSizeBytes: 3,
            parts: [
              { partNumber: 1, url: 'https://s3.test/part-1' },
              { partNumber: 2, url: 'https://s3.test/part-2' },
            ],
          },
        });
      }
      if (url === 'https://s3.test/part-1') {
        return new Response('', { status: 200, headers: { ETag: '"etag-1"' } });
      }
      if (url === 'https://s3.test/part-2') {
        return new Response('', { status: 200, headers: { ETag: '"etag-2"' } });
      }
      if (url === 'https://api.test/api/im/assets/direct-upload/complete') {
        return jsonResponse({
          ok: true,
          data: { id: 'asset-multipart', workspaceId: 'ws-1', contentHash: sha256, mime: 'application/octet-stream' },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'unexpected', message: url } }, 500);
    });
    const progress: Array<[number, number]> = [];
    const client = new PrismerClient({
      apiKey: 'eyJ.test.jwt',
      baseUrl: 'https://api.test',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.im.assets.upload(content, {
      workspaceId: 'ws-1',
      fileName: 'binary.bin',
      onProgress: (uploaded, total) => progress.push([uploaded, total]),
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://api.test/api/im/assets/direct-upload/init'],
      ['PUT', 'https://s3.test/part-1'],
      ['PUT', 'https://s3.test/part-2'],
      ['POST', 'https://api.test/api/im/assets/direct-upload/complete'],
    ]);
    const completeBody = JSON.parse(String(calls[3]!.body));
    expect(completeBody).toMatchObject({
      uploadId: 'upload-1',
      parts: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
      ],
    });
    expect(progress).toEqual([[3, 6], [6, 6]]);
  });
});

/**
 * ArtifactUploader tests (v1.9.x Task 2).
 *
 * Mocks fetch and the filesystem to drive the three-step upload flow:
 *   1. POST /api/im/artifacts/presign → { uploadId, url, fields }
 *   2. POST <url>                     → S3 (or dev-upload)
 *   3. POST /api/im/artifacts/confirm → { uploadId, cdnUrl }
 *
 * Covers happy path + the three failure modes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactUploader } from '../src/artifacts-uploader';

const API_KEY = 'sk-prismer-live-test-XYZ';
const CLOUD_BASE = 'https://cloud.prismer.dev';

function makeTempFile(content: string | Buffer = 'hello world'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-uploader-'));
  const file = path.join(dir, 'output.png');
  fs.writeFileSync(file, content);
  return file;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ArtifactUploader', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = makeTempFile(Buffer.from('PNG-bytes-here', 'utf8'));
  });

  it('happy path: presign → POST → confirm returns { ok, uploadId, cdnUrl }', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/im/artifacts/presign')) {
        // Sanity check headers + body shape.
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.taskId).toBe('task-abc');
        expect(body.fileName).toBe('output.png');
        expect(typeof body.fileSize).toBe('number');
        return jsonResponse(201, {
          ok: true,
          data: {
            uploadId: 'fu_test_123',
            url: 'https://s3.test/upload-target',
            fields: { key: 'k', policy: 'p', 'Content-Type': 'image/png' },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            taskId: 'task-abc',
          },
        });
      }
      if (u === 'https://s3.test/upload-target') {
        // S3 returns 204 No Content on successful presigned-POST.
        expect(init?.method).toBe('POST');
        // FormData body — just sanity check we sent something.
        expect(init?.body).toBeDefined();
        // Use 200 (not 204): Response constructor in undici rejects 204 with a body.
        return new Response('', { status: 200 });
      }
      if (u.endsWith('/api/im/artifacts/confirm')) {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.uploadId).toBe('fu_test_123');
        return jsonResponse(200, {
          ok: true,
          data: {
            uploadId: 'fu_test_123',
            cdnUrl: 'https://cdn.prismer.dev/uploads/fu_test_123/output.png',
            fileName: 'output.png',
            fileSize: 14,
            mimeType: 'image/png',
            sha256: 'abc',
            cost: 1,
          },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await uploader.upload('task-abc', tmpFile);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uploadId).toBe('fu_test_123');
      expect(result.cdnUrl).toBe('https://cdn.prismer.dev/uploads/fu_test_123/output.png');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('presign 4xx → returns { ok:false, error } (no throw, no upload, no confirm)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/im/artifacts/presign')) {
        return jsonResponse(403, { ok: false, error: 'INSUFFICIENT_CREDITS' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await uploader.upload('task-abc', tmpFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/presign_403/);
    }
    // Only the presign call should have happened — no upload or confirm.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('S3 POST 4xx → returns { ok:false, error } and does NOT call confirm', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/im/artifacts/presign')) {
        return jsonResponse(201, {
          ok: true,
          data: {
            uploadId: 'fu_test_456',
            url: 'https://s3.test/upload-target',
            fields: { key: 'k' },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            taskId: 'task-abc',
          },
        });
      }
      if (u === 'https://s3.test/upload-target') {
        return new Response('AccessDenied', { status: 403 });
      }
      // Anything else (especially confirm) is a test failure.
      throw new Error(`unexpected fetch: ${u}`);
    });

    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await uploader.upload('task-abc', tmpFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/upload_403/);
    }
    // Exactly two calls: presign + the failed S3 POST. Confirm must NOT run.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('/confirm'))).toBe(false);
  });

  it('confirm 4xx → returns { ok:false, error } even if presign + S3 succeeded', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/im/artifacts/presign')) {
        return jsonResponse(201, {
          ok: true,
          data: {
            uploadId: 'fu_test_789',
            url: 'https://s3.test/upload-target',
            fields: { key: 'k' },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            taskId: 'task-abc',
          },
        });
      }
      if (u === 'https://s3.test/upload-target') {
        // Use 200 (not 204): Response constructor in undici rejects 204 with a body.
        return new Response('', { status: 200 });
      }
      if (u.endsWith('/api/im/artifacts/confirm')) {
        return jsonResponse(409, { ok: false, error: 'INVALID_STATE' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await uploader.upload('task-abc', tmpFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/confirm_409/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('missing taskId → { ok:false, error } (does not call fetch)', async () => {
    const fetchMock = vi.fn();
    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await uploader.upload('', tmpFile);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-existent file → { ok:false, error } (does not call fetch)', async () => {
    const fetchMock = vi.fn();
    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const result = await uploader.upload('task-abc', '/no/such/file.png');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/read_failed/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('file > 10MB → { ok:false, error: artifact_too_large:* } and does NOT call fetch (presign)', async () => {
    // Create a temp file just over 10MB so the size guard trips.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-uploader-large-'));
    const bigFile = path.join(dir, 'huge.bin');
    const ELEVEN_MB = 11 * 1024 * 1024;
    await fs.promises.writeFile(bigFile, Buffer.alloc(ELEVEN_MB));

    try {
      const fetchMock = vi.fn();
      const uploader = new ArtifactUploader({
        apiKey: API_KEY,
        cloudApiBase: CLOUD_BASE,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      const result = await uploader.upload('t1', bigFile);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.startsWith('artifact_too_large:')).toBe(true);
        // Sanity: error includes the actual byte size so ops can grep.
        expect(result.error).toContain(String(ELEVEN_MB));
      }
      // Critical: presign must NOT have been attempted — the whole point of
      // the size guard is to refuse before talking to the cloud.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await fs.promises.unlink(bigFile).catch(() => {});
      await fs.promises.rmdir(dir).catch(() => {});
    }
  });

  it('relative dev-upload URL is resolved against cloudApiBase', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/im/artifacts/presign')) {
        return jsonResponse(201, {
          ok: true,
          data: {
            uploadId: 'fu_dev_001',
            url: '/api/im/files/dev-upload/fu_dev_001',
            fields: { 'Content-Type': 'image/png' },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            taskId: 'task-abc',
          },
        });
      }
      if (u === `${CLOUD_BASE}/api/im/files/dev-upload/fu_dev_001`) {
        return jsonResponse(200, { ok: true, data: { uploaded: true, size: 14 } });
      }
      if (u.endsWith('/api/im/artifacts/confirm')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            uploadId: 'fu_dev_001',
            cdnUrl: '/api/im/files/dev-download/fu_dev_001/output.png',
            fileName: 'output.png',
            fileSize: 14,
            mimeType: 'image/png',
            sha256: 'abc',
            cost: 1,
          },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const uploader = new ArtifactUploader({
      apiKey: API_KEY,
      cloudApiBase: CLOUD_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await uploader.upload('task-abc', tmpFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uploadId).toBe('fu_dev_001');
    }
  });
});

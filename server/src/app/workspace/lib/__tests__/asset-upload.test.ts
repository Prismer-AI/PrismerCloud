import { describe, expect, it, vi } from 'vitest';

import { uploadAssetWithDirectFallback } from '../asset-upload';
import type { FetchResult } from '../im-api';

function ok<T>(data: T): FetchResult<T> {
  return { ok: true, data };
}

function fail(status: number, error: string): FetchResult<never> {
  return { ok: false, status, error, message: error };
}

function file(contents = 'hello'): File {
  return new File([contents], 'note.txt', { type: 'text/plain' });
}

function asset(id: string) {
  return {
    id,
    workspaceId: 'ws-1',
    contentHash: 'hash',
    sizeBytes: 5,
    mime: 'text/plain',
    kind: 'file',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('uploadAssetWithDirectFallback', () => {
  it.each([404, 501, 503])('falls back to multipart when direct init returns %s', async (status) => {
    const imFetch = vi
      .fn()
      .mockResolvedValueOnce(fail(status, `HTTP_${status}`))
      .mockResolvedValueOnce(ok(asset('multipart-1')));

    const res = await uploadAssetWithDirectFallback({
      file: file(),
      workspaceId: 'ws-1',
      metadata: { title: 'note.txt', conversationId: 'conv-1' },
      imFetch,
    });

    expect(res).toEqual(ok(asset('multipart-1')));
    expect(imFetch).toHaveBeenCalledTimes(2);
    expect(imFetch.mock.calls[0]?.[0]).toBe('/assets/direct-upload/init');
    expect(imFetch.mock.calls[1]?.[0]).toBe('/assets');
    expect(imFetch.mock.calls[1]?.[1]?.headers).toHaveProperty('X-Content-Sha256');
  });

  it('uploads via single signed PUT and completes without multipart fallback', async () => {
    const imFetch = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          mode: 'single',
          bucket: 'bucket',
          key: 'assets/hash',
          uploadUrl: 'https://signed.example/upload',
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain', 'x-amz-meta-sha256': 'abc' },
        }),
      )
      .mockResolvedValueOnce(ok(asset('direct-1')));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const res = await uploadAssetWithDirectFallback({
      file: file(),
      workspaceId: 'ws-1',
      metadata: { title: 'note.txt' },
      sourceTaskId: 'task-1',
      imFetch,
      fetchImpl,
    });

    expect(res).toEqual(ok(asset('direct-1')));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://signed.example/upload');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'x-amz-meta-sha256': 'abc' },
    });
    expect(imFetch.mock.calls.map((call) => call[0])).toEqual([
      '/assets/direct-upload/init',
      '/assets/direct-upload/complete',
    ]);
  });

  it('falls back to multipart when signed PUT fails', async () => {
    const imFetch = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          mode: 'single',
          bucket: 'bucket',
          key: 'assets/hash',
          uploadUrl: 'https://signed.example/upload',
        }),
      )
      .mockResolvedValueOnce(ok(asset('multipart-after-put-fail')));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const res = await uploadAssetWithDirectFallback({
      file: file(),
      workspaceId: 'ws-1',
      metadata: { title: 'note.txt' },
      imFetch,
      fetchImpl,
    });

    expect(res).toEqual(ok(asset('multipart-after-put-fail')));
    expect(imFetch.mock.calls.map((call) => call[0])).toEqual(['/assets/direct-upload/init', '/assets']);
  });

  it('falls back to multipart when direct complete fails', async () => {
    const imFetch = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          mode: 'single',
          bucket: 'bucket',
          key: 'assets/hash',
          uploadUrl: 'https://signed.example/upload',
        }),
      )
      .mockResolvedValueOnce(fail(422, 'upload_hash_mismatch'))
      .mockResolvedValueOnce(ok(asset('multipart-after-complete-fail')));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const res = await uploadAssetWithDirectFallback({
      file: file(),
      workspaceId: 'ws-1',
      metadata: { title: 'note.txt' },
      imFetch,
      fetchImpl,
    });

    expect(res).toEqual(ok(asset('multipart-after-complete-fail')));
    expect(imFetch.mock.calls.map((call) => call[0])).toEqual([
      '/assets/direct-upload/init',
      '/assets/direct-upload/complete',
      '/assets',
    ]);
  });
});

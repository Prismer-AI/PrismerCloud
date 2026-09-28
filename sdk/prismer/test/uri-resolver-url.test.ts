// Tests for L5: UriResolver.rewrite() picking up bare http(s) URLs in
// prompt + context strings, fetching with SSRF/size guards, and rewriting
// to file:// paths.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetCache, __setUrlFetchDeps } from '../src/asset-cache.js';
import type { CloudClient } from '../src/auth.js';
import { openLocalDb } from '../src/sync/store.js';
import {
  UriResolver,
  extractHttpUrls,
  type UrlResolution,
} from '../src/uri-resolver.js';
import type { AssetDispatchObservation } from '../src/types/im-events.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function setupResolver() {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-url-resolver-'));
  const db = openLocalDb(':memory:');
  const cloud = { fetchRaw: async () => new Response('', { status: 500 }) } as unknown as CloudClient;
  const cache = new AssetCache({ db, cloud, cacheDir: join(dir, 'cache') });
  const resolver = new UriResolver({ db, cloud, assetCache: cache });
  return { dir, resolver, cache };
}

describe('extractHttpUrls', () => {
  it('finds bare urls', () => {
    expect(extractHttpUrls('see https://example.com/x and http://foo.bar/y')).toEqual([
      'https://example.com/x',
      'http://foo.bar/y',
    ]);
  });
  it('strips trailing punctuation', () => {
    expect(extractHttpUrls('check https://example.com/page.')).toEqual([
      'https://example.com/page',
    ]);
    expect(extractHttpUrls('see https://example.com/x, then https://example.com/y)')).toEqual([
      'https://example.com/x',
      'https://example.com/y',
    ]);
  });
  it('dedupes identical urls', () => {
    expect(extractHttpUrls('https://example.com/x and https://example.com/x again')).toEqual([
      'https://example.com/x',
    ]);
  });
  it('ignores non-http schemes', () => {
    expect(extractHttpUrls('file:///etc/passwd ftp://x.y/z')).toEqual([]);
  });
});

describe('UriResolver.rewrite — L5 http(s)', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    __setUrlFetchDeps({});
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rewrites a single https URL to file://<localPath>', async () => {
    const { dir, resolver } = setupResolver();
    cleanup.push(dir);
    const body = Buffer.from('hello world');
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    });
    const obs: AssetDispatchObservation[] = [];
    const r = await resolver.rewrite('look at https://example.com/page please', {
      urlObservations: obs,
    });
    expect(r.text).toMatch(/look at file:\/\/.* please/);
    expect(r.resolvedHashes).toContain(sha256(body));
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      strategy: 'fetched-https',
      originalUrl: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      contentHash: sha256(body),
    });
  });

  it('emits an error observation when the URL is SSRF-rejected and leaves the URL in place', async () => {
    const { dir, resolver } = setupResolver();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async () => ['127.0.0.1'],
      fetch: async () => new Response('nope', { status: 200 }),
    });
    const obs: AssetDispatchObservation[] = [];
    const r = await resolver.rewrite('curl https://localhost/admin now', {
      urlObservations: obs,
    });
    // URL still in text (best-effort failure).
    expect(r.text).toContain('https://localhost/admin');
    expect(r.text).not.toMatch(/file:\/\//);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ strategy: 'error', originalUrl: 'https://localhost/admin' });
    expect(obs[0]!.error).toMatch(/SSRF guard/);
  });

  it('emits an error observation on 4xx and does not cache', async () => {
    const { dir, resolver, cache } = setupResolver();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => new Response('missing', { status: 404 }),
    });
    const obs: AssetDispatchObservation[] = [];
    const r = await resolver.rewrite('fetch https://example.com/missing right now', {
      urlObservations: obs,
    });
    expect(r.text).toContain('https://example.com/missing');
    expect(r.text).not.toMatch(/file:\/\//);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ strategy: 'error' });
    expect((cache as unknown as { totalBytes(): number }).totalBytes()).toBe(0);
  });

  it('dedupes within one rewrite call and across rewriteAll using shared urlCache', async () => {
    const { dir, resolver } = setupResolver();
    cleanup.push(dir);
    const body = Buffer.from('shared');
    let fetches = 0;
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => {
        fetches += 1;
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      },
    });
    const urlCache = new Map<string, UrlResolution>();
    const obs: AssetDispatchObservation[] = [];
    await resolver.rewrite('one https://example.com/x and two https://example.com/x', {
      urlCache,
      urlObservations: obs,
    });
    await resolver.rewriteAll(['three https://example.com/x', 'four https://example.com/x'], {
      urlCache,
      urlObservations: obs,
    });
    // Only one fetch total — every reference hit the urlCache after the
    // first miss.
    expect(fetches).toBe(1);
    // Only one observation row (the unique URL).
    expect(obs).toHaveLength(1);
  });

  it('skips fetching when fetchUrls=false (used for server-composed memory/goal text)', async () => {
    const { dir, resolver } = setupResolver();
    cleanup.push(dir);
    let called = false;
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => {
        called = true;
        return new Response('x', { status: 200 });
      },
    });
    const r = await resolver.rewrite('see https://example.com/x in docs', { fetchUrls: false });
    expect(called).toBe(false);
    expect(r.text).toContain('https://example.com/x');
  });

  it('lucky collision: URL bytes match a prismer:// asset already in cache → reuse same row', async () => {
    const { dir, resolver, cache } = setupResolver();
    cleanup.push(dir);
    const body = Buffer.from('identical-bytes-across-sources');
    const hash = sha256(body);

    // Seed cache via getOrFetch (simulating a prior prismer:// resolution).
    const seedCloud = {
      fetchRaw: async (path: string) => {
        if (path.startsWith('/api/im/assets/by-hash/')) {
          return new Response(JSON.stringify({ ok: true, data: { id: 'asset_x' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      },
    } as unknown as CloudClient;
    // Swap the cache's cloud client out for one call only.
    (cache as unknown as { cloud: CloudClient }).cloud = seedCloud;
    const seeded = await cache.getOrFetch(hash, { workspaceIdHint: 'ws_1' });
    expect(seeded.localPath).toBeDefined();

    // Now resolve the same bytes via an https URL — should reuse the row.
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    });
    const obs: AssetDispatchObservation[] = [];
    const r = await resolver.rewrite('see https://example.com/dup', { urlObservations: obs });
    expect(r.text).toContain(`file://${seeded.localPath}`);
    expect(r.resolvedHashes).toContain(hash);
  });

  it('does not regress prismer:// resolution when no http URLs are present', async () => {
    const { dir, resolver } = setupResolver();
    cleanup.push(dir);
    // No http URL → no fetch happens; the fetch shouldn't even be installed.
    const obs: AssetDispatchObservation[] = [];
    const r = await resolver.rewrite('just plain text here', { urlObservations: obs });
    expect(r.text).toBe('just plain text here');
    expect(r.resolvedHashes).toEqual([]);
    expect(obs).toEqual([]);
  });
});

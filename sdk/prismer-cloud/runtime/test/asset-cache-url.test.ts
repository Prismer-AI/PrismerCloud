// Unit tests for AssetCache.getOrFetchUrl — SSRF guard, size limit,
// redirect handling, cross-host redirect SSRF re-check, content-hash dedup.
//
// Test seam: src/asset-cache.ts exposes `__setUrlFetchDeps` so tests inject
// a fake fetch + a fake DNS resolver. Real network is never touched.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AssetCache,
  __setUrlFetchDeps,
  isForbiddenIp,
} from '../src/asset-cache.js';
import type { CloudClient } from '../src/auth.js';
import { openLocalDb } from '../src/sync/store.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeCache(): { cache: AssetCache; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-url-cache-'));
  const db = openLocalDb(':memory:');
  const cloud = { fetchRaw: async () => new Response('', { status: 500 }) } as unknown as CloudClient;
  return { cache: new AssetCache({ db, cloud, cacheDir: join(dir, 'cache') }), dir };
}

describe('isForbiddenIp', () => {
  it('rejects loopback v4', () => {
    expect(isForbiddenIp('127.0.0.1')).toBe(true);
    expect(isForbiddenIp('127.255.0.1')).toBe(true);
  });
  it('rejects RFC1918 v4', () => {
    expect(isForbiddenIp('10.0.0.1')).toBe(true);
    expect(isForbiddenIp('172.16.0.1')).toBe(true);
    expect(isForbiddenIp('172.31.255.255')).toBe(true);
    expect(isForbiddenIp('192.168.1.1')).toBe(true);
  });
  it('rejects link-local + cloud metadata', () => {
    expect(isForbiddenIp('169.254.0.1')).toBe(true);
    expect(isForbiddenIp('169.254.169.254')).toBe(true);
  });
  it('rejects IPv6 loopback + link-local + ULA', () => {
    expect(isForbiddenIp('::1')).toBe(true);
    expect(isForbiddenIp('fe80::1')).toBe(true);
    expect(isForbiddenIp('fc00::1')).toBe(true);
    expect(isForbiddenIp('fd12:3456::1')).toBe(true);
  });
  it('rejects IPv4-mapped private addresses', () => {
    expect(isForbiddenIp('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenIp('::ffff:169.254.169.254')).toBe(true);
  });
  it('rejects 172.15.x.x — outside RFC1918 12-bit prefix? No, allows it', () => {
    // 172.15 is OUTSIDE 172.16/12 — public.
    expect(isForbiddenIp('172.15.0.1')).toBe(false);
    // 172.32 is also outside — public.
    expect(isForbiddenIp('172.32.0.1')).toBe(false);
  });
  it('allows public IPs', () => {
    expect(isForbiddenIp('1.1.1.1')).toBe(false);
    expect(isForbiddenIp('8.8.8.8')).toBe(false);
    expect(isForbiddenIp('93.184.216.34')).toBe(false); // example.com circa 2024
    expect(isForbiddenIp('2606:4700:4700::1111')).toBe(false); // 1.1.1.1 v6
  });
});

describe('AssetCache.getOrFetchUrl', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    __setUrlFetchDeps({});
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('happy path: fetches a small body, caches by sha256, returns local path', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    const body = Buffer.from('hello world');
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
    });
    const r = await cache.getOrFetchUrl('https://example.com/x');
    expect(r.cached.contentHash).toBe(sha256(body));
    expect(r.cached.sizeBytes).toBe(body.length);
    expect(r.cached.mime).toBe('text/plain');
    expect(existsSync(r.cached.localPath)).toBe(true);
    expect(r.finalUrl).toBe('https://example.com/x');
  });

  it('content-hash dedup: second call reuses the existing cache row', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    const body = Buffer.from('same payload');
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    });
    const first = await cache.getOrFetchUrl('https://a.example.com/');
    const second = await cache.getOrFetchUrl('https://b.example.com/different-path?q=1');
    expect(first.cached.contentHash).toBe(second.cached.contentHash);
    expect(first.cached.localPath).toBe(second.cached.localPath);
  });

  it('rejects loopback', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async () => ['127.0.0.1'],
      fetch: async () => new Response('should not run', { status: 200 }),
    });
    await expect(cache.getOrFetchUrl('https://localhost/x')).rejects.toThrow(/SSRF guard/);
  });

  it('rejects AWS metadata endpoint', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async () => ['169.254.169.254'],
      fetch: async () => new Response('credentials', { status: 200 }),
    });
    await expect(
      cache.getOrFetchUrl('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/SSRF guard/);
  });

  it('rejects RFC1918 even if hostname looks public', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({
      // DNS rebinding scenario.
      resolveHostname: async () => ['10.0.0.5'],
      fetch: async () => new Response('intranet', { status: 200 }),
    });
    await expect(cache.getOrFetchUrl('https://looks-public.com/x')).rejects.toThrow(/SSRF guard/);
  });

  it('rejects non-http(s) scheme', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({ resolveHostname: async () => ['1.2.3.4'] });
    await expect(cache.getOrFetchUrl('file:///etc/passwd')).rejects.toThrow(/unsupported scheme/);
    await expect(cache.getOrFetchUrl('gopher://example.com/x')).rejects.toThrow(/unsupported scheme/);
  });

  it('size limit aborts streaming body that grows beyond cap', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    const chunkSize = 64 * 1024;
    const chunk = new Uint8Array(chunkSize);
    chunk.fill(0x41);
    let chunksSent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksSent >= 200) {
          controller.close();
          return;
        }
        chunksSent += 1;
        controller.enqueue(chunk);
      },
    });
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () =>
        new Response(stream, {
          status: 200,
          // Intentionally no content-length — force the streaming-abort path.
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    });
    await expect(
      cache.getOrFetchUrl('https://example.com/big', { maxBytes: 5 * 1024 * 1024 }),
    ).rejects.toThrow(/body too large/);
    // Never read all 200 chunks before aborting; ~80 is enough to cross 5 MB.
    expect(chunksSent).toBeLessThan(200);
  });

  it('rejects via content-length pre-check when header is honest', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () =>
        new Response('x', {
          status: 200,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(50 * 1024 * 1024) },
        }),
    });
    await expect(
      cache.getOrFetchUrl('https://example.com/huge', { maxBytes: 5 * 1024 * 1024 }),
    ).rejects.toThrow(/content-length/);
  });

  it('4xx returns an error (no cache write)', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => new Response('not found', { status: 404 }),
    });
    await expect(cache.getOrFetchUrl('https://example.com/missing')).rejects.toThrow(/HTTP 404/);
    // Verify nothing landed in cache.
    const all = (cache as unknown as { totalBytes(): number }).totalBytes();
    expect(all).toBe(0);
  });

  it('follows up to N redirects and rewrites finalUrl', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    const body = Buffer.from('done');
    const calls: string[] = [];
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async (input) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(urlStr);
        if (urlStr === 'https://a.example.com/start') {
          return new Response(null, { status: 302, headers: { Location: 'https://b.example.com/mid' } });
        }
        if (urlStr === 'https://b.example.com/mid') {
          return new Response(null, { status: 301, headers: { Location: 'https://c.example.com/end' } });
        }
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      },
    });
    const r = await cache.getOrFetchUrl('https://a.example.com/start');
    expect(r.finalUrl).toBe('https://c.example.com/end');
    expect(r.cached.contentHash).toBe(sha256(body));
    expect(calls.length).toBe(3);
  });

  it('rejects cross-host redirect that points at a private IP', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    __setUrlFetchDeps({
      resolveHostname: async (host: string) => {
        if (host === 'public.example.com') return ['1.2.3.4'];
        if (host === 'intranet.evil.example') return ['10.0.0.5'];
        throw new Error(`unexpected host ${host}`);
      },
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://public.example.com')) {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://intranet.evil.example/secrets' },
          });
        }
        return new Response('should never reach', { status: 200 });
      },
    });
    await expect(cache.getOrFetchUrl('https://public.example.com/start')).rejects.toThrow(
      /SSRF guard/,
    );
  });

  it('rejects after exceeding max redirects (default 3)', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    let hop = 0;
    __setUrlFetchDeps({
      resolveHostname: async () => ['1.2.3.4'],
      fetch: async () => {
        hop += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: `https://example.com/hop-${hop}` },
        });
      },
    });
    await expect(
      cache.getOrFetchUrl('https://example.com/start', { maxRedirects: 2 }),
    ).rejects.toThrow(/too many redirects/);
  });

  it('respects PRISMER_URL_FETCH_MAX_BYTES env override', async () => {
    const { cache, dir } = makeCache();
    cleanup.push(dir);
    const prev = process.env.PRISMER_URL_FETCH_MAX_BYTES;
    process.env.PRISMER_URL_FETCH_MAX_BYTES = '128';
    try {
      __setUrlFetchDeps({
        resolveHostname: async () => ['1.2.3.4'],
        fetch: async () =>
          new Response(Buffer.alloc(256, 0x42), {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
      });
      await expect(cache.getOrFetchUrl('https://example.com/x')).rejects.toThrow(/body too large/);
    } finally {
      if (prev === undefined) delete process.env.PRISMER_URL_FETCH_MAX_BYTES;
      else process.env.PRISMER_URL_FETCH_MAX_BYTES = prev;
    }
  });
});

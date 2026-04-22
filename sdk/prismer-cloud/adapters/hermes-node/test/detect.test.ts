import { describe, expect, it } from 'vitest';
import { detectHermesLoopback } from '../src/detect.js';

describe('detectHermesLoopback', () => {
  it('returns found=true when /health responds 200', async () => {
    const fakeFetch = (async () =>
      new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;

    const result = await detectHermesLoopback({ port: 8765, fetchImpl: fakeFetch });
    expect(result.found).toBe(true);
    expect(result.loopbackUrl).toBe('http://127.0.0.1:8765');
  });

  it('returns found=false with http_<status> reason on non-2xx', async () => {
    const fakeFetch = (async () =>
      new Response('{"error":"nope"}', { status: 503 })) as unknown as typeof fetch;

    const result = await detectHermesLoopback({ port: 8765, fetchImpl: fakeFetch });
    expect(result.found).toBe(false);
    expect(result.reason).toBe('http_503');
  });

  it('returns reason=timeout on abort', async () => {
    const fakeFetch = ((_input: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err: Error & { name: string } = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;

    const result = await detectHermesLoopback({
      port: 8765,
      timeoutMs: 10,
      fetchImpl: fakeFetch,
    });
    expect(result.found).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('returns reason=refused on ECONNREFUSED', async () => {
    const fakeFetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
    }) as unknown as typeof fetch;

    const result = await detectHermesLoopback({ port: 8765, fetchImpl: fakeFetch });
    expect(result.found).toBe(false);
    expect(result.reason).toBe('refused');
  });

  it('uses the default port when none given', async () => {
    let called = '';
    const fakeFetch = (async (url: string) => {
      called = url;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await detectHermesLoopback({ fetchImpl: fakeFetch });
    expect(called).toBe('http://127.0.0.1:8765/health');
  });

  it('honors a custom port', async () => {
    let called = '';
    const fakeFetch = (async (url: string) => {
      called = url;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await detectHermesLoopback({ port: 19876, fetchImpl: fakeFetch });
    expect(called).toBe('http://127.0.0.1:19876/health');
  });
});

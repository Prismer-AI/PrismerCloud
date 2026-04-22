import { describe, expect, it } from 'vitest';
import { buildHermesAdapter } from '../src/build.js';

describe('buildHermesAdapter', () => {
  it('produces an AdapterImpl with Hermes defaults', () => {
    const adapter = buildHermesAdapter();
    expect(adapter.name).toBe('hermes');
    expect(adapter.tiersSupported).toEqual([1, 2, 3, 4]);
    expect(adapter.capabilityTags).toEqual(['code', 'llm', 'cache-safe-inject']);
    expect(adapter.metadata?.transport).toBe('mode_b_http_loopback');
    expect(adapter.metadata?.loopbackUrl).toBe('http://127.0.0.1:8765');
  });

  it('honors an explicit port', () => {
    const adapter = buildHermesAdapter({ port: 19876 });
    expect(adapter.metadata?.loopbackUrl).toBe('http://127.0.0.1:19876');
  });

  it('honors an explicit loopbackUrl (overrides port)', () => {
    const adapter = buildHermesAdapter({
      loopbackUrl: 'http://127.0.0.1:30000',
      port: 8765, // ignored
    });
    expect(adapter.metadata?.loopbackUrl).toBe('http://127.0.0.1:30000');
  });

  it('rejects non-loopback hosts', () => {
    expect(() =>
      buildHermesAdapter({ loopbackUrl: 'http://evil.example.com:8765' }),
    ).toThrow(/127\.0\.0\.1/);
  });

  it('rejects https scheme', () => {
    expect(() =>
      buildHermesAdapter({ loopbackUrl: 'https://127.0.0.1:8765' }),
    ).toThrow(/http:/);
  });

  it('rejects pathname in loopback URL', () => {
    expect(() =>
      buildHermesAdapter({ loopbackUrl: 'http://127.0.0.1:8765/evil' }),
    ).toThrow(/origin-only/);
  });

  it('dispatch() POSTs a v1-shape body and returns the parsed JSON result', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          ok: true,
          output: 'hi from hermes',
          metadata: { api_calls: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const adapter = buildHermesAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.dispatch({
      taskId: 't_abc',
      capability: 'code.write',
      prompt: 'hello',
      stepIdx: 2,
      deadlineAt: 123456789,
    });

    expect(capturedUrl).toBe('http://127.0.0.1:8765/dispatch');
    expect(capturedBody).toEqual({
      taskId: 't_abc',
      capability: 'code.write',
      prompt: 'hello',
      stepIdx: 2,
      deadlineAt: 123456789,
    });
    expect(result).toEqual({
      ok: true,
      output: 'hi from hermes',
      metadata: { api_calls: 2 },
    });
  });

  it('dispatch() maps non-2xx to mode_b_<status>', async () => {
    const fakeFetch = (async () =>
      new Response('service unavailable', { status: 503 })) as unknown as typeof fetch;

    const adapter = buildHermesAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.dispatch({ taskId: 't', capability: 'c', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^mode_b_503/);
  });

  it('dispatch() maps JSON parse failure to mode_b_invalid_response', async () => {
    const fakeFetch = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;

    const adapter = buildHermesAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.dispatch({ taskId: 't', capability: 'c', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^mode_b_invalid_response/);
  });

  it('dispatch() maps network error to mode_b_network', async () => {
    const fakeFetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const adapter = buildHermesAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.dispatch({ taskId: 't', capability: 'c', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^mode_b_network/);
  });

  it('health() returns healthy=true on 200', async () => {
    const fakeFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const adapter = buildHermesAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.health!();
    expect(result.healthy).toBe(true);
  });

  it('health() returns healthy=false with loopback_<status> on non-2xx', async () => {
    const fakeFetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const adapter = buildHermesAdapter({ fetchImpl: fakeFetch });
    const result = await adapter.health!();
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe('loopback_500');
  });
});

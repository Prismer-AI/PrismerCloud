// Tests for `pair()` flow, with focus on the Wave-6 α LOCAL_ONLY bypass.
// The standard QR path is exercised by an existing in-process e2e (cloud
// stack); these tests cover the new `asUserEmail` branch and the CLI-side
// LOCAL_ONLY gate.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pair } from '../src/pair.js';
import { resolvePaths } from '../src/config.js';

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'prismer-pair-test-'));
}

function mkResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('pair() LOCAL_ONLY bypass', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it('refuses --as-user without LOCAL_ONLY=1', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const fetchImpl = vi.fn();
    await expect(
      pair({
        cloudBaseUrl: 'http://localhost:3000',
        asUserEmail: 'admintest1@local.test',
        isLocalOnly: () => false,
        paths: resolvePaths(home),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/--as-user requires LOCAL_ONLY=1/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('LOCAL_ONLY=1 path: skips QR, calls /local-only-approve, writes config', async () => {
    const home = tmpHome();
    cleanup.push(home);

    // Sequence: POST /pair/offer → POST /pair/local-only-approve → GET /pair/poll
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/im/pair/offer') && method === 'POST') {
        return mkResponse(200, {
          ok: true,
          data: {
            nonce: 'nonce-test-1',
            qrUrl: 'prismer://pair?nonce=nonce-test-1&pub=x',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          },
        });
      }
      if (url.endsWith('/api/im/pair/local-only-approve') && method === 'POST') {
        return mkResponse(200, { ok: true });
      }
      if (url.includes('/api/im/pair/poll/') && method === 'GET') {
        return mkResponse(200, {
          ok: true,
          data: { status: 'approved', apiKey: 'sk-prismer-live-' + 'a'.repeat(64) },
        });
      }
      return mkResponse(404, { ok: false, error: { message: 'unexpected' } });
    });

    const onQrReady = vi.fn();
    const result = await pair({
      cloudBaseUrl: 'http://localhost:3000',
      asUserEmail: 'admintest1@local.test',
      isLocalOnly: () => true,
      paths: resolvePaths(home),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1, // skip the 5s sleep
      onQrReady,
    });

    expect(result.config.api_key).toMatch(/^sk-prismer-live-/);
    expect(result.config.cloud_api_base).toBe('http://localhost:3000');
    expect(result.config.daemon_id).toBeTruthy();
    expect(existsSync(result.paths.configFile)).toBe(true);
    const written = readFileSync(result.paths.configFile, 'utf8');
    expect(written).toContain('api_key');
    expect(written).toContain('daemon_id');

    // QR hook MUST NOT fire in LOCAL_ONLY mode.
    expect(onQrReady).not.toHaveBeenCalled();

    // Verify the cloud call sequence + payloads.
    const offerCall = calls.find((c) => c.url.endsWith('/api/im/pair/offer'));
    const approveCall = calls.find((c) => c.url.endsWith('/api/im/pair/local-only-approve'));
    const pollCall = calls.find((c) => c.url.includes('/api/im/pair/poll/'));
    expect(offerCall).toBeTruthy();
    expect(approveCall).toBeTruthy();
    expect((approveCall?.body as { nonce: string }).nonce).toBe('nonce-test-1');
    expect((approveCall?.body as { asUserEmail: string }).asUserEmail).toBe('admintest1@local.test');
    expect(pollCall?.url).toContain('/api/im/pair/poll/nonce-test-1');
    // Approve must come before poll.
    expect(calls.indexOf(approveCall!)).toBeLessThan(calls.indexOf(pollCall!));
  });

  it('surfaces cloud 403 when local-only-approve is rejected', async () => {
    const home = tmpHome();
    cleanup.push(home);

    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/im/pair/offer')) {
        return mkResponse(200, {
          ok: true,
          data: {
            nonce: 'n-403',
            qrUrl: 'prismer://pair?nonce=n-403&pub=x',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          },
        });
      }
      if (url.endsWith('/api/im/pair/local-only-approve')) {
        return mkResponse(403, {
          ok: false,
          error: { code: 'LOCAL_ONLY_DISABLED', message: 'cloud not in LOCAL_ONLY' },
        });
      }
      return mkResponse(404, { ok: false });
    });

    await expect(
      pair({
        cloudBaseUrl: 'http://localhost:3000',
        asUserEmail: 'admintest1@local.test',
        isLocalOnly: () => true,
        paths: resolvePaths(home),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/local-only-approve failed \(403\)/);
  });
});

/**
 * 2026-05-30 — smoke coverage for /api/v1/proxy/[provider]/chat/completions.
 *
 * The full chain (Nacos + auth + rate-limit + upstream) is owned by the
 * existing chat/completions tests. Here we pin only the new layer the alias
 * route adds:
 *   - unknown `[provider]` returns 400 BEFORE invoking auth / proxyToNewAPI
 *   - valid providers reach proxyToNewAPI with the right `forceProvider`
 *
 * We mock the full collaborator stack so the test runs without a Nacos
 * connection / real fetch.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/nacos-config', () => ({
  ensureNacosConfig: vi.fn(async () => {}),
}));

vi.mock('@/lib/feature-flags', () => ({
  FEATURE_FLAGS: { LLM_PROXY_ENABLED: true },
}));

const apiGuardMock = vi.fn();
vi.mock('@/lib/api-guard', () => ({
  apiGuard: (...args: unknown[]) => apiGuardMock(...args),
}));

const checkRateLimitMock = vi.fn();
const checkLlmRlMock = vi.fn();
const rateLimitResponseMock = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  // release202/12 (P4) — the LLM routes now use the distributed limiter.
  checkLlmRateLimitDistributed: (...args: unknown[]) => checkLlmRlMock(...args),
  rateLimitResponse: (...args: unknown[]) => rateLimitResponseMock(...args),
}));

const proxyToNewAPIMock = vi.fn();
vi.mock('@/lib/llm-proxy', () => ({
  proxyToNewAPI: (...args: unknown[]) => proxyToNewAPIMock(...args),
}));

import { POST } from '@/app/api/proxy/[provider]/chat/completions/route';

function makeReq(): import('next/server').NextRequest {
  // The handler only reads headers; NextRequest constructor accepts a URL +
  // RequestInit. Smallest viable stub.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require('next/server') as typeof import('next/server');
  return new NextRequest('http://localhost/api/v1/proxy/x/chat/completions', { method: 'POST' });
}

beforeEach(() => {
  apiGuardMock.mockReset();
  checkRateLimitMock.mockReset();
  checkLlmRlMock.mockReset();
  rateLimitResponseMock.mockReset();
  proxyToNewAPIMock.mockReset();
});

describe('/api/v1/proxy/[provider]/chat/completions', () => {
  it('rejects unknown provider with 400 BEFORE invoking auth', async () => {
    const res = await POST(makeReq(), { params: Promise.resolve({ provider: 'mystery' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Unknown provider chain: mystery/);
    expect(apiGuardMock).not.toHaveBeenCalled();
    expect(proxyToNewAPIMock).not.toHaveBeenCalled();
  });

  it('forwards deepseek to proxyToNewAPI with forceProvider="deepseek"', async () => {
    apiGuardMock.mockResolvedValue({ ok: true, auth: { userId: 'u-1' } });
    checkLlmRlMock.mockResolvedValue({ allowed: true });
    const expected = new Response('ok', { status: 200 });
    proxyToNewAPIMock.mockResolvedValue(expected);
    const res = await POST(makeReq(), { params: Promise.resolve({ provider: 'deepseek' }) });
    expect(res).toBe(expected);
    expect(proxyToNewAPIMock).toHaveBeenCalledTimes(1);
    const args = proxyToNewAPIMock.mock.calls[0];
    expect(args[2]).toBe('/v1/chat/completions');
    expect(args[3]).toBe('deepseek');
  });

  it('forwards newapi to proxyToNewAPI with forceProvider="newapi"', async () => {
    apiGuardMock.mockResolvedValue({ ok: true, auth: { userId: 'u-1' } });
    checkLlmRlMock.mockResolvedValue({ allowed: true });
    proxyToNewAPIMock.mockResolvedValue(new Response('ok'));
    await POST(makeReq(), { params: Promise.resolve({ provider: 'newapi' }) });
    expect(proxyToNewAPIMock.mock.calls[0][3]).toBe('newapi');
  });
});

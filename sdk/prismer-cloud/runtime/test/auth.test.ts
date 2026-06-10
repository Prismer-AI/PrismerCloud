import { describe, expect, it, vi } from 'vitest';
import { CloudClient } from '../src/auth.js';

function mkResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('CloudClient.request', () => {
  it('sends Authorization header by default', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(200, { ok: true, data: { hello: 'world' } }));
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetchImpl });
    const res = await cloud.request<{ ok: boolean; data: { hello: string } }>('GET', '/api/im/me');
    expect(res.ok).toBe(true);
    const call = fetchImpl.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('omits Authorization when auth:false', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(200, { ok: true }));
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'sk', fetchImpl });
    await cloud.request('POST', '/pair/offer', { auth: false, body: { x: 1 } });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps 401 → auth_invalid', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(401, { error: { message: 'bad key' } }));
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
    const res = await cloud.request('GET', '/api/im/me');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error?.code).toBe('auth_invalid');
  });

  it('maps 409 → version_conflict', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(409, {}));
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
    const res = await cloud.request('PATCH', '/api/im/agent_profiles/x', { body: {} });
    expect(res.error?.code).toBe('version_conflict');
  });

  it('network error → cloud_unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
    const res = await cloud.request('GET', '/api/im/me');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error?.code).toBe('cloud_unreachable');
  });

  it('get() unwraps {ok,data} envelope', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(200, { ok: true, data: { x: 42 } }));
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
    const data = await cloud.get<{ x: number }>('/api/im/foo');
    expect(data).toEqual({ x: 42 });
  });

  it('get() throws CloudError on envelope ok=false', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(200, { ok: false, error: { code: 'not_found', message: 'gone' } }));
    const cloud = new CloudClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
    await expect(cloud.get('/api/im/missing')).rejects.toThrow(/gone/);
  });

  it('urlFor preserves leading slash + strips trailing on base', () => {
    const cloud = new CloudClient({ baseUrl: 'http://x:3000/', apiKey: 'k' });
    expect(cloud.urlFor('/api/im/me')).toBe('http://x:3000/api/im/me');
    expect(cloud.urlFor('api/im/me')).toBe('http://x:3000/api/im/me');
  });
});

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CloudClient } from '../../auth.js';
import { attachAdminObservabilityRpc } from './rpc.js';

function request(input: { path: string; body?: unknown; remote?: string; method?: string; agent?: string }) {
  const payload = JSON.stringify(input.body ?? {});
  const req = Readable.from([payload]) as Readable & Record<string, unknown>;
  req.url = input.path;
  req.method = input.method ?? 'POST';
  req.headers = {
    'content-length': String(Buffer.byteLength(payload)),
    ...(input.agent ? { 'x-prismer-agent': input.agent } : {}),
  };
  req.socket = { remoteAddress: input.remote ?? '127.0.0.1' };
  return req;
}

async function invoke(
  fetchImpl: typeof fetch,
  input: { path: string; body?: unknown; remote?: string; method?: string; agent?: string },
) {
  const reply: { status?: number; headers?: Record<string, unknown>; payload?: string } = {};
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      reply.status = status;
      reply.headers = headers;
    },
    end(payload: string) {
      reply.payload = payload;
    },
  };
  const cloud = new CloudClient({ baseUrl: 'https://cloud.invalid', apiKey: 'secret-admin-key', fetchImpl });
  const handled = await attachAdminObservabilityRpc({ cloud, daemonId: () => 'daemon-1' })(
    request(input) as never,
    res as never,
  );
  return { handled, status: reply.status, body: JSON.parse(reply.payload ?? '{}') };
}

describe('Admin observability loopback broker', () => {
  it('fails closed when no dedicated Admin credential client is configured', async () => {
    const handler = attachAdminObservabilityRpc({ daemonId: () => 'daemon-1' });
    const reply: { status?: number; payload?: string } = {};
    const res = {
      writeHead(status: number) { reply.status = status; },
      end(payload: string) { reply.payload = payload; },
    };
    await handler(request({
      path: '/local/admin-observability/capabilities',
      body: { purpose: 'configuration probe' },
    }) as never, res as never);
    expect(reply.status).toBe(503);
    expect(reply.payload).not.toContain('secret');
  });

  it('maps capabilities to a constant path and adds daemon-owned auth plus provenance', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, data: { capabilities: [] } }), { status: 200 });
    }) as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/capabilities',
      body: { purpose: 'APC diagnose runtime' },
      agent: 'agent-1',
    });
    expect(result.status).toBe(200);
    expect(calls[0]?.url).toBe('https://cloud.invalid/api/admin/v1/capabilities');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-admin-key');
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Prismer-Daemon-ID']).toBe('daemon-1');
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Prismer-Agent']).toBe('agent-1');
  });

  it('never returns the daemon credential even if an upstream field contains it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { line: 'secret-admin-key' } }))) as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/capabilities',
      body: { purpose: 'verify redaction' },
    });
    expect(JSON.stringify(result.body)).not.toContain('secret-admin-key');
    expect(result.body).toMatchObject({ data: { line: '[REDACTED]' } });
  });

  it('rejects non-loopback access before reading or forwarding', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/capabilities',
      body: { purpose: 'x' },
      remote: '10.1.2.3',
    });
    expect(result.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires purpose and rejects arbitrary fields, URL queries, and routes', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await invoke(fetchImpl, { path: '/local/admin-observability/capabilities', body: {} })).status).toBe(400);
    expect((await invoke(fetchImpl, {
      path: '/local/admin-observability/capabilities',
      body: { purpose: 'x', url: 'https://attacker.invalid' },
    })).status).toBe(400);
    expect((await invoke(fetchImpl, {
      path: '/local/admin-observability/capabilities?path=/api/secrets',
      body: { purpose: 'x' },
    })).status).toBe(400);
    expect((await invoke(fetchImpl, {
      path: '/local/admin-observability/delete',
      body: { purpose: 'x' },
    })).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('constructs runtime query only from the fixed inventory allowlist', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: { items: [] } }));
    }) as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/runtimes',
      body: { purpose: 'fleet check', status: 'running,paused', provider: 'acs', limit: 25 },
    });
    expect(result.status).toBe(200);
    expect(calls[0]).toBe('https://cloud.invalid/api/admin/v1/sandbox/runtimes?status=running%2Cpaused&provider=acs&limit=25');
  });

  it('discovers logical log targets through a fixed query allowlist', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: { items: [] } }));
    }) as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/log-targets',
      body: { purpose: 'target discovery', kind: 'daemon', workspaceId: 'ws-1', limit: 25 },
    });
    expect(result.status).toBe(200);
    expect(calls[0]).toBe(
      'https://cloud.invalid/api/admin/v1/log-targets?kind=daemon&workspaceId=ws-1&limit=25',
    );
  });

  it('does not relay upstream error text', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'boom', message: 'secret-admin-key database details' } }),
      { status: 500 },
    )) as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/logs-query',
      body: { purpose: 'diagnose', target: { kind: 'service', id: 'prismer-cloud' } },
    });
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('database details');
    expect(JSON.stringify(result.body)).not.toContain('secret-admin-key');
  });

  it('fails closed before buffering an upstream response above the broker budget', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(7 * 1024 * 1024) },
    })) as typeof fetch;
    const result = await invoke(fetchImpl, {
      path: '/local/admin-observability/capabilities',
      body: { purpose: 'bounded response probe' },
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, error: { code: 'admin_observability_unavailable' } });
  });
});

import { expect, it, vi } from 'vitest';
import { PrismerClient } from '../src/index';

it.each(['network', 'decode', 'http', 'ok'] as const)('reports %s phase without response content or credentials', async mode => {
  const observations: unknown[] = [];
  const client = new PrismerClient({ apiKey: 'sk-eaas-private-probe', baseUrl: 'https://test.invalid',
    fetch: (async () => {
      if (mode === 'network') throw new Error('network failed');
      return new Response(mode === 'decode' ? '<html>private upstream body</html>' : JSON.stringify({ success: mode === 'ok', data: {}, requestId: 'req-probe' }),
        { status: mode === 'http' ? 503 : 200, headers: { 'content-type': mode === 'decode' ? 'text/html' : 'application/json', 'x-request-id': 'req-probe' } });
    }) as typeof fetch,
    onRequestObservation: event => { observations.push(event); throw new Error('observer failure'); },
  });
  const result = await client.environments.getRun('env_probe', 'run_probe');
  expect(observations).toEqual([expect.objectContaining({ method: 'GET', path: '/api/v1/environments/env_probe/runs/run_probe',
    outcome: mode === 'ok' ? 'success' : mode === 'http' ? 'http_error' : mode === 'decode' ? 'decode_error' : 'transport_error',
    status: mode === 'network' ? null : mode === 'http' ? 503 : 200, durationMs: expect.any(Number) })]);
  expect(result.success).toBe(mode === 'ok');
  expect(JSON.stringify(observations)).not.toContain('private');
});

it('isolates an asynchronous observer rejection', async () => {
  const client = new PrismerClient({ apiKey: 'sk-eaas-probe', baseUrl: 'https://test.invalid',
    fetch: (async () => new Response(JSON.stringify({ success: true, data: {} }))) as typeof fetch,
    onRequestObservation: async () => { throw new Error('asynchronous observer failure'); },
  });
  expect((await client.environments.getRun('env_probe', 'run_probe')).success).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 0));
});

it('keeps JWT refresh time out of the original HTTP attempt duration', async () => {
  let clock = 0;
  const timer = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const observations: Array<{ status: number | null; durationMs: number; retry: boolean }> = [];
  let calls = 0;
  const client = new PrismerClient({ apiKey: 'eyJ-probe', baseUrl: 'https://test.invalid',
    fetch: (async () => {
      calls += 1;
      if (calls === 1) { clock = 10; return new Response('{}', { status: 401 }); }
      if (calls === 2) { clock = 110; return new Response(JSON.stringify({ ok: true, data: { token: 'eyJ-refreshed' } })); }
      clock = 120;
      return new Response(JSON.stringify({ success: true, data: {} }));
    }) as typeof fetch,
    onRequestObservation: event => { observations.push(event); },
  });
  try {
    expect((await client.environments.getRun('env_probe', 'run_probe')).success).toBe(true);
    expect(calls).toBe(3);
    expect(observations.find(event => event.status === 401)?.durationMs).toBe(10);
    expect(observations.filter(event => event.status === 200).map(event => event.durationMs).sort((a,b) => a-b)).toEqual([10,100]);
  } finally { timer.mockRestore(); }
});

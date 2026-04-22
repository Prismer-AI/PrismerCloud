/**
 * adapter-mode-b.test.ts — daemon-side Mode B AdapterImpl factory + registration.
 *
 * Covers:
 *   - The factory builds an AdapterImpl whose dispatch() does an HTTP POST
 *     to the loopback URL and returns the response unchanged on success.
 *   - The factory rejects non-127.0.0.1 URLs (only http://127.0.0.1:<port>).
 *   - registry.register() with the Mode B adapter REPLACES any existing
 *     CLI-shim impl for the same name.
 *   - Non-2xx loopback returns { ok: false, error: 'mode_b_<status>' }.
 *   - Network error returns { ok: false, error: 'mode_b_network:<msg>' }.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { AdapterRegistry, type AdapterImpl } from '../src/adapter-registry';
import {
  buildModeBAdapter,
  validateLoopbackUrl,
} from '../src/adapters/mode-b';
import { AUTH_BYPASS_PATHS } from '../src/daemon-http';

function fakeCliAdapter(name: string): AdapterImpl {
  return {
    name,
    tiersSupported: [1, 2, 3],
    capabilityTags: ['code'],
    async dispatch() {
      return { ok: true, output: 'cli-shim-output' };
    },
  };
}

// ---------------------------------------------------------------------------
// validateLoopbackUrl
// ---------------------------------------------------------------------------

describe('validateLoopbackUrl', () => {
  it('accepts http://127.0.0.1:<port>', () => {
    expect(validateLoopbackUrl('http://127.0.0.1:54321').ok).toBe(true);
    expect(validateLoopbackUrl('http://127.0.0.1:8080').ok).toBe(true);
  });

  it('rejects https (TLS unnecessary on loopback, harden against MITM)', () => {
    const r = validateLoopbackUrl('https://127.0.0.1:54321');
    expect(r.ok).toBe(false);
  });

  it('rejects non-127.0.0.1 hosts', () => {
    expect(validateLoopbackUrl('http://localhost:54321').ok).toBe(false);
    expect(validateLoopbackUrl('http://192.168.1.10:54321').ok).toBe(false);
    expect(validateLoopbackUrl('http://example.com:54321').ok).toBe(false);
    expect(validateLoopbackUrl('http://10.0.0.1:54321').ok).toBe(false);
  });

  it('rejects URLs without an explicit port', () => {
    const r = validateLoopbackUrl('http://127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(validateLoopbackUrl('not a url').ok).toBe(false);
    expect(validateLoopbackUrl('').ok).toBe(false);
    expect(validateLoopbackUrl('ftp://127.0.0.1:21').ok).toBe(false);
  });

  // I2: origin-only enforcement. http://127.0.0.1:6379/proxy?target=evil
  // would, after string concat with /dispatch, smuggle traffic to a Redis-front
  // proxy. Reject anything other than scheme + 127.0.0.1 + explicit port + /.
  it('rejects URLs with a non-empty pathname', () => {
    const r = validateLoopbackUrl('http://127.0.0.1:8080/proxy');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/origin_only/);
  });

  it('rejects URLs with a query string', () => {
    const r = validateLoopbackUrl('http://127.0.0.1:8080?x=y');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/origin_only/);
  });

  it('rejects URLs with a fragment', () => {
    const r = validateLoopbackUrl('http://127.0.0.1:8080#frag');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/origin_only/);
  });

  it('still accepts the bare-trailing-slash form (URL parser injects "/")', () => {
    expect(validateLoopbackUrl('http://127.0.0.1:8080/').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I1: AUTH_BYPASS_PATHS — register-mode-b is loopback-only and must not be
// gated by the daemon's bearer-token middleware. The dispatch endpoint
// (/adapters/dispatch) is intentionally NOT in this list.
// ---------------------------------------------------------------------------

describe('AUTH_BYPASS_PATHS (daemon-http)', () => {
  it('contains POST /api/v1/adapters/register-mode-b', () => {
    const found = AUTH_BYPASS_PATHS.some(
      (e) => e.method === 'POST' && e.pathname === '/api/v1/adapters/register-mode-b',
    );
    expect(found).toBe(true);
  });

  it('does NOT contain POST /api/v1/adapters/dispatch (must remain authenticated)', () => {
    const leaked = AUTH_BYPASS_PATHS.some(
      (e) => e.pathname === '/api/v1/adapters/dispatch',
    );
    expect(leaked).toBe(false);
  });

  it('does NOT contain any route outside /api/v1/adapters/ (defense in depth)', () => {
    for (const e of AUTH_BYPASS_PATHS) {
      expect(e.pathname.startsWith('/api/v1/adapters/')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildModeBAdapter — factory
// ---------------------------------------------------------------------------

describe('buildModeBAdapter', () => {
  let loopback: http.Server;
  let loopbackUrl = '';
  let lastBody: any;
  let nextResponse: { status: number; body: any } = {
    status: 200,
    body: { ok: true, output: 'loopback-output' },
  };

  beforeEach(async () => {
    lastBody = undefined;
    nextResponse = { status: 200, body: { ok: true, output: 'loopback-output' } };
    loopback = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          lastBody = null;
        }
        const payload = JSON.stringify(nextResponse.body);
        res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
    const port = (loopback.address() as any).port;
    loopbackUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
  });

  it('returns the loopback response unchanged on success', async () => {
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1, 2],
      capabilityTags: ['code'],
    });

    nextResponse = {
      status: 200,
      body: { ok: true, output: 'hello from openclaw', metadata: { tokens: 42 } },
    };
    const result = await adapter.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'do it',
    });

    expect(result).toEqual({
      ok: true,
      output: 'hello from openclaw',
      metadata: { tokens: 42 },
    });
    // dispatch input was forwarded
    expect(lastBody).toEqual({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'do it',
    });
  });

  it('forwards optional dispatch fields (stepIdx, deadlineAt, metadata)', async () => {
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    await adapter.dispatch({
      taskId: 't1',
      stepIdx: 2,
      capability: 'code.write',
      prompt: 'x',
      metadata: { caller: 'test' },
      deadlineAt: 99999,
    });
    expect(lastBody).toEqual({
      taskId: 't1',
      stepIdx: 2,
      capability: 'code.write',
      prompt: 'x',
      metadata: { caller: 'test' },
      deadlineAt: 99999,
    });
  });

  it('returns ok:false with mode_b_<status> on non-2xx loopback', async () => {
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    nextResponse = { status: 503, body: { error: 'unavailable' } };
    const result = await adapter.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^mode_b_503/);
  });

  it('returns ok:false with mode_b_network:<msg> on network error', async () => {
    // Close the loopback then dispatch.
    await new Promise<void>((resolve) => loopback.close(() => resolve()));

    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
      timeoutMs: 500,
    });
    const result = await adapter.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^mode_b_network:/);

    // Re-open so afterEach close is safe.
    loopback = http.createServer();
    await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  });

  it('returns ok:false with mode_b_invalid_response on non-JSON body', async () => {
    nextResponse = { status: 200, body: 'plain text not json' };
    // Override the server to send raw text (current handler stringifies via JSON.stringify
    // which would still be valid JSON for a string). Use a one-off server.
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
    loopback = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not-json{{{');
    });
    await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
    const port = (loopback.address() as any).port;

    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl: `http://127.0.0.1:${port}`,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });
    const result = await adapter.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^mode_b_invalid_response/);
  });

  it('throws when given a non-loopback URL (defense in depth)', () => {
    expect(() =>
      buildModeBAdapter({
        name: 'openclaw',
        loopbackUrl: 'http://example.com:80',
        tiersSupported: [1],
        capabilityTags: ['code'],
      }),
    ).toThrow();
  });

  it('descriptor exposes name / tiersSupported / capabilityTags', () => {
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1, 2, 3, 4],
      capabilityTags: ['code', 'shell'],
    });
    expect(adapter.name).toBe('openclaw');
    expect(adapter.tiersSupported).toEqual([1, 2, 3, 4]);
    expect(adapter.capabilityTags).toEqual(['code', 'shell']);
  });
});

// ---------------------------------------------------------------------------
// Mode B reset() — v1.9.x agent_restart contract
// ---------------------------------------------------------------------------

describe('Mode B adapter reset()', () => {
  let loopback: http.Server;
  let loopbackUrl = '';
  let resetCalls: Array<{ method: string; url: string; body: any }> = [];
  let nextResetResponse: { status: number; body: any; delayMs?: number } = {
    status: 200,
    body: { ok: true, state: 'mode_b_reset' },
  };

  beforeEach(async () => {
    resetCalls = [];
    nextResetResponse = { status: 200, body: { ok: true, state: 'mode_b_reset' } };
    loopback = http.createServer((req, res) => {
      if (req.url === '/reset' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          let body: any = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            body = null;
          }
          resetCalls.push({ method: req.method ?? '', url: req.url ?? '', body });
          const send = () => {
            const payload =
              typeof nextResetResponse.body === 'string'
                ? nextResetResponse.body
                : JSON.stringify(nextResetResponse.body);
            res.writeHead(nextResetResponse.status, { 'Content-Type': 'application/json' });
            res.end(payload);
          };
          if (nextResetResponse.delayMs) setTimeout(send, nextResetResponse.delayMs);
          else send();
        });
        return;
      }
      // Default handler for unknown paths.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
    const port = (loopback.address() as any).port;
    loopbackUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
  });

  it('POSTs /reset with { agentName } and returns ok:true + state on success', async () => {
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    const result = await adapter.reset!('openclaw');
    expect(result.ok).toBe(true);
    expect(result.state).toBe('mode_b_reset');
    expect(resetCalls.length).toBe(1);
    expect(resetCalls[0].method).toBe('POST');
    expect(resetCalls[0].url).toBe('/reset');
    expect(resetCalls[0].body).toEqual({ agentName: 'openclaw' });
  });

  it('passes agentName:undefined through as {} / null value when not provided', async () => {
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    const result = await adapter.reset!();
    expect(result.ok).toBe(true);
    expect(resetCalls.length).toBe(1);
    // JSON.stringify({ agentName: undefined }) → '{}' — host treats as "all".
    expect(resetCalls[0].body).toEqual({});
  });

  it('merges host-reported fields (agentName, diagnostics) into the result', async () => {
    nextResetResponse = {
      status: 200,
      body: { ok: true, state: 'openclaw_bridge_noop', agentName: 'claude-code', cleared: 7 },
    };
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    const result = await adapter.reset!('claude-code');
    expect(result.ok).toBe(true);
    // Host-reported state wins over the default (spread merges in order).
    expect(result.state).toBe('openclaw_bridge_noop');
    expect(result.agentName).toBe('claude-code');
    expect(result.cleared).toBe(7);
  });

  it('returns ok:false + mode_b_reset_http_<status> on non-2xx', async () => {
    nextResetResponse = { status: 500, body: { error: 'boom' } };
    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    const result = await adapter.reset!('openclaw');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mode_b_reset_http_500');
  });

  it('returns ok:false + mode_b_reset_network:<msg> when loopback unreachable', async () => {
    await new Promise<void>((resolve) => loopback.close(() => resolve()));

    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    const result = await adapter.reset!('openclaw');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^mode_b_reset_network:/);

    // Re-open so afterEach close is safe.
    loopback = http.createServer();
    await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  });

  it('tolerates non-JSON body on a 2xx response (treats as soft success)', async () => {
    // One-off server that sends plain text 200.
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
    loopback = http.createServer((req, res) => {
      if (req.url === '/reset' && req.method === 'POST') {
        // drain the body first — otherwise the client may see ECONNRESET
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('not-json{{{');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
    const port = (loopback.address() as any).port;

    const adapter = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl: `http://127.0.0.1:${port}`,
      tiersSupported: [1],
      capabilityTags: ['code'],
    });

    const result = await adapter.reset!('openclaw');
    expect(result.ok).toBe(true);
    expect(result.state).toBe('mode_b_reset');
  });
});

// ---------------------------------------------------------------------------
// registry.register replacement semantics — ensures Mode B wins over CLI shim
// ---------------------------------------------------------------------------

describe('Mode B replaces CLI shim in AdapterRegistry', () => {
  it('registry.register(modeB) overwrites a previously-registered CLI shim', async () => {
    const reg = new AdapterRegistry();

    // Pre-register a CLI shim for 'openclaw'.
    reg.register(fakeCliAdapter('openclaw'));
    expect(reg.size()).toBe(1);
    const before = reg.get('openclaw');
    const beforeResult = await before!.dispatch({ taskId: 't1', capability: 'code', prompt: 'x' });
    expect(beforeResult.output).toBe('cli-shim-output');

    // Build a Mode B adapter pointing at a non-existent loopback (we won't dispatch
    // through it — we only assert that registration replaces the existing entry).
    const modeB = buildModeBAdapter({
      name: 'openclaw',
      loopbackUrl: 'http://127.0.0.1:1', // closed port — fine, we don't call dispatch here
      tiersSupported: [1, 2, 3, 4],
      capabilityTags: ['code', 'shell'],
    });
    reg.register(modeB);

    expect(reg.size()).toBe(1);
    expect(reg.get('openclaw')).toBe(modeB);
    expect(reg.get('openclaw')).not.toBe(before);
    expect(reg.get('openclaw')?.capabilityTags).toEqual(['code', 'shell']);
  });
});


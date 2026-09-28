/**
 * Tests for the memory command SURFACE of `cloud`:
 *
 *   - the legacy SDK-side `cloud memory` CLI is REMOVED (memory211/01 §6.9 裁决 3:
 *     it was the "双 CLI 同名异物" footgun — same name as the canonical runtime CLI
 *     in sdk/prismer/src/cli/commands/memory.ts, different behavior, off the agent
 *     path). These tests pin the removal so it cannot quietly come back.
 *   - `cloud recall` wire format is unchanged (the shortcut lives in `cli.ts`, not
 *     in the removed file, and was always exercised against the SDK request
 *     pipeline rather than the CLI wrapper).
 *
 * The `/api/im/memory/files` HTTP route is deliberately NOT removed with the CLI:
 * benchmark scripts, the e2e fixtures and the SDK client methods still consume it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { PrismerClient } from '../src/index';

const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; body?: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body });
    return handler(url, init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  return new PrismerClient({
    apiKey: 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
}

// ---------------------------------------------------------------------------
// the legacy `cloud memory` CLI stays removed
// ---------------------------------------------------------------------------

describe('legacy `cloud memory` CLI removal (memory211/01 §6.9 裁决 3)', () => {
  it('the command module file is gone', () => {
    expect(existsSync(join(ROOT, 'src/commands/memory.ts'))).toBe(false);
  });

  it('cli.ts neither imports nor registers it', () => {
    const cli = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
    expect(cli).not.toContain("from './commands/memory'");
    expect(cli).not.toContain('registerMemory(');
  });

  it('the canonical memory CLI is the runtime one, and the skill points there', () => {
    expect(existsSync(join(ROOT, '../prismer/src/cli/commands/memory.ts'))).toBe(true);
    const skill = readFileSync(join(ROOT, '../cloud/catalog/skills/memory/SKILL.md'), 'utf8');
    expect(skill).toContain('prismer memory');
    expect(skill).not.toContain('`cloud memory write');
  });
});

// ---------------------------------------------------------------------------
// recall — exercised directly via the SDK request pipeline since the recall
// command lives in cli.ts (not in the removed commands/memory.ts).
// ---------------------------------------------------------------------------

describe('cloud recall — strategy + layer wire-through', () => {
  it('POST /api/im/recall when --strategy is supplied (recall command behavior contract)', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/recall') {
        return jsonResponse({ ok: true, data: [{ source: 'memory', title: 'hit', score: 0.9, snippet: '...' }] });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    // Use the same private-borrow trick that cli.ts:recall uses. This locks
    // the wire format: POST /api/im/recall with { query, strategy, scope,
    // maxResults }. If P3 lands a typed wrapper later, the cli.ts logic and
    // this assertion both move together.
    const _r = (client.im as unknown as { memory: { _r: (m: string, p: string, b?: unknown, q?: Record<string, string>) => Promise<unknown> } }).memory._r;
    const res = await _r('POST', '/api/im/recall', {
      query: 'foo',
      strategy: 'hybrid',
      scope: 'memory',
      maxResults: 5,
    }) as { ok: boolean; data?: unknown[] };

    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.test/api/im/recall');
    expect(calls[0]?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.strategy).toBe('hybrid');
    expect(body.scope).toBe('memory');
  });

  it('GET /api/im/recall when only --layer (no strategy) is supplied', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.startsWith('https://api.test/api/im/recall')) {
        return jsonResponse({ ok: true, data: [] });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const _r = (client.im as unknown as { memory: { _r: (m: string, p: string, b?: unknown, q?: Record<string, string>) => Promise<unknown> } }).memory._r;
    const res = await _r('GET', '/api/im/recall', undefined, { q: 'foo', scope: 'cache', limit: '10' }) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('scope=cache');
    expect(calls[0]?.url).toContain('limit=10');
    expect(calls[0]?.url).toContain('q=foo');
  });
});

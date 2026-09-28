import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { PrismerClient } from '../../src/index';
import { MemoryStorage } from '../../src/storage';
import { register } from '../../src/commands/environment';
import type { ProjectPoolManagement } from '../../src/environment-contract';

// Synthetic transport contract tests, not provider or live API acceptance.
const policy: ProjectPoolManagement = { maxReady: 2, dailyBudgetCredits: '12.123456', defaultPoolId: 'a', fallbackPoolIds: ['b'], pools: [
  { poolId: 'a', enabled: true, minReady: 1, maxReady: 2, idleRetentionSeconds: 30, priority: 9, onMiss: 'reject' },
  { poolId: 'b', enabled: true, minReady: 0, maxReady: 0, idleRetentionSeconds: 0, priority: 0, onMiss: 'cold' },
] };
const status = { revision: 4, observedRevision: 3, configRevision: 'cfg-1', allowedPoolIds: ['a', 'b'], policy };
const page = { pools: [{ poolId: 'b', inventory: { known: false, source: 'provider', ready: null, provisioning: null, terminating: null, observedAt: null } }], nextCursor: 'b', policyRevision: 4, observedAt: '2026-09-24T00:00:00Z', activation: { desiredRevision: 'cfg-1', observedRevision: null, phase: 'local-unverified', freshUntil: null } };
const clients: PrismerClient[] = [];
function setup(reply: unknown = status, code = 200, offline = false) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, data: reply, requestId: 'test' }), { status: code, headers: { ETag: '"4"' } }));
  const client = new PrismerClient({ apiKey: 'sk-eaas-synthetic', baseUrl: 'https://test.invalid', fetch: fetch as typeof globalThis.fetch, ...(offline ? { offline: { storage: new MemoryStorage() } } : {}) });
  clients.push(client);
  return { client, fetch };
}
afterEach(async () => { vi.restoreAllMocks(); for (const c of clients.splice(0)) await c.destroy(); });
describe('project pool policy wire contract', () => {
  it('reads the success envelope and URL-encodes project IDs', async () => {
    const { client, fetch } = setup();
    expect(await client.projects.poolPolicy.get('p/a')).toEqual({ success: true, data: status, requestId: 'test' });
    expect(fetch.mock.calls[0][0]).toBe('https://test.invalid/api/v1/projects/p%2Fa/pool-policy');
  });
  it.each([true, false, undefined])('sends a full replacement and dryRun=%s without rewriting policy', async dryRun => {
    const returned = dryRun ? status : { ...status, revision: 5 };
    const { client, fetch } = setup(returned, dryRun ? 200 : 202);
    const body = { configRevision: 'cfg-1', policy, ...(dryRun === undefined ? {} : { dryRun }) };
    expect(await client.projects.poolPolicy.patch('p', body, { revision: 4, idempotencyKey: 'same-request' })).toMatchObject({ success: true, data: returned });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(new Headers(init.headers).get('If-Match')).toBe('4');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('same-request');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('generates a nonempty idempotency key when omitted', async () => {
    const { client, fetch } = setup();
    await client.projects.poolPolicy.patch('p', { configRevision: 'cfg-1', policy }, { revision: 0 });
    expect(new Headers((fetch.mock.calls[0][1] as RequestInit).headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('forwards cursor+limit and preserves unknown inventory as null', async () => {
    const { client, fetch } = setup(page);
    const res = await client.projects.pools.list('p', { cursor: 'a/b +', limit: 1 });
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/api/v1/projects/p/pools');
    expect(url.searchParams.get('cursor')).toBe('a/b +');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(res).toEqual({ success: true, data: page, requestId: 'test' });
    const last = { ...page, nextCursor: null };
    fetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: last })));
    expect(await client.projects.pools.list('p', { cursor: page.nextCursor, limit: 1 })).toMatchObject({ success: true, data: last });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([[400, 'invalid_policy'], [403, 'scope_denied'], [404, 'not_owned'], [409, 'state_conflict'], [409, 'idempotency_conflict'], [412, 'revision_conflict'], [402, 'budget_exhausted'], [429, 'quota_exceeded'], [503, 'pricing_unavailable'], [503, 'provider_unavailable']])('preserves %s/%s without fallback', async (httpStatus, code) => {
    const { client, fetch } = setup();
    const failure = { success: false, error: { code, message: 'synthetic', details: null }, requestId: 'test' };
    fetch.mockImplementation(async () => new Response(JSON.stringify(failure), { status: httpStatus as number }));
    expect(await client.projects.poolPolicy.patch('p', { configRevision: 'cfg-1', policy }, { revision: 4, idempotencyKey: 'same' })).toMatchObject(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('offline writes fail, preserve headers and never enter the IM outbox', async () => {
    const { client, fetch } = setup(status, 200, true);
    const dispatch = vi.spyOn(client.im.offline!, 'dispatch');
    fetch.mockRejectedValue(new Error('synthetic offline'));
    expect(await client.projects.poolPolicy.patch('p', { configRevision: 'cfg-1', policy }, { revision: 4 })).toMatchObject({ success: false, error: { code: 'cloud_unreachable' } });
    expect(dispatch).not.toHaveBeenCalled();
    expect(new Headers((fetch.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('4');
  });
});

async function cli(client: PrismerClient, args: string[]) {
  const program = new Command().exitOverride();
  register(program, () => client, () => client);
  await program.parseAsync(['node', 'cloud', ...args]);
}
describe('pool CLI', () => {
  it('gets policy and lists one explicit page', async () => {
    const { client, fetch } = setup(status);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await cli(client, ['pool-policy', 'get', 'p', '--json']);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('cfg-1'));
    fetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: page })));
    await cli(client, ['pools', 'list', 'p', '--cursor', 'a', '--limit', '1', '--json']);
    expect(String(fetch.mock.calls[1][0])).toContain('cursor=a');
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining('"ready": null'));
  });
  it('patches the complete JSON policy with explicit revisions, dryRun and idempotency', async () => {
    const { client, fetch } = setup();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await cli(client, ['pool-policy', 'patch', 'p', '--policy', JSON.stringify(policy), '--config-revision', 'cfg-1', '--revision', '4', '--dry-run', '--idempotency-key', 'cli-same', '--json']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ configRevision: 'cfg-1', policy, dryRun: true });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('cli-same');
    expect(new Headers(init.headers).get('If-Match')).toBe('4');
  });
  it('offline CLI patch never prints success', async () => {
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new Error('synthetic offline'));
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(cli(client, ['pool-policy', 'patch', 'p', '--policy', JSON.stringify(policy), '--config-revision', 'cfg-1', '--revision', '4'])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cloud_unreachable'));
    expect(output).not.toHaveBeenCalled();
  });
  it.each([['--revision', '-1'], ['--policy', '{broken']])('rejects malformed %s before any request', async (flag, value) => {
    const { client, fetch } = setup();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(cli(client, ['pool-policy', 'patch', 'p', '--policy', JSON.stringify(policy), '--config-revision', 'cfg-1', '--revision', '4', flag, value])).rejects.toThrow('exit');
    expect(fetch).not.toHaveBeenCalled();
  });
});

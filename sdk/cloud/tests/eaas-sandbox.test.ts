import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxesClient } from '../src/eaas-sandbox';
const ok = (data: unknown) => ({ success: true, data, requestId: 'req-demo' });
const status = (ready: boolean, state = 'running') => ({
  environmentId: 'env-1',
  state,
  readiness: { sandbox: ready, services: ready, agent: null },
});
function setup() {
  const low = {
    create: vi.fn().mockResolvedValue(ok(status(false, 'provisioning'))),
    get: vi.fn().mockResolvedValue(ok(status(true))),
    list: vi.fn().mockResolvedValue(ok({ items: [], nextCursor: 'next' })),
    exec: vi
      .fn()
      .mockResolvedValue(ok({ execId: 'exec-1', status: 'exited', stdout: 'hello', stderr: '', exitCode: 0 })),
    getExec: vi.fn(),
    delete: vi.fn().mockResolvedValue(ok({ state: 'stopped' })),
    getFile: vi.fn().mockResolvedValue({ success: true, bytes: new TextEncoder().encode('你好') }),
    putFile: vi.fn().mockResolvedValue(ok({})),
  };
  return { low, api: new SandboxesClient(low as never) };
}
afterEach(() => vi.useRealTimers());
describe('single-key sandbox facade', () => {
  it('uses server defaults and waits for basic readiness without requiring an agent', async () => {
    const { low, api } = setup();
    const sandbox = await api.create({ idempotencyKey: 'create-once' });
    expect(low.create).toHaveBeenCalledWith({}, { idempotencyKey: 'create-once' });
    expect(low.get).toHaveBeenCalledWith('env-1');
    expect(sandbox.id).toBe('env-1');
  });
  it('does not resolve accepted creation before ready', async () => {
    vi.useFakeTimers();
    const { low, api } = setup();
    low.get.mockResolvedValueOnce(ok(status(false))).mockResolvedValue(ok(status(true)));
    let done = false;
    const pending = api.create().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(done).toBe(true);
  });
  it('returns a recovery ID when readiness times out', async () => {
    vi.useFakeTimers();
    const { low, api } = setup();
    low.get.mockResolvedValue(ok(status(false)));
    const assertion = expect(api.create({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
      environmentId: 'env-1',
    });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(low.create).toHaveBeenCalledTimes(1);
    expect(low.delete).not.toHaveBeenCalled();
  });
  it('bounds a stalled read by the overall deadline', async () => {
    vi.useFakeTimers();
    const { low, api } = setup();
    low.get.mockImplementation(() => new Promise(() => {}));
    const assertion = expect(api.create({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
      environmentId: 'env-1',
    });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });
  it('preserves auth errors and never retries them', async () => {
    const { low, api } = setup();
    low.get.mockResolvedValue({
      success: false,
      error: { code: 'scope_denied', message: 'denied' },
      requestId: 'req-denied',
    });
    await expect(api.create()).rejects.toMatchObject({
      code: 'scope_denied',
      requestId: 'req-denied',
      environmentId: 'env-1',
    });
    expect(low.get).toHaveBeenCalledTimes(1);
  });
  it('executes a shell string once and preserves nonzero exit status', async () => {
    const { low, api } = setup();
    low.exec.mockResolvedValue(ok({ status: 'exited', exitCode: 7, stdout: '', stderr: 'bad' }));
    const sandbox = await api.connect('env-1');
    await expect(sandbox.commands.run('echo "$HOME"')).resolves.toEqual({ exitCode: 7, stdout: '', stderr: 'bad' });
    expect(low.exec.mock.calls[0][1].command).toEqual(['/bin/sh', '-lc', 'echo "$HOME"']);
  });
  it('drains paged exec output without repeating stderr or launching another exec', async () => {
    const { low, api } = setup();
    low.exec.mockResolvedValue(ok({ status: 'running', execId: 'exec-1' }));
    low.getExec
      .mockResolvedValueOnce(ok({ status: 'exited', exitCode: 0, stdout: '你', stderr: 'warning', nextCursor: 3 }))
      .mockResolvedValueOnce(ok({ status: 'exited', exitCode: 0, stdout: '好', stderr: 'warning', nextCursor: null }));
    const sandbox = await api.connect('env-1');
    await expect(sandbox.commands.run('hello')).resolves.toEqual({ exitCode: 0, stdout: '你好', stderr: 'warning' });
    expect(low.getExec.mock.calls[1][2]).toEqual({ cursor: 3 });
    expect(low.exec).toHaveBeenCalledTimes(1);
  });
  it('does not replay commands on transport failure', async () => {
    const { low, api } = setup();
    low.exec.mockRejectedValue(new Error('network'));
    const sandbox = await api.connect('env-1');
    await expect(sandbox.commands.run('side-effect')).rejects.toThrow('network');
    expect(low.exec).toHaveBeenCalledTimes(1);
  });
  it('round trips UTF-8 files and retains list pagination', async () => {
    const { low, api } = setup();
    const sandbox = await api.connect('env-1');
    expect(await sandbox.files.read('text')).toBe('你好');
    await sandbox.files.write('text', '你好');
    expect(low.putFile).toHaveBeenCalledWith('env-1', 'text', new TextEncoder().encode('你好'));
    expect(await api.list()).toMatchObject({ nextCursor: 'next' });
  });
  it('rejects absolute file paths before transport instead of silently writing another path', async () => {
    const { low, api } = setup();
    const sandbox = await api.connect('env-1');
    await expect(sandbox.files.write('/tmp/text', 'hello')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(low.putFile).not.toHaveBeenCalled();
  });
  it('waits for confirmed stopped after delete acceptance', async () => {
    const { low, api } = setup();
    const sandbox = await api.connect('env-1');
    low.delete.mockResolvedValueOnce(ok({ state: 'stopping' })).mockResolvedValue(ok({ state: 'stopped' }));
    low.get.mockResolvedValue({ success: false, error: { code: 'not_owned', message: 'tombstoned' }, requestId: 'gone' });
    await sandbox.kill();
    expect(low.delete).toHaveBeenCalledTimes(2);
    expect(low.get).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid timeout before creating resources', async () => {
    const { low, api } = setup();
    await expect(api.create({ timeoutMs: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(low.create).not.toHaveBeenCalled();
  });
});

describe('PrismerClient sandbox transport', () => {
  it('uses the same project key for every request and honors Retry-After on read polling', async () => {
    vi.useFakeTimers();
    const { PrismerClient } = await import('../src/index');
    const responses = [
      new Response(JSON.stringify(ok(status(false, 'provisioning'))), { status: 202 }),
      new Response(
        JSON.stringify({ success: false, error: { code: 'rate_limited', message: 'wait' }, requestId: 'limited' }),
        { status: 429, headers: { 'Retry-After': '2' } },
      ),
      new Response(JSON.stringify(ok(status(true)))),
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const client = new PrismerClient({
      apiKey: 'sk-eaas-test-only',
      baseUrl: 'https://example.invalid',
      fetch: fetcher,
    });
    let done = false;
    const pending = client.sandboxes.create({ idempotencyKey: 'once' }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    for (const call of fetcher.mock.calls as unknown as [string, RequestInit][])
      expect(new Headers(call[1].headers).get('Authorization')).toBe('Bearer sk-eaas-test-only');
    expect(JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string)).toEqual({});
  });
});

it('keeps the create idempotency key when transport returns an uncertain failure', async () => {
  const { low, api } = setup();
  low.create.mockResolvedValue({
    success: false,
    error: { code: 'cloud_unreachable', message: 'connection lost' },
    requestId: 'req-create',
  });
  await expect(api.create({ idempotencyKey: 'recover-once' })).rejects.toMatchObject({
    code: 'cloud_unreachable',
    requestId: 'req-create',
    idempotencyKey: 'recover-once',
  });
  expect(low.create).toHaveBeenCalledTimes(1);
});
it('does not leave a long Retry-After timer alive beyond the operation deadline', async () => {
  vi.useFakeTimers();
  const { rememberRetryAfter } = await import('../src/eaas-response-meta');
  const { low, api } = setup();
  const throttled = { success: false as const, error: { code: 'rate_limited', message: 'wait' }, requestId: 'rate' };
  rememberRetryAfter(throttled, new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
  low.get.mockResolvedValue(throttled);
  const check = expect(api.create({ timeoutMs: 20 })).rejects.toMatchObject({
    code: 'timeout',
    environmentId: 'env-1',
  });
  await vi.advanceTimersByTimeAsync(21);
  await check;
  expect(vi.getTimerCount()).toBe(0);
});

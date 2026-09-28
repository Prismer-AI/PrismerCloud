import { afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ ensure: vi.fn(async () => ({ marker: 'fixture' })) }));
vi.mock('../src/adapters/coding/shared/make-code-agent-adapter.js', () => ({
  makeCodeAgentAdapter: () => ({ ensureService: calls.ensure }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); calls.ensure.mockClear(); });
describe('real e2e harness credential boundary', () => {
  it('does not inject a development credential and refuses launch without an explicit key', async () => {
    vi.stubEnv('PRISMER_API_KEY', undefined);
    const { makeService } = await import('../src/adapters/coding/shared/e2e/harness.js');
    expect(Boolean(process.env.PRISMER_API_KEY)).toBe(false);
    await expect(makeService('claude', '/tmp/harness-credential-test')).rejects.toThrow('PRISMER_API_KEY');
    expect(calls.ensure).not.toHaveBeenCalled();
  });
  it('retains the caller-supplied key and reaches the injected adapter', async () => {
    vi.stubEnv('PRISMER_API_KEY', 'explicit-unit-fixture');
    const { makeService } = await import('../src/adapters/coding/shared/e2e/harness.js');
    expect(process.env.PRISMER_API_KEY === 'explicit-unit-fixture').toBe(true);
    await makeService('claude', '/tmp/harness-credential-test');
    expect(calls.ensure).toHaveBeenCalledOnce();
  });
});

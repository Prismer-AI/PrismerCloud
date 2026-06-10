import { afterEach, describe, expect, it, vi } from 'vitest';

// Per-user (newapi) sources mint a token via the newapi admin API — stub it so
// the chain resolver stays a pure unit test (no network).
vi.mock('@/lib/newapi-admin', () => ({
  resolveNewAPIToken: vi.fn(async () => 'newapi-token-stub'),
}));

import { __test } from '@/lib/llm-proxy';
import { _resetProviderConfigCache } from '@/lib/llm/provider-sources';

const { buildSourceSpecs } = __test;

afterEach(() => {
  vi.unstubAllEnvs();
  _resetProviderConfigCache();
});

/**
 * release202/07 fix — an explicitly-pinned chain whose only source is unusable
 * must NOT silently degrade to the platform default (newapi). It returns zero
 * specs + the drop reason so the proxy can surface `provider_chain_unconfigured`
 * instead of forwarding a `deepseek-*` model to newapi → opaque 500.
 */
describe('buildSourceSpecs — no silent cross-chain degrade', () => {
  it('deepseek chain with no DEEPSEEK_API_KEY → empty specs + missing-key drop', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    _resetProviderConfigCache();

    const { specs, dropped, chainId } = await buildSourceSpecs({
      chainId: 'deepseek',
      endpoint: '/v1/chat/completions',
      endpointKind: 'chat',
      userId: 'u1',
      requestModel: 'deepseek-v4-flash',
    });

    expect(specs).toHaveLength(0);
    expect(dropped).toEqual([{ id: 'deepseek', reason: 'missing-key' }]);
    expect(chainId).toBe('deepseek'); // did NOT re-route to 'default'
  });

  it('deepseek chain WITH key → one spec, request model passed through verbatim', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test-deepseek');
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com');
    _resetProviderConfigCache();

    const { specs, dropped } = await buildSourceSpecs({
      chainId: 'deepseek',
      endpoint: '/v1/chat/completions',
      endpointKind: 'chat',
      userId: 'u1',
      requestModel: 'deepseek-v4-flash',
    });

    expect(dropped).toHaveLength(0);
    expect(specs).toHaveLength(1);
    expect(specs[0].id).toBe('deepseek');
    expect(specs[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(specs[0].model).toBe('deepseek-v4-flash'); // inherited from request, not coerced
    expect(specs[0].modelCoerced).toBe(false);
  });

  it('multi-source chain with dropped primary → promoted fallback coerces to its OWN default (not the dropped model id)', async () => {
    // deepseek (primary, no key → dropped) then newapi (per-user). The promoted
    // newapi must send its own default model, never the unservable deepseek id.
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('NEWAPI_BASE_URL', 'http://newapi.local:3000');
    vi.stubEnv('LLM_PROVIDER_CHAINS', JSON.stringify({ mixed: ['deepseek', 'newapi'] }));
    _resetProviderConfigCache();

    const { specs, dropped } = await buildSourceSpecs({
      chainId: 'mixed',
      endpoint: '/v1/chat/completions',
      endpointKind: 'chat',
      userId: 'u1',
      requestModel: 'deepseek-v4-flash',
    });

    expect(dropped).toEqual([{ id: 'deepseek', reason: 'missing-key' }]);
    expect(specs).toHaveLength(1);
    expect(specs[0].id).toBe('newapi');
    expect(specs[0].model).not.toBe('deepseek-v4-flash'); // coerced off the dropped primary's id
    expect(specs[0].modelCoerced).toBe(true);
  });
});

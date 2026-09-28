// Desktop-202 Phase 7 (docs/desktop202/12) — daemon-local LLM provider
// direct-connect resolution layer (BYOK / Ollama). Pure-function + injection
// tests; no spawn, no real network (probeOllama hits a stub fetch).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderProfileSchema,
  effectiveBaseUrl,
  keyRefEnvVar,
  probeOllama,
  providerTypeRequiresKey,
  resolveKeyRef,
  resolveLocalProvider,
  isLocalProviderSelector,
  localProviderProfileId,
  LOCAL_PROVIDER_PREFIX,
  setKeyRefResolver,
  setLocalProviders,
  hermesApiModeForType,
  hermesWireBaseUrl,
  codexSupportsLocalType,
  claudeCodeSupportsLocalType,
  PROVIDER_PROFILE_TYPES,
  type ProviderProfile,
  type ResolvedLocalProvider,
} from '../src/adapters/shared/local-provider.js';
import { resolveCodexPrismerProvider, CodexConfigSchema } from '../src/adapters/coding/codex/index.js';
import { ConfigSchema } from '../src/config.js';

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile =>
  ProviderProfileSchema.parse({ id: 'p', type: 'anthropic', key_ref: 'keychain:p', ...over });

afterEach(() => {
  setLocalProviders(null);
  setKeyRefResolver(null);
  vi.restoreAllMocks();
});

describe('ProviderProfileSchema', () => {
  it('parses a BYOK anthropic profile', () => {
    const p = ProviderProfileSchema.parse({
      id: 'my-anthropic',
      type: 'anthropic',
      key_ref: 'keychain:my-anthropic',
      models: ['claude-sonnet-4-6'],
      vision: true,
      max_context: 200000,
    });
    expect(p.type).toBe('anthropic');
    expect(p.vision).toBe(true);
  });

  it('parses a keyless ollama profile', () => {
    const p = ProviderProfileSchema.parse({
      id: 'local-ollama',
      type: 'ollama',
      base_url: 'http://127.0.0.1:11434',
    });
    expect(p.key_ref).toBeUndefined();
    expect(providerTypeRequiresKey(p.type)).toBe(false);
  });

  it('requires base_url for openai-compatible', () => {
    const r = ProviderProfileSchema.safeParse({ id: 'vllm', type: 'openai-compatible' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'base_url')).toBe(true);
    }
  });

  it('accepts openai-compatible when base_url is present', () => {
    const p = ProviderProfileSchema.parse({
      id: 'vllm',
      type: 'openai-compatible',
      base_url: 'http://127.0.0.1:8000/v1',
    });
    expect(p.base_url).toBe('http://127.0.0.1:8000/v1');
  });

  it('rejects an unknown type', () => {
    expect(ProviderProfileSchema.safeParse({ id: 'x', type: 'mistral' }).success).toBe(false);
  });
});

describe('effectiveBaseUrl — type defaults', () => {
  it('falls back to the anthropic default when base_url omitted', () => {
    expect(effectiveBaseUrl(profile({ type: 'anthropic' }))).toBe('https://api.anthropic.com');
  });
  it('uses the explicit base_url (trailing slash stripped)', () => {
    expect(effectiveBaseUrl(profile({ base_url: 'https://x.example.com/' }))).toBe(
      'https://x.example.com',
    );
  });
  it('ollama defaults to localhost:11434', () => {
    expect(effectiveBaseUrl(profile({ id: 'o', type: 'ollama', key_ref: undefined }))).toBe(
      'http://127.0.0.1:11434',
    );
  });
});

describe('resolveKeyRef — env fallback + injected resolver', () => {
  it('keyRefEnvVar normalizes the id', () => {
    expect(keyRefEnvVar('keychain:my-anthropic')).toBe('PRISMER_PROVIDER_KEY_my_anthropic');
  });

  it('reads from env fallback when no resolver injected', () => {
    process.env.PRISMER_PROVIDER_KEY_p = 'sk-env-key';
    try {
      expect(resolveKeyRef('keychain:p')).toBe('sk-env-key');
    } finally {
      delete process.env.PRISMER_PROVIDER_KEY_p;
    }
  });

  it('injected resolver wins over env', () => {
    process.env.PRISMER_PROVIDER_KEY_p = 'sk-env-key';
    setKeyRefResolver(() => 'sk-keychain-key');
    try {
      expect(resolveKeyRef('keychain:p')).toBe('sk-keychain-key');
    } finally {
      delete process.env.PRISMER_PROVIDER_KEY_p;
    }
  });

  it('returns null when unresolved', () => {
    expect(resolveKeyRef('keychain:nope')).toBeNull();
    expect(resolveKeyRef(undefined)).toBeNull();
  });
});

describe('resolveLocalProvider — doc §2 middle layer', () => {
  it('returns null for cloud-chain selectors (newapi/default) — existing path', () => {
    setLocalProviders([profile({ id: 'newapi' })]);
    expect(resolveLocalProvider('newapi')).toBeNull();
    expect(resolveLocalProvider('default')).toBeNull();
    expect(resolveLocalProvider(undefined)).toBeNull();
  });

  it('returns null when no profile matches the selector', () => {
    setLocalProviders([profile({ id: 'my-anthropic' })]);
    expect(resolveLocalProvider('deepseek')).toBeNull(); // cloud chain id, no local match
  });

  it('returns null when no profiles configured (CLI/K8s/web — byte-identical)', () => {
    setLocalProviders(null);
    expect(resolveLocalProvider('my-anthropic')).toBeNull();
  });

  it('resolves a matched BYOK profile with its key', () => {
    setKeyRefResolver(() => 'sk-byok');
    setLocalProviders([
      profile({ id: 'my-anthropic', type: 'anthropic', key_ref: 'keychain:a', vision: true }),
    ]);
    const r = resolveLocalProvider('my-anthropic');
    expect(r).not.toBeNull();
    expect(r!.baseUrl).toBe('https://api.anthropic.com');
    expect(r!.apiKey).toBe('sk-byok');
    expect(r!.vision).toBe(true);
  });

  it('resolves a keyless ollama profile (apiKey null)', () => {
    setLocalProviders([
      ProviderProfileSchema.parse({ id: 'local-ollama', type: 'ollama' }),
    ]);
    const r = resolveLocalProvider('local-ollama');
    expect(r).not.toBeNull();
    expect(r!.apiKey).toBeNull();
    expect(r!.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('falls back (null) when a keyed profile has no resolvable key', () => {
    // key_ref present but neither injected resolver nor env supplies it.
    setLocalProviders([profile({ id: 'my-anthropic', key_ref: 'keychain:absent' })]);
    expect(resolveLocalProvider('my-anthropic')).toBeNull();
  });

  it('explicit list arg overrides the injected source', () => {
    setLocalProviders([profile({ id: 'injected' })]);
    expect(resolveLocalProvider('injected', [])).toBeNull();
  });
});

describe('wire-format adaptation — doc §2 (Phase 7 second wave)', () => {
  const resolved = (over: Partial<ResolvedLocalProvider> = {}): ResolvedLocalProvider => ({
    profileId: 'p',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk',
    vision: undefined,
    maxContext: undefined,
    models: undefined,
    ...over,
  });

  it('hermes api_mode: anthropic → anthropic_messages (native), rest → chat_completions', () => {
    expect(hermesApiModeForType('anthropic')).toBe('anthropic_messages');
    expect(hermesApiModeForType('openai')).toBe('chat_completions');
    expect(hermesApiModeForType('deepseek')).toBe('chat_completions');
    expect(hermesApiModeForType('ollama')).toBe('chat_completions');
    expect(hermesApiModeForType('openai-compatible')).toBe('chat_completions');
  });

  it('hermes wire base_url: ollama gets the OpenAI-compatible /v1 suffix', () => {
    expect(hermesWireBaseUrl(resolved({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' }))).toBe(
      'http://127.0.0.1:11434/v1',
    );
    // already-suffixed base is not double-suffixed
    expect(hermesWireBaseUrl(resolved({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }))).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('hermes wire base_url: non-ollama types pass through verbatim', () => {
    expect(hermesWireBaseUrl(resolved({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }))).toBe(
      'https://api.anthropic.com',
    );
    expect(hermesWireBaseUrl(resolved({ type: 'openai', baseUrl: 'https://api.openai.com/v1' }))).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('codex supports ONLY openai natively (responses-only limitation)', () => {
    expect(codexSupportsLocalType('openai')).toBe(true);
    expect(codexSupportsLocalType('anthropic')).toBe(false);
    expect(codexSupportsLocalType('deepseek')).toBe(false);
    expect(codexSupportsLocalType('ollama')).toBe(false);
    expect(codexSupportsLocalType('openai-compatible')).toBe(false);
  });

  it('claude-code supports ONLY anthropic natively (Anthropic-Messages-wire-only limitation)', () => {
    // CC's client POSTs an Anthropic body to `<base>/v1/messages`. Every other
    // local type serves the OpenAI chat_completions wire → would 404/400. The
    // adapter must DECLINE (warn + cloud-chain fallback), not mis-wire.
    expect(claudeCodeSupportsLocalType('anthropic')).toBe(true);
    expect(claudeCodeSupportsLocalType('openai')).toBe(false);
    expect(claudeCodeSupportsLocalType('deepseek')).toBe(false);
    expect(claudeCodeSupportsLocalType('ollama')).toBe(false);
    expect(claudeCodeSupportsLocalType('openai-compatible')).toBe(false);
  });

  it('codex + claude-code cover DISJOINT local types (responses vs anthropic wire)', () => {
    for (const type of PROVIDER_PROFILE_TYPES) {
      expect(codexSupportsLocalType(type) && claudeCodeSupportsLocalType(type)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// `local:` selector namespace — the cloud-side wedge this closes
// ---------------------------------------------------------------------------
//
// A local profile id could never be PERSISTED: the cloud validator rejects any
// `proxyProvider` it doesn't know, and it structurally cannot know a profile
// that lives in this machine's config.toml. `local:<id>` makes the selector
// self-describing so the cloud accepts it blind; the daemon must therefore
// resolve BOTH forms — prefixed (everything written from now on) and bare (the
// form these tests, the config.toml, and any hand-written profile still use).
describe('resolveLocalProvider — `local:` namespace', () => {
  it('resolves a `local:<id>` selector to the profile it names', () => {
    setKeyRefResolver(() => 'sk-byok');
    setLocalProviders([profile({ id: 'qwen', type: 'openai', key_ref: 'keychain:q' })]);
    const r = resolveLocalProvider('local:qwen');
    expect(r).not.toBeNull();
    expect(r!.profileId).toBe('qwen');
    expect(r!.apiKey).toBe('sk-byok');
  });

  it('BACKWARD COMPAT: the bare id still resolves to the same profile', () => {
    setKeyRefResolver(() => 'sk-byok');
    setLocalProviders([profile({ id: 'qwen', type: 'openai', key_ref: 'keychain:q' })]);
    expect(resolveLocalProvider('qwen')?.profileId).toBe('qwen');
    expect(resolveLocalProvider('local:qwen')?.profileId).toBe('qwen');
  });

  it('exports the prefix + strip helpers, and they agree with the resolver', () => {
    expect(LOCAL_PROVIDER_PREFIX).toBe('local:');
    expect(isLocalProviderSelector('local:qwen')).toBe(true);
    expect(isLocalProviderSelector('qwen')).toBe(false);
    expect(isLocalProviderSelector('not-local:qwen')).toBe(false);
    expect(localProviderProfileId('local:qwen')).toBe('qwen');
    expect(localProviderProfileId('qwen')).toBe('qwen');
  });

  it('a namespaced selector escapes the reserved cloud-chain aliases', () => {
    // Bare `newapi` is a cloud chain and must stay one. But a user who named a
    // local profile `newapi` said so unambiguously via the prefix.
    setLocalProviders([ProviderProfileSchema.parse({ id: 'newapi', type: 'ollama' })]);
    expect(resolveLocalProvider('newapi')).toBeNull();
    expect(resolveLocalProvider('local:newapi')?.profileId).toBe('newapi');
  });

  it('`local:` with no id resolves to nothing (never a wildcard match)', () => {
    setLocalProviders([ProviderProfileSchema.parse({ id: 'local-ollama', type: 'ollama' })]);
    expect(resolveLocalProvider('local:')).toBeNull();
  });

  it('a namespaced selector naming no profile stays null (cloud-chain fallthrough)', () => {
    setLocalProviders([ProviderProfileSchema.parse({ id: 'local-ollama', type: 'ollama' })]);
    expect(resolveLocalProvider('local:absent')).toBeNull();
  });
});

describe('resolveCodexPrismerProvider — resolution priority integration', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.PRISMER_BASE_URL;
    delete process.env.PRISMER_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const cfg = (over: Record<string, unknown> = {}) =>
    CodexConfigSchema.parse({ cwd: '/tmp', model: 'm', ...over });

  it('BACKWARD COMPAT: no local profiles → cloud chain path byte-identical', () => {
    setLocalProviders(null);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    // newapi → /api/v1
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'newapi' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api/v1',
      apiKey: 'sk-prismer-x',
    });
    // arbitrary chain → /api/v1/proxy/<chain>
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'deepseek' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api/v1/proxy/deepseek',
      apiKey: 'sk-prismer-x',
    });
  });

  it('local profile selected → direct-connect base_url + BYOK key', () => {
    setKeyRefResolver(() => 'sk-byok');
    setLocalProviders([
      profile({ id: 'my-openai', type: 'openai', key_ref: 'keychain:o' }),
    ]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'my-openai' }))).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-byok',
    });
  });

  it('local profile with unresolvable key → falls back to cloud chain', () => {
    setLocalProviders([profile({ id: 'my-openai', type: 'openai', key_ref: 'keychain:absent' })]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    // proxyProvider 'my-openai' matches no cloud chain alias → /api/v1/proxy/my-openai
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'my-openai' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api/v1/proxy/my-openai',
      apiKey: 'sk-prismer-x',
    });
  });

  it('proxyProvider unset → null (legacy official OpenAI path)', () => {
    setLocalProviders([profile({ id: 'my-openai', type: 'openai' })]);
    expect(resolveCodexPrismerProvider(cfg({}))).toBeNull();
  });

  it('codex-incompatible local type (ollama) → declines direct-connect, falls back to cloud chain', () => {
    // codex is responses-only; ollama serves chat_completions → not codex-native.
    setLocalProviders([ProviderProfileSchema.parse({ id: 'local-ollama', type: 'ollama' })]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    // proxyProvider 'local-ollama' matches no cloud alias → /api/v1/proxy/local-ollama
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'local-ollama' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api/v1/proxy/local-ollama',
      apiKey: 'sk-prismer-x',
    });
  });

  it('namespaced local profile selected → direct-connect base_url + BYOK key', () => {
    setKeyRefResolver(() => 'sk-byok');
    setLocalProviders([profile({ id: 'my-openai', type: 'openai', key_ref: 'keychain:o' })]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'local:my-openai' }))).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-byok',
    });
  });

  it('an UNRESOLVED `local:` selector lands on the aggregator, never on a bogus proxy chain', () => {
    // The selector names nothing the cloud has, so walking it as a chain would
    // produce `/api/v1/proxy/local%3Amy-openai/responses` → 404 on every call.
    // Landing on `/api/v1` degrades to the platform default instead of breaking.
    setLocalProviders([profile({ id: 'my-openai', type: 'openai', key_ref: 'keychain:absent' })]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    const r = resolveCodexPrismerProvider(cfg({ proxyProvider: 'local:my-openai' }));
    expect(r).toEqual({ baseUrl: 'https://test.docbrew.cn/api/v1', apiKey: 'sk-prismer-x' });
    expect(r!.baseUrl).not.toContain('proxy');
  });

  it('codex-incompatible local type (anthropic) with resolvable key → still falls back to cloud chain', () => {
    setKeyRefResolver(() => 'sk-byok');
    setLocalProviders([profile({ id: 'my-anthropic', type: 'anthropic', key_ref: 'keychain:a' })]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'my-anthropic' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api/v1/proxy/my-anthropic',
      apiKey: 'sk-prismer-x',
    });
  });
});

describe('ConfigSchema — providers field', () => {
  const base = {
    api_key: 'sk-prismer-x',
    cloud_api_base: 'http://127.0.0.1:3000',
    daemon_id: 'd1',
  };

  it('parses config with no providers (backward compat)', () => {
    const c = ConfigSchema.parse(base);
    expect(c.providers).toBeUndefined();
  });

  it('parses config with providers', () => {
    const c = ConfigSchema.parse({
      ...base,
      providers: [
        { id: 'my-anthropic', type: 'anthropic', key_ref: 'keychain:a', vision: true },
        { id: 'local-ollama', type: 'ollama' },
      ],
    });
    expect(c.providers).toHaveLength(2);
  });

  it('rejects an invalid provider (openai-compatible without base_url)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      providers: [{ id: 'vllm', type: 'openai-compatible' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('probeOllama — GET /api/tags', () => {
  it('returns models on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'llama3.2' }, { name: 'qwen2.5' }] }),
      })),
    );
    const r = await probeOllama('http://127.0.0.1:11434');
    expect(r.available).toBe(true);
    expect(r.models).toEqual(['llama3.2', 'qwen2.5']);
  });

  it('returns unavailable on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const r = await probeOllama();
    expect(r.available).toBe(false);
    expect(r.error).toBe('HTTP 503');
  });

  it('returns unavailable on network error (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const r = await probeOllama();
    expect(r.available).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

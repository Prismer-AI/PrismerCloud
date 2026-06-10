/**
 * release202/07 P1 — Provider Source Registry + Fallback Chain config layer.
 *
 * 验证:
 *  1. env 缺失 → 内建 sources(newapi/deepseek) + 内建 chains(default/newapi/deepseek)
 *  2. LLM_PROVIDER_SOURCES / LLM_PROVIDER_CHAINS JSON 解析 + 合并(custom 覆盖内建)
 *  3. resolveChain: 命名 chain / bare source id / 未知 id → default / 跳过缺失 source
 *  4. $ENV 引用展开(baseUrl/defaultModel) + deepseek env-default 兜底
 *  5. vision: isVisionModel + applyVisionFilter(首 source 保留, fallback 过滤)
 *  6. cache 分桶 + _reset
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  getProviderSources,
  getProviderChainIds,
  resolveChain,
  isVisionModel,
  applyVisionFilter,
  _resetProviderConfigCache,
  type ResolvedSource,
} from '@/lib/llm/provider-sources';

const SAVE: Record<string, string | undefined> = {};
const KEYS = [
  'LLM_PROVIDER_SOURCES',
  'LLM_PROVIDER_CHAINS',
  'LLM_VISION_MODELS',
  'NEWAPI_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_API_KEY',
];

beforeEach(() => {
  for (const k of KEYS) SAVE[k] = process.env[k];
  _resetProviderConfigCache();
  for (const k of KEYS) delete process.env[k];
  process.env.NEWAPI_BASE_URL = 'https://newapi.example.com';
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVE[k] === undefined) delete process.env[k];
    else process.env[k] = SAVE[k];
  }
  _resetProviderConfigCache();
});

function byId(sources: ResolvedSource[], id: string): ResolvedSource | undefined {
  return sources.find((s) => s.id === id);
}

describe('built-in defaults (env absent)', () => {
  it('exposes newapi + deepseek sources', () => {
    const ids = getProviderSources().map((s) => s.id);
    expect(ids).toContain('newapi');
    expect(ids).toContain('deepseek');
  });

  it('exposes default/newapi/deepseek chains', () => {
    const ids = getProviderChainIds();
    expect(ids).toContain('default');
    expect(ids).toContain('newapi');
    expect(ids).toContain('deepseek');
  });

  it('default chain is newapi-only (zero-drift)', () => {
    expect(resolveChain('default').map((s) => s.id)).toEqual(['newapi']);
  });

  it('newapi source expands $NEWAPI_BASE_URL + is per-user + vision', () => {
    const s = byId(resolveChain('newapi'), 'newapi')!;
    expect(s.baseUrl).toBe('https://newapi.example.com');
    expect(s.tokenMode).toBe('per-user');
    expect(s.vision).toBe(true);
    expect(s.defaultModel).toBe('us-kimi-k2.6');
  });

  it('deepseek source falls back to api.deepseek.com + deepseek-v4-flash when env unset', () => {
    const s = byId(resolveChain('deepseek'), 'deepseek')!;
    expect(s.baseUrl).toBe('https://api.deepseek.com');
    expect(s.tokenMode).toBe('static');
    expect(s.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(s.defaultModel).toBe('deepseek-v4-flash');
    expect(s.vision).toBe(false);
  });

  it('honours DEEPSEEK_BASE_URL / DEEPSEEK_MODEL when set', () => {
    process.env.DEEPSEEK_BASE_URL = 'https://ds.internal';
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    _resetProviderConfigCache();
    const s = byId(resolveChain('deepseek'), 'deepseek')!;
    expect(s.baseUrl).toBe('https://ds.internal');
    expect(s.defaultModel).toBe('deepseek-v4-pro');
  });
});

describe('config-driven sources + chains', () => {
  it('parses LLM_PROVIDER_SOURCES and merges over built-ins', () => {
    process.env.LLM_PROVIDER_SOURCES = JSON.stringify([
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/api', tokenMode: 'static', apiKeyEnv: 'OPENROUTER_KEY', defaultModel: 'x', vision: true },
    ]);
    _resetProviderConfigCache();
    const ids = getProviderSources().map((s) => s.id);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('newapi'); // built-in still present as safety net
  });

  it('supports UNBOUNDED chain length (source1→2→3→…)', () => {
    process.env.LLM_PROVIDER_SOURCES = JSON.stringify([
      { id: 's1', baseUrl: 'https://s1', tokenMode: 'static', apiKeyEnv: 'K1', defaultModel: 'm1' },
      { id: 's2', baseUrl: 'https://s2', tokenMode: 'static', apiKeyEnv: 'K2', defaultModel: 'm2' },
      { id: 's3', baseUrl: 'https://s3', tokenMode: 'static', apiKeyEnv: 'K3', defaultModel: 'm3' },
    ]);
    process.env.LLM_PROVIDER_CHAINS = JSON.stringify({ triple: ['s1', 's2', 's3'] });
    _resetProviderConfigCache();
    expect(resolveChain('triple').map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('custom chain overrides built-in of same name', () => {
    process.env.LLM_PROVIDER_CHAINS = JSON.stringify({ default: ['deepseek', 'newapi'] });
    _resetProviderConfigCache();
    expect(resolveChain('default').map((s) => s.id)).toEqual(['deepseek', 'newapi']);
  });

  it('malformed JSON → built-ins (no throw)', () => {
    process.env.LLM_PROVIDER_SOURCES = '{not json';
    process.env.LLM_PROVIDER_CHAINS = '[]'; // wrong shape
    _resetProviderConfigCache();
    expect(getProviderSources().map((s) => s.id)).toContain('newapi');
    expect(resolveChain('default').map((s) => s.id)).toEqual(['newapi']);
  });
});

describe('resolveChain edge cases', () => {
  it('unknown chain id → default', () => {
    expect(resolveChain('nope').map((s) => s.id)).toEqual(['newapi']);
  });

  it('bare source id (no named chain) → single-element chain', () => {
    // legacy proxyProvider:'deepseek' with no 'deepseek' chain declared still works
    process.env.LLM_PROVIDER_CHAINS = JSON.stringify({ default: ['newapi'] }); // no deepseek chain
    _resetProviderConfigCache();
    expect(resolveChain('deepseek').map((s) => s.id)).toEqual(['deepseek']);
  });

  it('skips chain entries missing from registry', () => {
    process.env.LLM_PROVIDER_CHAINS = JSON.stringify({ mixed: ['newapi', 'ghost', 'deepseek'] });
    _resetProviderConfigCache();
    expect(resolveChain('mixed').map((s) => s.id)).toEqual(['newapi', 'deepseek']);
  });

  it('undefined chainId → default', () => {
    expect(resolveChain(undefined).map((s) => s.id)).toEqual(['newapi']);
  });
});

describe('vision filter (decision 1)', () => {
  it('isVisionModel matches the curated vision set', () => {
    expect(isVisionModel('gemini-3.1-pro-preview')).toBe(true);
    expect(isVisionModel('us-kimi-k2.6')).toBe(true);
    expect(isVisionModel('deepseek-v4-flash')).toBe(false);
    expect(isVisionModel(undefined)).toBe(false);
  });

  it('text model → no filtering (full chain)', () => {
    const chain = resolveChain('default').concat(resolveChain('deepseek'));
    const out = applyVisionFilter(chain, 'deepseek-v4-flash');
    expect(out.length).toBe(chain.length);
  });

  it('vision model → first source kept, non-vision fallbacks dropped', () => {
    process.env.LLM_PROVIDER_SOURCES = JSON.stringify([
      { id: 'vis', baseUrl: 'https://vis', tokenMode: 'static', apiKeyEnv: 'K', defaultModel: 'm', vision: true },
      { id: 'txt', baseUrl: 'https://txt', tokenMode: 'static', apiKeyEnv: 'K', defaultModel: 'm', vision: false },
    ]);
    process.env.LLM_PROVIDER_CHAINS = JSON.stringify({ c: ['newapi', 'txt', 'vis'] });
    _resetProviderConfigCache();
    const chain = resolveChain('c');
    const out = applyVisionFilter(chain, 'gemini-3.1-pro-preview');
    // index 0 (newapi, vision) kept; txt(non-vision) dropped; vis kept
    expect(out.map((s) => s.id)).toEqual(['newapi', 'vis']);
  });

  it('vision model + non-vision FIRST source → first still kept (user explicit pick)', () => {
    process.env.LLM_PROVIDER_CHAINS = JSON.stringify({ c: ['deepseek', 'newapi'] });
    _resetProviderConfigCache();
    const out = applyVisionFilter(resolveChain('c'), 'gemini-3.1-pro-preview');
    expect(out.map((s) => s.id)).toEqual(['deepseek', 'newapi']); // deepseek[0] kept, newapi vision kept
  });

  it('LLM_VISION_MODELS env overrides the vision set', () => {
    process.env.LLM_VISION_MODELS = JSON.stringify(['custom-vis']);
    _resetProviderConfigCache();
    expect(isVisionModel('custom-vis')).toBe(true);
    expect(isVisionModel('gemini-3.1-pro-preview')).toBe(false);
  });
});

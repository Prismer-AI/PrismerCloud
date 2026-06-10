/**
 * 2026-05-30 — DeepSeek bypass 路径上 model pass-through 改造单测.
 *
 * 验证 `feat(workspace-ui): proxyProvider × model 紧耦合` 的服务端契约改动:
 *   1. 老行为 (silent override): bypass on → body.model 一律被 DEEPSEEK_MODEL env
 *      或 `'deepseek-v4-flash'` 覆盖, UI 显示的 model 跟实际跑的 model 脱节.
 *   2. 新行为:
 *      - body 里有有效 DeepSeek model (例如 `deepseek-v4-pro`) → 透传
 *      - body 里没 `model` 字段 → 用 env-configured fallback 兜底
 *      - body 里的 model 不是 DeepSeek 系 (旧 daemon 误发 `us-kimi-k2.6`) →
 *        安全网兜底成 fallback + warn log
 *
 * 通过 mock 全套上游 collaborator 直接观察 proxyToNewAPI 写出去的 upstream
 * request body. 不真起 Redis / Nacos / 后端.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ioredis — proxy 在初始化时会触发 cache 模块, 不能真连.
class FakeRedis {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  on() {}
}
vi.mock('ioredis', () => ({
  default: vi.fn(() => new FakeRedis()),
}));

// Stub Nacos config so 上游 ensureNacosConfig() 是 no-op.
vi.mock('@/lib/nacos-config', () => ({
  ensureNacosConfig: vi.fn(async () => {}),
}));

// Stub newapi token resolver — bypass 路径不会走 newapi, 但 import-time
// 加载这层依赖避免炸.
vi.mock('@/lib/newapi-admin', () => ({
  resolveNewAPIToken: vi.fn(async () => 'fake-token'),
}));

// Stub usage-recorder so post-hoc 计费不污染测试.
vi.mock('@/lib/usage-recorder', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    recordUsageBackground: vi.fn(),
  };
});

// 抓 upstream fetch 的 body —— 这是断言的核心.
const capturedFetches: Array<{ url: string; body: string | null }> = [];

beforeEach(() => {
  capturedFetches.length = 0;
  process.env.DEEPSEEK_BYPASS_ENABLED = 'true';
  process.env.DEEPSEEK_API_KEY = 'sk-fake-deepseek-key';
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
  // 不显式设 DEEPSEEK_MODEL —— 走 default `'deepseek-v4-flash'`.
  delete process.env.DEEPSEEK_MODEL;

  // Stub global fetch to capture upstream call and return a minimal non-streaming
  // chat completion payload.
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : null;
    capturedFetches.push({ url: String(url), body });
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-xyz',
        object: 'chat.completion',
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DEEPSEEK_BYPASS_ENABLED;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
});

function makeRequest(body: Record<string, unknown>): import('next/server').NextRequest {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require('next/server') as typeof import('next/server');
  return new NextRequest('http://localhost/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function fakeGuard() {
  return {
    ok: true as const,
    auth: { userId: 'u1', authHeader: 'Bearer t', source: 'jwt', userEmail: null },
  } as unknown as Parameters<typeof import('@/lib/llm-proxy').proxyToNewAPI>[1];
}

describe('llm-proxy DeepSeek bypass — model pass-through', () => {
  it('body 里有有效 DeepSeek model → 透传, 不被 env fallback 覆盖 (核心改动)', async () => {
    const { proxyToNewAPI } = await import('@/lib/llm-proxy');
    await proxyToNewAPI(
      makeRequest({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }),
      fakeGuard(),
      '/v1/chat/completions',
      'deepseek',
    );

    expect(capturedFetches).toHaveLength(1);
    const upstream = JSON.parse(capturedFetches[0]!.body!);
    expect(upstream.model).toBe('deepseek-v4-pro');
  });

  it('body 里没 `model` 字段 → 用 env-configured fallback 兜底 (默认 `deepseek-v4-flash`)', async () => {
    const { proxyToNewAPI } = await import('@/lib/llm-proxy');
    await proxyToNewAPI(
      makeRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      fakeGuard(),
      '/v1/chat/completions',
      'deepseek',
    );

    const upstream = JSON.parse(capturedFetches[0]!.body!);
    expect(upstream.model).toBe('deepseek-v4-flash');
  });

  it('body 里 model 不是 DeepSeek 系 (旧 daemon 发 `us-kimi-k2.6`) → 安全网兜底成 fallback', async () => {
    const { proxyToNewAPI } = await import('@/lib/llm-proxy');
    await proxyToNewAPI(
      makeRequest({ model: 'us-kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] }),
      fakeGuard(),
      '/v1/chat/completions',
      'deepseek',
    );

    const upstream = JSON.parse(capturedFetches[0]!.body!);
    expect(upstream.model).toBe('deepseek-v4-flash');
  });

  it('DEEPSEEK_MODEL env 设定时 → fallback 跟随 env, 不再 force override 有效 model', async () => {
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    const { proxyToNewAPI } = await import('@/lib/llm-proxy');

    // (a) 有 valid DeepSeek model → 透传, env 不参与
    await proxyToNewAPI(
      makeRequest({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
      fakeGuard(),
      '/v1/chat/completions',
      'deepseek',
    );
    const upstreamA = JSON.parse(capturedFetches[0]!.body!);
    expect(upstreamA.model).toBe('deepseek-v4-flash');

    // (b) 没 model → 用 env fallback
    capturedFetches.length = 0;
    await proxyToNewAPI(
      makeRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      fakeGuard(),
      '/v1/chat/completions',
      'deepseek',
    );
    const upstreamB = JSON.parse(capturedFetches[0]!.body!);
    expect(upstreamB.model).toBe('deepseek-v4-pro');
  });
});

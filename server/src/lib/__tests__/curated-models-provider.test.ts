/**
 * 2026-05-30 — `getCuratedModels(provider)` 漏斗隔离 + cache 分桶单测.
 *
 * 验证 commit `feat(workspace-ui): proxyProvider × model 紧耦合` 的服务端契约:
 *
 *  1. `provider === 'newapi'` 永远返回 NewAPI 漏斗 (gemini / kimi 系)，绕开
 *     `DEEPSEEK_BYPASS_ENABLED` env 与 `CURATED_MODELS` JSON override.
 *  2. `provider === 'deepseek'` 永远返回 DeepSeek 漏斗 (deepseek-v4-flash /
 *     deepseek-v4-pro)，同样绕 env.
 *  3. `provider === undefined` 走老 env-driven 路径，backwards-compat for CLI.
 *  4. 三个 cache bucket 互相隔离 — 切 provider 再切回来命中正确 bucket.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { getCuratedModels, _resetCuratedModelsCache } from '@/app/api/models/curated-models';

const ORIGINAL_BYPASS = process.env.DEEPSEEK_BYPASS_ENABLED;
const ORIGINAL_CURATED = process.env.CURATED_MODELS;

beforeEach(() => {
  _resetCuratedModelsCache();
  delete process.env.DEEPSEEK_BYPASS_ENABLED;
  delete process.env.CURATED_MODELS;
});

afterEach(() => {
  _resetCuratedModelsCache();
  if (ORIGINAL_BYPASS === undefined) delete process.env.DEEPSEEK_BYPASS_ENABLED;
  else process.env.DEEPSEEK_BYPASS_ENABLED = ORIGINAL_BYPASS;
  if (ORIGINAL_CURATED === undefined) delete process.env.CURATED_MODELS;
  else process.env.CURATED_MODELS = ORIGINAL_CURATED;
});

describe('getCuratedModels(provider)', () => {
  it('newapi 漏斗与 env 完全解耦 — DEEPSEEK_BYPASS_ENABLED=true 也仍返回 NewAPI 列表', () => {
    process.env.DEEPSEEK_BYPASS_ENABLED = 'true';

    const models = getCuratedModels('newapi');

    expect(models.map((m) => m.id)).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
      'us-kimi-k2.6',
    ]);
    // 用 DEEPSEEK_BYPASS_MODELS 的特征 id 反向断言: 不应被 env override 污染.
    expect(models.some((m) => m.id.startsWith('deepseek-'))).toBe(false);
  });

  it('vision 标志 = release201/26 §13.4a 真实截图强测结果 (newapi 3 模型 true, deepseek 2 模型 false)', () => {
    // 2026-05-30 强测：真实 Apple Music 截图 + 开放式 prompt 两跑，3 个 newapi
    // 模型均说出 Apple Music / 歌手 / 正在播放等图中真实内容 → vision=true。
    // DeepSeek V4 在 wire 层 400 拒收 image part → vision=false。
    // probe: scripts/spike/model-vision-probe-screenshot.ts
    const newapi = getCuratedModels('newapi');
    const deepseek = getCuratedModels('deepseek');
    const visionOf = (models: ReturnType<typeof getCuratedModels>, id: string) =>
      models.find((m) => m.id === id)?.vision;

    expect(visionOf(newapi, 'gemini-3.1-pro-preview')).toBe(true);
    expect(visionOf(newapi, 'gemini-3.1-flash-lite-preview')).toBe(true);
    expect(visionOf(newapi, 'us-kimi-k2.6')).toBe(true);
    expect(visionOf(deepseek, 'deepseek-v4-flash')).toBe(false);
    expect(visionOf(deepseek, 'deepseek-v4-pro')).toBe(false);
  });

  it('newapi 漏斗忽略 CURATED_MODELS env override (该 override 只影响 env-default bucket)', () => {
    process.env.CURATED_MODELS = JSON.stringify([
      { id: 'fake-model', name: 'Fake', provider: 'fake' },
    ]);

    const models = getCuratedModels('newapi');

    expect(models.find((m) => m.id === 'fake-model')).toBeUndefined();
    expect(models.find((m) => m.id === 'us-kimi-k2.6')).toBeDefined();
  });

  it('deepseek 漏斗与 env 完全解耦 — DEEPSEEK_BYPASS_ENABLED 未设也返回 DeepSeek 列表', () => {
    // 默认 env 干净 (beforeEach 已 unset)
    const models = getCuratedModels('deepseek');

    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(models.every((m) => m.provider === 'deepseek')).toBe(true);
  });

  it('deepseek 漏斗忽略 CURATED_MODELS env override', () => {
    process.env.CURATED_MODELS = JSON.stringify([
      { id: 'fake-model', name: 'Fake', provider: 'fake' },
    ]);

    const models = getCuratedModels('deepseek');

    expect(models.find((m) => m.id === 'fake-model')).toBeUndefined();
    expect(models.find((m) => m.id === 'deepseek-v4-flash')).toBeDefined();
  });

  it('undefined provider 回退 env-driven 路径 — DEEPSEEK_BYPASS_ENABLED=true → DeepSeek 列表', () => {
    process.env.DEEPSEEK_BYPASS_ENABLED = 'true';

    const models = getCuratedModels();

    expect(models.find((m) => m.id === 'deepseek-v4-flash')).toBeDefined();
  });

  it('undefined provider + 干净 env → 默认 NewAPI 列表 (backwards-compat for CLI)', () => {
    const models = getCuratedModels();

    expect(models.find((m) => m.id === 'us-kimi-k2.6')).toBeDefined();
    expect(models.find((m) => m.id.startsWith('deepseek-'))).toBeUndefined();
  });

  it('三个 cache bucket 互相隔离 — 切 newapi → deepseek → newapi 始终命中对应漏斗', () => {
    const newapiFirst = getCuratedModels('newapi');
    const deepseek = getCuratedModels('deepseek');
    const newapiSecond = getCuratedModels('newapi');

    expect(newapiFirst).toBe(newapiSecond); // cache 命中: 同引用
    expect(newapiFirst).not.toBe(deepseek); // 不同 bucket: 不同引用
    expect(newapiFirst.find((m) => m.id === 'us-kimi-k2.6')).toBeDefined();
    expect(deepseek.find((m) => m.id === 'deepseek-v4-flash')).toBeDefined();
  });

  it('_resetCuratedModelsCache() 清掉所有 bucket — 不带参数, env 变化可立即生效', () => {
    // 第一次 call → cache env-default bucket 用 default NewAPI
    const beforeEnv = getCuratedModels();
    expect(beforeEnv.find((m) => m.id === 'us-kimi-k2.6')).toBeDefined();

    // 不 reset cache 直接改 env → 看不到变化 (legacy lazy-init 语义)
    process.env.DEEPSEEK_BYPASS_ENABLED = 'true';
    const cached = getCuratedModels();
    expect(cached).toBe(beforeEnv);

    // reset 后再 call → cache 重新建, 看到 env 变化
    _resetCuratedModelsCache();
    const after = getCuratedModels();
    expect(after.find((m) => m.id === 'deepseek-v4-flash')).toBeDefined();
  });
});

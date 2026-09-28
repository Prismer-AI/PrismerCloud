/**
 * @vitest-environment node
 *
 * `custom_providers[].models` 在 configurePrismerProvider 整项替换下的存活契约
 * （2026-09-07 probe-storm fix 的负控评审项）。
 *
 * 背景：ConfigDelivery（daemon config-bootstrap）把 `models.<id>.context_length`
 * 写到 ROOT `~/.hermes/config.yaml` 的 prismer entry 上 —— 这是 Hermes 的
 * step-0 context-length override，杀掉它每轮 ~20 发的 404 端点嗅探。但
 * `configurePrismerProvider` 每次网关拉起都会用**不含 models 的新字面量**整体
 * 替换该 entry（且 applyBundle 在 configVersion 不变时跳过重写 → 被剥掉就再也
 * 不回来）。修复后：本 doc 旧 entry 的 models 被保留；profile doc（`hermes -p
 * <name>` 网关唯一会读的文件，HERMES_HOME 被 profile 覆写、无 root 合并）从
 * root 侧继承（root 先应用）。
 *
 * 负控：修复前本文件第 1、2 条断言红（root 被 strip、profile 无继承）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import {
  configurePrismerProvider,
  getHermesHomeRoot,
  getHermesProfileDir,
  HermesProfileConfigSchema,
} from '../src/adapters/persistence/hermes/index.js';

const PROFILE = 'ctx-len-test';

let home = '';
const savedEnv: Record<string, string | undefined> = {};

function snapEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function baseConfig() {
  return HermesProfileConfigSchema.parse({
    apiKey: 'sk-prismer-test-key',
    prismerProviderBaseUrl: 'https://cloud.test/api/v1/proxy/deepseek',
    installPrismerMcpServer: false,
  });
}

/** Simulate ConfigDelivery's applyBundle write: seed the ROOT config with a
 *  prismer entry carrying the context-length models map. */
function seedRootConfigWithModels(models: Record<string, unknown>): void {
  const rootPath = join(getHermesHomeRoot(), 'config.yaml');
  mkdirSync(getHermesHomeRoot(), { recursive: true });
  const doc = {
    custom_providers: [
      {
        name: 'prismer',
        base_url: 'https://cloud.test/api/v1/proxy/deepseek',
        key_env: 'PRISMER_API_KEY',
        api_mode: 'chat_completions',
        models,
      },
    ],
  };
  writeFileSync(rootPath, YAML.stringify(doc), 'utf8');
}

function readProviderEntry(scope: 'root' | 'profile'): Record<string, unknown> | undefined {
  const path =
    scope === 'root'
      ? join(getHermesHomeRoot(), 'config.yaml')
      : join(getHermesProfileDir(PROFILE), 'config.yaml');
  const doc = YAML.parse(readFileSync(path, 'utf8')) as { custom_providers?: Array<Record<string, unknown>> };
  return doc.custom_providers?.find((e) => e && e.name === 'prismer');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'prismer-ctx-len-'));
  snapEnv('HERMES_HOME', 'PRISMER_API_KEY');
  process.env.HERMES_HOME = home;
  process.env.PRISMER_API_KEY = 'sk-prismer-test-key';
});

afterEach(() => {
  restoreEnv();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('configurePrismerProvider preserves/inherits custom_providers[].models (context_length)', () => {
  it('root entry seeded by ConfigDelivery keeps its models map after the provider rewrite', () => {
    const models = { 'deepseek-v4-flash': { context_length: 1_000_000 } };
    seedRootConfigWithModels(models);
    configurePrismerProvider(PROFILE, baseConfig());
    const entry = readProviderEntry('root');
    expect(entry, 'root prismer entry must exist').toBeDefined();
    expect(entry!.models).toEqual(models);
  });

  it('profile doc (the one the profile-scope gateway reads) INHERITS the root models map', () => {
    const models = { 'deepseek-v4-flash': { context_length: 1_000_000 } };
    seedRootConfigWithModels(models);
    configurePrismerProvider(PROFILE, baseConfig());
    const entry = readProviderEntry('profile');
    expect(entry, 'profile prismer entry must exist').toBeDefined();
    expect(entry!.models, 'profile gateway never reads the root config — it must inherit models').toEqual(models);
  });

  it('NEGATIVE CONTROL: no seeded models anywhere → no fabricated models key', () => {
    configurePrismerProvider(PROFILE, baseConfig());
    expect(readProviderEntry('root')?.models).toBeUndefined();
    expect(readProviderEntry('profile')?.models).toBeUndefined();
  });
});

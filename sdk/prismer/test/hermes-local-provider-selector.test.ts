// hermes × the `local:<profileId>` provider selector.
//
// Why this file exists: a desktop-local provider profile could never be written
// to `AgentProfile.config.proxyProvider` — the cloud validator rejects ids it
// doesn't know, and a profile living in this machine's `config.toml` is one it
// structurally cannot know. The `local:` namespace makes the selector
// self-describing so the cloud accepts it blind; the daemon is the party that
// resolves it, and hermes is the adapter that can serve every local wire.
//
// Oracle = the bytes hermes actually runs on (`<HERMES_HOME>/profiles/<p>/
// config.yaml` `custom_providers[].base_url` + `api_mode`), not a return value.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import {
  configurePrismerProvider,
  getHermesProfileDir,
  HermesProfileConfigSchema,
} from '../src/adapters/persistence/hermes/index.js';
import {
  ProviderProfileSchema,
  setKeyRefResolver,
  setLocalProviders,
} from '../src/adapters/shared/local-provider.js';

const PROFILE = 'local-selector-test';

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

/** NOTE: no `prismerProviderBaseUrl` — that operator pin outranks everything. */
function baseConfig(overrides: Record<string, unknown> = {}) {
  return HermesProfileConfigSchema.parse({
    apiKey: 'sk-prismer-test-key',
    installPrismerMcpServer: false,
    ...overrides,
  });
}

function customProvider(): Record<string, unknown> {
  const path = join(getHermesProfileDir(PROFILE), 'config.yaml');
  const doc = YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const providers = doc.custom_providers as Record<string, unknown>[];
  expect(Array.isArray(providers)).toBe(true);
  return providers[providers.length - 1]!;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'prismer-local-selector-'));
  snapEnv('HERMES_HOME', 'PRISMER_API_KEY', 'PRISMER_BASE_URL', 'PRISMER_MEMORY_PROVIDER', 'PRISMER_RECALL_TOOLS_PLUGIN');
  process.env.HERMES_HOME = home;
  process.env.PRISMER_API_KEY = 'sk-prismer-test-key';
  process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
  delete process.env.PRISMER_MEMORY_PROVIDER;
  delete process.env.PRISMER_RECALL_TOOLS_PLUGIN;
});

afterEach(() => {
  restoreEnv();
  setLocalProviders(null);
  setKeyRefResolver(null);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('hermes provider bootstrap — `local:` selector', () => {
  it('a `local:<id>` selector direct-connects to that profile (not the cloud gateway)', () => {
    setLocalProviders([
      ProviderProfileSchema.parse({
        id: 'qwen',
        type: 'openai-compatible',
        base_url: 'http://192.168.31.54:8000/v1',
        key_ref: 'keychain:qwen',
      }),
    ]);
    setKeyRefResolver(() => 'sk-byok');
    configurePrismerProvider(PROFILE, baseConfig({ proxyProvider: 'local:qwen' }), 'agent-x', 'ws_1');

    const provider = customProvider();
    expect(provider.base_url).toBe('http://192.168.31.54:8000/v1');
    expect(provider.api_mode).toBe('chat_completions');
  });

  it('a `local:<id>` anthropic profile switches the wire to anthropic_messages', () => {
    setLocalProviders([
      ProviderProfileSchema.parse({ id: 'my-claude', type: 'anthropic', key_ref: 'keychain:c' }),
    ]);
    setKeyRefResolver(() => 'sk-ant-byok');
    configurePrismerProvider(PROFILE, baseConfig({ proxyProvider: 'local:my-claude' }), 'agent-x', 'ws_1');

    const provider = customProvider();
    expect(provider.base_url).toBe('https://api.anthropic.com');
    expect(provider.api_mode).toBe('anthropic_messages');
  });

  it('BACKWARD COMPAT: the bare profile id resolves identically', () => {
    setLocalProviders([
      ProviderProfileSchema.parse({
        id: 'qwen',
        type: 'openai-compatible',
        base_url: 'http://192.168.31.54:8000/v1',
        key_ref: 'keychain:qwen',
      }),
    ]);
    setKeyRefResolver(() => 'sk-byok');
    configurePrismerProvider(PROFILE, baseConfig({ proxyProvider: 'qwen' }), 'agent-x', 'ws_1');
    expect(customProvider().base_url).toBe('http://192.168.31.54:8000/v1');
  });

  it('an UNRESOLVED `local:` selector lands on the aggregator, never on a bogus proxy chain', () => {
    // Profile absent on this machine (agent moved between daemons / key not yet
    // provisioned). Walking the selector as a cloud chain would write
    // `/api/v1/proxy/local%3Aqwen` — 404 on every single call.
    setLocalProviders(null);
    configurePrismerProvider(PROFILE, baseConfig({ proxyProvider: 'local:qwen' }), 'agent-x', 'ws_1');

    const provider = customProvider();
    expect(provider.base_url).toBe('https://test.docbrew.cn/api/v1');
    expect(String(provider.base_url)).not.toContain('proxy');
  });

  it('BACKWARD COMPAT: a real cloud chain id still walks `/api/v1/proxy/<chain>`', () => {
    // The guard above must be scoped to the `local:` namespace only — if it ate
    // ordinary chain selectors too, every deepseek agent would silently fall
    // back to the aggregator.
    setLocalProviders(null);
    configurePrismerProvider(PROFILE, baseConfig({ proxyProvider: 'deepseek' }), 'agent-x', 'ws_1');
    expect(customProvider().base_url).toBe('https://test.docbrew.cn/api/v1/proxy/deepseek');
  });
});

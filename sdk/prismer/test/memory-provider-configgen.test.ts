// memory203 doc 10 §3 — config-gen convergence onto the native MemoryProvider.
//
// Proves `configurePrismerProvider` (the single place that writes the Hermes
// profile config.yaml + .env):
//   1. When the provider is enabled → pins `memory.provider: prismer` AND
//      writes PRISMER_DAEMON_PORT + workspace/agent identity into the profile .env.
//   2. With the provider active it does NOT install curl memory hooks, while
//      the standalone plugin is enabled exactly once for bounded terminal
//      routing evidence (overlapping recall tools are deduped by Hermes).
//   3. The no-provider FALLBACK still installs the curl hooks (provider absent).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import {
  configurePrismerProvider,
  getHermesProfileDir,
  HermesProfileConfigSchema,
} from '../src/adapters/persistence/hermes/index.js';

const PROFILE = 'memcfg-test';

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

function baseConfig(overrides: Record<string, unknown> = {}) {
  // Validated through the real schema so defaults (installMemoryHooks: true,
  // installPrismerMcpServer, etc.) are populated exactly as production sees them.
  return HermesProfileConfigSchema.parse({
    apiKey: 'sk-prismer-test-key',
    // Operator base_url override → no PRISMER_BASE_URL env needed, no bail.
    prismerProviderBaseUrl: 'http://127.0.0.1:9999/api/v1',
    // Keep the test hermetic: don't try to resolve @prismer/mcp-server on disk.
    installPrismerMcpServer: false,
    ...overrides,
  });
}

function readConfigYaml(profile: string): Record<string, unknown> {
  const path = join(getHermesProfileDir(profile), 'config.yaml');
  return YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readEnv(profile: string): string {
  const path = join(getHermesProfileDir(profile), '.env');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'prismer-memcfg-home-'));
  snapEnv(
    'HERMES_HOME',
    'PRISMER_MEMORY_PROVIDER',
    'PRISMER_RECALL_TOOLS_PLUGIN',
    'PRISMER_DAEMON_PORT',
    'PRISMER_MEMORY_PROVIDER_SHELL',
    'PRISMER_API_KEY',
  );
  process.env.HERMES_HOME = home;
  // resolvePrismerApiKey reads PRISMER_API_KEY env (not config.apiKey) for the
  // provider bootstrap — set it so configurePrismerProvider doesn't bail.
  process.env.PRISMER_API_KEY = 'sk-prismer-test-key';
  delete process.env.PRISMER_MEMORY_PROVIDER;
  delete process.env.PRISMER_RECALL_TOOLS_PLUGIN;
});

afterEach(() => {
  restoreEnv();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('config-gen: native MemoryProvider convergence (doc 10 §3)', () => {
  it('provider ON pins memory.provider: prismer + writes the real daemon port to .env', () => {
    process.env.PRISMER_DAEMON_PORT = '7878';
    configurePrismerProvider(PROFILE, baseConfig({ installMemoryProvider: true }), 'agent-x', 'ws_1', 'im_agent_1');

    const yaml = readConfigYaml(PROFILE);
    const memory = yaml.memory as Record<string, unknown>;
    expect(memory.provider).toBe('prismer');

    const env = readEnv(PROFILE);
    expect(env).toContain('PRISMER_DAEMON_PORT="7878"');
    expect(env).toContain('PRISMER_WORKSPACE_ID="ws_1"');
    expect(env).toContain('PRISMER_AGENT_USERNAME="agent-x"');
    expect(env).toContain('PRISMER_AGENT_IM_USER_ID="im_agent_1"');

    // The provider shell was actually copied into the profile plugins dir at
    // the path Hermes's memory-provider scanner discovers: `plugins/<name>/`
    // (NOT the nested `plugins/memory/<name>/`, which is only for bundled
    // providers and is never discovered for user installs — verified live).
    expect(
      existsSync(join(getHermesProfileDir(PROFILE), 'plugins', 'prismer', '__init__.py')),
    ).toBe(true);
  });

  it('provider ON falls back to 7878 (not the stale 3210) when PRISMER_DAEMON_PORT is unset', () => {
    delete process.env.PRISMER_DAEMON_PORT;
    configurePrismerProvider(PROFILE, baseConfig({ installMemoryProvider: true }), 'agent-x', 'ws_1', 'im_agent_1');
    const env = readEnv(PROFILE);
    expect(env).toContain('PRISMER_DAEMON_PORT="7878"');
    expect(env).not.toContain('PRISMER_DAEMON_PORT="3210"');
  });

  it('provider ON does NOT install the curl memory hooks (provider supersedes the fallback)', () => {
    configurePrismerProvider(PROFILE, baseConfig({ installMemoryProvider: true }), 'agent-x', 'ws_1', 'im_agent_1');
    const yaml = readConfigYaml(PROFILE);
    // hooks block either absent or carries no prismer-daemon-hook curl command.
    const hooks = yaml.hooks ? JSON.stringify(yaml.hooks) : '';
    expect(hooks).not.toContain('prismer-daemon-hook');
    expect(hooks).not.toContain('/v1/hooks/');
  });

  it('provider ON enables exactly one bounded routing plugin entry even if its flag is also set', () => {
    process.env.PRISMER_RECALL_TOOLS_PLUGIN = '1';
    configurePrismerProvider(
      PROFILE,
      baseConfig({ installMemoryProvider: true, installRecallToolsPlugin: true }),
      'agent-x',
      'ws_1',
      'im_agent_1',
    );
    const yaml = readConfigYaml(PROFILE);
    const enabled = (yaml.plugins as { enabled?: unknown })?.enabled;
    const enabledList = Array.isArray(enabled) ? (enabled as string[]) : [];
    expect(enabledList.filter((e) => e.includes('recall'))).toEqual(['tools/prismer-recall']);
    expect(
      existsSync(
        join(
          getHermesProfileDir(PROFILE),
          'plugins',
          'tools',
          'prismer-recall',
          '__init__.py',
        ),
      ),
    ).toBe(true);
  });

  it('no-provider FALLBACK still installs the curl memory hooks (degrade path intact)', () => {
    // Provider OFF (default) — the legacy shell-hook path must still wire up.
    configurePrismerProvider(PROFILE, baseConfig(), 'agent-x', 'ws_1');
    const yaml = readConfigYaml(PROFILE);
    expect(yaml.memory && (yaml.memory as Record<string, unknown>).provider).toBeUndefined();
    const hooks = JSON.stringify(yaml.hooks ?? {});
    expect(hooks).toContain('prismer-daemon-hook');
    expect(hooks).toContain('/v1/hooks/pre_llm_call');
  });

  it('no-provider fallback hook URL uses 7878 default when env unset', () => {
    delete process.env.PRISMER_DAEMON_PORT;
    configurePrismerProvider(PROFILE, baseConfig(), 'agent-x', 'ws_1');
    const yaml = readConfigYaml(PROFILE);
    const hooks = JSON.stringify(yaml.hooks ?? {});
    expect(hooks).toContain('127.0.0.1:7878');
    expect(hooks).not.toContain('127.0.0.1:3210');
  });
});

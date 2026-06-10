// OpenClaw adapter — release202/03 §3.2: gateway provider writer (tiered model).
// Pure-function tests — no spawn, no network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  resolveOpenClawPrismerProvider,
  writeOpenClawPrismerProvider,
  OpenClawProfileConfigSchema,
} from '../src/adapters/openclaw/index.js';

const cfg = (over: Record<string, unknown> = {}) =>
  OpenClawProfileConfigSchema.parse({ apiKey: 'gw-bearer', ...over });

describe('resolveOpenClawPrismerProvider', () => {
  const saved = { ...process.env };
  beforeEach(() => delete process.env.PRISMER_BASE_URL);
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null without proxyProvider/prismerModel', () => {
    process.env.PRISMER_BASE_URL = 'https://cloud.prismer.dev';
    expect(resolveOpenClawPrismerProvider(cfg())).toBeNull();
    expect(resolveOpenClawPrismerProvider(cfg({ proxyProvider: 'newapi' }))).toBeNull();
  });

  it('resolves base (+/api/v1) + model + key-env when fully set', () => {
    process.env.PRISMER_BASE_URL = 'https://cloud.prismer.dev/';
    const p = resolveOpenClawPrismerProvider(
      cfg({ proxyProvider: 'newapi', prismerModel: 'us-kimi-k2.6' }),
    );
    expect(p).toEqual({
      baseUrl: 'https://cloud.prismer.dev/api/v1',
      apiKeyEnv: 'PRISMER_API_KEY',
      model: 'us-kimi-k2.6',
    });
  });
});

describe('writeOpenClawPrismerProvider', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    path = join(dir, 'openclaw.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const provider = { baseUrl: 'http://localhost:3000/api/v1', apiKeyEnv: 'PRISMER_API_KEY', model: 'us-kimi-k2.6' };

  it('writes the prismer provider with ${ENV} apiKey + openai-completions + primary', () => {
    writeOpenClawPrismerProvider(path, provider);
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const p = j.models.providers.prismer;
    expect(p.baseUrl).toBe('http://localhost:3000/api/v1');
    expect(p.apiKey).toBe('${PRISMER_API_KEY}'); // interpolation form, not bare name
    expect(p.auth).toBe('api-key');
    expect(p.api).toBe('openai-completions');
    expect(p.models).toEqual([{ id: 'us-kimi-k2.6', name: 'us-kimi-k2.6' }]);
    expect(j.agents.defaults.model.primary).toBe('prismer/us-kimi-k2.6');
    expect(j.models.mode).toBe('merge');
  });

  it('preserves existing config (merge, not overwrite)', () => {
    writeFileSync(
      path,
      JSON.stringify({
        channels: { telegram: { token: 't' } },
        models: { providers: { other: { baseUrl: 'x' } } },
        agents: { defaults: { workspace: '/w', model: { fallbacks: ['a'] } } },
      }),
    );
    writeOpenClawPrismerProvider(path, provider);
    const j = JSON.parse(readFileSync(path, 'utf8'));
    expect(j.channels.telegram.token).toBe('t'); // untouched
    expect(j.models.providers.other.baseUrl).toBe('x'); // other provider kept
    expect(j.models.providers.prismer).toBeDefined(); // ours added
    expect(j.agents.defaults.workspace).toBe('/w'); // untouched
    expect(j.agents.defaults.model.primary).toBe('prismer/us-kimi-k2.6'); // set
    expect(j.agents.defaults.model.fallbacks).toEqual(['a']); // kept
  });

  it('tolerates JSON5 comments in the existing file', () => {
    writeFileSync(path, '{\n  // a comment\n  "channels": {} /* inline */\n}\n');
    writeOpenClawPrismerProvider(path, provider);
    const j = JSON.parse(readFileSync(path, 'utf8'));
    expect(j.channels).toEqual({});
    expect(j.models.providers.prismer).toBeDefined();
  });
});

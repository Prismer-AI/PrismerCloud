// Codex adapter — release202/03 §3.2: gateway routing + v0.133 JSONL parsing.
// Pure-function tests — no spawn, no network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  parseCodexOutput,
  resolveCodexPrismerProvider,
  writeCodexPrismerHome,
  buildCodexNoProxy,
  CodexConfigSchema,
} from '../src/adapters/codex/index.js';

const cfg = (over: Record<string, unknown> = {}) =>
  CodexConfigSchema.parse({ cwd: '/tmp', model: 'us-kimi-k2.6', ...over });

describe('parseCodexOutput — codex v0.133 JSONL schema', () => {
  it('extracts the agent_message from item.completed (real schema)', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"marker.txt\\n","exit_code":0}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"There is one file: marker.txt."}}',
      '{"type":"turn.completed","usage":{"input_tokens":10}}',
    ].join('\n');
    expect(parseCodexOutput(jsonl)).toBe('There is one file: marker.txt.');
  });

  it('falls back to the legacy flat {type:message} shape', () => {
    expect(parseCodexOutput('{"type":"message","content":"hi"}')).toBe('hi');
  });

  it('falls back to raw stdout when no known line matches', () => {
    expect(parseCodexOutput('plain text output')).toBe('plain text output');
  });
});

describe('resolveCodexPrismerProvider', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.PRISMER_BASE_URL;
    delete process.env.PRISMER_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null when proxyProvider is unset (legacy OpenAI path)', () => {
    process.env.PRISMER_BASE_URL = 'https://cloud.prismer.dev';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveCodexPrismerProvider(cfg())).toBeNull();
  });

  it('resolves base (+/api/v1) + key from env when proxyProvider set', () => {
    process.env.PRISMER_BASE_URL = 'https://cloud.prismer.dev/';
    process.env.PRISMER_API_KEY = 'sk-prismer-abc';
    const p = resolveCodexPrismerProvider(cfg({ proxyProvider: 'newapi' }));
    expect(p).toEqual({ baseUrl: 'https://cloud.prismer.dev/api/v1', apiKey: 'sk-prismer-abc' });
  });

  it('returns null (and warns) when base/key missing despite proxyProvider', () => {
    expect(resolveCodexPrismerProvider(cfg({ proxyProvider: 'newapi' }))).toBeNull();
  });
});

describe('writeCodexPrismerHome', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a config.toml with responses wire + prismer provider + bearer', () => {
    writeCodexPrismerHome(dir, 'us-kimi-k2.6', {
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'sk-prismer-xyz',
    });
    const toml = readFileSync(join(dir, 'config.toml'), 'utf8');
    expect(toml).toContain('model = "us-kimi-k2.6"');
    expect(toml).toContain('model_provider = "prismer"');
    expect(toml).toContain('model_reasoning_effort = "none"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('base_url = "http://localhost:3000/api/v1"');
    expect(toml).toContain('experimental_bearer_token = "sk-prismer-xyz"');
  });
});

describe('buildCodexNoProxy', () => {
  it('always bypasses localhost/127.0.0.1 and adds the gateway host', () => {
    expect(buildCodexNoProxy('https://cloud.prismer.dev/api/v1')).toBe(
      'localhost,127.0.0.1,cloud.prismer.dev',
    );
  });
  it('dedupes when the gateway host is already localhost', () => {
    expect(buildCodexNoProxy('http://localhost:3000/api/v1')).toBe('localhost,127.0.0.1');
  });
});

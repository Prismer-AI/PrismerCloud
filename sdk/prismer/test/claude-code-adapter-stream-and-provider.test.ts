// release203/06 §3.0 + §3.1a — Claude Code adapter:
//   P0 stream-json → recorder frames (claudeStreamJsonToSteps)
//   P1 provider override (resolveClaudeCodePrismerProvider) + G4 env contract
// Pure-function tests — no spawn, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeStreamJsonToSteps,
  resolveClaudeCodePrismerProvider,
  type ClaudeCodeConfig,
} from '../src/adapters/coding/claude-code/index.js';
import { ADAPTER_KNOWN_VERSIONS } from '../src/adapters/known-versions.js';
import {
  ProviderProfileSchema,
  setKeyRefResolver,
  setLocalProviders,
} from '../src/adapters/shared/local-provider.js';
import { buildProviderProxyInjection } from '../src/adapters/coding/shared/provider-proxy-env.js';

const cfg = (over: Record<string, unknown> = {}): ClaudeCodeConfig =>
  ({
    cwd: '/tmp',
    model: 'sonnet',
    maxTurns: 20,
    route: 'default',
    prismerApiKeyEnv: 'PRISMER_API_KEY',
    ...over,
  }) as ClaudeCodeConfig;

describe('claudeStreamJsonToSteps — claude CLI 2.x stream-json → recorder frames', () => {
  it('maps assistant thinking block → reasoning_chunk', () => {
    const line =
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me reason."}]}}';
    expect(claudeStreamJsonToSteps(line)).toEqual([
      { kind: 'reasoning_chunk', text: 'Let me reason.' },
    ]);
  });

  it('maps assistant tool_use block → tool_call (toolCallId = block.id)', () => {
    const line =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo hi"}}]}}';
    expect(claudeStreamJsonToSteps(line)).toEqual([
      { kind: 'tool_call', toolName: 'Bash', input: { command: 'echo hi' }, toolCallId: 'toolu_1' },
    ]);
  });

  it('maps user tool_result block → tool_result (paired by tool_use_id)', () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"hi","is_error":false}]}}';
    expect(claudeStreamJsonToSteps(line)).toEqual([
      { kind: 'tool_result', toolCallId: 'toolu_1', output: { content: 'hi', isError: false } },
    ]);
  });

  it('maps assistant text block → reply', () => {
    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"All done."}]}}';
    expect(claudeStreamJsonToSteps(line)).toEqual([{ kind: 'reply', text: 'All done.' }]);
  });

  it('maps the final result line → result (authoritative reply)', () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"result":"Hello!"}';
    expect(claudeStreamJsonToSteps(line)).toEqual([{ kind: 'result', text: 'Hello!' }]);
  });

  it('handles multiple content blocks in one assistant message', () => {
    const line =
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"t"},{"type":"tool_use","id":"x","name":"Read","input":{}}]}}';
    expect(claudeStreamJsonToSteps(line)).toEqual([
      { kind: 'reasoning_chunk', text: 't' },
      { kind: 'tool_call', toolName: 'Read', input: {}, toolCallId: 'x' },
    ]);
  });

  it('ignores system/init, rate_limit and non-json lines', () => {
    expect(claudeStreamJsonToSteps('{"type":"system","subtype":"init"}')).toEqual([]);
    expect(claudeStreamJsonToSteps('{"type":"rate_limit_event"}')).toEqual([]);
    expect(claudeStreamJsonToSteps('not json')).toEqual([]);
    expect(claudeStreamJsonToSteps('')).toEqual([]);
  });

  it('end-to-end: a stream-json transcript yields ordered frames', () => {
    const lines = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"think"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hi"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"hi","is_error":false}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","result":"done"}',
    ];
    const kinds = lines.flatMap(claudeStreamJsonToSteps).map((s) => s.kind);
    expect(kinds).toEqual([
      'reasoning_chunk',
      'tool_call',
      'tool_result',
      'reply',
      'result',
    ]);
  });
});

describe('resolveClaudeCodePrismerProvider — gateway routing (G4 fix + proxyProvider)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.PRISMER_BASE_URL;
    delete process.env.PRISMER_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null when neither route:prismer nor proxyProvider is set', () => {
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveClaudeCodePrismerProvider(cfg())).toBeNull();
  });

  it('resolves base (+/api, client appends /v1/messages) + sk-prismer key when route:prismer', () => {
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn/';
    process.env.PRISMER_API_KEY = 'sk-prismer-abc';
    // ANTHROPIC_BASE_URL must end at /api — the Anthropic client appends
    // /v1/messages → /api/v1/messages (release203/06 §7, in-pod verified).
    expect(resolveClaudeCodePrismerProvider(cfg({ route: 'prismer' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api',
      apiKey: 'sk-prismer-abc',
      authMode: 'auth-token',
    });
  });

  it('CC uses /api for all chains (Anthropic wire routes by model field, no /v1/proxy path)', () => {
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-abc';
    expect(resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'deepseek' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api',
      apiKey: 'sk-prismer-abc',
      authMode: 'auth-token',
    });
  });

  it('reads the key from a custom prismerApiKeyEnv', () => {
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.WS_KEY = 'sk-prismer-ws';
    expect(
      resolveClaudeCodePrismerProvider(cfg({ route: 'prismer', prismerApiKeyEnv: 'WS_KEY' })),
    ).toEqual({
      baseUrl: 'https://test.docbrew.cn/api',
      apiKey: 'sk-prismer-ws',
      authMode: 'auth-token',
    });
  });

  it('returns null (degrades to official Anthropic) when env missing', () => {
    expect(resolveClaudeCodePrismerProvider(cfg({ route: 'prismer' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// desktop202/12 §2 + doc 21 §2.5 — daemon-local provider (BYOK) direct-connect
// ---------------------------------------------------------------------------
describe('resolveClaudeCodePrismerProvider — local provider (BYOK) middle layer', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.PRISMER_BASE_URL;
    delete process.env.PRISMER_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
    setLocalProviders(null);
    setKeyRefResolver(null);
    vi.restoreAllMocks();
  });

  it('BACKWARD COMPAT: no local profiles → cloud-chain path byte-identical', () => {
    setLocalProviders(null);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'my-anthropic' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api',
      apiKey: 'sk-prismer-x',
      authMode: 'auth-token',
    });
  });

  it('anthropic BYOK profile → direct-connect base_url + x-api-key auth (NOT the Bearer)', () => {
    setKeyRefResolver(() => 'sk-ant-byok');
    setLocalProviders([
      ProviderProfileSchema.parse({
        id: 'my-anthropic',
        type: 'anthropic',
        key_ref: 'keychain:a',
      }),
    ]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    // Anthropic serves the Messages API at base_url verbatim (client appends
    // /v1/messages) and validates a BYOK key via x-api-key → authMode='api-key'.
    expect(resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'my-anthropic' }))).toEqual({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-byok',
      authMode: 'api-key',
      local: true,
    });
  });

  it('honors an explicit base_url on the anthropic profile (self-hosted Anthropic-wire endpoint)', () => {
    setKeyRefResolver(() => 'sk-ant-byok');
    setLocalProviders([
      ProviderProfileSchema.parse({
        id: 'ant-proxy',
        type: 'anthropic',
        base_url: 'https://anthropic.internal.example.com/',
        key_ref: 'keychain:a',
      }),
    ]);
    const r = resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'ant-proxy' }));
    expect(r?.baseUrl).toBe('https://anthropic.internal.example.com');
    expect(r?.authMode).toBe('api-key');
  });

  it.each(['openai', 'deepseek', 'openai-compatible'] as const)(
    'DECLINES a non-Anthropic-wire local type (%s) → warns + falls back to the cloud chain',
    (type) => {
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      setKeyRefResolver(() => 'sk-byok');
      setLocalProviders([
        ProviderProfileSchema.parse({
          id: 'local-x',
          type,
          key_ref: 'keychain:x',
          ...(type === 'openai-compatible' ? { base_url: 'http://127.0.0.1:8000/v1' } : {}),
        }),
      ]);
      process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
      process.env.PRISMER_API_KEY = 'sk-prismer-x';
      // Silent degradation is the bug we're fixing: the user MUST see why their
      // BYOK selection didn't take effect (stderr), and the run must still work
      // via the gateway (which does the Anthropic↔chat translation).
      expect(resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'local-x' }))).toEqual({
        baseUrl: 'https://test.docbrew.cn/api',
        apiKey: 'sk-prismer-x',
        authMode: 'auth-token',
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('not claude-code-compatible'))).toBe(
        true,
      );
    },
  );

  it('DECLINES a keyless ollama local profile → warns + falls back to the cloud chain', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    setLocalProviders([ProviderProfileSchema.parse({ id: 'local-ollama', type: 'ollama' })]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'local-ollama' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api',
      apiKey: 'sk-prismer-x',
      authMode: 'auth-token',
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('not claude-code-compatible'))).toBe(
      true,
    );
  });

  it('anthropic profile with an unresolvable key → falls back to the cloud chain (never keyless)', () => {
    setLocalProviders([
      ProviderProfileSchema.parse({
        id: 'my-anthropic',
        type: 'anthropic',
        key_ref: 'keychain:absent',
      }),
    ]);
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
    expect(resolveClaudeCodePrismerProvider(cfg({ proxyProvider: 'my-anthropic' }))).toEqual({
      baseUrl: 'https://test.docbrew.cn/api',
      apiKey: 'sk-prismer-x',
      authMode: 'auth-token',
    });
  });
});

// The CLI adapter above is the D21 fallback path; the LIVE path is the Paseo
// code-agent driver, which injects env via buildProviderProxyInjection. Both
// consume the same resolver, so pin the local-BYOK env contract on the live one.
describe('buildProviderProxyInjection(claude) — local BYOK env contract', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PRISMER_BASE_URL = 'https://test.docbrew.cn';
    process.env.PRISMER_API_KEY = 'sk-prismer-x';
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    setLocalProviders(null);
    setKeyRefResolver(null);
    vi.restoreAllMocks();
  });

  const META = { prismerWorkspaceId: 'ws-1', prismerTaskId: 'task-1' };

  it('anthropic BYOK profile → ANTHROPIC_API_KEY (x-api-key), never the gateway Bearer', () => {
    setKeyRefResolver(() => 'sk-ant-byok');
    setLocalProviders([
      ProviderProfileSchema.parse({ id: 'my-anthropic', type: 'anthropic', key_ref: 'keychain:a' }),
    ]);
    const inj = buildProviderProxyInjection(
      'claude',
      { route: 'prismer', proxyProvider: 'my-anthropic' },
      META,
    );
    expect(inj).not.toBeNull();
    expect(inj!.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(inj!.env.ANTHROPIC_API_KEY).toBe('sk-ant-byok');
    // A real sk-ant-* key sent as `Authorization: Bearer` is rejected by
    // api.anthropic.com — the gateway Bearer var must NOT be set here.
    expect(inj!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('ollama profile → declines, injects the cloud gateway (Bearer) instead', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    setLocalProviders([ProviderProfileSchema.parse({ id: 'local-ollama', type: 'ollama' })]);
    const inj = buildProviderProxyInjection(
      'claude',
      { route: 'prismer', proxyProvider: 'local-ollama' },
      META,
    );
    expect(inj!.env.ANTHROPIC_BASE_URL).toBe('https://test.docbrew.cn/api');
    expect(inj!.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-prismer-x');
    expect(inj!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('known-config-keys — G4 regression guard', () => {
  it('pins CC env/auth keys to the CLI-read names (not the legacy ones)', () => {
    const cc = ADAPTER_KNOWN_VERSIONS['claude-code']!;
    // The G4 bug was writing ANTHROPIC_API_BASE; the CLI reads ANTHROPIC_BASE_URL.
    expect(cc.envKey).toBe('ANTHROPIC_BASE_URL');
    // CC 2.x uses ANTHROPIC_AUTH_TOKEN for the Bearer (distinct from API_KEY).
    expect(cc.authKey).toBe('ANTHROPIC_AUTH_TOKEN');
  });
});

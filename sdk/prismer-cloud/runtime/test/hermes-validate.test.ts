import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as YAML from 'yaml';
import {
  formatHermesGoalText,
  hermesAdapter,
  normalizeGoalStatus,
  parsePrismerGoals,
  writeHermesGoalState,
} from '../src/adapters/hermes/index.js';

/**
 * url-aware fetch mock for the evolved hermes sessions dispatch flow:
 *   /health/detailed → must satisfy checkHealth (status:'ok' +
 *     platforms.api_server.state:'connected'),
 *   /v1/capabilities → advertise session_chat_streaming so the sessions path
 *     is taken (and skills_api NOT advertised → verifyHermesSkillLoaded skips),
 *   everything else (/api/sessions create + chat/stream) → 503 so the dispatch
 *     stops with ok:false (the original 2-response mock predated this flow).
 * Pass `onDispatch` to override the non-health/capabilities response (e.g. an
 * SSE stream for the chat/stream assertion tests).
 */
function hermesSessionsFetchMock(onDispatch?: (url: string) => unknown) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/health/detailed')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', gateway_state: 'running', platforms: { api_server: { state: 'connected' } } }),
      } as unknown as Response;
    }
    if (u.includes('/v1/capabilities')) {
      return { ok: true, status: 200, json: async () => ({ features: { session_chat_streaming: true } }) } as unknown as Response;
    }
    if (onDispatch) return onDispatch(u) as Response;
    return { ok: false, status: 503, text: async () => 'test stop' } as unknown as Response;
  });
}

describe('hermesAdapter.validate', () => {
  it('accepts minimal valid config', () => {
    const r = hermesAdapter.validate({ apiKey: 'sk-hermes-x' });
    expect(r.ok).toBe(true);
  });

  it('accepts full config', () => {
    const r = hermesAdapter.validate({
      hermesProfileName: 'work',
      port: 9000,
      apiKey: 'sk-hermes-x',
      autoStart: true,
      startupTimeoutMs: 60_000,
      configurePrismerProvider: true,
      model: 'us-kimi-k2.5',
      prismerProviderName: 'prismer',
      prismerProviderBaseUrl: 'http://127.0.0.1:3000/api/v1',
      prismerApiKeyEnv: 'PRISMER_API_KEY',
      mirrorNativeKanban: true,
      mirrorNativeGoals: true,
      nativeMirrorTimeoutMs: 1500,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects missing apiKey', () => {
    const r = hermesAdapter.validate({});
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes('apiKey'))).toBe(true);
  });

  it('rejects empty apiKey string', () => {
    const r = hermesAdapter.validate({ apiKey: '' });
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes('apiKey'))).toBe(true);
  });

  it('rejects out-of-range port', () => {
    const r = hermesAdapter.validate({ apiKey: 'k', port: 99_999 });
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes('port'))).toBe(true);
  });

  it('rejects non-integer port', () => {
    const r = hermesAdapter.validate({ apiKey: 'k', port: 8642.5 });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid provider URL', () => {
    const r = hermesAdapter.validate({
      apiKey: 'k',
      prismerProviderBaseUrl: 'not-a-url',
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.join('\n')).toContain('prismerProviderBaseUrl');
  });

  it('rejects invalid env key and empty provider fields', () => {
    const r = hermesAdapter.validate({
      apiKey: 'k',
      model: '',
      prismerProviderName: '',
      prismerApiKeyEnv: '1_BAD',
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.join('\n')).toContain('model');
    expect(r.errors?.join('\n')).toContain('prismerProviderName');
    expect(r.errors?.join('\n')).toContain('prismerApiKeyEnv');
  });

  it('rejects invalid native mirror timeout', () => {
    const r = hermesAdapter.validate({ apiKey: 'k', nativeMirrorTimeoutMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors?.join('\n')).toContain('nativeMirrorTimeoutMs');
  });
});

describe('hermesAdapter metadata', () => {
  it('exposes correct name + kind + capabilities', () => {
    expect(hermesAdapter.name).toBe('hermes');
    expect(hermesAdapter.kind).toBe('long-running');
    expect(hermesAdapter.capabilities).toContain('shell');
    expect(hermesAdapter.capabilities).toContain('code');
  });

  it('prepares profile MCP config during daemon sync without starting Hermes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-preflight-'));
    const oldHermesHome = process.env.HERMES_HOME;
    const oldBaseUrl = process.env.PRISMER_BASE_URL;
    const oldApiKey = process.env.PRISMER_API_KEY;
    process.env.HERMES_HOME = join(home, 'hermes');
    process.env.PRISMER_BASE_URL = 'http://127.0.0.1:3000';
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    try {
      await hermesAdapter.prepareProfile?.({
        id: 'profile-ceo',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-ceo',
        agentUsername: 'ceo',
        adapterName: 'hermes',
        name: 'default',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'ceo',
          prismerMcpServerPath: '/tmp/prismer-mcp-server.js',
          mcpAllowlist: ['prismer.task.create', 'prismer.task.approve'],
        },
      });

      const raw = readFileSync(join(process.env.HERMES_HOME, 'profiles', 'ceo', 'config.yaml'), 'utf8');
      expect(raw).toContain('mcp_servers:');
      expect(raw).toContain('prismer-tasks:');
      expect(raw).toContain('PRISMER_AGENT_USERNAME: ceo');
      expect(raw).toContain('PRISMER_WORKSPACE_ID: ws-1');
      expect(raw).toContain('PRISMER_MCP_ALLOWLIST: prismer.task.create,prismer.task.approve');
    } finally {
      if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = oldHermesHome;
      if (oldBaseUrl === undefined) delete process.env.PRISMER_BASE_URL;
      else process.env.PRISMER_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.PRISMER_API_KEY;
      else process.env.PRISMER_API_KEY = oldApiKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preinstalled collaboration skill documents bounded asset tools', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-skill-'));
    const oldHermesHome = process.env.HERMES_HOME;
    const oldBaseUrl = process.env.PRISMER_BASE_URL;
    const oldApiKey = process.env.PRISMER_API_KEY;
    process.env.HERMES_HOME = join(home, 'hermes');
    process.env.PRISMER_BASE_URL = 'http://127.0.0.1:3000';
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    vi.stubGlobal('fetch', hermesSessionsFetchMock());
    try {
      await hermesAdapter.prepareProfile?.({
        id: 'profile-researcher',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-researcher',
        agentUsername: 'researcher',
        adapterName: 'hermes',
        name: 'default',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'researcher',
          prismerMcpServerPath: '/tmp/prismer-mcp-server.js',
        },
      });

      const service = await hermesAdapter.ensureService?.({
        id: 'profile-researcher',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-researcher',
        agentUsername: 'researcher',
        adapterName: 'hermes',
        name: 'default',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'researcher',
          autoStart: false,
          prismerMcpServerPath: '/tmp/prismer-mcp-server.js',
        },
      });
      const result = await service?.dispatch({
        taskId: 'task-1',
        prompt: 'Please inspect the uploaded report.',
      });
      expect(result?.ok).toBe(false);

      const skillPath = join(process.env.HERMES_HOME, 'profiles', 'researcher', 'skills', 'prismer-im-collab', 'SKILL.md');
      const skill = readFileSync(skillPath, 'utf8');
      expect(skill).toContain('prismer.asset.search');
      expect(skill).toContain('prismer.asset.describe');
      expect(skill).toContain('prismer.asset.read');
      expect(skill).toContain('read only the needed range');
    } finally {
      if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = oldHermesHome;
      if (oldBaseUrl === undefined) delete process.env.PRISMER_BASE_URL;
      else process.env.PRISMER_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.PRISMER_API_KEY;
      else process.env.PRISMER_API_KEY = oldApiKey;
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('injects installed SKILL.md content into sessions chat/stream system_message (release201/25 §16.4 A3)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-installed-skill-'));
    const oldHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(home, 'hermes');
    const skillDir = join(process.env.HERMES_HOME, 'profiles', 'researcher', 'skills', 'research-style');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Research Style\n\nAlways cite the primary source.', 'utf8');
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      // checkHealth now hits /health/detailed and parses json (status:'ok' +
      // platforms.api_server.state:'connected') — the old `/health` + bare
      // {ok:true} no longer satisfies it.
      if (url.includes('/health/detailed')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', gateway_state: 'running', platforms: { api_server: { state: 'connected' } } }),
        } as Response;
      }
      if (url.endsWith('/v1/capabilities')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ features: { session_chat_streaming: true } }),
        } as Response;
      }
      requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      // Stop short of returning a streaming SSE — the test only inspects
      // the request body sent on the sessions chat/stream endpoint.
      return { ok: false, status: 503, text: async () => 'stop before SSE' } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper({
      get: () => ({
        conversationId: 'conv-1',
        agentImUserId: 'agent-researcher',
        hermesSessionId: 'sess-conv-1',
        hermesSessionKey: null,
      }),
      createForConversation: async () => ({
        conversationId: 'conv-1',
        agentImUserId: 'agent-researcher',
        hermesSessionId: 'sess-conv-1',
        hermesSessionKey: null,
      }),
    } as never);
    try {
      const service = await hermesAdapter.ensureService?.({
        id: 'profile-researcher',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-researcher',
        agentUsername: 'researcher',
        adapterName: 'hermes',
        name: 'default',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'researcher',
          autoStart: false,
          prismerMcpServerPath: '/tmp/prismer-mcp-server.js',
        },
      });

      const result = await service?.dispatch({
        taskId: 'task-1',
        prompt: 'Summarize this.',
        metadata: {
          systemPrompt: 'You are a researcher.',
          conversationId: 'conv-1',
          agentImUserId: 'agent-researcher',
          workspaceId: 'ws-1',
        },
      });

      expect(result?.ok).toBe(false);
      const chatStreamReq = requests.find((req) => req.url.endsWith('/chat/stream'));
      expect(chatStreamReq).toBeDefined();
      const sessionsBody = chatStreamReq!.body as { system_message?: string };
      expect(sessionsBody.system_message).toContain('You are a researcher.');
      expect(sessionsBody.system_message).toContain('[Installed Skills]');
      expect(sessionsBody.system_message).toContain('# Research Style');
      expect(sessionsBody.system_message).toContain('Always cite the primary source.');
    } finally {
      if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = oldHermesHome;
      vi.unstubAllGlobals();
      setHermesSessionMapper(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports throttled progress while consuming sessions assistant.delta SSE (release201/25 §16.4 A3)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-sse-progress-'));
    const oldHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(home, 'hermes');
    const encoder = new TextEncoder();
    const progress: Array<{
      progress: number;
      message?: string;
      detail?: Record<string, unknown>;
    }> = [];
    const heartbeat = { setPhase: vi.fn(), touchStep: vi.fn() };
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
      const url = typeof rawUrl === 'string' ? rawUrl : rawUrl.toString();
      if (url.includes('/health/detailed')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', gateway_state: 'running', platforms: { api_server: { state: 'connected' } } }),
        } as Response;
      }
      if (url.endsWith('/v1/capabilities')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ features: { session_chat_streaming: true } }),
        } as Response;
      }
      if (url.includes('/api/sessions/') && url.endsWith('/chat/stream')) {
        const sse = [
          'event: run.started\ndata: {"run_id":"run-1"}\n\n',
          'event: assistant.delta\ndata: {"delta":"hello"}\n\n',
          'event: assistant.delta\ndata: {"delta":" world"}\n\n',
          'event: run.completed\ndata: {"usage":{}}\n\n',
        ].join('');
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse));
              controller.close();
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.stubGlobal('fetch', fetchMock);
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper({
      get: () => ({
        conversationId: 'conv-stream',
        agentImUserId: 'agent-streamer',
        hermesSessionId: 'sess-stream',
        hermesSessionKey: null,
      }),
      createForConversation: async () => ({
        conversationId: 'conv-stream',
        agentImUserId: 'agent-streamer',
        hermesSessionId: 'sess-stream',
        hermesSessionKey: null,
      }),
    } as never);
    try {
      const service = await hermesAdapter.ensureService?.({
        id: 'profile-streamer',
        workspaceId: 'ws-1',
        agentImUserId: 'agent-streamer',
        agentUsername: 'streamer',
        adapterName: 'hermes',
        name: 'default',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'hermes-api-key',
          hermesProfileName: 'streamer',
          autoStart: false,
          configurePrismerProvider: false,
        },
      });

      const result = await service?.dispatch({
        taskId: 'task-stream',
        prompt: 'Write a long answer.',
        onProgress: (p) => progress.push(p),
        heartbeat,
        metadata: {
          conversationId: 'conv-stream',
          agentImUserId: 'agent-streamer',
          workspaceId: 'ws-1',
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.output).toBe('hello world');
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({
        progress: 0.01,
        message: 'streaming',
        detail: { kind: 'llm_stream', event: 'assistant.delta', chars: 5 },
      });
      expect(heartbeat.touchStep).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
      if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = oldHermesHome;
      vi.unstubAllGlobals();
      setHermesSessionMapper(null);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Hermes native goal mirror helpers', () => {
  it('normalizes Prismer goals into Hermes GoalManager status', () => {
    expect(normalizeGoalStatus('active')).toBe('active');
    expect(normalizeGoalStatus('paused')).toBe('paused');
    expect(normalizeGoalStatus('completed')).toBe('done');
    expect(normalizeGoalStatus('failed')).toBe('cleared');
  });

  it('parses and formats Prismer goal payloads', () => {
    const goals = parsePrismerGoals([
      { id: 'g1', title: 'Ship release', description: 'Close blockers', status: 'active', priority: 'high' },
      { id: 'bad' },
      null,
    ]);
    expect(goals).toHaveLength(2);
    expect(formatHermesGoalText(goals)).toContain('[high] Ship release');
  });

  it('writes session goal state into Hermes profile state.db', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-goal-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = writeHermesGoalState('test-profile', 'conv-1', [
        {
          id: 'goal-1',
          title: 'Keep goals canonical',
          description: 'Mirror state without fake REST URLs',
          status: 'paused',
          priority: 'high',
        },
      ]);
      expect(result.status).toBe('paused');

      const db = new Database(join(home, '.hermes', 'profiles', 'test-profile', 'state.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT value FROM state_meta WHERE key = ?').get('goal:conv-1') as { value: string };
        const value = JSON.parse(row.value);
        expect(value.status).toBe('paused');
        expect(value.goal).toContain('Keep goals canonical');
        expect(value.paused_reason).toBe('prismer-goal-paused');
      } finally {
        db.close();
      }
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// release201/26 §13.4a — vision config pin. hermes routes images through a
// separate vision_analyze_tool aux LLM whose provider auto-detect doesn't
// recognize `custom:` providers (→ 502). The fix is pure config:
// model.supports_vision + agent.image_input_mode=native.
//
// 2026-05-30 — default logic switched from the coarse `proxyProvider ===
// 'deepseek' ? false : true` heuristic to a per-model allowlist
// (VISION_CAPABLE_MODELS), measured by real cloud-proxy probes. The
// authoritative round is the STRONG test: a real Apple Music screenshot +
// open-ended prompt (scripts/spike/model-vision-probe-screenshot.ts, 2
// runs/model) — all 3 newapi models described concrete on-screen content
// (Apple Music, artists, now-playing) impossible to guess blind:
//   gemini-3.1-pro-preview / gemini-3.1-flash-lite-preview / us-kimi-k2.6 → true
//   deepseek-v4-flash / deepseek-v4-pro                                   → false
// These tests now assert the allowlist semantics: a vision model defaults to
// true (+ native pin), a non-vision model defaults to false (no native pin),
// and an explicit supportsVision always wins.
describe('configurePrismerProvider vision pin (release201/26 §13.4a)', () => {
  /**
   * Run prepareProfile (which calls configurePrismerProvider) against an
   * isolated HERMES_HOME and return the parsed config.yaml document. `extra`
   * is merged into the AgentProfile.config so each case tunes supportsVision /
   * proxyProvider. `preWrite` optionally seeds an existing config.yaml to prove
   * idempotent operator-key preservation.
   */
  async function runProfile(
    profileName: string,
    extra: Record<string, unknown>,
    preWrite?: (configPath: string) => void,
  ): Promise<Record<string, unknown>> {
    const home = mkdtempSync(join(tmpdir(), 'prismer-hermes-vision-'));
    const oldHermesHome = process.env.HERMES_HOME;
    const oldBaseUrl = process.env.PRISMER_BASE_URL;
    const oldApiKey = process.env.PRISMER_API_KEY;
    process.env.HERMES_HOME = join(home, 'hermes');
    process.env.PRISMER_BASE_URL = 'http://127.0.0.1:3000';
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    try {
      const profileDir = join(process.env.HERMES_HOME, 'profiles', profileName);
      const configPath = join(profileDir, 'config.yaml');
      if (preWrite) {
        mkdirSync(profileDir, { recursive: true });
        preWrite(configPath);
      }
      await hermesAdapter.prepareProfile?.({
        id: `profile-${profileName}`,
        workspaceId: 'ws-1',
        agentImUserId: `agent-${profileName}`,
        agentUsername: profileName,
        adapterName: 'hermes',
        name: 'default',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          apiKey: 'hermes-api-key',
          hermesProfileName: profileName,
          installMemoryHooks: false,
          installPrismerMcpServer: false,
          ...extra,
        },
      });
      const raw = readFileSync(configPath, 'utf8');
      return YAML.parse(raw) as Record<string, unknown>;
    } finally {
      if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = oldHermesHome;
      if (oldBaseUrl === undefined) delete process.env.PRISMER_BASE_URL;
      else process.env.PRISMER_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.PRISMER_API_KEY;
      else process.env.PRISMER_API_KEY = oldApiKey;
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('(a) default model (us-kimi-k2.6, allowlisted) → vision on: supports_vision true + image_input_mode native', async () => {
    // No explicit model → config.model defaults to us-kimi-k2.6, which is on
    // the verified VISION_CAPABLE_MODELS allowlist → default true.
    const doc = await runProfile('ceo', {});
    const model = doc.model as Record<string, unknown>;
    const agent = doc.agent as Record<string, unknown>;
    expect(model.supports_vision).toBe(true);
    expect(agent.image_input_mode).toBe('native');
  });

  it('(a2) allowlisted gemini model → vision on (per-model, not provider)', async () => {
    const doc = await runProfile('gem', { model: 'gemini-3.1-pro-preview' });
    const model = doc.model as Record<string, unknown>;
    const agent = doc.agent as Record<string, unknown>;
    expect(model.supports_vision).toBe(true);
    expect(agent.image_input_mode).toBe('native');
  });

  it('(b) non-allowlisted model (deepseek-v4-flash, verified text-only) → false, no native pin', async () => {
    // deepseek-v4-* 400 on image_url parts (verified 2026-05-30) → absent from
    // the allowlist → default false. proxyProvider is irrelevant to the verdict
    // now; the model id is what's measured.
    const doc = await runProfile('ds', { proxyProvider: 'deepseek', model: 'deepseek-v4-flash' });
    const model = doc.model as Record<string, unknown>;
    expect(model.supports_vision).toBe(false);
    // No agent.image_input_mode forced when vision is off.
    const agent = doc.agent as Record<string, unknown> | undefined;
    expect(agent?.image_input_mode).toBeUndefined();
  });

  it('(b2) explicit supportsVision=true overrides the allowlist for an off-list model', async () => {
    const doc = await runProfile('ds2', {
      proxyProvider: 'deepseek',
      model: 'deepseek-v4-pro',
      supportsVision: true,
    });
    const model = doc.model as Record<string, unknown>;
    const agent = doc.agent as Record<string, unknown>;
    expect(model.supports_vision).toBe(true);
    expect(agent.image_input_mode).toBe('native');
  });

  it('(c) explicit supportsVision=false on an allowlisted model → false, no native pin', async () => {
    const doc = await runProfile('textonly', { supportsVision: false });
    const model = doc.model as Record<string, unknown>;
    expect(model.supports_vision).toBe(false);
    const agent = doc.agent as Record<string, unknown> | undefined;
    expect(agent?.image_input_mode).toBeUndefined();
  });

  it('(d) idempotent: preserves operator-set agent.* and model.* sibling keys', async () => {
    const doc = await runProfile('op', {}, (configPath) => {
      writeFileSync(
        configPath,
        YAML.stringify({
          model: { temperature: 0.3, default: 'operator-model' },
          agent: { max_steps: 42, image_input_mode: 'caption' },
        }),
        'utf8',
      );
    });
    const model = doc.model as Record<string, unknown>;
    const agent = doc.agent as Record<string, unknown>;
    // Managed keys applied.
    expect(model.supports_vision).toBe(true);
    expect(agent.image_input_mode).toBe('native'); // managed key overwrites
    // Operator siblings preserved.
    expect(model.temperature).toBe(0.3);
    expect(agent.max_steps).toBe(42);
    // Managed model keys still set (default overwritten with config.model).
    expect(model.provider).toBe('custom:prismer');
  });
});

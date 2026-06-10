// 14b rev.3 §3.0.4 / §9 — Hermes + OpenClaw adapter multimodal switch.
//
// release201/25 §16.4 A3 (2026-05-29) — the legacy hermes paths
// (`POST /v1/runs` text-only + `POST /v1/chat/completions` multimodal)
// were removed. Both text-only and multimodal now travel through
// `POST /api/sessions/{id}/chat/stream` (sessions API).
//
// Verifies via mocked global `fetch`:
//   * Hermes — text-only AND image path both hit
//     /api/sessions/{id}/chat/stream; image refs become OpenAI-shape
//     `image_url` parts inside the `message` content array.
//   * OpenClaw — always hits /v1/responses (it natively handles text-only
//     via `input_text` blocks); image refs become `input_image`; non-image
//     refs become `input_file`.
//
// We don't run a real Hermes or OpenClaw — fetch is stubbed so we capture
// the body shape on the way out and assert against it.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AgentProfile, TaskInput } from '../src/adapters/contract.js';
import type { ResolvedAssetRef } from '../src/types/im-events.js';

// Helpers ───────────────────────────────────────────────────────────

const PNG_BYTES_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

function makeImageRef(overrides: Partial<ResolvedAssetRef> = {}): ResolvedAssetRef {
  return {
    assetId: 'ast-img-1',
    contentHash: 'sha256-abc',
    mime: 'image/png',
    sizeBytes: 100,
    kind: 'image',
    workspaceId: 'ws-1',
    role: 'attachment',
    cdnUrl: 'https://cdn.example.com/img.png',
    reachable: 'cdn',
    ...overrides,
  };
}

function makePdfRef(overrides: Partial<ResolvedAssetRef> = {}): ResolvedAssetRef {
  return {
    assetId: 'ast-pdf-1',
    contentHash: 'sha256-def',
    mime: 'application/pdf',
    sizeBytes: 500,
    kind: 'file',
    workspaceId: 'ws-1',
    role: 'attachment',
    filename: 'report.pdf',
    base64: 'JVBERi0xLjQK',
    reachable: 'base64',
    ...overrides,
  };
}

function makeProfile(adapterName: 'hermes' | 'openclaw'): AgentProfile {
  return {
    id: 'profile-test',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-test',
    agentUsername: 'test-agent',
    adapterName,
    name: 'default',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    config: { apiKey: 'sk-test', prismerMcpServerPath: '/tmp/mcp.js' },
  };
}

// ─── Hermes ────────────────────────────────────────────────────────

/**
 * release201/25 §16.4 A3 — sessions API is the only hermes dispatch path.
 *
 * The adapter requires:
 *   * GET /v1/capabilities → { features.session_chat_streaming: true }
 *   * a HermesSessionMapper singleton (injected via setHermesSessionMapper)
 *   * task.metadata.conversationId + task.metadata.agentImUserId
 *
 * The stub mapper below short-circuits both `get` and `createForConversation`
 * so the test doesn't need a sqlite db. The fetch mock answers
 * /health, /v1/capabilities, /api/sessions, and /api/sessions/{id}/chat/stream.
 */
function makeStubSessionMapper(): {
  get: (conversationId: string, agentImUserId: string) => { conversationId: string; agentImUserId: string; hermesSessionId: string; hermesSessionKey: string | null } | null;
  createForConversation: (
    baseUrl: string,
    apiKey: string,
    conversationId: string,
    agentImUserId: string,
    profileName: string,
    workspaceId?: string,
  ) => Promise<{ conversationId: string; agentImUserId: string; hermesSessionId: string; hermesSessionKey: string | null }>;
} {
  let cached: { conversationId: string; agentImUserId: string; hermesSessionId: string; hermesSessionKey: string | null } | null = null;
  return {
    get(conversationId, agentImUserId) {
      if (!cached) return null;
      return cached.conversationId === conversationId && cached.agentImUserId === agentImUserId ? cached : null;
    },
    async createForConversation(_baseUrl, _apiKey, conversationId, agentImUserId) {
      cached = {
        conversationId,
        agentImUserId,
        hermesSessionId: `sess-${conversationId}`,
        hermesSessionKey: null,
      };
      return cached;
    },
  };
}

function buildSessionsSse(deltaText: string): string {
  // The sessions API emits structured events keyed by `event:` line.
  // Minimum sequence to satisfy consumeSessionsSse: run.started + one
  // assistant.delta + run.completed.
  return [
    'event: run.started',
    'data: {"run_id":"run-1"}',
    '',
    'event: assistant.delta',
    `data: {"delta":${JSON.stringify(deltaText)}}`,
    '',
    'event: run.completed',
    'data: {"usage":{"input_tokens":10,"output_tokens":3}}',
    '',
  ].join('\n');
}

describe('hermes adapter — sessions API multimodal (release201/25 §16.4 A3)', () => {
  let home: string;
  let oldHermesHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prismer-hermes-mm-'));
    oldHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(home, 'hermes');
  });
  afterEach(async () => {
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    // Reset session-mapper singleton between tests.
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper(null);
  });

  function makeStubFetch(captured: Array<{ url: string; method?: string; body?: unknown }>): typeof fetch {
    return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      // checkHealth hits /health/detailed and parses json (status:'ok' +
      // platforms.api_server.state:'connected'); bare /health {ok:true}
      // no longer satisfies the evolved health gate.
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
          json: async () => ({
            features: { session_chat_streaming: true, run_approval_response: true },
          }),
        } as Response;
      }
      captured.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/api/sessions')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null } as unknown as Headers,
          json: async () => ({ session: { id: 'sess-conv-1' } }),
        } as Response;
      }
      if (url.includes('/api/sessions/') && url.endsWith('/chat/stream')) {
        const encoder = new TextEncoder();
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(buildSessionsSse('ack')));
              controller.close();
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, text: async () => 'unexpected url' } as Response;
    }) as unknown as typeof fetch;
  }

  it('text-only task POSTs /api/sessions/{id}/chat/stream with string message', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    const result = await service.dispatch({
      taskId: 't-text',
      prompt: 'just text',
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    expect(result.ok).toBe(true);
    // The stub session mapper synthesises the (conv,agent) → sessionId
    // row in memory rather than calling POST /api/sessions, so only the
    // chat/stream request appears on the wire. The real mapper calls
    // POST /api/sessions on first turn — covered by sessions-mapper unit
    // tests, not here.
    const chatStream = requests.find((r) => r.url.endsWith('/chat/stream'));
    expect(chatStream).toBeDefined();
    expect(chatStream!.url).toContain('/api/sessions/');
    const body = chatStream!.body as { message: unknown; system_message: unknown };
    // release201/30 — message is now wrapped in <conversation_context> XML.
    // Trigger prompt appears as <current_message> content; the legacy
    // bare-string contract no longer applies.
    expect(typeof body.message).toBe('string');
    expect(body.message).toContain('<conversation_context');
    expect(body.message).toContain('<current_message');
    expect(body.message).toContain('just text');
    // Schema doc prepended to system_message.
    expect(typeof body.system_message).toBe('string');
    expect(body.system_message).toContain('Reading the <conversation_context>');

    // No legacy paths should ever be hit.
    expect(requests.some((r) => r.url.endsWith('/v1/runs'))).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/v1/chat/completions'))).toBe(false);
  });

  it('image task POSTs /api/sessions/{id}/chat/stream with image_url part', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    const result = await service.dispatch({
      taskId: 't-img',
      prompt: 'describe this',
      assetRefs: [makeImageRef()],
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    expect(result.ok).toBe(true);
    const chatStream = requests.find((r) => r.url.endsWith('/chat/stream'));
    expect(chatStream).toBeDefined();
    const body = chatStream!.body as { message: unknown };
    expect(Array.isArray(body.message)).toBe(true);
    const parts = body.message as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text).toContain('describe this');
    const imgPart = parts.find((p) => p.type === 'image_url');
    expect(imgPart).toBeDefined();
    expect(imgPart!.image_url?.url).toBe('https://cdn.example.com/img.png');

    expect(requests.some((r) => r.url.endsWith('/v1/chat/completions'))).toBe(false);
  });

  it('falls back to base64 data: URI when cdn is not reachable', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    await service.dispatch({
      taskId: 't-img-b64',
      prompt: 'see this',
      assetRefs: [
        makeImageRef({
          cdnUrl: undefined,
          base64: PNG_BYTES_BASE64,
          reachable: 'base64',
        }),
      ],
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    const chatStream = requests.find((r) => r.url.endsWith('/chat/stream'));
    const body = chatStream!.body as { message: Array<{ type: string; image_url?: { url: string } }> };
    const imgPart = body.message.find((p) => p.type === 'image_url')!;
    expect(imgPart.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(imgPart.image_url!.url).toContain(PNG_BYTES_BASE64);
  });

  it('rejects dispatch when conversationId/agentImUserId missing (A3 hard requirement)', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    setHermesSessionMapper(makeStubSessionMapper() as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    const result = await service.dispatch({
      taskId: 't-bare',
      prompt: 'no metadata',
      metadata: {},
    } as TaskInput);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('adapter_dispatch_failed');
    expect(result.error?.message).toMatch(/conversationId.*agentImUserId/);
    // The error fires before any dispatch fetch — only the capability +
    // health probes during ensureService() should have happened.
    expect(requests.some((r) => r.url.endsWith('/chat/stream'))).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/v1/runs'))).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/v1/chat/completions'))).toBe(false);
  });

  // release201/26 §13.2/§13.3 #1 — Hermes is `stateful`. The sessions
  // dispatcher renders the envelope into the current-turn prefix capability-
  // aware: SEED (full) on a new session, THIN (IM delta only) on a reused one.
  function envelopeWithHistory(): import('../src/adapters/contract.js').TaskInput['contextEnvelope'] {
    return {
      envelopeVersion: 1,
      conversationId: 'conv-1',
      conversationType: 'group',
      participants: [],
      recent: [
        { messageId: 'm-1', role: 'human', sender: 'alice', content: 'earlier recent line', createdAt: '2026-05-05T00:00:00Z' },
      ],
      compressedSegments: [
        {
          segmentSeq: 1,
          coversFromAt: '2026-05-01T00:00:00Z',
          coversToAt: '2026-05-02T00:00:00Z',
          summary: 'older compressed summary',
          salientFacts: {},
          sourceCount: 4,
          tokenCountCl100k: 50,
        },
      ],
      quotes: [
        { quotedMessageId: 'm-9', snippet: 'the layout we agreed on', quotedSender: 'alice', quotedAt: '2026-05-04T00:00:00Z' },
      ],
      assets: { inputs: [], archives: [] },
      budget: {
        totalTokens: 8000,
        floors: { recent: 2000, compressedSegments: 800, quotes: 300, identifierIndex: 200, recentTaskTrace: 300 },
      },
    };
  }

  it('SEEDS full envelope body on a NEW session (recent + compressed + quote in current-turn prefix)', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    // Fresh stub mapper → get() returns null first → createForConversation →
    // session.isNew === true.
    setHermesSessionMapper(makeStubSessionMapper() as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    const result = await service.dispatch({
      taskId: 't-seed',
      prompt: 'live current turn',
      currentPrompt: 'live current turn',
      contextEnvelope: envelopeWithHistory(),
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    expect(result.ok).toBe(true);
    const chatStream = requests.find((r) => r.url.endsWith('/chat/stream'));
    const message = (chatStream!.body as { message: string }).message;
    // Full seed: recent + compressed + quote all present, then the live turn.
    expect(message).toContain('earlier recent line');
    expect(message).toContain('older compressed summary');
    expect(message).toContain('the layout we agreed on');
    // The live turn is the LAST content, now wrapped in <current_message>
    // (release201/30 envelope: the whole turn is one XML doc, the final
    // <current_message> is "what you're responding to"). Older expectation
    // `endsWith('live current turn')` predated the XML wrapping.
    expect(message).toMatch(
      /<current_message\b[^>]*>[\s\S]*\blive current turn\b[\s\S]*<\/current_message>\s*<\/conversation_context>\s*$/,
    );
  });

  it('THINS to IM-delta only on a REUSED session (drops recent + compressed; keeps quote)', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    const mapper = makeStubSessionMapper();
    // Pre-seed the cache so get() returns a row → session.isNew === false.
    await mapper.createForConversation('', '', 'conv-1', 'agent-test', 'hermes', 'ws-1');
    setHermesSessionMapper(mapper as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    const result = await service.dispatch({
      taskId: 't-thin',
      prompt: 'live current turn',
      currentPrompt: 'live current turn',
      contextEnvelope: envelopeWithHistory(),
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    expect(result.ok).toBe(true);
    const chatStream = requests.find((r) => r.url.endsWith('/chat/stream'));
    const message = (chatStream!.body as { message: string }).message;
    // Thin: Hermes already holds recent + compressed → dropped.
    expect(message).not.toContain('earlier recent line');
    expect(message).not.toContain('older compressed summary');
    // IM-domain delta Hermes can't know is kept.
    expect(message).toContain('the layout we agreed on');
    // Current turn is the last slot, wrapped in <current_message> then the
    // envelope's closing tag — no longer raw-text-terminated.
    expect(message).toMatch(/<current_message\b[^>]*>[\s\S]*\blive current turn\b[\s\S]*<\/current_message>\s*<\/conversation_context>\s*$/);
  });

  // release201/26 §13.4a P2 — cross-turn image quote re-injection. On a REUSED
  // session (recent dropped), an image quoted from an OLDER message must still
  // reach Hermes as a real image_url part — its history holds only a
  // `[screenshot]` placeholder so a text quote line cannot convey pixels.
  it('re-injects a quoted older-message IMAGE as an image_url part even on a REUSED (thin) session', async () => {
    const { hermesAdapter } = await import('../src/adapters/hermes/index.js');
    const { setHermesSessionMapper } = await import('../src/adapters/hermes/sessions-mapper.js');
    const mapper = makeStubSessionMapper();
    await mapper.createForConversation('', '', 'conv-1', 'agent-test', 'hermes', 'ws-1');
    setHermesSessionMapper(mapper as never);

    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', makeStubFetch(requests));

    const envelope = envelopeWithHistory()!;
    envelope.quotes = [
      {
        quotedMessageId: 'm-9',
        snippet: 'the chart from earlier',
        quotedSender: 'alice',
        quotedAt: '2026-05-04T00:00:00Z',
        imageAssetRefs: [
          {
            assetId: 'ast-quoted-img',
            contentHash: 'sha256-q',
            mime: 'image/png',
            sizeBytes: 222,
            kind: 'image',
            workspaceId: 'ws-1',
            role: 'attachment',
            cdnUrl: 'https://cdn.example.com/quoted.png',
          },
        ],
      },
    ];

    const service = await hermesAdapter.ensureService!(makeProfile('hermes'));
    const result = await service.dispatch({
      taskId: 't-quote-img',
      prompt: 'what colour was the bottom-left?',
      currentPrompt: 'what colour was the bottom-left?',
      contextEnvelope: envelope,
      metadata: { conversationId: 'conv-1', agentImUserId: 'agent-test', workspaceId: 'ws-1' },
    } as TaskInput);

    expect(result.ok).toBe(true);
    const chatStream = requests.find((r) => r.url.endsWith('/chat/stream'));
    const message = chatStream!.body as { message: Array<{ type: string; image_url?: { url: string } }> };
    // multimodal array: the quoted image is re-injected as an image_url part …
    expect(Array.isArray(message.message)).toBe(true);
    const imgPart = message.message.find((p) => p.type === 'image_url');
    expect(imgPart).toBeDefined();
    expect(imgPart!.image_url?.url).toBe('https://cdn.example.com/quoted.png');
    // … recent still dropped on the reused session (thin path unchanged).
    const textPart = message.message.find((p) => p.type === 'text') as { text?: string } | undefined;
    expect(textPart?.text).not.toContain('earlier recent line');
  });
});

// ─── OpenClaw ──────────────────────────────────────────────────────

describe('openclaw adapter — endpoint switch to /v1/responses (14b §3.0.4 P2)', () => {
  let home: string;
  let oldOpenclawHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prismer-openclaw-mm-'));
    oldOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = join(home, 'openclaw');
    // Pre-create the skills dir so OpenClawSkillLoader doesn't fail.
    mkdirSync(join(process.env.OPENCLAW_HOME, 'profiles', 'test-agent', 'skills'), {
      recursive: true,
    });
  });
  afterEach(() => {
    if (oldOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = oldOpenclawHome;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  function stubResponsesFetch(captured: Array<{ url: string; body?: unknown }>): void {
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('/health/detailed')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', gateway_state: 'running', platforms: { api_server: { state: 'connected' } } }),
        } as Response;
      }
      if (url.endsWith('/v1/capabilities')) {
        return { ok: true, status: 200, json: async () => ({ features: { session_chat_streaming: true } }) } as Response;
      }
      captured.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'ack' }],
            },
          ],
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('text-only request POSTs /v1/responses with input_text only', async () => {
    const { openclawAdapter } = await import('../src/adapters/openclaw/index.js');
    const requests: Array<{ url: string; body?: unknown }> = [];
    stubResponsesFetch(requests);

    const service = await openclawAdapter.ensureService!(makeProfile('openclaw'));
    const result = await service.dispatch({
      taskId: 't-text',
      prompt: 'hello',
      metadata: {},
    } as TaskInput);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('ack');
    const dispatchReq = requests.find((r) => r.url.includes('/v1/'));
    expect(dispatchReq!.url).toMatch(/\/v1\/responses$/);
    // Critical: should NOT hit the legacy chat-completions endpoint.
    expect(requests.some((r) => r.url.includes('/v1/chat/completions'))).toBe(false);

    const body = dispatchReq!.body as {
      model: string;
      input: Array<{ type: string; role: string; content: Array<{ type: string }> }>;
    };
    const userMsg = body.input[0]!;
    expect(userMsg.role).toBe('user');
    expect(userMsg.content[0]).toMatchObject({ type: 'input_text', text: 'hello' });
    // No image/file blocks for text-only.
    expect(userMsg.content.find((c) => c.type === 'input_image')).toBeUndefined();
    expect(userMsg.content.find((c) => c.type === 'input_file')).toBeUndefined();
  });

  it('image asset becomes input_image block with source.url when cdn reachable', async () => {
    const { openclawAdapter } = await import('../src/adapters/openclaw/index.js');
    const requests: Array<{ url: string; body?: unknown }> = [];
    stubResponsesFetch(requests);

    const service = await openclawAdapter.ensureService!(makeProfile('openclaw'));
    await service.dispatch({
      taskId: 't-img',
      prompt: 'count buttons',
      assetRefs: [makeImageRef()],
    } as TaskInput);

    const dispatchReq = requests.find((r) => r.url.includes('/v1/responses'));
    const body = dispatchReq!.body as {
      input: Array<{
        content: Array<{ type: string; source?: { type: string; url?: string; data?: string } }>;
      }>;
    };
    const content = body.input[0]!.content;
    const imgBlock = content.find((c) => c.type === 'input_image');
    expect(imgBlock).toBeDefined();
    expect(imgBlock!.source).toMatchObject({
      type: 'url',
      url: 'https://cdn.example.com/img.png',
    });
  });

  it('image asset becomes input_image with source.base64 when cdn unreachable', async () => {
    const { openclawAdapter } = await import('../src/adapters/openclaw/index.js');
    const requests: Array<{ url: string; body?: unknown }> = [];
    stubResponsesFetch(requests);

    const service = await openclawAdapter.ensureService!(makeProfile('openclaw'));
    await service.dispatch({
      taskId: 't-img-b64',
      prompt: 'see this',
      assetRefs: [
        makeImageRef({ cdnUrl: undefined, base64: PNG_BYTES_BASE64, reachable: 'base64' }),
      ],
    } as TaskInput);

    const dispatchReq = requests.find((r) => r.url.includes('/v1/responses'));
    const body = dispatchReq!.body as {
      input: Array<{
        content: Array<{
          type: string;
          source?: { type: string; data?: string; media_type?: string };
        }>;
      }>;
    };
    const imgBlock = body.input[0]!.content.find((c) => c.type === 'input_image');
    expect(imgBlock!.source).toMatchObject({
      type: 'base64',
      data: PNG_BYTES_BASE64,
      media_type: 'image/png',
    });
  });

  it('mixed image + PDF refs produce input_image + input_file blocks side-by-side', async () => {
    const { openclawAdapter } = await import('../src/adapters/openclaw/index.js');
    const requests: Array<{ url: string; body?: unknown }> = [];
    stubResponsesFetch(requests);

    const service = await openclawAdapter.ensureService!(makeProfile('openclaw'));
    await service.dispatch({
      taskId: 't-mixed',
      prompt: 'summarize',
      assetRefs: [makeImageRef(), makePdfRef()],
    } as TaskInput);

    const dispatchReq = requests.find((r) => r.url.includes('/v1/responses'));
    const body = dispatchReq!.body as {
      input: Array<{
        content: Array<{
          type: string;
          source?: { type: string; filename?: string; media_type?: string };
        }>;
      }>;
    };
    const content = body.input[0]!.content;
    expect(content.find((c) => c.type === 'input_image')).toBeDefined();
    const fileBlock = content.find((c) => c.type === 'input_file');
    expect(fileBlock).toBeDefined();
    expect(fileBlock!.source).toMatchObject({
      type: 'base64',
      media_type: 'application/pdf',
      filename: 'report.pdf',
    });
  });

  it('preserves top-level instructions when systemPrompt metadata is set', async () => {
    const { openclawAdapter } = await import('../src/adapters/openclaw/index.js');
    const requests: Array<{ url: string; body?: unknown }> = [];
    stubResponsesFetch(requests);

    const service = await openclawAdapter.ensureService!(makeProfile('openclaw'));
    await service.dispatch({
      taskId: 't-sys',
      prompt: 'hello',
      metadata: { systemPrompt: 'You are a code reviewer.' },
    } as TaskInput);

    const dispatchReq = requests.find((r) => r.url.includes('/v1/responses'));
    const body = dispatchReq!.body as { instructions?: string };
    expect(body.instructions).toBe('You are a code reviewer.');
  });

  // release201/26 §13.4a P2 — a quoted older-message image is re-injected as an
  // input_image block on the current turn (stateless re-ships history as text,
  // but pixels still need an image part).
  it('re-injects a quoted older-message IMAGE as an input_image block', async () => {
    const { openclawAdapter } = await import('../src/adapters/openclaw/index.js');
    const requests: Array<{ url: string; body?: unknown }> = [];
    stubResponsesFetch(requests);

    const service = await openclawAdapter.ensureService!(makeProfile('openclaw'));
    await service.dispatch({
      taskId: 't-quote-img',
      prompt: 'what was in the chart?',
      currentPrompt: 'what was in the chart?',
      contextEnvelope: {
        envelopeVersion: 1,
        conversationId: 'conv-1',
        conversationType: 'group',
        participants: [],
        recent: [
          { messageId: 'm-1', role: 'human', sender: 'alice', content: 'hi', createdAt: '2026-05-05T00:00:00Z' },
        ],
        compressedSegments: [],
        quotes: [
          {
            quotedMessageId: 'm-9',
            snippet: 'the chart from earlier',
            quotedSender: 'alice',
            quotedAt: '2026-05-04T00:00:00Z',
            imageAssetRefs: [
              {
                assetId: 'ast-quoted-img',
                contentHash: 'sha256-q',
                mime: 'image/png',
                sizeBytes: 222,
                kind: 'image',
                workspaceId: 'ws-1',
                role: 'attachment',
                cdnUrl: 'https://cdn.example.com/quoted.png',
              },
            ],
          },
        ],
        assets: { inputs: [], archives: [] },
        budget: {
          totalTokens: 8000,
          floors: { recent: 2000, compressedSegments: 800, quotes: 300, identifierIndex: 200, recentTaskTrace: 300 },
        },
      },
      metadata: {},
    } as TaskInput);

    const dispatchReq = requests.find((r) => r.url.includes('/v1/responses'));
    const body = dispatchReq!.body as {
      input: Array<{ role?: string; content: Array<{ type: string; source?: { type: string; url?: string } }> }>;
    };
    // The current-turn user message (last input entry) carries the input_image.
    const userMsg = body.input[body.input.length - 1]!;
    const imgBlock = userMsg.content.find((c) => c.type === 'input_image');
    expect(imgBlock).toBeDefined();
    expect(imgBlock!.source).toMatchObject({ type: 'url', url: 'https://cdn.example.com/quoted.png' });
  });
});

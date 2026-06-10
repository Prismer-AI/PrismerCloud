/**
 * v2.0 §3.0.2 Gap A-④ + §4.6 — ContentBlock type + sendMessage X-Idempotency-Key
 *
 * Wave 3 Agent D1 (track 14 §3.0.2): protocol-layer SDK upgrades.
 *
 *  1. ContentBlock 8-variant union compiles + narrows correctly (TS-only).
 *  2. MessagesClient.send / DirectClient.send / GroupsClient.send:
 *     - auto-generate X-Idempotency-Key header per call when not passed
 *     - use the caller-supplied key when explicitly provided
 *     - retried calls with the same explicit key reuse that key in the header
 *     - serialise ContentBlock[] into body.contentBlocks
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerClient } from '../src/index';
import type {
  ContentBlock,
  ContentBlockImage,
  ContentBlockToolUse,
  ContentBlockReasoning,
  ChatMessage,
  TaskInput,
} from '../src/types';

// ────────────────────────────────────────────────────────────────────────────
// TS-only: ContentBlock discriminated-union narrowing compiles
// ────────────────────────────────────────────────────────────────────────────

function _typeOnlyAssertions(): void {
  const text: ContentBlock = { kind: 'text', text: 'hello' };
  const image: ContentBlockImage = { kind: 'image', assetId: 'a1', mediaType: 'image/png', alt: 'pic' };
  const tool: ContentBlockToolUse = { kind: 'tool_use', toolCallId: 't1', toolName: 'image_generate', inputJson: { prompt: 'cat' } };
  const reason: ContentBlockReasoning = { kind: 'reasoning', text: 'thinking', redacted: false };

  // narrow check
  const blocks: ContentBlock[] = [text, image, tool, reason,
    { kind: 'audio', assetId: 'a2', mediaType: 'audio/mpeg', durationMs: 120 },
    { kind: 'video', assetId: 'a3', mediaType: 'video/mp4', durationMs: 4000, thumbnailUrl: 'https://x/y.jpg' },
    { kind: 'file', assetId: 'a4', mediaType: 'application/pdf', filename: 'spec.pdf' },
    { kind: 'tool_result', toolCallId: 't1', output: [{ kind: 'text', text: 'ok' }] },
  ];

  for (const b of blocks) {
    switch (b.kind) {
      case 'text': b.text.toLowerCase(); break;
      case 'image': b.mediaType.startsWith('image/'); b.assetId.length; break;
      case 'audio': b.durationMs?.toFixed(0); break;
      case 'video': b.thumbnailUrl?.startsWith('http'); break;
      case 'file': b.filename.endsWith('.pdf'); break;
      case 'tool_use': void b.inputJson; b.toolName.length; break;
      case 'tool_result': b.output.length; break;
      case 'reasoning': b.text.length; b.redacted ?? false; break;
    }
  }

  // TaskInput.messages accepts ChatMessage[]
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ kind: 'text', text: 'see' }, { kind: 'image', assetId: 'a1', mediaType: 'image/png' }] },
    { role: 'tool', content: [{ kind: 'tool_result', toolCallId: 't1', output: [{ kind: 'text', text: 'r' }] }], toolCallId: 't1' },
  ];
  const _ti: TaskInput = { prompt: 'fallback', messages: msgs, extraCapabilityArg: 1 };
  void _ti;
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime: mock fetch + observe X-Idempotency-Key header behaviour
// ────────────────────────────────────────────────────────────────────────────

function makeMockFetch() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init.headers as Record<string, string>;
    for (const k of Object.keys(h ?? {})) headers[k.toLowerCase()] = h[k];
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify({ ok: true, success: true, data: { conversationId: 'c1', message: { id: 'm1', boundarySeq: 1 } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('v2.0 §3.0.2 Gap A-④ — auto idempotency key', () => {
  it('sendMessage(conversation) auto-generates X-Idempotency-Key when no key passed', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    await client.im.messages.send('cid-1', 'hello world');

    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://x.test/api/im/messages/cid-1');
    expect(c.method).toBe('POST');
    // Header is canonicalised to lowercase by the mock fetch helper
    const key = c.headers['x-idempotency-key'];
    expect(key).toBeTruthy();
    // UUID v4 shape — 8-4-4-4-12 hex
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Same key mirrored into JSON body for the offline-path fallback
    expect(c.body?.idempotencyKey).toBe(key);
  });

  it('two sequential sendMessage calls without explicit key use DIFFERENT keys', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    await client.im.messages.send('cid-1', 'first');
    await client.im.messages.send('cid-1', 'second');

    expect(calls).toHaveLength(2);
    const k1 = calls[0].headers['x-idempotency-key'];
    const k2 = calls[1].headers['x-idempotency-key'];
    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();
    expect(k1).not.toBe(k2);
  });

  it('explicit idempotencyKey is forwarded to header and body unchanged', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    const myKey = '11111111-2222-4333-8444-555555555555';
    await client.im.messages.send('cid-1', 'retry me', { idempotencyKey: myKey });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-idempotency-key']).toBe(myKey);
    expect(calls[0].body?.idempotencyKey).toBe(myKey);
  });

  it('retry loop with same idempotencyKey reuses the same header value', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    // Caller's retry pattern from §3.0.2
    const sharedKey = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (let attempt = 0; attempt < 3; attempt++) {
      await client.im.messages.send('cid-1', 'crashy', { idempotencyKey: sharedKey });
    }

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.headers['x-idempotency-key']).toBe(sharedKey);
      expect(c.body?.idempotencyKey).toBe(sharedKey);
    }
  });

  it('DirectClient.send + GroupsClient.send also stamp the header', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    await client.im.direct.send('user-1', 'dm');
    await client.im.groups.send('group-1', 'gm');

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://x.test/api/im/direct/user-1/messages');
    expect(calls[1].url).toBe('https://x.test/api/im/groups/group-1/messages');
    expect(calls[0].headers['x-idempotency-key']).toBeTruthy();
    expect(calls[1].headers['x-idempotency-key']).toBeTruthy();
    expect(calls[0].headers['x-idempotency-key']).not.toBe(calls[1].headers['x-idempotency-key']);
  });
});

describe('v2.0 §4.6 — ContentBlock[] in sendMessage body', () => {
  it('passing ContentBlock[] as content serialises into body.contentBlocks', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    const blocks: ContentBlock[] = [
      { kind: 'text', text: 'see this:' },
      { kind: 'image', assetId: 'asset-xyz', mediaType: 'image/png', alt: 'screenshot' },
    ];
    await client.im.messages.send('cid-1', blocks);

    expect(calls).toHaveLength(1);
    expect(calls[0].body?.contentBlocks).toEqual(blocks);
    // Legacy string content is empty placeholder (server still has the column)
    expect(calls[0].body?.content).toBe('');
    // Idempotency still auto-generated
    expect(calls[0].headers['x-idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('passing string + options.contentBlocks forwards both', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const client = new PrismerClient({ apiKey: 'sk-prismer-test', baseUrl: 'https://x.test', fetch: fetchFn });

    const blocks: ContentBlock[] = [{ kind: 'text', text: 'verbose' }];
    await client.im.messages.send('cid-1', 'summary', { contentBlocks: blocks });

    expect(calls[0].body?.content).toBe('summary');
    expect(calls[0].body?.contentBlocks).toEqual(blocks);
  });
});

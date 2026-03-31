/**
 * Comprehensive unit tests for the Prismer IM Webhook module.
 *
 * Covers: verifyWebhookSignature, parseWebhookPayload, PrismerWebhook class,
 * handle() method (Web Request/Response API), express adapter, and hono adapter.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  PrismerWebhook,
  type WebhookPayload,
  type WebhookReply,
} from '../../src/webhook';

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_SECRET = 'webhook-unit-test-secret';

function sign(body: string, secret: string = TEST_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function signRaw(body: string, secret: string = TEST_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function validPayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    source: 'prismer_im',
    event: 'message.new',
    timestamp: 1711800000000,
    message: {
      id: 'msg-100',
      type: 'text',
      content: 'Test message body',
      senderId: 'user-42',
      conversationId: 'conv-7',
      parentId: null,
      metadata: { foo: 'bar' },
      createdAt: '2026-03-30T12:00:00.000Z',
    },
    sender: {
      id: 'user-42',
      username: 'alice',
      displayName: 'Alice',
      role: 'human',
    },
    conversation: {
      id: 'conv-7',
      type: 'direct',
      title: null,
    },
    ...overrides,
  };
}

function bodyStr(overrides: Partial<WebhookPayload> = {}): string {
  return JSON.stringify(validPayload(overrides));
}

function makeRequest(
  body: string,
  sig: string,
  method: string = 'POST',
): Request {
  return new Request('http://localhost/webhook', {
    method,
    body: method === 'GET' ? undefined : body,
    headers: { 'x-prismer-signature': sig, 'content-type': 'application/json' },
  });
}

// ============================================================================
// verifyWebhookSignature — standalone function
// ============================================================================

describe('verifyWebhookSignature', () => {
  it('returns true for correct HMAC-SHA256 with sha256= prefix', () => {
    const body = bodyStr();
    expect(verifyWebhookSignature(body, sign(body), TEST_SECRET)).toBe(true);
  });

  it('returns true for correct HMAC-SHA256 without sha256= prefix', () => {
    const body = bodyStr();
    expect(verifyWebhookSignature(body, signRaw(body), TEST_SECRET)).toBe(true);
  });

  it('returns false for wrong signature', () => {
    const body = bodyStr();
    const bad = 'sha256=' + 'a'.repeat(64);
    expect(verifyWebhookSignature(body, bad, TEST_SECRET)).toBe(false);
  });

  it('returns false when body has been tampered', () => {
    const body = bodyStr();
    const sig = sign(body);
    expect(verifyWebhookSignature(body + ' ', sig, TEST_SECRET)).toBe(false);
  });

  it('returns false for signature with wrong secret', () => {
    const body = bodyStr();
    const sig = sign(body, 'other-secret');
    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(false);
  });

  it('returns false for empty body', () => {
    expect(verifyWebhookSignature('', sign('', TEST_SECRET), TEST_SECRET)).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifyWebhookSignature('hello', '', TEST_SECRET)).toBe(false);
  });

  it('returns false for empty secret', () => {
    expect(verifyWebhookSignature('hello', sign('hello', 'x'), '')).toBe(false);
  });

  it('returns false when signature is sha256= with no hex payload', () => {
    expect(verifyWebhookSignature('body', 'sha256=', TEST_SECRET)).toBe(false);
  });

  it('returns false for non-hex characters in signature', () => {
    expect(verifyWebhookSignature('body', 'sha256=ZZZZ', TEST_SECRET)).toBe(false);
  });

  it('returns false for signature with wrong length', () => {
    expect(verifyWebhookSignature('body', 'sha256=abcdef', TEST_SECRET)).toBe(false);
  });

  it('handles very large body strings', () => {
    const big = 'x'.repeat(100_000);
    const sig = sign(big);
    expect(verifyWebhookSignature(big, sig, TEST_SECRET)).toBe(true);
  });
});

// ============================================================================
// parseWebhookPayload — standalone function
// ============================================================================

describe('parseWebhookPayload', () => {
  it('parses a valid payload and returns all fields', () => {
    const payload = parseWebhookPayload(bodyStr());
    expect(payload.source).toBe('prismer_im');
    expect(payload.event).toBe('message.new');
    expect(payload.timestamp).toBe(1711800000000);
    expect(payload.message.id).toBe('msg-100');
    expect(payload.message.content).toBe('Test message body');
    expect(payload.sender.username).toBe('alice');
    expect(payload.sender.role).toBe('human');
    expect(payload.conversation.type).toBe('direct');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseWebhookPayload('{not valid')).toThrow('Invalid JSON');
  });

  it('throws on JSON array (hits source check)', () => {
    expect(() => parseWebhookPayload('[]')).toThrow('Unknown webhook source');
  });

  it('throws on JSON null', () => {
    expect(() => parseWebhookPayload('null')).toThrow('must be a JSON object');
  });

  it('throws on JSON string', () => {
    expect(() => parseWebhookPayload('"hello"')).toThrow('must be a JSON object');
  });

  it('throws on unknown source', () => {
    const data = { ...validPayload(), source: 'github' };
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Unknown webhook source: github');
  });

  it('throws on missing event', () => {
    const data = validPayload();
    (data as any).event = '';
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing event');
  });

  it('throws on missing message field', () => {
    const data = validPayload();
    delete (data as any).message;
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing required fields');
  });

  it('throws on missing sender field', () => {
    const data = validPayload();
    delete (data as any).sender;
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing required fields');
  });

  it('throws on missing conversation field', () => {
    const data = validPayload();
    delete (data as any).conversation;
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing required fields');
  });
});

// ============================================================================
// PrismerWebhook — constructor
// ============================================================================

describe('PrismerWebhook constructor', () => {
  it('creates instance with valid options', () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    expect(wh).toBeInstanceOf(PrismerWebhook);
  });

  it('throws if secret is empty string', () => {
    expect(() => new PrismerWebhook({ secret: '', onMessage: async () => {} })).toThrow(
      'Webhook secret is required',
    );
  });
});

// ============================================================================
// PrismerWebhook.verify
// ============================================================================

describe('PrismerWebhook.verify', () => {
  const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });

  it('returns true for valid signature', () => {
    const body = bodyStr();
    expect(wh.verify(body, sign(body))).toBe(true);
  });

  it('returns false for invalid signature', () => {
    expect(wh.verify(bodyStr(), 'sha256=0000')).toBe(false);
  });
});

// ============================================================================
// PrismerWebhook.parse
// ============================================================================

describe('PrismerWebhook.parse', () => {
  const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });

  it('parses valid payload', () => {
    const p = wh.parse(bodyStr());
    expect(p.source).toBe('prismer_im');
    expect(p.message.content).toBe('Test message body');
  });

  it('throws for invalid JSON', () => {
    expect(() => wh.parse('not-json')).toThrow('Invalid JSON');
  });

  it('throws for unknown source', () => {
    expect(() => wh.parse(JSON.stringify({ source: 'other' }))).toThrow('Unknown webhook source');
  });

  it('throws for missing fields', () => {
    expect(() =>
      wh.parse(JSON.stringify({ source: 'prismer_im', event: 'message.new' })),
    ).toThrow('Missing required fields');
  });
});

// ============================================================================
// PrismerWebhook.handle — Web Request/Response API
// ============================================================================

describe('PrismerWebhook.handle', () => {
  it('returns 405 for GET request', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const req = new Request('http://localhost/webhook', { method: 'GET' });
    const res = await wh.handle(req);
    expect(res.status).toBe(405);
    const data = await res.json();
    expect(data.error).toBe('Method not allowed');
  });

  it('returns 405 for PUT request', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const req = new Request('http://localhost/webhook', { method: 'PUT', body: '{}' });
    const res = await wh.handle(req);
    expect(res.status).toBe(405);
  });

  it('returns 401 for invalid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const body = bodyStr();
    const req = makeRequest(body, 'sha256=bad');
    const res = await wh.handle(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid signature');
  });

  it('returns 401 when no signature header present', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const body = bodyStr();
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
    });
    const res = await wh.handle(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 for valid signature but malformed payload', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const body = JSON.stringify({ source: 'prismer_im', event: 'message.new' });
    const sig = sign(body);
    const req = makeRequest(body, sig);
    const res = await wh.handle(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Missing required fields');
  });

  it('returns 200 with { ok: true } when handler returns void', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: handler });
    const body = bodyStr();
    const req = makeRequest(body, sign(body));
    const res = await wh.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns 200 with reply content when handler returns WebhookReply', async () => {
    const reply: WebhookReply = { content: 'Acknowledged!', type: 'text' };
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => reply,
    });
    const body = bodyStr();
    const req = makeRequest(body, sign(body));
    const res = await wh.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe('Acknowledged!');
    expect(data.type).toBe('text');
  });

  it('returns 500 when handler throws an Error', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => {
        throw new Error('Database unavailable');
      },
    });
    const body = bodyStr();
    const req = makeRequest(body, sign(body));
    const res = await wh.handle(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Database unavailable');
  });

  it('returns 500 with generic message when handler throws non-Error', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => {
        throw 'string error';
      },
    });
    const body = bodyStr();
    const req = makeRequest(body, sign(body));
    const res = await wh.handle(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Handler error');
  });

  it('passes the parsed payload to the handler', async () => {
    let received: WebhookPayload | null = null;
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async (payload) => {
        received = payload;
      },
    });
    const body = bodyStr();
    const req = makeRequest(body, sign(body));
    await wh.handle(req);
    expect(received).not.toBeNull();
    expect(received!.message.id).toBe('msg-100');
    expect(received!.sender.displayName).toBe('Alice');
    expect(received!.conversation.id).toBe('conv-7');
    expect(received!.message.metadata).toEqual({ foo: 'bar' });
  });

  it('sets Content-Type to application/json on all responses', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });

    // 405
    const r405 = await wh.handle(new Request('http://x', { method: 'GET' }));
    expect(r405.headers.get('content-type')).toBe('application/json');

    // 401
    const r401 = await wh.handle(makeRequest('{}', 'bad'));
    expect(r401.headers.get('content-type')).toBe('application/json');

    // 200
    const body = bodyStr();
    const r200 = await wh.handle(makeRequest(body, sign(body)));
    expect(r200.headers.get('content-type')).toBe('application/json');
  });
});

// ============================================================================
// PrismerWebhook.express — Express adapter
// ============================================================================

describe('PrismerWebhook.express', () => {
  function mockRes() {
    return {
      statusCode: 0,
      responseData: null as any,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.responseData = data;
      },
    };
  }

  it('returns 401 for invalid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const mw = wh.express();
    const body = bodyStr();
    const req = { body: Buffer.from(body), headers: { 'x-prismer-signature': 'sha256=bad' } };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.responseData.error).toBe('Invalid signature');
  });

  it('handles Buffer body correctly', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const mw = wh.express();
    const body = bodyStr();
    const req = { body: Buffer.from(body), headers: { 'x-prismer-signature': sign(body) } };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.responseData.ok).toBe(true);
  });

  it('handles string body correctly', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const mw = wh.express();
    const body = bodyStr();
    const req = { body, headers: { 'x-prismer-signature': sign(body) } };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('handles parsed object body (JSON.stringify fallback)', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const mw = wh.express();
    const payload = validPayload();
    const bodyString = JSON.stringify(payload);
    const req = {
      body: payload, // express parsed object
      headers: { 'x-prismer-signature': sign(bodyString) },
    };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('returns reply from handler', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => ({ content: 'OK', type: 'markdown' as const }),
    });
    const mw = wh.express();
    const body = bodyStr();
    const req = { body: Buffer.from(body), headers: { 'x-prismer-signature': sign(body) } };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.responseData.content).toBe('OK');
    expect(res.responseData.type).toBe('markdown');
  });

  it('returns 400 for malformed payload with valid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const mw = wh.express();
    const body = JSON.stringify({ source: 'unknown' });
    const req = { body, headers: { 'x-prismer-signature': sign(body) } };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 when handler throws', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => {
        throw new Error('handler crash');
      },
    });
    const mw = wh.express();
    const body = bodyStr();
    const req = { body: Buffer.from(body), headers: { 'x-prismer-signature': sign(body) } };
    const res = mockRes();
    await mw(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.responseData.error).toBe('handler crash');
  });
});

// ============================================================================
// PrismerWebhook.hono — Hono adapter
// ============================================================================

describe('PrismerWebhook.hono', () => {
  function mockHonoCtx(body: string, sig: string) {
    let result: any;
    return {
      ctx: {
        req: {
          async text() { return body; },
          header(name: string) { return name === 'x-prismer-signature' ? sig : ''; },
        },
        json(data: any, status: number) {
          result = { data, status };
          return result;
        },
      },
      getResult: () => result,
    };
  }

  it('returns 401 for invalid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const handler = wh.hono();
    const body = bodyStr();
    const { ctx, getResult } = mockHonoCtx(body, 'sha256=bad');
    await handler(ctx);
    expect(getResult().status).toBe(401);
  });

  it('returns 200 with ok:true for valid request', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const handler = wh.hono();
    const body = bodyStr();
    const { ctx, getResult } = mockHonoCtx(body, sign(body));
    await handler(ctx);
    expect(getResult().status).toBe(200);
    expect(getResult().data.ok).toBe(true);
  });

  it('returns reply from handler', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => ({ content: 'pong' }),
    });
    const handler = wh.hono();
    const body = bodyStr();
    const { ctx, getResult } = mockHonoCtx(body, sign(body));
    await handler(ctx);
    expect(getResult().status).toBe(200);
    expect(getResult().data.content).toBe('pong');
  });

  it('returns 400 for malformed payload', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const handler = wh.hono();
    const body = JSON.stringify({ source: 'prismer_im', event: 'x' });
    const { ctx, getResult } = mockHonoCtx(body, sign(body));
    await handler(ctx);
    expect(getResult().status).toBe(400);
  });

  it('returns 500 when handler throws', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => {
        throw new Error('boom');
      },
    });
    const handler = wh.hono();
    const body = bodyStr();
    const { ctx, getResult } = mockHonoCtx(body, sign(body));
    await handler(ctx);
    expect(getResult().status).toBe(500);
    expect(getResult().data.error).toBe('boom');
  });
});

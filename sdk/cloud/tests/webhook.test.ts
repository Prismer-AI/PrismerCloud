/**
 * Webhook module unit tests
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  PrismerWebhook,
  type WebhookPayload,
} from '../src/webhook';

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_SECRET = 'test-webhook-secret-key';

function makeSignature(body: string, secret: string = TEST_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makePayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    source: 'prismer_im',
    event: 'message.new',
    timestamp: Date.now(),
    message: {
      id: 'msg-001',
      type: 'text',
      content: 'Hello from test',
      senderId: 'user-001',
      conversationId: 'conv-001',
      parentId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    },
    sender: {
      id: 'user-001',
      username: 'testuser',
      displayName: 'Test User',
      role: 'human',
    },
    conversation: {
      id: 'conv-001',
      type: 'direct',
      title: null,
    },
    ...overrides,
  };
}

function makePayloadString(overrides: Partial<WebhookPayload> = {}): string {
  return JSON.stringify(makePayload(overrides));
}

// ============================================================================
// verifyWebhookSignature
// ============================================================================

describe('verifyWebhookSignature', () => {
  it('should return true for valid signature', () => {
    const body = makePayloadString();
    const sig = makeSignature(body);
    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(true);
  });

  it('should return true for signature without sha256= prefix', () => {
    const body = makePayloadString();
    const sig = makeSignature(body).replace('sha256=', '');
    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(true);
  });

  it('should return false for wrong signature', () => {
    const body = makePayloadString();
    const sig = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(false);
  });

  it('should return false for wrong secret', () => {
    const body = makePayloadString();
    const sig = makeSignature(body, 'wrong-secret');
    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(false);
  });

  it('should return false for tampered body', () => {
    const body = makePayloadString();
    const sig = makeSignature(body);
    expect(verifyWebhookSignature(body + 'tampered', sig, TEST_SECRET)).toBe(false);
  });

  it('should return false for empty body', () => {
    expect(verifyWebhookSignature('', 'sha256=abc', TEST_SECRET)).toBe(false);
  });

  it('should return false for empty signature', () => {
    expect(verifyWebhookSignature('body', '', TEST_SECRET)).toBe(false);
  });

  it('should return false for empty secret', () => {
    expect(verifyWebhookSignature('body', 'sha256=abc', '')).toBe(false);
  });

  it('should return false for sha256= with no hex', () => {
    expect(verifyWebhookSignature('body', 'sha256=', TEST_SECRET)).toBe(false);
  });

  it('should return false for non-hex signature', () => {
    expect(verifyWebhookSignature('body', 'sha256=not-hex-at-all!!!', TEST_SECRET)).toBe(false);
  });
});

// ============================================================================
// parseWebhookPayload
// ============================================================================

describe('parseWebhookPayload', () => {
  it('should parse a valid payload', () => {
    const body = makePayloadString();
    const payload = parseWebhookPayload(body);
    expect(payload.source).toBe('prismer_im');
    expect(payload.event).toBe('message.new');
    expect(payload.message.id).toBe('msg-001');
    expect(payload.sender.username).toBe('testuser');
    expect(payload.conversation.type).toBe('direct');
  });

  it('should throw for invalid JSON', () => {
    expect(() => parseWebhookPayload('not json')).toThrow('Invalid JSON');
  });

  it('should throw for non-object JSON', () => {
    expect(() => parseWebhookPayload('"string"')).toThrow('must be a JSON object');
  });

  it('should throw for unknown source', () => {
    const body = JSON.stringify({ ...makePayload(), source: 'unknown' });
    expect(() => parseWebhookPayload(body)).toThrow('Unknown webhook source');
  });

  it('should throw for missing event', () => {
    const data = makePayload();
    (data as any).event = '';
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing event');
  });

  it('should throw for missing message field', () => {
    const data = makePayload();
    delete (data as any).message;
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing required fields');
  });

  it('should throw for missing sender field', () => {
    const data = makePayload();
    delete (data as any).sender;
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing required fields');
  });

  it('should throw for missing conversation field', () => {
    const data = makePayload();
    delete (data as any).conversation;
    expect(() => parseWebhookPayload(JSON.stringify(data))).toThrow('Missing required fields');
  });
});

// ============================================================================
// PrismerWebhook constructor
// ============================================================================

describe('PrismerWebhook', () => {
  it('should throw if secret is empty', () => {
    expect(() => new PrismerWebhook({ secret: '', onMessage: async () => {} })).toThrow(
      'Webhook secret is required',
    );
  });

  it('should create instance with valid options', () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    expect(wh).toBeInstanceOf(PrismerWebhook);
  });
});

// ============================================================================
// PrismerWebhook.verify / .parse
// ============================================================================

describe('PrismerWebhook.verify', () => {
  const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });

  it('should verify valid signature', () => {
    const body = makePayloadString();
    expect(wh.verify(body, makeSignature(body))).toBe(true);
  });

  it('should reject invalid signature', () => {
    const body = makePayloadString();
    expect(wh.verify(body, 'sha256=bad')).toBe(false);
  });
});

describe('PrismerWebhook.parse', () => {
  const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });

  it('should parse valid body', () => {
    const payload = wh.parse(makePayloadString());
    expect(payload.source).toBe('prismer_im');
  });

  it('should throw for invalid body', () => {
    expect(() => wh.parse('invalid')).toThrow();
  });
});

// ============================================================================
// PrismerWebhook.handle (Web Request/Response API)
// ============================================================================

describe('PrismerWebhook.handle', () => {
  it('should return 405 for non-POST', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const req = new Request('http://localhost/webhook', { method: 'GET' });
    const res = await wh.handle(req);
    expect(res.status).toBe(405);
  });

  it('should return 401 for invalid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const body = makePayloadString();
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: { 'x-prismer-signature': 'sha256=bad' },
    });
    const res = await wh.handle(req);
    expect(res.status).toBe(401);
  });

  it('should return 400 for malformed payload', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const body = '{"source": "unknown"}';
    const sig = makeSignature(body);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: { 'x-prismer-signature': sig },
    });
    const res = await wh.handle(req);
    expect(res.status).toBe(400);
  });

  it('should return 200 with ok:true when handler returns void', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: { 'x-prismer-signature': sig },
    });
    const res = await wh.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('should return 200 with reply when handler returns WebhookReply', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async (payload) => ({ content: `Echo: ${payload.message.content}` }),
    });
    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: { 'x-prismer-signature': sig },
    });
    const res = await wh.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe('Echo: Hello from test');
  });

  it('should return 500 when handler throws', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => {
        throw new Error('Something broke');
      },
    });
    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: { 'x-prismer-signature': sig },
    });
    const res = await wh.handle(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Something broke');
  });

  it('should pass the full payload to handler', async () => {
    let received: WebhookPayload | null = null;
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async (payload) => {
        received = payload;
      },
    });
    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body,
      headers: { 'x-prismer-signature': sig },
    });
    await wh.handle(req);
    expect(received).not.toBeNull();
    expect(received!.message.content).toBe('Hello from test');
    expect(received!.sender.role).toBe('human');
    expect(received!.conversation.id).toBe('conv-001');
  });
});

// ============================================================================
// PrismerWebhook.express
// ============================================================================

describe('PrismerWebhook.express', () => {
  it('should return 401 for invalid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const middleware = wh.express();

    const body = makePayloadString();
    const req = {
      body: Buffer.from(body),
      headers: { 'x-prismer-signature': 'sha256=bad' },
    };
    const res = {
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

    await middleware(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.responseData.error).toBe('Invalid signature');
  });

  it('should return 200 for valid request with Buffer body', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const middleware = wh.express();

    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = {
      body: Buffer.from(body),
      headers: { 'x-prismer-signature': sig },
    };
    const res = {
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

    await middleware(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.responseData.ok).toBe(true);
  });

  it('should handle string body', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const middleware = wh.express();

    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = {
      body: body,
      headers: { 'x-prismer-signature': sig },
    };
    const res = {
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

    await middleware(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('should return reply from handler', async () => {
    const wh = new PrismerWebhook({
      secret: TEST_SECRET,
      onMessage: async () => ({ content: 'Reply!', type: 'markdown' as const }),
    });
    const middleware = wh.express();

    const body = makePayloadString();
    const sig = makeSignature(body);
    const req = {
      body: Buffer.from(body),
      headers: { 'x-prismer-signature': sig },
    };
    const res = {
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

    await middleware(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.responseData.content).toBe('Reply!');
    expect(res.responseData.type).toBe('markdown');
  });
});

// ============================================================================
// PrismerWebhook.hono
// ============================================================================

describe('PrismerWebhook.hono', () => {
  it('should return 401 for invalid signature', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const handler = wh.hono();

    const body = makePayloadString();
    let result: any;
    const c = {
      req: {
        async text() { return body; },
        header(name: string) { return name === 'x-prismer-signature' ? 'sha256=bad' : ''; },
      },
      json(data: any, status: number) {
        result = { data, status };
        return result;
      },
    };

    await handler(c);
    expect(result.status).toBe(401);
  });

  it('should return 200 for valid request', async () => {
    const wh = new PrismerWebhook({ secret: TEST_SECRET, onMessage: async () => {} });
    const handler = wh.hono();

    const body = makePayloadString();
    const sig = makeSignature(body);
    let result: any;
    const c = {
      req: {
        async text() { return body; },
        header(name: string) { return name === 'x-prismer-signature' ? sig : ''; },
      },
      json(data: any, status: number) {
        result = { data, status };
        return result;
      },
    };

    await handler(c);
    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(true);
  });
});

/**
 * Prismer IM Webhook Handler
 *
 * Receives, verifies, and parses webhook payloads from Prismer IM server.
 * Provides framework adapters for Express and Hono.
 *
 * @example
 * ```typescript
 * import { PrismerWebhook } from '@prismer/sdk/webhook';
 *
 * const webhook = new PrismerWebhook({
 *   secret: process.env.WEBHOOK_SECRET!,
 *   onMessage: async (payload) => {
 *     console.log(`[${payload.sender.displayName}]: ${payload.message.content}`);
 *     return { content: 'Got it!' };
 *   },
 * });
 *
 * // Express
 * app.post('/webhook', webhook.express());
 *
 * // Hono
 * app.post('/webhook', webhook.hono());
 *
 * // Raw fetch/Request API
 * const response = await webhook.handle(request);
 * ```
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

/** Prismer IM webhook payload (POST to agent endpoint) */
export interface WebhookPayload {
  source: 'prismer_im';
  event: 'message.new';
  timestamp: number;
  message: WebhookMessage;
  sender: WebhookSender;
  conversation: WebhookConversation;
}

export interface WebhookMessage {
  id: string;
  type: string;
  content: string;
  senderId: string;
  conversationId: string;
  parentId: string | null;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface WebhookSender {
  id: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent';
}

export interface WebhookConversation {
  id: string;
  type: 'direct' | 'group';
  title: string | null;
}

export interface WebhookReply {
  content: string;
  type?: 'text' | 'markdown' | 'code';
}

export interface WebhookHandlerOptions {
  /** HMAC-SHA256 secret for verifying webhook signatures */
  secret: string;
  /** Called when a verified webhook payload is received */
  onMessage: (payload: WebhookPayload) => Promise<WebhookReply | void>;
}

// ============================================================================
// Standalone Functions
// ============================================================================

/**
 * Verify a Prismer IM webhook signature using HMAC-SHA256.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  if (!body || !signature || !secret) return false;

  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!sig) return false;

  const expected = createHmac('sha256', secret).update(body).digest('hex');

  // Timing-safe comparison
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Parse a raw webhook body into a typed WebhookPayload.
 * Throws if the body is not valid JSON or missing required fields.
 */
export function parseWebhookPayload(body: string): WebhookPayload {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON in webhook body');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Webhook body must be a JSON object');
  }
  if (parsed.source !== 'prismer_im') {
    throw new Error(`Unknown webhook source: ${parsed.source}`);
  }
  if (!parsed.event) {
    throw new Error('Missing event field in webhook payload');
  }
  if (!parsed.message || !parsed.sender || !parsed.conversation) {
    throw new Error('Missing required fields in webhook payload (message, sender, conversation)');
  }

  return parsed as WebhookPayload;
}

// ============================================================================
// PrismerWebhook Class
// ============================================================================

export class PrismerWebhook {
  private readonly secret: string;
  private readonly onMessage: (payload: WebhookPayload) => Promise<WebhookReply | void>;

  constructor(options: WebhookHandlerOptions) {
    if (!options.secret) {
      throw new Error('Webhook secret is required');
    }
    this.secret = options.secret;
    this.onMessage = options.onMessage;
  }

  /** Verify an HMAC-SHA256 signature */
  verify(body: string, signature: string): boolean {
    return verifyWebhookSignature(body, signature, this.secret);
  }

  /** Parse raw body into a typed WebhookPayload */
  parse(body: string): WebhookPayload {
    return parseWebhookPayload(body);
  }

  /**
   * Process a webhook request (verify + parse + call handler).
   * Works with the standard Web Request/Response API.
   */
  async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.text();
    const signature = request.headers.get('x-prismer-signature') || '';

    if (!this.verify(body, signature)) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let payload: WebhookPayload;
    try {
      payload = this.parse(body);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid payload' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    try {
      const reply = await this.onMessage(payload);
      if (reply) {
        return new Response(JSON.stringify(reply), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : 'Handler error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  /**
   * Express middleware adapter.
   * Expects `express.raw({ type: 'application/json' })` or a raw body parser
   * so that `req.body` is a Buffer.
   *
   * @example
   * ```typescript
   * app.post('/webhook', express.raw({ type: 'application/json' }), webhook.express());
   * ```
   */
  express(): (req: any, res: any, next?: any) => void {
    return async (req: any, res: any) => {
      try {
        const body: string =
          typeof req.body === 'string'
            ? req.body
            : Buffer.isBuffer(req.body)
              ? req.body.toString('utf-8')
              : JSON.stringify(req.body);

        const signature: string = req.headers['x-prismer-signature'] || '';

        if (!this.verify(body, signature)) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }

        let payload: WebhookPayload;
        try {
          payload = this.parse(body);
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid payload' });
          return;
        }

        const reply = await this.onMessage(payload);
        if (reply) {
          res.status(200).json(reply);
        } else {
          res.status(200).json({ ok: true });
        }
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Handler error' });
      }
    };
  }

  /**
   * Hono middleware adapter.
   *
   * @example
   * ```typescript
   * app.post('/webhook', webhook.hono());
   * ```
   */
  hono(): (c: any) => Promise<any> {
    return async (c: any) => {
      const body = await c.req.text();
      const signature = c.req.header('x-prismer-signature') || '';

      if (!this.verify(body, signature)) {
        return c.json({ error: 'Invalid signature' }, 401);
      }

      let payload: WebhookPayload;
      try {
        payload = this.parse(body);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid payload' }, 400);
      }

      try {
        const reply = await this.onMessage(payload);
        if (reply) {
          return c.json(reply, 200);
        }
        return c.json({ ok: true }, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Handler error' }, 500);
      }
    };
  }
}

/**
 * Prismer IM — Webhook dispatch service
 *
 * Pushes message events to agent HTTP endpoints (fire-and-forget).
 * Compatible with OpenClaw's POST /hooks/<name> webhook receiver.
 */

import { createHmac } from 'crypto';
import type Redis from 'ioredis';
import prisma from '../db';
import { config } from '../config';
import type { WebhookPayload } from '../types/index';
import { safeJsonParse } from '../utils/safe-json';

export class WebhookService {
  constructor(private redis: Redis) {}

  /**
   * Dispatch webhook for a newly created message.
   * Finds all agent participants with an endpoint in the conversation,
   * excludes the sender, and POSTs the event payload to each.
   */
  async dispatch(
    message: {
      id: string;
      conversationId: string;
      senderId: string;
      type: string;
      content: string;
      metadata: string;
      parentId: string | null;
      createdAt: Date;
    },
    senderId: string,
    conversationId: string,
  ): Promise<void> {
    // Find all participants with their user + agent card
    const participants = await prisma.iMParticipant.findMany({
      where: {
        conversationId,
        leftAt: null,
      },
      include: {
        imUser: {
          include: { agentCard: true },
        },
      },
    });

    // Filter: agents with endpoint, excluding the sender
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targets = participants.filter((p: any) =>
      p.imUser.role === 'agent' &&
      p.imUser.agentCard?.endpoint &&
      p.imUserId !== senderId
    );

    if (targets.length === 0) return;

    // Look up sender info
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sender = participants.find((p: any) => p.imUserId === senderId)?.imUser;
    if (!sender) return;

    // Look up conversation info
    const conversation = await prisma.iMConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, type: true, title: true },
    });
    if (!conversation) return;

    // Parse message metadata safely
    const metadata = safeJsonParse<Record<string, unknown>>(message.metadata as string | Record<string, unknown>, {});

    // Build payload
    const payload: WebhookPayload = {
      source: 'prismer_im',
      event: 'message.new',
      timestamp: Date.now(),
      message: {
        id: message.id,
        type: message.type,
        content: message.content,
        senderId: message.senderId,
        conversationId: message.conversationId,
        parentId: message.parentId,
        metadata,
        createdAt: message.createdAt.toISOString(),
      },
      sender: {
        id: sender.id,
        username: sender.username,
        displayName: sender.displayName,
        role: sender.role,
      },
      conversation: {
        id: conversation.id,
        type: conversation.type,
        title: conversation.title,
      },
    };

    console.log(`[Webhook] Dispatching to ${targets.length} agent endpoint(s) for message ${message.id}`);

    // Fire-and-forget to each agent endpoint
    for (const target of targets) {
      const endpoint = target.imUser.agentCard!.endpoint!;
      const secret = this.resolveSecret(target.imUser.agentCard!.metadata);

      // Don't await — fire-and-forget
      this.deliver(endpoint, payload, secret).catch((err) => {
        console.error(`[Webhook] Delivery failed for ${endpoint}:`, (err as Error).message);
      });
    }
  }

  /**
   * POST payload to URL with HMAC signature and retry.
   */
  private isBlockedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return true;
      const host = parsed.hostname.toLowerCase();
      return (
        host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ||
        host.startsWith('10.') || host.startsWith('172.') || host.startsWith('192.168.') ||
        host.startsWith('169.254.') || host.endsWith('.internal') || host.endsWith('.local')
      );
    } catch {
      return true;
    }
  }

  private async deliver(
    url: string,
    payload: WebhookPayload,
    secret: string,
    attempt: number = 1,
  ): Promise<void> {
    if (this.isBlockedUrl(url)) {
      console.warn(`[Webhook] Blocked delivery to private/internal URL: ${url}`);
      return;
    }

    const body = JSON.stringify(payload);
    const signature = this.sign(body, secret);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Prismer-Signature': `sha256=${signature}`,
          'X-Prismer-Event': payload.event,
          'User-Agent': 'Prismer-IM/0.3.0',
        },
        body,
        signal: AbortSignal.timeout(config.webhook.timeoutMs),
      });

      if (response.ok) {
        console.log(`[Webhook] POST ${url} → ${response.status}`);
        return;
      }

      // Non-2xx response — retry if attempts remain
      if (attempt < config.webhook.maxRetries) {
        const delay = attempt === 1 ? 2000 : 5000;
        console.warn(`[Webhook] POST ${url} → ${response.status}, retry ${attempt + 1} in ${delay}ms`);
        await this.delay(delay);
        return this.deliver(url, payload, secret, attempt + 1);
      }

      console.error(`[Webhook] POST ${url} → ${response.status} after ${attempt} attempts`);
    } catch (err) {
      if (attempt < config.webhook.maxRetries) {
        const delay = attempt === 1 ? 2000 : 5000;
        console.warn(`[Webhook] POST ${url} error: ${(err as Error).message}, retry ${attempt + 1} in ${delay}ms`);
        await this.delay(delay);
        return this.deliver(url, payload, secret, attempt + 1);
      }

      console.error(`[Webhook] POST ${url} failed after ${attempt} attempts:`, (err as Error).message);
    }
  }

  /**
   * HMAC-SHA256 signature of the payload body.
   */
  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  /**
   * Resolve webhook secret: per-agent metadata.webhookSecret → global config fallback.
   */
  private resolveSecret(metadata: string | null | undefined): string {
    const parsed = safeJsonParse<Record<string, unknown>>(metadata, {});
    if (parsed.webhookSecret) return parsed.webhookSecret as string;
    return config.webhook.secret;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

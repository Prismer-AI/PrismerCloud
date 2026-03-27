/**
 * Prismer IM — Message service
 *
 * Enhanced with @mention parsing and routing support.
 */

import type Redis from 'ioredis';
import { MessageModel, type MessageQuery } from '../models/message';
import { ConversationModel } from '../models/conversation';
import { ParticipantModel } from '../models/participant';
import { MentionService, type RoutingDecision } from './mention.service';
import { ResponseCoordinatorService } from './response-coordinator.service';
import type { WebhookService } from './webhook.service';
import type { SyncService } from './sync.service';
import type { ContextAccessService } from './context-access.service';
import type { MessageType, MessageMetadata } from '../types/index';
import prisma from '../db';

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  type?: MessageType;
  content: string;
  metadata?: MessageMetadata;
  parentId?: string;
  // E2E Signing fields (Layer 2)
  secVersion?: number;
  senderKeyId?: string;
  sequence?: number;
  contentHash?: string;
  prevHash?: string;
  signature?: string;
}

export interface SendMessageResult {
  message: Awaited<ReturnType<MessageModel['create']>>;
  routing?: RoutingDecision;
}

export class MessageService {
  private messageModel: MessageModel;
  private conversationModel: ConversationModel;
  private participantModel: ParticipantModel;
  private mentionService: MentionService;
  private responseCoordinator: ResponseCoordinatorService;
  private webhookService?: WebhookService;
  private syncService?: SyncService;
  private contextAccessService?: ContextAccessService;

  constructor(
    private redis: Redis,
    webhookService?: WebhookService,
    syncService?: SyncService,
    contextAccessService?: ContextAccessService,
  ) {
    this.messageModel = new MessageModel();
    this.conversationModel = new ConversationModel();
    this.participantModel = new ParticipantModel();
    this.mentionService = new MentionService();
    this.responseCoordinator = new ResponseCoordinatorService(redis);
    this.webhookService = webhookService;
    this.syncService = syncService;
    this.contextAccessService = contextAccessService;
  }

  /**
   * Send a message with automatic @mention parsing and routing.
   */
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    // Idempotency check (for offline SDK retries)
    const idemKey = (input.metadata as any)?._idempotencyKey as string | undefined;
    if (idemKey) {
      const existing = await this.findByIdempotencyKey(input.conversationId, idemKey);
      if (existing) {
        return { message: existing };
      }
    }

    // Verify sender is participant
    const isParticipant = await this.participantModel.isParticipant(input.conversationId, input.senderId);
    if (!isParticipant) {
      throw new Error('User is not a participant in this conversation');
    }

    // Validate file messages — must reference a confirmed upload
    if (input.type === 'file') {
      await this.validateFileMessage(input);
    }

    // Encryption mode enforcement (Layer 5 server-side)
    // If the conversation requires encryption, reject plaintext messages.
    // system_event messages are exempt (infrastructure messages, not user content).
    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId: input.conversationId },
    });
    if (security?.encryptionMode === 'required') {
      const isEncrypted = input.metadata?.encrypted === true || input.type === 'system_event';
      if (!isEncrypted) {
        throw new Error(
          'This conversation requires encrypted messages. ' +
            'Set metadata.encrypted=true with AES-256-GCM ciphertext in content.',
        );
      }
    }

    // Encrypted message validation (P2.3)
    if (input.metadata?.encrypted === true) {
      // Validate content looks like ciphertext (Base64, minimum length)
      if (
        !input.content ||
        input.content.length < 32 ||
        !/^[A-Za-z0-9+/=\s]+$/.test(input.content.replace(/\s/g, ''))
      ) {
        throw new Error('Encrypted message content must be valid Base64 ciphertext (min 32 chars)');
      }
      // Validate context refs from metadata header (server can't read encrypted content)
      if (this.contextAccessService && Array.isArray(input.metadata?.contextRefs)) {
        const access = await this.contextAccessService.validateAccess(
          input.senderId,
          input.metadata.contextRefs as string[],
        );
        if (!access.allowed) {
          throw new Error(`Context access denied: ${access.deniedRefs.join(', ')}`);
        }
      }
    }

    // Context access control (Layer 3)
    // Only validate cleartext messages — encrypted messages have refs in header/metadata
    // and are opaque to the server. system_event messages are infrastructure, skip them.
    if (this.contextAccessService && input.type !== 'system_event' && !input.metadata?.encrypted) {
      const refs = this.contextAccessService.extractContextRefs(input.content, input.metadata as Record<string, any>);
      if (refs.length > 0) {
        const access = await this.contextAccessService.validateAccess(input.senderId, refs);
        if (!access.allowed) {
          throw new Error(
            `Context access denied: ${access.deniedRefs.join(', ')}. You do not have access to these private context URIs.`,
          );
        }
      }
    }

    // Parse @mentions and determine routing
    const routing = await this.mentionService.determineRouting(input.content, input.conversationId, input.senderId);

    // Add mention info to metadata
    const enhancedMetadata: MessageMetadata = {
      ...input.metadata,
      mentions:
        routing.originalMentions.length > 0
          ? routing.originalMentions.map((m) => ({
              raw: m.raw,
              username: m.username,
              userId: m.userId,
            }))
          : undefined,
      routingMode: routing.mode !== 'none' ? routing.mode : undefined,
      routeTargets: routing.targets.length > 0 ? routing.targets.map((t) => t.userId) : undefined,
    };

    // Create message
    const msg = await this.messageModel.create({
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type ?? 'text',
      content: input.content,
      metadata: enhancedMetadata,
      parentId: input.parentId,
      // E2E Signing fields (pass through if present)
      secVersion: input.secVersion,
      senderKeyId: input.senderKeyId,
      sequence: input.sequence,
      contentHash: input.contentHash,
      prevHash: input.prevHash,
      signature: input.signature,
    });

    // Update conversation last_message_at
    await this.conversationModel.touchLastMessage(input.conversationId);

    // Dispatch webhooks to agent endpoints (fire-and-forget)
    if (this.webhookService) {
      this.webhookService
        .dispatch(msg, input.senderId, input.conversationId)
        .catch((err) => console.warn('[MessageService] Webhook dispatch error:', (err as Error).message));
    }

    // Publish to Redis for multi-instance support (optional in dev)
    try {
      await this.redis.publish(
        `im:conversation:${input.conversationId}:messages`,
        JSON.stringify({
          event: 'message.new',
          data: msg,
          routing: routing.mode !== 'none' ? routing : undefined,
        }),
      );
    } catch (err) {
      console.warn('[MessageService] Redis publish failed (dev mode):', (err as Error).message);
    }

    // Write sync event for offline clients
    if (this.syncService) {
      this.syncService
        .writeEvent(
          'message.new',
          {
            id: msg.id,
            conversationId: msg.conversationId,
            senderId: msg.senderId,
            type: msg.type,
            content: msg.content,
            metadata: msg.metadata,
            parentId: msg.parentId,
            createdAt: (msg.createdAt as Date).toISOString(),
          },
          msg.conversationId,
          msg.senderId,
        )
        .catch((err) => console.warn('[MessageService] Sync event write failed:', (err as Error).message));
    }

    return { message: msg, routing: routing.mode !== 'none' ? routing : undefined };
  }

  /**
   * Legacy send method that returns just the message (for backwards compatibility).
   */
  async sendSimple(input: SendMessageInput) {
    const result = await this.send(input);
    return result.message;
  }

  /**
   * Try to acquire response lock for a message.
   * Call this before an agent starts responding.
   */
  async tryAcquireResponseLock(messageId: string, agentId: string) {
    return this.responseCoordinator.tryAcquireLock(messageId, agentId);
  }

  /**
   * Release response lock after agent finishes responding.
   */
  async releaseResponseLock(messageId: string, agentId: string) {
    return this.responseCoordinator.releaseLock(messageId, agentId);
  }

  /**
   * Check if a message is being handled by an agent.
   */
  async isMessageLocked(messageId: string) {
    return this.responseCoordinator.isLocked(messageId);
  }

  /**
   * Extend response lock for long-running operations.
   */
  async extendResponseLock(messageId: string, agentId: string, ttlMs?: number) {
    return this.responseCoordinator.extendLock(messageId, agentId, ttlMs);
  }

  /**
   * Get the MentionService for direct access.
   */
  getMentionService() {
    return this.mentionService;
  }

  /**
   * Get the ResponseCoordinator for direct access.
   */
  getResponseCoordinator() {
    return this.responseCoordinator;
  }

  async getHistory(query: MessageQuery) {
    return this.messageModel.list(query);
  }

  async getById(id: string) {
    return this.messageModel.findById(id);
  }

  async update(id: string, data: { content?: string; metadata?: Record<string, unknown> }) {
    const updated = await this.messageModel.update(id, data);
    if (this.syncService && updated) {
      const meta = updated.metadata
        ? typeof updated.metadata === 'string'
          ? JSON.parse(updated.metadata)
          : updated.metadata
        : undefined;
      this.syncService
        .writeEvent(
          'message.edit',
          {
            id: updated.id,
            content: updated.content,
            type: updated.type,
            metadata: meta,
          },
          updated.conversationId,
          updated.senderId,
        )
        .catch(() => {});
    }
    return updated;
  }

  async delete(id: string) {
    const deleted = await this.messageModel.delete(id);
    if (this.syncService) {
      this.syncService
        .writeEvent(
          'message.delete',
          {
            id: deleted.id,
          },
          deleted.conversationId,
          deleted.senderId,
        )
        .catch(() => {});
    }
    return deleted;
  }

  async getCount(conversationId: string) {
    return this.messageModel.countInConversation(conversationId);
  }

  /**
   * Find a message by idempotency key (for deduplication).
   * Searches recent messages (last 24h) in the given conversation.
   */
  async findByIdempotencyKey(conversationId: string, key: string): Promise<any | null> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const results = await prisma.iMMessage.findMany({
      where: {
        conversationId,
        metadata: { contains: key },
        createdAt: { gte: cutoff },
      },
      take: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Validate a file message references a confirmed upload with matching CDN URL.
   * Prevents fabricated file URLs from being sent.
   */
  private async validateFileMessage(input: SendMessageInput): Promise<void> {
    const metadata = input.metadata;
    if (!metadata?.uploadId || typeof metadata.uploadId !== 'string') {
      throw new Error('File message requires metadata.uploadId');
    }
    if (!metadata.fileUrl || typeof metadata.fileUrl !== 'string') {
      throw new Error('File message requires metadata.fileUrl');
    }

    const upload = await prisma.iMFileUpload.findUnique({
      where: { uploadId: metadata.uploadId },
    });

    if (!upload) {
      throw new Error('Upload not found');
    }
    if (upload.status !== 'confirmed') {
      throw new Error('Upload is not confirmed');
    }
    if (upload.imUserId !== input.senderId) {
      throw new Error('Upload does not belong to sender');
    }
    if (upload.cdnUrl !== metadata.fileUrl) {
      throw new Error('File URL does not match confirmed upload');
    }
  }
}

/**
 * Prismer IM — Message service
 *
 * Enhanced with @mention parsing and routing support.
 */

import type Redis from 'ioredis';
import { MessageModel, type MessageQuery } from '../models/message';
import { ConversationModel } from '../models/conversation';
import { ParticipantModel } from '../models/participant';
import { MentionService, type RouteTarget, type RoutingDecision } from './mention.service';
import { ResponseCoordinatorService } from './response-coordinator.service';
import type { WebhookService } from './webhook.service';
import type { SyncService } from './sync.service';
import type { ContextAccessService } from './context-access.service';
import type { MessageType, MessageMetadata, TaskDispatchContextEntry } from '../types/index';
import type { SigningService } from './signing.service';
import type { TaskService } from './task.service';
import type { IMMessage } from '@prisma/client';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('MessageService');

// ─── @-mention task dispatch defaults (v1.9.x) ───────────────
//
// Bound the chat-history snippet that rides along with `task.dispatch.request`
// so prompts don't blow past LLM context windows. The hard cap on `taskInput`
// JSON is set elsewhere; these are the upstream "be reasonable" defaults.
//
// Per [11-multi-agent-collab.md §五]:
// - 20 messages is enough for short-horizon coordination (PM ↔ Engineer
//   handoffs); longer history goes through memory recall, not context push.
// - 8000 chars ≈ 2-3K tokens; leaves room for the agent's system prompt.
const TASK_CONTEXT_DEFAULTS = {
  contextWindow: 20,
  contextMaxChars: 8000,
} as const;

// ─── Agent ↔ agent hop cap ────────────────────────────────────
//
// Multi-agent conversations are allowed (an agent reply may @-mention
// another agent and trigger a downstream dispatch), but we bound the
// chain to `MAX_AGENT_HOPS` hops to prevent LLM-hallucinated mention
// loops from chewing through credits indefinitely. Each task_run we
// dispatch in response to a mention carries `metadata.hopCount`; the
// agent's reply (sent back as `kind: 'agent_reply'`) is expected to
// stamp the same hopCount onto its message metadata so the next
// mention-dispatch decision can compare against the cap.
//
// A hop is "agent A replies → agent B is dispatched", so 5 hops lets
// roughly five-step agent chains complete naturally while still
// catching obvious loops on the next bounce.
export const MAX_AGENT_HOPS = 5;

function readNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  type?: MessageType;
  content: string;
  metadata?: MessageMetadata;
  parentId?: string;
  quotedMessageId?: string; // v1.8.2: Quote reply (distinct from parentId threading)
  // E2E Signing fields (Layer 2)
  secVersion?: number;
  senderKeyId?: string;
  sequence?: number;
  contentHash?: string;
  prevHash?: string;
  signature?: string;
  // AIP DID fields (v1.8.0 S2)
  senderDid?: string;
  delegationProof?: string;
  signedAt?: number;
  // Set to true when the caller (API route) has already verified the signature,
  // so messageService skips redundant re-verification.
  _signatureVerified?: boolean;
}

export interface SendMessageResult {
  message: Awaited<ReturnType<MessageModel['create']>>;
  routing?: RoutingDecision;
  directAgentTarget?: RouteTarget;
  keyRotationAdvised?: string;
}

export interface SearchMessagesInput {
  conversationId: string;
  query: string;
  before?: string;
  limit?: number;
}

export interface SearchMessageResult {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  metadata: string;
  parentId: string | null;
  quotedMessageId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  snippet: string;
  matchRanges: Array<{ start: number; end: number }>;
}

export interface SearchMessagesResult {
  messages: SearchMessageResult[];
  total: number;
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
  private signingService?: SigningService;
  /**
   * Optional task service for v1.9.x mention-driven dispatch. Wired by the
   * IM bootstrap (server.ts) after both services are constructed — circular
   * dep avoidance, since TaskService already depends on MessageService.
   */
  private taskService?: TaskService;

  constructor(
    private redis: Redis,
    webhookService?: WebhookService,
    syncService?: SyncService,
    contextAccessService?: ContextAccessService,
    signingService?: SigningService,
  ) {
    this.messageModel = new MessageModel();
    this.conversationModel = new ConversationModel();
    this.participantModel = new ParticipantModel();
    this.mentionService = new MentionService();
    this.responseCoordinator = new ResponseCoordinatorService(redis);
    this.webhookService = webhookService;
    this.syncService = syncService;
    this.contextAccessService = contextAccessService;
    this.signingService = signingService;
  }

  /**
   * Wire the TaskService for v1.9.x @-mention dispatch. Idempotent.
   * MUST be called by bootstrap (server.ts) after both services exist;
   * without it, mention dispatch silently skips (test envs typically
   * don't bother wiring this).
   */
  setTaskService(taskService: TaskService): void {
    this.taskService = taskService;
  }

  /**
   * Send a message with automatic @mention parsing and routing.
   */
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    // v1.8.2: Cap metadata payload size. MySQL `metadata` is @db.Text (64KB);
    // 16KB leaves room for indices/overhead and prevents waveform/transcription
    // floods from blowing up the column.
    if (input.metadata) {
      const metaSize = Buffer.byteLength(JSON.stringify(input.metadata), 'utf8');
      if (metaSize > 16384) {
        throw new Error(`metadata too large: ${metaSize} bytes (max 16384)`);
      }
    }

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

    // P9: Block check — only for direct conversations
    const conv = await prisma.iMConversation.findUnique({
      where: { id: input.conversationId },
      select: { type: true },
    });
    let directAgentTarget: RouteTarget | null = null;
    if (conv?.type === 'direct') {
      const participants = await prisma.iMParticipant.findMany({
        where: { conversationId: input.conversationId },
        include: { imUser: true },
      });
      const otherUserId = participants.find((p: any) => p.imUserId !== input.senderId)?.imUserId;
      if (otherUserId) {
        const { ContactService } = await import('./contact.service');
        const contactSvc = new ContactService();
        const blocked = await contactSvc.isBlockedForMessaging(input.senderId, otherUserId);
        if (blocked) {
          throw Object.assign(new Error('You are blocked by this user'), { status: 403, code: 'BLOCKED' });
        }
      }
      const other = participants.find((p: any) => p.imUserId !== input.senderId)?.imUser;
      const sender = participants.find((p: any) => p.imUserId === input.senderId)?.imUser;
      if (other?.role === 'agent' && sender?.role !== 'agent') {
        directAgentTarget = {
          userId: other.id,
          username: other.username,
          displayName: other.displayName,
          role: other.role,
          agentType: other.agentType ?? undefined,
        };
      }
    }

    // Validate file messages — must reference a confirmed upload
    if (input.type === 'file') {
      await this.validateFileMessage(input);
    }

    // Encryption mode enforcement (Layer 5 server-side)
    // If the conversation requires encryption, reject plaintext messages.
    // Infrastructure types (system_event, system) are exempt — they're not
    // user content (member_join notices, task completion notifications, etc.).
    const isInfrastructureType = input.type === 'system_event' || input.type === 'system';
    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId: input.conversationId },
    });
    if (security?.encryptionMode === 'required') {
      const isEncrypted = input.metadata?.encrypted === true || isInfrastructureType;
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
    // and are opaque to the server. Infrastructure types (system_event, system) skip.
    if (this.contextAccessService && !isInfrastructureType && !input.metadata?.encrypted) {
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

    // v1.8.0 S2: Signature verification + signing policy enforcement
    // Skip re-verification if the caller (API route) has already verified the signature.
    if (this.signingService && input.signature && !input._signatureVerified) {
      // Lite mode: SDK sends signedAt timestamp (used in payload instead of server time)
      const signedAt = (input.metadata as any)?.signedAt ?? (input as any).signedAt ?? Date.now();
      const verifyResult = await this.signingService.verifyMessage({
        senderId: input.senderId,
        conversationId: input.conversationId,
        type: input.type ?? 'text',
        content: input.content,
        createdAt: signedAt,
        secVersion: input.secVersion ?? 1,
        senderKeyId: input.senderKeyId ?? '',
        senderDid: input.senderDid,
        delegationProof: input.delegationProof,
        sequence: input.sequence ?? 0,
        contentHash: input.contentHash ?? '',
        prevHash: input.prevHash ?? null,
        signature: input.signature,
      });
      if (!verifyResult.valid) {
        const err = new Error(`Signature verification failed: ${verifyResult.reason}`) as any;
        err.code = 'SIGNATURE_INVALID';
        err.status = 400;
        throw err;
      }
    } else if (this.signingService && !input.signature) {
      // Enforce signing policy for unsigned messages.
      // Infrastructure types (system_event, system) are exempt — task completion
      // notifications etc. are emitted by the cloud and are not signed.
      const policy = security?.signingPolicy ?? 'recommended';
      if (policy === 'required' && !isInfrastructureType) {
        const err = new Error('This conversation requires signed messages') as any;
        err.code = 'SIGNATURE_REQUIRED';
        err.status = 400;
        throw err;
      }
      if (policy === 'recommended' && !isInfrastructureType) {
        console.warn(
          `[MessageService] Unsigned message in recommended-signing conv ${input.conversationId} from ${input.senderId}`,
        );
      }
    }

    // Parse @mentions and determine routing. Pass input.metadata so the
    // service can honor structured mentions (produced by the
    // `prismer.agent.send` MCP tool / UI mention picker) over text-regex
    // parsing — see R4 in the agent-collab redesign.
    const routing = await this.mentionService.determineRouting(
      input.content,
      input.conversationId,
      input.senderId,
      input.metadata,
    );

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
      quotedMessageId: input.quotedMessageId,
      // E2E Signing fields (pass through if present)
      secVersion: input.secVersion,
      senderKeyId: input.senderKeyId,
      sequence: input.sequence,
      contentHash: input.contentHash,
      prevHash: input.prevHash,
      signature: input.signature,
      // AIP DID fields (v1.8.0 S2)
      senderDid: input.senderDid,
      delegationProof: input.delegationProof,
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

    // v1.9.x @-mention task dispatch — fire-and-forget so message.send latency
    // doesn't pay for each agent's profile lookup. Skips when:
    //   - message is system_event
    //   - taskService not wired (test env)
    //
    // Agent → agent dispatch via explicit @-mention is allowed up to
    // MAX_AGENT_HOPS hops. The incoming message's metadata.hopCount tells us
    // how many hops the current chain has already taken; if we're at the cap
    // we silently stop (no error — just don't dispatch the next hop, the
    // reply still lands in the conversation).
    //
    // The direct-DM `else if` branch keeps `!isAgentReply` — auto-DM between
    // two agents (no explicit mention, sender is human, target is the other
    // direct participant) is a different feature and should not be triggered
    // by an `agent_reply` callback.
    const metaKind = (input.metadata as { kind?: unknown } | undefined)?.kind;
    const isAgentReply = metaKind === 'agent_reply';
    const incomingHop = readNumber((input.metadata as { hopCount?: unknown } | undefined)?.hopCount, 0);
    const hopExceeded = isAgentReply && incomingHop >= MAX_AGENT_HOPS;

    if (hopExceeded) {
      console.log(
        `[MessageService] hop cap (${MAX_AGENT_HOPS}) reached for conversation ${input.conversationId} — silent stop`,
      );
    }

    // `conv.type` was fetched above (line ~194) for the DM block-check and is
    // re-used here to stamp the dispatched task_run so the daemon's prompt
    // builder knows the channel mode. See the block comment above
    // dispatchToMentionedAgents for the DM/Group dispatch split.
    const conversationType: 'direct' | 'group' | undefined =
      conv?.type === 'direct' || conv?.type === 'group' ? conv.type : undefined;

    if (
      this.taskService &&
      !isInfrastructureType &&
      routing.mode === 'explicit' &&
      routing.targets.length > 0 &&
      !hopExceeded
    ) {
      const nextHop = incomingHop + 1;
      this.dispatchToMentionedAgents(msg, routing, nextHop, conversationType).catch((err) =>
        console.warn('[MessageService] mention dispatch error:', (err as Error).message),
      );
    } else if (
      this.taskService &&
      !isInfrastructureType &&
      !isAgentReply &&
      directAgentTarget &&
      routing.mode !== 'explicit'
    ) {
      this.dispatchToAgent(directAgentTarget, msg, 1, conversationType).catch((err) =>
        console.warn('[MessageService] direct-agent dispatch error:', (err as Error).message),
      );
    }

    // AIP: Check key rotation advisory for signed messages (fire-and-forget)
    let keyRotationAdvised: string | undefined;
    if (input.signature || input.senderKeyId) {
      try {
        const { IdentityService } = await import('./identity.service');
        const identityService = new IdentityService();
        const rotationCheck = await identityService.checkKeyRotation(input.senderId);
        if (rotationCheck.needed) {
          keyRotationAdvised = rotationCheck.reason;
        }
      } catch {
        // Non-critical — skip if identity service unavailable
      }
    }

    return {
      message: msg,
      routing: routing.mode !== 'none' ? routing : undefined,
      directAgentTarget: directAgentTarget ?? undefined,
      keyRotationAdvised,
    };
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

  async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResult> {
    const query = input.query.trim();
    if (!query) return { messages: [], total: 0 };

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const searchableTypes = ['text', 'markdown', 'code', 'system_event', 'system', 'tool_result', 'artifact'];
    const beforeMessage = input.before ? await this.messageModel.findById(input.before) : null;
    const where = {
      conversationId: input.conversationId,
      type: { in: searchableTypes },
      content: { contains: query },
      ...(beforeMessage ? { createdAt: { lt: beforeMessage.createdAt } } : {}),
    };

    const [messages, total] = await Promise.all([
      prisma.iMMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.iMMessage.count({ where }),
    ]);

    return {
      messages: messages.map((message: IMMessage) => ({
        ...message,
        snippet: buildMessageSearchSnippet(message.content, query),
        matchRanges: buildMessageSearchMatchRanges(message.content, query),
      })),
      total,
    };
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

  // ═══════════════════════════════════════════════════════════
  // v1.9.x @-mention task dispatch
  //
  // Triggered after a human-sent message containing `@<agentname>` lands.
  // For each mentioned agent that is a participant in the conversation, we
  // create a task with capability='chat', `prompt` = the message content,
  // and `metadata.context` carrying the recent chat history. The task's
  // creation hook in TaskService emits `task.dispatch.request` over WS to
  // the agent's daemon (see [task.service.ts] §emitDaemonDispatchRequest).
  //
  // See [docs/refactor/11-multi-agent-collab.md §三] for the full design.
  // ═══════════════════════════════════════════════════════════

  // DM vs Group dispatch (architectural):
  //   - DM (conversation.type === 'direct'): any non-agent_reply message
  //     auto-dispatches to the other party via dispatchToAgent. Single
  //     hop max (`!isAgentReply` blocks chain) — human is in the loop.
  //   - Group (conversation.type === 'group'): only explicit @-mentions
  //     dispatch via dispatchToMentionedAgents. Chain length bounded by
  //     hopCount (MAX_AGENT_HOPS). Self-mentions filtered upstream in
  //     mention.service.
  // The LLM gets [Channel context] in its prompt so it knows which mode
  // applies to a given turn — see daemon/dispatch.ts appendChannelContext.

  /**
   * Iterate routing.targets and dispatch each agent target. Skips
   * non-agents (humans hit the regular notification path, not task
   * dispatch). `hopCount` is the value to stamp on the dispatched
   * task_run's metadata (and downstream `agent_reply`) — see
   * MAX_AGENT_HOPS at the top of this file.
   *
   * `conversationType` is forwarded onto the task_run metadata so the
   * daemon prompt builder can render the right [Channel context] block
   * for the LLM (see dispatch.ts appendChannelContext).
   */
  private async dispatchToMentionedAgents(
    triggerMessage: Awaited<ReturnType<MessageModel['create']>>,
    routing: RoutingDecision,
    hopCount: number,
    conversationType?: 'direct' | 'group',
  ): Promise<void> {
    if (!this.taskService) return;

    // ─── Sequential @-mention dispatch (v1.9.x) ──────────────────
    //
    // When a single message @-mentions multiple agents (`@A @B 你俩讨论 X`),
    // we used to fan out in parallel. That produced fragmented, mutually
    // unaware replies. Instead, dispatch ONLY to the first agent target;
    // stamp the remaining targets onto `metadata.pendingMentionTargets`
    // so that ws/handler.handleTaskDispatchReply can chain the next
    // agent once A's reply lands (with A's reply as the new trigger).
    //
    // Why on the task_run only (not the agent_reply message): the cursor
    // is an internal sequencing detail, not part of the public message
    // metadata contract. SDK consumers and webhooks should not see it.
    const agentTargets = routing.targets.filter((t) => t.role === 'agent');
    if (agentTargets.length === 0) return;

    const [primary, ...rest] = agentTargets;
    const pendingMentionTargets = rest.map((t) => t.userId);

    try {
      await this.dispatchToAgent(primary, triggerMessage, hopCount, conversationType, pendingMentionTargets);
    } catch (err) {
      const errMsg = (err as Error).message;
      log.error(
        { err, agent: primary.username, triggerMessageId: triggerMessage.id },
        `dispatchToAgent failed for @${primary.username}: ${errMsg}`,
      );
      // Surface the failure into the conversation so the human sees a
      // diagnostic instead of silence. Sender = agent so the message
      // shows under the agent's name; kind=mention_dispatch_failed lets
      // UI / webhooks treat it as a system event.
      //
      // Note: if the primary dispatch fails, we do NOT cascade to the
      // pending targets. The original mention was "all of you discuss X";
      // it's the human's call (after seeing the failure) whether to retry
      // or re-mention. Silent fan-out to B/C without A would change the
      // conversational semantics in a surprising way.
      try {
        await this.messageModel.create({
          conversationId: triggerMessage.conversationId,
          senderId: primary.userId,
          type: 'system_event',
          content: `Failed to dispatch task to @${primary.username}: ${errMsg}`,
          metadata: {
            kind: 'mention_dispatch_failed',
            agentImUserId: primary.userId,
            triggerMessageId: triggerMessage.id,
            errorCode: (err as { code?: string }).code,
          },
        });
      } catch (sysErr) {
        log.error(
          { err: sysErr, agent: primary.username, triggerMessageId: triggerMessage.id },
          `also failed to post mention_dispatch_failed system_event: ${(sysErr as Error).message}`,
        );
      }
    }
  }

  /**
   * Public entry point for the sequential @-mention follow-up dispatch.
   *
   * Called by ws/handler.handleTaskDispatchReply AFTER an agent's reply
   * has been posted to the conversation, when the originating task_run
   * carried a non-empty `metadata.pendingMentionTargets`. The trigger
   * for this dispatch is the just-posted agent_reply message — so the
   * next agent sees the previous agent's response as fresh context.
   *
   * `pendingRest` is the remaining tail (already shifted by one) so the
   * recursion bottoms out naturally when empty.
   *
   * Forwards through the same `dispatchToAgent` path used by single-
   * mention dispatch; hopCount + conversationType propagate unchanged
   * so MAX_AGENT_HOPS still bounds the chain and the daemon prompt
   * builder still gets the right [Channel context] block.
   */
  async dispatchPendingMention(
    triggerMessageId: string,
    targetUser: RouteTarget,
    pendingRest: string[],
    hopCount: number,
    conversationType?: 'direct' | 'group',
  ): Promise<void> {
    if (!this.taskService) return;
    if (targetUser.role !== 'agent') {
      // Edge case: target's role changed between dispatches (e.g. agent
      // demoted to human). Refuse to fan out further — silent no-op is
      // acceptable here: the chain terminates one step early and the
      // conversation still has the prior agents' replies. Log so an
      // operator can trace why the chain "stopped early".
      log.warn(
        { triggerMessageId, targetUserId: targetUser.userId, role: targetUser.role },
        `dispatchPendingMention: target ${targetUser.username} is no longer an agent (role=${targetUser.role}); chain terminates`,
      );
      return;
    }

    const triggerMessage = await this.messageModel.findById(triggerMessageId);
    if (!triggerMessage) {
      log.warn(
        { triggerMessageId, targetUserId: targetUser.userId },
        `dispatchPendingMention: trigger message ${triggerMessageId} not found — chain terminates`,
      );
      return;
    }

    try {
      await this.dispatchToAgent(targetUser, triggerMessage, hopCount, conversationType, pendingRest);
    } catch (err) {
      const errMsg = (err as Error).message;
      log.error(
        { err, agent: targetUser.username, triggerMessageId },
        `dispatchPendingMention failed for @${targetUser.username}: ${errMsg}`,
      );
      try {
        await this.messageModel.create({
          conversationId: triggerMessage.conversationId,
          senderId: targetUser.userId,
          type: 'system_event',
          content: `Failed to dispatch follow-up to @${targetUser.username}: ${errMsg}`,
          metadata: {
            kind: 'mention_dispatch_failed',
            agentImUserId: targetUser.userId,
            triggerMessageId,
            errorCode: (err as { code?: string }).code,
            pendingChain: true,
          },
        });
      } catch (sysErr) {
        log.error(
          { err: sysErr, agent: targetUser.username, triggerMessageId },
          `also failed to post mention_dispatch_failed system_event: ${(sysErr as Error).message}`,
        );
      }
    }
  }

  /**
   * Dispatch a single agent: build context window, resolve default profile,
   * create the task. The TaskService.createTask hook does the WS emission.
   *
   * If the agent has no IMAgentProfile in any workspace, post a system
   * message back to the conversation explaining the misconfiguration —
   * silent failure here would look like the agent simply ignored the user.
   */
  private async dispatchToAgent(
    agent: RouteTarget,
    triggerMessage: Awaited<ReturnType<MessageModel['create']>>,
    hopCount: number,
    conversationType?: 'direct' | 'group',
    /**
     * Remaining sequential @-mention targets (IM user IDs). When non-empty,
     * `ws/handler.handleTaskDispatchReply` will read this from
     * `task_run.metadata.pendingMentionTargets` after this agent replies,
     * shift the first, and dispatch the next via `dispatchPendingMention`.
     * Cursor only — not exposed on the public agent_reply metadata.
     */
    pendingMentionTargets?: string[],
  ): Promise<void> {
    if (!this.taskService) return;

    // Build context window: last N messages, capped at TASK_CONTEXT_DEFAULTS.
    // Skip system_event entries — those are infrastructure noise that
    // shouldn't compete for the agent's prompt budget.
    const recent = await this.messageModel.list({
      conversationId: triggerMessage.conversationId,
      limit: TASK_CONTEXT_DEFAULTS.contextWindow,
    });

    type RecentMessage = (typeof recent)[number];
    const senderIds = Array.from(new Set(recent.map((m: RecentMessage) => m.senderId)));
    const senders = await prisma.iMUser.findMany({
      where: { id: { in: senderIds } },
      select: { id: true, username: true, role: true },
    });
    type SenderInfo = (typeof senders)[number];
    const byId = new Map<string, SenderInfo>(senders.map((s: SenderInfo) => [s.id, s]));

    // Walk chat history. For each message also collect any
    // workspace-asset attachments (Wave-8 W1) so the dispatcher can hand
    // them to the daemon. Two prerequisites for an attachment to count:
    //   1. m.metadata.kind === 'workspace_asset_attachment'
    //   2. m.metadata.assetIds is a non-empty array of strings
    // Anything else is ignored (silent drops would mask UI bugs, but the
    // metadata key is owner-controlled so a stray non-array shouldn't
    // crash dispatch — log loud for the owner to find).
    const allEntries: TaskDispatchContextEntry[] = [];
    const aggregatedAssetIds: string[] = [];
    const seenAssetIds = new Set<string>();
    for (const m of recent) {
      // Infrastructure types are not user content — never feed them back into
      // the agent's prompt context (would loop task notifications back into
      // the LLM and pollute its working memory).
      if (m.type === 'system_event' || m.type === 'system') continue;
      const sender = byId.get(m.senderId);
      if (!sender) continue;
      const attachedAssetIds = extractAttachedAssetIds(m.metadata, m.id);
      for (const id of attachedAssetIds) {
        if (!seenAssetIds.has(id)) {
          seenAssetIds.add(id);
          aggregatedAssetIds.push(id);
        }
      }
      allEntries.push({
        sender: sender.username,
        senderRole: sender.role as TaskDispatchContextEntry['senderRole'],
        content: m.content,
        createdAt: (m.createdAt as Date).toISOString(),
        ...(attachedAssetIds.length > 0 ? { attachedAssetIds } : {}),
      });
    }

    // Trim oldest entries until total under cap. Always keep at least the
    // triggering message (the last entry) so the agent has something to act
    // on even if the cap is set unreasonably low.
    let totalChars = allEntries.reduce((sum, e) => sum + e.content.length, 0);
    let context = allEntries;
    while (totalChars > TASK_CONTEXT_DEFAULTS.contextMaxChars && context.length > 1) {
      const dropped = context[0];
      context = context.slice(1);
      totalChars -= dropped.content.length;
    }

    // Resolve agent's default profile. v1.9.x is 1:1 user ↔ workspace, so we
    // pick the first non-deleted profile for this agent across all workspaces
    // — IMAgentProfile.workspaceId scope-matching is Track A m2's job
    // (im_agent_cards gains workspaceId then), so for now we rely on the
    // 1:1 invariant.
    // Prefer the most-recently-created profile. Cookbooks and the mvp
    // bootstrap scripts create a fresh profile on every container restart
    // (with the current adapter/config), so picking by `createdAt: asc`
    // would pin dispatch to a stale profile from a previous run — exactly
    // what blew up when we swapped ENG from hermes to openclaw mid-session.
    const profile = await prisma.iMAgentProfile.findFirst({
      where: {
        agentImUserId: agent.userId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, workspaceId: true },
    });

    if (!profile) {
      // Surface the misconfiguration to the conversation so the human owner
      // sees it. Sender is the agent itself (role='agent'), so the message
      // appears under the agent's name. Wrapped in try/catch — a failure
      // here shouldn't break the original message send.
      try {
        await this.messageModel.create({
          conversationId: triggerMessage.conversationId,
          senderId: agent.userId,
          type: 'system_event',
          content: `Agent @${agent.username} has no AgentProfile configured. Owner: run \`prismer profile create --agent ${agent.userId}\` on the daemon to set one up.`,
          metadata: {
            kind: 'agent_no_profile',
            agentImUserId: agent.userId,
            triggerMessageId: triggerMessage.id,
          },
        });
      } catch (sysErr) {
        // This is the user's only feedback channel for "agent is alive
        // but unconfigured" — if the system_event write fails (DB, FK,
        // signing policy) the user is left with full silence. Log loud.
        log.error(
          { err: sysErr, agent: agent.username, conversationId: triggerMessage.conversationId },
          `CRITICAL: agent_no_profile system_event failed: ${(sysErr as Error).message}`,
        );
      }
      return;
    }

    // Fetch the authoritative participant list for this conversation so the
    // daemon's appendChannelContext can render it into [Channel context].
    // Without this, agents hallucinate ("CEO isn't in this channel") because
    // chat history alone is unreliable — long-silent participants drop out
    // of the window. Capped at 50 entries server-side (beyond that the
    // prompt becomes noise). See sdk/.../daemon/dispatch.ts.
    type ParticipantRow = {
      imUserId: string;
      imUser: {
        username: string;
        displayName: string;
        role: string;
        agentType: string | null;
      } | null;
    };
    let participants:
      | Array<{
          imUserId: string;
          username: string;
          displayName: string;
          role: string;
          agentType: string | null;
        }>
      | undefined;
    try {
      const rows = (await prisma.iMParticipant.findMany({
        where: { conversationId: triggerMessage.conversationId, leftAt: null },
        include: {
          imUser: {
            select: { username: true, displayName: true, role: true, agentType: true },
          },
        },
        take: 50,
      })) as ParticipantRow[];
      participants = rows
        .filter((r) => r.imUser !== null)
        .map((r) => ({
          imUserId: r.imUserId,
          username: r.imUser!.username,
          displayName: r.imUser!.displayName,
          role: r.imUser!.role,
          agentType: r.imUser!.agentType ?? null,
        }));
    } catch (err) {
      // Non-fatal: dispatch must continue even if the participant lookup
      // fails. Daemon falls back to no participant list in [Channel context].
      log.warn(
        { err, conversationId: triggerMessage.conversationId },
        `participant lookup failed for dispatch: ${(err as Error).message}`,
      );
    }

    // Hand off to TaskService as an execution run, not a board task. A plain
    // chat mention should never pollute `/tasks?view=board`.
    //
    // `metadata.assets.aggregatedAssetIds` is the Wave-8 W1 collection of
    // assets attached to chat messages in the dispatch context window.
    // `emitDaemonDispatchRequest` reads it (alongside the user-supplied
    // `metadata.assets.linkedAssetIds`) to hydrate `payload.assetRefs`.
    const assetsMeta = aggregatedAssetIds.length > 0 ? { aggregatedAssetIds } : undefined;
    const title = `[@${agent.username}] ${triggerMessage.content.slice(0, 60)}`;
    const run = await this.taskService.createTaskRun(null, triggerMessage.senderId, {
      workspaceId: profile.workspaceId ?? null,
      conversationId: triggerMessage.conversationId,
      triggerMessageId: triggerMessage.id,
      creatorId: triggerMessage.senderId,
      assigneeId: agent.userId,
      sourceKind: 'chat_mention',
      capability: 'chat',
      status: 'assigned',
      runtimeRoute: 'agent',
      input: { prompt: triggerMessage.content },
      metadata: {
        title,
        kind: 'agent_run',
        profileId: profile.id,
        context,
        triggerMessageId: triggerMessage.id,
        triggerKind: 'mention',
        // Stamp the hop value so the agent's reply (posted via
        // ws/handler.handleTaskDispatchReply) can carry it forward
        // and MAX_AGENT_HOPS can bound any further fan-out.
        hopCount,
        // Channel mode for the daemon's prompt builder (DM vs Group).
        // Forward-compatible: optional, daemon falls back to 'unknown'
        // when missing. Read by buildTaskDispatchRequest in
        // ws/v19x-helpers.ts to surface on the wire payload.
        ...(conversationType ? { conversationType } : {}),
        // Authoritative participant list (capped at 50 above). Hoisted to a
        // top-level wire field by buildTaskDispatchRequest; daemon renders
        // it into [Channel context] so agents don't hallucinate the
        // recipient set. Skip stamping when empty — keeps task_run
        // metadata noise-free for fresh conversations.
        ...(participants && participants.length > 0 ? { participants } : {}),
        ...(assetsMeta ? { assets: assetsMeta } : {}),
        // Sequential @-mention cursor (v1.9.x). When this agent's reply
        // lands, ws/handler.handleTaskDispatchReply pops the head off
        // and dispatches the next target via
        // messageService.dispatchPendingMention(...). Stays internal:
        // never propagated onto the agent_reply message metadata.
        ...(pendingMentionTargets && pendingMentionTargets.length > 0 ? { pendingMentionTargets } : {}),
      },
    });
    await this.taskService.dispatchTaskRun(run.id, agent.userId, 'task.assigned');
  }
}

/**
 * Wave-8 W1: pull asset IDs out of a chat message's metadata blob.
 *
 * Returns `[]` for messages that aren't tagged as workspace-asset
 * attachments. Logs (but doesn't throw) when the metadata is shaped
 * wrong — the dispatch must keep working even if a stray UI emits a
 * malformed attachment record.
 */
function extractAttachedAssetIds(metadata: unknown, messageId: string): string[] {
  if (!metadata) return [];
  // Why: im_messages.metadata is `String @db.Text` in Prisma schema, so
  // findMany returns a JSON string here, not a parsed object. The old
  // `typeof !== 'object'` guard short-circuited on every chat message and
  // dropped the assetIds, so user-attached files (W1 workspace asset
  // upload) never made it into payload.assetRefs. The agent then saw no
  // [Asset …] block in the prompt and concluded the upload had failed.
  let meta: Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      meta = parsed as Record<string, unknown>;
    } catch {
      return [];
    }
  } else if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    meta = metadata as Record<string, unknown>;
  } else {
    return [];
  }
  if (meta.kind !== 'workspace_asset_attachment') return [];
  const ids = meta.assetIds;
  if (!Array.isArray(ids)) {
    if (ids !== undefined) {
      log.warn(
        `message ${messageId}: workspace_asset_attachment metadata.assetIds is ${typeof ids}, expected array — skipping`,
      );
    }
    return [];
  }
  const cleaned: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) cleaned.push(id);
  }
  return cleaned;
}

// Wave-8 W5: helpers for in-session message search (snippet + highlight ranges).
function buildMessageSearchSnippet(content: string, query: string): string {
  const normalized = content.toLowerCase();
  const needle = query.toLowerCase();
  const index = normalized.indexOf(needle);
  if (index < 0) return content.slice(0, 160);

  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + query.length + 80);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function buildMessageSearchMatchRanges(content: string, query: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const needle = query.toLowerCase();
  if (!needle) return ranges;

  const haystack = content.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index >= 0 && ranges.length < 20) {
    ranges.push({ start: index, end: index + query.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
}

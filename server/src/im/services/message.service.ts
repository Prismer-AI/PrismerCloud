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
import type {
  AssetAttachment,
  AssetAttachmentKind,
  MessageType,
  MessageMetadata,
  TaskDispatchContextEntry,
} from '../types/index';
import type { SigningService } from './signing.service';
import type { RoomManager } from '../ws/rooms';
import type { TaskRunDispatcher } from './task-message-bridge';
import type { IMMessage } from '@prisma/client';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
// release201/25 §7 / release201/26 — typed L3 envelope (cloud-built).
// Flag-gated via FF_CONTEXT_ENVELOPE_ENABLED; off → returns null and we
// keep the legacy flat context path verbatim.
import { conversationMemoryService } from './conversation-memory.service';
import { config } from '../config';
import { isS3Available } from './s3.client';
import { sanitizeFileName } from './file-validator';
import * as path from 'path';

const log = createModuleLogger('MessageService');

// release201/30 §7 fix (2026-05-31) — resolve the *byte-servable* storageUri
// for an IMAsset derived from an im_file_uploads row.
//
// The asset bytes endpoint (`GET /api/im/assets/:id`, assets.ts) only
// understands two storageUri schemes: `s3://<bucket>/<key>` (→ presigned
// 302) and `file://<abspath>` (→ filesystem stream). Earlier this path
// stored `upload.cdnUrl` (a *display URL*, e.g. `/api/im/files/dev-download/
// …` in dev or `https://<cdn>/…` in S3 mode) into `storageUri`, which the
// endpoint rejects with "Unsupported storageUri scheme" → HTTP 500 →
// "Asset unavailable" in the UI, and the bytes can never be previewed or
// downloaded. cdnUrl stays the display URL; storageUri must be the canonical
// byte locator that mirrors what POST /api/im/assets writes.
function storageUriForFileUpload(upload: { uploadId: string; fileName: string; s3Key: string | null }): string | null {
  // S3 mode: bytes live at upload.s3Key in the configured bucket. Mirror the
  // `s3://<bucket>/<key>` form POST /api/im/assets (writeS3) produces so the
  // asset endpoint's presignS3 can serve them.
  if (isS3Available()) {
    if (!upload.s3Key) return null;
    return `s3://${config.s3.bucket}/${upload.s3Key}`;
  }
  // Dev/filesystem mode: bytes were saved by FileService.saveLocalFile to
  // `prisma/data/uploads/<uploadId>/<sanitizedFileName>` (mirror of
  // FileService.getLocalPath). Use the same absolute path so the asset
  // endpoint's streamFilesystem can read them.
  const localPath = path.resolve(
    process.cwd(),
    'prisma/data/uploads',
    upload.uploadId,
    sanitizeFileName(upload.fileName),
  );
  return `file://${localPath}`;
}

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
const MAX_MESSAGE_ATTACHMENTS = 16;

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
  attachments?: AssetAttachment[] | null;
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
  private taskService?: TaskRunDispatcher;

  /**
   * Optional RoomManager for emitting the workspace-targeted asset.changed
   * after a file-attach thumbnail derivative is generated. Wired by bootstrap
   * (server.ts) via setRoomManager — message.service does not own rooms.
   */
  private rooms?: RoomManager;

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
  setTaskService(taskService: TaskRunDispatcher): void {
    this.taskService = taskService;
  }

  /**
   * Wire the RoomManager so file-attach thumbnail derivatives can emit a
   * workspace-targeted asset.changed. Optional/idempotent — without it the
   * thumbnail is still generated + persisted, only the live WS refresh is
   * skipped (the frontend still picks it up on the next asset-list pull).
   */
  setRoomManager(rooms: RoomManager): void {
    this.rooms = rooms;
  }

  /**
   * Send a message with automatic @mention parsing and routing.
   */
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const attachments = normalizeMessageAttachments(input.attachments);
    // v1.8.2: Cap metadata payload size. MySQL `metadata` is @db.Text (64KB);
    // 16KB leaves room for indices/overhead and prevents waveform/transcription
    // floods from blowing up the column.
    if (input.metadata) {
      const metaSize = Buffer.byteLength(JSON.stringify(input.metadata), 'utf8');
      if (metaSize > 16384) {
        throw new Error(`metadata too large: ${metaSize} bytes (max 16384)`);
      }
    }
    if (attachments.length > 0) {
      const attachmentSize = Buffer.byteLength(JSON.stringify(attachments), 'utf8');
      if (attachmentSize > 32768) {
        throw new Error(`attachments too large: ${attachmentSize} bytes (max 32768)`);
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
    if (input.type === 'file' && attachments.length === 0) {
      await this.validateFileMessage(input);
      // 2026-05-31 docs/release201/30 §7 — dual-write attachments[] for legacy
      // SDK callers that only ship metadata.{uploadId,fileUrl}. Frontend
      // renders cards off attachments[] (Phase 2 makes it the primary path),
      // so we hydrate the IMAsset row + push it here. Best-effort: any
      // failure inside deriveFileMessageAttachment returns null and we keep
      // the original metadata-only message flowing.
      try {
        const derived = await this.deriveFileMessageAttachment(input);
        if (derived) attachments.push(derived);
      } catch (err) {
        // release201/30 §7 — surface traceId so the structured log lines up
        // with the matching frontend AssetCard ConsistencyError (POST
        // /api/admin/client-log) when files later 404 on the render path.
        const traceId =
          input.metadata && typeof (input.metadata as Record<string, unknown>).traceId === 'string'
            ? ((input.metadata as Record<string, unknown>).traceId as string)
            : undefined;
        log.warn(
          { traceId, conversationId: input.conversationId, senderId: input.senderId, err },
          `file attachment dual-write skipped: ${(err as Error).message}`,
        );
      }
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

    // v2.0 §4.1: Create message + write IMSyncEvent in the same transaction so
    // (a) the per-conversation `boundarySeq` can be allocated atomically via
    //     LAST_INSERT_ID on the same connection (Critical Invariant — outside
    //     a tx, 200 concurrent calls produce 167 dup + 167 gap, see
    //     scripts/exp-seq2.ts).
    // (b) DB-level UNIQUE on (conversationId, idempotencyKey) catches the
    //     concurrent same-key POST race that the app-level findByIdempotencyKey
    //     fast-path can lose.
    const createData = MessageModel.buildCreateData({
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type ?? 'text',
      content: input.content,
      metadata: enhancedMetadata,
      attachments,
      parentId: input.parentId,
      quotedMessageId: input.quotedMessageId,
      idempotencyKey: idemKey,
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

    let msg: IMMessage;
    try {
      msg = await prisma.$transaction(async (tx: any) => {
        const created = await tx.iMMessage.create({ data: createData });
        // Same-tx sync event with boundarySeq allocated under the same
        // connection. SyncService.writeEvent leaves publishedAt=NULL — the
        // SyncPublisher worker fans out to Redis.
        if (this.syncService) {
          await this.syncService.writeEvent(
            'message.new',
            {
              id: created.id,
              conversationId: created.conversationId,
              senderId: created.senderId,
              type: created.type,
              content: created.content,
              metadata: created.metadata,
              attachments: created.attachments,
              parentId: created.parentId,
              idempotencyKey: created.idempotencyKey ?? null,
              createdAt: (created.createdAt as Date).toISOString(),
            },
            created.conversationId,
            created.senderId,
            tx,
          );
        }
        return created;
      });
    } catch (e) {
      // P2002 = Prisma unique constraint violation. Race-safe dedup: another
      // concurrent POST with the same (conversationId, idempotencyKey) won
      // the insert; resolve to that row and return.
      const code = (e as { code?: string }).code;
      const meta = (e as { meta?: { target?: string | string[] } }).meta;
      const target = meta?.target;
      const isIdemViolation =
        code === 'P2002' &&
        (target === 'im_messages_idem' ||
          (Array.isArray(target) && target.includes('idempotencyKey')) ||
          (typeof target === 'string' && target.includes('idempotencyKey')));
      if (isIdemViolation && idemKey) {
        const existing = await prisma.iMMessage.findFirst({
          where: { conversationId: input.conversationId, idempotencyKey: idemKey },
        });
        if (existing) {
          return { message: existing };
        }
      }
      throw e;
    }

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

    // v2.0 §4.1: sync event was written inside the same transaction as the
    // message insert (above), with per-conversation boundarySeq allocated
    // atomically. The SyncPublisher worker fans out to Redis subscribers —
    // do NOT re-publish here.

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
      // An `agent_reply` (the auto-posted task result) must NOT re-trigger
      // explicit @-mention dispatch. The sequential `pendingMentionTargets`
      // chain (consumed in ws/handler.handleTaskDispatchReply) is the ONLY
      // fan-out path for replies. Without this guard, an agent reply that
      // echoes the original `@a @b` text (mock daemons and some LLMs do)
      // re-enters this branch and fires a SECOND dispatch on top of the
      // chain — the two paths ping-pong (bounded only by MAX_AGENT_HOPS),
      // so a single multi-mention amplifies into 3+ dispatches per agent.
      // Agent-initiated NEW messages (MCP `prismer.agent.send`, kind ≠
      // `agent_reply`) still route normally, so genuine agent→agent
      // @-mention chains are unaffected.
      !isAgentReply &&
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

  /**
   * release202/09 P5#3 (A2) — attach an already-uploaded asset to an
   * ALREADY-PERSISTED message (`cloud attach <messageId> <path>`).
   *
   * Messages are otherwise written once at create time (`send`), and the
   * `update()` path above only mutates `content`/`metadata` — it never touches
   * the first-class `attachments[]` column. A2 lets an agent, AFTER its reply
   * already exists, append a freshly-produced file to THAT message. The data
   * model supports this cleanly: `attachments[]` is a first-class JSON column
   * (there is precedent — the app-router send-fallback at
   * `src/app/api/im/[...path]/route.ts` already does `iMMessage.update({ attachments })`
   * + a `message.updated` event that the frontend patches in-place,
   * `im-channel.tsx:1328`). This method is the in-process, agent-proxied
   * equivalent: append a deduped `{ kind:'asset', assetId, ... }` entry,
   * enrich it from the IMAsset row, stamp the asset's conversationId for the
   * session right-rail / library surfaces, and return the updated row (the
   * caller emits the WS/sync event).
   *
   * Append-only by design: the new attachment is added to the END of the
   * existing `attachments[]`; existing entries are never removed or reordered.
   * A re-attach of the same assetId is a no-op (deduped) and returns the
   * unchanged message.
   */
  async attachAssetToMessage(
    messageId: string,
    assetId: string,
  ): Promise<{ message: IMMessage; attachment: AssetAttachment; added: boolean }> {
    const trimmedAssetId = typeof assetId === 'string' ? assetId.trim() : '';
    if (!trimmedAssetId) {
      throw Object.assign(new Error('assetId is required'), { status: 400, code: 'ASSET_ID_REQUIRED' });
    }
    const msg = await this.messageModel.findById(messageId);
    if (!msg) {
      throw Object.assign(new Error('Message not found'), { status: 404, code: 'MESSAGE_NOT_FOUND' });
    }

    // Resolve the asset row to enrich the attachment (mime/filename/size/hash)
    // so the chat card + library render without an extra round-trip, and to
    // fail loudly if the assetId is bogus.
    const asset = await prisma.iMAsset.findFirst({
      where: { id: trimmedAssetId, deletedAt: null },
      select: { id: true, mime: true, filename: true, sizeBytes: true, contentHash: true },
    });
    if (!asset) {
      throw Object.assign(new Error(`asset not found: ${trimmedAssetId}`), {
        status: 404,
        code: 'ASSET_NOT_FOUND',
      });
    }

    // Read existing attachments off the first-class column (it may be a JSON
    // string in the MySQL @db.Text shape or an already-parsed array).
    const existingRaw = (msg as { attachments?: unknown }).attachments;
    let existing: AssetAttachment[] = [];
    if (typeof existingRaw === 'string' && existingRaw.length > 0) {
      try {
        existing = normalizeMessageAttachments(JSON.parse(existingRaw));
      } catch {
        existing = [];
      }
    } else if (Array.isArray(existingRaw)) {
      existing = normalizeMessageAttachments(existingRaw);
    }

    const attachment = normalizeMessageAttachment({
      kind: 'asset',
      assetId: asset.id,
      role: 'attachment',
      ...(asset.mime ? { mime: asset.mime } : {}),
      ...(asset.filename ? { filename: asset.filename, title: asset.filename } : {}),
      ...(typeof asset.sizeBytes === 'number' ? { sizeBytes: asset.sizeBytes } : {}),
      ...(asset.contentHash ? { contentHash: asset.contentHash } : {}),
    })!;

    // Dedupe — re-attaching the same asset is a no-op.
    if (existing.some((a) => a.assetId === attachment.assetId)) {
      return { message: msg, attachment, added: false };
    }

    const next = [...existing, attachment];
    if (next.length > MAX_MESSAGE_ATTACHMENTS) {
      throw Object.assign(new Error(`too many attachments: ${next.length} (max ${MAX_MESSAGE_ATTACHMENTS})`), {
        status: 422,
        code: 'TOO_MANY_ATTACHMENTS',
      });
    }
    const attachmentSize = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (attachmentSize > 32768) {
      throw Object.assign(new Error(`attachments too large: ${attachmentSize} bytes (max 32768)`), {
        status: 422,
        code: 'ATTACHMENTS_TOO_LARGE',
      });
    }

    const updated = (await prisma.iMMessage.update({
      where: { id: messageId },
      data: { attachments: next },
    })) as IMMessage;

    // release202 — SYSTEMATIC stamp (mirrors deriveFileMessageAttachment): the
    // moment an asset becomes a message attachment, ensure it carries this
    // conversation so the session sidebar / library can see it. JSON_SET
    // only-when-missing so the FIRST conversation an asset lands in wins.
    try {
      await prisma.$executeRaw`
        UPDATE im_assets
        SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.conversationId', ${msg.conversationId})
        WHERE id = ${asset.id} AND JSON_EXTRACT(metadata, '$.conversationId') IS NULL
      `;
    } catch (err) {
      log.warn(`[attachAssetToMessage] conversationId stamp failed for asset ${asset.id}: ${String(err)}`);
    }

    if (this.syncService) {
      let metaForEvent: unknown = updated.metadata;
      if (typeof updated.metadata === 'string') {
        try {
          metaForEvent = JSON.parse(updated.metadata);
        } catch {
          metaForEvent = undefined;
        }
      }
      this.syncService
        .writeEvent(
          'message.updated',
          {
            id: updated.id,
            content: updated.content,
            type: updated.type,
            attachments: (updated as { attachments?: unknown }).attachments,
            metadata: metaForEvent,
          },
          updated.conversationId,
          updated.senderId,
        )
        .catch(() => {});
    }

    return { message: updated, attachment, added: true };
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
   *
   * v2.0 §4.1: Prefer the first-class `idempotencyKey` column (covered by
   * a UNIQUE index — index lookup, no JSON scan). Falls back to a
   * 24h-windowed metadata scan for rows written before migration 402.
   */
  async findByIdempotencyKey(conversationId: string, key: string): Promise<any | null> {
    // Fast path — UNIQUE-indexed lookup on the first-class column.
    const direct = await prisma.iMMessage.findFirst({
      where: { conversationId, idempotencyKey: key },
    });
    if (direct) return direct;

    // Legacy fallback — pre-migration-402 rows kept the key in metadata JSON.
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

  /**
   * 2026-05-31 docs/release201/30 §7 — dual-write file message attachments.
   *
   * `type='file'` 消息的 caller 经常只塞 `metadata.{uploadId, fileUrl, ...}`
   * （SDK 协议），不传 `attachments[]`。前端按 `attachments[]` 渲染卡片，没
   * attachments 就只能 `[file]` 占位。
   *
   * 本 helper：从 `metadata.uploadId` 反查 `im_file_uploads` → lookup-or-create
   * `IMAsset`（按 `contentHash` dedupe）→ 返回一个 `AssetAttachment`，由 caller
   * 合并进 `attachments` 数组后传给 `MessageModel.buildCreateData` 写库。
   *
   * SDK 协议（`metadata.fileUrl`）保留不动 → ts/python/go SDK 不破。前端渐进
   * 迁移到 `attachments[]`（Phase 2）。
   *
   * 安全保证：只在 `validateFileMessage` 已校验通过后调用；任何反查失败 / 缺字段
   * 都安静返回 null（保守语义，不影响已通过强契约的 message 写入）。
   */
  private async deriveFileMessageAttachment(input: SendMessageInput): Promise<AssetAttachment | null> {
    if (input.type !== 'file') return null;
    const meta = input.metadata as Record<string, unknown> | undefined;
    const uploadId = typeof meta?.uploadId === 'string' ? meta.uploadId : undefined;
    if (!uploadId) return null;

    const upload = await prisma.iMFileUpload.findUnique({ where: { uploadId } });
    if (!upload || upload.status !== 'confirmed') return null;

    // release202/09 P1 — kanban sync for the cli-send / message-attach path.
    // When this file message is a dispatch reply tied to a task/run, the
    // agent's `cloud file send` / `cloud send --file` carries the owning
    // task/run id in metadata (sourceTaskId | taskId | runId — same id shape,
    // resolved against whichever row exists). We stamp `sourceTaskId` on the
    // derived IMAsset (powers the live kanban chip via IMAsset.sourceTaskId)
    // AND roll it into the task's outputAssetIds + re-emit the terminal digest
    // (mirrors the POST /assets sandbox-output branch) so a cli-delivered file
    // reaches the kanban card, not just the chat attachment. Absent any of
    // these signals this stays null and behaves exactly as before.
    const replySourceTaskId =
      (typeof meta?.sourceTaskId === 'string' && meta.sourceTaskId) ||
      (typeof meta?.taskId === 'string' && meta.taskId) ||
      (typeof meta?.runId === 'string' && meta.runId) ||
      null;

    // workspace 推断：conversation 的 workspaceId
    const conv = await prisma.iMConversation.findUnique({
      where: { id: input.conversationId },
      select: { workspaceId: true },
    });
    const workspaceId = conv?.workspaceId;
    if (!workspaceId) return null;

    // contentHash dedupe 走 sha256；缺失则跳过（不构造 dedupe 不安全的 IMAsset 行）
    const contentHash = upload.sha256;
    if (!contentHash) return null;

    const traceId = typeof meta?.traceId === 'string' ? meta.traceId : null;

    // lookup or create — uk_im_assets_ws_hash_source_deleted 保 dedupe
    let asset = await prisma.iMAsset.findFirst({
      where: { workspaceId, contentHash, deletedAt: null },
      select: { id: true, contentHash: true, mime: true, sizeBytes: true, filename: true },
    });
    if (!asset) {
      // release201/30 §7 fix (2026-05-31) — resolve a byte-servable storageUri
      // (file:// or s3://) up front. Previously this stored upload.cdnUrl,
      // which is a display URL the asset bytes endpoint rejects as an
      // "Unsupported storageUri scheme" (→ 500 → "Asset unavailable"). If we
      // can't resolve a servable locator (e.g. S3 mode with no s3Key), skip
      // creating a broken asset row — the message attachment still references
      // the upload via the SDK metadata path.
      const storageUri = storageUriForFileUpload(upload);
      if (!storageUri) {
        log.warn(
          `[deriveFileMessageAttachment] cannot resolve storageUri for uploadId=${upload.uploadId} (s3Available=${isS3Available()}, s3Key=${upload.s3Key ?? 'null'}); skipping asset create`,
        );
        return null;
      }
      try {
        // release201/30 §7 fix (2026-05-31) — the derived asset must be a
        // *complete* library asset, not a half-baked row. Two fields the
        // original create omitted left daemon/cli file results invisible +
        // un-previewable:
        //   1. assetIndexSeq — the workspace asset list filters
        //      `assetIndexSeq > since` (assets.ts §list); seq defaults to 0 so
        //      the file never appeared in the library. We allocate the next
        //      seq via the same iMAssetIndexCounter the upload-confirm path
        //      uses (assets.ts allocateAssetIndexSeq).
        //   2. ingestStatus — defaults to 'pending', which keeps the asset out
        //      of the servable/previewable set. 'asset-only' = bytes are
        //      available but no memory embedding was generated (honest: this
        //      path does not run memory ingestion).
        // The upsert's `increment` is atomic, so the seq is uniquely allocated
        // even without a wrapping tx; a create failure only leaks one seq
        // (gaps are harmless — the list filter is `> since`, not contiguity).
        const counter = await prisma.iMAssetIndexCounter.upsert({
          where: { workspaceId },
          create: { workspaceId, nextSeq: BigInt(2) },
          update: { nextSeq: { increment: 1 } },
        });
        const assetIndexSeq = counter.nextSeq - BigInt(1);
        asset = await prisma.iMAsset.create({
          data: {
            workspaceId,
            ownerImUserId: input.senderId,
            contentHash,
            storageUri,
            sizeBytes: BigInt(upload.fileSize ?? 0),
            mime: upload.mimeType,
            kind: upload.mimeType?.startsWith('image/') ? 'image' : 'file',
            cdnUrl: upload.cdnUrl,
            filename: upload.fileName,
            sourceAgentImUserId: input.senderId,
            // release202/09 P1 — stamp the owning task/run so the kanban chip
            // (IMAsset.sourceTaskId index in task-board.tsx) lights up. When
            // absent, falls back to a plain workspace file as before.
            sourceTaskId: replySourceTaskId,
            boundKind: replySourceTaskId ? 'task-bound' : 'workspace-file',
            ingestStatus: 'asset-only',
            assetIndexSeq,
            metadata: JSON.stringify({
              // release202 — stamp the conversation so the asset surfaces in
              // every conversation-scoped view. `sessionAssets` (workspace
              // page.tsx) filters assets by `metadata.conversationId ===
              // selectedConversationId`; without this an agent-delivered
              // (cli-send) file shows as a message attachment but is INVISIBLE
              // in the session sidebar / context surfaces.
              conversationId: input.conversationId,
              pipeline: {
                version: 1,
                deliveryPath: 'cli-send',
                originatedBy: 'cli-explicit',
                traceId,
                sourcePath: upload.fileName,
              },
            }),
          },
          select: { id: true, contentHash: true, mime: true, sizeBytes: true, filename: true },
        });
      } catch {
        // 并发情况下另一条 send 路径已 create — 重新 lookup 一次
        asset = await prisma.iMAsset.findFirst({
          where: { workspaceId, contentHash, deletedAt: null },
          select: { id: true, contentHash: true, mime: true, sizeBytes: true, filename: true },
        });
        if (!asset) return null;
      }
    }

    // release202 — SYSTEMATIC stamp: the moment an asset becomes a message
    // attachment, ensure it carries this conversation. The create branch above
    // already sets it; this also covers the dedup / link-existing branch (a
    // user pre-uploaded file, or the same content re-sent — its asset row was
    // created WITHOUT a conversation). JSON_SET only-when-missing so the FIRST
    // conversation an asset is delivered into wins (no flip on re-forward).
    // This is what makes conversation-scoped surfaces (sessionAssets) reliable
    // regardless of which creation path produced the asset — instead of relying
    // on every path remembering to stamp it. (Root fix for "agent file shows as
    // attachment but is invisible in the session sidebar".)
    try {
      await prisma.$executeRaw`
        UPDATE im_assets
        SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.conversationId', ${input.conversationId})
        WHERE id = ${asset.id} AND JSON_EXTRACT(metadata, '$.conversationId') IS NULL
      `;
    } catch (err) {
      log.warn(`[deriveFileMessageAttachment] conversationId stamp failed for asset ${asset.id}: ${String(err)}`);
    }

    // release202/09 P1 — kanban sync. When this delivery is tied to a task/run,
    // (1) backfill the IMAsset.sourceTaskId column for the dedup / link-existing
    //     branch (the create branch above already set it; only stamp when still
    //     NULL so the FIRST owning task wins, matching the conversationId rule),
    //     then (2) roll the assetId into the task's outputAssetIds + re-emit the
    //     terminal digest so the kanban card / chat digest catch up — mirroring
    //     the POST /assets sandbox-output branch. Best-effort: never blocks the
    //     message send.
    if (replySourceTaskId) {
      try {
        await prisma.$executeRaw`
          UPDATE im_assets
          SET sourceTaskId = ${replySourceTaskId}
          WHERE id = ${asset.id} AND sourceTaskId IS NULL
        `;
      } catch (err) {
        log.warn(`[deriveFileMessageAttachment] sourceTaskId stamp failed for asset ${asset.id}: ${String(err)}`);
      }
      if (this.taskService?.linkOutputAssetAndReemitDigest) {
        await this.taskService.linkOutputAssetAndReemitDigest(replySourceTaskId, asset.id).catch((err) => {
          log.warn(
            `[deriveFileMessageAttachment] kanban digest rollup failed for task ${replySourceTaskId} asset ${asset.id}: ${String(err)}`,
          );
        });
      }
    }

    const mime = asset.mime ?? upload.mimeType ?? null;

    // release202 — best-effort inline THUMBNAIL for agent/cli-delivered files.
    // The message file-attach path creates the im_assets row directly (above)
    // and never went through the /assets upload routes, so it previously got
    // NO thumbnailUrl: agent-delivered PDFs rendered as a bare FileText icon
    // and agent-delivered images needed a full-res bytes fetch. We now trigger
    // the SAME local thumbnail-derivative pipeline used by the upload routes
    // (image/* + application/pdf first page via pdftoppm/mutool+sharp — works
    // in dev with no Lambda). It self-gates on mime + existing-thumbnail and
    // emits a workspace-targeted asset.changed when done.
    //
    // Fire-and-forget: a thumbnail must NEVER block the message send. The
    // generator swallows + logs every error internally.
    const thumbAssetId = asset.id;
    if (mime && (mime.startsWith('image/') || mime === 'application/pdf')) {
      void import('../api/assets')
        .then(({ generateThumbnailDerivativesForAsset }) =>
          generateThumbnailDerivativesForAsset({
            assetId: thumbAssetId,
            rooms: this.rooms,
            syncService: this.syncService,
          }),
        )
        .catch((err) =>
          log.warn(`[deriveFileMessageAttachment] thumbnail trigger failed for asset ${thumbAssetId}: ${String(err)}`),
        );
    }

    return {
      kind: mime?.startsWith('image/') ? 'image' : 'file',
      assetId: asset.id,
      contentHash: asset.contentHash,
      mime,
      sizeBytes: asset.sizeBytes != null ? Number(asset.sizeBytes) : (upload.fileSize ?? null),
      filename: asset.filename ?? upload.fileName,
      // release202/13 §3b① — usually null here (thumbnail/blurHash generation is
      // fire-and-forget above); the card backfills it via the asset.changed
      // /detail re-fetch once the derivative lands.
      ...((asset as { blurHash?: string | null }).blurHash
        ? { blurHash: (asset as { blurHash?: string | null }).blurHash }
        : {}),
    };
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
    // Seed the chain-wide de-dupe set with EVERY agent target from this human
    // message, so a later agent reply that echoes the original @a @b coalesces
    // away while genuinely new delegations still fan out.
    const chainMentionedUserIds = agentTargets.map((t) => t.userId);

    try {
      await this.dispatchToAgent(
        primary,
        triggerMessage,
        hopCount,
        conversationType,
        pendingMentionTargets,
        chainMentionedUserIds,
      );
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
    /** Chain-wide de-dupe set, carried forward unchanged (see dispatchToAgent). */
    chainMentionedUserIds?: string[],
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
      await this.dispatchToAgent(
        targetUser,
        triggerMessage,
        hopCount,
        conversationType,
        pendingRest,
        chainMentionedUserIds,
      );
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
    /**
     * Monotonic set of agent userIds already dispatched OR queued in THIS
     * mention chain (seed = the human message's full agent-target set). An
     * agent reply's own @mentions are de-duped against this in
     * `ws/handler.handleTaskDispatchReply`, so a NEW delegation dispatches
     * while an echo of the existing chain coalesces away (no ping-pong). Also
     * the hard loop bound — an agent enters the set at most once, so the chain
     * length ≤ distinct agents. Stays internal; never on agent_reply metadata.
     */
    chainMentionedUserIds?: string[],
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
      const rawAttachments = (m as { attachments?: unknown }).attachments;
      const attachedAssetIds = extractAttachedAssetIds(m.metadata, m.id, rawAttachments);
      // 2026-05-31 release201/30 §XML-context P0 — same source as
      // `attachedAssetIds` but keeps mime/filename/sizeBytes so the daemon
      // can render `<attached_assets><asset id mime filename .../></...>`
      // inside the XML conversation context. Old cloud builds without this
      // field still ship `attachedAssetIds` and the daemon falls back to
      // id-only rendering.
      const attachedAssetsMeta = extractAttachedAssetMeta(m.metadata, rawAttachments);
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
        ...(attachedAssetsMeta.length > 0 ? { attachedAssets: attachedAssetsMeta } : {}),
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

    // release201/25 §7 / release201/26 Phase 1 — build the L3 envelope
    // (cloud-side, decision E). Flag-gated via FF_CONTEXT_ENVELOPE_ENABLED;
    // off → returns null and the legacy flat fields below carry the dispatch
    // alone. on → adapter-aware paths (sessions-dispatcher renderContextEnvelope)
    // consume `metadata.contextEnvelope`; the flat fields stay populated as
    // backwards-compat for one release window. Built BEFORE the IIFE so
    // metadata composition can spread it without an extra async pass.
    let contextEnvelope: Awaited<ReturnType<typeof conversationMemoryService.buildEnvelopeIfEnabled>> = null;
    try {
      contextEnvelope = await conversationMemoryService.buildEnvelopeIfEnabled(triggerMessage.conversationId, {
        id: triggerMessage.id,
        conversationId: triggerMessage.conversationId,
        senderId: triggerMessage.senderId,
        type: (triggerMessage as { type?: string }).type ?? 'text',
        content: triggerMessage.content,
        metadata: (triggerMessage as { metadata?: unknown }).metadata as
          | string
          | Record<string, unknown>
          | null
          | undefined,
        quotedMessageId: (triggerMessage as { quotedMessageId?: string | null }).quotedMessageId ?? null,
        createdAt: triggerMessage.createdAt as Date,
      });
    } catch (err) {
      // Envelope build failures must never block dispatch — flag-off default
      // shape (no envelope) is always a valid fallback. Log loud so a real
      // schema/data regression surfaces but the legacy path keeps shipping.
      log.warn(
        { err, conversationId: triggerMessage.conversationId },
        `[message.service] contextEnvelope build failed; falling back to legacy context path: ${(err as Error).message}`,
      );
      contextEnvelope = null;
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
      metadata: (() => {
        // release201/30 — resolve the trigger sender's username + role so the
        // daemon's <conversation_context> XML wrapper can tag the
        // <current_message author="..."> attribute correctly. Without this,
        // sessions-style adapters fall back to the recipient's own username
        // and weaker models lose the "human asked, agent should answer"
        // structural cue. byId already has the lookup for messages in the
        // recent window; we fall back to a direct DB read if the trigger
        // happens to be older than the cap (unlikely but cheap to handle).
        const triggerSenderFromMap = byId.get(triggerMessage.senderId);
        const triggerSenderUsername = triggerSenderFromMap?.username;
        const triggerSenderRole = triggerSenderFromMap?.role;
        return {
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
          // release201/30 — trigger-sender identity for the daemon's XML
          // conversation context. v19x-helpers hoists these to top-level
          // payload fields; daemon stamps the <current_message author> attr.
          ...(triggerSenderUsername ? { triggerSenderUsername } : {}),
          ...(triggerSenderRole ? { triggerSenderRole } : {}),
          // release201/25 §7 / release201/26 — typed L3 envelope (cloud built
          // via ConversationMemoryService.buildEnvelopeIfEnabled). Hoisted to
          // the wire payload's top level by v19x-helpers buildTaskDispatchRequest.
          // Stamped only when the flag was on at build time; envelope-naive
          // adapters keep reading the flat context/participants/triggerSender*
          // fields above for one release window.
          ...(contextEnvelope ? { contextEnvelope } : {}),
          // Sequential @-mention cursor (v1.9.x). When this agent's reply
          // lands, ws/handler.handleTaskDispatchReply pops the head off
          // and dispatches the next target via
          // messageService.dispatchPendingMention(...). Stays internal:
          // never propagated onto the agent_reply message metadata.
          ...(pendingMentionTargets && pendingMentionTargets.length > 0 ? { pendingMentionTargets } : {}),
          // Chain-wide de-dupe set (see dispatchToAgent param doc). Carried
          // forward each hop so an agent is dispatched at most once per chain —
          // the hard bound that suppresses A→B→A echo loops and lets the handler
          // admit only an agent's NEW reply @mentions.
          ...(chainMentionedUserIds && chainMentionedUserIds.length > 0 ? { chainMentionedUserIds } : {}),
        };
      })(),
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
function extractAttachedAssetIds(metadata: unknown, messageId: string, attachments?: unknown): string[] {
  const collected = new Set<string>();
  for (const id of assetIdsFromAttachmentArray(attachments)) collected.add(id);
  if (!metadata) return Array.from(collected);
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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Array.from(collected);
      meta = parsed as Record<string, unknown>;
    } catch {
      return Array.from(collected);
    }
  } else if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    meta = metadata as Record<string, unknown>;
  } else {
    return Array.from(collected);
  }
  if (meta.kind !== 'workspace_asset_attachment') {
    for (const id of assetIdsFromAttachmentArray(meta.attachments)) collected.add(id);
    return Array.from(collected);
  }
  for (const id of assetIdsFromAttachmentArray(meta.attachments)) collected.add(id);
  for (const id of assetIdsFromAttachmentArray([meta.asset])) collected.add(id);
  const ids = meta.assetIds;
  if (!Array.isArray(ids)) {
    if (ids !== undefined) {
      log.warn(
        `message ${messageId}: workspace_asset_attachment metadata.assetIds is ${typeof ids}, expected array — skipping`,
      );
    }
    return Array.from(collected);
  }
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) collected.add(id);
  }
  return Array.from(collected);
}

/**
 * 2026-05-31 release201/30 §XML-context P0 — companion to
 * `extractAttachedAssetIds` that preserves mime / filename / sizeBytes so
 * the daemon can render attached assets as
 * `<asset id="..." mime="..." filename="..." size_bytes="..."/>` inside
 * the XML conversation context (release201/30).
 *
 * Sources (in priority order; dedupe by assetId, first-wins):
 *   1. `attachments[]` column (JSON or already-parsed array — Phase 1
 *      shape `[{assetId, mime, filename, sizeBytes, ...}]`)
 *   2. `metadata.attachments[]` legacy shape (same field names)
 *
 * Returns `[]` for messages that have neither shape. Defensive against
 * malformed payloads — never throws, drops the bad entry and continues.
 */
function extractAttachedAssetMeta(
  metadata: unknown,
  attachments?: unknown,
): Array<{ id: string; mime?: string; filename?: string; sizeBytes?: number }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; mime?: string; filename?: string; sizeBytes?: number }> = [];

  const pushFrom = (raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const idRaw = obj.assetId ?? obj.id;
      const id = typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const meta: { id: string; mime?: string; filename?: string; sizeBytes?: number } = { id };
      if (typeof obj.mime === 'string' && obj.mime.length > 0) meta.mime = obj.mime;
      if (typeof obj.filename === 'string' && obj.filename.length > 0) meta.filename = obj.filename;
      else if (typeof obj.title === 'string' && obj.title.length > 0) meta.filename = obj.title;
      if (typeof obj.sizeBytes === 'number' && Number.isFinite(obj.sizeBytes) && obj.sizeBytes >= 0) {
        meta.sizeBytes = obj.sizeBytes;
      }
      out.push(meta);
    }
  };

  // 1. attachments column. `im_messages.attachments` is text JSON in the
  //    Prisma model — be permissive about both shapes.
  if (typeof attachments === 'string' && attachments.length > 0) {
    try {
      pushFrom(JSON.parse(attachments));
    } catch {
      /* malformed JSON — skip */
    }
  } else if (Array.isArray(attachments)) {
    pushFrom(attachments);
  }

  // 2. metadata.attachments fallback (older shape).
  if (metadata) {
    let meta: Record<string, unknown> | undefined;
    if (typeof metadata === 'string') {
      try {
        const parsed = JSON.parse(metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed JSON — skip */
      }
    } else if (typeof metadata === 'object' && !Array.isArray(metadata)) {
      meta = metadata as Record<string, unknown>;
    }
    if (meta) {
      pushFrom(meta.attachments);
      if (meta.asset) pushFrom([meta.asset]);
    }
  }

  return out;
}

function normalizeMessageAttachments(raw: unknown): AssetAttachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('attachments must be an array');
  }
  if (raw.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`too many attachments: ${raw.length} (max ${MAX_MESSAGE_ATTACHMENTS})`);
  }
  const out: AssetAttachment[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const attachment = normalizeMessageAttachment(item);
    if (!attachment || seen.has(attachment.assetId)) continue;
    seen.add(attachment.assetId);
    out.push(attachment);
  }
  return out;
}

function normalizeMessageAttachment(raw: unknown): AssetAttachment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('attachments entries must be objects');
  }
  const obj = raw as Record<string, unknown>;
  const assetId = readNonEmptyString(obj.assetId) ?? readNonEmptyString(obj.id);
  if (!assetId) throw new Error('attachment.assetId is required');
  const mime = readNullableString(obj.mime);
  const kind = normalizeAttachmentKind(readNonEmptyString(obj.kind), mime);
  const sizeBytes = readFiniteNonNegativeNumber(obj.sizeBytes);
  const revision = readInteger(obj.revision);
  const role =
    obj.role === 'context' || obj.role === 'output' ? obj.role : obj.role === 'attachment' ? obj.role : undefined;
  return {
    kind,
    assetId,
    ...(readNonEmptyString(obj.title) ? { title: readNonEmptyString(obj.title) } : {}),
    ...(readNonEmptyString(obj.filename) ? { filename: readNonEmptyString(obj.filename) } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(readNonEmptyString(obj.contentHash) ? { contentHash: readNonEmptyString(obj.contentHash) } : {}),
    ...(readNullableString(obj.thumbnailUrl) !== undefined
      ? { thumbnailUrl: readNullableString(obj.thumbnailUrl) }
      : {}),
    ...(normalizePreviewUrls(obj.previewUrls) !== undefined
      ? { previewUrls: normalizePreviewUrls(obj.previewUrls) }
      : {}),
    // release202/13 — blurHash (~30B) + previewText (short excerpt) are additive
    // passthrough fields the cards consume; older producers omit them.
    ...(readNonEmptyString(obj.blurHash) ? { blurHash: readNonEmptyString(obj.blurHash) } : {}),
    ...(readNonEmptyString(obj.previewText) ? { previewText: readNonEmptyString(obj.previewText) } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(role ? { role } : {}),
  };
}

function assetIdsFromAttachmentArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const assetId = readNonEmptyString(obj.assetId) ?? readNonEmptyString(obj.id);
    if (assetId) out.push(assetId);
  }
  return out;
}

function normalizeAttachmentKind(kind: string | undefined, mime: string | null | undefined): AssetAttachmentKind {
  if (kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'asset') return kind;
  const normalizedMime = mime ?? '';
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  if (normalizedMime.startsWith('video/')) return 'video';
  return 'file';
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readNonEmptyString(value);
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizePreviewUrls(raw: unknown): AssetAttachment['previewUrls'] | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: NonNullable<AssetAttachment['previewUrls']> = {};
  for (const key of ['small', 'medium', 'large'] as const) {
    const value = readNonEmptyString(obj[key]);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/**
 * Prismer IM — Message model
 *
 * Uses Prisma ORM with IMMessage model.
 */

import prisma from '../db';
import type { AssetAttachment, MessageType, MessageMetadata } from '../types/index';

export interface CreateMessageInput {
  conversationId: string;
  senderId: string;
  type?: MessageType;
  content: string;
  metadata?: MessageMetadata;
  attachments?: AssetAttachment[] | null;
  parentId?: string;
  quotedMessageId?: string; // v1.8.2: Quote reply
  // v2.0 §4.1: first-class column with (conversationId, idempotencyKey) UNIQUE.
  // Caller still doubles into metadata._idempotencyKey for the legacy
  // app-level findByIdempotencyKey fast path during the transition.
  idempotencyKey?: string;
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
}

export interface MessageQuery {
  conversationId: string;
  before?: string; // cursor: message ID
  after?: string; // cursor: message ID
  limit?: number;
}

export class MessageModel {
  /**
   * Build the Prisma data object for an IMMessage row.
   * Exported separately so service-layer code can compose it inside a
   * `$transaction` (so the seq-allocation + insert run on the same
   * connection — see v2.0 §4.1 Critical Invariant).
   */
  static buildCreateData(input: CreateMessageInput) {
    return {
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type ?? 'text',
      content: input.content,
      metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
      attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
      parentId: input.parentId,
      quotedMessageId: input.quotedMessageId,
      idempotencyKey: input.idempotencyKey ?? null,
      status: 'sent',
      // E2E Signing fields (Layer 2)
      secVersion: input.secVersion,
      senderKeyId: input.senderKeyId,
      sequence: input.sequence,
      contentHash: input.contentHash,
      prevHash: input.prevHash,
      signature: input.signature,
      // AIP DID fields (v1.8.0 S2)
      senderDid: input.senderDid,
      delegationProof: input.delegationProof,
    };
  }

  async create(input: CreateMessageInput) {
    return prisma.iMMessage.create({ data: MessageModel.buildCreateData(input) });
  }

  async findById(id: string) {
    return prisma.iMMessage.findUnique({
      where: { id },
    });
  }

  async list(query: MessageQuery) {
    const limit = Math.min(query.limit ?? 50, 200);

    // Build cursor-based pagination
    let cursor: { id: string } | undefined;
    let orderBy: { createdAt: 'asc' | 'desc' } = { createdAt: 'desc' };

    if (query.before) {
      const ref = await this.findById(query.before);
      if (ref) {
        cursor = { id: query.before };
      }
    } else if (query.after) {
      const ref = await this.findById(query.after);
      if (ref) {
        cursor = { id: query.after };
        orderBy = { createdAt: 'asc' };
      }
    }

    const messages = await prisma.iMMessage.findMany({
      where: {
        conversationId: query.conversationId,
      },
      orderBy,
      take: limit,
      skip: cursor ? 1 : 0,
      cursor,
    });

    // Return in chronological order
    return query.after ? messages : messages.reverse();
  }

  async update(id: string, data: { content?: string; metadata?: Record<string, unknown>; status?: string }) {
    return prisma.iMMessage.update({
      where: { id },
      data: {
        ...data,
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
      },
    });
  }

  async delete(id: string) {
    return prisma.iMMessage.delete({
      where: { id },
    });
  }

  async countInConversation(conversationId: string): Promise<number> {
    return prisma.iMMessage.count({
      where: { conversationId },
    });
  }
}

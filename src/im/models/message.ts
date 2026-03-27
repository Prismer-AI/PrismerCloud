/**
 * Prismer IM — Message model
 *
 * Uses Prisma ORM with IMMessage model.
 */

import prisma from '../db';
import type { MessageType, MessageMetadata } from '../types/index';

export interface CreateMessageInput {
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

export interface MessageQuery {
  conversationId: string;
  before?: string; // cursor: message ID
  after?: string; // cursor: message ID
  limit?: number;
}

export class MessageModel {
  async create(input: CreateMessageInput) {
    return prisma.iMMessage.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.senderId,
        type: input.type ?? 'text',
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
        parentId: input.parentId,
        status: 'sent',
        // E2E Signing fields (Layer 2)
        secVersion: input.secVersion,
        senderKeyId: input.senderKeyId,
        sequence: input.sequence,
        contentHash: input.contentHash,
        prevHash: input.prevHash,
        signature: input.signature,
      },
    });
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

  async update(
    id: string,
    data: { content?: string; metadata?: Record<string, unknown>; status?: string }
  ) {
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

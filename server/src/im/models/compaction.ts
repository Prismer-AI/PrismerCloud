/**
 * Prismer IM — Compaction Summary Model
 *
 * CRUD operations for im_compaction_summaries (Working Memory).
 */

import prisma from '../db';

export interface CreateCompactionData {
  conversationId: string;
  summary: string;
  messageRangeStart?: string;
  messageRangeEnd?: string;
  tokenCount: number;
}

export class CompactionModel {
  async create(data: CreateCompactionData) {
    return prisma.iMCompactionSummary.create({
      data: {
        conversationId: data.conversationId,
        summary: data.summary,
        messageRangeStart: data.messageRangeStart,
        messageRangeEnd: data.messageRangeEnd,
        tokenCount: data.tokenCount,
      },
    });
  }

  async findByConversation(conversationId: string) {
    return prisma.iMCompactionSummary.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findLatest(conversationId: string) {
    return prisma.iMCompactionSummary.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async delete(id: string) {
    return prisma.iMCompactionSummary.delete({ where: { id } });
  }
}

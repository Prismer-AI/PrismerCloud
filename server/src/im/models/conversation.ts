/**
 * Prismer IM — Conversation model
 *
 * Uses Prisma ORM with IMConversation model.
 */

import prisma from '../db';
import type { ConversationType, ConversationStatus } from '../types/index';

export interface CreateConversationInput {
  type: ConversationType;
  title?: string;
  description?: string;
  createdBy: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

export class ConversationModel {
  async create(input: CreateConversationInput) {
    return prisma.iMConversation.create({
      data: {
        type: input.type,
        title: input.title,
        description: input.description,
        createdById: input.createdBy,
        workspaceId: input.workspaceId,
        metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
      },
    });
  }

  async findById(id: string) {
    return prisma.iMConversation.findUnique({
      where: { id },
    });
  }

  async findByWorkspaceId(workspaceId: string) {
    return prisma.iMConversation.findUnique({
      where: { workspaceId },
    });
  }

  async listByUser(userId: string, status: ConversationStatus = 'active') {
    return prisma.iMParticipant.findMany({
      where: {
        imUserId: userId,
        leftAt: null,
        conversation: {
          status,
        },
      },
      include: {
        conversation: true,
      },
      orderBy: {
        conversation: {
          lastMessageAt: 'desc',
        },
      },
    });
  }

  async updateStatus(id: string, status: ConversationStatus) {
    return prisma.iMConversation.update({
      where: { id },
      data: { status },
    });
  }

  async update(
    id: string,
    data: Partial<Pick<CreateConversationInput, 'title' | 'description' | 'metadata'>>
  ) {
    return prisma.iMConversation.update({
      where: { id },
      data: {
        ...data,
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
      },
    });
  }

  async touchLastMessage(id: string) {
    return prisma.iMConversation.update({
      where: { id },
      data: { lastMessageAt: new Date() },
    });
  }

  async delete(id: string) {
    return prisma.iMConversation.delete({
      where: { id },
    });
  }
}

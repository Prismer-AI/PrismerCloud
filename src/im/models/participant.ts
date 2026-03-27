/**
 * Prismer IM — Participant model
 *
 * Uses Prisma ORM with IMParticipant model.
 */

import prisma from '../db';
import type { ParticipantRole } from '../types/index';

export interface AddParticipantInput {
  conversationId: string;
  userId: string;
  role?: ParticipantRole;
}

export class ParticipantModel {
  async add(input: AddParticipantInput) {
    // Use upsert to handle conflicts (already a participant)
    return prisma.iMParticipant.upsert({
      where: {
        conversationId_imUserId: {
          conversationId: input.conversationId,
          imUserId: input.userId,
        },
      },
      update: {
        leftAt: null, // Rejoin if previously left
        role: input.role ?? 'member',
      },
      create: {
        conversationId: input.conversationId,
        imUserId: input.userId,
        role: input.role ?? 'member',
      },
    });
  }

  async remove(conversationId: string, userId: string) {
    return prisma.iMParticipant.update({
      where: {
        conversationId_imUserId: {
          conversationId,
          imUserId: userId,
        },
      },
      data: { leftAt: new Date() },
    });
  }

  async listByConversation(conversationId: string) {
    return prisma.iMParticipant.findMany({
      where: {
        conversationId,
        leftAt: null,
      },
      include: {
        imUser: true,
      },
    });
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const participant = await prisma.iMParticipant.findFirst({
      where: {
        conversationId,
        imUserId: userId,
        leftAt: null,
      },
    });
    return !!participant;
  }

  async getRole(conversationId: string, userId: string): Promise<ParticipantRole | null> {
    const participant = await prisma.iMParticipant.findFirst({
      where: {
        conversationId,
        imUserId: userId,
        leftAt: null,
      },
    });
    return (participant?.role as ParticipantRole) ?? null;
  }
}

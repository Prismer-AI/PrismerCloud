/**
 * Prismer IM — User model (data access layer)
 *
 * Uses Prisma ORM with IMUser model.
 */

import prisma from '../db';
import type { UserRole, AgentType } from '../types/index';
import { generateIMUserId } from '../utils/id-gen';

export interface CreateUserInput {
  username: string;
  displayName: string;
  passwordHash?: string;
  role?: UserRole;
  agentType?: AgentType;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
  userId?: string; // Link to main User table
}

export class UserModel {
  async create(input: CreateUserInput) {
    const role = input.role ?? 'human';
    return prisma.iMUser.create({
      data: {
        id: generateIMUserId(role),
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role,
        agentType: input.agentType,
        avatarUrl: input.avatarUrl,
        metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
        userId: input.userId,
      },
    });
  }

  async findById(id: string) {
    return prisma.iMUser.findUnique({
      where: { id },
    });
  }

  async findByUsername(username: string) {
    return prisma.iMUser.findUnique({
      where: { username },
    });
  }

  async findByUserId(userId: string) {
    return prisma.iMUser.findUnique({
      where: { userId },
    });
  }

  async update(id: string, data: Partial<CreateUserInput>) {
    return prisma.iMUser.update({
      where: { id },
      data: {
        ...data,
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
      },
    });
  }

  async listByRole(role: UserRole) {
    return prisma.iMUser.findMany({
      where: { role },
    });
  }

  async delete(id: string) {
    return prisma.iMUser.delete({
      where: { id },
    });
  }
}

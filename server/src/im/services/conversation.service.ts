/**
 * Prismer IM — Conversation service
 *
 * Writes sync events for all mutations so offline SDK clients
 * stay in sync via GET /api/im/sync or SSE /api/im/sync/stream.
 */

import type Redis from 'ioredis';
import { ConversationModel } from '../models/conversation';
import { ParticipantModel } from '../models/participant';
import type { ConversationStatus, ParticipantRole } from '../types/index';
import type { SyncService } from './sync.service';
import prisma from '../db';

export interface CreateDirectInput {
  createdBy: string;
  otherUserId: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateGroupInput {
  createdBy: string;
  title: string;
  description?: string;
  memberIds: string[];
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

export class ConversationService {
  private convModel: ConversationModel;
  private participantModel: ParticipantModel;

  constructor(
    private redis: Redis,
    private syncService?: SyncService,
  ) {
    this.convModel = new ConversationModel();
    this.participantModel = new ParticipantModel();
  }

  /**
   * Write a sync event for all participants of a conversation.
   */
  private async writeSyncForParticipants(
    type: string,
    data: Record<string, unknown>,
    conversationId: string,
    participantIds?: string[],
  ): Promise<void> {
    if (!this.syncService) return;
    const ids =
      participantIds ??
      (await this.participantModel.listByConversation(conversationId)).map((p: { imUserId: string }) => p.imUserId);
    for (const userId of ids) {
      if (userId) {
        await this.syncService.writeEvent(type, data, conversationId, userId);
      }
    }
  }

  /**
   * Create a 1:1 direct conversation.
   */
  async createDirect(input: CreateDirectInput) {
    const participantWhere = [
      { participants: { some: { imUserId: input.createdBy, leftAt: null } } },
      { participants: { some: { imUserId: input.otherUserId, leftAt: null } } },
    ];
    const existing = await prisma.iMConversation.findFirst({
      where: {
        type: 'direct',
        status: { not: 'deleted' },
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        AND: participantWhere,
      },
    });
    if (existing) {
      if (existing.status === 'archived') {
        const reactivated = await prisma.iMConversation.update({
          where: { id: existing.id },
          data: { status: 'active' },
        });
        await this.writeSyncForParticipants('conversation.update', { id: existing.id, status: 'active' }, existing.id);
        return reactivated;
      }
      return existing;
    }

    if (input.workspaceId) {
      const legacy = await prisma.iMConversation.findFirst({
        where: {
          type: 'direct',
          status: { not: 'deleted' },
          workspaceId: null,
          AND: participantWhere,
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (legacy) {
        const patched = await prisma.iMConversation.update({
          where: { id: legacy.id },
          data: {
            workspaceId: input.workspaceId,
            ...(legacy.status === 'archived' ? { status: 'active' as ConversationStatus } : {}),
          },
        });
        await this.writeSyncForParticipants(
          'conversation.update',
          { id: legacy.id, workspaceId: input.workspaceId, status: patched.status },
          legacy.id,
        );
        return patched;
      }
    }

    const conv = await this.convModel.create({
      type: 'direct',
      createdBy: input.createdBy,
      workspaceId: input.workspaceId,
      metadata: input.metadata,
    });

    // Add both participants
    await this.participantModel.add({
      conversationId: conv.id,
      userId: input.createdBy,
      role: 'owner',
    });
    await this.participantModel.add({
      conversationId: conv.id,
      userId: input.otherUserId,
      role: 'member',
    });

    // v1.8.0 S3: Create security record with 'recommended' signing policy
    await prisma.iMConversationSecurity
      .create({
        data: { conversationId: conv.id, signingPolicy: 'recommended', encryptionMode: 'none' },
      })
      .catch(() => {}); // Ignore if already exists (race condition guard)

    // Sync event for both participants
    const participants = [input.createdBy, input.otherUserId];
    await this.writeSyncForParticipants(
      'conversation.create',
      { id: conv.id, type: 'direct', participants },
      conv.id,
      participants,
    );

    return conv;
  }

  /**
   * Create a group conversation.
   */
  async createGroup(input: CreateGroupInput) {
    const conv = await this.convModel.create({
      type: 'group',
      title: input.title,
      description: input.description,
      createdBy: input.createdBy,
      workspaceId: input.workspaceId,
      metadata: input.metadata,
    });

    // Add creator as owner
    await this.participantModel.add({
      conversationId: conv.id,
      userId: input.createdBy,
      role: 'owner',
    });

    // Add other members
    for (const memberId of input.memberIds) {
      if (memberId !== input.createdBy) {
        await this.participantModel.add({
          conversationId: conv.id,
          userId: memberId,
          role: 'member',
        });
      }
    }

    // v1.8.0 S3: Create security record with 'recommended' signing policy
    await prisma.iMConversationSecurity
      .create({
        data: { conversationId: conv.id, signingPolicy: 'recommended', encryptionMode: 'none' },
      })
      .catch(() => {});

    // Sync event for all members
    const allMembers = [input.createdBy, ...input.memberIds.filter((m) => m !== input.createdBy)];
    await this.writeSyncForParticipants(
      'conversation.create',
      { id: conv.id, type: 'group', title: input.title, members: allMembers },
      conv.id,
      allMembers,
    );

    return conv;
  }

  async getById(id: string) {
    return this.convModel.findById(id);
  }

  async getByWorkspaceId(workspaceId: string) {
    return this.convModel.findByWorkspaceId(workspaceId);
  }

  async listByUser(userId: string, status: ConversationStatus = 'active') {
    return this.convModel.listByUser(userId, status);
  }

  async archive(id: string) {
    const result = await this.convModel.updateStatus(id, 'archived');
    await this.writeSyncForParticipants('conversation.archive', { id }, id);
    return result;
  }

  async softDelete(id: string) {
    const result = await this.convModel.updateStatus(id, 'deleted');
    await this.writeSyncForParticipants('conversation.delete', { id }, id);
    return result;
  }

  async update(id: string, data: { title?: string; description?: string; metadata?: Record<string, unknown> }) {
    const result = await this.convModel.update(id, data);
    await this.writeSyncForParticipants('conversation.update', { id, ...data }, id);
    return result;
  }

  async addParticipant(conversationId: string, userId: string, role: ParticipantRole = 'member') {
    const result = await this.participantModel.add({ conversationId, userId, role });
    // Notify all existing participants + the new one
    await this.writeSyncForParticipants('participant.add', { conversationId, userId, role }, conversationId);
    return result;
  }

  async removeParticipant(conversationId: string, userId: string) {
    // Write sync event BEFORE removal so the removed user also sees it
    await this.writeSyncForParticipants('participant.remove', { conversationId, userId }, conversationId);
    return this.participantModel.remove(conversationId, userId);
  }

  async getParticipants(conversationId: string) {
    return this.participantModel.listByConversation(conversationId);
  }

  async getParticipantIds(conversationId: string): Promise<string[]> {
    const list = await this.participantModel.listByConversation(conversationId);
    return list.map((p: any) => p.imUserId);
  }

  async isParticipant(conversationId: string, userId: string) {
    return this.participantModel.isParticipant(conversationId, userId);
  }

  /**
   * release201/08 §3.0 — tag a conversation with one of the 4 skill-dev roles
   * (business | dev | test | review). Writes to `metadata.skillDev` and emits
   * a `conversation.update` sync event so Studio Lifecycle session-links can
   * surface the chain. Idempotent: re-applying the same role is a no-op.
   *
   * `parentConversationId` lets dev/test/review sessions link back to the
   * originating business session, forming the chain described in §3.0.
   */
  async setSkillDevRole(
    conversationId: string,
    skillDraftId: string,
    role: 'business' | 'dev' | 'test' | 'review',
    options: { projectId?: string; parentConversationId?: string } = {},
  ): Promise<{ conversationId: string; metadata: Record<string, unknown> }> {
    const existing = await prisma.iMConversation.findUnique({ where: { id: conversationId } });
    if (!existing) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    let metadata: Record<string, unknown> = {};
    try {
      const raw = (existing as { metadata?: unknown }).metadata;
      if (typeof raw === 'string') metadata = JSON.parse(raw) || {};
      else if (raw && typeof raw === 'object') metadata = raw as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    metadata.skillDev = {
      skillDraftId,
      role,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.parentConversationId ? { parentConversationId: options.parentConversationId } : {}),
      taggedAt: new Date().toISOString(),
    };
    await prisma.iMConversation.update({
      where: { id: conversationId },
      data: { metadata: JSON.stringify(metadata) as any },
    });
    await this.writeSyncForParticipants(
      'conversation.update',
      { id: conversationId, skillDev: metadata.skillDev },
      conversationId,
    );
    return { conversationId, metadata };
  }
}

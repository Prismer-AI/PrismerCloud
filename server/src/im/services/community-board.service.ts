/**
 * Prismer IM — Community Board Service
 *
 * Dynamic board management: CRUD, admin permissions, subscriptions.
 * System boards (showcase, genelab, helpdesk, ideas, changelog) are immutable.
 */

import { prisma } from '@/lib/prisma';

const LOG = '[CommunityBoard]';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const MAX_BOARDS_PER_USER = 5;
const MIN_KARMA_TO_CREATE = 50;

const SYSTEM_SLUGS = new Set(['showcase', 'genelab', 'helpdesk', 'ideas', 'changelog']);

// ─── Types ──────────────────────────────────────────────────

export interface BoardRules {
  allowedPostTypes?: string[];
  requireTags?: boolean;
  approvalRequired?: boolean;
}

export interface CreateBoardInput {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  rules?: BoardRules;
}

export interface UpdateBoardInput {
  name?: string;
  description?: string;
  icon?: string;
  rules?: BoardRules;
  status?: 'active' | 'archived' | 'hidden';
}

export class BoardNotFoundError extends Error {
  constructor(slug: string) {
    super(`Board not found: ${slug}`);
    this.name = 'BoardNotFoundError';
  }
}

export class BoardPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardPermissionError';
  }
}

// ─── Service ────────────────────────────────────────────────

export class CommunityBoardService {
  async listBoards(options?: { includeHidden?: boolean }) {
    const where: any = {};
    if (!options?.includeHidden) {
      where.status = 'active';
    }

    return prisma.iMCommunityBoard.findMany({
      where,
      orderBy: [{ isSystem: 'desc' }, { postCount: 'desc' }],
    });
  }

  async getBoardBySlug(slug: string) {
    const board = await prisma.iMCommunityBoard.findUnique({
      where: { slug },
    });
    if (!board || board.status === 'hidden') return null;
    return board;
  }

  async resolveSlugToId(slug: string): Promise<string | null> {
    const board = await prisma.iMCommunityBoard.findUnique({
      where: { slug },
      select: { id: true },
    });
    return board?.id ?? null;
  }

  async createBoard(creatorId: string, input: CreateBoardInput) {
    if (!SLUG_REGEX.test(input.slug)) {
      throw new Error('Invalid slug: must be 3-50 lowercase alphanumeric with hyphens');
    }

    if (SYSTEM_SLUGS.has(input.slug)) {
      throw new Error('Cannot use a system board slug');
    }

    const existing = await prisma.iMCommunityBoard.findUnique({
      where: { slug: input.slug },
    });
    if (existing) throw new Error('Board slug already taken');

    const userBoardCount = await prisma.iMCommunityBoard.count({
      where: { creatorId, isSystem: false },
    });
    if (userBoardCount >= MAX_BOARDS_PER_USER) {
      throw new Error(`Maximum ${MAX_BOARDS_PER_USER} boards per user`);
    }

    const board = await prisma.iMCommunityBoard.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description,
        icon: input.icon,
        creatorId,
        isSystem: false,
        rules: input.rules ? JSON.stringify(input.rules) : null,
      },
    });

    await prisma.iMCommunityBoardAdmin.create({
      data: { boardId: board.id, userId: creatorId, role: 'owner' },
    });

    console.log(`${LOG} Board created: ${board.slug} by ${creatorId}`);
    return board;
  }

  async updateBoard(slug: string, userId: string, input: UpdateBoardInput) {
    const board = await prisma.iMCommunityBoard.findUnique({ where: { slug } });
    if (!board) throw new BoardNotFoundError(slug);

    const adminRole = await this.getAdminRole(board.id, userId);
    if (adminRole !== 'owner') {
      throw new BoardPermissionError('Only board owner can update board settings');
    }

    const data: any = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.icon !== undefined) data.icon = input.icon;
    if (input.rules !== undefined) data.rules = JSON.stringify(input.rules);
    if (input.status !== undefined) {
      if (board.isSystem && input.status !== 'active') {
        throw new Error('Cannot change status of system boards');
      }
      data.status = input.status;
    }

    return prisma.iMCommunityBoard.update({ where: { slug }, data });
  }

  async deleteBoard(slug: string, userId: string) {
    const board = await prisma.iMCommunityBoard.findUnique({ where: { slug } });
    if (!board) throw new BoardNotFoundError(slug);
    if (board.isSystem) throw new Error('Cannot delete system boards');

    const adminRole = await this.getAdminRole(board.id, userId);
    if (adminRole !== 'owner') {
      throw new BoardPermissionError('Only board owner can delete the board');
    }

    await prisma.iMCommunityBoardAdmin.deleteMany({ where: { boardId: board.id } });
    await prisma.iMCommunityBoard.delete({ where: { slug } });
    console.log(`${LOG} Board deleted: ${slug}`);
    return true;
  }

  // ─── Admin Management ──────────────────────────────────────

  async getAdminRole(boardId: string, userId: string): Promise<'owner' | 'moderator' | null> {
    const admin = await prisma.iMCommunityBoardAdmin.findUnique({
      where: { boardId_userId: { boardId, userId } },
    });
    return (admin?.role as 'owner' | 'moderator') ?? null;
  }

  async listAdmins(boardId: string) {
    return prisma.iMCommunityBoardAdmin.findMany({ where: { boardId } });
  }

  async addModerator(slug: string, ownerId: string, targetUserId: string) {
    const board = await prisma.iMCommunityBoard.findUnique({ where: { slug } });
    if (!board) throw new BoardNotFoundError(slug);

    const ownerRole = await this.getAdminRole(board.id, ownerId);
    if (ownerRole !== 'owner') {
      throw new BoardPermissionError('Only board owner can add moderators');
    }

    return prisma.iMCommunityBoardAdmin.upsert({
      where: { boardId_userId: { boardId: board.id, userId: targetUserId } },
      create: { boardId: board.id, userId: targetUserId, role: 'moderator' },
      update: {},
    });
  }

  async removeModerator(slug: string, ownerId: string, targetUserId: string) {
    const board = await prisma.iMCommunityBoard.findUnique({ where: { slug } });
    if (!board) throw new BoardNotFoundError(slug);

    const ownerRole = await this.getAdminRole(board.id, ownerId);
    if (ownerRole !== 'owner') {
      throw new BoardPermissionError('Only board owner can remove moderators');
    }

    const target = await prisma.iMCommunityBoardAdmin.findUnique({
      where: { boardId_userId: { boardId: board.id, userId: targetUserId } },
    });
    if (!target || target.role === 'owner') {
      throw new Error('Cannot remove board owner');
    }

    await prisma.iMCommunityBoardAdmin.delete({
      where: { boardId_userId: { boardId: board.id, userId: targetUserId } },
    });
    return true;
  }

  // ─── Subscribe / Unsubscribe ───────────────────────────────

  async subscribe(slug: string, userId: string) {
    const board = await prisma.iMCommunityBoard.findUnique({ where: { slug } });
    if (!board) throw new BoardNotFoundError(slug);

    const existing = await prisma.iMCommunityFollow.findFirst({
      where: { followerId: userId, followingId: board.id, followingType: 'board' },
    });

    if (existing) {
      await prisma.iMCommunityFollow.delete({ where: { id: existing.id } });
      await prisma.iMCommunityBoard.update({
        where: { slug },
        data: { subscriberCount: { decrement: 1 } },
      });
      return { subscribed: false };
    }

    await prisma.iMCommunityFollow.create({
      data: { followerId: userId, followingId: board.id, followingType: 'board' },
    });
    await prisma.iMCommunityBoard.update({
      where: { slug },
      data: { subscriberCount: { increment: 1 } },
    });
    return { subscribed: true };
  }

  async getSubscribedBoards(userId: string) {
    const follows = await prisma.iMCommunityFollow.findMany({
      where: { followerId: userId, followingType: 'board' },
    });
    if (follows.length === 0) return [];

    return prisma.iMCommunityBoard.findMany({
      where: { id: { in: follows.map((f: { followingId: string }) => f.followingId) } },
    });
  }

  async isSubscribed(slug: string, userId: string): Promise<boolean> {
    const board = await prisma.iMCommunityBoard.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!board) return false;

    const follow = await prisma.iMCommunityFollow.findFirst({
      where: { followerId: userId, followingId: board.id, followingType: 'board' },
    });
    return !!follow;
  }

  // ─── Stats ─────────────────────────────────────────────────

  async incrementPostCount(boardId: string) {
    await prisma.iMCommunityBoard.update({
      where: { id: boardId },
      data: { postCount: { increment: 1 } },
    }).catch(() => {});
  }

  async decrementPostCount(boardId: string) {
    await prisma.iMCommunityBoard.update({
      where: { id: boardId },
      data: { postCount: { decrement: 1 } },
    }).catch(() => {});
  }
}

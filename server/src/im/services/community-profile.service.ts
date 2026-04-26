/**
 * Prismer IM — Community Profile Service
 *
 * Lazy-init profile for users on first community action.
 * Denormalized stats updated on each relevant action.
 */

import { prisma } from '@/lib/prisma';

const LOG = '[CommunityProfile]';

// ─── Types ──────────────────────────────────────────────────

export interface UpdateProfileInput {
  bio?: string;
  website?: string;
}

export interface ProfileStats {
  postCount: number;
  commentCount: number;
  karmaTotal: number;
  followerCount: number;
  followingCount: number;
  streakDays: number;
  lastActiveAt: Date | null;
}

// ─── Service ────────────────────────────────────────────────

export class CommunityProfileService {

  async getOrCreate(userId: string) {
    let profile = await prisma.iMCommunityProfile.findUnique({
      where: { id: userId },
    });

    if (!profile) {
      profile = await prisma.iMCommunityProfile.create({
        data: { id: userId, lastActiveAt: new Date() },
      });
      console.log(`${LOG} Profile created for ${userId}`);
    }

    return profile;
  }

  async getProfile(userId: string) {
    return prisma.iMCommunityProfile.findUnique({ where: { id: userId } });
  }

  async updateProfile(userId: string, input: UpdateProfileInput) {
    await this.getOrCreate(userId);

    return prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: {
        bio: input.bio,
        website: input.website,
      },
    });
  }

  async getEnrichedProfile(userId: string) {
    const [profile, user, badges] = await Promise.all([
      this.getOrCreate(userId),
      prisma.iMUser.findUnique({
        where: { id: userId },
        select: { id: true, username: true, displayName: true, role: true, avatarUrl: true, createdAt: true },
      }),
      prisma.iMEvolutionAchievement.findMany({
        where: { ownerId: userId },
        select: { badge: true, awardedAt: true },
        orderBy: { awardedAt: 'desc' },
      }).catch(() => []),
    ]);

    return { ...profile, user, badges };
  }

  // ─── Stat increments ──────────────────────────────────────

  async incrementPostCount(userId: string) {
    await this.ensureProfile(userId);
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { postCount: { increment: 1 }, lastActiveAt: new Date() },
    }).catch(() => {});
  }

  async decrementPostCount(userId: string) {
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { postCount: { decrement: 1 } },
    }).catch(() => {});
  }

  async incrementCommentCount(userId: string) {
    await this.ensureProfile(userId);
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { commentCount: { increment: 1 }, lastActiveAt: new Date() },
    }).catch(() => {});
  }

  async decrementCommentCount(userId: string) {
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { commentCount: { decrement: 1 } },
    }).catch(() => {});
  }

  async updateKarma(userId: string, delta: number) {
    await this.ensureProfile(userId);
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { karmaTotal: { increment: delta } },
    }).catch(() => {});
  }

  async incrementFollowerCount(userId: string) {
    await this.ensureProfile(userId);
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { followerCount: { increment: 1 } },
    }).catch(() => {});
  }

  async decrementFollowerCount(userId: string) {
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { followerCount: { decrement: 1 } },
    }).catch(() => {});
  }

  async incrementFollowingCount(userId: string) {
    await this.ensureProfile(userId);
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { followingCount: { increment: 1 } },
    }).catch(() => {});
  }

  async decrementFollowingCount(userId: string) {
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { followingCount: { decrement: 1 } },
    }).catch(() => {});
  }

  async touchActive(userId: string) {
    await this.ensureProfile(userId);
    await prisma.iMCommunityProfile.update({
      where: { id: userId },
      data: { lastActiveAt: new Date() },
    }).catch(() => {});
  }

  // ─── Activity heatmap ─────────────────────────────────────

  async getActivityHeatmap(userId: string, weeks = 52) {
    const since = new Date();
    since.setDate(since.getDate() - weeks * 7);

    const [posts, comments, votes] = await Promise.all([
      prisma.iMCommunityPost.findMany({
        where: { authorId: userId, createdAt: { gte: since }, deletedAt: null },
        select: { createdAt: true },
      }),
      prisma.iMCommunityComment.findMany({
        where: { authorId: userId, createdAt: { gte: since }, deletedAt: null },
        select: { createdAt: true },
      }),
      prisma.iMCommunityVote.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
    ]);

    const dayMap = new Map<string, number>();
    const addDay = (d: Date) => {
      const key = d.toISOString().slice(0, 10);
      dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
    };

    posts.forEach((p: { createdAt: Date }) => addDay(p.createdAt));
    comments.forEach((c: { createdAt: Date }) => addDay(c.createdAt));
    votes.forEach((v: { createdAt: Date }) => addDay(v.createdAt));

    return Object.fromEntries(dayMap);
  }

  // ─── Streak calculation (for cron) ─────────────────────────

  async updateStreaks() {
    const profiles = await prisma.iMCommunityProfile.findMany({
      where: { lastActiveAt: { not: null } },
      select: { id: true, lastActiveAt: true, streakDays: true },
    });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    for (const p of profiles) {
      if (!p.lastActiveAt) continue;
      const lastDay = p.lastActiveAt.toISOString().slice(0, 10);

      if (lastDay === today || lastDay === yesterday) {
        continue;
      }

      if (p.streakDays > 0) {
        await prisma.iMCommunityProfile.update({
          where: { id: p.id },
          data: { streakDays: 0 },
        }).catch(() => {});
      }
    }
  }

  // ─── Private ───────────────────────────────────────────────

  private async ensureProfile(userId: string) {
    const exists = await prisma.iMCommunityProfile.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) {
      await prisma.iMCommunityProfile.create({
        data: { id: userId, lastActiveAt: new Date() },
      }).catch(() => {});
    }
  }
}

/**
 * Prismer IM — Community Follow Service
 *
 * Toggle follow on users/genes (and schema-supported types); list following/followers.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export type CommunityFollowingType = "user" | "gene" | "agent" | "board";

export class CommunityFollowService {
  constructor(private prisma: PrismaClient) {}

  async follow(
    followerId: string,
    followingId: string,
    followingType: CommunityFollowingType = "user",
  ): Promise<{ followed: boolean }> {
    const existing = await this.prisma.iMCommunityFollow.findFirst({
      where: { followerId, followingId, followingType },
    });

    if (existing) {
      await this.prisma.iMCommunityFollow.delete({ where: { id: existing.id } });
      console.log(`[CommunityFollow] ${followerId} unfollowed ${followingType}:${followingId}`);
      return { followed: false };
    }

    await this.prisma.iMCommunityFollow.create({
      data: { followerId, followingId, followingType },
    });
    console.log(`[CommunityFollow] ${followerId} followed ${followingType}:${followingId}`);
    return { followed: true };
  }

  async getFollowing(
    userId: string,
    type?: string,
  ): Promise<Array<{ followingId: string; followingType: string; createdAt: Date }>> {
    const where: Prisma.IMCommunityFollowWhereInput = { followerId: userId };
    if (type) where.followingType = type;

    return this.prisma.iMCommunityFollow.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: { followingId: true, followingType: true, createdAt: true },
    });
  }

  async getFollowers(userId: string): Promise<Array<{ followerId: string; createdAt: Date }>> {
    return this.prisma.iMCommunityFollow.findMany({
      where: { followingId: userId, followingType: "user" },
      orderBy: { createdAt: "desc" },
      select: { followerId: true, createdAt: true },
    });
  }

  async getFollowerCount(userId: string): Promise<number> {
    return this.prisma.iMCommunityFollow.count({
      where: { followingId: userId, followingType: "user" },
    });
  }

  async isFollowing(
    followerId: string,
    followingId: string,
    followingType: CommunityFollowingType | string = "user",
  ): Promise<boolean> {
    const count = await this.prisma.iMCommunityFollow.count({
      where: { followerId, followingId, followingType },
    });
    return count > 0;
  }
}

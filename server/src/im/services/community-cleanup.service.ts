import { PrismaClient } from '@prisma/client';

export class CommunityCleanupService {
  constructor(private prisma: PrismaClient) {}

  async cleanupSoftDeletedPosts(
    daysOld = 30
  ): Promise<{ postsRemoved: number; commentsRemoved: number }> {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

    const postsToDelete = await this.prisma.iMCommunityPost.findMany({
      where: {
        deletedAt: { not: null, lt: cutoff },
      },
      select: { id: true },
    });

    if (postsToDelete.length === 0) {
      console.log('[CommunityCleanup] No soft-deleted posts older than cutoff');
      return { postsRemoved: 0, commentsRemoved: 0 };
    }

    const postIds = postsToDelete.map((p) => p.id);

    const result = await this.prisma.$transaction(async (tx) => {
      const commentRows = await tx.iMCommunityComment.findMany({
        where: { postId: { in: postIds } },
        select: { id: true },
      });
      const commentIds = commentRows.map((c) => c.id);

      await tx.iMCommunityVote.deleteMany({
        where: {
          OR: [
            { targetType: 'post', targetId: { in: postIds } },
            { targetType: 'comment', targetId: { in: commentIds } },
          ],
        },
      });

      await tx.iMCommunityBookmark.deleteMany({
        where: { postId: { in: postIds } },
      });

      await tx.iMCommunityPostTag.deleteMany({
        where: { postId: { in: postIds } },
      });

      const commentsResult = await tx.iMCommunityComment.deleteMany({
        where: { postId: { in: postIds } },
      });

      const postsResult = await tx.iMCommunityPost.deleteMany({
        where: { id: { in: postIds } },
      });

      return {
        postsRemoved: postsResult.count,
        commentsRemoved: commentsResult.count,
      };
    });

    console.log(
      `[CommunityCleanup] Cleaned up ${result.postsRemoved} posts and ${result.commentsRemoved} comments`
    );
    return result;
  }

  async archiveStalePostsCron(daysInactive = 90, minUpvotes = 2): Promise<number> {
    const cutoff = new Date(Date.now() - daysInactive * 24 * 60 * 60 * 1000);

    const result = await this.prisma.iMCommunityPost.updateMany({
      where: {
        updatedAt: { lt: cutoff },
        upvotes: { lt: minUpvotes },
        commentCount: 0,
        status: 'active',
        deletedAt: null,
      },
      data: { status: 'archived' },
    });

    if (result.count > 0) {
      console.log(`[CommunityCleanup] Archived ${result.count} stale posts`);
    }
    return result.count;
  }
}

import { PrismaClient } from '@prisma/client';

const DELETED_USER_ID = 'DELETED_USER';

export class CommunityGdprService {
  constructor(private prisma: PrismaClient) {}

  async anonymizeUser(userId: string): Promise<{
    postsAnonymized: number;
    commentsAnonymized: number;
    votesDeleted: number;
    bookmarksDeleted: number;
    followsDeleted: number;
    profilesDeleted: number;
    draftsDeleted: number;
  }> {
    console.log(`[CommunityGDPR] Starting anonymization for user ${userId}`);

    const result = await this.prisma.$transaction(async (tx) => {
      const postsResult = await tx.iMCommunityPost.updateMany({
        where: { authorId: userId },
        data: { authorId: DELETED_USER_ID, authorType: 'deleted' },
      });

      const commentsResult = await tx.iMCommunityComment.updateMany({
        where: { authorId: userId },
        data: { authorId: DELETED_USER_ID, authorType: 'deleted' },
      });

      const votesResult = await tx.iMCommunityVote.deleteMany({
        where: { userId },
      });

      const bookmarksResult = await tx.iMCommunityBookmark.deleteMany({
        where: { userId },
      });

      const followsResult = await tx.iMCommunityFollow.deleteMany({
        where: {
          OR: [{ followerId: userId }, { followingId: userId, followingType: 'user' }],
        },
      });

      // Profile is 1:1 with im_users (id = userId), contains personal data (bio, website)
      const profileResult = await tx.iMCommunityProfile.deleteMany({
        where: { id: userId },
      });

      // Drafts are personal content, delete entirely
      const draftsResult = await tx.iMCommunityDraft.deleteMany({
        where: { authorId: userId },
      });

      return {
        postsAnonymized: postsResult.count,
        commentsAnonymized: commentsResult.count,
        votesDeleted: votesResult.count,
        bookmarksDeleted: bookmarksResult.count,
        followsDeleted: followsResult.count,
        profilesDeleted: profileResult.count,
        draftsDeleted: draftsResult.count,
      };
    });

    console.log(`[CommunityGDPR] Anonymization complete for ${userId}:`, result);
    return result;
  }
}

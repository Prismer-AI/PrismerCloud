/**
 * Prismer IM — Community Draft Service
 *
 * Auto-save drafts with 7-day TTL, per-user listing, and expired draft cleanup.
 */

import { prisma } from '@/lib/prisma';

const LOG = '[CommunityDraft]';
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Types ──────────────────────────────────────────────────

export interface SaveDraftInput {
  boardSlug?: string;
  title?: string;
  contentJson?: string;
  content?: string;
}

// ─── Service ────────────────────────────────────────────────

export class CommunityDraftService {

  async saveDraft(authorId: string, input: SaveDraftInput, draftId?: string) {
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);

    if (draftId) {
      const existing = await prisma.iMCommunityDraft.findFirst({
        where: { id: draftId, authorId },
      });

      if (existing) {
        return prisma.iMCommunityDraft.update({
          where: { id: draftId },
          data: {
            boardSlug: input.boardSlug ?? existing.boardSlug,
            title: input.title ?? existing.title,
            contentJson: input.contentJson ?? existing.contentJson,
            content: input.content ?? existing.content,
            expiresAt,
          },
        });
      }
    }

    const draft = await prisma.iMCommunityDraft.create({
      data: {
        authorId,
        boardSlug: input.boardSlug,
        title: input.title,
        contentJson: input.contentJson,
        content: input.content,
        expiresAt,
      },
    });

    console.log(`${LOG} Draft saved: ${draft.id} for user ${authorId}`);
    return draft;
  }

  async getDraft(draftId: string, authorId: string) {
    return prisma.iMCommunityDraft.findFirst({
      where: { id: draftId, authorId, expiresAt: { gt: new Date() } },
    });
  }

  async listDrafts(authorId: string) {
    return prisma.iMCommunityDraft.findMany({
      where: { authorId, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async deleteDraft(draftId: string, authorId: string): Promise<boolean> {
    const draft = await prisma.iMCommunityDraft.findFirst({
      where: { id: draftId, authorId },
    });
    if (!draft) return false;

    await prisma.iMCommunityDraft.delete({ where: { id: draftId } });
    return true;
  }

  async cleanupExpired(): Promise<number> {
    const result = await prisma.iMCommunityDraft.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    if (result.count > 0) {
      console.log(`${LOG} Cleaned up ${result.count} expired drafts`);
    }
    return result.count;
  }
}

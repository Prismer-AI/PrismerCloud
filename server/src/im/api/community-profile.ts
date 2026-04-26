/**
 * Prismer IM — Community Profile & Draft & Follow API
 *
 * Profile: get/update, activity heatmap, enriched view.
 * Drafts: save/list/get/delete.
 * Follow: follow/unfollow users/agents/genes.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { CommunityProfileService } from '../services/community-profile.service';
import type { CommunityDraftService } from '../services/community-draft.service';
import type { CommunityFollowService } from '../services/community-follow.service';
import type { RateLimiterService } from '../services/rate-limiter.service';

export function createCommunityProfileRouter(
  profileService: CommunityProfileService,
  draftService: CommunityDraftService,
  followService: CommunityFollowService,
  rateLimiter?: RateLimiterService,
) {
  const router = new Hono();

  // ─── Profile (Public) ──────────────────────────────────────

  router.get('/profile/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const enriched = await profileService.getEnrichedProfile(userId);
      return c.json<ApiResponse>({ ok: true, data: enriched });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/profile/:userId/heatmap', async (c) => {
    try {
      const userId = c.req.param('userId');
      const weeks = Math.min(parseInt(c.req.query('weeks') || '52', 10), 104);
      const heatmap = await profileService.getActivityHeatmap(userId, weeks);
      return c.json<ApiResponse>({ ok: true, data: heatmap });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  // ─── Profile (Authenticated) ───────────────────────────────

  router.get('/me/profile', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const profile = await profileService.getOrCreate(user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: profile });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.put('/me/profile', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const body = await c.req.json();
      const updated = await profileService.updateProfile(user.imUserId, {
        bio: body.bio,
        website: body.website,
      });
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  // ─── Follow ────────────────────────────────────────────────

  router.post('/follow', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const { followingId, followingType } = await c.req.json();

      if (!followingId || !followingType) {
        return c.json<ApiResponse>({ ok: false, error: 'followingId and followingType required' }, 400);
      }

      const validTypes = ['user', 'agent', 'gene'];
      if (!validTypes.includes(followingType)) {
        return c.json<ApiResponse>({ ok: false, error: `followingType must be one of: ${validTypes.join(', ')}` }, 400);
      }

      const result = await followService.follow(user.imUserId, followingId, followingType);

      if (result.followed) {
        profileService.incrementFollowingCount(user.imUserId).catch(() => {});
        if (followingType === 'user' || followingType === 'agent') {
          profileService.incrementFollowerCount(followingId).catch(() => {});
        }
      } else {
        profileService.decrementFollowingCount(user.imUserId).catch(() => {});
        if (followingType === 'user' || followingType === 'agent') {
          profileService.decrementFollowerCount(followingId).catch(() => {});
        }
      }

      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/following', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const type = c.req.query('type') || undefined;
      const following = await followService.getFollowing(user.imUserId, type);
      return c.json<ApiResponse>({ ok: true, data: following });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/followers/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const followers = await followService.getFollowers(userId);
      return c.json<ApiResponse>({ ok: true, data: followers });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/is-following/:followingId', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const followingId = c.req.param('followingId');
      const type = c.req.query('type') || 'user';
      const isFollowing = await followService.isFollowing(user.imUserId, followingId, type);
      return c.json<ApiResponse>({ ok: true, data: { isFollowing } });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  // ─── Drafts ────────────────────────────────────────────────

  router.post('/drafts', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const body = await c.req.json();
      const draft = await draftService.saveDraft(user.imUserId, {
        boardSlug: body.boardSlug,
        title: body.title,
        contentJson: body.contentJson,
        content: body.content,
      }, body.draftId);
      return c.json<ApiResponse>({ ok: true, data: draft });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/drafts', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const drafts = await draftService.listDrafts(user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: drafts });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/drafts/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const id = c.req.param('id');
      const draft = await draftService.getDraft(id, user.imUserId);
      if (!draft) {
        return c.json<ApiResponse>({ ok: false, error: 'Draft not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: draft });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.delete('/drafts/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const id = c.req.param('id');
      const deleted = await draftService.deleteDraft(id, user.imUserId);
      if (!deleted) {
        return c.json<ApiResponse>({ ok: false, error: 'Draft not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: { deleted: true } });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  return router;
}

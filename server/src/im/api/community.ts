/**
 * Prismer IM — Community API
 *
 * Community forum endpoints: posts, comments, votes, bookmarks, stats.
 * Public GET routes (no auth) for SEO/anonymous browsing.
 * POST/PUT/DELETE routes require authentication.
 *
 * @see docs/DESIGN-COMMUNITY.md §5
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { CommunityService } from '../services/community.service';
import type { CommunitySearchService } from '../services/community-search.service';
import type { CommunityAutoService } from '../services/community-auto.service';
import type { CommunityGdprService } from '../services/community-gdpr.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { searchGeneNames, searchSkillNames } from '../services/community-markdown';
import { CommunityNotificationService } from '../services/community-notification.service';
import { createModuleLogger } from '@/lib/logger';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const log = createModuleLogger('Community');

// Agent post rate limit: 1 post per 10 minutes per user
const AGENT_POST_COOLDOWN_MS = 10 * 60 * 1000;
const agentPostTimestamps = new Map<string, number>();

export function createCommunityRouter(
  communityService: CommunityService,
  rateLimiter?: RateLimiterService,
  searchService?: CommunitySearchService,
  autoService?: CommunityAutoService,
  gdprService?: CommunityGdprService,
) {
  const router = new Hono();

  // ─── Posts (Public) ─────────────────────────────────────────

  /**
   * GET /posts — List posts (public, cursor-based pagination)
   * Query: ?boardSlug=showcase&sort=hot&period=week&authorType=all&cursor=xxx&limit=20
   *        &postType=battleReport&tag=timeout&authorId=xxx&geneId=xxx&q=search
   *        (boardId accepted as alias for backwards compatibility)
   */
  router.get('/posts', async (c) => {
    try {
      const boardId = c.req.query('boardSlug') || c.req.query('boardId');
      const sort = (c.req.query('sort') as any) || 'hot';
      const period = (c.req.query('period') as any) || 'week';
      const authorType = (c.req.query('authorType') as any) || 'all';
      const cursor = c.req.query('cursor');
      const page = c.req.query('page') ? parseInt(c.req.query('page')!, 10) : undefined;
      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
      const postType = c.req.query('postType') || undefined;
      const tag = c.req.query('tag') || undefined;
      const authorId = c.req.query('authorId') || undefined;
      const geneId = c.req.query('geneId') || undefined;
      const q = c.req.query('q') || undefined;

      const data = await communityService.listPosts({
        boardId,
        sort,
        period,
        authorType,
        cursor,
        page,
        limit,
        postType,
        tag,
        authorId,
        geneId,
        q,
      });

      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * GET /hot — Community Hero: top hot posts (public, for SDK `prismer community hot`)
   */
  router.get('/hot', async (c) => {
    try {
      const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 50);
      const period = (c.req.query('period') as any) || 'week';
      const data = await communityService.listPosts({ sort: 'hot', period, limit });
      return c.json<ApiResponse>({ ok: true, data: data.posts });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * GET /tags/trending — Trending tags (public)
   */
  router.get('/tags/trending', async (c) => {
    try {
      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
      const tags = await communityService.getTrendingTags(limit);
      return c.json<ApiResponse>({ ok: true, data: tags });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * GET /tags/search?q=xxx — Search tags by name prefix (public)
   */
  router.get('/tags/search', async (c) => {
    try {
      const q = c.req.query('q') || '';
      if (!q.trim()) return c.json<ApiResponse>({ ok: true, data: [] });
      const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 30);
      const tags = await communityService.searchTags(q, limit);
      c.header('Cache-Control', 'public, max-age=30');
      return c.json<ApiResponse>({ ok: true, data: tags });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * PUT /tags/:id — Rename a tag (auth required)
   */
  router.put('/tags/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      if (user.role !== 'admin') {
        return c.json<ApiResponse>({ ok: false, error: 'Admin access required' }, 403);
      }
      const tagId = c.req.param('id');
      const body = await c.req.json();
      const { name } = body;
      if (!name || typeof name !== 'string') return c.json<ApiResponse>({ ok: false, error: 'name is required' }, 400);
      const tag = await communityService.renameTag(tagId, name, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: tag });
    } catch (err: any) {
      const status = err.message === 'Tag name already exists' ? 409 : err.message === 'Invalid tag name' ? 400 : 500;
      return c.json<ApiResponse>({ ok: false, error: err.message }, status);
    }
  });

  /**
   * POST /tags/merge — Merge source tag into target (auth required)
   */
  router.post('/tags/merge', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      if (user.role !== 'admin') {
        return c.json<ApiResponse>({ ok: false, error: 'Admin access required' }, 403);
      }
      const body = await c.req.json();
      const { sourceTagId, targetTagId } = body;
      if (!sourceTagId || !targetTagId)
        return c.json<ApiResponse>({ ok: false, error: 'sourceTagId and targetTagId required' }, 400);
      const tag = await communityService.mergeTags(sourceTagId, targetTagId, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: tag });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * DELETE /tags/:id — Delete a tag (auth required)
   */
  router.delete('/tags/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      if (user.role !== 'admin') {
        return c.json<ApiResponse>({ ok: false, error: 'Admin access required' }, 403);
      }
      const tagId = c.req.param('id');
      const result = await communityService.deleteTag(tagId, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * GET /posts/:id — Get post detail (public)
   */
  router.get('/posts/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const post = await communityService.getPost(id);
      if (!post) {
        return c.json<ApiResponse>({ ok: false, error: 'Post not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: post });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Posts (Authenticated) ──────────────────────────────────

  /**
   * POST /posts — Create post (auth required)
   */
  router.post('/posts', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const body = await c.req.json();

      const boardId = body.boardSlug || body.boardId || null;
      if (!body.title || !body.content) {
        return c.json<ApiResponse>({ ok: false, error: 'title and content are required' }, 400);
      }

      const authorType = user.role === 'agent' ? 'agent' : 'human';

      // Agent post rate limit: 1 post per 10 minutes
      if (authorType === 'agent') {
        const lastPost = agentPostTimestamps.get(user.imUserId);
        if (lastPost && Date.now() - lastPost < AGENT_POST_COOLDOWN_MS) {
          const waitSec = Math.ceil((AGENT_POST_COOLDOWN_MS - (Date.now() - lastPost)) / 1000);
          return c.json<ApiResponse>({ ok: false, error: `Agent post rate limited. Try again in ${waitSec}s.` }, 429);
        }
      }

      const post = await communityService.createPost(user.imUserId, {
        title: body.title,
        content: body.content,
        contentHtml: body.contentHtml,
        contentJson: body.contentJson,
        boardId,
        authorType,
        postType: body.postType,
        tags: body.tags,
        linkedGeneIds: body.linkedGeneIds,
        linkedSkillIds: body.linkedSkillIds,
        linkedAgentId: body.linkedAgentId,
        linkedCapsuleId: body.linkedCapsuleId,
        attachments: body.attachments,
        autoGenerated: body.autoGenerated,
      });

      // Record timestamp for agent rate limiting
      if (authorType === 'agent') {
        agentPostTimestamps.set(user.imUserId, Date.now());
      }

      return c.json<ApiResponse>({ ok: true, data: post }, 201);
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * PUT /posts/:id — Update post (auth, only author)
   */
  router.put('/posts/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const id = c.req.param('id');
      const body = await c.req.json();

      const updateInput: any = { ...body };
      if (user.role !== 'admin') {
        delete updateInput.pinned;
        delete updateInput.featured;
      }
      const post = await communityService.updatePost(id, user.imUserId, updateInput);
      if (!post) {
        return c.json<ApiResponse>({ ok: false, error: 'Post not found or not author' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: post });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * DELETE /posts/:id — Delete post (auth, author or admin)
   */
  router.delete('/posts/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const id = c.req.param('id');

      const deleted = await communityService.deletePost(id, user.imUserId, user.role);
      if (!deleted) {
        return c.json<ApiResponse>({ ok: false, error: 'Post not found or not authorized' }, 404);
      }
      return c.json<ApiResponse>({ ok: true });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Comments (Public) ──────────────────────────────────────

  /**
   * GET /posts/:id/comments — List comments (public, board-aware sorting)
   * Query: ?sort=time|votes|best_first&commentType=all|answer|reply&cursor=xxx&limit=30
   */
  router.get('/posts/:id/comments', async (c) => {
    try {
      const postId = c.req.param('id');
      const sort = (c.req.query('sort') as any) || undefined;
      const commentType = (c.req.query('commentType') as any) || 'all';
      const cursor = c.req.query('cursor');
      const limit = Math.min(parseInt(c.req.query('limit') || '30', 10), 100);

      const data = await communityService.listComments(postId, {
        sort,
        commentType,
        cursor,
        limit,
      });

      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Comments (Authenticated) ──────────────────────────────

  /**
   * POST /posts/:id/comments — Create comment (auth)
   */
  router.post('/posts/:id/comments', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const postId = c.req.param('id');
      const body = await c.req.json();

      if (!body.content) {
        return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
      }

      const authorType = user.role === 'agent' ? 'agent' : 'human';
      const comment = await communityService.createComment(postId, user.imUserId, {
        content: body.content,
        contentHtml: body.contentHtml,
        parentId: body.parentId,
        commentType: body.commentType,
        linkedGeneIds: body.linkedGeneIds,
        metrics: body.metrics,
        autoGenerated: body.autoGenerated,
        authorType,
      });
      return c.json<ApiResponse>({ ok: true, data: comment }, 201);
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * PUT /comments/:id — Update comment (auth, only author)
   */
  router.put('/comments/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const id = c.req.param('id');
      const body = await c.req.json();

      const comment = await communityService.updateComment(id, user.imUserId, body);
      if (!comment) {
        return c.json<ApiResponse>({ ok: false, error: 'Comment not found or not author' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: comment });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * DELETE /comments/:id — Delete comment (auth, soft delete)
   */
  router.delete('/comments/:id', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const id = c.req.param('id');

      const deleted = await communityService.deleteComment(id, user.imUserId, user.role);
      if (!deleted) {
        return c.json<ApiResponse>({ ok: false, error: 'Comment not found or not authorized' }, 404);
      }
      return c.json<ApiResponse>({ ok: true });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * POST /comments/:id/best-answer — Mark best answer (auth, only post author)
   */
  router.post('/comments/:id/best-answer', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const commentId = c.req.param('id');

      const result = await communityService.markBestAnswer(commentId, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Interactions (Authenticated) ──────────────────────────

  /**
   * POST /vote — Vote on post or comment (auth)
   * Body: { targetType: 'post'|'comment', targetId: string, value: 1|-1|0 }
   *
   * Rate limiting handled by the global api.write limiter in routes.ts
   */
  router.post('/vote', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const body = await c.req.json();

      if (!body.targetType || !body.targetId || body.value === undefined) {
        return c.json<ApiResponse>({ ok: false, error: 'targetType, targetId, and value are required' }, 400);
      }
      if (!['post', 'comment'].includes(body.targetType)) {
        return c.json<ApiResponse>({ ok: false, error: 'targetType must be "post" or "comment"' }, 400);
      }
      if (![1, -1, 0].includes(body.value)) {
        return c.json<ApiResponse>({ ok: false, error: 'value must be 1, -1, or 0' }, 400);
      }

      const result = await communityService.vote(user.imUserId, {
        targetType: body.targetType,
        targetId: body.targetId,
        value: body.value,
      });

      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * POST /bookmark — Toggle bookmark (auth)
   * Body: { postId: string }
   */
  router.post('/bookmark', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const body = await c.req.json();

      if (!body.postId) {
        return c.json<ApiResponse>({ ok: false, error: 'postId is required' }, 400);
      }

      const result = await communityService.toggleBookmark(user.imUserId, body.postId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Attachment Upload ────────────────────────────────────────

  const UPLOAD_MAX_SIZE = 10 * 1024 * 1024; // 10MB
  const UPLOAD_ALLOWED_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
  ];
  const UPLOAD_DIR = path.resolve(process.cwd(), 'prisma/data/community-uploads');

  function getExtFromContentType(ct: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'application/pdf': 'pdf',
    };
    return map[ct] || 'bin';
  }

  /**
   * POST /upload/presign — Generate upload URL
   */
  router.post('/upload/presign', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const body = await c.req.json();
      const { filename, contentType, size } = body;

      if (!filename || !contentType || !size) {
        return c.json<ApiResponse>({ ok: false, error: 'filename, contentType, and size are required' }, 400);
      }
      if (size > UPLOAD_MAX_SIZE) {
        return c.json<ApiResponse>({ ok: false, error: `File too large. Max ${UPLOAD_MAX_SIZE / 1024 / 1024}MB` }, 400);
      }
      if (
        !UPLOAD_ALLOWED_TYPES.some((t) => contentType === t || (t === 'image/*' && contentType.startsWith('image/')))
      ) {
        if (!UPLOAD_ALLOWED_TYPES.includes(contentType)) {
          return c.json<ApiResponse>({ ok: false, error: `Content type ${contentType} not allowed` }, 400);
        }
      }

      const ext = getExtFromContentType(contentType);
      const rand = crypto.randomBytes(8).toString('hex');
      const key = `community/${user.imUserId}/${Date.now()}-${rand}.${ext}`;

      if (process.env.COMMUNITY_UPLOAD_BUCKET) {
        // S3-compatible presigned URL (placeholder for future implementation)
        return c.json<ApiResponse>({
          ok: true,
          data: {
            uploadUrl: `https://${process.env.COMMUNITY_UPLOAD_BUCKET}/${key}?presigned=true`,
            key,
            publicUrl: `https://${process.env.COMMUNITY_UPLOAD_BUCKET}/${key}`,
          },
        });
      }

      // Local file storage fallback
      const uploadUrl = `/api/im/community/upload/${key}`;
      const publicUrl = `/api/im/community/upload/${key}`;

      return c.json<ApiResponse>({ ok: true, data: { uploadUrl, key, publicUrl } });
    } catch (err: any) {
      console.error('[Community] Upload presign error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * PUT /upload/:key{.+} — Save uploaded file (local mode)
   */
  router.put('/upload/*', authMiddleware, async (c) => {
    try {
      const key = c.req.path.replace(/^\/upload\//, '');
      if (!key || key.includes('..')) {
        return c.json<ApiResponse>({ ok: false, error: 'Invalid key' }, 400);
      }

      const user = c.get('user');
      // Verify the key belongs to this user
      if (!key.startsWith(`community/${user.imUserId}/`)) {
        return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
      }

      const body = await c.req.arrayBuffer();
      if (body.byteLength > UPLOAD_MAX_SIZE) {
        return c.json<ApiResponse>({ ok: false, error: 'File too large' }, 400);
      }

      const filePath = path.join(UPLOAD_DIR, key);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(body));

      console.log(`[Community] File uploaded: ${key} (${body.byteLength} bytes)`);
      return c.json<ApiResponse>({ ok: true, data: { key, size: body.byteLength } });
    } catch (err: any) {
      console.error('[Community] Upload error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * GET /upload/:key{.+} — Serve uploaded file (local mode)
   */
  router.get('/upload/*', async (c) => {
    try {
      const key = c.req.path.replace(/^\/upload\//, '');
      if (!key || key.includes('..')) {
        return c.json<ApiResponse>({ ok: false, error: 'Invalid key' }, 400);
      }

      const filePath = path.join(UPLOAD_DIR, key);
      if (!fs.existsSync(filePath)) {
        return c.json<ApiResponse>({ ok: false, error: 'File not found' }, 404);
      }

      const ext = path.extname(filePath).slice(1);
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
      };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      const data = fs.readFileSync(filePath);

      c.header('Content-Type', contentType);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(data);
    } catch (err: any) {
      console.error('[Community] Upload serve error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Bookmarks (Authenticated) ──────────────────────────────

  /**
   * GET /bookmarks — Get user's bookmarked posts
   * Query: ?cursor=xxx&limit=20
   */
  router.get('/bookmarks', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const cursor = c.req.query('cursor');
      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);

      const data = await communityService.getBookmarkedPosts(user.imUserId, { cursor, limit });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Bookmarks error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Notifications (Authenticated) ──────────────────────────

  const notificationService = new CommunityNotificationService();

  /**
   * GET /notifications — Get user's notifications
   * Query: ?unread=true&limit=20&offset=0
   */
  router.get('/notifications', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const unread = c.req.query('unread') === 'true';
      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
      const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

      const data = await notificationService.getNotifications(user.imUserId, { unread, limit, offset });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Notifications error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * POST /notifications/read — Mark notification(s) as read
   * Body: { notificationId?: string } (if omitted, mark all read)
   */
  router.post('/notifications/read', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const body = await c.req.json().catch(() => ({}));
      const { notificationId } = body;

      if (notificationId) {
        const success = await notificationService.markRead(user.imUserId, notificationId);
        return c.json<ApiResponse>({ ok: true, data: { marked: success ? 1 : 0 } });
      }

      const count = await notificationService.markAllRead(user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: { marked: count } });
    } catch (err: any) {
      console.error('[Community] Notifications read error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * GET /notifications/count — Get unread count
   */
  router.get('/notifications/count', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const count = await notificationService.getUnreadCount(user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: { unread: count } });
    } catch (err: any) {
      console.error('[Community] Notifications count error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Stats (Public) ─────────────────────────────────────────

  /**
   * GET /stats — Community stats (public)
   */
  router.get('/stats', async (c) => {
    try {
      const data = await communityService.getStats();
      c.header('Cache-Control', 'public, max-age=60');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ── Search ──────────────────────────────────────────────────────────

  router.get('/search', async (c) => {
    try {
      const q = c.req.query('q') || '';
      if (!q.trim()) {
        return c.json<ApiResponse>({ ok: false, error: 'q is required' }, 400);
      }
      if (!searchService) {
        return c.json<ApiResponse>({ ok: false, error: 'Search not available' }, 503);
      }
      const data = await searchService.search({
        q,
        boardId: c.req.query('boardSlug') || c.req.query('boardId') || undefined,
        scope: (c.req.query('scope') as 'posts' | 'comments' | 'all') || 'all',
        sort: (c.req.query('sort') as 'relevance' | 'hot' | 'new') || 'relevance',
        highlight: c.req.query('highlight') !== 'false',
        limit: Math.min(parseInt(c.req.query('limit') || '20', 10), 50),
        cursor: c.req.query('cursor') || undefined,
      });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Search error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  router.get('/search/suggest', async (c) => {
    try {
      const q = c.req.query('q') || '';
      if (!q.trim() || !searchService) {
        return c.json<ApiResponse>({ ok: true, data: { tags: [], genes: [] } });
      }
      const data = await searchService.suggest(q);
      c.header('Cache-Control', 'public, max-age=30');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      console.error('[Community] Suggest error:', err.message);
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ── Autocomplete (Gene/Skill names for [[gene:...]] editor) ────────

  router.get('/autocomplete/genes', async (c) => {
    try {
      const q = c.req.query('q') || '';
      const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20);
      const data = await searchGeneNames(q, limit);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  router.get('/autocomplete/skills', async (c) => {
    try {
      const q = c.req.query('q') || '';
      const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20);
      const data = await searchSkillNames(q, limit);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  // ─── Agent Auto-Post (Authenticated) ──────────────────────

  if (autoService) {
    router.post('/agent-post/battle-report', authMiddleware, async (c) => {
      try {
        const body = await c.req.json();
        if (!body.agentId || !body.agentName) {
          return c.json<ApiResponse>({ ok: false, error: 'agentId and agentName are required' }, 400);
        }
        const postId = await autoService.createBattleReport(body);
        return c.json<ApiResponse>({ ok: true, data: { postId } }, postId ? 201 : 200);
      } catch (err: any) {
        console.error('[Community] Agent battle-report error:', err.message);
        return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
      }
    });

    router.post('/agent-post/milestone', authMiddleware, async (c) => {
      try {
        const body = await c.req.json();
        if (!body.agentId || !body.agentName || !body.milestone) {
          return c.json<ApiResponse>({ ok: false, error: 'agentId, agentName, and milestone are required' }, 400);
        }
        const postId = await autoService.createMilestone(body);
        return c.json<ApiResponse>({ ok: true, data: { postId } }, postId ? 201 : 200);
      } catch (err: any) {
        console.error('[Community] Agent milestone error:', err.message);
        return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
      }
    });

    router.post('/agent-post/gene-release', authMiddleware, async (c) => {
      try {
        const body = await c.req.json();
        if (!body.agentId || !body.geneId || !body.geneTitle || !body.version || !body.changelog) {
          return c.json<ApiResponse>(
            { ok: false, error: 'agentId, geneId, geneTitle, version, and changelog are required' },
            400,
          );
        }
        const postId = await autoService.createGeneRelease(body);
        return c.json<ApiResponse>({ ok: true, data: { postId } }, postId ? 201 : 200);
      } catch (err: any) {
        console.error('[Community] Agent gene-release error:', err.message);
        return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
      }
    });
  }

  // ─── GDPR (Admin Only) ──────────────────────────────────────

  if (gdprService) {
    /**
     * DELETE /gdpr/anonymize/:userId — Anonymize a user's community data (GDPR right-to-erasure)
     * Admin-only endpoint.
     */
    router.delete('/gdpr/anonymize/:userId', authMiddleware, async (c) => {
      try {
        const user = c.get('user');
        if (user.role !== 'admin') {
          return c.json<ApiResponse>({ ok: false, error: 'Admin access required' }, 403);
        }

        const targetUserId = c.req.param('userId');
        if (!targetUserId) {
          return c.json<ApiResponse>({ ok: false, error: 'userId is required' }, 400);
        }

        const result = await gdprService.anonymizeUser(targetUserId);
        return c.json<ApiResponse>({ ok: true, data: result });
      } catch (err: any) {
        const targetUserId = c.req.param('userId');
        log.error({ err, userId: targetUserId }, 'GDPR anonymize error');
        return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
      }
    });
  }

  return router;
}

/**
 * CommunityHub — v1.8.0 greenfield community API for agents.
 *
 * Single entry for forum operations: REST parity + TTL cache + intent helpers + WS hookup.
 * Not a thin pass-through: feed/stats/notifications use cache; attachRealtime() merges push events.
 */

import type { RequestFn, IMResult, CommunityHubConfig } from './types';
import type { RealtimeWSClient } from './realtime';

export type { CommunityHubConfig };

interface FeedCacheEntry {
  at: number;
  payload: unknown;
}

export class CommunityHub {
  private readonly feedTTL: number;
  private readonly statsTTL: number;
  private feedCache = new Map<string, FeedCacheEntry>();
  private statsCache: { at: number; data: unknown } | null = null;
  private notifCountCache: { at: number; count: number } | null = null;
  private readonly notifCountTTL = 15_000;
  private wsUnsubs: Array<() => void> = [];

  constructor(
    private readonly _r: RequestFn,
    config?: CommunityHubConfig,
  ) {
    this.feedTTL = config?.feedTTLMs ?? 300_000;
    this.statsTTL = config?.statsTTLMs ?? 600_000;
  }

  /** Invalidate cached feeds/stats (e.g. after you posted). */
  invalidateCache(boardId?: string): void {
    if (boardId) this.feedCache.delete(boardId);
    else this.feedCache.clear();
    this.statsCache = null;
    this.notifCountCache = null;
  }

  /**
   * Subscribe to community.* WebSocket events; updates local notification count hint and invalidates feed.
   */
  attachRealtime(ws: RealtimeWSClient): void {
    const onReply = () => {
      this.notifCountCache = null;
      this.feedCache.clear();
    };
    const types = [
      'community.reply',
      'community.vote',
      'community.answer.accepted',
      'community.mention',
    ] as const;
    for (const t of types) {
      ws.on(t, onReply);
      this.wsUnsubs.push(() => ws.off(t, onReply));
    }
  }

  detachRealtime(): void {
    for (const u of this.wsUnsubs) u();
    this.wsUnsubs = [];
  }

  // ─── Intent (cached reads) ─────────────────────────────────

  async feed(opts?: { boardId?: string; limit?: number }): Promise<IMResult<any>> {
    const key = opts?.boardId ?? '__all__';
    const hit = this.feedCache.get(key);
    if (hit && Date.now() - hit.at < this.feedTTL) {
      return { ok: true, data: hit.payload };
    }
    const res = await this.listPosts({
      boardId: opts?.boardId,
      limit: opts?.limit ?? 20,
      sort: 'hot',
    });
    if (res.ok && res.data != null) {
      this.feedCache.set(key, { at: Date.now(), payload: res.data });
    }
    return res;
  }

  async aggregatedContext(opts?: { boardId?: string; feedLimit?: number }): Promise<{
    feed: IMResult<any>;
    stats: IMResult<any>;
    unreadNotifications: IMResult<{ unread: number }>;
  }> {
    const [feed, stats, unreadNotifications] = await Promise.all([
      this.feed({ boardId: opts?.boardId, limit: opts?.feedLimit ?? 15 }),
      this.statsCached(),
      this.unreadCountCached(),
    ]);
    return { feed, stats, unreadNotifications };
  }

  private async statsCached(): Promise<IMResult<any>> {
    if (this.statsCache && Date.now() - this.statsCache.at < this.statsTTL) {
      return { ok: true, data: this.statsCache.data };
    }
    const res = await this.getStats();
    if (res.ok && res.data != null) {
      this.statsCache = { at: Date.now(), data: res.data };
    }
    return res;
  }

  private async unreadCountCached(): Promise<IMResult<{ unread: number }>> {
    if (this.notifCountCache && Date.now() - this.notifCountCache.at < this.notifCountTTL) {
      return { ok: true, data: { unread: this.notifCountCache.count } };
    }
    const res = await this.getNotificationCount();
    const n = (res.data as { unread?: number } | undefined)?.unread;
    if (res.ok && typeof n === 'number') {
      this.notifCountCache = { at: Date.now(), count: n };
    }
    return res as IMResult<{ unread: number }>;
  }

  /** Helpdesk question shortcut */
  async ask(title: string, content: string, tags?: string[]): Promise<IMResult<any>> {
    const res = await this.createPost({
      boardId: 'helpdesk',
      title,
      content,
      postType: 'question',
      tags,
    });
    if (res.ok) this.invalidateCache('helpdesk');
    return res;
  }

  /** Showcase battle report shortcut */
  async reportBattle(input: {
    title: string;
    content: string;
    linkedGeneIds?: string[];
    linkedAgentId?: string;
    tags?: string[];
  }): Promise<IMResult<any>> {
    const res = await this.createPost({
      boardId: 'showcase',
      title: input.title,
      content: input.content,
      postType: 'battleReport',
      tags: input.tags,
      linkedGeneIds: input.linkedGeneIds,
      linkedAgentId: input.linkedAgentId,
    });
    if (res.ok) this.invalidateCache('showcase');
    return res;
  }

  // ─── Notifications & profile (auth) ────────────────────────

  async getNotifications(opts?: { unread?: boolean; limit?: number; offset?: number }): Promise<IMResult<any>> {
    const q: Record<string, string> = {};
    if (opts?.unread) q.unread = 'true';
    if (opts?.limit != null) q.limit = String(opts.limit);
    if (opts?.offset != null) q.offset = String(opts.offset);
    return this._r('GET', '/api/im/community/notifications', undefined, q);
  }

  async markNotificationsRead(notificationId?: string): Promise<IMResult<any>> {
    const body = notificationId ? { notificationId } : {};
    return this._r('POST', '/api/im/community/notifications/read', body);
  }

  async getNotificationCount(): Promise<IMResult<{ unread: number }>> {
    return this._r('GET', '/api/im/community/notifications/count');
  }

  async listBookmarks(opts?: { cursor?: string; limit?: number }): Promise<IMResult<any>> {
    const q: Record<string, string> = {};
    if (opts?.cursor) q.cursor = opts.cursor;
    if (opts?.limit != null) q.limit = String(opts.limit);
    return this._r('GET', '/api/im/community/bookmarks', undefined, q);
  }

  async followToggle(followingId: string, followingType: 'user' | 'agent' | 'gene' | 'board'): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/community/follow', { followingId, followingType });
  }

  async listFollowing(type?: string): Promise<IMResult<any>> {
    const q: Record<string, string> = {};
    if (type) q.type = type;
    return this._r('GET', '/api/im/community/following', undefined, q);
  }

  async listFollowers(userId: string): Promise<IMResult<any>> {
    return this._r('GET', `/api/im/community/followers/${encodeURIComponent(userId)}`);
  }

  async getProfile(userId: string): Promise<IMResult<any>> {
    return this._r('GET', `/api/im/community/profile/${encodeURIComponent(userId)}`);
  }

  // ─── REST (same surface as former CommunityClient) ─────────

  async createPost(input: {
    boardId: string;
    title: string;
    content: string;
    postType?: string;
    tags?: string[];
    linkedGeneIds?: string[];
    linkedAgentId?: string;
    linkedCapsuleId?: string;
  }): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/community/posts', input);
  }

  async listPosts(opts?: {
    boardId?: string;
    sort?: string;
    period?: string;
    authorType?: string;
    cursor?: string;
    limit?: number;
  }): Promise<IMResult<any>> {
    const query: Record<string, string> = {};
    if (opts?.boardId) query.boardId = opts.boardId;
    if (opts?.sort) query.sort = opts.sort;
    if (opts?.period) query.period = opts.period;
    if (opts?.authorType) query.authorType = opts.authorType;
    if (opts?.cursor) query.cursor = opts.cursor;
    if (opts?.limit != null) query.limit = String(opts.limit);
    return this._r('GET', '/api/im/community/posts', undefined, query);
  }

  async getPost(postId: string): Promise<IMResult<any>> {
    return this._r('GET', `/api/im/community/posts/${encodeURIComponent(postId)}`);
  }

  async updatePost(
    postId: string,
    input: { title?: string; content?: string; tags?: string[] },
  ): Promise<IMResult<any>> {
    return this._r('PUT', `/api/im/community/posts/${encodeURIComponent(postId)}`, input);
  }

  async deletePost(postId: string): Promise<IMResult<any>> {
    return this._r('DELETE', `/api/im/community/posts/${encodeURIComponent(postId)}`);
  }

  async createComment(
    postId: string,
    input: { content: string; parentId?: string; commentType?: string },
  ): Promise<IMResult<any>> {
    return this._r('POST', `/api/im/community/posts/${encodeURIComponent(postId)}/comments`, input);
  }

  async listComments(
    postId: string,
    opts?: { sort?: string; cursor?: string; limit?: number },
  ): Promise<IMResult<any>> {
    const query: Record<string, string> = {};
    if (opts?.sort) query.sort = opts.sort;
    if (opts?.cursor) query.cursor = opts.cursor;
    if (opts?.limit != null) query.limit = String(opts.limit);
    return this._r('GET', `/api/im/community/posts/${encodeURIComponent(postId)}/comments`, undefined, query);
  }

  async markBestAnswer(commentId: string): Promise<IMResult<any>> {
    return this._r('POST', `/api/im/community/comments/${encodeURIComponent(commentId)}/best-answer`);
  }

  async vote(targetType: 'post' | 'comment', targetId: string, value: 1 | -1 | 0): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/community/vote', { targetType, targetId, value });
  }

  async bookmark(postId: string): Promise<IMResult<any>> {
    return this._r('POST', '/api/im/community/bookmark', { postId });
  }

  async search(query: string, opts?: { boardId?: string; sort?: string; limit?: number }): Promise<IMResult<any>> {
    const q: Record<string, string> = { q: query };
    if (opts?.boardId) q.boardId = opts.boardId;
    if (opts?.sort) q.sort = opts.sort;
    if (opts?.limit != null) q.limit = String(opts.limit);
    return this._r('GET', '/api/im/community/search', undefined, q);
  }

  async updateComment(commentId: string, input: { content?: string }): Promise<IMResult<any>> {
    return this._r('PUT', `/api/im/community/comments/${encodeURIComponent(commentId)}`, input);
  }

  async deleteComment(commentId: string): Promise<IMResult<any>> {
    return this._r('DELETE', `/api/im/community/comments/${encodeURIComponent(commentId)}`);
  }

  async getStats(): Promise<IMResult<{ totalPosts: number; totalComments: number; totalUsers: number; activeToday: number }>> {
    return this._r('GET', '/api/im/community/stats');
  }

  async getTrendingTags(limit?: number): Promise<IMResult<Array<{ tag: string; count: number }>>> {
    const query: Record<string, string> = {};
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/community/tags/trending', undefined, query);
  }

  async getHotPosts(opts?: { limit?: number; period?: 'day' | 'week' | 'month' | 'all' }): Promise<IMResult<any[]>> {
    const query: Record<string, string> = {};
    if (opts?.limit != null) query.limit = String(opts.limit);
    if (opts?.period) query.period = opts.period;
    return this._r('GET', '/api/im/community/hot', undefined, query);
  }

  async searchSuggest(q: string): Promise<IMResult<string[]>> {
    return this._r('GET', '/api/im/community/search/suggest', undefined, { q });
  }

  async autocompleteGenes(q: string, limit?: number): Promise<IMResult<Array<{ id: string; name: string }>>> {
    const query: Record<string, string> = { q };
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/community/autocomplete/genes', undefined, query);
  }

  async autocompleteSkills(q: string, limit?: number): Promise<IMResult<Array<{ id: string; name: string }>>> {
    const query: Record<string, string> = { q };
    if (limit != null) query.limit = String(limit);
    return this._r('GET', '/api/im/community/autocomplete/skills', undefined, query);
  }

  async createBattleReport(input: {
    agentId: string;
    capsuleIds?: string[];
    geneIds?: string[];
    metrics?: Record<string, unknown>;
    narrative?: string;
  }): Promise<IMResult<any>> {
    return this.createPost({
      boardId: 'showcase',
      title: `Battle Report: ${input.agentId}`,
      content: input.narrative || 'Auto-generated battle report',
      postType: 'battleReport',
      linkedGeneIds: input.geneIds,
      linkedAgentId: input.agentId,
    });
  }

  async createMilestone(input: {
    agentId: string;
    title: string;
    content: string;
    geneIds?: string[];
    tags?: string[];
  }): Promise<IMResult<any>> {
    return this.createPost({
      boardId: 'showcase',
      title: input.title,
      content: input.content,
      postType: 'milestone',
      linkedGeneIds: input.geneIds,
      linkedAgentId: input.agentId,
      tags: input.tags,
    });
  }

  async createGeneRelease(input: {
    geneId: string;
    title: string;
    content: string;
    tags?: string[];
  }): Promise<IMResult<any>> {
    return this.createPost({
      boardId: 'showcase',
      title: input.title,
      content: input.content,
      postType: 'geneRelease',
      linkedGeneIds: [input.geneId],
      tags: input.tags,
    });
  }
}

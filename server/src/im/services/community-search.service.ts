/**
 * Prismer IM — Community Search Service
 *
 * Dual-track search (same idea as SkillService):
 * - MySQL: FULLTEXT on im_community_posts (title, content) when practical
 * - SQLite / fallback: Prisma `contains` with per-word AND + OR on fields
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

const LOG = '[CommunitySearchService]';

/** Explicit row types — prisma singleton is typed as `any` in @/lib/prisma */
type PostSearchRow = {
  id: string;
  title: string;
  content: string;
  boardId: string;
  authorId: string;
  authorType: string;
  upvotes: number;
  commentCount: number;
  createdAt: Date;
};

type CommentSearchRow = {
  id: string;
  postId: string;
  authorId: string;
  authorType: string;
  content: string;
  upvotes: number;
  createdAt: Date;
};

type PostMetaRow = {
  id: string;
  title: string;
  boardId: string;
  commentCount: number;
};

export interface CommunitySearchOptions {
  q: string;
  boardId?: string;
  scope?: 'posts' | 'comments' | 'all';
  sort?: 'relevance' | 'hot' | 'new';
  highlight?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  type: 'post' | 'comment';
  id: string;
  title?: string;
  snippet: string;
  boardId?: string;
  author: { id: string; name?: string };
  upvotes: number;
  commentCount?: number;
  relevanceScore: number;
  createdAt: Date;
}

export interface SearchSuggestion {
  tags: string[];
  genes: { id: string; title: string }[];
}

function hotnessScore(upvotes: number, downvotes: number, createdAt: Date): number {
  const score = upvotes - downvotes;
  const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
  return score / Math.pow(ageHours + 2, 1.5);
}

function splitWords(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class CommunitySearchService {
  /**
   * Full-text search across community posts (and optionally comments).
   * MySQL: uses FULLTEXT INDEX. SQLite: falls back to Prisma contains.
   */
  async search(opts: CommunitySearchOptions): Promise<{
    results: SearchResult[];
    nextCursor?: string;
    relatedTags: string[];
  }> {
    const q = (opts.q || '').trim();
    const scope = opts.scope ?? 'posts';
    const sort = opts.sort ?? 'relevance';
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const words = splitWords(q);

    if (words.length === 0) {
      return { results: [], relatedTags: [] };
    }

    const relatedTags = await this.fetchRelatedTags(words);

    const effectiveBoard =
      opts.boardId && opts.boardId !== 'all' ? opts.boardId : undefined;

    // Cursor + merged "all" scope: use Prisma path only (reliable pagination).
    const useMysqlFulltext = this.isMySQL() && !opts.cursor;

    if (useMysqlFulltext && scope === 'posts') {
      const booleanQuery = this.toBooleanQuery(words);
      if (booleanQuery) {
        try {
          return await this.searchPostsMysql({
            words,
            booleanQuery,
            boardId: effectiveBoard,
            sort,
            highlight: opts.highlight ?? false,
            limit,
            relatedTags,
          });
        } catch (err) {
          console.warn(`${LOG} FULLTEXT post search failed, falling back:`, (err as Error).message);
        }
      }
    }

    if (useMysqlFulltext && scope === 'comments') {
      const booleanQuery = this.toBooleanQuery(words);
      if (booleanQuery) {
        try {
          const commentResults = await this.searchCommentsMysql({
            words,
            booleanQuery,
            boardId: effectiveBoard,
            sort,
            highlight: opts.highlight ?? false,
            limit,
          });
          const nextCursor = commentResults.length === limit ? commentResults[commentResults.length - 1]!.id : undefined;
          return { results: commentResults, nextCursor, relatedTags };
        } catch (err) {
          console.warn(`${LOG} FULLTEXT comment search failed, falling back:`, (err as Error).message);
        }
      }
    }

    if (useMysqlFulltext && scope === 'all') {
      const booleanQuery = this.toBooleanQuery(words);
      if (booleanQuery) {
        try {
          const postLimit = Math.max(1, Math.ceil(limit * 0.65));
          const commentLimit = Math.max(1, Math.ceil(limit * 0.65));
          const postPart = await this.searchPostsMysql({
            words,
            booleanQuery,
            boardId: effectiveBoard,
            sort,
            highlight: opts.highlight ?? false,
            limit: postLimit,
            relatedTags,
          });
          const commentPart = await this.searchCommentsMysql({
            words,
            booleanQuery,
            boardId: effectiveBoard,
            sort,
            highlight: opts.highlight ?? false,
            limit: commentLimit,
          });
          const results = this.sortResults([...postPart.results, ...commentPart], sort).slice(
            0,
            limit,
          );
          return { results, relatedTags: postPart.relatedTags };
        } catch (err) {
          console.warn(`${LOG} FULLTEXT combined search failed, falling back:`, (err as Error).message);
        }
      }
    }

    // For scope='all' with cursor: decode composite cursor "post:id" / "comment:id"
    let postCursor: string | undefined;
    let commentCursor: string | undefined;
    if (scope === 'all' && opts.cursor) {
      const [type, id] = opts.cursor.split(':', 2);
      if (type === 'post') postCursor = id;
      else if (type === 'comment') commentCursor = id;
    }

    const [postResults, commentResults] = await Promise.all([
      scope === 'comments'
        ? Promise.resolve([] as SearchResult[])
        : this.searchPostsPrisma({
            words,
            boardId: effectiveBoard,
            sort,
            highlight: opts.highlight ?? false,
            limit: scope === 'all' ? limit + 1 : limit,
            cursor: scope === 'all' ? postCursor : opts.cursor,
          }),
      scope === 'posts'
        ? Promise.resolve([] as SearchResult[])
        : this.searchCommentsPrisma({
            words,
            boardId: effectiveBoard,
            sort,
            highlight: opts.highlight ?? false,
            limit: scope === 'all' ? limit + 1 : limit,
            cursor: scope === 'all' ? commentCursor : opts.cursor,
          }),
    ]);

    let results: SearchResult[] = [...postResults, ...commentResults];

    if (scope === 'all') {
      results = this.sortResults(results, sort);
      const hasMore = results.length > limit;
      results = results.slice(0, limit);
      const last = results[results.length - 1];
      const nextCursor = hasMore && last ? `${last.type}:${last.id}` : undefined;
      return { results, nextCursor, relatedTags };
    }

    const nextCursor =
      results.length === limit ? results[results.length - 1]!.id : undefined;

    return { results, nextCursor, relatedTags };
  }

  /**
   * Typeahead search suggestions: matching tags + gene names.
   */
  async suggest(q: string): Promise<SearchSuggestion> {
    const prefix = q.trim().toLowerCase();
    if (!prefix) {
      return { tags: [], genes: [] };
    }

    const [tags, genes] = await Promise.all([
      prisma.iMCommunityTag.findMany({
        where: { name: { startsWith: prefix } },
        take: 5,
        orderBy: { postCount: 'desc' },
        select: { name: true },
      }),
      prisma.iMGene.findMany({
        where: { title: { contains: q.trim() } },
        take: 5,
        select: { id: true, title: true },
      }),
    ]);

    return {
      tags: tags.map((t: { name: string }) => t.name),
      genes: genes.map((g: { id: string; title: string }) => ({ id: g.id, title: g.title })),
    };
  }

  /**
   * Detect if using MySQL (has FULLTEXT support).
   */
  private isMySQL(): boolean {
    const url = process.env.DATABASE_URL || '';
    return url.startsWith('mysql://');
  }

  private toBooleanQuery(words: string[]): string {
    const safe = words
      .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
      .filter(Boolean)
      .map((w) => `+${w}*`);
    return safe.join(' ');
  }

  private async fetchRelatedTags(words: string[]): Promise<string[]> {
    const lowered = words.map((w) => w.toLowerCase());
    const rows = await prisma.iMCommunityTag.findMany({
      where: {
        OR: lowered.map((w) => ({ name: { contains: w } })),
      },
      take: 5,
      orderBy: { postCount: 'desc' },
      select: { name: true },
    });
    return rows.map((r: { name: string }) => r.name);
  }

  private async resolveAuthorNames(authorIds: string[]): Promise<Map<string, string | undefined>> {
    const unique = [...new Set(authorIds)];
    if (unique.length === 0) return new Map();
    const users = await prisma.iMUser.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u: { id: string; displayName: string }) => [u.id, u.displayName]));
  }

  private sqliteRelevance(title: string, content: string, words: string[]): number {
    if (words.length === 0) return 0;
    const hay = `${title}\n${content}`.toLowerCase();
    let matched = 0;
    for (const w of words) {
      if (hay.includes(w.toLowerCase())) matched += 1;
    }
    return matched / words.length;
  }

  private buildSnippet(
    text: string,
    words: string[],
    highlight: boolean,
  ): string {
    const lower = text.toLowerCase();
    let idx = -1;
    for (const w of words) {
      const i = lower.indexOf(w.toLowerCase());
      if (i >= 0 && (idx < 0 || i < idx)) {
        idx = i;
      }
    }
    if (idx < 0) {
      const slice = text.slice(0, 150);
      return highlight ? escapeHtml(slice) : slice;
    }
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + 90);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = `…${snippet}`;
    if (end < text.length) snippet = `${snippet}…`;

    if (!highlight) return snippet;

    let safe = escapeHtml(snippet);
    for (const w of words) {
      if (!w) continue;
      const re = new RegExp(`(${escapeRegExp(w)})`, 'gi');
      safe = safe.replace(re, '<em>$1</em>');
    }
    return safe;
  }

  private sortResults(results: SearchResult[], sort: 'relevance' | 'hot' | 'new'): SearchResult[] {
    const copy = [...results];
    switch (sort) {
      case 'new':
        copy.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
      case 'hot':
        copy.sort(
          (a, b) =>
            hotnessScore(b.upvotes, 0, b.createdAt) - hotnessScore(a.upvotes, 0, a.createdAt),
        );
        break;
      default:
        copy.sort((a, b) => b.relevanceScore - a.relevanceScore);
    }
    return copy;
  }

  private async searchPostsMysql(input: {
    words: string[];
    booleanQuery: string;
    boardId?: string;
    sort: 'relevance' | 'hot' | 'new';
    highlight: boolean;
    limit: number;
    relatedTags: string[];
  }): Promise<{ results: SearchResult[]; nextCursor?: string; relatedTags: string[] }> {
    if (!input.booleanQuery) {
      throw new Error('empty boolean query');
    }

    let orderClause: string;
    switch (input.sort) {
      case 'new':
        orderClause = 'createdAt DESC';
        break;
      case 'hot':
        orderClause = 'upvotes DESC';
        break;
      default:
        orderClause = 'relevance DESC';
    }

    const boardParam = input.boardId ?? null;
    const sql = `
      SELECT id, title, content, boardId, authorId, authorType, upvotes, commentCount, createdAt,
             MATCH(title, content) AGAINST(? IN BOOLEAN MODE) AS relevance
      FROM im_community_posts
      WHERE deletedAt IS NULL
        AND MATCH(title, content) AGAINST(? IN BOOLEAN MODE)
        AND (? IS NULL OR boardId = ?)
      ORDER BY ${orderClause}
      LIMIT ?
    `;

    const rows = (await prisma.$queryRawUnsafe(
      sql,
      input.booleanQuery,
      input.booleanQuery,
      boardParam,
      boardParam,
      input.limit,
    )) as Array<{
      id: string;
      title: string;
      content: string;
      boardId: string;
      authorId: string;
      authorType: string;
      upvotes: number;
      commentCount: number;
      createdAt: Date;
      relevance: number | bigint | null;
    }>;

    const authorMap = await this.resolveAuthorNames(rows.map((r) => r.authorId));

    const results: SearchResult[] = rows.map((r) => {
      const rel = Number(r.relevance ?? 0);
      return {
        type: 'post',
        id: r.id,
        title: r.title,
        snippet: this.buildSnippet(r.content, input.words, input.highlight),
        boardId: r.boardId,
        author: { id: r.authorId, name: authorMap.get(r.authorId) },
        upvotes: r.upvotes,
        commentCount: r.commentCount,
        relevanceScore: rel,
        createdAt: r.createdAt,
      };
    });

    const nextCursor = results.length === input.limit ? results[results.length - 1]!.id : undefined;

    return { results, nextCursor, relatedTags: input.relatedTags };
  }

  private async searchPostsPrisma(input: {
    words: string[];
    boardId?: string;
    sort: 'relevance' | 'hot' | 'new';
    highlight: boolean;
    limit: number;
    cursor?: string;
  }): Promise<SearchResult[]> {
    const where: Prisma.IMCommunityPostWhereInput = {
      deletedAt: null,
      AND: input.words.map((w) => ({
        OR: [{ title: { contains: w } }, { content: { contains: w } }],
      })),
      ...(input.boardId ? { boardId: input.boardId } : {}),
    };

    const orderBy: Prisma.IMCommunityPostOrderByWithRelationInput =
      input.sort === 'new'
        ? { createdAt: 'desc' }
        : input.sort === 'hot'
          ? { upvotes: 'desc' }
          : { createdAt: 'desc' };

    const posts = (await prisma.iMCommunityPost.findMany({
      where,
      orderBy,
      take: input.sort === 'relevance' ? Math.min(input.limit * 3, 150) : input.limit,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        content: true,
        boardId: true,
        authorId: true,
        authorType: true,
        upvotes: true,
        commentCount: true,
        createdAt: true,
      },
    })) as PostSearchRow[];

    const authorMap = await this.resolveAuthorNames(posts.map((p: PostSearchRow) => p.authorId));

    let mapped: SearchResult[] = posts.map((p: PostSearchRow) => ({
      type: 'post' as const,
      id: p.id,
      title: p.title,
      snippet: this.buildSnippet(p.content, input.words, input.highlight),
      boardId: p.boardId,
      author: { id: p.authorId, name: authorMap.get(p.authorId) },
      upvotes: p.upvotes,
      commentCount: p.commentCount,
      relevanceScore: this.sqliteRelevance(p.title, p.content, input.words),
      createdAt: p.createdAt,
    }));

    if (input.sort === 'relevance') {
      mapped = this.sortResults(mapped, 'relevance').slice(0, input.limit);
    }

    return mapped;
  }

  private async searchCommentsMysql(input: {
    words: string[];
    booleanQuery: string;
    boardId?: string;
    sort: 'relevance' | 'hot' | 'new';
    highlight: boolean;
    limit: number;
  }): Promise<SearchResult[]> {
    if (!input.booleanQuery) throw new Error('empty boolean query');

    let orderClause: string;
    switch (input.sort) {
      case 'new':
        orderClause = 'c.createdAt DESC';
        break;
      case 'hot':
        orderClause = 'c.upvotes DESC';
        break;
      default:
        orderClause = 'relevance DESC';
    }

    const boardParam = input.boardId ?? null;
    const sql = `
      SELECT c.id, c.postId, c.authorId, c.authorType, c.content, c.upvotes, c.createdAt,
             MATCH(c.content) AGAINST(? IN BOOLEAN MODE) AS relevance,
             p.title AS postTitle, p.boardId AS postBoardId, p.commentCount AS postCommentCount
      FROM im_community_comments c
      JOIN im_community_posts p ON p.id = c.postId AND p.deletedAt IS NULL
      WHERE c.deletedAt IS NULL
        AND MATCH(c.content) AGAINST(? IN BOOLEAN MODE)
        AND (? IS NULL OR p.boardId = ?)
      ORDER BY ${orderClause}
      LIMIT ?
    `;

    const rows = (await prisma.$queryRawUnsafe(
      sql,
      input.booleanQuery,
      input.booleanQuery,
      boardParam,
      boardParam,
      input.limit,
    )) as Array<{
      id: string;
      postId: string;
      authorId: string;
      authorType: string;
      content: string;
      upvotes: number;
      createdAt: Date;
      relevance: number | bigint | null;
      postTitle: string;
      postBoardId: string;
      postCommentCount: number;
    }>;

    const authorMap = await this.resolveAuthorNames(rows.map((r) => r.authorId));

    return rows.map((r) => ({
      type: 'comment' as const,
      id: r.id,
      title: r.postTitle,
      snippet: this.buildSnippet(r.content, input.words, input.highlight),
      boardId: r.postBoardId,
      author: { id: r.authorId, name: authorMap.get(r.authorId) },
      upvotes: r.upvotes,
      commentCount: r.postCommentCount,
      relevanceScore: Number(r.relevance ?? 0),
      createdAt: r.createdAt,
    }));
  }

  private async searchCommentsPrisma(input: {
    words: string[];
    boardId?: string;
    sort: 'relevance' | 'hot' | 'new';
    highlight: boolean;
    limit: number;
    cursor?: string;
  }): Promise<SearchResult[]> {
    const where: Prisma.IMCommunityCommentWhereInput = {
      deletedAt: null,
      AND: input.words.map((w) => ({
        content: { contains: w },
      })),
    };

    const orderBy: Prisma.IMCommunityCommentOrderByWithRelationInput =
      input.sort === 'new'
        ? { createdAt: 'desc' }
        : input.sort === 'hot'
          ? { upvotes: 'desc' }
          : { createdAt: 'desc' };

    const take = input.sort === 'relevance' ? Math.min(input.limit * 4, 200) : input.limit;

    const comments = (await prisma.iMCommunityComment.findMany({
      where,
      orderBy,
      take,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        postId: true,
        authorId: true,
        authorType: true,
        content: true,
        upvotes: true,
        createdAt: true,
      },
    })) as CommentSearchRow[];

    const postIds = [...new Set(comments.map((c: CommentSearchRow) => c.postId))];
    const posts = (await prisma.iMCommunityPost.findMany({
      where: {
        id: { in: postIds },
        deletedAt: null,
        ...(input.boardId ? { boardId: input.boardId } : {}),
      },
      select: {
        id: true,
        title: true,
        boardId: true,
        commentCount: true,
      },
    })) as PostMetaRow[];
    const postMap = new Map<string, PostMetaRow>(posts.map((p: PostMetaRow) => [p.id, p]));

    const filtered = comments.filter((c: CommentSearchRow) => postMap.has(c.postId));
    const authorMap = await this.resolveAuthorNames(
      filtered.map((c: CommentSearchRow) => c.authorId),
    );

    let mapped: SearchResult[] = filtered.map((c: CommentSearchRow) => {
      const post = postMap.get(c.postId)!;
      return {
        type: 'comment' as const,
        id: c.id,
        title: post.title,
        snippet: this.buildSnippet(c.content, input.words, input.highlight),
        boardId: post.boardId,
        author: { id: c.authorId, name: authorMap.get(c.authorId) },
        upvotes: c.upvotes,
        commentCount: post.commentCount,
        relevanceScore: this.sqliteRelevance(post.title, c.content, input.words),
        createdAt: c.createdAt,
      };
    });

    if (input.sort === 'relevance') {
      mapped = this.sortResults(mapped, 'relevance').slice(0, input.limit);
    } else {
      mapped = mapped.slice(0, input.limit);
    }

    return mapped;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

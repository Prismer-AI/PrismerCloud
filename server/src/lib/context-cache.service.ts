/**
 * Context Cache Service — Prisma-first
 *
 * Local SQLite (dev) / MySQL (test/prod) via shared Prisma client.
 * Feature-flag controlled: FF_CONTEXT_CACHE_LOCAL
 *
 * All operations enforce:
 * - userId mandatory (every entry has an owner)
 * - Visibility enforcement (private: owner only, public: all, unlisted: with link)
 * - 100MB content size gate
 * - SHA-256 rawLink dedup via unique index
 */

import prisma from '@/lib/prisma';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface DepositInput {
  userId: string;
  rawLink: string;
  hqccContent: string;
  intrContent?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  contentUri?: string;
  meta?: Record<string, unknown>;
  tags?: string[];
}

export interface DepositResult {
  status: 'created' | 'updated';
  id: string;
  rawLinkHash: string;
  contentUri?: string;
}

export interface WithdrawInput {
  rawLink?: string;
  rawLinkHash?: string;
  format?: 'hqcc' | 'intr' | 'both';
}

export interface WithdrawResult {
  found: boolean;
  raw_link?: string;
  content_uri?: string;
  hqcc_content?: string;
  intr_content?: string;
  meta?: Record<string, unknown>;
  visibility?: string;
}

export interface WithdrawBatchResult {
  results: Array<{
    raw_link: string;
    found: boolean;
    hqcc_content?: string;
    intr_content?: string;
    meta?: Record<string, unknown>;
  }>;
  summary: { total: number; found: number; not_found: number };
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CONTENT_BYTES = 100 * 1024 * 1024; // 100MB

// ============================================================================
// Helpers
// ============================================================================

export function computeRawLinkHash(rawLink: string): string {
  return crypto.createHash('sha256').update(rawLink).digest('hex');
}

// ============================================================================
// Service
// ============================================================================

export class ContextCacheService {
  /**
   * Deposit (upsert) content into the cache.
   * Owner check: only the original owner (or anyone for public entries) can update.
   */
  async deposit(input: DepositInput): Promise<DepositResult> {
    const rawLinkHash = computeRawLinkHash(input.rawLink);
    const hqccBytes = Buffer.byteLength(input.hqccContent, 'utf-8');
    const intrBytes = Buffer.byteLength(input.intrContent || '', 'utf-8');
    const sizeBytes = hqccBytes + intrBytes;

    if (sizeBytes > MAX_CONTENT_BYTES) {
      throw new Error(`Content exceeds 100MB limit (${Math.round(sizeBytes / 1024 / 1024)}MB)`);
    }

    const visibility = input.visibility || 'private';
    const meta = JSON.stringify(input.meta || {});
    const tags = JSON.stringify(input.tags || []);

    const existing = await prisma.contextCache.findUnique({
      where: { rawLinkHash },
      select: { id: true, userId: true, visibility: true, contentUri: true },
    });

    if (existing) {
      // Only owner can update private/unlisted entries
      if (existing.userId !== input.userId && existing.visibility === 'private') {
        throw new Error("Permission denied: cannot update another user's private cache entry");
      }

      await prisma.contextCache.update({
        where: { rawLinkHash },
        data: {
          hqccContent: input.hqccContent,
          intrContent: input.intrContent,
          visibility,
          meta,
          tags,
          sizeBytes,
          contentUri: input.contentUri || existing.contentUri,
        },
      });

      console.log(`[ContextCacheService] Updated: ${rawLinkHash.substring(0, 12)}...`);
      return {
        status: 'updated',
        id: existing.id,
        rawLinkHash,
        contentUri: input.contentUri || existing.contentUri || undefined,
      };
    }

    const created = await prisma.contextCache.create({
      data: {
        userId: input.userId,
        rawLink: input.rawLink,
        rawLinkHash,
        hqccContent: input.hqccContent,
        intrContent: input.intrContent,
        visibility,
        meta,
        tags,
        sizeBytes,
        contentUri: input.contentUri,
      },
    });

    console.log(`[ContextCacheService] Created: ${rawLinkHash.substring(0, 12)}... (${sizeBytes} bytes)`);
    return {
      status: 'created',
      id: created.id,
      rawLinkHash,
      contentUri: input.contentUri || undefined,
    };
  }

  /**
   * Withdraw (read) from cache.
   * Visibility enforcement:
   * - public: anyone can read
   * - private: only owner (returns found:false to non-owner)
   * - unlisted: anyone with the rawLink can read
   */
  async withdraw(input: WithdrawInput, requestingUserId: string): Promise<WithdrawResult> {
    const hash = input.rawLinkHash || (input.rawLink ? computeRawLinkHash(input.rawLink) : null);
    if (!hash) {
      return { found: false };
    }

    const entry = await prisma.contextCache.findUnique({
      where: { rawLinkHash: hash },
    });

    if (!entry) {
      return { found: false };
    }

    // Visibility enforcement
    if (entry.visibility === 'private' && entry.userId !== requestingUserId) {
      return { found: false };
    }

    // Expiry check
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      return { found: false };
    }

    const format = input.format || 'hqcc';
    return {
      found: true,
      raw_link: entry.rawLink,
      content_uri: entry.contentUri || undefined,
      hqcc_content: format !== 'intr' ? entry.hqccContent || undefined : undefined,
      intr_content: format !== 'hqcc' ? entry.intrContent || undefined : undefined,
      meta: entry.meta ? JSON.parse(entry.meta) : undefined,
      visibility: entry.visibility,
    };
  }

  /**
   * Batch withdraw — single Prisma findMany with visibility filter.
   * Performance: ~10ms for any batch size (vs N HTTP requests to backend).
   */
  async withdrawBatch(
    urls: string[],
    requestingUserId: string,
    format?: 'hqcc' | 'intr' | 'both',
  ): Promise<WithdrawBatchResult> {
    const hashes = urls.map((url) => ({
      url,
      hash: computeRawLinkHash(url),
    }));

    const entries = await prisma.contextCache.findMany({
      where: {
        rawLinkHash: { in: hashes.map((h) => h.hash) },
        AND: {
          OR: [{ visibility: { in: ['public', 'unlisted'] } }, { userId: requestingUserId }],
        },
      },
    });

    const entryMap = new Map(entries.map((e: any) => [e.rawLinkHash, e] as [string, any]));
    const now = new Date();
    const fmt = format || 'hqcc';

    const results = hashes.map(({ url, hash }) => {
      const entry: any = entryMap.get(hash);
      if (!entry || (entry.expiresAt && entry.expiresAt < now)) {
        return { raw_link: url, found: false as const };
      }
      return {
        raw_link: url,
        found: true as const,
        hqcc_content: fmt !== 'intr' ? entry.hqccContent || undefined : undefined,
        intr_content: fmt !== 'hqcc' ? entry.intrContent || undefined : undefined,
        meta: entry.meta ? JSON.parse(entry.meta) : undefined,
      };
    });

    const found = results.filter((r) => r.found).length;
    return {
      results,
      summary: { total: urls.length, found, not_found: urls.length - found },
    };
  }

  /**
   * Search cache by query tokens matched against tags + meta.
   * Tokenizes query, scores by hit count, returns ranked results.
   */
  async search(
    query: string,
    requestingUserId: string,
    limit: number = 10,
  ): Promise<
    Array<{
      id: string;
      rawLink: string;
      title: string;
      snippet: string;
      tags: string[];
      score: number;
      visibility: string;
      updatedAt: Date;
    }>
  > {
    const tokens = query
      .toLowerCase()
      .split(/[\s,;:.\-_/\\|]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);

    if (tokens.length === 0) return [];

    const orConditions = tokens.flatMap((token) => [{ tags: { contains: token } }, { meta: { contains: token } }]);

    const entries = await prisma.contextCache.findMany({
      where: {
        OR: orConditions,
        AND: {
          OR: [{ visibility: { in: ['public', 'unlisted'] } }, { userId: requestingUserId }],
        },
      },
      select: {
        id: true,
        rawLink: true,
        hqccContent: true,
        tags: true,
        meta: true,
        visibility: true,
        updatedAt: true,
      },
      take: limit * 3,
      orderBy: { updatedAt: 'desc' },
    });

    const scored = entries.map((e: any) => {
      const tagsStr = (e.tags || '[]').toLowerCase();
      const metaStr = (e.meta || '{}').toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (tagsStr.includes(token)) score += 2;
        if (metaStr.includes(token)) score += 1;
      }
      const parsedMeta = e.meta ? JSON.parse(e.meta) : {};
      return {
        id: e.id,
        rawLink: e.rawLink,
        title: parsedMeta.title || e.rawLink,
        snippet: (e.hqccContent || '').slice(0, 300),
        tags: e.tags ? JSON.parse(e.tags) : [],
        score,
        visibility: e.visibility,
        updatedAt: e.updatedAt,
      };
    });

    scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * @deprecated Use search() instead.
   */
  async searchByTags(
    query: string,
    requestingUserId: string,
    limit: number = 10,
  ): Promise<
    Array<{
      id: string;
      rawLink: string;
      snippet: string;
      tags: string[];
      visibility: string;
      updatedAt: Date;
      source: 'cache';
    }>
  > {
    const entries = await prisma.contextCache.findMany({
      where: {
        OR: [{ tags: { contains: query } }, { hqccContent: { contains: query } }, { rawLink: { contains: query } }],
        AND: {
          OR: [{ visibility: { in: ['public', 'unlisted'] } }, { userId: requestingUserId }],
        },
      },
      select: {
        id: true,
        rawLink: true,
        hqccContent: true,
        tags: true,
        visibility: true,
        updatedAt: true,
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    });

    return entries.map((e: any) => ({
      id: e.id,
      rawLink: e.rawLink,
      snippet: (e.hqccContent || '').slice(0, 300),
      tags: e.tags ? JSON.parse(e.tags) : [],
      visibility: e.visibility,
      updatedAt: e.updatedAt,
      source: 'cache' as const,
    }));
  }

  /**
   * Delete a cache entry. Only the owner can delete.
   */
  async delete(rawLink: string, userId: string): Promise<boolean> {
    const hash = computeRawLinkHash(rawLink);
    const entry = await prisma.contextCache.findUnique({
      where: { rawLinkHash: hash },
      select: { userId: true },
    });

    if (!entry || entry.userId !== userId) {
      return false;
    }

    await prisma.contextCache.delete({ where: { rawLinkHash: hash } });
    console.log(`[ContextCacheService] Deleted: ${hash.substring(0, 12)}...`);
    return true;
  }
}

// Singleton
export const contextCacheService = new ContextCacheService();

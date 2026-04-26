/**
 * Prismer IM — Memory API
 *
 * POST   /memory/files            Create/upsert memory file
 * GET    /memory/files            List memory files
 * GET    /memory/files/:id        Read memory file
 * PATCH  /memory/files/:id        Partial update (append / replace / replace_section)
 * DELETE /memory/files/:id        Delete memory file
 * POST   /memory/compact          Create compaction summary
 * GET    /memory/compact/:conversationId  Get compaction summaries
 * GET    /memory/load             Auto-load session memory (MEMORY.md, truncated)
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { MemoryService, MemoryConflictError, MemoryNotFoundError } from '../services/memory.service';
import { ConversationService } from '../services/conversation.service';
import { runDream } from '../services/memory-dream';
import { extractMemories } from '../services/memory-extract';
import type { KnowledgeLinkService } from '../services/knowledge-link.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import type { EventBusService } from '../services/event-bus.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse } from '../types';

/** Max content size for a single memory file (1MB) */
const MAX_CONTENT_SIZE = 1024 * 1024;

export function createMemoryRouter(
  memoryService: MemoryService,
  conversationService?: ConversationService,
  knowledgeLinkService?: KnowledgeLinkService,
  rateLimiter?: RateLimiterService,
  eventBusService?: EventBusService,
) {
  const router = new Hono();

  router.use('*', authMiddleware);

  // ─── Rate Limiting (write operations) ────────────────────
  if (rateLimiter) {
    router.post('/files', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.patch('/files/:id', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.patch('/files/:id/metadata', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.delete('/files/:id', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/compact', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/consolidate', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/extract', createRateLimitMiddleware(rateLimiter, 'api.write'));
  }

  router.get('/stats', async (c) => {
    const user = c.get('user');
    const stats = await memoryService.getStats(user.imUserId);
    return c.json<ApiResponse>({ ok: true, data: stats });
  });

  router.patch('/files/:id/metadata', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { memoryType, description, stale } = body;

    if (memoryType !== undefined && !['feedback', 'project', 'reference', 'user', null].includes(memoryType)) {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid memoryType' }, 400);
    }

    try {
      const existing = await memoryService.readMemoryFile(c.req.param('id'));
      if (existing.ownerId !== user.imUserId) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      const result = await memoryService.updateFileMetadata(c.req.param('id'), {
        ...(memoryType !== undefined && { memoryType }),
        ...(description !== undefined && { description }),
        ...(stale !== undefined && { stale: Boolean(stale) }),
      });

      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      if (err instanceof MemoryNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      throw err;
    }
  });

  router.get('/links', async (c) => {
    const user = c.get('user');
    if (!knowledgeLinkService) {
      return c.json<ApiResponse>({ ok: true, data: { links: [], unlinkedMemories: [], totalLinks: 0 } });
    }

    const files = await memoryService.listMemoryFiles(user.imUserId);
    const memoryIds = files.map((f) => f.id);

    if (memoryIds.length === 0) {
      return c.json<ApiResponse>({ ok: true, data: { links: [], unlinkedMemories: [], totalLinks: 0 } });
    }

    const linkedGenes = await knowledgeLinkService.getLinkedGenes(memoryIds);

    const links: Array<{
      memoryId: string;
      memoryPath: string;
      genes: Array<{ geneId: string; title: string; linkType: string; strength: number; successRate: number }>;
    }> = [];
    const unlinkedMemories: string[] = [];
    let totalLinks = 0;

    for (const file of files) {
      const genes = linkedGenes.get(file.id);
      if (genes && genes.length > 0) {
        links.push({
          memoryId: file.id,
          memoryPath: file.path,
          genes,
        });
        totalLinks += genes.length;
      } else {
        unlinkedMemories.push(file.path);
      }
    }

    return c.json<ApiResponse>({ ok: true, data: { links, unlinkedMemories, totalLinks } });
  });

  // ═══════════════════════════════════════════════════════════
  // Memory Files (Episodic Memory)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /memory/files — Create or upsert a memory file
   *
   * Body: { path: string, content: string, scope?: string, ownerType?: string }
   * Upserts by (ownerId, scope, path) — if exists, replaces content.
   */
  router.post('/files', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    const { path, content, scope, ownerType } = body;

    if (!path || typeof path !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'path is required' }, 400);
    }
    if (content === undefined || content === null) {
      return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
    }
    if (typeof content === 'string' && content.length > MAX_CONTENT_SIZE) {
      return c.json<ApiResponse>({ ok: false, error: `content exceeds max size (${MAX_CONTENT_SIZE} bytes)` }, 400);
    }

    const result = await memoryService.writeMemoryFile(
      user.imUserId,
      ownerType ?? 'agent',
      path,
      String(content),
      scope ?? 'global',
      body.memoryType,
      body.description,
    );

    // Fire-and-forget: publish memory.write event for Cross-system Signal Bridge
    // geneId is optional — bridge only records evolution signal when present
    void eventBusService
      ?.publish({
        type: 'memory.write',
        timestamp: Date.now(),
        data: {
          agentId: user.imUserId,
          geneId: body.geneId,
          path,
          memoryType: body.memoryType,
          scope: scope ?? 'global',
        },
      })
      .catch(() => {});

    return c.json<ApiResponse>({ ok: true, data: result }, 201);
  });

  /**
   * GET /memory/files — List memory files (metadata only)
   *
   * Query: ?scope=global&path=MEMORY.md&memoryType=project&stale=false&sort=updatedAt&order=desc
   */
  router.get('/files', async (c) => {
    const user = c.get('user');
    const scope = c.req.query('scope');
    const path = c.req.query('path');
    const memoryType = c.req.query('memoryType');
    const staleParam = c.req.query('stale');
    const sort = c.req.query('sort');
    const order = c.req.query('order') as 'asc' | 'desc' | undefined;

    const stale = staleParam === 'true' ? true : staleParam === 'false' ? false : undefined;

    const files = await memoryService.listMemoryFiles(user.imUserId, scope, path, memoryType, stale, sort, order);
    return c.json<ApiResponse>({ ok: true, data: files });
  });

  /**
   * GET /memory/files/:id — Read a memory file (with content)
   */
  router.get('/files/:id', async (c) => {
    try {
      const file = await memoryService.readMemoryFile(c.req.param('id'));
      const user = c.get('user');
      if (file.ownerId !== user.imUserId) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      let linkedGenes: Array<{
        geneId: string;
        title: string;
        successRate: number;
        linkType: string;
        strength: number;
      }> = [];
      if (knowledgeLinkService) {
        try {
          const links = await knowledgeLinkService.getLinkedGenes([file.id]);
          linkedGenes = links.get(file.id) || [];
        } catch {}
      }

      return c.json<ApiResponse>({ ok: true, data: { ...file, linkedGenes } });
    } catch (err) {
      if (err instanceof MemoryNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      throw err;
    }
  });

  /**
   * PATCH /memory/files/:id — Partial update
   *
   * Body: { operation: 'append'|'replace'|'replace_section', content: string, section?: string, version?: number }
   * Returns 409 on version conflict.
   */
  router.patch('/files/:id', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { operation, content, section, version } = body;

    if (!operation || !['append', 'replace', 'replace_section'].includes(operation)) {
      return c.json<ApiResponse>(
        { ok: false, error: "operation must be 'append', 'replace', or 'replace_section'" },
        400,
      );
    }
    if (content === undefined || content === null) {
      return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
    }
    if (typeof content === 'string' && content.length > MAX_CONTENT_SIZE) {
      return c.json<ApiResponse>({ ok: false, error: `content exceeds max size (${MAX_CONTENT_SIZE} bytes)` }, 400);
    }

    try {
      // Pre-check ownership
      const existing = await memoryService.readMemoryFile(c.req.param('id'));
      if (existing.ownerId !== user.imUserId) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      const result = await memoryService.updateMemoryFile(
        c.req.param('id'),
        operation,
        String(content),
        version,
        section,
      );

      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      if (err instanceof MemoryNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof MemoryConflictError) {
        return c.json<ApiResponse>(
          { ok: false, error: err.message, meta: { currentVersion: err.currentVersion } },
          409,
        );
      }
      throw err;
    }
  });

  /**
   * DELETE /memory/files/:id — Delete a memory file
   */
  router.delete('/files/:id', async (c) => {
    const user = c.get('user');

    try {
      const existing = await memoryService.readMemoryFile(c.req.param('id'));
      if (existing.ownerId !== user.imUserId) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      await memoryService.deleteMemoryFile(c.req.param('id'));
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      if (err instanceof MemoryNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Compaction (Working Memory)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /memory/compact — Create a compaction summary
   *
   * Body: { conversationId: string, summary: string, messageRangeStart?: string, messageRangeEnd?: string }
   */
  router.post('/compact', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { conversationId, summary, messageRangeStart, messageRangeEnd } = body;

    if (!conversationId) {
      return c.json<ApiResponse>({ ok: false, error: 'conversationId is required' }, 400);
    }
    if (!summary || typeof summary !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'summary is required' }, 400);
    }

    // Verify user is a participant of the conversation
    if (conversationService) {
      const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
      if (!isMember) {
        return c.json<ApiResponse>({ ok: false, error: 'Not a participant of this conversation' }, 403);
      }
    }

    const result = await memoryService.compact(conversationId, summary, messageRangeStart, messageRangeEnd);

    return c.json<ApiResponse>({ ok: true, data: result }, 201);
  });

  /**
   * GET /memory/compact/:conversationId — Get compaction summaries
   */
  router.get('/compact/:conversationId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId');

    // Verify user is a participant of the conversation
    if (conversationService) {
      const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
      if (!isMember) {
        return c.json<ApiResponse>({ ok: false, error: 'Not a participant of this conversation' }, 403);
      }
    }

    const summaries = await memoryService.getCompactionSummaries(conversationId);
    return c.json<ApiResponse>({ ok: true, data: summaries });
  });

  // ═══════════════════════════════════════════════════════════
  // Session Memory (Auto-load)
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /memory/load — Auto-load MEMORY.md for session start
   *
   * Query: ?scope=global
   * Returns full MEMORY.md content + metadata (totalLines, totalBytes).
   * Truncation is the SDK/Agent's responsibility.
   */
  router.get('/load', async (c) => {
    const user = c.get('user');
    const scope = c.req.query('scope') ?? 'global';
    const path = c.req.query('path') ?? 'MEMORY.md';

    const memory = await memoryService.loadMemoryFile(user.imUserId, scope, path);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        content: memory?.content ?? null,
        totalLines: memory?.totalLines ?? 0,
        totalBytes: memory?.totalBytes ?? 0,
        version: memory?.version ?? 0,
        id: memory?.id ?? null,
        scope,
        path,
        template: path === 'MEMORY.md' ? memoryService.getCompactionTemplate() : undefined,
      },
    });
  });

  /**
   * GET /memory/digest — v1.8.1: CC-style always-load memory digest
   *
   * Returns a Markdown-formatted digest of the agent's memory, designed to be
   * injected into the agent's system prompt on session start (like Claude Code's
   * MEMORY.md 200-line auto-load).
   *
   * Unlike `/recall` which is a keyword-search API, this endpoint is query-free
   * and returns a priority-ordered summary of all memory files (facts first,
   * then reference/semantic, then recent episodes), truncated to fit in a
   * system prompt budget.
   *
   * Query:
   *   scope    — scope filter (default: "global")
   *   maxLines — max lines in digest (default: 200, matching CC's MEMORY.md truncation)
   *   maxBytes — max bytes in digest (default: 6000)
   *
   * Returns:
   *   digest           — Markdown string ready to inject into system prompt
   *   totalLines       — digest line count after truncation
   *   totalBytes       — digest byte count after truncation
   *   filesSummarized  — number of files included in digest
   *   filesTotal       — total memory files owned by user (pre-filter)
   *   truncated        — true if budget caused truncation
   *   generatedAt      — ISO timestamp
   *
   * SDK/Plugin impact: **additive only**. Existing /recall and /files endpoints
   * unchanged. SDK does not yet expose a wrapper for digest (v1.8.2+).
   */
  router.get('/digest', async (c) => {
    const user = c.get('user');
    const scope = c.req.query('scope') ?? 'global';
    const maxLines = Number.parseInt(c.req.query('maxLines') || '200', 10);
    const maxBytes = Number.parseInt(c.req.query('maxBytes') || '6000', 10);

    // Sanity clamps to prevent runaway queries
    const clampedMaxLines = Math.max(10, Math.min(maxLines, 1000));
    const clampedMaxBytes = Math.max(500, Math.min(maxBytes, 30000));

    const result = await memoryService.buildDigest(user.imUserId, {
      scope,
      maxLines: clampedMaxLines,
      maxBytes: clampedMaxBytes,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: result,
    });
  });

  /**
   * POST /memory/consolidate — Manually trigger Dream consolidation
   */
  router.post('/consolidate', async (c) => {
    const user = c.get('user');
    const scope = c.req.query('scope') ?? 'global';

    const result = await runDream(user.imUserId, scope);
    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * POST /memory/extract — Structured memory extraction from session journal (v1.8.0 P1)
   *
   * Body:
   *   journal — session journal text (required, min 50 chars)
   *   scope   — evolution scope (default: global)
   */
  router.post('/extract', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { journal, scope = 'global' } = body;

    if (!journal || typeof journal !== 'string' || journal.trim().length < 50) {
      return c.json<ApiResponse>({ ok: false, error: 'journal must be at least 50 characters' }, 400);
    }

    const result = await extractMemories(memoryService, {
      agentId: user.imUserId,
      journal,
      scope,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: result,
    });
  });

  return router;
}

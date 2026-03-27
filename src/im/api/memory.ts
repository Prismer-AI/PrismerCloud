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
import type { ApiResponse } from '../types';

/** Max content size for a single memory file (1MB) */
const MAX_CONTENT_SIZE = 1024 * 1024;

export function createMemoryRouter(memoryService: MemoryService, conversationService?: ConversationService) {
  const router = new Hono();

  router.use('*', authMiddleware);

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
    );

    return c.json<ApiResponse>({ ok: true, data: result }, 201);
  });

  /**
   * GET /memory/files — List memory files (metadata only)
   *
   * Query: ?scope=global&path=MEMORY.md
   */
  router.get('/files', async (c) => {
    const user = c.get('user');
    const scope = c.req.query('scope');
    const path = c.req.query('path');

    const files = await memoryService.listMemoryFiles(user.imUserId, scope, path);

    return c.json<ApiResponse>({ ok: true, data: files });
  });

  /**
   * GET /memory/files/:id — Read a memory file (with content)
   */
  router.get('/files/:id', async (c) => {
    try {
      const file = await memoryService.readMemoryFile(c.req.param('id'));

      // Ownership check
      const user = c.get('user');
      if (file.ownerId !== user.imUserId) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      return c.json<ApiResponse>({ ok: true, data: file });
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

  return router;
}

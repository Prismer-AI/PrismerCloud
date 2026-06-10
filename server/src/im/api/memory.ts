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

import { Hono, type Context } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { MemoryService, MemoryConflictError, MemoryNotFoundError } from '../services/memory.service';
import { ConversationService } from '../services/conversation.service';
import { runDream } from '../services/memory-dream';
import { extractMemories } from '../services/memory-extract';
import { MemoryReadService } from '../services/memory-read.service';
import { MemoryWriteService, MemoryWriteError } from '../services/memory-write.service';
import { MemoryProposalService, type ProposalOperation } from '../services/memory-proposal.service';
import { MemorySearchService, MemorySearchError, type EncryptionMode } from '../services/memory-search.service';
import { loadWorkspaceForMemoryAccess, type MemoryAclContext } from '../services/memory-acl';
import type { KnowledgeLinkService } from '../services/knowledge-link.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import type { EventBusService } from '../services/event-bus.service';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents, type MemoryInvalidatePayload } from '../ws/events';
import prisma from '../db';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse, MemoryFileOperation } from '../types';
import {
  WorkspaceResolutionError,
  memoryWorkspaceErrorResponse,
  resolveMemoryWorkspaceIdForRequest,
} from './workspace-resolver';
import { requireAgentToolAllowed, resolveConversationWorkspaceId } from '../security/mcp-allowlist';

/** Max content size for a single memory file (1MB) */
const MAX_CONTENT_SIZE = 1024 * 1024;

export function createMemoryRouter(
  memoryService: MemoryService,
  conversationService?: ConversationService,
  knowledgeLinkService?: KnowledgeLinkService,
  rateLimiter?: RateLimiterService,
  eventBusService?: EventBusService,
  rooms?: RoomManager,
) {
  const router = new Hono();
  const memoryReadService = new MemoryReadService();

  // Fan-out memory.invalidate to workspace owner + each delegated agent.
  // Daemon WS clients subscribe per imUserId; broadcasting once per
  // connected human/agent reaches all live mirrors.
  const invalidateNotifier = async (payload: MemoryInvalidatePayload): Promise<void> => {
    if (!rooms) return;
    try {
      const workspace = await prisma.iMWorkspace.findFirst({
        where: { id: payload.workspaceId, deletedAt: null },
        select: { ownerImUserId: true },
      });
      if (!workspace) return;
      const agentCards = await prisma.iMAgentCard.findMany({
        where: { workspaceId: payload.workspaceId },
        select: { imUserId: true },
      });
      const recipients = new Set<string>([
        workspace.ownerImUserId,
        ...agentCards.map((a: { imUserId: string }) => a.imUserId),
      ]);
      const event = ServerEvents.memoryInvalidate(payload);
      for (const uid of recipients) rooms.sendToUser(uid, event);
    } catch (err) {
      console.error('[memoryInvalidate] fan-out failed:', err);
    }
  };
  const memoryWriteService = new MemoryWriteService(invalidateNotifier);
  const memoryProposalService = new MemoryProposalService();
  const memorySearchService = new MemorySearchService();
  const resolveWorkspace = async (c: Context, explicit?: unknown) => {
    try {
      return { workspaceId: await resolveMemoryWorkspaceIdForRequest(c, explicit) };
    } catch (err) {
      if (err instanceof WorkspaceResolutionError) {
        return { response: memoryWorkspaceErrorResponse(c, err) };
      }
      throw err;
    }
  };

  /** Resolve workspace + ACL in one shot. Returns either ACL context or a 404 response. */
  const resolveAcl = async (
    c: Context,
    explicit?: unknown,
  ): Promise<{ acl: MemoryAclContext } | { response: Response }> => {
    const resolved = await resolveWorkspace(c, explicit);
    if (resolved.response) return { response: resolved.response };
    const user = c.get('user');
    const callerKind: 'user' | 'agent' = user.role === 'agent' ? 'agent' : 'user';
    const acl = await loadWorkspaceForMemoryAccess(resolved.workspaceId!, user.imUserId, callerKind);
    if (!acl) {
      return {
        response: c.json<ApiResponse>({ ok: false, error: 'Memory workspace not found' }, 404),
      };
    }
    return { acl };
  };
  const requireMemoryWriteAllowed = (c: Context, workspaceId: string) =>
    requireAgentToolAllowed(c, 'prismer.memory.write', workspaceId);

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /memory in routes.ts; wildcard scoped to that prefix
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
    // M-D independent HTML write — same rate class as other page writes.
    router.patch('/pages/:id/html', createRateLimitMiddleware(rateLimiter, 'api.write'));
  }

  router.get('/stats', async (c) => {
    const user = c.get('user');
    const resolved = await resolveWorkspace(c, c.req.query('workspaceId'));
    if (resolved.response) return resolved.response;

    const stats = await memoryService.getStats(resolved.workspaceId!, user.imUserId);
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
      const resolved = await resolveWorkspace(c, body.workspaceId);
      if (resolved.response) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.workspaceId!);
      if (denied) return denied;

      const existing = await memoryService.readMemoryFile(c.req.param('id'), resolved.workspaceId!);
      // v2.0.7.1 hotfix (B11): allow workspace-shared sentinel rows; ownership
      // upstream (resolveWorkspace) already gated this caller to the workspace.
      if (!memoryService.isFileReadableByCaller(existing, user.imUserId)) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      const result = await memoryService.updateFileMetadata(c.req.param('id'), resolved.workspaceId!, {
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

    const resolved = await resolveWorkspace(c, c.req.query('workspaceId'));
    if (resolved.response) return resolved.response;

    const files = await memoryService.listMemoryFiles(resolved.workspaceId!, user.imUserId);
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
  // Workspace Memory Pages (Phase B cloud mirror/read surface)
  // ═══════════════════════════════════════════════════════════

  router.get('/pages', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;

    const pages = await memoryReadService.listPages(resolved.acl, {
      sourceAssetId: c.req.query('sourceAssetId') ?? null,
      sourceRef: c.req.query('sourceRef') ?? null,
      limit: Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 200),
    });
    return c.json<ApiResponse>({ ok: true, data: pages });
  });

  router.get('/pages/by-source', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const sourceAssetId = c.req.query('sourceAssetId') ?? null;
    const sourceRef = c.req.query('sourceRef') ?? null;
    if (!sourceAssetId && !sourceRef) {
      return c.json<ApiResponse>({ ok: false, error: 'sourceAssetId or sourceRef is required' }, 400);
    }
    const pages = await memoryReadService.listBySource(resolved.acl, {
      sourceAssetId,
      sourceRef,
      limit: Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200),
    });
    return c.json<ApiResponse>({ ok: true, data: pages });
  });

  router.get('/pages/:id', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    // M-D: ?format=markdown|html|both. Default 'both' so existing clients
    // continue to receive `content` and now also see `contentHtml` /
    // `contentHtmlVersion`. 'html' narrows to the HTML payload (e.g. for
    // the rich-text editor); 'markdown' narrows to the legacy shape.
    const formatRaw = c.req.query('format');
    const format = formatRaw === 'markdown' || formatRaw === 'html' || formatRaw === 'both' ? formatRaw : 'both';
    const page = await memoryReadService.readPage(resolved.acl, c.req.param('id'), { format });
    if (!page) return c.json<ApiResponse>({ ok: false, error: 'Memory page not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data: page });
  });

  router.get('/pages/:id/links', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const links = await memoryReadService.getPageLinks(resolved.acl, c.req.param('id'));
    if (!links) return c.json<ApiResponse>({ ok: false, error: 'Memory page not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data: links });
  });

  router.get('/pages/:id/versions', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const versions = await memoryReadService.listVersions(resolved.acl, c.req.param('id'));
    if (!versions) return c.json<ApiResponse>({ ok: false, error: 'Memory page not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data: { versions } });
  });

  // ─── Health (read-only governance surface) ──────────────────
  router.get('/health/broken-links', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
    const data = await memoryReadService.healthBrokenLinks(resolved.acl, limit);
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.get('/health/stale', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
    const data = await memoryReadService.healthStale(resolved.acl, limit);
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.get('/health/duplicates', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
    const data = await memoryReadService.healthDuplicates(resolved.acl, limit);
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.get('/health/orphans', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
    const data = await memoryReadService.healthOrphans(resolved.acl, limit);
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.get('/graph', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const rootId = c.req.query('rootId');
    if (!rootId) {
      return c.json<ApiResponse>({ ok: false, error: 'rootId is required' }, 400);
    }
    const depth = parseInt(c.req.query('depth') ?? '', 10) || undefined;
    const data = await memoryReadService.graph(resolved.acl, rootId, depth);
    if (!data) return c.json<ApiResponse>({ ok: false, error: 'Memory page not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.get('/observability/recall-trace', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const sessionId = c.req.query('sessionId') ?? '';
    if (!sessionId) {
      return c.json<ApiResponse>({ ok: false, error: 'sessionId is required' }, 400);
    }
    const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
    const data = await memoryReadService.recallTrace(resolved.acl, sessionId, limit);
    return c.json<ApiResponse>({ ok: true, data });
  });

  // ─── Write surface (A3) ────────────────────────────────────
  const handleWriteError = (c: Context, err: unknown): Response => {
    if (err instanceof MemoryWriteError) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message, ...(err.meta ? { meta: err.meta } : {}) },
        err.status as 400 | 401 | 403 | 404 | 409 | 412 | 413 | 422,
      );
    }
    throw err;
  };

  router.post('/pages', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const created = await memoryWriteService.createPage({
        acl: resolved.acl,
        path: body.path,
        content: body.content,
        // M-D: optional independent HTML source. Pipeline / editor passes
        // through; we never derive from markdown on write.
        contentHtml: typeof body.contentHtml === 'string' ? body.contentHtml : undefined,
        pageType: body.pageType,
        visibility: body.visibility,
        sourceRefs: body.sourceRefs,
        rationale: body.rationale,
      });
      return c.json<ApiResponse>({ ok: true, data: created }, 201);
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/pages/:id/archive', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const resolved = await resolveAcl(c, body.workspaceId ?? c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const updated = await memoryWriteService.archive(resolved.acl, c.req.param('id'));
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/pages/:id/unarchive', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const resolved = await resolveAcl(c, body.workspaceId ?? c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const updated = await memoryWriteService.unarchive(resolved.acl, c.req.param('id'));
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.delete('/pages/:id', async (c) => {
    try {
      const resolved = await resolveAcl(c, c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const result = await memoryWriteService.softDelete({ acl: resolved.acl, pageId: c.req.param('id') });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  // M-F: dashboard data source. Aggregates the 7 doc 25 §5.5 health
  // metrics for a workspace + window. Read-only; no rate limit.
  router.get('/metrics', async (c) => {
    try {
      const resolved = await resolveAcl(c, c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const { computeMemoryMetrics } = await import('../services/memory-metrics.service');
      const windowMsRaw = c.req.query('windowMs');
      const windowMs = windowMsRaw ? Math.max(60_000, parseInt(windowMsRaw, 10) || 0) : undefined;
      const report =
        windowMs !== undefined
          ? await computeMemoryMetrics(resolved.acl.workspaceId, windowMs)
          : await computeMemoryMetrics(resolved.acl.workspaceId);
      return c.json<ApiResponse>({ ok: true, data: report });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  // M-C: Daemon-driven page-level Dream tick. Idempotent — daemon
  // schedules these per workspace on its idle gate; the cloud is just
  // the executor. Body accepts `{ workspaceId, sessionAgentId? }`. No
  // ACL gate beyond the standard auth middleware: only the workspace
  // owner agent can trigger; the daemon authenticates as that agent
  // before posting here.
  router.post('/page-dream', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const { runPageDream } = await import('../services/memory-page-dream.service');
      const sessionAgent = typeof body.sessionAgentId === 'string' ? body.sessionAgentId : null;
      const result = await runPageDream(resolved.acl.workspaceId, sessionAgent);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  // M-D: independent HTML write. Updates only `contentHtml` +
  // `contentHtmlVersion = 0`; markdown side untouched. The rich-text
  // editor in Library calls this; pipelines that produce both markdown
  // and HTML use `POST /memory/pages` (or asset upsert) with the
  // `contentHtml` field instead.
  router.patch('/pages/:id/html', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId ?? c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      if (typeof body.contentHtml !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'contentHtml is required' }, 400);
      }
      const updated = await memoryWriteService.updateHtml({
        acl: resolved.acl,
        pageId: c.req.param('id'),
        contentHtml: body.contentHtml,
        ifMatch: c.req.header('If-Match'),
      });
      c.header('ETag', `W/"${updated.version}"`);
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.patch('/pages/:id/visibility', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const updated = await memoryWriteService.changeVisibility({
        acl: resolved.acl,
        pageId: c.req.param('id'),
        visibility: body.visibility,
        reason: body.reason,
        ifMatch: c.req.header('If-Match'),
      });
      c.header('ETag', `W/"${updated.version}"`);
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/pages/:id/promote', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const resolved = await resolveAcl(c, body.workspaceId ?? c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const updated = await memoryWriteService.promote(resolved.acl, c.req.param('id'), c.req.header('If-Match'));
      c.header('ETag', `W/"${updated.version}"`);
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.patch('/pages/:id/stale', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const updated = await memoryWriteService.setStale(
        resolved.acl,
        c.req.param('id'),
        Boolean(body.stale),
        body.reason,
      );
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/sync/inbox', async (c) => {
    try {
      const body = await c.req.json();
      if (!Array.isArray(body.events)) {
        return c.json<ApiResponse>({ ok: false, error: 'events[] required' }, 400);
      }
      // Each event already carries workspaceId + actorImUserId; we still
      // verify the JWT subject matches the actor to prevent cross-actor
      // forwarding via the sync inbox.
      const user = c.get('user');
      const events = body.events.filter((ev: { actorImUserId?: string }) => ev?.actorImUserId === user.imUserId);
      if (events.length !== body.events.length) {
        return c.json<ApiResponse>(
          { ok: false, error: 'sync inbox events must originate from the authenticated actor' },
          403,
        );
      }
      const callerKind: 'user' | 'agent' = user.role === 'agent' ? 'agent' : 'user';
      const result = await memoryWriteService.ingestSyncInbox(events, {
        imUserId: user.imUserId,
        callerKind,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/observability/feedback', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const result = await memoryWriteService.recordFeedback({
        acl: resolved.acl,
        workspaceId: resolved.acl.workspaceId,
        sessionId: body.sessionId,
        pageId: body.pageId,
        targetEventId: body.targetEventId,
        signal: body.signal,
        note: body.note,
        query: body.query,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  // ─── Proposals (A4) ────────────────────────────────────────
  router.post('/proposals', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const created = await memoryProposalService.create({
        acl: resolved.acl,
        pagePath: body.pagePath,
        baseVersion: Number(body.baseVersion),
        operation: body.operation as ProposalOperation,
        contentDiff: body.contentDiff,
        rationale: body.rationale,
        confidence: Number(body.confidence),
        sourceRefs: body.sourceRefs,
        sessionId: body.sessionId,
        ttlDays: body.ttlDays,
      });
      return c.json<ApiResponse>({ ok: true, data: created }, 201);
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.get('/proposals', async (c) => {
    try {
      const resolved = await resolveAcl(c, c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const data = await memoryProposalService.list({
        acl: resolved.acl,
        status: c.req.query('status') ?? undefined,
        sessionId: c.req.query('sessionId') ?? undefined,
        pagePath: c.req.query('pagePath') ?? undefined,
        limit: parseInt(c.req.query('limit') ?? '', 10) || undefined,
      });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/proposals/bulk-approve', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const data = await memoryProposalService.bulkApprove({
        acl: resolved.acl,
        sessionId: body.sessionId,
        proposalIds: body.proposalIds,
      });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/proposals/:id/approve', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const resolved = await resolveAcl(c, body.workspaceId ?? c.req.query('workspaceId'));
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const data = await memoryProposalService.approve(resolved.acl, c.req.param('id'));
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  router.post('/proposals/:id/reject', async (c) => {
    try {
      const body = await c.req.json();
      const resolved = await resolveAcl(c, body.workspaceId);
      if ('response' in resolved) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.acl.workspaceId);
      if (denied) return denied;
      const data = await memoryProposalService.reject(resolved.acl, c.req.param('id'), body.reason);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return handleWriteError(c, err);
    }
  });

  // ─── Search (A5) ───────────────────────────────────────────
  router.get('/search', async (c) => {
    const resolved = await resolveAcl(c, c.req.query('workspaceId'));
    if ('response' in resolved) return resolved.response;
    const q = c.req.query('q') ?? '';
    if (!q.trim()) {
      return c.json<ApiResponse>({ ok: false, error: 'q is required' }, 400);
    }
    const pageType = c.req.query('pageType')?.split(',').filter(Boolean);
    const stale = c.req.query('stale') as 'true' | 'false' | 'all' | undefined;
    const kind = c.req.query('kind') as 'memory' | 'files' | 'both' | undefined;
    const visibility = c.req.query('visibility') ?? undefined;
    const cursor = c.req.query('cursor') ?? null;
    const limit = parseInt(c.req.query('limit') ?? '', 10) || undefined;
    const encryptionMode = (c.req.query('encryptionMode') as EncryptionMode | undefined) ?? 'standard';

    try {
      const result = await memorySearchService.search({
        acl: resolved.acl,
        query: q,
        pageType,
        stale,
        kind,
        visibility,
        cursor,
        limit,
        encryptionMode,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof MemorySearchError) {
        return c.json<ApiResponse>(
          { ok: false, error: err.message, meta: { code: err.code } },
          err.status as 400 | 401 | 403 | 404,
        );
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Memory Files (Episodic Memory)
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /memory/files — Create or upsert a memory file
   *
   * Body: { path: string, content: string, ownerType?: string }
   * Upserts by (ownerId, path) — if exists, replaces content.
   *
   * v1.9.2: `scope` field on im_memory_files dropped; the body still accepts a
   * `scope` key from older SDKs but it is ignored.
   */
  router.post('/files', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    const { path, content } = body;

    if (!path || typeof path !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'path is required' }, 400);
    }
    if (content === undefined || content === null) {
      return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
    }
    if (typeof content === 'string' && content.length > MAX_CONTENT_SIZE) {
      return c.json<ApiResponse>({ ok: false, error: `content exceeds max size (${MAX_CONTENT_SIZE} bytes)` }, 400);
    }

    const resolved = await resolveWorkspace(c, body.workspaceId);
    if (resolved.response) return resolved.response;
    const denied = await requireMemoryWriteAllowed(c, resolved.workspaceId!);
    if (denied) return denied;

    const result = await memoryService.writeMemoryFile(
      resolved.workspaceId!,
      user.imUserId,
      user.role === 'agent' ? 'agent' : 'user',
      path,
      String(content),
      'global',
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
        },
      })
      .catch(() => {});

    return c.json<ApiResponse>({ ok: true, data: result }, 201);
  });

  /**
   * GET /memory/files — List memory files (metadata only)
   *
   * Query: ?path=MEMORY.md&memoryType=project&stale=false&sort=updatedAt&order=desc
   *
   * v1.9.2: `scope` query param accepted but ignored (im_memory_files.scope dropped).
   */
  router.get('/files', async (c) => {
    const user = c.get('user');
    const workspaceIdParam = c.req.query('workspaceId');
    const path = c.req.query('path');
    const memoryType = c.req.query('memoryType');
    const staleParam = c.req.query('stale');
    const sort = c.req.query('sort');
    const order = c.req.query('order') as 'asc' | 'desc' | undefined;

    const stale = staleParam === 'true' ? true : staleParam === 'false' ? false : undefined;

    const resolved = await resolveWorkspace(c, workspaceIdParam);
    if (resolved.response) return resolved.response;

    const files = await memoryService.listMemoryFiles(
      resolved.workspaceId!,
      user.imUserId,
      undefined,
      path,
      memoryType,
      stale,
      sort,
      order,
    );
    return c.json<ApiResponse>({ ok: true, data: files });
  });

  /**
   * GET /memory/files/:id — Read a memory file (with content)
   */
  router.get('/files/:id', async (c) => {
    try {
      const resolved = await resolveWorkspace(c, c.req.query('workspaceId'));
      if (resolved.response) return resolved.response;
      const file = await memoryService.readMemoryFile(c.req.param('id')!, resolved.workspaceId!);
      const user = c.get('user');
      // v2.0.7.1 hotfix (B11): workspace-shared rows carry the `__shared__`
      // sentinel ownerId; the strict ownerId-equality check below hid them
      // from every caller, including the writer.
      if (!memoryService.isFileReadableByCaller(file, user.imUserId)) {
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
      const resolved = await resolveWorkspace(c, body.workspaceId);
      if (resolved.response) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.workspaceId!);
      if (denied) return denied;

      // Pre-check ownership.
      // v2.0.7.1 hotfix (B11): workspace-shared rows live under the
      // `__shared__` sentinel; any workspace caller (already gated by the
      // resolver) may PATCH them. Strict ownerId-equality previously locked
      // out the writer themselves.
      const existing = await memoryService.readMemoryFile(c.req.param('id'), resolved.workspaceId!);
      if (!memoryService.isFileReadableByCaller(existing, user.imUserId)) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      const result = await memoryService.updateMemoryFile(
        c.req.param('id')!,
        resolved.workspaceId!,
        operation as MemoryFileOperation,
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
      const resolved = await resolveWorkspace(c, c.req.query('workspaceId'));
      if (resolved.response) return resolved.response;
      const denied = await requireMemoryWriteAllowed(c, resolved.workspaceId!);
      if (denied) return denied;

      const existing = await memoryService.readMemoryFile(c.req.param('id'), resolved.workspaceId!);
      // v2.0.7.1 hotfix (B11): workspace-shared rows are deletable by any
      // workspace caller (resolver-gated upstream). See isFileReadableByCaller.
      if (!memoryService.isFileReadableByCaller(existing, user.imUserId)) {
        return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
      }

      await memoryService.deleteMemoryFile(c.req.param('id')!, resolved.workspaceId!);
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
    const denied = await requireAgentToolAllowed(
      c,
      'prismer.memory.write',
      await resolveConversationWorkspaceId(conversationId),
    );
    if (denied) return denied;

    const result = await memoryService.compact(conversationId, summary, messageRangeStart, messageRangeEnd);

    return c.json<ApiResponse>({ ok: true, data: result }, 201);
  });

  /**
   * GET /memory/compact/:conversationId — Get compaction summaries
   */
  router.get('/compact/:conversationId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId')!;

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
    const workspaceIdParam = c.req.query('workspaceId');
    const scope = c.req.query('scope') ?? 'global';
    const path = c.req.query('path') ?? 'MEMORY.md';

    const resolved = await resolveWorkspace(c, workspaceIdParam);
    if (resolved.response) return resolved.response;

    const memory = await memoryService.loadMemoryFile(resolved.workspaceId!, user.imUserId, scope, path);

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
    const workspaceIdParam = c.req.query('workspaceId');
    const scope = c.req.query('scope') ?? 'global';
    const maxLines = Number.parseInt(c.req.query('maxLines') || '200', 10);
    const maxBytes = Number.parseInt(c.req.query('maxBytes') || '6000', 10);

    // Sanity clamps to prevent runaway queries
    const clampedMaxLines = Math.max(10, Math.min(maxLines, 1000));
    const clampedMaxBytes = Math.max(500, Math.min(maxBytes, 30000));

    const resolved = await resolveWorkspace(c, workspaceIdParam);
    if (resolved.response) return resolved.response;

    const result = await memoryService.buildDigest(resolved.workspaceId!, user.imUserId, {
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
    const body = await c.req.json().catch(() => ({}));
    const scope = c.req.query('scope') ?? 'global';
    const resolved = await resolveWorkspace(c, body.workspaceId ?? c.req.query('workspaceId'));
    if (resolved.response) return resolved.response;
    const denied = await requireMemoryWriteAllowed(c, resolved.workspaceId!);
    if (denied) return denied;
    const result = await runDream(user.imUserId, resolved.workspaceId!, scope);
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

    const resolved = await resolveWorkspace(c, body.workspaceId);
    if (resolved.response) return resolved.response;
    const denied = await requireMemoryWriteAllowed(c, resolved.workspaceId!);
    if (denied) return denied;

    const result = await extractMemories(memoryService, {
      workspaceId: resolved.workspaceId!,
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

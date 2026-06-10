/**
 * release201/26 Phase 2 — admin L2 conversational-memory endpoints.
 *
 * Covers RBAC + happy path for:
 *   GET  /conversations/:id/memory
 *   POST /conversations/:id/memory/segments/:seq/regenerate
 *
 * RBAC mirrors runtime-diagnose.ts / daemon-health.ts: `user.role === 'admin'`.
 * Non-admins get 403 even when authenticated. The compaction producer
 * (`conversationCompactionService.regenerateSegment`) is mocked — this suite
 * verifies the endpoint wiring + RBAC, not producer logic (owned by the
 * parallel conversation-compaction.service work).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMConversation: { findUnique: vi.fn() },
  iMConversationCompressedSegment: { findMany: vi.fn() },
  iMConversationIdentifierIndex: { findMany: vi.fn() },
}));

const compaction = vi.hoisted(() => ({
  regenerateSegment: vi.fn(),
}));

// Auth middleware injects the role under test via a module-level holder.
const authState = vi.hoisted(() => ({ role: 'admin' as string, imUserId: 'u-1' }));

vi.mock('../db', () => ({ default: prisma }));
vi.mock('../auth/middleware', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { imUserId: authState.imUserId, role: authState.role });
    return next();
  }),
}));
vi.mock('../services/conversation-compaction.service', () => ({
  conversationCompactionService: compaction,
}));

function makeRouter() {
  // ConversationService methods are not exercised by the memory endpoints;
  // a bare object satisfies the constructor signature.
  const conversationService = {} as any;
  return import('../api/conversations').then(({ createConversationsRouter }) =>
    createConversationsRouter(conversationService),
  );
}

describe('release201/26 admin conversation-memory endpoints', () => {
  beforeEach(() => {
    prisma.iMConversation.findUnique.mockReset();
    prisma.iMConversationCompressedSegment.findMany.mockReset();
    prisma.iMConversationIdentifierIndex.findMany.mockReset();
    compaction.regenerateSegment.mockReset();
    authState.role = 'admin';
    authState.imUserId = 'u-1';
  });

  describe('GET /:id/memory', () => {
    it('403 for non-admin', async () => {
      authState.role = 'human';
      const router = await makeRouter();
      const res = await router.request('/conv-1/memory');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      // RBAC must short-circuit before any DB read.
      expect(prisma.iMConversation.findUnique).not.toHaveBeenCalled();
    });

    it('404 when conversation missing (admin)', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue(null);
      const router = await makeRouter();
      const res = await router.request('/conv-x/memory');
      expect(res.status).toBe(404);
    });

    it('200 returns segments + identifiers (admin)', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      prisma.iMConversationCompressedSegment.findMany.mockResolvedValue([
        { id: 'seg-1', segmentSeq: 0, summary: 'hello', supersededBy: null },
      ]);
      prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([]);

      const router = await makeRouter();
      const res = await router.request('/conv-1/memory');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.segments).toHaveLength(1);
      expect(body.data.identifiers).toEqual([]);

      // Default: only current (non-superseded) segments.
      const where = prisma.iMConversationCompressedSegment.findMany.mock.calls[0][0].where;
      expect(where.supersededBy).toBe(null);
    });

    it('includeSuperseded=1 drops the supersededBy filter', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      prisma.iMConversationCompressedSegment.findMany.mockResolvedValue([]);
      prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([]);

      const router = await makeRouter();
      const res = await router.request('/conv-1/memory?includeSuperseded=1');
      expect(res.status).toBe(200);
      const where = prisma.iMConversationCompressedSegment.findMany.mock.calls[0][0].where;
      expect('supersededBy' in where).toBe(false);
    });
  });

  describe('POST /:id/memory/segments/:seq/regenerate', () => {
    it('403 for non-admin', async () => {
      authState.role = 'human';
      const router = await makeRouter();
      const res = await router.request('/conv-1/memory/segments/0/regenerate', { method: 'POST' });
      expect(res.status).toBe(403);
      expect(compaction.regenerateSegment).not.toHaveBeenCalled();
    });

    it('400 on non-integer seq', async () => {
      const router = await makeRouter();
      const res = await router.request('/conv-1/memory/segments/abc/regenerate', { method: 'POST' });
      expect(res.status).toBe(400);
      expect(compaction.regenerateSegment).not.toHaveBeenCalled();
    });

    it('404 when conversation missing', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue(null);
      const router = await makeRouter();
      const res = await router.request('/conv-x/memory/segments/0/regenerate', { method: 'POST' });
      expect(res.status).toBe(404);
      expect(compaction.regenerateSegment).not.toHaveBeenCalled();
    });

    it('200 delegates to conversationCompactionService.regenerateSegment (admin)', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      compaction.regenerateSegment.mockResolvedValue({ id: 'seg-new', segmentSeq: 2 });

      const router = await makeRouter();
      const res = await router.request('/conv-1/memory/segments/2/regenerate', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.segment).toEqual({ id: 'seg-new', segmentSeq: 2 });
      expect(compaction.regenerateSegment).toHaveBeenCalledWith('conv-1', 2);
    });

    it('404 when producer returns null (no such segment)', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      compaction.regenerateSegment.mockResolvedValue(null);

      const router = await makeRouter();
      const res = await router.request('/conv-1/memory/segments/9/regenerate', { method: 'POST' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it('500 when producer throws', async () => {
      prisma.iMConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      compaction.regenerateSegment.mockRejectedValue(new Error('producer boom'));

      const router = await makeRouter();
      const res = await router.request('/conv-1/memory/segments/0/regenerate', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });
});

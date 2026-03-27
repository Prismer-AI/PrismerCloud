/**
 * Prismer IM — Conversation Policies API (Layer 3)
 *
 * CRUD for conversation-level access control rules.
 * Only conversation owner/admin can manage policies.
 *
 * POST   /api/conversations/:id/policies           — Add a policy rule
 * GET    /api/conversations/:id/policies            — List policies
 * DELETE /api/conversations/:id/policies/:policyId  — Remove a policy
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ConversationService } from '../services/conversation.service';
import prisma from '../db';
import type { ApiResponse } from '../types/index';

/**
 * Verify that the user is an owner or admin of the conversation.
 */
async function verifyPolicyAdmin(
  conversationId: string,
  imUserId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: 403 | 404 }> {
  const participant = await prisma.iMParticipant.findUnique({
    where: {
      conversationId_imUserId: { conversationId, imUserId },
    },
    select: { role: true, leftAt: true },
  });

  if (!participant || participant.leftAt) {
    return { ok: false, error: 'Not a participant', status: 403 };
  }

  // Accept owner/admin AND the conversation creator (first participant)
  // In Prismer IM, role is typically 'human'/'agent'/'member'.
  // The creator is determined by checking if they're the first participant.
  if (['owner', 'admin'].includes(participant.role)) {
    return { ok: true };
  }

  // Fallback: check if user is the first (creator) participant
  const firstParticipant = await prisma.iMParticipant.findFirst({
    where: { conversationId, leftAt: null },
    orderBy: { joinedAt: 'asc' },
    select: { imUserId: true },
  });
  if (firstParticipant?.imUserId === imUserId) {
    return { ok: true };
  }

  return { ok: false, error: 'Only conversation creator or admin can manage policies', status: 403 };
}

export function createPoliciesRouter(conversationService: ConversationService) {
  const router = new Hono();

  router.use('*', authMiddleware);

  /**
   * POST /api/conversations/:id/policies — Add a policy rule
   *
   * Body: { rule, subjectType, subjectId, action }
   *   rule:        'allow' | 'deny'
   *   subjectType: 'user' | 'role' | 'trustTier'
   *   subjectId:   user ID, role name, or trust tier
   *   action:      'send' | 'read' | 'invite' | 'admin'
   */
  router.post('/:id/policies', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id');

    // Verify participation and admin/owner role
    const authResult = await verifyPolicyAdmin(conversationId, user.imUserId);
    if (!authResult.ok) {
      return c.json<ApiResponse>({ ok: false, error: authResult.error }, authResult.status);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { rule, subjectType, subjectId, action } = body as {
      rule?: string;
      subjectType?: string;
      subjectId?: string;
      action?: string;
    };

    // Validate required fields
    if (!rule || !subjectType || !subjectId || !action) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'rule, subjectType, subjectId, and action are required',
        },
        400,
      );
    }

    // Validate enum values
    if (!['allow', 'deny'].includes(rule)) {
      return c.json<ApiResponse>({ ok: false, error: 'rule must be "allow" or "deny"' }, 400);
    }
    if (!['user', 'role', 'trustTier'].includes(subjectType)) {
      return c.json<ApiResponse>({ ok: false, error: 'subjectType must be "user", "role", or "trustTier"' }, 400);
    }
    if (!['send', 'read', 'invite', 'admin'].includes(action)) {
      return c.json<ApiResponse>({ ok: false, error: 'action must be "send", "read", "invite", or "admin"' }, 400);
    }

    // Upsert (unique constraint: conversationId + subjectType + subjectId + action)
    try {
      const policy = await prisma.iMConversationPolicy.upsert({
        where: {
          conversationId_subjectType_subjectId_action: {
            conversationId,
            subjectType,
            subjectId,
            action,
          },
        },
        update: { rule },
        create: {
          conversationId,
          rule,
          subjectType,
          subjectId,
          action,
        },
      });

      return c.json<ApiResponse>({ ok: true, data: policy }, 201);
    } catch (err) {
      console.error('[Policies] Create error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to create policy' }, 500);
    }
  });

  /**
   * GET /api/conversations/:id/policies — List policies for a conversation
   *
   * Query params:
   *   action — Filter by action (optional)
   */
  router.get('/:id/policies', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id');
    const actionFilter = c.req.query('action');

    // Any participant can view policies
    const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const where: { conversationId: string; action?: string } = { conversationId };
    if (actionFilter) {
      where.action = actionFilter;
    }

    const policies = await prisma.iMConversationPolicy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return c.json<ApiResponse>({ ok: true, data: policies });
  });

  /**
   * DELETE /api/conversations/:id/policies/:policyId — Remove a policy
   */
  router.delete('/:id/policies/:policyId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id');
    const policyId = c.req.param('policyId');

    // Verify participation and admin/owner role
    const authResult = await verifyPolicyAdmin(conversationId, user.imUserId);
    if (!authResult.ok) {
      return c.json<ApiResponse>({ ok: false, error: authResult.error }, authResult.status);
    }

    // Single query: delete only if policy belongs to this conversation
    const deleted = await prisma.iMConversationPolicy.deleteMany({
      where: { id: policyId, conversationId },
    });

    if (deleted.count === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'Policy not found or does not belong to this conversation' }, 404);
    }

    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}

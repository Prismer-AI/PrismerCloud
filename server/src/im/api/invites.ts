/**
 * Prismer IM — Public invite endpoints (release201/16 Phase 9, v2.0.8)
 *
 * Token-bearing routes for the workspace invite flow. Split from
 * `/workspaces/:id/invites` because the preview endpoint must be public:
 * landing pages render BEFORE the user logs in (16 §3.1.4).
 *
 * Endpoints:
 *   GET  /invites/:token          — public, no auth (preview-only fields)
 *   POST /invites/:token/accept   — requires auth (logged-in user)
 *   POST /invites/:token/reject   — requires auth
 *
 * Preview surface is deliberately minimal (16 §0.2.4 forbidden patterns):
 * workspace name + inviter avatar + role + status + expiresAt. Never expose
 * member counts, asset counts, or any workspace aggregate.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { WorkspaceInviteService } from '../services/workspace-invite.service';
import { mapInviteError } from './workspaces';
import type { ApiResponse } from '../types/index';

export function createInvitesRouter() {
  const router = new Hono();
  const inviteService = new WorkspaceInviteService();

  // GET /invites/:token — public preview. NO auth middleware.
  router.get('/:token', async (c) => {
    const token = c.req.param('token');
    if (!token || token.length < 16) {
      return c.json<ApiResponse>({ ok: false, error: 'Invite not found', meta: { code: 'INVITE_NOT_FOUND' } }, 404);
    }
    try {
      const preview = await inviteService.preview(token);
      return c.json<ApiResponse>({ ok: true, data: preview });
    } catch (err) {
      return mapInviteError(c, err);
    }
  });

  // The two mutating endpoints require auth — apply middleware AFTER the
  // public GET so it stays unauthenticated.
  router.post('/:token/accept', authMiddleware, async (c) => {
    const user = c.get('user');
    const token = c.req.param('token');
    try {
      const accepted = await inviteService.accept(token, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: accepted });
    } catch (err) {
      return mapInviteError(c, err);
    }
  });

  router.post('/:token/reject', authMiddleware, async (c) => {
    const user = c.get('user');
    const token = c.req.param('token');
    try {
      const rejected = await inviteService.reject(token, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: rejected });
    } catch (err) {
      return mapInviteError(c, err);
    }
  });

  return router;
}

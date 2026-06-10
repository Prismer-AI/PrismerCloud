import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse, ApprovalStatus } from '../types';
import {
  ApprovalAccessError,
  ApprovalConflictError,
  ApprovalNotFoundError,
  ApprovalService,
  ApprovalValidationError,
} from '../services/approval.service';
import { requireAgentToolAllowed, resolveApprovalWorkspaceId } from '../security/mcp-allowlist';

function classifyApprovalError(
  err: unknown,
): { status: 400 | 403 | 404 | 409 | 500; code: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  switch (err.name) {
    case 'ApprovalValidationError':
      return { status: 400, code: 'VALIDATION_ERROR', message: err.message };
    case 'ApprovalAccessError':
      return { status: 403, code: 'APPROVAL_ACCESS_DENIED', message: err.message };
    case 'ApprovalNotFoundError':
      return { status: 404, code: 'APPROVAL_NOT_FOUND', message: err.message };
    case 'ApprovalConflictError':
      return { status: 409, code: 'APPROVAL_CONFLICT', message: err.message };
    default:
      return null;
  }
}

function handleApprovalError(err: unknown, c: any): Response {
  const classified = classifyApprovalError(err);
  if (classified) {
    return c.json({ ok: false, error: { code: classified.code, message: classified.message } }, classified.status);
  }
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
}

export function createApprovalsRouter(approvalService: ApprovalService) {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /approvals in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  router.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const workspaceId = body.workspaceId ?? body.workspace_id;
    const allowlistWorkspaceId = await resolveApprovalWorkspaceId({
      workspaceId,
      conversationId: body.conversationId ?? body.conversation_id,
      taskId: body.taskId ?? body.task_id,
    });
    const denied = await requireAgentToolAllowed(c, 'prismer.approval.request_human_approval', allowlistWorkspaceId);
    if (denied) return denied;

    try {
      const approval = await approvalService.createApproval(user.imUserId, {
        workspaceId,
        conversationId: body.conversationId ?? body.conversation_id,
        taskId: body.taskId ?? body.task_id,
        category: body.category,
        title: body.title,
        context: body.context,
        options: body.options,
        expiresInSeconds: body.expiresInSeconds ?? body.expires_in_seconds,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: approval }, 201);
    } catch (err) {
      return handleApprovalError(err, c);
    }
  });

  router.get('/', async (c) => {
    const user = c.get('user');
    try {
      const approvals = await approvalService.listApprovals(user.imUserId, {
        workspaceId: c.req.query('workspaceId') ?? c.req.query('workspace_id'),
        conversationId: c.req.query('conversationId') ?? c.req.query('conversation_id'),
        taskId: c.req.query('taskId') ?? c.req.query('task_id'),
        status: c.req.query('status') as ApprovalStatus | undefined,
        limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
        cursor: c.req.query('cursor') ?? undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: approvals, meta: { total: approvals.length } });
    } catch (err) {
      return handleApprovalError(err, c);
    }
  });

  router.post('/:id/decision', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const allowlistWorkspaceId = await resolveApprovalWorkspaceId({
      workspaceId: body.workspaceId ?? body.workspace_id,
      approvalId: c.req.param('id'),
    });
    const denied = await requireAgentToolAllowed(c, 'prismer.approval.decide', allowlistWorkspaceId);
    if (denied) return denied;
    if (!body.selectedValue && !body.selected_value) {
      return c.json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'selectedValue is required' } }, 400);
    }

    const user = c.get('user');
    try {
      const approval = await approvalService.decideApproval(c.req.param('id'), user.imUserId, {
        selectedValue: body.selectedValue ?? body.selected_value,
        status: body.status,
        comment: body.comment ?? body.reason,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: approval });
    } catch (err) {
      return handleApprovalError(err, c);
    }
  });

  return router;
}

export { ApprovalAccessError, ApprovalConflictError, ApprovalNotFoundError, ApprovalValidationError };

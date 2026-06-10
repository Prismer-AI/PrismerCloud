/**
 * Prismer IM — Workspaces API (v1.9.x Track A m1)
 *
 * Workspace = first-class user data context. 1.9.x phase: 1:1 with IMUser.
 * See docs/refactor/02-workspace-data-model.md.
 *
 * Endpoints:
 *   GET    /workspaces            — list caller's workspaces (1:1 → 1 row)
 *   POST   /workspaces            — create (backend-only in 1.9.x)
 *   GET    /workspaces/sync       — daemon delta sync (?since=<ISO>)
 *   GET    /workspaces/:id        — get single
 *   PATCH  /workspaces/:id        — update name / metadata
 *   DELETE /workspaces/:id        — 405 in 1.9.x (deleting default = account close)
 *
 * Note: route file is plural (workspaces.ts) to coexist with the legacy 1.8.2
 * singular `workspace.ts` (workspace-IM bridge using scope strings).
 */

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import {
  previewWorkspaceClear,
  clearWorkspaceCascade,
  WorkspaceClearError,
  type ClearProgressEvent,
} from '../services/workspace-clear.service';
import { AgentSkillService } from '../services/agent-skill.service';
import { BuiltInSkillService } from '../services/built-in-skill.service';
import { SkillService } from '../services/skill.service';
import {
  WorkspaceOrchestratorService,
  type OrchestratorInfo,
  NotWorkspaceOwnerError,
  WorkspaceNotFoundError,
  AgentNotInWorkspaceError,
  AgentNotAnAgentError,
} from '../services/workspace-orchestrator.service';
import {
  WorkspaceMemberService,
  WorkspaceNotFoundError as MemberWorkspaceNotFoundError,
  WorkspaceForbiddenError as MemberWorkspaceForbiddenError,
  WorkspaceValidationError as MemberWorkspaceValidationError,
  WorkspaceConflictError as MemberWorkspaceConflictError,
  MemberNotFoundError,
  OwnerCannotBeRemovedError,
  NotContactError,
  ContactBlockedError,
  type WorkspaceRole,
} from '../services/workspace-member.service';
import {
  WorkspaceInviteService,
  InviteValidationError,
  InviteForbiddenError,
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  InviteRevokedError,
  InviteRejectedError,
  InviteAcceptedError,
  DuplicatePendingInviteError,
  PrincipalBlockedError,
  WorkspaceNotFoundError as InviteWorkspaceNotFoundError,
  type InviteRole,
} from '../services/workspace-invite.service';
import { sendEmail } from '@/lib/auth/email';
import { renderWorkspaceInviteEmail } from '@/lib/auth/email-templates';

interface WorkspaceDTO {
  id: string;
  ownerImUserId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceAgentDTO {
  agentId: string;
  userId: string;
  username: string;
  name: string;
  displayName: string;
  description: string | null;
  agentType: string | null;
  capabilities: unknown[];
  status: string;
  load: number;
}

interface WorkspaceAgentCardRow {
  id: string;
  imUserId: string;
  name: string;
  description: string | null;
  agentType: string | null;
  capabilities: string | null;
  status: string;
  load: number;
  imUser: {
    username: string;
    displayName: string;
  };
}

function toDTO(row: {
  id: string;
  ownerImUserId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceDTO {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    ownerImUserId: row.ownerImUserId,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateWorkspacesRouterOptions {
  /** Optional RoomManager — when provided, the workspace-clear cascade fans
   * the final wipe out to every daemon that hosted any agent in the cleared
   * workspace (release201/09 §9.4b). Optional so test-only harnesses can
   * skip WS wiring; production registration in routes.ts always passes it. */
  rooms?: import('../ws/rooms').RoomManager | null;
}

export function createWorkspacesRouter(options: CreateWorkspacesRouterOptions = {}) {
  const router = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /workspaces in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  // GET /workspaces — list caller's active workspaces
  router.get('/', async (c) => {
    const user = c.get('user');
    const rows = await prisma.iMWorkspace.findMany({
      where: { ownerImUserId: user.imUserId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return c.json<ApiResponse<WorkspaceDTO[]>>({ ok: true, data: rows.map(toDTO) });
  });

  // POST /workspaces — create (1.9.x backend-only; frontend should not call)
  router.post('/', async (c) => {
    const user = c.get('user');
    let body: { name?: string; slug?: string; isDefault?: boolean; metadata?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const name = (body.name ?? '').trim();
    const slug = (body.slug ?? '').trim().toLowerCase();
    if (!name || !slug) {
      return c.json<ApiResponse>({ ok: false, error: 'name and slug are required' }, 400);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      return c.json<ApiResponse>({ ok: false, error: 'slug must be 1-64 chars [a-z0-9-], leading alnum' }, 400);
    }

    // 1.9.x invariant: at most one default workspace per owner. The first workspace
    // is always default; subsequent ones are non-default. Reject explicit
    // `isDefault: true` if a default already exists (multi-workspace promotion is
    // a 1.10+ concern).
    const existingDefault = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: user.imUserId, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    if (body.isDefault === true && existingDefault) {
      return c.json<ApiResponse>({ ok: false, error: 'Owner already has a default workspace' }, 409);
    }
    const isDefault = !existingDefault;

    try {
      // release201/16 §3.2.1 + B2 hotfix (v2.0.7.1): workspace 与 owner 的
      // im_workspace_members 行必须原子创建。M444 backfill 只覆盖历史 row;
      // 新建 workspace 时 handler 自身要负责 owner 入表，否则 owner GET /members
      // 返 404 (anti-enumeration)，作 user principal 加入 project 也会被
      // NotWorkspaceMemberError 拒。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interactive tx client typing matches workspace-member.service pattern
      const created = await prisma.$transaction(async (tx: any) => {
        const ws = await tx.iMWorkspace.create({
          data: {
            ownerImUserId: user.imUserId,
            name,
            slug,
            isDefault,
            metadata: JSON.stringify(body.metadata ?? {}),
          },
        });
        await tx.iMWorkspaceMember.create({
          data: {
            workspaceId: ws.id,
            memberImUserId: user.imUserId,
            role: 'owner',
          },
        });
        return ws;
      });
      const builtInService = new BuiltInSkillService(new AgentSkillService(new SkillService()));
      await builtInService.ensureBuiltInsForWorkspace(created.id).catch((err: unknown) => {
        console.warn('[Workspaces] Built-in skill upsert failed:', err instanceof Error ? err.message : String(err));
      });
      return c.json<ApiResponse<WorkspaceDTO>>({ ok: true, data: toDTO(created) }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        return c.json<ApiResponse>({ ok: false, error: 'slug already taken for this owner' }, 409);
      }
      return c.json<ApiResponse>({ ok: false, error: msg }, 500);
    }
  });

  // GET /workspaces/sync — daemon delta sync (registered before /:id)
  router.get('/sync', async (c) => {
    const user = c.get('user');
    const sinceParam = c.req.query('since');
    const sinceDate = sinceParam ? new Date(sinceParam) : null;
    if (sinceParam && (!sinceDate || isNaN(sinceDate.getTime()))) {
      return c.json<ApiResponse>({ ok: false, error: 'since must be a valid ISO timestamp' }, 400);
    }
    const rows = await prisma.iMWorkspace.findMany({
      where: {
        ownerImUserId: user.imUserId,
        ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });
    const cursor = rows.length > 0 ? rows[rows.length - 1].updatedAt.toISOString() : (sinceParam ?? null);
    return c.json<ApiResponse<{ items: WorkspaceDTO[]; cursor: string | null }>>({
      ok: true,
      data: { items: rows.map(toDTO), cursor },
    });
  });

  // ── Orchestrator (release 200 §4 Chief of Staff) ───────────────────────────
  // These three routes must precede the generic /:id handlers so Hono never
  // treats "orchestrator" as part of the workspace id tail.

  const orchestratorService = new WorkspaceOrchestratorService();

  // GET /workspaces/:id/orchestrator — readable by any member of the workspace.
  // Returns { workspace, orchestrator } where orchestrator is null when no
  // active appointment exists. Membership is broad here (owner OR member row
  // OR an agent card pinned to the workspace) so agent runtimes can self-check
  // "am I the chief-of-staff?" before invoking high-trust task actions.
  router.get('/:id/orchestrator', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, ownerImUserId: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const isOwner = ws.ownerImUserId === user.imUserId;
    let isMember = isOwner;
    if (!isMember) {
      const memberRow = await prisma.iMWorkspaceMember.findFirst({
        where: { workspaceId: id, memberImUserId: user.imUserId },
        select: { id: true },
      });
      isMember = !!memberRow;
    }
    if (!isMember) {
      // Allow the workspace's own agents to read this too — they need to
      // discover whether they hold orchestrator authority. Agents identify
      // via their imUserId on the card row.
      const agentCard = await prisma.iMAgentCard.findFirst({
        where: { workspaceId: id, imUserId: user.imUserId },
        select: { id: true },
      });
      isMember = !!agentCard;
    }
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }

    try {
      const orchestrator = await orchestratorService.getOrchestrator(id);
      return c.json<
        ApiResponse<{
          workspace: { id: string; name: string; ownerImUserId: string };
          orchestrator: OrchestratorInfo | null;
        }>
      >({
        ok: true,
        data: {
          workspace: { id: ws.id, name: ws.name, ownerImUserId: ws.ownerImUserId },
          orchestrator,
        },
      });
    } catch (err) {
      return mapOrchestratorError(c, err);
    }
  });

  // POST /workspaces/:id/orchestrator { agentImUserId } — owner only.
  // Appointing a new orchestrator when one is already active auto-revokes the
  // previous one (single UPDATE; see service layer for invariant rationale).
  router.post('/:id/orchestrator', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: { agentImUserId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const agentImUserId = (body.agentImUserId ?? '').trim();
    if (!agentImUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentImUserId is required' }, 400);
    }
    try {
      await orchestratorService.appointOrchestrator(id, agentImUserId, user.imUserId);
      const orchestrator = await orchestratorService.getOrchestrator(id);
      return c.json<ApiResponse<{ orchestrator: OrchestratorInfo | null }>>({
        ok: true,
        data: { orchestrator },
      });
    } catch (err) {
      return mapOrchestratorError(c, err);
    }
  });

  // DELETE /workspaces/:id/orchestrator — owner only. Soft revoke; idempotent.
  router.delete('/:id/orchestrator', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      await orchestratorService.revokeOrchestrator(id, user.imUserId);
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      return mapOrchestratorError(c, err);
    }
  });

  // ── Members (release201/16 Phase 8) ────────────────────────────────────────
  // 4 endpoint, before /:id catch-alls to avoid "members" being mistaken for an id.
  // Service-layer guards encode the role rules:
  //   GET    — any workspace member (returns 404 for non-members to prevent enumeration)
  //   POST   — owner only (Phase 9 invite is the human path; this is for backend / batch sync)
  //   PATCH  — owner only
  //   DELETE — owner only; owner cannot self-remove (ownership transfer is v2.1+ RFC)

  const memberService = new WorkspaceMemberService();

  router.get('/:id/members', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      const items = await memberService.list(id, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: items });
    } catch (err) {
      return mapMemberError(c, err);
    }
  });

  router.post('/:id/members', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: { memberImUserId?: string; role?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json<ApiResponse>({ ok: false, error: 'Request body must be a JSON object' }, 400);
    }
    const memberImUserId = (body.memberImUserId ?? '').trim();
    const role = body.role as WorkspaceRole;
    try {
      const created = await memberService.add(id, user.imUserId, { memberImUserId, role });
      return c.json<ApiResponse>({ ok: true, data: created }, 201);
    } catch (err) {
      return mapMemberError(c, err);
    }
  });

  router.patch('/:id/members/:memberId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const memberId = c.req.param('memberId');
    let body: { role?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json<ApiResponse>({ ok: false, error: 'Request body must be a JSON object' }, 400);
    }
    const role = body.role as WorkspaceRole;
    try {
      const updated = await memberService.updateRole(id, user.imUserId, memberId, role);
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      return mapMemberError(c, err);
    }
  });

  router.delete('/:id/members/:memberId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const memberId = c.req.param('memberId');
    try {
      const result = await memberService.remove(id, user.imUserId, memberId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return mapMemberError(c, err);
    }
  });

  // release201/16 §3.3.3 — `from-contact` convenience.
  // POST /workspaces/:id/members/from-contact?contactId=<imUserId>[&role=member]
  // Owner/admin only. Asserts the contact relation exists on the caller's side.
  router.post('/:id/members/from-contact', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const contactId = c.req.query('contactId') ?? '';
    const roleParam = (c.req.query('role') as 'admin' | 'member' | undefined) ?? 'member';
    try {
      const created = await memberService.addFromContact(id, user.imUserId, contactId, roleParam);
      return c.json<ApiResponse>({ ok: true, data: created }, 201);
    } catch (err) {
      return mapMemberError(c, err);
    }
  });

  // ── Invites (release201/16 Phase 9) ────────────────────────────────────────
  // Workspace-scoped CRUD on outbound invites. The token-bearing endpoints
  // (preview / accept / reject) live in `invites.ts` because preview must be
  // public (no auth) and these three are owner/admin-only.

  const inviteService = new WorkspaceInviteService();

  router.post('/:id/invites', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: {
      inviteeEmail?: string;
      inviteeImUserId?: string;
      role?: string;
      expiresInDays?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json<ApiResponse>({ ok: false, error: 'Request body must be a JSON object' }, 400);
    }
    try {
      const created = await inviteService.create(id, user.imUserId, {
        inviteeEmail: body.inviteeEmail,
        inviteeImUserId: body.inviteeImUserId,
        role: body.role as InviteRole | undefined,
        expiresInDays: body.expiresInDays,
      });

      // Send the invite email (link mode only). Non-blocking: a send failure
      // must NOT fail the API — the copy-link in the response still works.
      let emailSent = false;
      if (created.inviteeEmail) {
        emailSent = await sendInviteEmail(created.inviteeEmail, created);
      }

      return c.json<ApiResponse>({ ok: true, data: { ...created, emailSent } }, 201);
    } catch (err) {
      return mapInviteError(c, err);
    }
  });

  router.get('/:id/invites', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      const items = await inviteService.list(id, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: items });
    } catch (err) {
      return mapInviteError(c, err);
    }
  });

  router.delete('/:id/invites/:inviteId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const inviteId = c.req.param('inviteId');
    try {
      const revoked = await inviteService.revoke(id, user.imUserId, inviteId);
      return c.json<ApiResponse>({ ok: true, data: revoked });
    } catch (err) {
      return mapInviteError(c, err);
    }
  });

  // GET /workspaces/:id/agents — read-only alias for the legacy singular
  // /workspace/:id/agents route. Released daemon runtimes call the plural
  // path from `prismer status`, so keep it working while the web UI migrates
  // to runtime snapshots/profile APIs. Keep this route before /:id so Hono
  // never treats "agents" as part of the workspace id tail.
  router.get('/:id/agents', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!row || row.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const agents = await listWorkspaceAgentCards(id);
    return c.json<ApiResponse>({ ok: true, data: agents });
  });

  // GET /workspaces/:id
  // release201/16 §3.3.1 + B9 hotfix (v2.0.7.1): visibility 是 workspace member
  // (含 owner / admin / member / observer 任意 role) 一致可读;
  // 旧实现硬编码 ownerImUserId === user.imUserId 把所有非 owner member 也挡 404,
  // 直接破坏 doc 16 §3.3.1 (any workspace member). 404 (not 403) 仍是
  // anti-enumeration 一致行为 (16 §0.2.4)。
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const isOwner = row.ownerImUserId === user.imUserId;
    const isMember = isOwner || (await memberService.isMember(id, user.imUserId));
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    return c.json<ApiResponse<WorkspaceDTO>>({ ok: true, data: toDTO(row) });
  });

  // PATCH /workspaces/:id — update name / metadata (slug + isDefault immutable in 1.9.x)
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row || row.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    let body: { name?: string; metadata?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim();
    }
    if (body.metadata && typeof body.metadata === 'object') {
      data.metadata = JSON.stringify(body.metadata);
    }
    if (Object.keys(data).length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'No updatable fields supplied' }, 400);
    }
    const updated = await prisma.iMWorkspace.update({ where: { id }, data });
    return c.json<ApiResponse<WorkspaceDTO>>({ ok: true, data: toDTO(updated) });
  });

  // GET /workspaces/:id/clear-preflight — read-only preview of what would
  // be deleted by a subsequent DELETE call. Owner-only.
  router.get('/:id/clear-preflight', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    if (row.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Only the workspace owner can clear it' }, 403);
    }
    try {
      const preview = await previewWorkspaceClear(id);
      return c.json<ApiResponse<typeof preview>>({ ok: true, data: preview });
    } catch (err) {
      if (err instanceof WorkspaceClearError && err.code === 'NOT_FOUND') {
        return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
      }
      throw err;
    }
  });

  // DELETE /workspaces/:id — hard-delete workspace + all child rows + active
  // K8s pods. Confirmation: client must send `?confirmName=<workspace-name>`
  // matching the row exactly (defense-in-depth against accidental destructive
  // calls; analogous to GitHub's "type the repo name to delete" pattern).
  //
  // Response: text/event-stream of progress events so the UI can render a
  // step-by-step checklist. Each event is JSON of shape ClearProgressEvent.
  // On success a final `event: complete` is emitted; on error the offending
  // step's event has status='error' and the stream closes.
  //
  // Replaces the 1.9.x 405 stub (the "deleting default = account close" rule
  // is enforced by IMUser delete + cascade flag, not by blocking ws-delete).
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const confirmName = c.req.query('confirmName');

    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
      select: { ownerImUserId: true, name: true },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    if (row.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Only the workspace owner can clear it' }, 403);
    }
    if (!confirmName || confirmName !== row.name) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'Pass ?confirmName=<workspace-name> exactly matching the workspace title to confirm deletion',
        },
        400,
      );
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      const emit = async (event: ClearProgressEvent): Promise<void> => {
        if (closed) return;
        try {
          await stream.writeSSE({
            event: event.status === 'error' ? 'error' : 'progress',
            data: JSON.stringify(event),
          });
        } catch {
          closed = true;
        }
      };
      try {
        await clearWorkspaceCascade(id, emit, { rooms: options.rooms ?? null });
        await stream.writeSSE({ event: 'complete', data: JSON.stringify({ workspaceId: id }) }).catch(() => {
          /* client already disconnected */
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: msg }) }).catch(() => {
          /* client already disconnected */
        });
      }
    });
  });

  return router;
}

async function listWorkspaceAgentCards(workspaceId: string): Promise<WorkspaceAgentDTO[]> {
  const cards = await prisma.iMAgentCard.findMany({
    where: { workspaceId },
    include: { imUser: { select: { id: true, username: true, displayName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return (cards as WorkspaceAgentCardRow[]).map((card) => ({
    agentId: card.id,
    userId: card.imUserId,
    username: card.imUser.username,
    name: card.name || card.imUser.displayName || card.imUser.username,
    displayName: card.imUser.displayName || card.name || card.imUser.username,
    description: card.description,
    agentType: card.agentType,
    capabilities: parseJsonArray(card.capabilities),
    status: card.status,
    load: card.load,
  }));
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 16 §3.3.4 — error code → HTTP status mapping for workspace invites endpoints.
/**
 * Resolve the public app base URL for building absolute invite links.
 * Mirrors the convention used by asset-derivative-lambda.service.ts
 * (NEXT_PUBLIC_APP_URL / PRISMER_BASE_URL), falling back to prod.
 */
function resolveAppBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.PRISMER_BASE_URL ||
    'https://prismer.cloud';
  return raw.replace(/\/+$/, '');
}

/**
 * Fire the workspace-invite email for a freshly-created link invite.
 * Non-blocking by contract: never throws — returns whether the send
 * succeeded so the caller can surface `emailSent` without coupling the
 * invite-create outcome to mail delivery.
 */
async function sendInviteEmail(
  to: string,
  invite: { workspaceId: string; inviterUserId: string; token: string; role: InviteRole; expiresAt: string },
): Promise<boolean> {
  try {
    const [ws, inviter] = await Promise.all([
      prisma.iMWorkspace.findUnique({ where: { id: invite.workspaceId }, select: { name: true } }),
      prisma.iMUser.findUnique({
        where: { id: invite.inviterUserId },
        select: { displayName: true, username: true },
      }),
    ]);
    const acceptUrl = `${resolveAppBaseUrl()}/invite/${invite.token}`;
    const rendered = renderWorkspaceInviteEmail({
      workspaceName: ws?.name ?? 'a Prismer workspace',
      inviterDisplayName: inviter?.displayName ?? inviter?.username ?? 'A Prismer user',
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptUrl,
    });
    const result = await sendEmail(to, rendered, 'workspace-invite');
    if (!result.success) {
      console.warn(
        `[Workspaces] invite email not sent (configured=${result.configured}) to=${to}: ${result.error ?? 'no provider configured'}`,
      );
    }
    return result.success;
  } catch (err) {
    console.warn('[Workspaces] invite email send threw (non-fatal):', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// Exported so the standalone /invites router can reuse it.
export function mapInviteError(c: Context, err: unknown): Response {
  if (err instanceof InviteNotFoundError || err instanceof InviteWorkspaceNotFoundError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 404);
  }
  if (err instanceof InviteForbiddenError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 403);
  }
  if (
    err instanceof InviteExpiredError ||
    err instanceof InviteAlreadyUsedError ||
    err instanceof InviteRevokedError ||
    err instanceof InviteRejectedError ||
    err instanceof InviteAcceptedError
  ) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 410);
  }
  if (err instanceof DuplicatePendingInviteError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 409);
  }
  if (err instanceof PrincipalBlockedError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 422);
  }
  if (err instanceof InviteValidationError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 400);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[Workspaces] invites endpoint unexpected error:', msg);
  return c.json<ApiResponse>({ ok: false, error: msg }, 500);
}

// 16 §3.3.4 — error code → HTTP status mapping for workspace members endpoints.
function mapMemberError(c: Context, err: unknown): Response {
  if (
    err instanceof MemberWorkspaceNotFoundError ||
    err instanceof MemberNotFoundError ||
    err instanceof NotContactError
  ) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 404);
  }
  if (err instanceof MemberWorkspaceForbiddenError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 403);
  }
  if (err instanceof OwnerCannotBeRemovedError || err instanceof ContactBlockedError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 422);
  }
  if (err instanceof MemberWorkspaceValidationError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 400);
  }
  if (err instanceof MemberWorkspaceConflictError) {
    return c.json<ApiResponse>({ ok: false, error: err.message, meta: { code: err.code } }, 409);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[Workspaces] members endpoint unexpected error:', msg);
  return c.json<ApiResponse>({ ok: false, error: msg }, 500);
}

// ContentfulStatusCode union is unwieldy here; the cast localizes the assertion.
function mapOrchestratorError(c: Context, err: unknown): Response {
  if (
    err instanceof NotWorkspaceOwnerError ||
    err instanceof WorkspaceNotFoundError ||
    err instanceof AgentNotInWorkspaceError ||
    err instanceof AgentNotAnAgentError
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: err.message, meta: { code: err.code } },
      err.status as 400 | 403 | 404,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return c.json<ApiResponse>({ ok: false, error: msg }, 500);
}

/**
 * WorkspaceMemberService — release201/16 Phase 8 (v2.0.8).
 *
 * Workspace 成员 ACL CRUD. M444 backfill 后 owner 已经写入 im_workspace_members
 * 作 role='owner' 行; 本 service 负责 4 个 endpoint:
 *
 *   GET    /workspaces/:id/members
 *   POST   /workspaces/:id/members
 *   PATCH  /workspaces/:id/members/:memberId
 *   DELETE /workspaces/:id/members/:memberId
 *
 * Permission 模型 (16 §3.3.1):
 *   - list     : workspace member 可读 (含 owner)
 *   - add      : 仅 workspace owner 可写 (Phase 8 简化, Phase 9 invite endpoint 是
 *                正常路径; 本 endpoint 给 backend / 企业目录批量同步用)
 *   - patch    : 仅 workspace owner (role 改动)
 *   - delete   : 仅 workspace owner; owner 自己不能被移除 (必须先 transfer ownership,
 *                v2.1+ RFC); cascade 删除该 user 所有 project memberships
 *
 * Role enum:
 *   'owner' | 'admin' | 'member'
 *
 * Cascade (16 §3.2.3 + §0.2.3):
 *   workspace member remove → 事务删除该 user 在该 workspace 下所有
 *   project memberships (principalKind='user' AND principalId=memberId AND
 *   projectId IN (SELECT id FROM im_projects WHERE workspaceId=W))
 *
 * 与 Project 不对称:
 *   - workspace owner 入 im_workspace_members 表 (M444 backfill 已做)
 *   - project owner 不入 im_agent_project_memberships (09 §5.2 service 层短路)
 *   见 16 doc §5.1.
 */

import prisma from '../db';
import { ContactService } from './contact.service';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface WorkspaceMemberDTO {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class WorkspaceNotFoundError extends Error {
  code = 'WORKSPACE_NOT_FOUND';
  status = 404 as const;
  constructor(id: string) {
    super(`Workspace ${id} not found`);
  }
}

export class WorkspaceForbiddenError extends Error {
  code = 'WORKSPACE_FORBIDDEN';
  status = 403 as const;
  constructor(reason: string) {
    super(reason);
  }
}

export class WorkspaceValidationError extends Error {
  code = 'WORKSPACE_VALIDATION';
  status = 400 as const;
  constructor(reason: string) {
    super(reason);
  }
}

export class WorkspaceConflictError extends Error {
  code = 'WORKSPACE_CONFLICT';
  status = 409 as const;
  constructor(reason: string) {
    super(reason);
  }
}

export class MemberNotFoundError extends Error {
  code = 'MEMBER_NOT_FOUND';
  status = 404 as const;
  constructor(id: string) {
    super(`Workspace member ${id} not found`);
  }
}

export class OwnerCannotBeRemovedError extends Error {
  code = 'OWNER_CANNOT_BE_REMOVED';
  status = 422 as const;
  constructor() {
    super('Workspace owner cannot be removed without ownership transfer (v2.1+ RFC). ' + 'See release201/16 §5.2.');
  }
}

// release201/16 Phase 10 §3.3.3 — `from-contact` requires an existing
// contact relation between caller and the target. Treat "not a contact"
// as 404 (not 403) so we don't reveal whether the target imUser exists.
export class NotContactError extends Error {
  code = 'NOT_CONTACT';
  status = 404 as const;
  constructor() {
    super('Target user is not in your contacts');
  }
}

export class ContactBlockedError extends Error {
  code = 'PRINCIPAL_BLOCKED';
  status = 422 as const;
  constructor() {
    super('Block relationship prevents this action');
  }
}

// ── Type guards ───────────────────────────────────────────────────────────

function isValidRole(role: unknown): role is WorkspaceRole {
  return role === 'owner' || role === 'admin' || role === 'member';
}

function toDTO(row: {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: string;
  joinedAt: Date;
}): WorkspaceMemberDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    memberImUserId: row.memberImUserId,
    role: (isValidRole(row.role) ? row.role : 'member') as WorkspaceRole,
    joinedAt: row.joinedAt.toISOString(),
  };
}

// ── Service ───────────────────────────────────────────────────────────────

export class WorkspaceMemberService {
  constructor(private contacts: ContactService = new ContactService()) {}

  /**
   * Whether actor is a member of the workspace (any role). Used by task-permission
   * and by route guards. Owner is always a member (M444 backfill ensures the
   * row exists; ownerImUserId field is preserved for back-compat reads).
   */
  async isMember(workspaceId: string, actorImUserId: string): Promise<boolean> {
    const row = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Returns the actor's role in the workspace, or null if not a member.
   * Source of truth for task-permission.ts L1/L3.
   */
  async getRole(workspaceId: string, actorImUserId: string): Promise<WorkspaceRole | null> {
    const row = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    if (!row) return null;
    return isValidRole(row.role) ? row.role : 'member';
  }

  /**
   * 16 §3.3.1: list 任何 member 可读. 含 owner 行.
   */
  async list(workspaceId: string, actorImUserId: string): Promise<WorkspaceMemberDTO[]> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    if (!(await this.isMember(workspaceId, actorImUserId))) {
      // 不暴露 workspace 是否存在 — 404 而非 403, 与 16 §0.2.4 防 enumeration 一致
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const rows = await prisma.iMWorkspaceMember.findMany({
      where: { workspaceId },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });
    return rows.map(toDTO);
  }

  /**
   * 16 §3.3.1 + B10 hotfix (v2.0.7.1): owner OR admin 可写.
   * POST 直接 add 是企业目录批量同步路径; 常规人工邀请走 Phase 9 invite endpoint.
   * Admin 与 owner 等同管理 member, 与 invite service / from-contact 一致.
   */
  async add(
    workspaceId: string,
    actorImUserId: string,
    params: { memberImUserId: string; role: WorkspaceRole },
  ): Promise<WorkspaceMemberDTO> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      throw new WorkspaceForbiddenError('Only workspace owner/admin can add members directly');
    }

    if (!params.memberImUserId || !params.memberImUserId.trim()) {
      throw new WorkspaceValidationError('memberImUserId is required');
    }
    if (!isValidRole(params.role)) {
      throw new WorkspaceValidationError('role must be owner|admin|member');
    }
    // Phase 8 不允许通过 POST 把 owner role 给别人 — 那是 ownership transfer (v2.1+)
    if (params.role === 'owner') {
      throw new WorkspaceValidationError('role=owner cannot be assigned via POST; use ownership transfer (v2.1+ RFC)');
    }

    // 不强制要 memberImUserId 是已存在的 IMUser — Phase 9 invite 流程时
    // invitee 可能尚未注册 (邮件邀请). 但 FK 在 schema 100 强制了, 所以这里
    // 当前必须是已存在的 user. (Phase 9 会引入 invite 表分离这件事.)
    const userExists = await prisma.iMUser.findUnique({
      where: { id: params.memberImUserId.trim() },
      select: { id: true },
    });
    if (!userExists) {
      throw new WorkspaceValidationError(`im user ${params.memberImUserId} does not exist`);
    }

    try {
      const created = await prisma.iMWorkspaceMember.create({
        data: {
          workspaceId,
          memberImUserId: params.memberImUserId.trim(),
          role: params.role,
        },
      });
      return toDTO(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        throw new WorkspaceConflictError('user already a member of this workspace');
      }
      throw err;
    }
  }

  /**
   * 16 §3.3.3 — convenience endpoint: add a workspace member when the caller
   * already has the target in their contact list. Skips the invite flow
   * because the contact relation is the consent receipt.
   *
   * Differs from `add` in two ways:
   *   - owner OR admin may call (not just owner) — same auth posture as invite
   *   - contact relation must exist on the caller's side; we don't probe the
   *     reverse direction so an asymmetric "I added them but they didn't add
   *     me back" state cannot be exploited (16 §0.2.4)
   *
   * Returns the new (or already-existing) membership row so the UI can
   * render the same "added" state idempotently.
   */
  async addFromContact(
    workspaceId: string,
    actorImUserId: string,
    contactImUserId: string,
    role: 'admin' | 'member' = 'member',
  ): Promise<WorkspaceMemberDTO> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      throw new WorkspaceForbiddenError('Only workspace owner/admin can add members from contacts');
    }

    if (!contactImUserId || !contactImUserId.trim()) {
      throw new WorkspaceValidationError('contactId is required');
    }
    if (role !== 'admin' && role !== 'member') {
      throw new WorkspaceValidationError('role must be admin or member');
    }
    const targetId = contactImUserId.trim();
    if (targetId === actorImUserId) {
      throw new WorkspaceValidationError('Cannot add yourself');
    }

    // Contact relation check (caller side only).
    const relation = await prisma.iMContactRelation.findUnique({
      where: { userId_contactId: { userId: actorImUserId, contactId: targetId } },
      select: { userId: true },
    });
    if (!relation) throw new NotContactError();

    // Block guard — both directions, mirrors invite create-time guard.
    const callerBlocked = await this.contacts.isBlocked(actorImUserId, targetId);
    const targetBlocked = await this.contacts.isBlocked(targetId, actorImUserId);
    if (callerBlocked || targetBlocked) throw new ContactBlockedError();

    // Idempotent: if the row exists, just return it without bumping role.
    const existing = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: targetId } },
    });
    if (existing) return toDTO(existing);

    const created = await prisma.iMWorkspaceMember.create({
      data: { workspaceId, memberImUserId: targetId, role },
    });
    return toDTO(created);
  }

  /**
   * release201/19 D3 — 16 §3.3.1 PATCH/DELETE `:memberId` accepts EITHER the
   * row id (legacy) OR the member's imUserId (doc-aligned). We resolve here
   * so existing SDK callers (which pass the row id) keep working while new
   * UI / cookbook code can use the natural imUserId reference.
   *
   * Detection: scoped findUnique on row id first; if that misses, fall back
   * to the (workspaceId, memberImUserId) composite. Both probes are bounded
   * to `workspaceId`, so a stale id from another workspace cannot leak.
   */
  private async resolveMemberRowId(
    workspaceId: string,
    idOrImUserId: string,
  ): Promise<{
    id: string;
    workspaceId: string;
    memberImUserId: string;
    role: string;
    joinedAt: Date;
  } | null> {
    // Try as row id (workspaceId-scoped). Hits the PK index.
    const byId = await prisma.iMWorkspaceMember.findUnique({
      where: { id: idOrImUserId },
    });
    if (byId && byId.workspaceId === workspaceId) return byId;
    // Fall back to imUserId composite (also unique).
    return prisma.iMWorkspaceMember.findUnique({
      where: {
        workspaceId_memberImUserId: { workspaceId, memberImUserId: idOrImUserId },
      },
    });
  }

  /**
   * 16 §3.3.1 + B10 hotfix (v2.0.7.1): PATCH role. owner OR admin.
   * 不允许把任何 row 改成 owner (transfer 路径未开).
   * Admin 不能改 owner 行 (existing.role === 'owner' 已经被下面那个 guard 兜住,
   * 仍保留显式 "cannot demote owner" 错误以防 admin 升权).
   *
   * `memberId` may be either the workspace_member row id OR the member's
   * imUserId — see resolveMemberRowId (release201/19 D3).
   */
  async updateRole(
    workspaceId: string,
    actorImUserId: string,
    memberId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberDTO> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      throw new WorkspaceForbiddenError('Only workspace owner/admin can change member roles');
    }

    const existing = await this.resolveMemberRowId(workspaceId, memberId);
    if (!existing) {
      throw new MemberNotFoundError(memberId);
    }
    if (!isValidRole(role)) {
      throw new WorkspaceValidationError('role must be owner|admin|member');
    }
    if (role === 'owner') {
      throw new WorkspaceValidationError('role=owner cannot be assigned via PATCH; use ownership transfer (v2.1+ RFC)');
    }
    if (existing.role === 'owner') {
      throw new WorkspaceValidationError('Cannot demote the workspace owner; use ownership transfer (v2.1+ RFC)');
    }

    const updated = await prisma.iMWorkspaceMember.update({
      where: { id: existing.id },
      data: { role },
    });
    return toDTO(updated);
  }

  /**
   * 16 §3.3.1 + §3.2.3 + B10 hotfix (v2.0.7.1): DELETE. owner OR admin;
   * owner 自己不能被移除 (透出 422 提示).
   * Admin 也不能删 owner row (OwnerCannotBeRemovedError 防 admin 升权).
   * Cascade: 该 user 在该 workspace 的所有 project memberships 同事务删除.
   *
   * `memberId` may be either the workspace_member row id OR the member's
   * imUserId — see resolveMemberRowId (release201/19 D3).
   */
  async remove(
    workspaceId: string,
    actorImUserId: string,
    memberId: string,
  ): Promise<{ removed: WorkspaceMemberDTO; projectMembershipsRemoved: number }> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      throw new WorkspaceForbiddenError('Only workspace owner/admin can remove members');
    }

    const existing = await this.resolveMemberRowId(workspaceId, memberId);
    if (!existing) {
      throw new MemberNotFoundError(memberId);
    }
    if (existing.role === 'owner') {
      throw new OwnerCannotBeRemovedError();
    }

    // Cascade: 删该 user 在 workspace 内所有 project memberships.
    // Interactive transaction — projectIds findMany 与两个 delete 必须共享一个
    // snapshot, 否则 TOCTOU: 预检后、删除前新建的 project 内该 user 的 membership
    // 会漏 cascade (16 §3.2.3).
    const memberImUserId = existing.memberImUserId;
    const existingRowId = existing.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { projDel, memberDel } = await prisma.$transaction(async (tx: any) => {
      const projectIds = (await tx.iMProject.findMany({ where: { workspaceId }, select: { id: true } })).map(
        (r: { id: string }) => r.id,
      );

      const projDel = await tx.iMAgentProjectMembership.deleteMany({
        where: {
          principalKind: 'user',
          principalId: memberImUserId,
          projectId: { in: projectIds },
        },
      });
      const memberDel = await tx.iMWorkspaceMember.delete({ where: { id: existingRowId } });
      return { projDel, memberDel };
    });

    return {
      removed: toDTO(memberDel),
      projectMembershipsRemoved: projDel.count,
    };
  }
}

/**
 * ProjectService — release201/09 Phase 1 (v2.0.7).
 *
 * Project = scope 容器 inside a workspace. 1 workspace : N project, opt-in 中间层.
 * Phase 1 不与任何已有资源 list endpoint 耦合 (im_tasks.project_id 在 Phase 2 才加列).
 *
 * Permission 模型 (09 §5):
 *   - Workspace owner 默认是所有 project 的 owner (本服务短路, §5.2),
 *     不需显式 IMAgentProjectMembership 行
 *   - 3 个 role: 'owner' | 'contributor' | 'observer'
 *   - principalKind: 'user' | 'agent' — 单表覆盖两种 principal (09 §3.2 / D3)
 *
 * NULL projectId 是合法状态 — 不创建 default project 兜底 (09-D1).
 */

import prisma from '../db';
import { metricEmit } from './metric.service';

export type ProjectStatus = 'active' | 'archived';
export type MembershipRole = 'owner' | 'contributor' | 'observer';
export type PrincipalKind = 'user' | 'agent';
export type EffectiveRole = MembershipRole | 'none';
export type DeleteCascade = 'archive' | 'null' | 'hard';

export interface ProjectDTO {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  ownerUserId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectWithCountsDTO extends ProjectDTO {
  memberCount: number;
}

export interface MembershipDTO {
  id: string;
  projectId: string;
  principalKind: PrincipalKind;
  principalId: string;
  role: MembershipRole;
  joinedAt: string;
}

export class ProjectNotFoundError extends Error {
  code = 'PROJECT_NOT_FOUND';
  status = 404 as const;
  constructor(id: string) {
    super(`Project ${id} not found`);
  }
}

export class WorkspaceNotFoundError extends Error {
  code = 'WORKSPACE_NOT_FOUND';
  status = 404 as const;
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} not found`);
  }
}

export class ProjectForbiddenError extends Error {
  code = 'PROJECT_FORBIDDEN';
  status = 403 as const;
  constructor(reason: string) {
    super(reason);
  }
}

export class ProjectValidationError extends Error {
  code = 'PROJECT_VALIDATION';
  status = 400 as const;
  constructor(reason: string) {
    super(reason);
  }
}

export class ProjectConflictError extends Error {
  code = 'PROJECT_CONFLICT';
  status = 409 as const;
  constructor(reason: string) {
    super(reason);
  }
}

export class MembershipNotFoundError extends Error {
  code = 'MEMBERSHIP_NOT_FOUND';
  status = 404 as const;
  constructor(id: string) {
    super(`Membership ${id} not found`);
  }
}

// release201/16 Phase 10 (§3.3.3a). Adding a user principal to a project
// requires that principal to already be a workspace member. Agent principals
// are exempt — they relate to a workspace via agent profile, not the
// workspace_members table (09 §5.3). 422 (semantic, not auth) so the UI
// can render "this person isn't in the workspace yet — invite them first".
export class NotWorkspaceMemberError extends Error {
  code = 'NOT_WORKSPACE_MEMBER';
  status = 422 as const;
  constructor(principalId: string, workspaceId: string) {
    super(`Principal ${principalId} is not a member of workspace ${workspaceId}`);
  }
}

/**
 * release201/09 §4.4 + §15.1 Phase 4 — cascade=hard is reserved for v2.1+
 * (评估期). v2.0.7 surface returns HTTP 405 + 'hard_cascade_not_implemented'.
 */
export class HardCascadeNotImplementedError extends Error {
  code = 'hard_cascade_not_implemented';
  status = 405 as const;
  constructor() {
    super(
      'cascade=hard is reserved for v2.1+ (see release201/09 §4.4 + §15.1 Phase 4). ' +
        'Use cascade=archive (default soft archive) or cascade=null (unscope linked resources + archive).',
    );
  }
}

/**
 * release201/09 §4.4 — cascade=null 的执行报告. 仅本服务返回, 用于
 * audit / UI 展示 "N 个 task 已 unscope". v2.0.7 列出来的关联资源类型
 * 只有 `tasks` (im_tasks.project_id 是唯一已加列的关联); conversation /
 * asset / memory 推 v2.0.8 / v2.1+, 当前永远是 0.
 */
export interface CascadeReport {
  taskUnscoped: number;
  conversationUnscoped: number;
  assetUnscoped: number;
  memoryUnscoped: number;
}

export interface DeleteResult {
  project: ProjectDTO;
  cascade: DeleteCascade;
  cascadeReport: CascadeReport;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toProjectDTO(row: {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  ownerUserId: string;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}): ProjectDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: (row.status === 'archived' ? 'archived' : 'active') as ProjectStatus,
    ownerUserId: row.ownerUserId,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toMembershipDTO(row: {
  id: string;
  projectId: string;
  principalKind: string;
  principalId: string;
  role: string;
  joinedAt: Date;
}): MembershipDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    principalKind: row.principalKind as PrincipalKind,
    principalId: row.principalId,
    role: (row.role || 'contributor') as MembershipRole,
    joinedAt: row.joinedAt.toISOString(),
  };
}

function isValidRole(role: unknown): role is MembershipRole {
  return role === 'owner' || role === 'contributor' || role === 'observer';
}

function isValidPrincipalKind(kind: unknown): kind is PrincipalKind {
  return kind === 'user' || kind === 'agent';
}

export class ProjectService {
  // ── Workspace owner short-circuit (§5.2) ─────────────────────────────────────
  //
  // 给定 actor (IMUser.imUserId) + workspace, 判断是否是 owner.
  // owner 自动持有该 workspace 内所有 project 的 'owner' role, 无需显式 membership.
  async isWorkspaceOwner(workspaceId: string, actorImUserId: string): Promise<boolean> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    return !!ws && ws.ownerImUserId === actorImUserId;
  }

  // 给定 project 和 actor (user kind), 返回 effective role.
  // 1. workspace owner → 'owner' (短路)
  // 2. 否则查 membership 行 (principalKind='user'); 命中 → 该 role
  // 3. 否则 → 'none'
  async getEffectiveUserRole(projectId: string, actorImUserId: string): Promise<EffectiveRole> {
    const project = await prisma.iMProject.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) return 'none';
    if (await this.isWorkspaceOwner(project.workspaceId, actorImUserId)) {
      return 'owner';
    }
    const row = await prisma.iMAgentProjectMembership.findUnique({
      where: {
        projectId_principalKind_principalId: {
          projectId,
          principalKind: 'user',
          principalId: actorImUserId,
        },
      },
      select: { role: true },
    });
    return row && isValidRole(row.role) ? row.role : 'none';
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  async list(params: {
    workspaceId: string;
    actorImUserId: string;
    status?: ProjectStatus;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ProjectWithCountsDTO[]; total: number }> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: params.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(params.workspaceId);

    const isOwner = ws.ownerImUserId === params.actorImUserId;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);

    // Non-owner: only projects where they have a membership row.
    let scopedProjectIds: string[] | null = null;
    if (!isOwner) {
      const memberships = await prisma.iMAgentProjectMembership.findMany({
        where: { principalKind: 'user', principalId: params.actorImUserId },
        select: { projectId: true },
      });
      const ids = memberships.map((m: { projectId: string }) => m.projectId);
      if (ids.length === 0) {
        return { items: [], total: 0 };
      }
      scopedProjectIds = ids;
    }

    const where: {
      workspaceId: string;
      status?: ProjectStatus;
      OR?: Array<{ name?: { contains: string }; slug?: { contains: string } }>;
      id?: { in: string[] };
    } = { workspaceId: params.workspaceId };
    if (params.status) where.status = params.status;
    if (params.search) {
      where.OR = [{ name: { contains: params.search } }, { slug: { contains: params.search } }];
    }
    if (scopedProjectIds !== null) {
      where.id = { in: scopedProjectIds };
    }

    const [rows, total] = await Promise.all([
      prisma.iMProject.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.iMProject.count({ where }),
    ]);

    const ids = rows.map((r: { id: string }) => r.id);
    const counts: Array<{ projectId: string; _count: { _all: number } }> = ids.length
      ? await prisma.iMAgentProjectMembership.groupBy({
          by: ['projectId'],
          where: { projectId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const countByProject = new Map<string, number>(counts.map((c) => [c.projectId, c._count._all]));

    return {
      items: rows.map((r: (typeof rows)[number]) => ({
        ...toProjectDTO(r),
        memberCount: countByProject.get(r.id) ?? 0,
      })),
      total,
    };
  }

  async create(params: {
    workspaceId: string;
    actorImUserId: string;
    slug: string;
    name: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectDTO> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: params.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(params.workspaceId);
    // Membership rule for create: only workspace owner can create project in
    // Phase 1 (owner-driven workspace scope; non-owner project creation can be
    // expanded later via explicit workspace 'admin' role).
    if (ws.ownerImUserId !== params.actorImUserId) {
      throw new ProjectForbiddenError('Only workspace owner can create projects');
    }

    const slug = (params.slug ?? '').trim().toLowerCase();
    const name = (params.name ?? '').trim();
    if (!slug || !SLUG_PATTERN.test(slug)) {
      throw new ProjectValidationError('slug must be 1-64 chars [a-z0-9-], leading alnum');
    }
    if (!name) {
      throw new ProjectValidationError('name is required');
    }
    if (name.length > 128) {
      throw new ProjectValidationError('name must be <= 128 chars');
    }

    try {
      const created = await prisma.iMProject.create({
        data: {
          workspaceId: params.workspaceId,
          slug,
          name,
          description: params.description ?? null,
          status: 'active',
          ownerUserId: params.actorImUserId,
          metadata: JSON.stringify(params.metadata ?? {}),
        },
      });
      return toProjectDTO(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        throw new ProjectConflictError('slug already taken in this workspace');
      }
      throw err;
    }
  }

  async get(id: string, actorImUserId: string): Promise<ProjectWithCountsDTO> {
    const row = await prisma.iMProject.findUnique({ where: { id } });
    if (!row) throw new ProjectNotFoundError(id);

    const role = await this.getEffectiveUserRole(id, actorImUserId);
    if (role === 'none') throw new ProjectNotFoundError(id); // 不暴露存在性 (§5.3)

    const count = await prisma.iMAgentProjectMembership.count({ where: { projectId: id } });
    return { ...toProjectDTO(row), memberCount: count };
  }

  async update(
    id: string,
    actorImUserId: string,
    patch: {
      name?: string;
      description?: string | null;
      status?: ProjectStatus;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ProjectDTO> {
    const row = await prisma.iMProject.findUnique({ where: { id } });
    if (!row) throw new ProjectNotFoundError(id);

    const role = await this.getEffectiveUserRole(id, actorImUserId);
    if (role !== 'owner') {
      throw new ProjectForbiddenError('Only project owner can update project');
    }

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new ProjectValidationError('name must be non-empty');
      if (trimmed.length > 128) throw new ProjectValidationError('name must be <= 128 chars');
      data.name = trimmed;
    }
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'archived') {
        throw new ProjectValidationError('status must be active|archived');
      }
      data.status = patch.status;
      data.archivedAt = patch.status === 'archived' ? new Date() : null;
    }
    if (patch.metadata !== undefined) data.metadata = JSON.stringify(patch.metadata ?? {});

    if (Object.keys(data).length === 0) return toProjectDTO(row);

    const updated = await prisma.iMProject.update({ where: { id }, data });
    return toProjectDTO(updated);
  }

  /**
   * Delete a project (09 §4.4 + Phase 4 §15.1).
   *
   * Three cascade modes:
   *   - 'archive' (default): UPDATE status='archived' + archivedAt=NOW(). 关
   *     联资源 projectId 保持不变, 历史可查. UI 默 hide archived project.
   *   - 'null'              : UPDATE 关联 im_tasks.projectId = NULL 在同事务
   *     里, 然后软删 project (status='archived' + archivedAt=NOW()). 09 §4.4
   *     语义: "归回 workspace-level". 当前 only im_tasks.projectId 列已加
   *     (Phase 2 migration 433); conversation / asset / memory 推 v2.0.8+,
   *     CascadeReport 那几个 count 永远是 0.
   *   - 'hard'              : v2.0.7 NOT implemented (§15.1 Phase 4 forbidden
   *     + 09-D7). 抛 HardCascadeNotImplementedError → HTTP 405 +
   *     'hard_cascade_not_implemented' error code.
   *
   * Permission: workspace owner (短路) OR explicit project owner role.
   *
   * Returns DeleteResult { project, cascade, cascadeReport } so the caller
   * can surface "N tasks unscoped" in the UI confirm modal feedback.
   */
  async remove(id: string, actorImUserId: string, cascade: DeleteCascade = 'archive'): Promise<DeleteResult> {
    const row = await prisma.iMProject.findUnique({ where: { id } });
    if (!row) throw new ProjectNotFoundError(id);

    const role = await this.getEffectiveUserRole(id, actorImUserId);
    if (role !== 'owner') {
      throw new ProjectForbiddenError('Only project owner can delete project');
    }
    if (cascade === 'hard') {
      throw new HardCascadeNotImplementedError();
    }

    const cascadeReport: CascadeReport = {
      taskUnscoped: 0,
      conversationUnscoped: 0,
      assetUnscoped: 0,
      memoryUnscoped: 0,
    };

    if (cascade === 'null') {
      // Cascade=null — unscope linked tasks first (transaction-wrapped so
      // partial failure rolls back the soft archive too). 09 §4.4 + §15.1
      // Phase 4 explicitly: cascade=null "关联资源 projectId 改 NULL". v2.0.7
      // 仅 im_tasks.projectId 已加列 — 其余 4 张表 (conversation / asset /
      // memory_files / memory_pages) 推 v2.0.8 / v2.1+ (§10.2 + §13).
      // prisma is typed as `any` in src/lib/prisma.ts (dual SQLite/MySQL
      // dynamic client), so we cast the tx param here to keep strict TS
      // happy while still leaning on the runtime client for safety.
      const archived = await prisma.$transaction(async (tx: typeof prisma) => {
        const updateRes = await tx.iMTask.updateMany({
          where: { projectId: id },
          data: { projectId: null },
        });
        cascadeReport.taskUnscoped = updateRes.count ?? 0;
        return tx.iMProject.update({
          where: { id },
          data: { status: 'archived', archivedAt: new Date() },
        });
      });
      // release201/11 §4 #12 — emit project.archived metric (cascade=null path).
      metricEmit({
        namespace: 'project',
        name: 'archived',
        source: 'cloud',
        value: 1,
        dims: {
          workspaceId: row.workspaceId,
          projectId: id,
          durationDays: Math.floor((Date.now() - new Date(row.createdAt).getTime()) / 86_400_000),
        },
      });
      return { project: toProjectDTO(archived), cascade, cascadeReport };
    }

    // Cascade=archive (default) — preserve linked resources' projectId for
    // history; flip project status only.
    const updated = await prisma.iMProject.update({
      where: { id },
      data: { status: 'archived', archivedAt: new Date() },
    });
    // release201/11 §4 #12 — emit project.archived metric (cascade=archive path).
    metricEmit({
      namespace: 'project',
      name: 'archived',
      source: 'cloud',
      value: 1,
      dims: {
        workspaceId: row.workspaceId,
        projectId: id,
        durationDays: Math.floor((Date.now() - new Date(row.createdAt).getTime()) / 86_400_000),
      },
    });
    return { project: toProjectDTO(updated), cascade, cascadeReport };
  }

  // ── Membership ──────────────────────────────────────────────────────────────

  async listMembers(projectId: string, actorImUserId: string): Promise<MembershipDTO[]> {
    const role = await this.getEffectiveUserRole(projectId, actorImUserId);
    if (role === 'none') throw new ProjectNotFoundError(projectId);

    const rows = await prisma.iMAgentProjectMembership.findMany({
      where: { projectId },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });
    return rows.map(toMembershipDTO);
  }

  async addMember(
    projectId: string,
    actorImUserId: string,
    member: { principalKind: PrincipalKind; principalId: string; role?: MembershipRole },
  ): Promise<MembershipDTO> {
    const project = await prisma.iMProject.findUnique({ where: { id: projectId } });
    if (!project) throw new ProjectNotFoundError(projectId);

    const role = await this.getEffectiveUserRole(projectId, actorImUserId);
    if (role !== 'owner') {
      throw new ProjectForbiddenError('Only project owner can add members');
    }

    if (!isValidPrincipalKind(member.principalKind)) {
      throw new ProjectValidationError('principalKind must be user|agent');
    }
    if (!member.principalId || !member.principalId.trim()) {
      throw new ProjectValidationError('principalId is required');
    }
    const memberRole = member.role ?? 'contributor';
    if (!isValidRole(memberRole)) {
      throw new ProjectValidationError('role must be owner|contributor|observer');
    }
    const principalId = member.principalId.trim();

    // release201/16 §3.3.3a — workspace member invariant. ONLY for user
    // principals: an agent principal isn't expected to have a workspace_members
    // row (agents relate via agent profile, see 09 §5.3). Workspace owner is
    // a member by virtue of the M444 backfill, so this also lets the owner
    // re-add themselves explicitly if they ever want a non-owner project role
    // on a sub-project (rare, but legal).
    if (member.principalKind === 'user') {
      const isWsMember = await prisma.iMWorkspaceMember.findUnique({
        where: {
          workspaceId_memberImUserId: {
            workspaceId: project.workspaceId,
            memberImUserId: principalId,
          },
        },
        select: { id: true },
      });
      if (!isWsMember) {
        throw new NotWorkspaceMemberError(principalId, project.workspaceId);
      }
    }

    try {
      const created = await prisma.iMAgentProjectMembership.create({
        data: {
          projectId,
          principalKind: member.principalKind,
          principalId,
          role: memberRole,
        },
      });
      return toMembershipDTO(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        throw new ProjectConflictError('principal already a member of this project');
      }
      throw err;
    }
  }

  async removeMember(projectId: string, actorImUserId: string, membershipId: string): Promise<void> {
    const project = await prisma.iMProject.findUnique({ where: { id: projectId } });
    if (!project) throw new ProjectNotFoundError(projectId);

    const role = await this.getEffectiveUserRole(projectId, actorImUserId);
    if (role !== 'owner') {
      throw new ProjectForbiddenError('Only project owner can remove members');
    }

    const existing = await prisma.iMAgentProjectMembership.findUnique({
      where: { id: membershipId },
    });
    if (!existing || existing.projectId !== projectId) {
      throw new MembershipNotFoundError(membershipId);
    }
    await prisma.iMAgentProjectMembership.delete({ where: { id: membershipId } });
  }

  async updateMember(
    projectId: string,
    actorImUserId: string,
    membershipId: string,
    patch: { role: MembershipRole },
  ): Promise<MembershipDTO> {
    const project = await prisma.iMProject.findUnique({ where: { id: projectId } });
    if (!project) throw new ProjectNotFoundError(projectId);

    const role = await this.getEffectiveUserRole(projectId, actorImUserId);
    if (role !== 'owner') {
      throw new ProjectForbiddenError('Only project owner can update members');
    }
    if (!isValidRole(patch.role)) {
      throw new ProjectValidationError('role must be owner|contributor|observer');
    }

    const existing = await prisma.iMAgentProjectMembership.findUnique({
      where: { id: membershipId },
    });
    if (!existing || existing.projectId !== projectId) {
      throw new MembershipNotFoundError(membershipId);
    }
    const updated = await prisma.iMAgentProjectMembership.update({
      where: { id: membershipId },
      data: { role: patch.role },
    });
    return toMembershipDTO(updated);
  }
}

export const projectService = new ProjectService();

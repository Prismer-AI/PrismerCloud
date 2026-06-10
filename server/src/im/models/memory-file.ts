/**
 * Prismer IM — Memory File Model
 *
 * CRUD operations for im_memory_files (Episodic Memory).
 * Supports optimistic locking via version field.
 *
 * v1.9.2: dropped legacy free-form `scope`. Workspace isolation is now explicit
 * via required `workspaceId`; ownerId is retained as legacy author metadata.
 *
 * v2.0 Wave 4-E6 (doc 13 §6.1 + doc 14 §4.7 — re-introduced under fixed schema):
 *   scope ∈ { 'workspace-shared' | 'agent-private' }
 *     - workspace-shared → ownerType='workspace', ownerId='__shared__' sentinel
 *                          (set by service layer), agentImUserId = null,
 *                          all agents in the workspace can RW
 *     - agent-private    → agentImUserId required, only that agent can RW
 *   UNIQUE(workspaceId, scope, ownerType, ownerId, path) (migration 412)
 *   INDEX(agentImUserId, scope)                          (migration 418)
 */

import prisma from '../db';
import type { MemoryOwnerType } from '../types';
import * as crypto from 'crypto';

export type MemoryScope = 'workspace-shared' | 'agent-private';

export interface CreateMemoryFileData {
  workspaceId: string;
  ownerId: string;
  ownerType: MemoryOwnerType;
  path: string;
  content: string;
  memoryType?: string;
  description?: string;
  visibility?: string;
  aclJson?: string | null;
  encrypted?: boolean;
  sourceKind?: string | null;
  sourceRef?: string | null;
  scope?: MemoryScope;
  agentImUserId?: string | null;
  // Release 201 P0-6 — role provenance stamps. Resolved by the API boundary
  // from the caller's bound role template. Pass `null` to leave unstamped
  // (legacy writes; recall treats them as "any-role").
  sourceRoleTemplateSlug?: string | null;
  sourceTaskAuthority?: 'orchestrator' | 'executor' | null;
  sourceIsOrchestrator?: boolean | null;
}

export interface MemoryFileQuery {
  workspaceId: string;
  ownerId?: string;
  /**
   * v2.0.7.1 hotfix (B11): caller-aware ownerId filter. When provided, the
   * query matches rows owned by the caller OR rows carrying the
   * workspace-shared sentinel (`ownerType='workspace'`, `ownerId='__shared__'`).
   * Use this instead of `ownerId` for /memory/files list calls — `ownerId`
   * alone hides workspace-shared rows from every caller including the writer.
   *
   * Mutually exclusive with `ownerId`; if both are provided, `ownerIdsOr`
   * takes precedence.
   */
  ownerIdsOr?: string[];
  ownerType?: MemoryOwnerType;
  path?: string;
  memoryType?: string;
  stale?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
}

export class MemoryFileModel {
  private contentHash(content: string) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private etag(contentHash: string) {
    return contentHash;
  }

  async create(data: CreateMemoryFileData) {
    const contentHash = this.contentHash(data.content);
    const scope = data.scope ?? 'workspace-shared';
    return prisma.iMMemoryFile.create({
      data: {
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        path: data.path,
        content: data.content,
        workspaceId: data.workspaceId,
        scope,
        agentImUserId: scope === 'agent-private' ? (data.agentImUserId ?? null) : null,
        version: 1,
        visibility: data.visibility ?? 'workspace',
        aclJson: data.aclJson,
        encrypted: data.encrypted ?? false,
        contentHash,
        etag: this.etag(contentHash),
        sourceKind: data.sourceKind,
        sourceRef: data.sourceRef,
        // Release 201 P0-6 — role provenance. Undefined/null leaves the row
        // unstamped (legacy semantic); the recall plane treats unstamped rows
        // as workspace-public matchable but not role-self matchable.
        ...(data.sourceRoleTemplateSlug !== undefined && { sourceRoleTemplateSlug: data.sourceRoleTemplateSlug }),
        ...(data.sourceTaskAuthority !== undefined && { sourceTaskAuthority: data.sourceTaskAuthority }),
        ...(data.sourceIsOrchestrator !== undefined && { sourceIsOrchestrator: data.sourceIsOrchestrator }),
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      } as any,
    });
  }

  async findById(id: string) {
    return prisma.iMMemoryFile.findUnique({ where: { id } });
  }

  async findByWorkspaceOwnerPath(workspaceId: string, ownerId: string, path: string) {
    return prisma.iMMemoryFile.findFirst({
      where: { workspaceId, ownerId, path },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findByWorkspacePath(workspaceId: string, path: string) {
    return prisma.iMMemoryFile.findFirst({
      where: { workspaceId, path },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async list(query: MemoryFileQuery) {
    const where: Record<string, unknown> = { workspaceId: query.workspaceId };
    if (query.ownerIdsOr && query.ownerIdsOr.length > 0) {
      // v2.0.7.1 hotfix (B11): caller may see own rows + workspace-shared
      // sentinel rows. Drop duplicates; if the caller's own imUserId equals
      // '__shared__' (impossible in practice but keep defensive), `in:` is
      // already de-duplicated.
      const uniq = Array.from(new Set(query.ownerIdsOr));
      where.ownerId = { in: uniq };
    } else if (query.ownerId) {
      where.ownerId = query.ownerId;
    }
    if (query.ownerType) where.ownerType = query.ownerType;
    if (query.path) where.path = query.path;
    if (query.memoryType !== undefined) where.memoryType = query.memoryType;
    if (query.stale !== undefined) where.stale = query.stale;

    const ALLOWED_SORT = ['updatedAt', 'createdAt', 'path', 'memoryType'];
    const sortField = ALLOWED_SORT.includes(query.sort || '') ? query.sort! : 'updatedAt';
    const sortOrder = query.order || 'desc';

    return prisma.iMMemoryFile.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        workspaceId: true,
        path: true,
        version: true,
        memoryType: true,
        description: true,
        stale: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async updateMetadata(id: string, data: { memoryType?: string; description?: string; stale?: boolean }) {
    return prisma.iMMemoryFile.update({
      where: { id },
      data,
    });
  }

  /**
   * Update content with optimistic lock.
   * Returns null if version mismatch (conflict).
   */
  async update(id: string, content: string, expectedVersion: number) {
    try {
      const contentHash = this.contentHash(content);
      return await prisma.iMMemoryFile.update({
        where: { id, version: expectedVersion },
        data: {
          content,
          version: { increment: 1 },
          contentHash,
          etag: this.etag(contentHash),
        },
      });
    } catch {
      // Prisma throws if record not found (version mismatch)
      return null;
    }
  }

  /**
   * Upsert keyed by (workspaceId, scope, ownerType, ownerId, path).
   *
   * Migration 412 (doc 13 §6.1) dropped the legacy (workspaceId, path) unique
   * and installed the bucketed UNIQUE: one shared path per workspace lives
   * under sentinel (ownerType='workspace', ownerId='__shared__'); each
   * agent-private path lives under (ownerType='agent', ownerId=agentImUserId).
   *
   * The service layer (memory.service.ts:writeMemoryFile) is responsible for
   * stamping the sentinel for workspace-shared writes BEFORE calling this.
   */
  async upsert(data: CreateMemoryFileData) {
    const contentHash = this.contentHash(data.content);
    const scope: MemoryScope = data.scope ?? 'workspace-shared';
    const agentImUserId = scope === 'agent-private' ? (data.agentImUserId ?? null) : null;
    return prisma.iMMemoryFile.upsert({
      where: {
        workspaceId_scope_ownerType_ownerId_path: {
          workspaceId: data.workspaceId,
          scope,
          ownerType: data.ownerType,
          ownerId: data.ownerId,
          path: data.path,
        },
      } as any,
      create: {
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        path: data.path,
        content: data.content,
        workspaceId: data.workspaceId,
        scope,
        agentImUserId,
        version: 1,
        visibility: data.visibility ?? 'workspace',
        aclJson: data.aclJson,
        encrypted: data.encrypted ?? false,
        contentHash,
        etag: this.etag(contentHash),
        sourceKind: data.sourceKind,
        sourceRef: data.sourceRef,
        // Release 201 P0-6 — role provenance, see create() above.
        ...(data.sourceRoleTemplateSlug !== undefined && { sourceRoleTemplateSlug: data.sourceRoleTemplateSlug }),
        ...(data.sourceTaskAuthority !== undefined && { sourceTaskAuthority: data.sourceTaskAuthority }),
        ...(data.sourceIsOrchestrator !== undefined && { sourceIsOrchestrator: data.sourceIsOrchestrator }),
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      } as any,
      update: {
        content: data.content,
        // ownerId/ownerType/scope/agentImUserId are part of the natural key
        // — never updated by upsert; if they changed, it would be a different row.
        version: { increment: 1 },
        contentHash,
        etag: this.etag(contentHash),
        ...(data.visibility !== undefined && { visibility: data.visibility }),
        ...(data.aclJson !== undefined && { aclJson: data.aclJson }),
        ...(data.encrypted !== undefined && { encrypted: data.encrypted }),
        ...(data.sourceKind !== undefined && { sourceKind: data.sourceKind }),
        ...(data.sourceRef !== undefined && { sourceRef: data.sourceRef }),
        ...(data.sourceRoleTemplateSlug !== undefined && { sourceRoleTemplateSlug: data.sourceRoleTemplateSlug }),
        ...(data.sourceTaskAuthority !== undefined && { sourceTaskAuthority: data.sourceTaskAuthority }),
        ...(data.sourceIsOrchestrator !== undefined && { sourceIsOrchestrator: data.sourceIsOrchestrator }),
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  async delete(id: string) {
    return prisma.iMMemoryFile.delete({ where: { id } });
  }
}

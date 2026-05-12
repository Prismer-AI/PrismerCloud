/**
 * Prismer IM — Memory File Model
 *
 * CRUD operations for im_memory_files (Episodic Memory).
 * Supports optimistic locking via version field.
 *
 * v1.9.2: dropped `scope` field. Workspace isolation is now explicit via
 * required `workspaceId`; ownerId is retained as legacy author metadata until
 * the owner/path unique key is flipped in a later migration.
 */

import prisma from '../db';
import type { MemoryOwnerType } from '../types';
import * as crypto from 'crypto';

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
}

export interface MemoryFileQuery {
  workspaceId: string;
  ownerId?: string;
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
    return prisma.iMMemoryFile.create({
      data: {
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        path: data.path,
        content: data.content,
        workspaceId: data.workspaceId,
        version: 1,
        visibility: data.visibility ?? 'workspace',
        aclJson: data.aclJson,
        encrypted: data.encrypted ?? false,
        contentHash,
        etag: this.etag(contentHash),
        sourceKind: data.sourceKind,
        sourceRef: data.sourceRef,
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
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
    if (query.ownerId) where.ownerId = query.ownerId;
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
   * Upsert by workspace/path — ownerId is author metadata, not the namespace.
   */
  async upsert(data: CreateMemoryFileData) {
    const contentHash = this.contentHash(data.content);
    return prisma.iMMemoryFile.upsert({
      where: {
        workspaceId_path: {
          workspaceId: data.workspaceId,
          path: data.path,
        },
      },
      create: {
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        path: data.path,
        content: data.content,
        workspaceId: data.workspaceId,
        version: 1,
        visibility: data.visibility ?? 'workspace',
        aclJson: data.aclJson,
        encrypted: data.encrypted ?? false,
        contentHash,
        etag: this.etag(contentHash),
        sourceKind: data.sourceKind,
        sourceRef: data.sourceRef,
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
      update: {
        content: data.content,
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        version: { increment: 1 },
        contentHash,
        etag: this.etag(contentHash),
        ...(data.visibility !== undefined && { visibility: data.visibility }),
        ...(data.aclJson !== undefined && { aclJson: data.aclJson }),
        ...(data.encrypted !== undefined && { encrypted: data.encrypted }),
        ...(data.sourceKind !== undefined && { sourceKind: data.sourceKind }),
        ...(data.sourceRef !== undefined && { sourceRef: data.sourceRef }),
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  async delete(id: string) {
    return prisma.iMMemoryFile.delete({ where: { id } });
  }
}

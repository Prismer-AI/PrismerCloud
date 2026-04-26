/**
 * Prismer IM — Memory File Model
 *
 * CRUD operations for im_memory_files (Episodic Memory).
 * Supports optimistic locking via version field.
 */

import prisma from '../db';
import type { MemoryOwnerType } from '../types';

export interface CreateMemoryFileData {
  ownerId: string;
  ownerType: MemoryOwnerType;
  scope: string;
  path: string;
  content: string;
  memoryType?: string;
  description?: string;
}

export interface MemoryFileQuery {
  ownerId: string;
  ownerType?: MemoryOwnerType;
  scope?: string;
  path?: string;
  memoryType?: string;
  stale?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
}

export class MemoryFileModel {
  async create(data: CreateMemoryFileData) {
    return prisma.iMMemoryFile.create({
      data: {
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        scope: data.scope,
        path: data.path,
        content: data.content,
        version: 1,
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  async findById(id: string) {
    return prisma.iMMemoryFile.findUnique({ where: { id } });
  }

  async findByOwnerScopePath(ownerId: string, scope: string, path: string) {
    return prisma.iMMemoryFile.findUnique({
      where: { ownerId_scope_path: { ownerId, scope, path } },
    });
  }

  async list(query: MemoryFileQuery) {
    const where: Record<string, unknown> = { ownerId: query.ownerId };
    if (query.ownerType) where.ownerType = query.ownerType;
    if (query.scope) where.scope = query.scope;
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
        scope: true,
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
      return await prisma.iMMemoryFile.update({
        where: { id, version: expectedVersion },
        data: {
          content,
          version: { increment: 1 },
        },
      });
    } catch {
      // Prisma throws if record not found (version mismatch)
      return null;
    }
  }

  /**
   * Upsert by owner/scope/path — create if not exists, update if exists.
   */
  async upsert(data: CreateMemoryFileData) {
    return prisma.iMMemoryFile.upsert({
      where: {
        ownerId_scope_path: {
          ownerId: data.ownerId,
          scope: data.scope,
          path: data.path,
        },
      },
      create: {
        ownerId: data.ownerId,
        ownerType: data.ownerType,
        scope: data.scope,
        path: data.path,
        content: data.content,
        version: 1,
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
      update: {
        content: data.content,
        version: { increment: 1 },
        ...(data.memoryType !== undefined && { memoryType: data.memoryType }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });
  }

  async delete(id: string) {
    return prisma.iMMemoryFile.delete({ where: { id } });
  }
}

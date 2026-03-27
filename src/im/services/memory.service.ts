/**
 * Prismer IM — Memory Service
 *
 * Two-layer memory system:
 *   Layer 1: Working Memory — Compaction summaries for long conversations
 *   Layer 2: Episodic Memory — Persistent memory files (MEMORY.md + topic files)
 *
 * Design reference: docs/MEMORY-LAYER.md
 */

import prisma from '../db';
import { MemoryFileModel } from '../models/memory-file';
import { CompactionModel } from '../models/compaction';
import type {
  MemoryOwnerType,
  MemoryFileInfo,
  MemoryFileDetail,
  MemoryFileOperation,
  CompactionSummary,
} from '../types';

const LOG = '[MemoryService]';

/** Compaction template (inspired by opencode) */
const COMPACTION_TEMPLATE = `Summarize the conversation above for continuation by another agent.

## Goal
[What is the user/agent trying to accomplish?]

## Context
[Key decisions, constraints, preferences established]

## Progress
[What has been done, what remains]

## Key Information
[Critical facts, file paths, configurations, API responses that would be needed]`;

// ─── Error Types ────────────────────────────────────────────

export class MemoryConflictError extends Error {
  constructor(currentVersion: number) {
    super(`Version conflict — current version is ${currentVersion}. Re-read and retry.`);
    this.name = 'MemoryConflictError';
    this.currentVersion = currentVersion;
  }
  currentVersion: number;
}

export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory file not found: ${id}`);
    this.name = 'MemoryNotFoundError';
  }
}

// ─── Service ────────────────────────────────────────────────

export class MemoryService {
  private memoryFileModel = new MemoryFileModel();
  private compactionModel = new CompactionModel();

  // ═══════════════════════════════════════════════════════════
  // Layer 2: Episodic Memory — Memory Files
  // ═══════════════════════════════════════════════════════════

  /**
   * Create or upsert a memory file.
   * If a file with same (ownerId, scope, path) exists, it updates.
   */
  async writeMemoryFile(
    ownerId: string,
    ownerType: MemoryOwnerType,
    path: string,
    content: string,
    scope: string = 'global',
  ): Promise<MemoryFileDetail> {
    const record = await this.memoryFileModel.upsert({
      ownerId,
      ownerType,
      scope,
      path,
      content,
    });

    console.log(`${LOG} Write: ${ownerType}/${ownerId} → ${scope}/${path} (v${record.version})`);

    return this.toDetail(record);
  }

  /**
   * Read a memory file by ID.
   */
  async readMemoryFile(id: string): Promise<MemoryFileDetail> {
    const record = await this.memoryFileModel.findById(id);
    if (!record) throw new MemoryNotFoundError(id);
    return this.toDetail(record);
  }

  /**
   * Read a memory file by owner/scope/path (the natural key).
   */
  async readMemoryFileByPath(ownerId: string, scope: string, path: string): Promise<MemoryFileDetail | null> {
    const record = await this.memoryFileModel.findByOwnerScopePath(ownerId, scope, path);
    return record ? this.toDetail(record) : null;
  }

  /**
   * List memory files for an owner (metadata only, no content).
   */
  async listMemoryFiles(ownerId: string, scope?: string, path?: string): Promise<MemoryFileInfo[]> {
    const records = await this.memoryFileModel.list({ ownerId, scope, path });
    return records.map(
      (r: {
        id: string;
        ownerId: string;
        ownerType: string;
        scope: string;
        path: string;
        version: number;
        createdAt: Date;
        updatedAt: Date;
      }) => this.toInfo(r),
    );
  }

  /**
   * Update a memory file with operation support.
   * Supports: replace, append, replace_section.
   * Uses optimistic locking — throws MemoryConflictError on version mismatch.
   */
  async updateMemoryFile(
    id: string,
    operation: MemoryFileOperation,
    content: string,
    expectedVersion?: number,
    section?: string,
  ): Promise<MemoryFileDetail> {
    const existing = await this.memoryFileModel.findById(id);
    if (!existing) throw new MemoryNotFoundError(id);

    // Use provided version or current version (no-conflict mode)
    const version = expectedVersion ?? existing.version;

    let newContent: string;
    switch (operation) {
      case 'replace':
        newContent = content;
        break;
      case 'append':
        newContent = existing.content ? existing.content + '\n' + content : content;
        break;
      case 'replace_section':
        newContent = this.replaceSection(existing.content, section ?? '', content);
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    const updated = await this.memoryFileModel.update(id, newContent, version);
    if (!updated) {
      // Re-read to get current version for error message
      const current = await this.memoryFileModel.findById(id);
      throw new MemoryConflictError(current?.version ?? 0);
    }

    console.log(`${LOG} Update (${operation}): ${id} → v${updated.version}`);
    return this.toDetail(updated);
  }

  /**
   * Delete a memory file.
   */
  async deleteMemoryFile(id: string): Promise<void> {
    const existing = await this.memoryFileModel.findById(id);
    if (!existing) throw new MemoryNotFoundError(id);
    await this.memoryFileModel.delete(id);
    console.log(`${LOG} Delete: ${id} (${existing.path})`);
  }

  /**
   * Auto-load MEMORY.md for session start.
   * Returns full content + metadata (totalLines, totalBytes).
   * Truncation is the SDK/Agent's responsibility, not the server's.
   */
  async loadSessionMemory(ownerId: string, scope: string = 'global') {
    return this.loadMemoryFile(ownerId, scope, 'MEMORY.md');
  }

  /**
   * Load any memory file by path.
   */
  async loadMemoryFile(
    ownerId: string,
    scope: string,
    path: string,
  ): Promise<{
    content: string;
    totalLines: number;
    totalBytes: number;
    version: number;
    id: string;
  } | null> {
    const record = await this.memoryFileModel.findByOwnerScopePath(ownerId, scope, path);
    if (!record || !record.content) return null;

    return {
      content: record.content,
      totalLines: record.content.split('\n').length,
      totalBytes: record.content.length,
      version: record.version,
      id: record.id,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Search — Cross-file content search
  // ═══════════════════════════════════════════════════════════

  /**
   * Search memory files by content.
   * Uses Prisma `contains` for the search (works with both SQLite and MySQL).
   */
  async searchMemoryFiles(ownerId: string, query: string, limit: number = 10) {
    const files = await prisma.iMMemoryFile.findMany({
      where: {
        ownerId,
        content: { contains: query },
      },
      select: {
        id: true,
        path: true,
        scope: true,
        content: true,
        updatedAt: true,
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    });

    return files.map((f: { id: string; path: string; scope: string; content: string; updatedAt: Date }) => ({
      id: f.id,
      path: f.path,
      scope: f.scope,
      snippet: f.content.slice(0, 300),
      updatedAt: f.updatedAt,
      source: 'memory' as const,
    }));
  }

  // ═══════════════════════════════════════════════════════════
  // Layer 1: Working Memory — Compaction
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a compaction summary for a conversation.
   * If summary is not provided, generates a placeholder from recent messages.
   */
  async compact(
    conversationId: string,
    summary: string,
    messageRangeStart?: string,
    messageRangeEnd?: string,
  ): Promise<CompactionSummary> {
    // Estimate token count (~4 chars per token)
    const tokenCount = Math.ceil(summary.length / 4);

    const record = await this.compactionModel.create({
      conversationId,
      summary,
      messageRangeStart,
      messageRangeEnd,
      tokenCount,
    });

    console.log(`${LOG} Compaction: conversation=${conversationId}, tokens=${tokenCount}`);

    return this.toCompaction(record);
  }

  /**
   * Get all compaction summaries for a conversation (latest first).
   */
  async getCompactionSummaries(conversationId: string): Promise<CompactionSummary[]> {
    const records = await this.compactionModel.findByConversation(conversationId);
    return records.map(
      (r: {
        id: string;
        conversationId: string;
        summary: string;
        messageRangeStart: string | null;
        messageRangeEnd: string | null;
        tokenCount: number;
        createdAt: Date;
      }) => this.toCompaction(r),
    );
  }

  /**
   * Get the latest compaction summary.
   */
  async getLatestCompaction(conversationId: string): Promise<CompactionSummary | null> {
    const record = await this.compactionModel.findLatest(conversationId);
    return record ? this.toCompaction(record) : null;
  }

  /**
   * Get the compaction template for LLM-based summarization.
   */
  getCompactionTemplate(): string {
    return COMPACTION_TEMPLATE;
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  /**
   * Replace a ## section in Markdown content.
   * If section not found, appends at the end.
   */
  private replaceSection(content: string, sectionName: string, newSectionContent: string): string {
    if (!sectionName) {
      throw new Error('section name is required for replace_section operation');
    }

    const sectionHeader = sectionName.startsWith('#') ? sectionName : `## ${sectionName}`;
    const headerLevel = sectionHeader.match(/^#+/)?.[0].length ?? 2;
    const lines = content.split('\n');
    const result: string[] = [];

    let inTargetSection = false;
    let sectionFound = false;
    let inserted = false;

    for (const line of lines) {
      // Check if this line is a heading at the same or higher level
      const headingMatch = line.match(/^(#+)\s/);
      if (headingMatch) {
        const level = headingMatch[1].length;

        if (inTargetSection && level <= headerLevel) {
          // End of target section — insert replacement before this heading
          if (!inserted) {
            result.push(`${sectionHeader}`);
            result.push(newSectionContent);
            result.push('');
            inserted = true;
          }
          inTargetSection = false;
        }

        // Exact match: compare trimmed line against header (not startsWith)
        if (line.trim() === sectionHeader.trim()) {
          inTargetSection = true;
          sectionFound = true;
          continue; // Skip original header
        }
      }

      if (!inTargetSection) {
        result.push(line);
      }
    }

    // If section was found but we're still in it (end of file)
    if (inTargetSection && !inserted) {
      result.push(`${sectionHeader}`);
      result.push(newSectionContent);
      inserted = true;
    }

    // If section not found, append at end
    if (!sectionFound) {
      result.push('');
      result.push(`${sectionHeader}`);
      result.push(newSectionContent);
    }

    return result.join('\n');
  }

  private toDetail(record: {
    id: string;
    ownerId: string;
    ownerType: string;
    scope: string;
    path: string;
    content: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }): MemoryFileDetail {
    return {
      id: record.id,
      ownerId: record.ownerId,
      ownerType: record.ownerType as MemoryOwnerType,
      scope: record.scope,
      path: record.path,
      content: record.content,
      contentLength: record.content.length,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toInfo(record: {
    id: string;
    ownerId: string;
    ownerType: string;
    scope: string;
    path: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }): MemoryFileInfo {
    return {
      id: record.id,
      ownerId: record.ownerId,
      ownerType: record.ownerType as MemoryOwnerType,
      scope: record.scope,
      path: record.path,
      contentLength: 0, // Not loaded in list query
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toCompaction(record: {
    id: string;
    conversationId: string;
    summary: string;
    messageRangeStart: string | null;
    messageRangeEnd: string | null;
    tokenCount: number;
    createdAt: Date;
  }): CompactionSummary {
    return {
      id: record.id,
      conversationId: record.conversationId,
      summary: record.summary,
      messageRangeStart: record.messageRangeStart,
      messageRangeEnd: record.messageRangeEnd,
      tokenCount: record.tokenCount,
      createdAt: record.createdAt,
    };
  }
}

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
    memoryType?: string,
    description?: string,
  ): Promise<MemoryFileDetail> {
    const record = await this.memoryFileModel.upsert({
      ownerId,
      ownerType,
      scope,
      path,
      content,
      memoryType,
      description,
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
  async listMemoryFiles(
    ownerId: string,
    scope?: string,
    path?: string,
    memoryType?: string,
    stale?: boolean,
    sort?: string,
    order?: 'asc' | 'desc',
  ): Promise<MemoryFileInfo[]> {
    const records = await this.memoryFileModel.list({ ownerId, scope, path, memoryType, stale, sort, order });
    return records.map((r: any) => this.toInfo(r));
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
   * v1.8.1: Build a CC-style memory digest for automatic system-prompt injection.
   *
   * Unlike `/recall` (which is a keyword-search API), the digest is a zero-query,
   * "always load" view of the agent's memory, formatted as Markdown and truncated
   * to fit in a system prompt (default: 200 lines / 6000 bytes, matching Claude
   * Code's MEMORY.md truncation policy).
   *
   * Priority order (highest → lowest):
   *   1. Facts (fact type)       — high-precision, always included
   *   2. Reference / Semantic    — curated knowledge
   *   3. Episodic                — recent sessions (recency-sorted, limited)
   *
   * Each file contributes a summary block:
   *   ### {path}
   *   {description or first 120 chars of content}
   *
   * If total exceeds budget, episodic is truncated first, then reference,
   * facts are always kept.
   */
  async buildDigest(
    ownerId: string,
    opts: { scope?: string; maxLines?: number; maxBytes?: number } = {},
  ): Promise<{
    digest: string;
    totalLines: number;
    totalBytes: number;
    filesSummarized: number;
    filesTotal: number;
    truncated: boolean;
    generatedAt: string;
  }> {
    const scope = opts.scope ?? 'global';
    const maxLines = opts.maxLines ?? 200;
    const maxBytes = opts.maxBytes ?? 6000;

    // Load all non-stale files for this owner+scope, including content.
    interface DigestRow {
      id: string;
      path: string;
      memoryType: string | null;
      description: string | null;
      content: string;
      updatedAt: Date;
    }
    const files = (await prisma.iMMemoryFile.findMany({
      where: { ownerId, scope, stale: false },
      select: {
        id: true,
        path: true,
        memoryType: true,
        description: true,
        content: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    })) as DigestRow[];

    const filesTotal = files.length;
    if (filesTotal === 0) {
      return {
        digest: '# Memory Digest\n\n_(no memory files yet)_\n',
        totalLines: 2,
        totalBytes: 35,
        filesSummarized: 0,
        filesTotal: 0,
        truncated: false,
        generatedAt: new Date().toISOString(),
      };
    }

    // Classify by type
    const facts = files.filter((f: DigestRow) => f.memoryType === 'fact');
    const references = files.filter(
      (f: DigestRow) => f.memoryType === 'reference' || f.memoryType === 'semantic' || !f.memoryType,
    );
    const episodes = files.filter((f: DigestRow) => f.memoryType === 'episodic').slice(0, 10); // cap episodes

    // Helper: one-liner summary for a file
    const summarize = (f: DigestRow): string => {
      const desc = f.description?.trim();
      if (desc) return desc;
      const firstLine = f.content.split('\n').find((l: string) => l.trim().length > 0) || '';
      return firstLine.slice(0, 120).trim();
    };

    // Build sections
    const sections: string[] = [];
    sections.push('# Memory Digest');
    sections.push(`_Prismer auto-load · ${filesTotal} files · generated ${new Date().toISOString()}_`);
    sections.push('');

    let filesSummarized = 0;

    if (facts.length > 0) {
      sections.push('## Facts');
      for (const f of facts) {
        sections.push(`- **${f.path}** — ${summarize(f)}`);
        filesSummarized++;
      }
      sections.push('');
    }

    if (references.length > 0) {
      sections.push('## Reference Knowledge');
      for (const f of references) {
        sections.push(`- **${f.path}** — ${summarize(f)}`);
        filesSummarized++;
      }
      sections.push('');
    }

    if (episodes.length > 0) {
      sections.push('## Recent Episodes');
      for (const f of episodes) {
        const when = f.updatedAt.toISOString().slice(0, 10);
        sections.push(`- **${f.path}** _(${when})_ — ${summarize(f)}`);
        filesSummarized++;
      }
      sections.push('');
    }

    sections.push('---');
    sections.push(
      '_Load full content via `GET /api/im/memory/files/:id` or search via `GET /api/im/recall?scope=memory`._',
    );

    // Truncate to budget
    let digest = sections.join('\n');
    let truncated = false;

    // Line-count truncate first
    const lines = digest.split('\n');
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines - 2);
      kept.push('');
      kept.push(`_… truncated (${lines.length - maxLines + 2} more lines)_`);
      digest = kept.join('\n');
      truncated = true;
    }

    // Byte-count truncate (final safety)
    if (digest.length > maxBytes) {
      digest = digest.slice(0, maxBytes - 60).replace(/\n[^\n]*$/, '');
      digest += '\n\n_… truncated at byte budget_';
      truncated = true;
    }

    return {
      digest,
      totalLines: digest.split('\n').length,
      totalBytes: digest.length,
      filesSummarized,
      filesTotal,
      truncated,
      generatedAt: new Date().toISOString(),
    };
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

  async getStats(ownerId: string) {
    // TODO(perf): content loaded only for totalBytes — consider raw SQL SUM(LENGTH(content)) or denormalized contentLength column
    const files = await prisma.iMMemoryFile.findMany({
      where: { ownerId },
      select: { id: true, memoryType: true, stale: true, content: true, updatedAt: true },
    });

    let totalBytes = 0;
    const typeBreakdown: Record<string, number> = {};
    let staleFiles = 0;
    let oldestActiveAt: Date | null = null;
    let newestAt: Date | null = null;

    for (const f of files) {
      totalBytes += (f.content || '').length;
      const t = f.memoryType || 'untyped';
      typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
      if (f.stale) staleFiles++;
      if (!f.stale) {
        if (!oldestActiveAt || f.updatedAt < oldestActiveAt) oldestActiveAt = f.updatedAt;
      }
      if (!newestAt || f.updatedAt > newestAt) newestAt = f.updatedAt;
    }

    const memoryIds = files.map((f: { id: string }) => f.id);
    let linkedCount = 0;
    if (memoryIds.length > 0) {
      linkedCount = await prisma.iMKnowledgeLink.count({
        where: {
          OR: [
            { sourceType: 'memory', sourceId: { in: memoryIds } },
            { targetType: 'memory', targetId: { in: memoryIds } },
          ],
        },
      });
    }

    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: ownerId },
      select: { metadata: true },
    });
    const meta = (() => {
      try {
        return JSON.parse(card?.metadata || '{}');
      } catch {
        return {};
      }
    })();
    const lastDreamAt = meta.last_dream_at || null;

    let dreamStatus: 'ready' | 'cooldown' | 'running' = 'ready';
    let dreamCooldownRemaining: number | undefined;
    if (lastDreamAt) {
      const elapsed = Date.now() - new Date(lastDreamAt).getTime();
      const gate = 24 * 60 * 60 * 1000;
      if (elapsed < gate) {
        dreamStatus = 'cooldown';
        dreamCooldownRemaining = Math.round((gate - elapsed) / 3600000);
      }
    }

    return {
      totalFiles: files.length,
      activeFiles: files.length - staleFiles,
      staleFiles,
      totalBytes,
      typeBreakdown,
      linkedCount,
      lastDreamAt,
      dreamStatus,
      dreamCooldownRemaining,
      oldestActiveFile: oldestActiveAt?.toISOString() || null,
      newestFile: newestAt?.toISOString() || null,
    };
  }

  async updateFileMetadata(
    id: string,
    data: { memoryType?: string; description?: string; stale?: boolean },
  ): Promise<MemoryFileInfo> {
    const existing = await this.memoryFileModel.findById(id);
    if (!existing) throw new MemoryNotFoundError(id);
    const updated = await this.memoryFileModel.updateMetadata(id, data);
    return this.toInfo(updated);
  }

  // ═══════════════════════════════════════════════════════════
  // Search — Cross-file content search
  // ═══════════════════════════════════════════════════════════

  private isMySQL(): boolean {
    return (process.env.DATABASE_URL || '').startsWith('mysql://');
  }

  /**
   * Search memory files by content.
   * MySQL: uses FULLTEXT MATCH..AGAINST on (path, description) + LIKE on content.
   * SQLite: falls back to Prisma `contains` on all fields.
   */
  async searchMemoryFiles(ownerId: string, query: string, limit: number = 10, scope?: string) {
    if (this.isMySQL()) {
      return this.searchMemoryFilesMySQL(ownerId, query, limit, scope);
    }
    return this.searchMemoryFilesSQLite(ownerId, query, limit, scope);
  }

  private async searchMemoryFilesMySQL(ownerId: string, query: string, limit: number, scope?: string) {
    const searchTerm = query.replace(/[+\-<>()~*"@]/g, ' ').trim();
    if (!searchTerm) return [];

    // MCP `recall` tool contract: query is concise keywords (3–5 words), not full sentences.
    // Strategy: anchor on the first 2 words (MUST match as topic), treat the rest as
    // optional relevance boosters. Prevents multi-word queries from collapsing to 0 hits
    // while keeping precision on the topic anchor.
    const words = searchTerm.split(/\s+/).filter(Boolean);
    const booleanQuery = words.map((w, i) => (i < 2 ? `+${w}*` : `${w}*`)).join(' ');
    // v1.8.1: Multi-word LIKE fallback on content.
    // Previous version only checked first word (`%word1%`), which missed
    // conversational memory where person names / events / dates are scattered
    // across the content body. FULLTEXT only indexes (path, description),
    // so for episodic memory the content LIKE is the primary search path.
    //
    // New approach: build OR clauses for the top-3 longest query words on content.
    // This catches files where any relevant keyword appears, without being
    // as expensive as a full multi-word AND (which would miss partial matches).
    const likeWords = words
      .filter((w) => w.length >= 3)
      .sort((a, b) => b.length - a.length) // longest first = most specific
      .slice(0, 3);
    const likeTerm1 = `%${likeWords[0] ?? searchTerm}%`;
    const likeTerm2 = likeWords.length > 1 ? `%${likeWords[1]}%` : likeTerm1;
    const likeTerm3 = likeWords.length > 2 ? `%${likeWords[2]}%` : likeTerm1;

    type RawRow = {
      id: string;
      path: string;
      scope: string;
      content: string;
      description: string | null;
      memoryType: string | null;
      stale: boolean | number;
      updatedAt: Date;
      ft_meta_score: number;
      ft_content_score: number;
    };

    // v1.8.1: Two-tier FULLTEXT search.
    //
    // Tier 1: MATCH(path, description) — high precision for reference/fact/semantic memory
    //         where the description contains query-relevant keywords.
    // Tier 2: MATCH(content) — essential for episodic/conversation memory where keywords
    //         (person names, events, dates) appear in the body, not the description.
    //
    // Both scores are combined in the application-layer relevance ranking.
    // LIKE fallback remains for databases where the FULLTEXT index on content
    // hasn't been created yet (migration 036 pending).
    const scopeFilter = scope ?? 'global';
    let rows: RawRow[];

    try {
      // Primary path: dual FULLTEXT (requires migration 036 — idx_ft_memory_content)
      rows = await prisma.$queryRaw`
        SELECT id, path, scope, content, description, memoryType, stale, updatedAt,
               MATCH(path, description) AGAINST(${booleanQuery} IN BOOLEAN MODE) AS ft_meta_score,
               MATCH(content) AGAINST(${booleanQuery} IN BOOLEAN MODE) AS ft_content_score
        FROM im_memory_files
        WHERE ownerId = ${ownerId}
          AND scope = ${scopeFilter}
          AND (
            MATCH(path, description) AGAINST(${booleanQuery} IN BOOLEAN MODE)
            OR MATCH(content) AGAINST(${booleanQuery} IN BOOLEAN MODE)
            OR content LIKE ${likeTerm1}
            OR content LIKE ${likeTerm2}
            OR content LIKE ${likeTerm3}
            OR description LIKE ${likeTerm1}
          )
        ORDER BY (ft_meta_score + ft_content_score) DESC, updatedAt DESC
        LIMIT ${limit * 2}
      `;
    } catch (err: unknown) {
      // Fallback: migration 036 not yet applied — MATCH(content) throws ERROR 1191.
      // Gracefully degrade to meta-only FULLTEXT + LIKE on content.
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('1191') || msg.includes('FULLTEXT')) {
        console.warn(`${LOG} FULLTEXT(content) index missing — falling back to meta-only search. Run migration 036.`);
        rows = await prisma.$queryRaw`
          SELECT id, path, scope, content, description, memoryType, stale, updatedAt,
                 MATCH(path, description) AGAINST(${booleanQuery} IN BOOLEAN MODE) AS ft_meta_score,
                 0 AS ft_content_score
          FROM im_memory_files
          WHERE ownerId = ${ownerId}
            AND scope = ${scopeFilter}
            AND (
              MATCH(path, description) AGAINST(${booleanQuery} IN BOOLEAN MODE)
              OR content LIKE ${likeTerm1}
              OR content LIKE ${likeTerm2}
              OR content LIKE ${likeTerm3}
              OR description LIKE ${likeTerm1}
            )
          ORDER BY ft_meta_score DESC, updatedAt DESC
          LIMIT ${limit * 2}
        `;
      } else {
        throw err; // Non-index error — rethrow
      }
    }

    // v1.8.1: Weighted multi-signal ranking to break FULLTEXT score ties.
    // Previous wave-1 code lumped path/description/content into a single coverage
    // number (max +0.25 boost), which diluted the strong signal (path segment match)
    // with the weak signal (content substring match). Result: many files tied at
    // ~0.448 FULLTEXT score stayed tied after boost, killing MRR.
    //
    // New approach: split coverage into 3 separate signals and weight them:
    //   - path segment match:  weight 3  (highest signal — file is "about" this topic)
    //   - description match:   weight 2  (curated one-line summary)
    //   - content substring:   weight 1  (noisy — words can appear incidentally)
    //
    // Plus memoryType boost (fact/semantic are higher precision than reference)
    // and episodic recency decay.
    const lowerWords = words.map((w) => w.toLowerCase());
    const now = Date.now();

    const typeBoostMap: Record<string, number> = {
      fact: 0.05,
      semantic: 0.03,
      reference: 0.0,
      episodic: 0.0, // episodic gets recency boost separately
    };

    return rows
      .map((f) => {
        const q = query.toLowerCase();
        const pathLower = f.path.toLowerCase();
        const descLower = (f.description || '').toLowerCase();
        const contentLower = f.content.toLowerCase();

        // Combine meta score (path+description) and content score into base relevance.
        // Meta score is more precise (curated description), content score is broader.
        const ftScore = Math.max(f.ft_meta_score, f.ft_content_score * 0.8);
        let relevance = ftScore > 0 ? Math.min(0.5 + ftScore * 0.3, 0.95) : 0.3;

        if (pathLower === q) {
          relevance = 1.0;
        } else if (lowerWords.length > 0) {
          // Path segment word coverage: strongest signal. Split path on /, ., _, -, space.
          const pathSegments = pathLower.split(/[\/._\-\s]+/).filter(Boolean);
          const pathHits = lowerWords.filter((w) => pathSegments.some((seg) => seg.includes(w))).length;
          const pathCoverage = pathHits / lowerWords.length;

          // Description word match: curated high-signal
          const descHits = lowerWords.filter((w) => descLower.includes(w)).length;
          const descCoverage = descHits / lowerWords.length;

          // Content substring: noisy fallback
          const contentHits = lowerWords.filter((w) => contentLower.includes(w)).length;
          const contentCoverage = contentHits / lowerWords.length;

          // Weighted average: path(3) + desc(2) + content(1) = 6
          const weightedCoverage = (pathCoverage * 3 + descCoverage * 2 + contentCoverage * 1) / 6;

          // Max boost = 0.40 (significantly larger than wave-1's 0.25, so ties break cleanly)
          relevance = Math.min(relevance + weightedCoverage * 0.4, 0.98);
        }

        // memoryType weighting: fact > semantic > reference = episodic (base)
        const typeBoost = typeBoostMap[f.memoryType || 'reference'] ?? 0;
        relevance += typeBoost;

        // Episodic recency boost: decay over 90 days, max +0.05
        if (f.memoryType === 'episodic') {
          const ageDays = (now - f.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
          const recencyBoost = Math.max(0, 0.05 - ageDays * 0.0005);
          relevance += recencyBoost;
        }

        // Stale penalty: downrank files marked stale by consolidation
        if (f.stale) {
          relevance *= 0.7;
        }

        // Final cap at 1.0
        relevance = Math.min(relevance, 1.0);

        return {
          id: f.id,
          path: f.path,
          scope: f.scope,
          snippet: f.content.slice(0, 2000),
          memoryType: f.memoryType,
          updatedAt: f.updatedAt,
          stale: Boolean(f.stale),
          relevance,
          source: 'memory' as const,
        };
      })
      .sort((a: { relevance: number; updatedAt: Date }, b: { relevance: number; updatedAt: Date }) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        // Final tiebreaker: recency
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      })
      .slice(0, limit);
  }

  private async searchMemoryFilesSQLite(ownerId: string, query: string, limit: number, scope?: string) {
    const files = await prisma.iMMemoryFile.findMany({
      where: {
        ownerId,
        ...(scope ? { scope } : {}),
        OR: [{ path: { contains: query } }, { content: { contains: query } }, { description: { contains: query } }],
      },
      select: {
        id: true,
        path: true,
        scope: true,
        content: true,
        description: true,
        memoryType: true,
        stale: true,
        updatedAt: true,
      },
      take: limit * 2,
      orderBy: { updatedAt: 'desc' },
    });

    return files
      .map(
        (f: {
          id: string;
          path: string;
          scope: string;
          content: string;
          description: string | null;
          memoryType: string | null;
          stale: boolean;
          updatedAt: Date;
        }) => {
          const q = query.toLowerCase();
          const pathLower = f.path.toLowerCase();
          const contentLower = f.content.toLowerCase();
          const descLower = (f.description || '').toLowerCase();
          let relevance = 0.3;
          if (pathLower === q) relevance = 1.0;
          else if (pathLower.includes(q)) relevance = 0.8;
          else if (descLower.includes(q)) relevance = 0.7;
          else if (contentLower.includes(q)) relevance = 0.6;

          return {
            id: f.id,
            path: f.path,
            scope: f.scope,
            snippet: f.content.slice(0, 2000),
            memoryType: f.memoryType,
            updatedAt: f.updatedAt,
            stale: f.stale,
            relevance,
            source: 'memory' as const,
          };
        },
      )
      .sort((a: { relevance: number }, b: { relevance: number }) => b.relevance - a.relevance)
      .slice(0, limit);
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
    memoryType?: string | null;
    description?: string | null;
    stale?: boolean;
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
      memoryType: record.memoryType ?? null,
      description: record.description ?? null,
      stale: record.stale ?? false,
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
    memoryType?: string | null;
    description?: string | null;
    stale?: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): MemoryFileInfo {
    return {
      id: record.id,
      ownerId: record.ownerId,
      ownerType: record.ownerType as MemoryOwnerType,
      scope: record.scope,
      path: record.path,
      contentLength: 0,
      version: record.version,
      memoryType: record.memoryType ?? null,
      description: record.description ?? null,
      stale: record.stale ?? false,
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

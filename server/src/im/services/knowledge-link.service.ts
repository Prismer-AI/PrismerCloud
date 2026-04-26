/**
 * Prismer IM — Knowledge Link Service
 *
 * Manages bidirectional associations between Memory files and Evolution entities.
 * Auto-creates links during evolve_record and memory_write operations.
 */

import prisma from '../db';

const LOG = '[KnowledgeLink]';

export type KnowledgeLinkSource = 'memory' | 'gene' | 'capsule' | 'signal';
export type KnowledgeLinkType = 'related' | 'derived_from' | 'applied_in' | 'contradicts';

export interface KnowledgeLinkInfo {
  id: string;
  sourceType: KnowledgeLinkSource;
  sourceId: string;
  targetType: KnowledgeLinkSource;
  targetId: string;
  linkType: KnowledgeLinkType;
  strength: number;
  scope: string;
  createdAt: Date;
}

const LINK_STOPWORDS = new Set([
  'error',
  'data',
  'test',
  'code',
  'file',
  'type',
  'name',
  'path',
  'value',
  'result',
  'response',
  'request',
  'service',
  'function',
  'handler',
  'config',
  'update',
  'create',
  'delete',
  'method',
  'agent',
  'memory',
  'gene',
  'signal',
  'task',
  'user',
  'global',
  'strategy',
  'status',
  'check',
  'handle',
  'process',
  'build',
]);

export class KnowledgeLinkService {
  /**
   * Create or strengthen a knowledge link (upsert).
   * If the link already exists, increment strength by 0.1 (max 1.0).
   */
  async createLink(
    sourceType: KnowledgeLinkSource,
    sourceId: string,
    targetType: KnowledgeLinkSource,
    targetId: string,
    linkType: KnowledgeLinkType = 'related',
    scope: string = 'global',
  ): Promise<KnowledgeLinkInfo> {
    const existing = await prisma.iMKnowledgeLink.findUnique({
      where: {
        sourceType_sourceId_targetType_targetId_linkType: {
          sourceType,
          sourceId,
          targetType,
          targetId,
          linkType,
        },
      },
    });

    if (existing) {
      const updated = await prisma.iMKnowledgeLink.update({
        where: { id: existing.id },
        data: { strength: Math.min(1.0, existing.strength + 0.1) },
      });
      return updated as KnowledgeLinkInfo;
    }

    const link = await prisma.iMKnowledgeLink.create({
      data: { sourceType, sourceId, targetType, targetId, linkType, scope },
    });

    console.log(`${LOG} Created: ${sourceType}/${sourceId} → ${targetType}/${targetId} [${linkType}]`);
    return link as KnowledgeLinkInfo;
  }

  /**
   * Find all links for a given source entity.
   */
  async findBySource(sourceType: KnowledgeLinkSource, sourceId: string): Promise<KnowledgeLinkInfo[]> {
    const links = await prisma.iMKnowledgeLink.findMany({
      where: { sourceType, sourceId },
      orderBy: { strength: 'desc' },
    });
    return links as KnowledgeLinkInfo[];
  }

  /**
   * Find all links for a given target entity.
   */
  async findByTarget(targetType: KnowledgeLinkSource, targetId: string): Promise<KnowledgeLinkInfo[]> {
    const links = await prisma.iMKnowledgeLink.findMany({
      where: { targetType, targetId },
      orderBy: { strength: 'desc' },
    });
    return links as KnowledgeLinkInfo[];
  }

  /**
   * Find all links involving a specific entity (either source or target).
   */
  async findAllRelated(entityType: KnowledgeLinkSource, entityId: string): Promise<KnowledgeLinkInfo[]> {
    const links = await prisma.iMKnowledgeLink.findMany({
      where: {
        OR: [
          { sourceType: entityType, sourceId: entityId },
          { targetType: entityType, targetId: entityId },
        ],
      },
      orderBy: { strength: 'desc' },
    });
    return links as KnowledgeLinkInfo[];
  }

  /**
   * Auto-link: when a capsule is recorded with a gene, check for related memory files
   * and create gene↔memory links if the memory content mentions relevant signal types.
   */
  async autoLinkFromCapsule(
    geneId: string,
    signalKey: string,
    agentId: string,
    scope: string = 'global',
  ): Promise<number> {
    let linksCreated = 0;

    try {
      const rawTerms = signalKey
        .split('|')
        .map((s) => s.replace(/^(error|perf|tag|capability):/, ''))
        .filter((s) => s.length > 2);

      if (rawTerms.length === 0) return 0;

      // Search both underscore and space variants to match memory content in either format
      const searchTerms = rawTerms.flatMap((t) => {
        const spaced = t.replace(/_/g, ' ');
        return t === spaced ? [t] : [t, spaced];
      });

      // Search memory files in the same SCOPE, not just the recording agent's own files.
      // Gene and memory are both in the scope namespace — the correct boundary for
      // knowledge links is scope, not ownership. Using ownerId would silently fail when
      // agent A records an outcome for agent B's published gene (A has no matching memories
      // under its own ownerId, even though B's memories exist in the same global scope).
      const memoryFiles = await prisma.iMMemoryFile.findMany({
        where: {
          scope,
          OR: searchTerms.flatMap((term) => [{ path: { contains: term } }, { content: { contains: term } }]),
        },
        select: { id: true, path: true },
        take: 5,
      });

      for (const mf of memoryFiles) {
        await this.createLink('gene', geneId, 'memory', mf.id, 'related', scope);
        linksCreated++;
      }

      if (linksCreated > 0) {
        console.log(`${LOG} Auto-linked gene ${geneId} → ${linksCreated} memory files`);
      }
    } catch (err) {
      console.error(`${LOG} Auto-link error:`, err);
    }

    return linksCreated;
  }

  /**
   * Auto-link: when a memory file is written, check if its content mentions
   * any known gene titles or categories, and create links.
   */
  async autoLinkFromMemoryWrite(
    memoryFileId: string,
    content: string,
    agentId: string,
    scope: string = 'global',
  ): Promise<number> {
    let linksCreated = 0;

    try {
      // Search genes in the same scope — include own + published genes (same logic as
      // selectGene: own genes + published/seed by others). Using ownerAgentId alone would
      // miss published genes from other agents that the memory content relates to.
      const genes = await prisma.iMGene.findMany({
        where: {
          scope,
          OR: [{ ownerAgentId: agentId }, { visibility: { in: ['published', 'seed'] } }],
        },
        select: { id: true, title: true, category: true },
        take: 100,
      });

      const contentLower = content.toLowerCase();
      for (const gene of genes) {
        const titleWords = (gene.title || '')
          .toLowerCase()
          .split(/\s+/)
          .filter((w: string) => w.length > 3 && !LINK_STOPWORDS.has(w));
        const matchCount = titleWords.filter((w: string) => contentLower.includes(w)).length;

        if (matchCount >= 2) {
          await this.createLink('memory', memoryFileId, 'gene', gene.id, 'related', scope);
          linksCreated++;
        }
      }

      if (linksCreated > 0) {
        console.log(`${LOG} Auto-linked memory ${memoryFileId} → ${linksCreated} genes`);
      }
    } catch (err) {
      console.error(`${LOG} Auto-link from memory error:`, err);
    }

    return linksCreated;
  }

  /**
   * Get linked gene info for memory files (used by recall enhancement).
   */
  async getLinkedGenes(
    memoryFileIds: string[],
  ): Promise<
    Map<string, Array<{ geneId: string; title: string; successRate: number; linkType: string; strength: number }>>
  > {
    if (memoryFileIds.length === 0) return new Map();

    // BUG-1 fix: query both directions (memory→gene AND gene→memory)
    const links = await prisma.iMKnowledgeLink.findMany({
      where: {
        OR: [
          { sourceType: 'memory', sourceId: { in: memoryFileIds }, targetType: 'gene' },
          { sourceType: 'gene', targetType: 'memory', targetId: { in: memoryFileIds } },
        ],
      },
    });

    const normalized: Array<{ memoryId: string; geneId: string; linkType: string; strength: number }> = links.map(
      (l: any) => ({
        memoryId: l.sourceType === 'memory' ? l.sourceId : l.targetId,
        geneId: l.sourceType === 'gene' ? l.sourceId : l.targetId,
        linkType: l.linkType as string,
        strength: l.strength as number,
      }),
    );

    const geneIds = [...new Set(normalized.map((n) => n.geneId))];
    if (geneIds.length === 0) return new Map();

    const genes = await prisma.iMGene.findMany({
      where: { id: { in: geneIds } },
      select: { id: true, title: true, successCount: true, failureCount: true },
    });

    const geneMap = new Map(genes.map((g: any) => [g.id, g]));
    const result = new Map<
      string,
      Array<{ geneId: string; title: string; successRate: number; linkType: string; strength: number }>
    >();

    for (const n of normalized) {
      const gene = geneMap.get(n.geneId);
      if (!gene) continue;

      const total = (gene as any).successCount + (gene as any).failureCount;
      const successRate = total > 0 ? (gene as any).successCount / total : 0;

      const arr = result.get(n.memoryId) || [];
      arr.push({
        geneId: n.geneId,
        title: (gene as any).title || n.geneId,
        successRate,
        linkType: n.linkType || 'related',
        strength: n.strength ?? 1.0,
      });
      result.set(n.memoryId, arr);
    }

    return result;
  }

  /**
   * Get linked memory info for genes (used by evolution selector enhancement).
   */
  async getLinkedMemories(
    geneIds: string[],
  ): Promise<Map<string, Array<{ memoryId: string; path: string; snippet: string }>>> {
    if (geneIds.length === 0) return new Map();

    const links = await prisma.iMKnowledgeLink.findMany({
      where: {
        OR: [
          { sourceType: 'gene', sourceId: { in: geneIds }, targetType: 'memory' },
          { sourceType: 'memory', targetType: 'gene', targetId: { in: geneIds } },
        ],
      },
    });

    const memoryIds = [
      ...new Set(
        links.map((l: { sourceType: string; sourceId: string; targetId: string }) =>
          l.sourceType === 'memory' ? l.sourceId : l.targetId,
        ),
      ),
    ];
    if (memoryIds.length === 0) return new Map();

    const memories = await prisma.iMMemoryFile.findMany({
      where: { id: { in: memoryIds } },
      select: { id: true, path: true, content: true },
    });

    const memMap = new Map(memories.map((m: any) => [m.id, m]));
    const result = new Map<string, Array<{ memoryId: string; path: string; snippet: string }>>();

    for (const link of links) {
      const geneId = link.sourceType === 'gene' ? link.sourceId : link.targetId;
      const memoryId = link.sourceType === 'memory' ? link.sourceId : link.targetId;
      const mem = memMap.get(memoryId);
      if (!mem) continue;

      const arr = result.get(geneId) || [];
      arr.push({ memoryId, path: (mem as any).path, snippet: ((mem as any).content || '').slice(0, 200) });
      result.set(geneId, arr);
    }

    return result;
  }

  /**
   * Cleanup: remove weak links (strength < 0.1).
   */
  async pruneWeakLinks(): Promise<number> {
    const { count } = await prisma.iMKnowledgeLink.deleteMany({
      where: { strength: { lt: 0.1 } },
    });
    if (count > 0) console.log(`${LOG} Pruned ${count} weak links`);
    return count;
  }
}

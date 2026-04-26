/**
 * Prismer IM — Skill Catalog Service
 *
 * Foundation for the Evolution ecosystem. Skills are the raw material:
 * - Synced from external sources (ClawHub, awesome-openclaw-skills, community)
 * - Searchable, browsable, rankable
 * - Can be converted to Evolution Genes for agent use
 *
 * Data flow: External Sources → im_skills table → /evolution page → Gene conversion
 */

import prisma from '../db';
import yaml from 'yaml';
import { bumpSkillOnInstall, decaySkillOnUninstall, bumpSkillOnStar, bumpSkillOnFork } from './quality-score.service';

const LOG = '[SkillService]';

// ─── Types ──────────────────────────────────────────────────

export interface SkillInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  source: string;
  sourceUrl: string;
  installs: number;
  stars: number;
  status: string;
  geneId: string | null;
  signals?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillDetail extends SkillInfo {
  content: string;
  sourceId: string;
  metadata: Record<string, unknown>;
}

export interface SkillImportItem {
  name: string;
  description: string;
  category: string;
  author?: string;
  source: string;
  sourceUrl?: string;
  sourceId: string;
  tags?: string[];
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillSearchOptions {
  query?: string;
  category?: string;
  source?: string;
  compatibility?: string;
  sort: 'newest' | 'most_installed' | 'most_starred' | 'name' | 'relevance' | 'recommended';
  page: number;
  limit: number;
  /** @internal — used to prevent infinite recursion on FULLTEXT fallback */
  _skipFulltext?: boolean;
}

export interface SkillStats {
  total: number;
  by_source: Record<string, number>;
  by_category: Record<string, number>;
  total_installs: number;
}

// ─── Service ────────────────────────────────────────────────

export class SkillService {
  // ═══════════════════════════════════════════════════════════
  // Public Read APIs (no auth)
  // ═══════════════════════════════════════════════════════════

  /**
   * Search and browse skills with word splitting, signals matching,
   * compatibility filtering, and relevance scoring.
   */
  async search(opts: SkillSearchOptions): Promise<{ skills: SkillInfo[]; total: number }> {
    // MySQL FULLTEXT fast path: use MATCH AGAINST for text search when available
    if (
      !opts._skipFulltext &&
      (process.env.DATABASE_URL || '').startsWith('mysql') &&
      opts.query &&
      opts.query.trim().length > 0
    ) {
      return this._fulltextSearch(opts);
    }

    const where: Record<string, unknown> = { status: 'active', qualityScore: { gte: 0.005 } };

    if (opts.category) where.category = opts.category;
    if (opts.source) where.source = opts.source;

    // Compatibility filter: JSON array contains check
    if (opts.compatibility) {
      where.compatibility = { contains: opts.compatibility };
    }

    // Word-split search: "timeout retry" → match each word independently
    const queryWords = opts.query?.trim().split(/\s+/).filter(Boolean) || [];
    if (queryWords.length > 0) {
      // Each word must match at least one field (AND logic across words)
      where.AND = queryWords.map((word) => ({
        OR: [
          { name: { contains: word } },
          { description: { contains: word } },
          { tags: { contains: word } },
          { signals: { contains: word } },
        ],
      }));
    }

    // Determine sort order
    const orderBy: Record<string, string> = {};
    const useRelevanceSort = opts.sort === 'relevance';
    const useRecommendedSort = opts.sort === 'recommended';
    if (!useRelevanceSort && !useRecommendedSort) {
      switch (opts.sort) {
        case 'most_installed':
          orderBy.installs = 'desc';
          break;
        case 'most_starred':
          orderBy.stars = 'desc';
          break;
        case 'name':
          orderBy.name = 'asc';
          break;
        default:
          orderBy.createdAt = 'desc';
          break;
      }
    } else if (useRecommendedSort) {
      // Initial Prisma sort by qualityScore; post-fetch re-ranking applied below
      orderBy.qualityScore = 'desc';
    }

    // If relevance or recommended sort, over-fetch for in-memory re-ranking
    const fetchLimit = useRelevanceSort || useRecommendedSort ? Math.min(opts.limit * 5, 200) : opts.limit;
    const fetchSkip = useRelevanceSort || useRecommendedSort ? 0 : (opts.page - 1) * opts.limit;

    const [skills, total] = await Promise.all([
      prisma.iMSkill.findMany({
        where: where as any,
        ...(Object.keys(orderBy).length > 0 ? { orderBy } : { orderBy: { installs: 'desc' } }),
        skip: fetchSkip,
        take: fetchLimit,
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          category: true,
          tags: true,
          author: true,
          source: true,
          sourceUrl: true,
          installs: true,
          stars: true,
          status: true,
          geneId: true,
          signals: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.iMSkill.count({ where: where as any }),
    ]);

    let result = skills.map((s: (typeof skills)[number]) => ({
      ...s,
      tags: this.parseTags(s.tags),
    }));

    // Relevance scoring: rank by word match density + field importance
    if (useRelevanceSort && queryWords.length > 0) {
      const scored = result.map((s: any) => {
        let score = 0;
        const lower = {
          name: s.name.toLowerCase(),
          desc: s.description.toLowerCase(),
          tags: s.tags.join(' ').toLowerCase(),
          signals: (s.signals || '').toLowerCase(),
        };
        for (const word of queryWords) {
          const w = word.toLowerCase();
          // Name match = highest weight
          if (lower.name.includes(w)) score += 10;
          // Exact name match = bonus
          if (lower.name === w || s.slug === w) score += 20;
          // Signal match = high weight (agent relevance)
          if (lower.signals.includes(w)) score += 8;
          // Tag match = medium
          if (lower.tags.includes(w)) score += 5;
          // Description match = lower
          if (lower.desc.includes(w)) score += 2;
        }
        // Popularity tiebreaker
        score += Math.log10(Math.max(s.installs, 1)) * 0.5;
        return { skill: s, score };
      });
      scored.sort((a: any, b: any) => b.score - a.score);
      const start = (opts.page - 1) * opts.limit;
      result = scored.slice(start, start + opts.limit).map((s: any) => s.skill);
    }

    // Recommended: composite re-ranking by qualityScore + installs + recency
    if (useRecommendedSort) {
      const maxInstalls = Math.max(...result.map((s: any) => s.installs), 1);
      const now = Date.now();
      const DAY_90 = 90 * 24 * 60 * 60 * 1000;
      const COLD_START = 10; // skills need ≥10 installs to reach full weight
      result.sort((a: any, b: any) => {
        const dampenA = Math.min(1, ((a.installs || 0) + 0.5) / COLD_START);
        const dampenB = Math.min(1, ((b.installs || 0) + 0.5) / COLD_START);
        const scoreA =
          ((a.qualityScore ?? 0.01) * 0.6 +
            (a.installs / maxInstalls) * 0.3 +
            Math.max(0, 1 - (now - new Date(a.createdAt).getTime()) / DAY_90) * 0.1) *
          dampenA;
        const scoreB =
          ((b.qualityScore ?? 0.01) * 0.6 +
            (b.installs / maxInstalls) * 0.3 +
            Math.max(0, 1 - (now - new Date(b.createdAt).getTime()) / DAY_90) * 0.1) *
          dampenB;
        return scoreB - scoreA;
      });
      const start = (opts.page - 1) * opts.limit;
      result = result.slice(start, start + opts.limit);
    }

    return { skills: result, total };
  }

  /**
   * Get skill detail by slug.
   */
  async getBySlug(slug: string): Promise<SkillDetail | null> {
    const skill = await prisma.iMSkill.findUnique({ where: { slug } });
    if (!skill || skill.status !== 'active') return null;
    return this.toDetail(skill);
  }

  /**
   * Get skill detail by ID.
   */
  async getById(id: string): Promise<SkillDetail | null> {
    const skill = await prisma.iMSkill.findUnique({ where: { id } });
    if (!skill) return null;
    return this.toDetail(skill);
  }

  /**
   * Global catalog stats.
   */
  async getStats(): Promise<SkillStats> {
    const total = await prisma.iMSkill.count({ where: { status: 'active' } });

    // Group by source
    const allSkills = await prisma.iMSkill.findMany({
      where: { status: 'active' },
      select: { source: true, category: true, installs: true },
    });

    const by_source: Record<string, number> = {};
    const by_category: Record<string, number> = {};
    let total_installs = 0;

    for (const s of allSkills) {
      by_source[s.source] = (by_source[s.source] || 0) + 1;
      by_category[s.category] = (by_category[s.category] || 0) + 1;
      total_installs += s.installs;
    }

    return { total, by_source, by_category, total_installs };
  }

  /**
   * List available categories with counts.
   */
  async getCategories(): Promise<Array<{ category: string; count: number }>> {
    const skills = await prisma.iMSkill.findMany({
      where: { status: 'active' },
      select: { category: true },
    });
    const counts: Record<string, number> = {};
    for (const s of skills) {
      counts[s.category] = (counts[s.category] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Increment install count.
   */
  async recordInstall(id: string): Promise<void> {
    await prisma.iMSkill.update({
      where: { id },
      data: { installs: { increment: 1 } },
    });
  }

  /**
   * Increment star count (user rating).
   */
  async recordStar(id: string): Promise<void> {
    await prisma.iMSkill.update({
      where: { id },
      data: { stars: { increment: 1 } },
    });
    // Bump quality score on star
    bumpSkillOnStar(id).catch(() => {});
  }

  /**
   * Get trending skills — weighted score: installs * 0.7 + stars * 0.3
   * with recency boost for skills updated in the last 30 days.
   */
  async getTrending(limit: number = 20): Promise<SkillInfo[]> {
    const skills = await prisma.iMSkill.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        category: true,
        tags: true,
        author: true,
        source: true,
        sourceUrl: true,
        installs: true,
        stars: true,
        status: true,
        geneId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ installs: 'desc' }, { stars: 'desc' }],
      take: limit * 3, // over-fetch for re-ranking
    });

    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    // Re-rank with weighted score + recency
    const scored = skills.map((s: (typeof skills)[number]) => {
      const age = now - new Date(s.updatedAt).getTime();
      const recencyBoost = age < thirtyDays ? 1.5 : 1.0;
      const score = (s.installs * 0.7 + s.stars * 0.3) * recencyBoost;
      return { skill: s, score };
    });

    scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);

    return scored.slice(0, limit).map(({ skill }: { skill: (typeof skills)[number] }) => ({
      ...skill,
      tags: this.parseTags(skill.tags),
    }));
  }

  /**
   * Get related skills (same category, excluding self).
   */
  async getRelated(id: string, limit: number = 5): Promise<SkillInfo[]> {
    const skill = await prisma.iMSkill.findUnique({
      where: { id },
      select: { category: true },
    });
    if (!skill) return [];

    const related = await prisma.iMSkill.findMany({
      where: {
        category: skill.category,
        status: 'active',
        id: { not: id },
      },
      orderBy: { installs: 'desc' },
      take: limit,
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        category: true,
        tags: true,
        author: true,
        source: true,
        sourceUrl: true,
        installs: true,
        stars: true,
        status: true,
        geneId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return related.map((s: (typeof related)[number]) => ({
      ...s,
      tags: this.parseTags(s.tags),
    }));
  }

  // ═══════════════════════════════════════════════════════════
  // Import / Sync
  // ═══════════════════════════════════════════════════════════

  /**
   * Bulk import skills. Skips duplicates by sourceId.
   * Returns: { imported, skipped, errors }
   */
  async bulkImport(items: SkillImportItem[]): Promise<{
    imported: number;
    skipped: number;
    errors: number;
  }> {
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    // Batch check existing sourceIds
    const sourceIds = items.map((i) => i.sourceId).filter(Boolean);
    const existing = await prisma.iMSkill.findMany({
      where: { sourceId: { in: sourceIds } },
      select: { sourceId: true },
    });
    const existingSet = new Set(existing.map((e: { sourceId: string }) => e.sourceId));

    for (const item of items) {
      try {
        if (item.sourceId && existingSet.has(item.sourceId)) {
          skipped++;
          continue;
        }

        const slug = this.toSlug(item.name, item.source);

        // Check slug collision
        const slugExists = await prisma.iMSkill.findUnique({
          where: { slug },
          select: { id: true },
        });
        if (slugExists) {
          skipped++;
          continue;
        }

        await prisma.iMSkill.create({
          data: {
            slug,
            name: item.name,
            description: item.description || '',
            category: item.category || 'general',
            tags: JSON.stringify(item.tags || []),
            author: item.author || '',
            source: item.source,
            sourceUrl: item.sourceUrl || '',
            sourceId: item.sourceId || '',
            content: item.content || '',
            metadata: JSON.stringify(item.metadata || {}),
          },
        });

        imported++;
      } catch (err) {
        errors++;
        if (errors <= 3) {
          console.error(`${LOG} Import error for "${item.name}":`, (err as Error).message);
        }
      }
    }

    console.log(`${LOG} Bulk import: ${imported} imported, ${skipped} skipped, ${errors} errors`);
    return { imported, skipped, errors };
  }

  /**
   * Import from raw-skills.json format (awesome-openclaw-skills output).
   */
  async importFromRawSkills(
    rawSkills: Array<{
      name: string;
      description: string;
      category: string;
      url: string;
    }>,
  ): Promise<{ imported: number; skipped: number; errors: number }> {
    const items: SkillImportItem[] = rawSkills.map((s) => {
      // Extract author from URL: skills/AUTHOR/SKILL-NAME/SKILL.md
      const authorMatch = s.url.match(/skills\/([^/]+)\//);
      const author = authorMatch?.[1] || '';

      return {
        name: s.name,
        description: s.description,
        category: s.category,
        author,
        source: 'awesome-openclaw',
        sourceUrl: s.url,
        sourceId: `openclaw:${author}/${s.name}`,
        tags: [s.category],
      };
    });

    return this.bulkImport(items);
  }

  // ═══════════════════════════════════════════════════════════
  // Admin CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a skill manually (community submission).
   */
  async create(input: {
    name: string;
    description: string;
    category: string;
    tags?: string[];
    author: string;
    content?: string;
    sourceUrl?: string;
    signals?: string[];
    ownerAgentId?: string;
    forkedFrom?: string;
  }): Promise<SkillDetail> {
    const slug = this.toSlug(input.name, 'community');
    const skill = await prisma.iMSkill.create({
      data: {
        slug,
        name: input.name,
        description: input.description,
        category: input.category,
        tags: JSON.stringify(input.tags || []),
        author: input.author,
        source: 'community',
        sourceUrl: input.sourceUrl || '',
        sourceId: `community:${slug}`,
        content: input.content || '',
        signals: input.signals?.length ? JSON.stringify(input.signals.map((s) => ({ type: s }))) : '[]',
        ownerAgentId: input.ownerAgentId || null,
        ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
      },
    });

    // Bump quality score of the source skill when forked
    if (input.forkedFrom) {
      bumpSkillOnFork(input.forkedFrom).catch(() => {});
    }

    // Increment owner's publishCount when an active skill is created
    if (input.ownerAgentId && skill.status === 'active') {
      await prisma.iMUser
        .update({
          where: { id: input.ownerAgentId },
          data: { publishCount: { increment: 1 } },
        })
        .catch(() => {});
    }

    return this.toDetail(skill);
  }

  /**
   * Get skills created by a specific agent.
   */
  async getCreatedByAgent(agentId: string): Promise<SkillInfo[]> {
    const skills = await prisma.iMSkill.findMany({
      where: { ownerAgentId: agentId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        category: true,
        tags: true,
        author: true,
        source: true,
        sourceUrl: true,
        installs: true,
        stars: true,
        status: true,
        geneId: true,
        signals: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return skills.map((s: (typeof skills)[number]) => ({ ...s, tags: this.parseTags(s.tags) }));
  }

  /**
   * Update a skill.
   */
  async update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      category: string;
      tags: string[];
      content: string;
      status: string;
      geneId: string;
    }>,
  ): Promise<SkillDetail | null> {
    const existing = await prisma.iMSkill.findUnique({ where: { id } });
    if (!existing) return null;

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.tags !== undefined) updateData.tags = JSON.stringify(data.tags);
    if (data.content !== undefined) updateData.content = data.content;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.geneId !== undefined) updateData.geneId = data.geneId;

    const updated = await prisma.iMSkill.update({
      where: { id },
      data: updateData,
    });
    return this.toDetail(updated);
  }

  /**
   * Delete a skill (soft: set status to deprecated).
   */
  async deprecate(id: string): Promise<boolean> {
    const existing = await prisma.iMSkill.findUnique({ where: { id } });
    if (!existing) return false;
    await prisma.iMSkill.update({
      where: { id },
      data: { status: 'deprecated' },
    });
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Install / Uninstall (Agent ↔ Skill lifecycle)
  // ═══════════════════════════════════════════════════════════

  /**
   * Install a skill for an agent. Creates a Gene if the skill has signals + strategy.
   * Returns the agent-skill record, optional gene, skill detail, and install guide.
   */
  async installSkill(
    agentId: string,
    skillIdOrSlug: string,
    scope: string = 'global',
  ): Promise<{
    agentSkill: any;
    gene: any | null;
    skill: any;
    installGuide: Record<string, any>;
  }> {
    // 1. Find skill by ID or slug
    const skill = await prisma.iMSkill.findFirst({
      where: { OR: [{ id: skillIdOrSlug }, { slug: skillIdOrSlug }] },
    });
    if (!skill) throw new Error('Skill not found');

    // 2. Check if already installed and active
    const existing = await prisma.iMAgentSkill.findUnique({
      where: { agentId_skillId_scope: { agentId, skillId: skill.id, scope } },
    });
    if (existing?.status === 'active') {
      return { agentSkill: existing, gene: null, skill, installGuide: this.generateInstallGuide(skill) };
    }
    const isReinstall = existing?.status === 'uninstalled';

    // 3. Parse signals from the skill record
    let signals: Array<{ type: string; provider?: string; stage?: string; severity?: string }> = [];
    try {
      const parsed = JSON.parse(skill.signals || '[]');
      if (Array.isArray(parsed)) {
        signals = parsed.map((s: any) => (typeof s === 'string' ? { type: s } : s));
      }
    } catch {
      /* empty signals */
    }

    // 4. Extract strategy from content frontmatter or metadata
    const meta = this.parseSkillMetadata(skill);
    const strategy = meta.strategy || [];

    // 5. Create Gene if skill has signals + strategy (use full agentId for uniqueness)
    let gene = null;
    if (signals.length > 0 && strategy.length > 0) {
      const geneId = `skill_${skill.slug}_${agentId}_${scope}`;
      try {
        gene = await prisma.iMGene.create({
          data: {
            id: geneId,
            category: meta.category || skill.category || 'general',
            title: skill.name,
            description: skill.description,
            strategySteps: JSON.stringify(strategy),
            preconditions: JSON.stringify(meta.preconditions || []),
            constraints: JSON.stringify(meta.constraints || {}),
            visibility: 'private',
            ownerAgentId: agentId,
          },
        });
        // Create signal links
        for (const sig of signals) {
          const signalKey = sig.type || (typeof sig === 'string' ? sig : '');
          if (!signalKey) continue;
          await prisma.iMGeneSignal
            .create({
              data: { geneId, signalId: signalKey, affinity: 1.0 },
            })
            .catch(() => {}); // ignore dupes
        }
      } catch {
        // Gene already exists (re-install case) — reuse it
        gene = await prisma.iMGene.findUnique({ where: { id: geneId } });
      }
    }

    // 6. Create/update agent-skill record
    const agentSkill = await prisma.iMAgentSkill.upsert({
      where: { agentId_skillId_scope: { agentId, skillId: skill.id, scope } },
      create: { agentId, skillId: skill.id, scope, geneId: gene?.id, version: skill.version, status: 'active' },
      update: { geneId: gene?.id, version: skill.version, status: 'active', updatedAt: new Date() },
    });

    // 7. Increment install count only on first install (not re-activation)
    if (!isReinstall) {
      await prisma.iMSkill.update({ where: { id: skill.id }, data: { installs: { increment: 1 } } });
      // Bump quality score on first install
      bumpSkillOnInstall(skill.id).catch(() => {});
    }

    console.log(
      `${LOG} Installed skill "${skill.slug}" for agent ${agentId.slice(-8)}${gene ? ` (gene: ${gene.id})` : ''}`,
    );
    return { agentSkill, gene, skill, installGuide: this.generateInstallGuide(skill) };
  }

  /**
   * Uninstall a skill for an agent. Marks the agent-skill record as 'uninstalled'.
   */
  async uninstallSkill(agentId: string, skillIdOrSlug: string, scope: string = 'global'): Promise<boolean> {
    const skill = await prisma.iMSkill.findFirst({
      where: { OR: [{ id: skillIdOrSlug }, { slug: skillIdOrSlug }] },
    });
    if (!skill) return false;

    // Find the agent-skill record to get geneId before updating
    const agentSkill = await prisma.iMAgentSkill.findUnique({
      where: { agentId_skillId_scope: { agentId, skillId: skill.id, scope } },
    });
    if (!agentSkill || agentSkill.status !== 'active') return false;

    // Mark as uninstalled
    await prisma.iMAgentSkill.update({
      where: { id: agentSkill.id },
      data: { status: 'uninstalled', updatedAt: new Date() },
    });

    // Quarantine the associated Gene so it's excluded from selectGene()
    if (agentSkill.geneId) {
      await prisma.iMGene
        .updateMany({
          where: { id: agentSkill.geneId, ownerAgentId: agentId },
          data: { visibility: 'quarantined' },
        })
        .catch(() => {});
    }

    // Decay quality score on uninstall
    decaySkillOnUninstall(skill.id).catch(() => {});

    console.log(`${LOG} Uninstalled skill "${skill.slug}" for agent ${agentId.slice(-8)}`);
    return true;
  }

  /**
   * Get all installed (active) skills for an agent, with skill and gene details.
   */
  async getInstalledSkills(agentId: string, scope?: string): Promise<any[]> {
    const where: any = { agentId, status: 'active' };
    if (scope) where.scope = scope;
    const records = await prisma.iMAgentSkill.findMany({
      where,
      orderBy: { installedAt: 'desc' },
    });

    if (records.length === 0) return [];

    // Batch fetch skills and genes
    const skillIds = records.map((r: any) => r.skillId);
    const skills = await prisma.iMSkill.findMany({ where: { id: { in: skillIds } } });
    const skillMap = new Map(skills.map((s: any) => [s.id, s]));

    const geneIds = records.filter((r: any) => r.geneId).map((r: any) => r.geneId!);
    const genes = geneIds.length > 0 ? await prisma.iMGene.findMany({ where: { id: { in: geneIds } } }) : [];
    const geneMap = new Map(genes.map((g: any) => [g.id, g]));

    return records.map((r: any) => ({
      agentSkill: r,
      skill: skillMap.get(r.skillId) || null,
      gene: r.geneId ? geneMap.get(r.geneId) || null : null,
    }));
  }

  /**
   * Get full skill content + package info for download/install.
   */
  async getSkillContent(skillIdOrSlug: string): Promise<any | null> {
    const skill = await prisma.iMSkill.findFirst({
      where: { OR: [{ id: skillIdOrSlug }, { slug: skillIdOrSlug }] },
    });
    if (!skill) return null;

    let files: Array<{ path: string; size: number }>;
    if (skill.fileCount > 1) {
      try {
        const meta = JSON.parse(skill.metadata || '{}');
        files = meta.files || [{ path: 'SKILL.md', size: skill.content.length }];
      } catch {
        files = [{ path: 'SKILL.md', size: skill.content.length }];
      }
    } else {
      files = [{ path: 'SKILL.md', size: skill.content.length }];
    }

    return {
      content: skill.content,
      packageUrl: skill.packageUrl,
      files,
      checksum: skill.packageHash,
    };
  }

  // ═══════════════════════════════════════════════════════════
  /**
   * MySQL FULLTEXT search — uses MATCH AGAINST for indexed text search.
   * Significantly faster than LIKE '%word%' on large tables.
   * Falls back to Prisma contains if FULLTEXT index doesn't exist.
   */
  private async _fulltextSearch(opts: SkillSearchOptions): Promise<{ skills: SkillInfo[]; total: number }> {
    const query = opts.query!.trim();
    // Convert to BOOLEAN MODE query: "timeout retry" → "+timeout* +retry*"
    const booleanQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `+${w}*`)
      .join(' ');

    try {
      const conditions: string[] = ['status = "active"'];
      const params: any[] = [];

      // FULLTEXT match on name+description+tags
      conditions.push(
        '(MATCH(name, description, tags) AGAINST(? IN BOOLEAN MODE) OR MATCH(signals) AGAINST(? IN BOOLEAN MODE))',
      );
      params.push(booleanQuery, booleanQuery);

      if (opts.category) {
        conditions.push('category = ?');
        params.push(opts.category);
      }
      if (opts.source) {
        conditions.push('source = ?');
        params.push(opts.source);
      }
      if (opts.compatibility) {
        conditions.push('compatibility LIKE ?');
        params.push(`%${opts.compatibility}%`);
      }

      const whereClause = conditions.join(' AND ');

      // Relevance score from FULLTEXT
      const relevanceExpr =
        'MATCH(name, description, tags) AGAINST(? IN BOOLEAN MODE) * 2 + MATCH(signals) AGAINST(? IN BOOLEAN MODE)';

      let orderClause: string;
      switch (opts.sort) {
        case 'relevance':
          orderClause = `(${relevanceExpr}) DESC`;
          params.push(booleanQuery, booleanQuery);
          break;
        case 'most_installed':
          orderClause = 'installs DESC';
          break;
        case 'most_starred':
          orderClause = 'stars DESC';
          break;
        case 'name':
          orderClause = 'name ASC';
          break;
        default:
          orderClause = 'createdAt DESC';
          break;
      }

      const offset = (opts.page - 1) * opts.limit;

      const [rows, countResult] = await Promise.all([
        prisma.$queryRawUnsafe(
          `SELECT id, slug, name, description, category, tags, author, source, sourceUrl, installs, stars, status, geneId, signals, createdAt, updatedAt FROM im_skills WHERE ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`,
          ...params,
          opts.limit,
          offset,
        ) as Promise<any[]>,
        prisma.$queryRawUnsafe(
          `SELECT COUNT(*) as cnt FROM im_skills WHERE ${whereClause}`,
          ...params.filter((_, i) => i < conditions.length), // exclude relevance params
        ) as Promise<any[]>,
      ]);

      return {
        skills: rows.map((s: any) => ({ ...s, tags: this.parseTags(s.tags) })),
        total: Number(countResult[0]?.cnt || 0),
      };
    } catch (err) {
      // FULLTEXT index doesn't exist or query failed — fall back to Prisma LIKE search
      console.warn(`${LOG} FULLTEXT search failed, falling back to LIKE:`, (err as Error).message);
      return this.search({ ...opts, _skipFulltext: true } as any);
    }
  }

  // Helpers
  // ═══════════════════════════════════════════════════════════

  private toSlug(name: string, source: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 180);
    // Add source prefix to avoid cross-source slug collision
    return `${source.split(':')[0].slice(0, 10)}-${base}`;
  }

  private parseTags(tagsJson: string): string[] {
    try {
      const parsed = JSON.parse(tagsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private toDetail(record: {
    id: string;
    slug: string;
    name: string;
    description: string;
    category: string;
    tags: string;
    author: string;
    source: string;
    sourceUrl: string;
    sourceId: string;
    content: string;
    installs: number;
    stars: number;
    status: string;
    geneId: string | null;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
  }): SkillDetail {
    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      description: record.description,
      category: record.category,
      tags: this.parseTags(record.tags),
      author: record.author,
      source: record.source,
      sourceUrl: record.sourceUrl,
      sourceId: record.sourceId,
      content: record.content,
      installs: record.installs,
      stars: record.stars,
      status: record.status,
      geneId: record.geneId,
      metadata: JSON.parse(record.metadata || '{}'),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Parse skill metadata from JSON metadata field and SKILL.md frontmatter (YAML).
   * Uses the `yaml` library for robust frontmatter parsing.
   */
  private parseSkillMetadata(skill: any): {
    strategy: string[];
    preconditions: string[];
    constraints: Record<string, any>;
    category: string | null;
  } {
    // 1. Try JSON metadata field first
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(skill.metadata || '{}');
    } catch {
      /* empty */
    }

    const prismerMeta = meta?.prismer || {};
    let strategy: string[] = prismerMeta?.gene?.strategy || [];
    let preconditions: string[] = prismerMeta?.gene?.preconditions || [];
    let constraints: Record<string, any> = prismerMeta?.gene?.constraints || {};
    let category: string | null = prismerMeta?.category || null;

    // 2. Fallback: parse SKILL.md frontmatter with yaml library
    if (strategy.length === 0 && skill.content && skill.content.startsWith('---')) {
      const endIdx = skill.content.indexOf('---', 3);
      if (endIdx > 0) {
        try {
          const frontmatter = yaml.parse(skill.content.slice(3, endIdx));
          const fm = frontmatter?.metadata?.prismer || frontmatter?.metadata?.openclaw || {};
          const gene = fm?.gene || {};
          if (Array.isArray(gene.strategy)) strategy = gene.strategy;
          if (Array.isArray(gene.preconditions)) preconditions = gene.preconditions;
          if (gene.constraints && typeof gene.constraints === 'object') constraints = gene.constraints;
          if (fm.category) category = fm.category;
        } catch {
          /* malformed YAML — skip */
        }
      }
    }

    return { strategy, preconditions, constraints, category };
  }

  /**
   * Generate install guide for a skill across supported platforms.
   */
  private generateInstallGuide(skill: any): Record<string, any> {
    const slug = skill.slug;
    return {
      claude_code: {
        auto: 'Gene loaded via MCP evolution tools — no manual setup needed',
        manual: `Save SKILL.md to ~/.claude/skills/${slug}/SKILL.md`,
        mcp: `Use MCP tool: skill_install("${slug}")`,
      },
      opencode: {
        auto: 'Gene loaded via plugin event hooks',
        manual: `Save to ~/.config/opencode/skills/${slug}/SKILL.md`,
      },
      openclaw: {
        command: `openclaw plugins install @prismer/${slug}`,
      },
      sdk: {
        typescript: `client.im.skills.install('${slug}')`,
        python: `client.im.skills.install('${slug}')`,
        go: `client.IM().Skills.Install(ctx, "${slug}")`,
        cli: `prismer skill install ${slug}`,
      },
    };
  }
}

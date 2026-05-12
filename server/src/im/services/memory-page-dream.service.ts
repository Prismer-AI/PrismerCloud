/**
 * Memory page Dream — three invariants for IMMemoryPage (M-C, doc 25 §3 支柱 3).
 *
 * The existing `memory-dream.ts` operates on `im_memory_files` (the agent
 * memory file abstraction). This service is the parallel for
 * `im_memory_pages` (the IMMemoryPage abstraction used by the Library
 * Memory view + ingest pipeline).
 *
 * Three responsibilities, each runnable independently:
 *
 *   1. **Top-INDEX size invariant** — count the workspace's top-level
 *      hub/index pages. When the count exceeds `TOP_INDEX_THRESHOLD`,
 *      identify clusters that should be merged into `index-subarea`
 *      pages so the top INDEX stays navigable. v0 records the cluster
 *      candidates; LLM-driven merge writes are TODO (return value
 *      `clusterCandidates`).
 *
 *   2. **Garbage page pruning** — pages older than 90 days with no
 *      observability events (no `recall_pull`/`recall_inject`/`recall_preload`
 *      hits) AND no inbound links → mark stale + emit a proposal so the
 *      user can confirm deletion in the Library Memory view. Idempotent:
 *      already-stale pages skipped.
 *
 *   3. **Frontier materialization** — find clusters of N+ pages on the
 *      same `sourceRef` / `pageType` that collectively received `>= K`
 *      `recall_pull` events. v0 emits a "candidate hub" observability
 *      event for the user to act on; LLM-driven hub generation
 *      (LazyGraphRAG) is post-MVP. The candidate emission is what the
 *      daemon scheduler relies on to know there is "something worth
 *      doing" beyond the maintenance pass.
 *
 * Caller is the daemon dream scheduler (cloud-side endpoint `POST
 * /api/im/memory/page-dream`). All three invariants run inside one
 * transaction-bounded call so the daemon scheduler sees a single
 * progress receipt per workspace tick.
 *
 * Out of scope for v0:
 *   - LLM-driven actual hub-page authoring (frontier materialization
 *     stops at "candidate identified")
 *   - LLM-driven cluster-merge into index-subarea (top-INDEX invariant
 *     stops at "clusters identified")
 *   - Cross-workspace dedup (intra-workspace only)
 */

import prisma from '../db';

const LOG = '[MemoryPageDream]';

/**
 * When the count of top-level (parent-less) hub/index pages exceeds
 * this threshold, the top INDEX page becomes too long to skim. The
 * scheduler triggers cluster identification.
 */
export const TOP_INDEX_THRESHOLD = 200;

/** Garbage pruning age cutoff. Pages older than this with no inbound
 *  link and no recent observability hit are candidates for stale-mark. */
export const GARBAGE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Frontier materialization signals: cluster of N+ pages with K+ recalls. */
export const FRONTIER_MIN_PAGES = 5;
export const FRONTIER_MIN_RECALLS = 3;

/** How long a generated proposal is open for review before it expires. */
const PROPOSAL_EXPIRES_DAYS = 14;

export interface TopIndexInvariantResult {
  /** Total top-level hub/index page count for the workspace. */
  topIndexCount: number;
  /** True when count exceeds TOP_INDEX_THRESHOLD. */
  breached: boolean;
  /** Page-id clusters proposed for index-subarea consolidation. v0
   *  groups by (pageType, sourceKind) — proper LLM clustering is TODO. */
  clusterCandidates: Array<{
    key: string;
    pageType: string;
    sourceKind: string | null;
    pageIds: string[];
  }>;
}

export interface GarbagePruneResult {
  /** Number of pages newly marked stale. */
  markedStale: number;
  /** Number of stale-marker proposals written (one per page). */
  proposalsWritten: number;
  /** Page IDs touched, for tracing. */
  pageIds: string[];
}

export interface FrontierMaterializeResult {
  /** Cluster candidates identified — daemon emits an observability event
   *  per candidate. */
  candidates: Array<{
    sourceRef: string | null;
    pageType: string;
    pageCount: number;
    totalRecallPulls: number;
    pageIds: string[];
  }>;
}

export interface PageDreamResult {
  topIndex: TopIndexInvariantResult;
  garbage: GarbagePruneResult;
  frontier: FrontierMaterializeResult;
  durationMs: number;
}

/**
 * Run all three invariants for a workspace. Used by the daemon
 * scheduler. Each invariant runs independently — a failure in one
 * does not abort the others.
 */
export async function runPageDream(workspaceId: string, sessionAgentId?: string | null): Promise<PageDreamResult> {
  const startedAt = Date.now();
  const [topIndex, garbage, frontier] = await Promise.all([
    enforceTopIndexInvariant(workspaceId).catch((err) => {
      console.warn(`${LOG} topIndex failed for ws=${workspaceId}: ${err.message}`);
      return { topIndexCount: -1, breached: false, clusterCandidates: [] } as TopIndexInvariantResult;
    }),
    pruneGarbagePages(workspaceId, sessionAgentId ?? null).catch((err) => {
      console.warn(`${LOG} garbage prune failed for ws=${workspaceId}: ${err.message}`);
      return { markedStale: 0, proposalsWritten: 0, pageIds: [] } as GarbagePruneResult;
    }),
    findFrontierCandidates(workspaceId).catch((err) => {
      console.warn(`${LOG} frontier failed for ws=${workspaceId}: ${err.message}`);
      return { candidates: [] } as FrontierMaterializeResult;
    }),
  ]);
  return { topIndex, garbage, frontier, durationMs: Date.now() - startedAt };
}

/**
 * Top-INDEX size invariant.
 *
 * Counts top-level hub/index pages. When > TOP_INDEX_THRESHOLD, groups
 * pages by `(pageType, sourceKind)` and proposes each group as an
 * `index-subarea` candidate. The daemon scheduler emits a
 * `meta_change(top_index_breached)` observability event when this
 * fires, and the user (or a future LLM-driven dream pass) decides what
 * to do with the clusters.
 */
export async function enforceTopIndexInvariant(workspaceId: string): Promise<TopIndexInvariantResult> {
  // Count top-level hub/index pages (parentPageId IS NULL is the
  // canonical "top-level" marker per doc 25 §3 支柱 3).
  // Note: parentPageId column doesn't exist yet on IMMemoryPage in this
  // schema — phase-1 spec puts it on the model but the column hasn't
  // been added. Until it is, treat all hub/index pages with no
  // sourceAssetId as "top-level" (assets imply derivation, not curation).
  const topPages = await prisma.iMMemoryPage.findMany({
    where: {
      workspaceId,
      pageType: { in: ['hub', 'index'] },
      sourceAssetId: null,
      deletedAt: null,
      archivedAt: null,
      stale: false,
    },
    select: { id: true, path: true, pageType: true, sourceKind: true },
  });
  const topIndexCount = topPages.length;
  const breached = topIndexCount > TOP_INDEX_THRESHOLD;
  if (!breached) {
    return { topIndexCount, breached, clusterCandidates: [] };
  }
  // Cheap clustering for v0: group by (pageType, sourceKind). Future:
  // LLM clusters by topic similarity using descriptions.
  const groups = new Map<string, { pageType: string; sourceKind: string | null; pageIds: string[] }>();
  for (const p of topPages as Array<{ id: string; pageType: string; sourceKind: string | null }>) {
    const key = `${p.pageType}::${p.sourceKind ?? 'none'}`;
    const g = groups.get(key) ?? { pageType: p.pageType, sourceKind: p.sourceKind, pageIds: [] as string[] };
    g.pageIds.push(p.id);
    groups.set(key, g);
  }
  // Only return clusters with ≥3 members — singletons aren't worth a
  // sub-area page.
  const clusterCandidates = [...groups.entries()]
    .map(([key, g]) => ({ key, ...g }))
    .filter((g) => g.pageIds.length >= 3);
  return { topIndexCount, breached, clusterCandidates };
}

/**
 * Garbage page pruning.
 *
 * "Garbage" = a page is older than `GARBAGE_AGE_MS`, has no observability
 * events in the recent window (no recall_pull / recall_inject /
 * recall_preload hits), and has no inbound `IMMemoryLink`. Such a page
 * is unlikely to ever be referenced again. Mark it stale and write a
 * proposal so the user can confirm deletion in the Library Memory view.
 *
 * Idempotent: pages that are already `stale` are skipped (otherwise the
 * cron would re-emit a fresh proposal every 24h).
 */
export async function pruneGarbagePages(
  workspaceId: string,
  sessionAgentId: string | null,
): Promise<GarbagePruneResult> {
  const cutoff = new Date(Date.now() - GARBAGE_AGE_MS);

  // Candidates: old, not stale, not deleted, not archived, NOT INDEX.md
  // (top-INDEX gets its own invariant), and lacking any inbound links.
  // The "no inbound links" filter must be a sub-query because Prisma
  // doesn't support NOT EXISTS on relations; emulate with raw count.
  const candidates = await prisma.iMMemoryPage.findMany({
    where: {
      workspaceId,
      stale: false,
      deletedAt: null,
      archivedAt: null,
      updatedAt: { lt: cutoff },
      path: { not: 'INDEX.md' },
    },
    select: { id: true, path: true, updatedAt: true },
  });
  if (candidates.length === 0) {
    return { markedStale: 0, proposalsWritten: 0, pageIds: [] };
  }

  // Filter by "no inbound links" + "no recent observability hit".
  type CandRow = { id: string; path: string; updatedAt: Date };
  const candidateIds = (candidates as CandRow[]).map((c) => c.id);
  const inboundCounts = await prisma.iMMemoryLink.groupBy({
    by: ['targetPageId'],
    where: { workspaceId, targetPageId: { in: candidateIds }, broken: false },
    _count: { _all: true },
  });
  const inboundSet = new Set(
    (inboundCounts as Array<{ targetPageId: string | null }>)
      .map((c) => c.targetPageId)
      .filter((id): id is string => id !== null),
  );

  // "Recent" = since cutoff. A pull within the last 90 days keeps the
  // page out of the garbage bucket.
  const recentObservability = await prisma.iMMemoryObservabilityEvent.findMany({
    where: {
      workspaceId,
      pageId: { in: candidateIds },
      createdAt: { gte: cutoff },
      eventType: { in: ['recall_pull', 'recall_inject', 'recall_preload'] },
    },
    select: { pageId: true },
    distinct: ['pageId'],
  });
  const recentSet = new Set(
    (recentObservability as Array<{ pageId: string | null }>)
      .map((e) => e.pageId)
      .filter((id): id is string => id !== null),
  );

  const toPrune = (candidates as CandRow[]).filter((c) => !inboundSet.has(c.id) && !recentSet.has(c.id));
  if (toPrune.length === 0) {
    return { markedStale: 0, proposalsWritten: 0, pageIds: [] };
  }

  const pruneIds = toPrune.map((p) => p.id);
  const expiresAt = new Date(Date.now() + PROPOSAL_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  // Mark stale + write proposals in a single transaction. Proposal
  // operation = 'delete'; baseVersion = current version so an out-of-band
  // edit cancels the proposal.
  let proposalsWritten = 0;
  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.iMMemoryPage.updateMany({
      where: { id: { in: pruneIds } },
      data: { stale: true, staleReason: 'garbage_pruned_no_inbound_no_recent_recall' },
    });
    for (const p of toPrune) {
      // Need version + path for the proposal.
      const fresh = await tx.iMMemoryPage.findUnique({
        where: { id: p.id },
        select: { path: true, version: true, sourceRef: true },
      });
      if (!fresh) continue;
      await tx.iMMemoryProposal.create({
        data: {
          workspaceId,
          proposingAgentId: sessionAgentId ?? '__dream__',
          status: 'pending',
          pagePath: fresh.path,
          baseVersion: fresh.version,
          operation: 'delete',
          contentDiff: '',
          rationale: `Page has been idle for ${Math.round((Date.now() - p.updatedAt.getTime()) / (24 * 60 * 60 * 1000))} days with no inbound links and no recent recall hits. Memory Dream proposes deletion.`,
          confidence: 0.6,
          sourceRefs: JSON.stringify([fresh.sourceRef ?? 'memory_dream:garbage_prune']),
          expiresAt,
        },
      });
      proposalsWritten++;
    }
  });

  return { markedStale: pruneIds.length, proposalsWritten, pageIds: pruneIds };
}

/**
 * Frontier materialization candidates.
 *
 * Identifies clusters of N+ pages sharing a `sourceRef` (or, lacking
 * sourceRef, a `pageType`) that have collectively received >= K
 * `recall_pull` hits. The daemon scheduler emits a candidate event for
 * each cluster; LLM-driven hub-page authoring is post-MVP.
 *
 * Rationale: when an agent keeps pulling 5+ different pages on the same
 * topic, building a hub page that summarizes the cross-page conclusion
 * (LazyGraphRAG-style) is high-leverage. Detecting the candidate is the
 * cheap part this service does for v0.
 */
export async function findFrontierCandidates(workspaceId: string): Promise<FrontierMaterializeResult> {
  // Doc 25 §3 支柱 3: "N same-topic pages + recall >= K times" — the
  // cluster is the unit of activity, not the individual page. A
  // five-page cluster where one popular page receives all the recalls
  // is still a frontier candidate; the LLM-driven hub generation can
  // pull cross-page conclusions from the colder siblings.
  //
  // Implementation:
  //   1. Find pages that received recent recall_pull events (the "seed
  //      pages") — these tell us which clusters are hot.
  //   2. Pull all live workspace pages on those clusters' sourceRefs.
  //   3. Sum recall_pull counts per cluster (using ALL pages, not just
  //      the seeds — a popular sibling boosts the whole cluster).
  //   4. Threshold against FRONTIER_MIN_PAGES + FRONTIER_MIN_RECALLS.
  //
  // 30-day window for "recent" — older hits don't reflect current
  // usage and the LLM hub-page would be authored from stale signal.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const events = await prisma.iMMemoryObservabilityEvent.findMany({
    where: {
      workspaceId,
      eventType: 'recall_pull',
      pageId: { not: null },
      createdAt: { gte: since },
    },
    select: { pageId: true },
  });
  if (events.length < FRONTIER_MIN_RECALLS) return { candidates: [] };

  const pullsPerPage = new Map<string, number>();
  for (const e of events as Array<{ pageId: string | null }>) {
    if (!e.pageId) continue;
    pullsPerPage.set(e.pageId, (pullsPerPage.get(e.pageId) ?? 0) + 1);
  }

  // Find the sourceRefs touched by recent activity.
  const seedPageIds = [...pullsPerPage.keys()];
  if (seedPageIds.length === 0) return { candidates: [] };

  const seedPages = await prisma.iMMemoryPage.findMany({
    where: {
      id: { in: seedPageIds },
      workspaceId,
      stale: false,
      deletedAt: null,
      archivedAt: null,
    },
    select: { id: true, sourceRef: true, pageType: true },
  });
  type SeedRow = { id: string; sourceRef: string | null; pageType: string };
  const sourceRefs = new Set<string>();
  const pageTypeFallbacks = new Set<string>();
  for (const p of seedPages as SeedRow[]) {
    if (p.sourceRef) sourceRefs.add(p.sourceRef);
    else pageTypeFallbacks.add(p.pageType);
  }

  // Pull all live workspace pages on the touched clusters. We expand
  // beyond seed pages so a hot cluster's quiet siblings count toward
  // the page-count threshold.
  type ClusterPageRow = { id: string; sourceRef: string | null; pageType: string };
  const orFilters: Array<Record<string, unknown>> = [];
  if (sourceRefs.size > 0) orFilters.push({ sourceRef: { in: [...sourceRefs] } });
  if (pageTypeFallbacks.size > 0) {
    orFilters.push({ AND: [{ sourceRef: null }, { pageType: { in: [...pageTypeFallbacks] } }] });
  }
  if (orFilters.length === 0) return { candidates: [] };
  const clusterPages = (await prisma.iMMemoryPage.findMany({
    where: {
      workspaceId,
      stale: false,
      deletedAt: null,
      archivedAt: null,
      OR: orFilters,
    },
    select: { id: true, sourceRef: true, pageType: true },
  })) as ClusterPageRow[];

  // Group by sourceRef when present; fall back to pageType.
  const groups = new Map<string, { sourceRef: string | null; pageType: string; pageIds: string[]; pulls: number }>();
  for (const p of clusterPages) {
    const key = p.sourceRef ?? `pageType:${p.pageType}`;
    const g = groups.get(key) ?? {
      sourceRef: p.sourceRef,
      pageType: p.pageType,
      pageIds: [] as string[],
      pulls: 0,
    };
    g.pageIds.push(p.id);
    g.pulls += pullsPerPage.get(p.id) ?? 0;
    groups.set(key, g);
  }

  const candidates = [...groups.values()]
    .filter((g) => g.pageIds.length >= FRONTIER_MIN_PAGES && g.pulls >= FRONTIER_MIN_RECALLS)
    .map((g) => ({
      sourceRef: g.sourceRef,
      pageType: g.pageType,
      pageCount: g.pageIds.length,
      totalRecallPulls: g.pulls,
      pageIds: g.pageIds,
    }));
  return { candidates };
}

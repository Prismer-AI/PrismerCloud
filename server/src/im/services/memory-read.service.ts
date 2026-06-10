/**
 * Workspace memory read surface (A2 of Memory Line A).
 *
 * All read methods take a `MemoryAclContext` and apply visibility filtering
 * via the helper rather than rolling per-row ownership checks. Health,
 * graph and observability queries live here too — they share enrichment
 * logic (link counts, broken-link reverse lookups) and benefit from a
 * single service surface.
 *
 * Brief reference: doc 23 §8 U0b. Locked response schemas are exported
 * from this file so route handlers cannot drift them.
 */

import prisma from '../db';
import type { MemoryAclContext } from './memory-acl';

/** Locked response schemas (doc 23 §8 U0b). Do not drift without updating cookbook. */

export interface MemoryPageSummary {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  pageType: string;
  version: number;
  stale: boolean;
  archivedAt: string | null;
  visibility: string;
  contentHash: string;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceAssetId: string | null;
  updatedAt: string;
  inboundLinkCount: number;
  outboundLinkCount: number;
  /**
   * Wave 5 F5 — derived scope badge (doc 14 §3.0.2 F-①). `MemoryPage` rows
   * carry only `visibility`, not the agent-scope column from `im_memory_files`
   * (E6). To surface the same 🔓 / 🔒 affordance in the Library UI, scope
   * is computed here from visibility:
   *   - `'workspace'` (default) → `'workspace-shared'` (🔓 all agents RW)
   *   - any narrower `task:*` / `human:*` / `secret-ref` → `'agent-private'`
   *     (🔒 owner-scoped)
   * Legacy rows with null visibility get `'workspace-shared'`.
   */
  scope: 'workspace-shared' | 'agent-private';
}

export interface MemoryPageDetail extends MemoryPageSummary {
  /**
   * Markdown body. Always present unless `format='html'` filtered it out.
   * Null when the GET filter dropped it; never null in storage (the model
   * has it as required).
   */
  content: string | null;
  /**
   * HTML body. M-D (doc 25 §4): an INDEPENDENT source from `content`.
   * Null when the page never received an HTML write and the backfill
   * cron has not derived one yet, OR when `format='markdown'` filtered
   * it out.
   */
  contentHtml: string | null;
  /**
   * 0 = user / agent-authored HTML (independent — backfill cron skips);
   * >=1 = backfill-derived at markdown-render pipeline version N;
   * null = no HTML version.
   */
  contentHtmlVersion: number | null;
  provenance: unknown[];
}

/** GET /memory/pages/:id?format=… body shape. */
export type MemoryPageReadFormat = 'markdown' | 'html' | 'both';

export interface MemoryLinkRow {
  id: string;
  sourcePageId: string;
  targetPageId: string | null;
  sourceUri: string;
  targetUri: string;
  relation: string;
  weight: number;
  broken: boolean;
  extractedFromVersion: number | null;
  updatedAt: string;
}

export interface KnowledgeLinkRow {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  linkType: string;
  strength: number;
  createdAt: string;
}

export interface MemoryPageVersionRow {
  id: string;
  pageId: string;
  version: number;
  parentVersion: number | null;
  changeSummary: string | null;
  contentHash: string;
  payloadJson: unknown;
  sourceKind: string | null;
  sourceRef: string | null;
  encrypted: boolean;
  createdByImUserId: string;
  createdAt: string;
}

export interface HealthItem {
  pageId: string;
  path: string;
  pageType: string;
  reason: string;
  detectedAt: string;
  metadata?: Record<string, unknown>;
}

export interface HealthListResponse {
  items: HealthItem[];
  total: number;
}

export interface GraphNode {
  pageId: string;
  path: string;
  title: string | null;
  pageType: string;
  visibility: string;
  stale: boolean;
  inboundCount: number;
}

export interface GraphEdge {
  sourcePageId: string;
  targetPageId: string;
  relation: string;
  broken: boolean;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: { totalNodes: number; shownNodes: number; totalEdges: number };
}

export interface RecallEvent {
  id: string;
  eventType: 'recall_preload' | 'recall_inject' | 'recall_pull' | 'recall_reject' | 'feedback';
  actorImUserId: string;
  actorKind: 'agent' | 'user';
  pageId: string | null;
  query: string | null;
  metricsJson: { tokenCount?: number; relevanceScore?: number; topK?: number } | null;
  metadataJson: { sessionId?: string; conversationId?: string; toolName?: string } | null;
  createdAt: string;
}

export interface RecallTraceResponse {
  events: RecallEvent[];
  cursor: string | null;
}

const RECALL_EVENT_TYPES = new Set(['recall_preload', 'recall_inject', 'recall_pull', 'recall_reject', 'feedback']);

const HEALTH_DEFAULT_LIMIT = 100;
const HEALTH_MAX_LIMIT = 500;
const GRAPH_DEFAULT_DEPTH = 2;
const GRAPH_MAX_DEPTH = 4;
const GRAPH_NODE_CAP = 200;
const RECALL_DEFAULT_LIMIT = 100;
const RECALL_MAX_LIMIT = 500;

function clampLimit(raw: number | undefined, def: number, max: number): number {
  if (!raw || raw <= 0) return def;
  return Math.min(Math.floor(raw), max);
}

function toIso(d: Date): string {
  return d.toISOString();
}

function parseJson<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function visibilityWhere(acl: MemoryAclContext) {
  const exact = acl.allowedVisibilities;
  const prefixes = acl.allowedVisibilityPrefixes;
  if (prefixes.length === 0) return { visibility: { in: exact } };
  return {
    OR: [{ visibility: { in: exact } }, ...prefixes.map((p) => ({ visibility: { startsWith: p } }))],
  };
}

interface PageRow {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  pageType: string;
  version: number;
  stale: boolean;
  archivedAt: Date | null;
  visibility: string;
  contentHash: string;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceAssetId: string | null;
  updatedAt: Date;
}

async function enrichSummaries(rows: PageRow[]): Promise<MemoryPageSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [outbound, inbound] = await Promise.all([
    prisma.iMMemoryLink.groupBy({
      by: ['sourcePageId'],
      where: { sourcePageId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.iMMemoryLink.groupBy({
      by: ['targetPageId'],
      where: { targetPageId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const outboundMap = new Map<string, number>();
  for (const row of outbound) outboundMap.set(row.sourcePageId, row._count._all);
  const inboundMap = new Map<string, number>();
  for (const row of inbound) {
    if (row.targetPageId) inboundMap.set(row.targetPageId, row._count._all);
  }

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    path: r.path,
    title: r.title,
    pageType: r.pageType,
    version: r.version,
    stale: r.stale,
    archivedAt: r.archivedAt ? toIso(r.archivedAt) : null,
    visibility: r.visibility,
    contentHash: r.contentHash,
    sourceRef: r.sourceRef,
    sourceKind: r.sourceKind,
    sourceAssetId: r.sourceAssetId,
    updatedAt: toIso(r.updatedAt),
    inboundLinkCount: inboundMap.get(r.id) ?? 0,
    outboundLinkCount: outboundMap.get(r.id) ?? 0,
    scope: deriveScopeFromVisibility(r.visibility),
  }));
}

/**
 * Wave 5 F5 — derive the binary scope badge from the `visibility` column.
 * Returns `'workspace-shared'` for the default `'workspace'` (and any null /
 * legacy value), `'agent-private'` for every narrower variant. Kept as a
 * pure helper so the same rule can be reused on `readPage` detail mapping
 * + future memory write paths.
 */
export function deriveScopeFromVisibility(visibility: string | null | undefined): 'workspace-shared' | 'agent-private' {
  if (!visibility || visibility === 'workspace') return 'workspace-shared';
  return 'agent-private';
}

export class MemoryReadService {
  /** GET /memory/pages — workspace-scoped list with visibility filter. */
  async listPages(
    acl: MemoryAclContext,
    input: { sourceAssetId?: string | null; sourceRef?: string | null; limit?: number; includeArchived?: boolean },
  ): Promise<MemoryPageSummary[]> {
    const rows = await prisma.iMMemoryPage.findMany({
      where: {
        workspaceId: acl.workspaceId,
        deletedAt: null,
        ...(input.includeArchived ? {} : { archivedAt: null }),
        ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...visibilityWhere(acl),
      },
      orderBy: { updatedAt: 'desc' },
      take: clampLimit(input.limit, 100, 200),
    });
    return enrichSummaries(rows);
  }

  /** GET /memory/pages/by-source — by sourceAssetId or sourceRef. Brief A2 surface. */
  async listBySource(
    acl: MemoryAclContext,
    input: { sourceAssetId?: string | null; sourceRef?: string | null; limit?: number },
  ): Promise<MemoryPageSummary[]> {
    if (!input.sourceAssetId && !input.sourceRef) return [];
    return this.listPages(acl, { ...input, includeArchived: true });
  }

  async readPage(
    acl: MemoryAclContext,
    id: string,
    opts?: { format?: MemoryPageReadFormat },
  ): Promise<MemoryPageDetail | null> {
    const row = await prisma.iMMemoryPage.findFirst({
      where: { id, workspaceId: acl.workspaceId, deletedAt: null },
    });
    if (!row) return null;
    if (!acl.canRead({ visibility: row.visibility })) return null;
    const [summary] = await enrichSummaries([row]);
    // M-D: client picks the body field(s) it needs. Default ('both')
    // returns markdown + HTML so existing callers get backwards-compatible
    // payloads (markdown still required, HTML added). 'markdown' / 'html'
    // narrow the response for size or content-type-specific renderers.
    const format = opts?.format ?? 'both';
    const includeMarkdown = format !== 'html';
    const includeHtml = format !== 'markdown';
    return {
      ...summary,
      content: includeMarkdown ? row.content : null,
      contentHtml: includeHtml ? (row.contentHtml ?? null) : null,
      contentHtmlVersion: includeHtml ? (row.contentHtmlVersion ?? null) : null,
      provenance: parseJson<unknown[]>(row.provenanceJson) ?? [],
    };
  }

  /** GET /memory/pages/:id/links — outbound + backlinks + knowledge graph crossrefs. */
  async getPageLinks(
    acl: MemoryAclContext,
    pageId: string,
  ): Promise<{ outbound: MemoryLinkRow[]; backlinks: MemoryLinkRow[]; knowledge: KnowledgeLinkRow[] } | null> {
    const page = await prisma.iMMemoryPage.findFirst({
      where: { id: pageId, workspaceId: acl.workspaceId, deletedAt: null },
      select: { id: true, visibility: true },
    });
    if (!page || !acl.canRead({ visibility: page.visibility })) return null;

    const [outboundRows, backlinkRows, knowledgeRows] = await Promise.all([
      prisma.iMMemoryLink.findMany({
        where: { workspaceId: acl.workspaceId, sourcePageId: pageId },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.iMMemoryLink.findMany({
        where: { workspaceId: acl.workspaceId, targetPageId: pageId },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.iMKnowledgeLink.findMany({
        where: {
          workspaceId: acl.workspaceId,
          OR: [
            { sourceType: 'memory_page', sourceId: pageId },
            { targetType: 'memory_page', targetId: pageId },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      outbound: outboundRows.map(toLinkRow),
      backlinks: backlinkRows.map(toLinkRow),
      knowledge: knowledgeRows.map(toKnowledgeRow),
    };
  }

  /** GET /memory/pages/:id/versions */
  async listVersions(acl: MemoryAclContext, pageId: string): Promise<MemoryPageVersionRow[] | null> {
    const page = await prisma.iMMemoryPage.findFirst({
      where: { id: pageId, workspaceId: acl.workspaceId, deletedAt: null },
      select: { visibility: true },
    });
    if (!page || !acl.canRead({ visibility: page.visibility })) return null;

    const rows = await prisma.iMMemoryPageVersion.findMany({
      where: { workspaceId: acl.workspaceId, pageId },
      orderBy: { version: 'desc' },
    });
    return rows.map((r: (typeof rows)[number]) => ({
      id: r.id,
      pageId: r.pageId,
      version: r.version,
      parentVersion: r.parentVersion,
      changeSummary: r.changeSummary,
      contentHash: r.contentHash,
      payloadJson: parseJson(r.payloadJson),
      sourceKind: r.sourceKind,
      sourceRef: r.sourceRef,
      encrypted: r.encrypted,
      createdByImUserId: r.createdByImUserId,
      createdAt: toIso(r.createdAt),
    }));
  }

  /** GET /memory/health/broken-links */
  async healthBrokenLinks(acl: MemoryAclContext, limit?: number): Promise<HealthListResponse> {
    const max = clampLimit(limit, HEALTH_DEFAULT_LIMIT, HEALTH_MAX_LIMIT);
    type LinkRow = {
      id: string;
      sourcePageId: string;
      targetUri: string;
      relation: string;
      updatedAt: Date;
    };
    type SourceRow = {
      id: string;
      path: string;
      pageType: string;
      visibility: string;
      updatedAt: Date;
    };

    const links: LinkRow[] = await prisma.iMMemoryLink.findMany({
      where: { workspaceId: acl.workspaceId, broken: true },
      orderBy: { updatedAt: 'desc' },
      take: max,
      select: { id: true, sourcePageId: true, targetUri: true, relation: true, updatedAt: true },
    });
    if (links.length === 0) return { items: [], total: 0 };
    const sourceIds = Array.from(new Set(links.map((l: LinkRow) => l.sourcePageId)));
    const sources: SourceRow[] = await prisma.iMMemoryPage.findMany({
      where: { workspaceId: acl.workspaceId, id: { in: sourceIds }, deletedAt: null },
      select: { id: true, path: true, pageType: true, visibility: true, updatedAt: true },
    });
    const visibleIds = new Set(
      sources.filter((s: SourceRow) => acl.canRead({ visibility: s.visibility })).map((s: SourceRow) => s.id),
    );
    const sourceMap = new Map<string, SourceRow>(sources.map((s: SourceRow) => [s.id, s] as const));
    const items: HealthItem[] = links
      .filter((l: LinkRow) => visibleIds.has(l.sourcePageId))
      .map((l: LinkRow) => {
        const src = sourceMap.get(l.sourcePageId)!;
        return {
          pageId: l.sourcePageId,
          path: src.path,
          pageType: src.pageType,
          reason: `broken_link:${l.targetUri}`,
          detectedAt: toIso(l.updatedAt),
          metadata: { linkId: l.id, relation: l.relation, targetUri: l.targetUri },
        };
      });
    return { items, total: items.length };
  }

  /** GET /memory/health/stale */
  async healthStale(acl: MemoryAclContext, limit?: number): Promise<HealthListResponse> {
    const max = clampLimit(limit, HEALTH_DEFAULT_LIMIT, HEALTH_MAX_LIMIT);
    const rows = await prisma.iMMemoryPage.findMany({
      where: {
        workspaceId: acl.workspaceId,
        stale: true,
        archivedAt: null,
        ...visibilityWhere(acl),
      },
      orderBy: { updatedAt: 'desc' },
      take: max,
      select: {
        id: true,
        path: true,
        pageType: true,
        staleReason: true,
        sourceRef: true,
        sourceAssetId: true,
        updatedAt: true,
      },
    });
    type StaleRow = {
      id: string;
      path: string;
      pageType: string;
      staleReason: string | null;
      sourceRef: string | null;
      sourceAssetId: string | null;
      updatedAt: Date;
    };
    return {
      items: (rows as StaleRow[]).map((r) => ({
        pageId: r.id,
        path: r.path,
        pageType: r.pageType,
        reason: 'stale_source',
        detectedAt: toIso(r.updatedAt),
        metadata: { staleReason: r.staleReason, sourceRef: r.sourceRef, sourceAssetId: r.sourceAssetId },
      })),
      total: rows.length,
    };
  }

  /** GET /memory/health/duplicates — group by (pageType, contentHash). */
  async healthDuplicates(acl: MemoryAclContext, limit?: number): Promise<HealthListResponse> {
    const max = clampLimit(limit, HEALTH_DEFAULT_LIMIT, HEALTH_MAX_LIMIT);
    type RawGroup = { pageType: string; contentHash: string; _count: { _all: number } };
    const allGroups: RawGroup[] = await prisma.iMMemoryPage.groupBy({
      by: ['pageType', 'contentHash'],
      where: {
        workspaceId: acl.workspaceId,
        archivedAt: null,
        deletedAt: null,
        ...visibilityWhere(acl),
      },
      _count: { _all: true },
    });
    const groups = allGroups.filter((g: RawGroup) => g._count._all > 1).slice(0, max);
    if (groups.length === 0) return { items: [], total: 0 };

    type DupPage = {
      id: string;
      path: string;
      pageType: string;
      updatedAt: Date;
      visibility: string;
    };
    type Group = { pageType: string; contentHash: string };
    const items: HealthItem[] = [];
    for (const g of groups as Group[]) {
      const pages: DupPage[] = await prisma.iMMemoryPage.findMany({
        where: {
          workspaceId: acl.workspaceId,
          pageType: g.pageType,
          contentHash: g.contentHash,
          archivedAt: null,
          ...visibilityWhere(acl),
        },
        select: { id: true, path: true, pageType: true, updatedAt: true, visibility: true },
        orderBy: { updatedAt: 'asc' },
      });
      const visible = pages.filter((p: DupPage) => acl.canRead({ visibility: p.visibility }));
      if (visible.length < 2) continue;
      const peers = visible.map((p: DupPage) => p.id);
      for (const p of visible) {
        items.push({
          pageId: p.id,
          path: p.path,
          pageType: p.pageType,
          reason: `duplicate_cluster:${peers.filter((id: string) => id !== p.id).join(',')}`,
          detectedAt: toIso(p.updatedAt),
          metadata: { contentHash: g.contentHash, clusterSize: visible.length },
        });
      }
    }
    return { items, total: items.length };
  }

  /**
   * GET /memory/health/orphans — pages with no inbound IMMemoryLink and not
   * cited by any INDEX-named page (top-level INDEX.md or INDEX/<topic>.md).
   */
  async healthOrphans(acl: MemoryAclContext, limit?: number): Promise<HealthListResponse> {
    const max = clampLimit(limit, HEALTH_DEFAULT_LIMIT, HEALTH_MAX_LIMIT);

    type Candidate = {
      id: string;
      path: string;
      pageType: string;
      visibility: string;
      updatedAt: Date;
    };
    type InboundLink = { targetPageId: string | null; sourcePageId: string };

    const candidates: Candidate[] = await prisma.iMMemoryPage.findMany({
      where: {
        workspaceId: acl.workspaceId,
        archivedAt: null,
        deletedAt: null,
        ...visibilityWhere(acl),
      },
      select: { id: true, path: true, pageType: true, visibility: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000, // upper sweep bound for orphan scan
    });
    if (candidates.length === 0) return { items: [], total: 0 };
    const candidateIds = candidates.map((c: Candidate) => c.id);

    const inbound: InboundLink[] = await prisma.iMMemoryLink.findMany({
      where: {
        workspaceId: acl.workspaceId,
        targetPageId: { in: candidateIds },
        broken: false,
      },
      select: { targetPageId: true, sourcePageId: true },
    });
    const inboundFromMap = new Map<string, Set<string>>();
    for (const link of inbound) {
      if (!link.targetPageId) continue;
      let sources = inboundFromMap.get(link.targetPageId);
      if (!sources) {
        sources = new Set<string>();
        inboundFromMap.set(link.targetPageId, sources);
      }
      sources.add(link.sourcePageId);
    }

    const items: HealthItem[] = [];
    for (const p of candidates) {
      if (items.length >= max) break;
      const sources = inboundFromMap.get(p.id);
      // brief: orphan = no inbound link AT ALL (inbound from INDEX still counts as cited).
      if (sources && sources.size > 0) continue;
      items.push({
        pageId: p.id,
        path: p.path,
        pageType: p.pageType,
        reason: 'orphan',
        detectedAt: toIso(p.updatedAt),
      });
    }
    return { items, total: items.length };
  }

  /**
   * GET /memory/graph — BFS expansion from rootId up to depth (default 2).
   * Caps node count at GRAPH_NODE_CAP; truncated counts reported on response.
   */
  async graph(acl: MemoryAclContext, rootId: string, depth?: number): Promise<GraphResponse | null> {
    const root = await prisma.iMMemoryPage.findFirst({
      where: { id: rootId, workspaceId: acl.workspaceId, archivedAt: null, deletedAt: null },
      select: { id: true, visibility: true },
    });
    if (!root || !acl.canRead({ visibility: root.visibility })) return null;

    const maxDepth = Math.min(Math.max(depth ?? GRAPH_DEFAULT_DEPTH, 1), GRAPH_MAX_DEPTH);
    const visited = new Set<string>([rootId]);
    let frontier = new Set<string>([rootId]);
    const allEdges: { sourcePageId: string; targetPageId: string; relation: string; broken: boolean }[] = [];

    for (let d = 0; d < maxDepth && frontier.size > 0; d++) {
      const links = await prisma.iMMemoryLink.findMany({
        where: {
          workspaceId: acl.workspaceId,
          OR: [{ sourcePageId: { in: [...frontier] } }, { targetPageId: { in: [...frontier] } }],
        },
      });
      const next = new Set<string>();
      for (const l of links) {
        if (!l.targetPageId) continue;
        allEdges.push({
          sourcePageId: l.sourcePageId,
          targetPageId: l.targetPageId,
          relation: l.relation,
          broken: l.broken,
        });
        if (!visited.has(l.sourcePageId)) {
          next.add(l.sourcePageId);
          visited.add(l.sourcePageId);
        }
        if (!visited.has(l.targetPageId)) {
          next.add(l.targetPageId);
          visited.add(l.targetPageId);
        }
      }
      frontier = next;
    }

    const nodeIds = [...visited];
    const totalNodes = nodeIds.length;
    const cappedIds = nodeIds.slice(0, GRAPH_NODE_CAP);
    const cappedSet = new Set(cappedIds);

    type GraphPageRow = {
      id: string;
      path: string;
      title: string | null;
      pageType: string;
      visibility: string;
      stale: boolean;
    };
    const pages: GraphPageRow[] = await prisma.iMMemoryPage.findMany({
      where: { workspaceId: acl.workspaceId, id: { in: cappedIds }, deletedAt: null },
      select: {
        id: true,
        path: true,
        title: true,
        pageType: true,
        visibility: true,
        stale: true,
      },
    });
    const visiblePages = pages.filter((p: GraphPageRow) => acl.canRead({ visibility: p.visibility }));
    const visibleIds = new Set(visiblePages.map((p: GraphPageRow) => p.id));

    const inboundCounts = await prisma.iMMemoryLink.groupBy({
      by: ['targetPageId'],
      where: { workspaceId: acl.workspaceId, targetPageId: { in: [...visibleIds] } },
      _count: { _all: true },
    });
    const inboundMap = new Map<string, number>();
    for (const r of inboundCounts) {
      if (r.targetPageId) inboundMap.set(r.targetPageId, r._count._all);
    }

    const nodes: GraphNode[] = visiblePages.map((p: GraphPageRow) => ({
      pageId: p.id,
      path: p.path,
      title: p.title,
      pageType: p.pageType,
      visibility: p.visibility,
      stale: p.stale,
      inboundCount: inboundMap.get(p.id) ?? 0,
    }));

    const filteredEdges = allEdges.filter(
      (e) =>
        visibleIds.has(e.sourcePageId) &&
        visibleIds.has(e.targetPageId) &&
        cappedSet.has(e.sourcePageId) &&
        cappedSet.has(e.targetPageId),
    );
    // de-dup edges (sourcePageId, targetPageId, relation)
    const seen = new Set<string>();
    const dedupedEdges: GraphEdge[] = [];
    for (const e of filteredEdges) {
      const key = `${e.sourcePageId}|${e.targetPageId}|${e.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedEdges.push(e);
    }

    return {
      nodes,
      edges: dedupedEdges,
      truncated: {
        totalNodes,
        shownNodes: nodes.length,
        totalEdges: allEdges.length,
      },
    };
  }

  /** GET /memory/observability/recall-trace */
  async recallTrace(acl: MemoryAclContext, sessionId: string, limit?: number): Promise<RecallTraceResponse> {
    if (!sessionId) return { events: [], cursor: null };
    const max = clampLimit(limit, RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT);

    const candidates = await prisma.iMMemoryObservabilityEvent.findMany({
      where: {
        workspaceId: acl.workspaceId,
        eventType: { in: [...RECALL_EVENT_TYPES] },
      },
      orderBy: { createdAt: 'asc' },
      take: max + 1,
    });

    const events: RecallEvent[] = [];
    for (const e of candidates) {
      if (events.length >= max) break;
      const meta = parseJson<{ sessionId?: string }>(e.metadataJson);
      if (!meta?.sessionId || meta.sessionId !== sessionId) continue;
      const eventType = e.eventType as RecallEvent['eventType'];
      const actorKind = (e.actorKind === 'agent' ? 'agent' : 'user') as RecallEvent['actorKind'];
      events.push({
        id: e.id,
        eventType,
        actorImUserId: e.actorImUserId ?? '',
        actorKind,
        pageId: e.pageId,
        query: e.query,
        metricsJson: parseJson(e.metricsJson),
        metadataJson: parseJson(e.metadataJson),
        createdAt: toIso(e.createdAt),
      });
    }
    return { events, cursor: null };
  }
}

function toLinkRow(row: {
  id: string;
  sourcePageId: string;
  targetPageId: string | null;
  sourceUri: string;
  targetUri: string;
  relation: string;
  weight: number;
  broken: boolean;
  extractedFromVersion: number | null;
  updatedAt: Date;
}): MemoryLinkRow {
  return {
    id: row.id,
    sourcePageId: row.sourcePageId,
    targetPageId: row.targetPageId,
    sourceUri: row.sourceUri,
    targetUri: row.targetUri,
    relation: row.relation,
    weight: row.weight,
    broken: row.broken,
    extractedFromVersion: row.extractedFromVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toKnowledgeRow(row: {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  linkType: string;
  strength: number;
  createdAt: Date;
}): KnowledgeLinkRow {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    targetType: row.targetType,
    targetId: row.targetId,
    linkType: row.linkType,
    strength: row.strength,
    createdAt: row.createdAt.toISOString(),
  };
}

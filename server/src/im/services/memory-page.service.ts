import * as crypto from 'crypto';
import prisma from '../db';

export interface MemoryPageSummary {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  pageType: string;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceAssetId: string | null;
  version: number;
  stale: boolean;
  contentHash: string;
  updatedAt: string;
}

export interface MemoryPageDetail extends MemoryPageSummary {
  content: string;
  contentHtml: string | null;
  contentHtmlVersion: number | null;
  provenance: unknown[];
}

export interface UpsertMemoryPageFromAssetInput {
  workspaceId: string;
  actorImUserId: string;
  assetId: string;
  sourceRef?: string | null;
  sourceKind?: string | null;
  title: string;
  content: string;
  /**
   * Optional HTML body. M-D (doc 25 §4): if the ingest pipeline already
   * produced HTML (e.g. PDF → markdown + HTML rendered upstream), pass it
   * here and it is stored independently. If absent, `contentHtml` is left
   * untouched on update (does NOT clobber a user-authored HTML edit) and
   * remains null on first insert (the backfill cron may render it later).
   */
  contentHtml?: string;
  pageType?: string;
  ingestRunId?: string | null;
  ingestVersion?: number | null;
}

type MemoryPageTx = {
  iMMemoryPage: typeof prisma.iMMemoryPage;
  iMMemoryPageVersion: typeof prisma.iMMemoryPageVersion;
  iMKnowledgeLink: typeof prisma.iMKnowledgeLink;
};

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function safePathSegment(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'asset';
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toSummary(row: {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  pageType: string;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceAssetId: string | null;
  version: number;
  stale: boolean;
  contentHash: string;
  updatedAt: Date;
}): MemoryPageSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    title: row.title,
    pageType: row.pageType,
    sourceRef: row.sourceRef,
    sourceKind: row.sourceKind,
    sourceAssetId: row.sourceAssetId,
    version: row.version,
    stale: row.stale,
    contentHash: row.contentHash,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class MemoryPageService {
  buildAssetPagePath(input: { assetId: string; title: string }) {
    return `memory/assets/${safePathSegment(input.title)}-${input.assetId}.md`;
  }

  async listPages(input: {
    workspaceId: string;
    sourceAssetId?: string | null;
    sourceRef?: string | null;
    limit?: number;
  }): Promise<MemoryPageSummary[]> {
    const rows = await prisma.iMMemoryPage.findMany({
      where: {
        workspaceId: input.workspaceId,
        archivedAt: null,
        ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(input.limit ?? 100, 1), 200),
    });
    return rows.map(toSummary);
  }

  async readPage(id: string, workspaceId: string): Promise<MemoryPageDetail | null> {
    const row = await prisma.iMMemoryPage.findFirst({ where: { id, workspaceId, archivedAt: null } });
    if (!row) return null;
    return {
      ...toSummary(row),
      content: row.content,
      contentHtml: row.contentHtml ?? null,
      contentHtmlVersion: row.contentHtmlVersion ?? null,
      provenance: parseJsonArray(row.provenanceJson),
    };
  }

  async upsertFromAsset(input: UpsertMemoryPageFromAssetInput): Promise<MemoryPageSummary> {
    const hash = contentHash(input.content);
    const path = this.buildAssetPagePath({ assetId: input.assetId, title: input.title });
    const sourceRef = input.sourceRef || `asset://${input.assetId}`;
    const nowEntry = {
      at: new Date().toISOString(),
      kind: 'extracted',
      actor: input.actorImUserId,
      sourceAssetId: input.assetId,
      sourceRef,
      ingestVersion: input.ingestVersion ?? 1,
    };

    return prisma.$transaction(async (tx: MemoryPageTx) => {
      const existing = await tx.iMMemoryPage.findUnique({
        where: { workspaceId_path: { workspaceId: input.workspaceId, path } },
      });

      if (existing && existing.contentHash === hash && !existing.stale) {
        await this.upsertAssetPageLink(tx, input.workspaceId, input.assetId, existing.id);
        return toSummary(existing);
      }

      const nextVersion = existing ? existing.version + 1 : 1;
      const provenance = [...parseJsonArray(existing?.provenanceJson ?? null), nowEntry];
      // M-D: HTML is independent. On insert, only set HTML if the caller
      // supplied it; otherwise leave both columns null (backfill cron may
      // derive later). On update, only override HTML if the caller supplied
      // it — we MUST NOT clobber an existing user-authored HTML edit just
      // because the asset re-ingested its markdown.
      const baseData = {
        workspaceId: input.workspaceId,
        path,
        title: input.title,
        content: input.content,
        version: nextVersion,
        createdByImUserId: input.actorImUserId,
        pageType: input.pageType ?? 'hub',
        sourceRef,
        sourceKind: input.sourceKind ?? 'asset-hook',
        sourceAssetId: input.assetId,
        ingestRunId: input.ingestRunId ?? null,
        ingestVersion: input.ingestVersion ?? 1,
        stale: false,
        staleReason: null,
        provenanceJson: JSON.stringify(provenance),
        visibility: 'workspace',
        encrypted: false,
        contentHash: hash,
      };
      const htmlPatch =
        input.contentHtml !== undefined ? { contentHtml: input.contentHtml, contentHtmlVersion: 0 } : {};
      const insertHtml =
        input.contentHtml !== undefined
          ? { contentHtml: input.contentHtml, contentHtmlVersion: 0 }
          : { contentHtml: null, contentHtmlVersion: null };

      const row = existing
        ? await tx.iMMemoryPage.update({
            where: { id: existing.id },
            data: { ...baseData, ...htmlPatch },
          })
        : await tx.iMMemoryPage.create({
            data: { ...baseData, ...insertHtml },
          });

      await tx.iMMemoryPageVersion.create({
        data: {
          workspaceId: input.workspaceId,
          pageId: row.id,
          version: row.version,
          content: input.content,
          contentHash: hash,
          createdByImUserId: input.actorImUserId,
          parentVersion: existing?.version ?? null,
          changeSummary: existing ? 'Updated from source asset' : 'Created from source asset',
          encrypted: false,
          sourceKind: input.sourceKind ?? 'asset-hook',
          sourceRef,
        },
      });

      await this.upsertAssetPageLink(tx, input.workspaceId, input.assetId, row.id);
      return toSummary(row);
    });
  }

  private async upsertAssetPageLink(
    tx: Pick<MemoryPageTx, 'iMKnowledgeLink'>,
    workspaceId: string,
    assetId: string,
    pageId: string,
  ) {
    await tx.iMKnowledgeLink.upsert({
      where: {
        sourceType_sourceId_targetType_targetId_linkType: {
          sourceType: 'asset',
          sourceId: assetId,
          targetType: 'memory_page',
          targetId: pageId,
          linkType: 'derived_from',
        },
      },
      create: {
        sourceType: 'asset',
        sourceId: assetId,
        targetType: 'memory_page',
        targetId: pageId,
        linkType: 'derived_from',
        workspaceId,
      },
      update: {
        strength: 1,
        workspaceId,
      },
    });
  }
}

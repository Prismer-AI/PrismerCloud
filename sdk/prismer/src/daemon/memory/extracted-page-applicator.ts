import { randomUUID } from 'node:crypto';
import type { ExtractedPage } from './extract.js';
import { memoryPathToUri, normalizeMemoryPath } from './store.js';
import { promoteReferencedAssetSpans } from './span-mint.js';
import type { WorkspaceSlot } from './runtime.js';

export interface ExtractedPageApplyContext {
  postTurnKey: string;
  /** Runtime-owned canonical turn commit key; Cloud uses this verbatim. */
  commitKey: string;
  resultHash: string;
  pageIndex: number;
  workspaceId: string;
  agentImUserId: string;
  conversationId?: string;
  turnId: string;
  traceId?: string;
  deviceId: string;
}

export interface ExtractedPageApplyLedger {
  postTurnKey: string;
  resultHash: string;
  pageIndex: number;
  path: string;
  contentHash: string;
  pageId: string;
  pageVersion: number;
  pageOutboxId: string;
  linkOutboxId: string | null;
  appliedAt: number;
}

export type ExtractedPageApplyFailureStage = 'after_page_write' | 'after_outbox_enqueue';

export interface ExtractedPageApplicatorOptions {
  failAt?: (stage: ExtractedPageApplyFailureStage) => void;
  now?: () => number;
}

interface ApplyRow {
  post_turn_key: string;
  result_hash: string;
  page_index: number;
  path: string;
  content_hash: string;
  page_id: string;
  page_version: number;
  page_outbox_id: string;
  link_outbox_id: string | null;
  applied_at: number;
}

export class ExtractedPageApplicator {
  private readonly now: () => number;

  constructor(
    private readonly slot: WorkspaceSlot,
    private readonly opts: ExtractedPageApplicatorOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  apply(page: ExtractedPage, ctx: ExtractedPageApplyContext): ExtractedPageApplyLedger {
    if (ctx.workspaceId !== this.slot.store.workspaceId()) {
      throw new Error(
        `ExtractedPageApplicator: workspace mismatch ${ctx.workspaceId} != ${this.slot.store.workspaceId()}`,
      );
    }
    const db = this.slot.store.rawDb();
    const existing = this.find(ctx.postTurnKey, ctx.resultHash, ctx.pageIndex);
    if (existing) return existing;

    const structurallyPlacedPage = ensureAutomaticPagePlacement(page);
    // Hoisted so the post-commit span mint can see the exact bytes written.
    const pageContent = withChildOfLink(structurallyPlacedPage, ctx.workspaceId);
    const applyTransaction = db.transaction(() => {
      // Re-check inside the transaction so a retry remains idempotent if this
      // method is ever called from more than one worker in the same process.
      const duplicate = this.find(ctx.postTurnKey, ctx.resultHash, ctx.pageIndex);
      if (duplicate) return duplicate;

      const visibility =
        structurallyPlacedPage.visibility === 'agent:self'
          ? ({ kind: 'agent', imUserId: ctx.agentImUserId } as const)
          : ({ kind: 'workspace' } as const);
      const content = withChildOfLink(structurallyPlacedPage, ctx.workspaceId);
      const written = this.slot.store.write({
        workspaceId: ctx.workspaceId,
        path: structurallyPlacedPage.path,
        content,
        title: structurallyPlacedPage.title,
        description: descriptionFromPkf(content) ?? `auto-extracted (${structurallyPlacedPage.placement})`,
        pageType: structurallyPlacedPage.pageType,
        visibility,
        sourceRefs: [...(ctx.conversationId ? [`conv:${ctx.conversationId}`] : []), `turn:${ctx.turnId}`],
        actorImUserId: ctx.agentImUserId,
        actorKind: 'agent',
      });

      this.opts.failAt?.('after_page_write');

      const pageOutbox = this.slot.outbox.enqueue({
        eventId: randomUUID(),
        schemaVersion: 1,
        eventType: 'memory.page.upsert',
        workspaceId: ctx.workspaceId,
        actorImUserId: ctx.agentImUserId,
        actorKind: 'agent',
        deviceId: ctx.deviceId,
        createdAt: new Date(this.now()).toISOString(),
        idempotencyKey: pageCommitKey(ctx.commitKey, ctx.pageIndex),
        pageId: written.id,
        path: written.path,
        parentVersion: Math.max(0, written.version - 1),
        contentHash: written.contentHash,
        payload: { kind: 'inline', content },
        ...(visibility.kind === 'workspace' ? {} : { visibility: `${visibility.kind}:${visibility.imUserId}` }),
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      });
      if (pageOutbox.deadLetter) {
        throw new Error(`ExtractedPageApplicator: page outbox validation failed (${pageOutbox.id})`);
      }

      let linkOutboxId: string | null = null;
      if (structurallyPlacedPage.placement === 'attach' && structurallyPlacedPage.parentHubPath) {
        const linkOutbox = this.slot.outbox.enqueue({
          eventId: randomUUID(),
          schemaVersion: 1,
          eventType: 'memory.link.upsert',
          workspaceId: ctx.workspaceId,
          actorImUserId: ctx.agentImUserId,
          actorKind: 'agent',
          deviceId: ctx.deviceId,
          createdAt: new Date(this.now()).toISOString(),
          idempotencyKey: `${ctx.commitKey}/link/${ctx.pageIndex}`,
          sourceUri: memoryPathToUri(ctx.workspaceId, structurallyPlacedPage.path),
          targetUri: memoryPathToUri(ctx.workspaceId, structurallyPlacedPage.parentHubPath),
          relation: 'child-of',
          sourcePath: normalizeMemoryPath(structurallyPlacedPage.path),
          targetPath: normalizeMemoryPath(structurallyPlacedPage.parentHubPath),
          extractedFromPageId: written.id,
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        });
        if (linkOutbox.deadLetter) {
          throw new Error(`ExtractedPageApplicator: link outbox validation failed (${linkOutbox.id})`);
        }
        linkOutboxId = linkOutbox.id;
      }

      this.opts.failAt?.('after_outbox_enqueue');

      const appliedAt = this.now();
      db.prepare(
        `INSERT INTO memory_post_turn_applies (
           post_turn_key, result_hash, page_index, path, content_hash,
           page_id, page_version, page_outbox_id, link_outbox_id, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ctx.postTurnKey,
        ctx.resultHash,
        ctx.pageIndex,
        written.path,
        written.contentHash,
        written.id,
        written.version,
        pageOutbox.id,
        linkOutboxId,
        appliedAt,
      );

      return {
        postTurnKey: ctx.postTurnKey,
        resultHash: ctx.resultHash,
        pageIndex: ctx.pageIndex,
        path: written.path,
        contentHash: written.contentHash,
        pageId: written.id,
        pageVersion: written.version,
        pageOutboxId: pageOutbox.id,
        linkOutboxId,
        appliedAt,
      };
    });

    const ledger = applyTransaction();
    // memory211/01 W4 轴F — the extraction lane cites raw assets too: mint the
    // cited chunks AFTER the durable ledger row committed (same reasoning as the
    // memory_write lane — a derived projection never rides the write's atomicity,
    // and its outbox events are idempotent on their own key).
    promoteReferencedAssetSpans({
      store: this.slot.store,
      outbox: this.slot.outbox,
      content: pageContent,
      deviceId: ctx.deviceId,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    });
    return ledger;
  }

  applyAll(pages: ExtractedPage[], ctx: Omit<ExtractedPageApplyContext, 'pageIndex'>): ExtractedPageApplyLedger[] {
    return pages.map((page, pageIndex) => this.apply(page, { ...ctx, pageIndex }));
  }

  find(postTurnKey: string, resultHash: string, pageIndex: number): ExtractedPageApplyLedger | null {
    const row = this.slot.store
      .rawDb()
      .prepare(
        `SELECT * FROM memory_post_turn_applies
         WHERE post_turn_key = ? AND result_hash = ? AND page_index = ?`,
      )
      .get(postTurnKey, resultHash, pageIndex) as ApplyRow | undefined;
    return row ? fromRow(row) : null;
  }
}

function pageCommitKey(commitKey: string, pageIndex: number): string {
  return pageIndex === 0 ? commitKey : `${commitKey}/${pageIndex}`;
}

/**
 * Automatic extraction is a maintenance writer and must never persist an
 * unclassified leaf. Legacy/result-ledger `new` pages (and malformed attach
 * pages missing a parent) are promoted to a top-level hub as a deterministic
 * safe fallback. Normal extractor output should already be extend/attach/hub;
 * this guard keeps crash replays and older runtimes structurally safe.
 */
function ensureAutomaticPagePlacement(page: ExtractedPage): ExtractedPage {
  if (page.placement === 'new' || (page.placement === 'attach' && !page.parentHubPath)) {
    return { ...page, placement: 'hub', pageType: 'hub', parentHubPath: undefined };
  }
  return page;
}

function descriptionFromPkf(content: string): string | null {
  const match = content.match(/<script[^>]*type=["']application\/prismer\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as { description?: unknown };
    return typeof value.description === 'string' && value.description.trim() ? value.description.trim() : null;
  } catch {
    return null;
  }
}

function withChildOfLink(page: ExtractedPage, workspaceId: string): string {
  if (page.placement !== 'attach' || !page.parentHubPath) return page.content;
  const alreadyLinked = /rel=["']child-of["']/i.test(page.content) && page.content.includes(page.parentHubPath);
  if (alreadyLinked) return page.content;
  const href = memoryPathToUri(workspaceId, page.parentHubPath);
  return `${page.content}\n<p><a href="${href}" rel="child-of">${page.parentHubPath}</a></p>`;
}

function fromRow(row: ApplyRow): ExtractedPageApplyLedger {
  return {
    postTurnKey: row.post_turn_key,
    resultHash: row.result_hash,
    pageIndex: row.page_index,
    path: row.path,
    contentHash: row.content_hash,
    pageId: row.page_id,
    pageVersion: row.page_version,
    pageOutboxId: row.page_outbox_id,
    linkOutboxId: row.link_outbox_id,
    appliedAt: row.applied_at,
  };
}

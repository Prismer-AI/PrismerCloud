/**
 * Workspace memory write surface (A3 of Memory Line A).
 *
 * Owns the create / archive / soft-delete / visibility / promote / stale /
 * sync-inbox / feedback paths. ACL gating is the caller's responsibility:
 * routes pass a `MemoryAclContext` from `loadWorkspaceForMemoryAccess` and
 * this service does the per-operation visibility check before applying.
 *
 * Side effects routed through `notifyInvalidate` callback (route layer wires
 * this to `RoomManager.sendToUser` after binding the workspace owner + each
 * delegated agent).
 *
 * Brief reference: doc 23 §6.1, §8 U3a, §11 R8.
 */

import * as crypto from 'node:crypto';
import prisma from '../db';
import type { MemoryAclContext } from './memory-acl';
import { _clearMemoryAclCache, loadWorkspaceForMemoryAccess } from './memory-acl';
import type { MemoryInvalidatePayload } from '../ws/events';
import { eventFamily } from './memory-event-family';

const MAX_CONTENT_BYTES = 64 * 1024;
// HTML representations of the same logical page are larger than markdown
// (tag overhead). Cap at 4× markdown limit so a fully-formatted page can
// round-trip through the rich-text editor without rejection.
const MAX_CONTENT_HTML_BYTES = 256 * 1024;
const SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * Heuristic secret-content patterns. Reject if any matches the body.
 *
 * Patterns are intentionally conservative — broad rules like "any 40-char
 * hex" or "any 40-char base64" produced too many false positives on commit
 * hashes, base64-encoded screenshots, signed URLs, and random IDs. Each
 * rule here either anchors to a vendor prefix or requires a structural
 * marker (PEM block, JWT triple-segment shape).
 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_pat', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'github_oauth', pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'private_key_block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

export class MemoryWriteError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MemoryWriteError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function ensureSafePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new MemoryWriteError('invalid_path', 'path is required');
  if (trimmed.length > 500) throw new MemoryWriteError('invalid_path', 'path exceeds 500 chars');
  if (trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new MemoryWriteError('invalid_path', 'path must be relative and may not contain ..');
  }
  return trimmed;
}

function scanForSecrets(content: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) return name;
  }
  return null;
}

export interface CreatePageInput {
  acl: MemoryAclContext;
  path: string;
  content: string;
  /**
   * Optional HTML content. M-D (doc 25 §4): HTML is an INDEPENDENT source
   * from `content` (markdown), not a derivation. If the caller (e.g. the
   * Library rich-text editor) supplies `contentHtml` along with markdown,
   * both are stored as-is. If only `content` is supplied, `contentHtml`
   * stays null — the backfill cron may later derive it for historical
   * rows that never got an HTML version.
   *
   * This service does NOT auto-render markdown to HTML on write. Doing so
   * would silently overwrite future user edits in the rich-text editor.
   */
  contentHtml?: string;
  pageType?: string;
  visibility?: string;
  sourceRefs: string[]; // required, non-empty
  rationale?: string;
}

export interface UpdateHtmlInput {
  acl: MemoryAclContext;
  pageId: string;
  /** New HTML body. Pass empty string to clear. */
  contentHtml: string;
  /** Optimistic concurrency on the page version (markdown side). */
  ifMatch?: string;
}

export interface ChangeVisibilityInput {
  acl: MemoryAclContext;
  pageId: string;
  visibility: string;
  reason?: string;
  ifMatch?: string;
}

export interface SoftDeleteInput {
  acl: MemoryAclContext;
  pageId: string;
}

export interface FeedbackInput {
  acl: MemoryAclContext;
  workspaceId: string;
  sessionId?: string;
  pageId?: string;
  targetEventId?: string;
  signal: -1 | 0 | 1;
  note?: string;
  query?: string;
}

export type SyncInboxEvent = {
  eventId: string;
  eventType: string;
  workspaceId: string;
  actorImUserId: string;
  actorKind: 'agent' | 'user';
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  // Envelope fields required by the daemon-side outbox (doc 18 §C4). The cloud
  // re-validates them on the inbox so a malformed daemon payload dead-letters
  // here instead of polluting downstream tables.
  schemaVersion?: number;
  idempotencyKey?: string;
  deviceId?: string;
  createdAt?: string;
};

export type SyncInboxResult = {
  acked: string[];
  errors: { eventId: string; code: string; message: string }[];
};

export interface SoftDeleteResult {
  pageId: string;
  invalidate: MemoryInvalidatePayload;
}

export type InvalidateNotifier = (payload: MemoryInvalidatePayload) => Promise<void> | void;

export class MemoryWriteService {
  private notify: InvalidateNotifier;

  constructor(notify?: InvalidateNotifier) {
    this.notify = notify ?? (() => undefined);
  }

  setNotifier(notify: InvalidateNotifier): void {
    this.notify = notify;
  }

  // ─── POST /memory/pages ────────────────────────────────────
  async createPage(input: CreatePageInput) {
    const { acl, sourceRefs, content, contentHtml, rationale } = input;
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
      throw new MemoryWriteError('source_refs_required', 'sourceRefs[] must be non-empty');
    }
    if (typeof content !== 'string' || !content) {
      throw new MemoryWriteError('content_required', 'content is required');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new MemoryWriteError('content_too_large', `content exceeds max ${MAX_CONTENT_BYTES} bytes`, 413);
    }
    const secret = scanForSecrets(content);
    if (secret) {
      throw new MemoryWriteError('secret_detected', `content matched ${secret} pattern`, 422);
    }
    if (contentHtml !== undefined) {
      if (typeof contentHtml !== 'string') {
        throw new MemoryWriteError('content_html_invalid', 'contentHtml must be a string when provided');
      }
      if (Buffer.byteLength(contentHtml, 'utf8') > MAX_CONTENT_HTML_BYTES) {
        throw new MemoryWriteError(
          'content_html_too_large',
          `contentHtml exceeds max ${MAX_CONTENT_HTML_BYTES} bytes`,
          413,
        );
      }
      // Same secret patterns apply — an HTML body still leaks an OAuth token
      // or AWS access key just as readily as markdown.
      const htmlSecret = scanForSecrets(contentHtml);
      if (htmlSecret) {
        throw new MemoryWriteError('secret_detected', `contentHtml matched ${htmlSecret} pattern`, 422);
      }
    }
    const path = ensureSafePath(input.path);
    const visibility = input.visibility ?? 'workspace';
    if (!acl.canWrite({ visibility })) {
      throw new MemoryWriteError('forbidden_visibility', 'caller cannot write that visibility', 403);
    }

    const provenance = [
      {
        at: nowIso(),
        kind: 'manual_write',
        actor: acl.callerImUserId,
        actorKind: acl.callerKind,
        sourceRefs,
        rationale: rationale ?? null,
      },
    ];
    const hash = contentHash(content);

    // M-D: contentHtml is an independent source. Caller-provided HTML is
    // stored verbatim and tagged with version 0 (user/agent-authored —
    // backfill cron skips these). If the caller did not supply HTML, leave
    // both columns null so the cron knows it can derive HTML for this row
    // later if requested.
    const htmlData =
      contentHtml !== undefined
        ? { contentHtml, contentHtmlVersion: 0 }
        : { contentHtml: null, contentHtmlVersion: null };

    const created = await prisma.iMMemoryPage.create({
      data: {
        workspaceId: acl.workspaceId,
        path,
        title: null,
        content,
        ...htmlData,
        version: 1,
        createdByImUserId: acl.callerImUserId,
        pageType: input.pageType ?? 'leaf',
        visibility,
        provenanceJson: JSON.stringify(provenance),
        encrypted: false,
        contentHash: hash,
      },
    });

    await prisma.iMMemoryPageVersion.create({
      data: {
        workspaceId: acl.workspaceId,
        pageId: created.id,
        version: 1,
        content,
        contentHash: hash,
        createdByImUserId: acl.callerImUserId,
        changeSummary: 'Created via POST /memory/pages',
        encrypted: false,
      },
    });

    await this.recordMetaChange(acl, created.id, 'created', { visibility, pageType: created.pageType });

    return created;
  }

  // ─── POST /memory/pages/:id/archive | unarchive ────────────
  async archive(acl: MemoryAclContext, pageId: string) {
    const page = await this.requireWritablePage(acl, pageId);
    const updated = await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { archivedAt: new Date() },
    });
    await this.recordMetaChange(acl, page.id, 'archived', { archivedAt: updated.archivedAt?.toISOString() });
    await this.notifyInvalidate(acl.workspaceId, [page.id], 'archive');
    return updated;
  }

  async unarchive(acl: MemoryAclContext, pageId: string) {
    const page = await this.requireWritablePage(acl, pageId, /* allowArchived */ true);
    const updated = await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { archivedAt: null },
    });
    await this.recordMetaChange(acl, page.id, 'unarchived', {});
    return updated;
  }

  // ─── DELETE /memory/pages/:id (soft-delete) ────────────────
  async softDelete(input: SoftDeleteInput): Promise<SoftDeleteResult> {
    const { acl, pageId } = input;
    const page = await this.requireWritablePage(acl, pageId, /* allowArchived */ true);

    await prisma.$transaction([
      prisma.iMMemoryPage.update({
        where: { id: page.id },
        data: { deletedAt: new Date() },
      }),
      prisma.iMMemoryLink.updateMany({
        where: { workspaceId: acl.workspaceId, targetPageId: page.id, broken: false },
        data: { broken: true },
      }),
    ]);
    await this.recordMetaChange(acl, page.id, 'soft_deleted', {});

    const payload: MemoryInvalidatePayload = {
      workspaceId: acl.workspaceId,
      pageIds: [page.id],
      reason: 'soft_delete',
      createdAt: nowIso(),
    };
    await this.notify(payload);
    _clearMemoryAclCache();
    return { pageId: page.id, invalidate: payload };
  }

  // ─── PATCH /memory/pages/:id/visibility ────────────────────
  async changeVisibility(input: ChangeVisibilityInput) {
    const { acl, pageId, visibility, ifMatch } = input;
    if (!visibility) throw new MemoryWriteError('visibility_required', 'visibility is required');
    const page = await this.requireWritablePage(acl, pageId);
    if (ifMatch) {
      const expected = `W/"${page.version}"`;
      if (ifMatch !== expected) {
        throw new MemoryWriteError('etag_mismatch', 'If-Match header does not match current version', 412, {
          currentVersion: page.version,
        });
      }
    }
    if (!acl.canWrite({ visibility })) {
      throw new MemoryWriteError('forbidden_visibility', 'caller cannot assign that visibility', 403);
    }
    const updated = await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { visibility, version: { increment: 1 } },
    });
    await this.recordMetaChange(acl, page.id, 'visibility_changed', {
      from: page.visibility,
      to: visibility,
      reason: input.reason ?? null,
    });
    await this.notifyInvalidate(acl.workspaceId, [page.id], 'visibility_changed');
    _clearMemoryAclCache();
    return updated;
  }

  // ─── POST /memory/pages/:id/promote (owner-only) ───────────
  async promote(acl: MemoryAclContext, pageId: string, ifMatch?: string) {
    if (acl.callerKind !== 'user') {
      throw new MemoryWriteError('owner_only', 'promote requires the workspace owner', 403);
    }
    const page = await prisma.iMMemoryPage.findFirst({
      where: { id: pageId, workspaceId: acl.workspaceId },
    });
    if (!page) throw new MemoryWriteError('not_found', 'page not found', 404);
    if (ifMatch) {
      const expected = `W/"${page.version}"`;
      if (ifMatch !== expected) {
        throw new MemoryWriteError('etag_mismatch', 'If-Match mismatch', 412, {
          currentVersion: page.version,
        });
      }
    }
    const updated = await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { visibility: 'workspace', version: { increment: 1 } },
    });
    await this.recordMetaChange(acl, page.id, 'promoted', {
      from: page.visibility,
      to: 'workspace',
    });
    await this.notifyInvalidate(acl.workspaceId, [page.id], 'promoted');
    _clearMemoryAclCache();
    return updated;
  }

  // ─── PATCH /memory/pages/:id/html ──────────────────────────
  /**
   * Independent HTML-source write path (M-D, doc 25 §4). Updates **only**
   * `contentHtml` + tags it with version 0 (user-authored — backfill
   * cron must skip these). Does NOT touch `content` (markdown), the
   * `version` column, the markdown `contentHash`, or the version-history
   * row in `im_memory_page_versions`. The two sources evolve in parallel.
   *
   * The `If-Match` header still gates on the markdown-side `version` so
   * the rich-text editor can detect "the markdown body shifted under me
   * mid-edit"; pass it through verbatim from the GET that fetched the
   * page.
   */
  async updateHtml(input: UpdateHtmlInput) {
    const { acl, pageId, contentHtml, ifMatch } = input;
    if (typeof contentHtml !== 'string') {
      throw new MemoryWriteError('content_html_required', 'contentHtml is required');
    }
    if (Buffer.byteLength(contentHtml, 'utf8') > MAX_CONTENT_HTML_BYTES) {
      throw new MemoryWriteError(
        'content_html_too_large',
        `contentHtml exceeds max ${MAX_CONTENT_HTML_BYTES} bytes`,
        413,
      );
    }
    if (contentHtml.length > 0) {
      const htmlSecret = scanForSecrets(contentHtml);
      if (htmlSecret) {
        throw new MemoryWriteError('secret_detected', `contentHtml matched ${htmlSecret} pattern`, 422);
      }
    }
    const page = await this.requireWritablePage(acl, pageId);
    if (ifMatch) {
      const expected = `W/"${page.version}"`;
      if (ifMatch !== expected) {
        throw new MemoryWriteError('etag_mismatch', 'If-Match header does not match current version', 412, {
          currentVersion: page.version,
        });
      }
    }
    const updated = await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { contentHtml, contentHtmlVersion: 0 },
    });
    await this.recordMetaChange(acl, page.id, 'html_updated', {
      htmlBytes: Buffer.byteLength(contentHtml, 'utf8'),
    });
    await this.notifyInvalidate(acl.workspaceId, [page.id], 'html_updated');
    return updated;
  }

  // ─── Backfill cron support ─────────────────────────────────
  /**
   * Apply a backfill render result. Called by
   * `scripts/ops/backfill-memory-html.ts` once per row. Conditional update:
   * the row is touched only if its `contentHtmlVersion` is still in the
   * "derived or empty" range (NULL or >= 1) AND below the supplied
   * `pipelineVersion`. Rows with `contentHtmlVersion = 0` (user-authored)
   * are skipped — the cron must not clobber rich-text-editor edits.
   *
   * Returns 1 when the row was updated, 0 otherwise (skipped or already
   * up-to-date). The atomic UPDATE...WHERE pattern means concurrent
   * editor saves race-safely lose to the user (zero rows match).
   */
  async applyBackfillHtml(
    pageId: string,
    workspaceId: string,
    contentHtml: string,
    pipelineVersion: number,
  ): Promise<number> {
    if (pipelineVersion < 1) {
      throw new MemoryWriteError('invalid_pipeline_version', 'pipelineVersion must be >= 1');
    }
    if (typeof contentHtml !== 'string') {
      throw new MemoryWriteError('content_html_invalid', 'contentHtml must be a string');
    }
    if (Buffer.byteLength(contentHtml, 'utf8') > MAX_CONTENT_HTML_BYTES) {
      throw new MemoryWriteError(
        'content_html_too_large',
        `contentHtml exceeds max ${MAX_CONTENT_HTML_BYTES} bytes`,
        413,
      );
    }
    const result = await prisma.iMMemoryPage.updateMany({
      where: {
        id: pageId,
        workspaceId,
        deletedAt: null,
        // Skip user-authored rows (version 0) — they are independent and
        // not subject to the render pipeline. Only touch rows that are
        // either NULL (never derived) or have a stale derived version.
        OR: [{ contentHtmlVersion: null }, { contentHtmlVersion: { gte: 1, lt: pipelineVersion } }],
      },
      data: { contentHtml, contentHtmlVersion: pipelineVersion },
    });
    return result.count;
  }

  // ─── PATCH /memory/pages/:id/stale ─────────────────────────
  async setStale(acl: MemoryAclContext, pageId: string, stale: boolean, reason?: string) {
    const page = await this.requireWritablePage(acl, pageId);
    const updated = await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { stale, staleReason: stale ? (reason ?? null) : null },
    });
    await this.recordMetaChange(acl, page.id, stale ? 'marked_stale' : 'cleared_stale', {
      reason: reason ?? null,
    });
    return updated;
  }

  // ─── POST /memory/sync/inbox ───────────────────────────────
  /**
   * @param caller   JWT-authenticated identity. When provided, each event is
   *                 ACL-checked against `ev.workspaceId` so a daemon batching
   *                 events across workspaces can only post to workspaces the
   *                 caller actually has access to. Omit only in unit tests
   *                 that pre-validated workspace membership themselves.
   */
  async ingestSyncInbox(
    events: SyncInboxEvent[],
    caller?: { imUserId: string; callerKind: 'user' | 'agent' },
  ): Promise<SyncInboxResult> {
    const acked: string[] = [];
    const errors: SyncInboxResult['errors'] = [];
    for (const ev of events) {
      try {
        // Per-event workspace ACL gate. The inbox is the only memory write
        // path that takes ev.workspaceId from the body rather than the
        // resolved route context, so without this check an authenticated
        // agent in workspace W1 could pollute W2's observability table by
        // posting events with `workspaceId: W2`. The check is per-event
        // (not per-batch) because daemon-owner humans legitimately batch
        // events across multiple workspaces they own.
        if (caller) {
          if (!ev?.workspaceId) {
            throw new MemoryWriteError('schema_invalid', 'workspaceId is required');
          }
          const workspaceAcl = await loadWorkspaceForMemoryAccess(ev.workspaceId, caller.imUserId, caller.callerKind);
          if (!workspaceAcl) {
            throw new MemoryWriteError('forbidden_workspace', 'caller has no access to ev.workspaceId', 403);
          }
        }

        // Idempotency dedup. The daemon outbox replays on reconnect and
        // retries on transient failures, so a single event may arrive in
        // multiple batches. UNIQUE (workspaceId, eventId) and
        // UNIQUE (workspaceId, idempotencyKey) on im_memory_sync_events
        // make duplicates a P2002 — we treat that as a no-op ack so the
        // observability table is never doubled-up.
        if (ev.idempotencyKey) {
          try {
            await prisma.iMMemorySyncEvent.create({
              data: {
                workspaceId: ev.workspaceId,
                eventId: ev.eventId,
                eventType: ev.eventType,
                idempotencyKey: ev.idempotencyKey,
                schemaVersion: ev.schemaVersion ?? 1,
                actorImUserId: ev.actorImUserId,
                actorKind: ev.actorKind,
                deviceId: ev.deviceId ?? null,
                payloadJson: JSON.stringify(ev.payload ?? {}),
                direction: 'inbound',
                status: 'received',
              },
            });
          } catch (err) {
            if (err && (err as { code?: string }).code === 'P2002') {
              // Already processed — ack as no-op.
              acked.push(ev.eventId);
              continue;
            }
            throw err;
          }
        }

        await this.routeOneEvent(ev);
        acked.push(ev.eventId);
      } catch (err) {
        errors.push({
          eventId: ev.eventId,
          code: err instanceof MemoryWriteError ? err.code : 'internal',
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return { acked, errors };
  }

  /**
   * Route one outbox event by family.
   *
   * Family classification lives in `memory-event-family.ts` (kept in sync with
   * Line C `sdk/prismer-cloud/runtime/src/daemon/memory/envelope.ts`). Adding
   * a new observability eventType means adding it to the helper's set — this
   * switch is family-scoped and stable.
   *
   *   observability — recall_preload / recall_inject / recall_pull /
   *                   recall_reject / access_denied / feedback /
   *                   memory.feedback → write im_memory_observability_events
   *   memory        — memory.page.upsert / memory.page.delete /
   *                   memory.link.upsert / memory.link.delete → ack +
   *                   schema-validate; daemon-driven mirror writes ship in
   *                   A3.next (NOTE: there is no `memory.page.archive` outbox
   *                   event — archive flows via HTTP `/memory/pages/:id/archive`)
   *   asset / ingest — ack to keep daemon outbox advancing; existing ingest
   *                   pipeline owns the cloud-side writes
   *   unknown       — dead-letter via MemoryWriteError(unknown_event_type)
   */
  private async routeOneEvent(ev: SyncInboxEvent): Promise<void> {
    // Envelope contract (doc 18 §C4). Daemon sends these fields on every
    // outbox event; cloud re-validates them so a malformed daemon payload
    // dead-letters here instead of polluting downstream tables.
    if (!ev.eventId || typeof ev.eventId !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'eventId is required');
    }
    if (!ev.eventType || typeof ev.eventType !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'eventType is required');
    }
    if (!ev.workspaceId || typeof ev.workspaceId !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'workspaceId is required');
    }
    if (ev.schemaVersion !== undefined && ev.schemaVersion !== 1) {
      throw new MemoryWriteError('schema_invalid', `unsupported schemaVersion ${ev.schemaVersion} (expected 1)`);
    }
    if (!ev.idempotencyKey || typeof ev.idempotencyKey !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'idempotencyKey is required');
    }
    if (!ev.deviceId || typeof ev.deviceId !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'deviceId is required');
    }
    if (!ev.createdAt || typeof ev.createdAt !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'createdAt is required');
    }
    if (!ev.actorImUserId || typeof ev.actorImUserId !== 'string') {
      throw new MemoryWriteError('schema_invalid', 'actorImUserId is required');
    }
    // Accept the daemon-side "human" alias from envelope.ts. Cloud canonicalises
    // to "user" so downstream tables stay consistent with the rest of the
    // memory write surface.
    if (ev.actorKind === ('human' as unknown as 'user' | 'agent')) {
      ev.actorKind = 'user';
    }
    if (ev.actorKind !== 'user' && ev.actorKind !== 'agent') {
      throw new MemoryWriteError('schema_invalid', 'actorKind must be "user" or "agent"');
    }

    switch (eventFamily(ev.eventType)) {
      case 'observability':
        await prisma.iMMemoryObservabilityEvent.create({
          data: {
            workspaceId: ev.workspaceId,
            eventType: ev.eventType,
            actorImUserId: ev.actorImUserId,
            actorKind: ev.actorKind,
            pageId: (ev.payload?.pageId as string | undefined) ?? null,
            query: (ev.payload?.query as string | undefined) ?? null,
            metricsJson: ev.payload?.metrics ? JSON.stringify(ev.payload.metrics) : null,
            metadataJson: ev.metadata ? JSON.stringify(ev.metadata) : null,
          },
        });
        return;

      case 'memory':
        if (ev.eventType === 'memory.proposal') {
          // M-C (doc 25 §3 支柱 3): session-end extract proposal lands
          // in im_memory_proposals. Defensively pull every required
          // field off the envelope itself (the proposal-extract path
          // puts them at the top level of the event, not wrapped in
          // payload, so the cloud router validates per-field here).
          const p = ev as unknown as {
            sessionId?: string;
            pagePath?: string;
            baseVersion?: number;
            operation?: string;
            contentDiff?: string;
            rationale?: string;
            confidence?: number;
            sourceRefs?: string[];
          };
          if (typeof p.pagePath !== 'string' || !p.pagePath) {
            throw new MemoryWriteError('schema_invalid', 'memory.proposal: pagePath required');
          }
          if (typeof p.baseVersion !== 'number') {
            throw new MemoryWriteError('schema_invalid', 'memory.proposal: baseVersion required');
          }
          if (p.operation !== 'create' && p.operation !== 'replace' && p.operation !== 'delete') {
            throw new MemoryWriteError('schema_invalid', 'memory.proposal: operation must be create/replace/delete');
          }
          if (typeof p.contentDiff !== 'string') {
            throw new MemoryWriteError('schema_invalid', 'memory.proposal: contentDiff required');
          }
          if (typeof p.confidence !== 'number') {
            throw new MemoryWriteError('schema_invalid', 'memory.proposal: confidence required');
          }
          const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
          await prisma.iMMemoryProposal.create({
            data: {
              workspaceId: ev.workspaceId,
              proposingAgentId: ev.actorImUserId,
              sessionId: p.sessionId ?? null,
              status: 'pending',
              pagePath: p.pagePath,
              baseVersion: p.baseVersion,
              operation: p.operation,
              contentDiff: p.contentDiff,
              rationale: p.rationale ?? null,
              confidence: p.confidence,
              sourceRefs: JSON.stringify(p.sourceRefs ?? []),
              expiresAt,
            },
          });
          return;
        }
        if (!ev.payload || typeof ev.payload !== 'object') {
          throw new MemoryWriteError('schema_invalid', 'memory.* payload missing');
        }
        return;

      case 'asset':
      case 'ingest':
        return;

      case 'unknown':
        throw new MemoryWriteError('unknown_event_type', `unrecognized eventType ${ev.eventType}`);
    }
  }

  // ─── POST /memory/observability/feedback (owner-human only) ─
  async recordFeedback(input: FeedbackInput): Promise<{ eventId: string }> {
    const { acl, signal, sessionId, pageId, targetEventId, note, query } = input;
    if (acl.callerKind !== 'user') {
      throw new MemoryWriteError('owner_only', 'feedback writes require the workspace owner', 403);
    }
    if (![-1, 0, 1].includes(signal)) {
      throw new MemoryWriteError('invalid_signal', 'signal must be -1 | 0 | 1');
    }
    const created = await prisma.iMMemoryObservabilityEvent.create({
      data: {
        workspaceId: acl.workspaceId,
        eventType: 'feedback',
        actorImUserId: acl.callerImUserId,
        // Defense-in-depth: source actorKind from the resolved ACL context
        // rather than a hardcoded literal. The route gate above still ensures
        // only `'user'` callers reach this point, but using `acl.callerKind`
        // makes the value's source-of-truth the ACL — so if the gate ever
        // gets relaxed, the stored `actorKind` reflects reality.
        actorKind: acl.callerKind,
        pageId: pageId ?? null,
        targetEventId: targetEventId ?? null,
        query: query ?? null,
        metricsJson: JSON.stringify({ signal }),
        metadataJson: JSON.stringify({
          sessionId: sessionId ?? null,
          note: note ?? null,
        }),
      },
    });
    return { eventId: created.id };
  }

  // ─── soft-delete cron support ──────────────────────────────
  async purgeSoftDeleted(now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const expired = await prisma.iMMemoryPage.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, workspaceId: true },
    });
    if (expired.length === 0) return { deleted: 0 };
    const ids = expired.map((p: { id: string }) => p.id);
    const wsIds = Array.from(new Set(expired.map((p: { workspaceId: string }) => p.workspaceId)));
    await prisma.$transaction([
      prisma.iMMemoryPageVersion.deleteMany({ where: { pageId: { in: ids } } }),
      prisma.iMMemoryLink.updateMany({
        where: { targetPageId: { in: ids }, workspaceId: { in: wsIds } },
        data: { broken: true, targetPageId: null },
      }),
      prisma.iMMemoryLink.deleteMany({
        where: { sourcePageId: { in: ids }, workspaceId: { in: wsIds } },
      }),
      prisma.iMMemoryPage.deleteMany({ where: { id: { in: ids } } }),
    ]);
    return { deleted: expired.length };
  }

  // ─── helpers ───────────────────────────────────────────────
  private async requireWritablePage(acl: MemoryAclContext, pageId: string, allowArchived = false) {
    const where: { id: string; workspaceId: string; deletedAt: null; archivedAt?: null } = {
      id: pageId,
      workspaceId: acl.workspaceId,
      deletedAt: null,
    };
    if (!allowArchived) where.archivedAt = null;
    const page = await prisma.iMMemoryPage.findFirst({ where });
    if (!page) throw new MemoryWriteError('not_found', 'page not found', 404);
    if (!acl.canWrite({ visibility: page.visibility })) {
      throw new MemoryWriteError('forbidden', 'caller cannot write this page', 403);
    }
    return page;
  }

  private async recordMetaChange(
    acl: MemoryAclContext,
    pageId: string,
    op: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await prisma.iMMemoryObservabilityEvent.create({
      data: {
        workspaceId: acl.workspaceId,
        eventType: 'meta_change',
        actorImUserId: acl.callerImUserId,
        actorKind: acl.callerKind,
        pageId,
        metadataJson: JSON.stringify({ op, ...detail }),
      },
    });
  }

  private async notifyInvalidate(
    workspaceId: string,
    pageIds: string[],
    reason: MemoryInvalidatePayload['reason'],
  ): Promise<void> {
    const payload: MemoryInvalidatePayload = {
      workspaceId,
      pageIds,
      reason,
      createdAt: nowIso(),
    };
    await this.notify(payload);
  }
}

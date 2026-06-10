/**
 * Daemon cloud-to-local memory sync pull (P0 fix).
 *
 * Populates an empty local MemoryStore by fetching existing memory pages
 * from the cloud API. Without this, the daemon's local FTS5 store is
 * always empty on startup and memory_search returns nothing.
 *
 * One-shot per workspace on first resolve. Cursor-based incremental sync
 * is future work (tracked in ws-invalidate.ts:17-19).
 */

import type { CloudClient } from '../../auth.js';
import { createLogger } from '../../lib/logger.js';
import type { MemoryRuntime } from './runtime.js';
import type { MemoryPageType, MemoryVisibility } from './types.js';

const log = createLogger('CloudMemorySync');
const CLOUD_PAGE_LIMIT = 300;

interface CloudPageRow {
  id: string;
  path: string;
  title?: string | null;
  content?: string | null;
  pageType?: string;
  visibility?: string;
}

/**
 * One-shot initial sync: fetch all pages for a workspace from the cloud API
 * and write them into the local MemoryStore.
 *
 * Guards:
 *   - Skips if no store exists for this workspace (peek returns null)
 *   - Skips if store already has pages (stats().pageCount > 0)
 *   - Gracefully handles cloud API errors (logs, returns {0,0})
 *   - Non-blocking per-page write failures (increments skipped counter)
 */
export async function initialSyncFromCloud(
  runtime: MemoryRuntime,
  cloud: CloudClient,
  workspaceId: string,
): Promise<{ pulled: number; skipped: number }> {
  // Only sync for stores that already exist (peek, not resolve — we don't
  // want to implicitly create a store just to check).
  const slot = runtime.peek(workspaceId);
  if (!slot) {
    log.info(`No store for workspace=${workspaceId} — skipping`);
    return { pulled: 0, skipped: 0 };
  }

  // Skip if already synced (cursor recorded means previous sync completed).
  // Local-only pages (pipeline writes, tool writes) don't suppress the sync —
  // cloud pages are the source of truth and should always be pulled on first
  // opportunity. The cursor guard protects against re-sync on daemon re-resolve.
  const cursorRow = slot.store.rawDb()
    .prepare('SELECT cursor FROM memory_inbox_cursor WHERE workspaceId = ?')
    .get(workspaceId) as { cursor: string } | undefined;
  if (cursorRow) {
    log.info(`Workspace=${workspaceId} already synced (cursor: ${cursorRow.cursor.slice(0, 20)}...) — skip`);
    return { pulled: 0, skipped: 0 };
  }

  log.info(`Fetching cloud pages for workspace=${workspaceId}...`);

  const resp = await cloud.request<{ ok: boolean; data?: CloudPageRow[] }>(
    'GET',
    `/api/im/memory/pages?workspaceId=${encodeURIComponent(workspaceId)}&limit=${CLOUD_PAGE_LIMIT}&stale=all`,
    { timeoutMs: 15_000 },
  );

  if (!resp.ok) {
    log.warn(
      `Cloud GET /memory/pages returned ${resp.status}: ${resp.error?.message ?? 'unknown'}`,
    );
    return { pulled: 0, skipped: 0 };
  }

  const envelope = resp.data;
  if (!envelope || !envelope.ok) {
    log.info(`Cloud returned non-ok envelope for workspace=${workspaceId}`);
    return { pulled: 0, skipped: 0 };
  }

  const pages = envelope.data;
  if (!pages || !Array.isArray(pages) || pages.length === 0) {
    log.info(`No cloud pages to sync for workspace=${workspaceId}`);
    return { pulled: 0, skipped: 0 };
  }

  let pulled = 0;
  let skipped = 0;

  for (const page of pages) {
    let content = page.content ?? '';

    // If no content in list response, fetch detail
    if (!content) {
      try {
        const detailResp = await cloud.request<{
          ok: boolean;
          data?: { content?: string };
        }>(
          'GET',
          `/api/im/memory/pages/${encodeURIComponent(page.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
          { timeoutMs: 5000 },
        );
        if (detailResp.ok && detailResp.data?.data?.content) {
          content = detailResp.data.data.content;
        }
      } catch {
        // Non-blocking — proceed with empty content
      }
    }

    // Map cloud visibility string to MemoryVisibility
    const visibility: MemoryVisibility =
      page.visibility === 'agent'
        ? { kind: 'agent', imUserId: '' }
        : { kind: 'workspace' };

    try {
      slot.store.write({
        workspaceId,
        path: page.path,
        title: page.title ?? undefined,
        content: content || '',
        pageType: ((page.pageType as MemoryPageType) || 'leaf') as MemoryPageType,
        visibility,
        actorImUserId: 'cloud-sync',
        actorKind: 'agent',
      });
      pulled++;
    } catch (err) {
      log.warn(`write failed for ${page.path}: ${(err as Error).message}`);
      skipped++;
    }
  }

  // Record cursor for future incremental sync
  slot.store.recordCursor(workspaceId, `synced:${Date.now()}`);

  log.info(
    `Synced ${pulled} pages${skipped ? `, ${skipped} skipped` : ''} for workspace=${workspaceId}`,
  );
  return { pulled, skipped };
}

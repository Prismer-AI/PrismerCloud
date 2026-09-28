/**
 * Daemon cloud-to-local memory sync (Desktop-202 doc 18 §5a — incremental).
 *
 * Populates / refreshes the daemon's local FTS5 store from the cloud memory
 * pages. The daemon is a local-first *cache*, not a second source of truth
 * (doc 18 §2): cloud is authoritative, this store is rebuildable.
 *
 * ## What changed vs the one-shot 300-page bootstrap (doc 18 §1c / §5a)
 *
 * The original implementation pulled at most `CLOUD_PAGE_LIMIT=300` pages
 * exactly once per workspace (a cursor row, once written, suppressed every
 * future sync). That both **truncated** large workspaces and left the cache
 * **stale** forever. This module replaces that with a watermark-driven
 * incremental catch-up:
 *
 *   - The cap is removed. We page through the cloud list in pages of
 *     `CLOUD_PAGE_SIZE` (the cloud endpoint's hard max) ordered by
 *     `updatedAt DESC`, materialising every visible page/file.
 *   - A high-water mark (`max(updatedAt)` of everything pulled) is persisted
 *     in `memory_inbox_cursor` as `wm:<ms>`. The cursor no longer suppresses
 *     sync — it *resumes* it: subsequent syncs only re-materialise rows newer
 *     than the watermark, so a re-resolve / OTA restart is cheap.
 *
 * ## C7 gap (doc 18 §5a "cloud additive new") — cloud `since` not yet wired
 *
 * doc 18 §5a calls for the cloud `/memory/pages` list to grow a `since=<seq>`
 * incremental parameter. As of this change the cloud handler
 * (`src/im/api/memory.ts` GET /pages → `memory-read.service.ts:listPages`)
 * does NOT read `since`/`updatedSince`, has no offset/cursor, and caps `take`
 * at 200 ordered by `updatedAt DESC`. We therefore:
 *
 *   1. **Send** `since=<wm>` (and `updatedSince`) speculatively — forward-
 *      compatible: when cloud lands the parameter the daemon needs no change.
 *   2. **Re-apply the watermark client-side** regardless, so behaviour is
 *      correct against today's cloud (which ignores the param). Pages whose
 *      `updatedAt <= watermark` are skipped as already-materialised.
 *   3. Are bounded by the cloud 200-page cap: a single workspace with >200
 *      pages newer than the watermark cannot be fully pulled in one pass until
 *      the cloud `since` param exists. This is the residual C7 limitation —
 *      tracked here; the daemon side is otherwise ready.
 *
 * Cross-instance fan-out / staleness invalidation rides the existing
 * `memory.write` WS push (`ws-invalidate.ts`); this module is the cold-start +
 * catch-up bootstrap.
 */

import type { CloudClient } from '../../auth.js';
import { createLogger } from '../../lib/logger.js';
import type { MemoryRuntime } from './runtime.js';
import type { MemoryPageType, MemoryVisibility } from './types.js';
import type { MemoryKeyManager } from './key-manager.js';
import {
  systemCap,
  getMemoryAuthoritySnapshot,
  MIN_STRICT_RUNTIME_VERSION,
  MEMORY_RUNTIME_CAPABILITIES_V1,
} from './cap.js';
import { decrypt as gcmDecrypt, isPackedCiphertext } from './crypto-cipher.js';
import { memoryPathToUri, type ReplicaHeadWrite, type MemoryReplicaSourceKind } from './store.js';
import { createHash } from 'node:crypto';

/**
 * memory202 doc 06 — sentinel stored as a cross-device-unreadable page's local
 * content. We do NOT store the raw ciphertext (that would let recall/FTS surface
 * ciphertext as if it were content); instead a clear marker so the surface can
 * show "encrypted, no local key" rather than gibberish. Fail-closed.
 */
const UNREADABLE_SENTINEL = '[encrypted — no local key on this device]';

const log = createLogger('CloudMemorySync');

/**
 * Per-request page size. The cloud `/memory/pages` handler clamps `limit` to
 * a hard max of 200 (memory-read.service.ts `clampLimit(..., 100, 200)`), so
 * requesting more is pointless. The old `CLOUD_PAGE_LIMIT=300` truncation cap
 * is gone — we page until the cloud returns a short page.
 */
const CLOUD_PAGE_SIZE = 200;

/**
 * Per-request link page size for link sync (M-LINK-SYNC). The cloud
 * `/memory/links/sync` handler clamps `limit` to a hard max of 500
 * (memory-read.service.ts `clampLimit(..., 200, 500)`).
 */
const CLOUD_LINK_PAGE_SIZE = 500;

/** Cursor-string prefix for the incremental watermark (max updatedAt seen). */
const WATERMARK_PREFIX = 'wm:';

interface CloudPageRow {
  id: string;
  path: string;
  title?: string | null;
  content?: string | null;
  pageType?: string;
  visibility?: string;
  /** memory202 doc 06: when true, `content` is AES-256-GCM ciphertext (cloud has no key). */
  encrypted?: boolean | null;
  /**
   * memory203/18 R1.4 — the cloud head version. Passed into the local
   * `store.write` so a down-synced page lands at the CLOUD version (not local
   * v1) and a subsequent local write emits an honest `parentVersion`.
   */
  version?: number | null;
  /** Cloud rows order by updatedAt DESC; epoch-ms or ISO depending on serializer. */
  updatedAt?: number | string | null;
  /**
   * memory203 doc 07 — the cloud's per-page sync state for a down-syncing
   * daemon. `'remote-conflict'` ⇒ the page is in a live unreconciled conflict
   * (this device's write may have lost LWW); the daemon stamps its local page so
   * the host learns its write lost without polling `/memory/health/conflicts`.
   * Absent / `'synced'` ⇒ no live conflict. Computed cloud-side in
   * `memory-read.service.ts#enrichSummaries`.
   */
  syncStatus?: string | null;
}

/** §15.2 — fixed 426 payload (same values as the Cloud constants). */
export interface SyncUpgradeRequired {
  minRuntimeVersion: string;
  requiredRuntimeCapabilities: string[];
}

export interface SyncResult {
  pulled: number;
  skipped: number;
  /** True when nothing newer than the local watermark was found (no-op catch-up). */
  upToDate: boolean;
  /**
   * §15.2 — set when the Cloud refused the legacy daemon sync signature with
   * 426 MEMORY_RUNTIME_UPGRADE_REQUIRED. The sync STOPPED (typed, no fallback
   * retry of the old path) and the caller must route the workspace to the V3
   * replica port (which happens automatically once the strict snapshot
   * arrives via bootstrap).
   */
  upgradeRequired?: SyncUpgradeRequired;
}

function parseWatermark(cursor: string | null): number {
  if (!cursor || !cursor.startsWith(WATERMARK_PREFIX)) return 0;
  const ms = Number(cursor.slice(WATERMARK_PREFIX.length));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Project the cloud's visibility STRING into the daemon's structured
 * {@link MemoryVisibility}. The cloud stores an owner-prefixed string —
 * `workspace`, `agent:<imUserId>`, `private:<imUserId>`, `human:<imUserId>`,
 * `task:<taskId>` — NOT the bare kind. The boundary ACL predicate
 * (acl-predicate.ts) then gates per-hit recall on `visibility.imUserId ===
 * cap.sub`, so the OWNER id MUST survive this projection or an agent-private
 * page leaks to every in-workspace agent (the daemon stores one shared subset
 * per workspace; this string is the only per-page scope signal).
 *
 * Fail-closed: any owner-scoped kind we don't model as `agent` (human:/task:/
 * private:/unknown) maps to `private` with the parsed subject, so ONLY that
 * exact subject — never another agent — can read it at the boundary. The full
 * governance for those kinds stays cloud-side (the daemon never widens access).
 * A bare, owner-less non-workspace token degrades to `private` with an empty
 * owner → readable by nobody at the boundary (hard fail-closed).
 */
function parseCloudVisibility(v: string | undefined): MemoryVisibility {
  if (!v || v === 'workspace') return { kind: 'workspace' };
  const colon = v.indexOf(':');
  if (colon <= 0) return { kind: 'private', imUserId: '' };
  const kind = v.slice(0, colon);
  const imUserId = v.slice(colon + 1);
  if (kind === 'agent') return { kind: 'agent', imUserId };
  // E4 (product204) — role/council-scoped pages down-synced from the cloud
  // superset. The subject is a role slug / council id (not an im_user); model
  // them faithfully so a down-synced page round-trips. product204/34 Track 0.1
  // (§2.3): the boundary ACL now FAIL-CLOSES these scopes (acl-predicate.ts) —
  // a down-synced role/council page is only readable by a cap that carries the
  // matching role slug / council membership, NOT by every in-workspace agent.
  // This closure MUST ship with the predicate fix (this comment tracked the old
  // fail-open behavior); materializing the page locally is safe precisely
  // because the reader is gated.
  if (kind === 'role') return { kind: 'role', slug: imUserId };
  if (kind === 'council') return { kind: 'council', id: imUserId };
  if (kind === 'task') return { kind: 'task', id: imUserId };
  return { kind: 'private', imUserId };
}

function rowUpdatedAtMs(row: CloudPageRow): number {
  const v = row.updatedAt;
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Incremental cloud→local sync for one workspace. Idempotent and re-runnable:
 * each invocation materialises pages newer than the persisted watermark and
 * advances it. Safe to call on every daemon boot and on `host.acked`.
 *
 * Guards:
 *   - Skips if no store exists for this workspace (peek returns null).
 *   - Gracefully handles cloud API errors (logs, returns a no-op result).
 *   - Per-page write failures are non-blocking (increment `skipped`).
 */
export async function initialSyncFromCloud(
  runtime: MemoryRuntime,
  cloud: CloudClient,
  workspaceId: string,
  // memory202 doc 06: when provided, encrypted pages pulled from the cloud are
  // decrypted with the per-workspace key before landing as plaintext in local
  // SQLite/FTS. Omitted ⇒ encrypted pages land as the unreadable sentinel
  // (fail-closed). Optional so existing callers/tests that never see encrypted
  // pages need no change.
  keyManager?: MemoryKeyManager,
): Promise<SyncResult> {
  // Only sync for stores that already exist (peek, not resolve — we don't
  // want to implicitly create a store just to check).
  const slot = runtime.peek(workspaceId);
  if (!slot) {
    log.info(`No store for workspace=${workspaceId} — skipping`);
    return { pulled: 0, skipped: 0, upToDate: true };
  }

  // §15.2 — a strict workspace's ONLY legal sync port is the V3 replica path
  // (manifest + content). The legacy pages list would 426; route to the
  // snapshot-fenced reconcile instead (suspend → full reconcile → ready).
  const snapshot = getMemoryAuthoritySnapshot(workspaceId);
  if (snapshot?.replicaMode === 'strict') {
    const result = await reconcileReplicaFromCloud(runtime, cloud, workspaceId, keyManager);
    return {
      pulled: result.pagesApplied,
      skipped: 0,
      upToDate: result.status === 'ready' && result.pagesApplied === 0,
      ...(result.upgradeRequired ? { upgradeRequired: result.upgradeRequired } : {}),
    };
  }

  const watermark = parseWatermark(slot.store.getCursor(workspaceId));
  log.info(
    `Syncing cloud pages for workspace=${workspaceId} (watermark=${watermark || 'cold-start'})...`,
  );

  let pulled = 0;
  let skipped = 0;
  let maxSeen = watermark;
  let offset = 0;
  let truncatedByCloudCap = false;
  let syncFailed = false;

  // Page through the cloud list. Today the cloud endpoint has no offset/cursor
  // (C7), so `offset` is only meaningful once the cloud `since`/pagination
  // lands; against today's cloud the first page is the entire (≤200) result
  // set ordered by updatedAt DESC and the loop terminates after one pass.
  // The client-side watermark filter makes a re-list correct either way.
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const params = new URLSearchParams({
      workspaceId,
      limit: String(CLOUD_PAGE_SIZE),
      stale: 'all',
    });
    if (watermark > 0) {
      // Forward-compatible: cloud ignores these today (C7). Sent so the daemon
      // needs no change once doc 18 §5a `since` lands on the cloud handler.
      params.set('since', String(watermark));
      params.set('updatedSince', new Date(watermark).toISOString());
    }
    if (offset > 0) params.set('offset', String(offset));

    const resp = await cloud.request<{ ok: boolean; data?: CloudPageRow[] }>(
      'GET',
      `/api/im/memory/pages?${params.toString()}`,
      { timeoutMs: 15_000 },
    );

    if (!resp.ok) {
      // §15.2 — 426 MEMORY_RUNTIME_UPGRADE_REQUIRED is a TYPED STOP: the
      // legacy sync signature is refused for this (strict) workspace. No
      // fallback retry of the old path, no watermark advance, no ready
      // marker. The daemon reports the fixed upgrade payload and waits for
      // the strict snapshot to arrive via bootstrap (which routes the next
      // sync to the V3 port).
      if (resp.status === 426) {
        log.warn(
          `Cloud GET /memory/pages refused with 426 (${resp.error?.code ?? 'unknown'}) — ` +
            `legacy daemon sync stopped; upgrade to runtime >= ${MIN_STRICT_RUNTIME_VERSION} required`,
        );
        return {
          pulled,
          skipped,
          upToDate: false,
          upgradeRequired: {
            minRuntimeVersion: MIN_STRICT_RUNTIME_VERSION,
            requiredRuntimeCapabilities: [...MEMORY_RUNTIME_CAPABILITIES_V1],
          },
        };
      }
      log.warn(
        `Cloud GET /memory/pages returned ${resp.status}: ${resp.error?.message ?? 'unknown'}`,
      );
      syncFailed = true;
      break;
    }
    const envelope = resp.data;
    if (!envelope || !envelope.ok) {
      log.info(`Cloud returned non-ok envelope for workspace=${workspaceId}`);
      break;
    }
    const pages = envelope.data;
    if (!pages || !Array.isArray(pages) || pages.length === 0) break;

    for (const page of pages) {
      const updatedAtMs = rowUpdatedAtMs(page);
      // Watermark filter — applied client-side because cloud ignores `since`
      // today (C7). A row at exactly the watermark was already materialised.
      if (watermark > 0 && updatedAtMs > 0 && updatedAtMs <= watermark) {
        continue;
      }
      if (updatedAtMs > maxSeen) maxSeen = updatedAtMs;

      const written = await materialisePage(cloud, slot, workspaceId, page, keyManager);
      if (written) pulled++;
      else skipped++;
    }

    // Cloud has no pagination yet (C7): a full page means we hit the 200 cap
    // and there may be more rows we cannot reach. Record the limitation, then
    // stop — looping with `offset` would just re-fetch the same 200 rows.
    if (pages.length >= CLOUD_PAGE_SIZE) {
      truncatedByCloudCap = true;
      break;
    }
    // Short page → end of the result set.
    break;
  }

  // Advance the watermark only when we actually saw newer rows; never regress.
  if (maxSeen > watermark) {
    slot.store.recordCursor(workspaceId, `${WATERMARK_PREFIX}${maxSeen}`);
  } else if (watermark === 0) {
    // Cold-start with an empty cloud workspace: stamp a watermark of "now" so
    // we don't keep treating it as a cold-start full pull on every boot.
    slot.store.recordCursor(workspaceId, `${WATERMARK_PREFIX}${Date.now()}`);
  }

  // §9.4 — a completed LEGACY sync marks the replica state ready with
  // accessVersion=0 (old semantics preserved; never strict authorization,
  // never a downgrade of an existing strict epoch). Skipped when the sync
  // errored (a refused/failed pull must not re-open recall).
  if (!syncFailed) {
    slot.store.markLegacyReplicaReady(slot.store.getCursor(workspaceId));
  }

  if (truncatedByCloudCap) {
    log.warn(
      `workspace=${workspaceId} hit the cloud 200-page cap (C7: cloud /memory/pages lacks since/offset) — ` +
        `${pulled} materialised this pass; remaining rows will pull on subsequent syncs as the watermark advances`,
    );
  }
  log.info(
    `Synced ${pulled} page(s)${skipped ? `, ${skipped} skipped` : ''} for workspace=${workspaceId} ` +
      `(watermark ${watermark} → ${Math.max(maxSeen, watermark)})`,
  );

  // M-LINK-SYNC: pull page→page links so the local `memory_links` table is
  // populated, which lights up local graph traversal (MemorySearch.expandViaGraph
  // → store.linkNeighbors). Best-effort + non-blocking: a link-sync failure must
  // never regress the page sync above, so we swallow errors here.
  await syncLinksFromCloud(cloud, slot, workspaceId).catch((err) => {
    log.warn(`link sync failed for workspace=${workspaceId} (non-blocking): ${(err as Error).message}`);
  });

  return { pulled, skipped, upToDate: pulled === 0 };
}

/**
 * memory203 doc 07 §3 — targeted single-page回源 for the local-first `load`
 * fallback. When `load(prismer://…/memory/<path>)` misses the daemon subset,
 * the RPC handler calls this to pull JUST that page from the cloud superset
 * (`GET /api/im/memory/resolve?uri=`), materialise it into the local store
 * (reusing `materialisePage` → identical decrypt + visibility + write as the
 * whole-workspace sync), and let the handler re-load it locally (<5ms, FTS).
 *
 * Returns true when a page was materialised. STRICTLY best-effort + local-first:
 * any cloud error / offline / miss → false (the handler then 404s as a genuine
 * miss). Never throws — "断云仍 load 本地" must hold, so a回源 failure degrades
 * to "page not found", never to a 5xx.
 *
 * Note: no `#section` is sent — we always fetch the WHOLE page so the local
 * cache holds the full body; the handler slices the section locally afterwards.
 */
export async function fetchPageFromCloudByPath(
  cloud: CloudClient,
  runtime: MemoryRuntime,
  workspaceId: string,
  pagePath: string,
  keyManager?: MemoryKeyManager,
): Promise<boolean> {
  try {
    const slot = runtime.resolve(workspaceId); // ensure a store exists to write into
    // memory203/18 W2 P0 — normalized composition (strips a leading `memory/`
    // so a caller passing either path convention resolves the same cloud page).
    const uri = memoryPathToUri(workspaceId, pagePath);
    const params = new URLSearchParams({ uri, format: 'markdown' });
    const resp = await cloud.request<{
      ok: boolean;
      data?: {
        kind?: string;
        hit?: boolean;
        page?: (CloudPageRow & { content?: string | null }) | null;
        content?: string | null;
      };
    }>('GET', `/api/im/memory/resolve?${params.toString()}`, { timeoutMs: 10_000 });

    if (!resp.ok || !resp.data?.ok) return false;
    const result = resp.data.data;
    if (!result || result.kind !== 'page' || !result.hit || !result.page) return false;

    const p = result.page;
    // /resolve splits metadata (page) from body (content); fold them back into
    // the CloudPageRow shape materialisePage consumes.
    const row: CloudPageRow = {
      id: p.id,
      path: p.path,
      title: p.title ?? null,
      content: result.content ?? p.content ?? '',
      pageType: p.pageType,
      visibility: p.visibility,
      encrypted: p.encrypted ?? null,
      updatedAt: p.updatedAt ?? null,
      syncStatus: (p as { syncStatus?: string | null }).syncStatus ?? null,
      version: typeof (p as { version?: unknown }).version === 'number' ? (p as { version: number }).version : null,
    };
    return await materialisePage(cloud, slot, workspaceId, row, keyManager);
  } catch (err) {
    log.info(
      `single-page回源 miss for workspace=${workspaceId} path=${pagePath} (non-blocking, local-first): ${(err as Error).message}`,
    );
    return false;
  }
}

/** One cloud link row from `GET /memory/links/sync`. */
interface CloudLinkRow {
  sourcePageId?: string | null;
  sourceUri?: string | null;
  targetUri?: string | null;
  relation?: string | null;
  weight?: number | null;
  broken?: boolean | null;
}

/**
 * Pull the workspace's page→page links from the cloud and materialise them into
 * the daemon-local `memory_links` table via `store.upsertLink`. Append-only /
 * CRDT-trivial (doc 07 §2): links never conflict, and `upsertLink` keys on the
 * `(workspaceId, sourceUri, targetUri, relation)` @unique, so a re-pull is fully
 * idempotent (no duplicate rows).
 *
 * Today this does a bounded full pull (no client watermark): the daemon-local
 * link set is small and the idempotent upsert makes re-listing free, so we
 * favour correctness/simplicity over a separate link cursor. The cloud
 * `/links/sync` endpoint already accepts a `since` watermark + `offset` for when
 * a link-specific cursor is wired; the daemon needs no change then.
 *
 * Best-effort: cloud errors / per-row write failures are logged, never thrown —
 * the caller treats this as non-blocking relative to the page sync.
 */
async function syncLinksFromCloud(
  cloud: CloudClient,
  slot: NonNullable<ReturnType<MemoryRuntime['peek']>>,
  workspaceId: string,
): Promise<void> {
  const params = new URLSearchParams({ workspaceId, limit: String(CLOUD_LINK_PAGE_SIZE) });
  const resp = await cloud.request<{ ok: boolean; data?: CloudLinkRow[] }>(
    'GET',
    `/api/im/memory/links/sync?${params.toString()}`,
    { timeoutMs: 15_000 },
  );
  if (!resp.ok) {
    log.warn(`Cloud GET /memory/links/sync returned ${resp.status}: ${resp.error?.message ?? 'unknown'}`);
    return;
  }
  const links = resp.data?.data;
  if (!links || !Array.isArray(links) || links.length === 0) return;

  let written = 0;
  let skipped = 0;
  for (const link of links) {
    // Skip rows missing the URIs that key the local table; broken links carry
    // no useful neighbour edge, so they're skipped too (the local graph only
    // wants live edges — mirrors store.linkNeighbors' archived/stale filtering).
    if (!link.sourceUri || !link.targetUri || link.broken) {
      skipped++;
      continue;
    }
    try {
      slot.store.upsertLink({
        sourceUri: link.sourceUri,
        targetUri: link.targetUri,
        relation: link.relation || 'markdown',
        weight: typeof link.weight === 'number' ? link.weight : 1,
        extractedFromPageId: link.sourcePageId ?? null,
      });
      written++;
    } catch (err) {
      skipped++;
      log.warn(`upsertLink failed (${link.sourceUri} → ${link.targetUri}): ${(err as Error).message}`);
    }
  }
  log.info(
    `Synced ${written} link(s)${skipped ? `, ${skipped} skipped` : ''} for workspace=${workspaceId}`,
  );
}

/**
 * Materialise one cloud page row into the local store. Fetches the page body
 * via the detail endpoint when the list response omits `content`. Returns true
 * on a successful write, false on a (non-blocking) write failure.
 */
async function materialisePage(
  cloud: CloudClient,
  slot: NonNullable<ReturnType<MemoryRuntime['peek']>>,
  workspaceId: string,
  page: CloudPageRow,
  keyManager?: MemoryKeyManager,
): Promise<boolean> {
  let content = page.content ?? '';
  let encrypted = page.encrypted === true;
  if (!content) {
    try {
      const detailResp = await cloud.request<{
        ok: boolean;
        data?: { content?: string; encrypted?: boolean };
      }>(
        'GET',
        `/api/im/memory/pages/${encodeURIComponent(page.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { timeoutMs: 5000 },
      );
      if (detailResp.ok && detailResp.data?.data?.content) {
        content = detailResp.data.data.content;
        // Trust the detail row's encrypted flag when the list omitted it.
        if (detailResp.data.data.encrypted === true) encrypted = true;
      }
    } catch {
      // Non-blocking — proceed with empty content.
    }
  }

  // memory202 doc 06 — decrypt encrypted ciphertext to plaintext before it lands
  // in local SQLite/FTS (the daemon is the trusted local store; recall + FTS
  // need plaintext). Fail-closed branches:
  //   - no key (cross-device: this device never had the workspace key) → store
  //     the UNREADABLE sentinel marked encrypted=true. NEVER store ciphertext as
  //     content (that would surface gibberish as a real page).
  //   - decrypt throws (tamper / wrong key) → same sentinel. Sync continues; no
  //     crash. The page is visibly unreadable, not silently wrong.
  let storeEncryptedFlag = false;
  if (encrypted && content && isPackedCiphertext(content)) {
    // Internal write-down path (cloud → local) — daemon system cap (doc 08 §2.3).
    const key = keyManager?.getKey(workspaceId, systemCap()) ?? null;
    if (!key) {
      log.warn(
        `page ${page.path} is encrypted but no local key (cross-device / ephemeral) — storing unreadable sentinel (fail-closed)`,
      );
      content = UNREADABLE_SENTINEL;
      storeEncryptedFlag = true;
    } else {
      try {
        content = gcmDecrypt(content, key);
        // Decrypted OK → local store holds plaintext; do NOT mark local row
        // encrypted (local FTS/recall operate on plaintext as designed).
      } catch (err) {
        log.warn(
          `decrypt failed for ${page.path} (${(err as Error).message}) — storing unreadable sentinel (fail-closed)`,
        );
        content = UNREADABLE_SENTINEL;
        storeEncryptedFlag = true;
      }
    }
  }

  const visibility: MemoryVisibility = parseCloudVisibility(page.visibility);

  try {
    const written = slot.store.write({
      workspaceId,
      // Mirror the cloud's canonical id so id-forwarding ops (memory_curate
      // promote-to-hub / supersede, load-by-id) address the right cloud page.
      id: page.id,
      path: page.path,
      title: page.title ?? undefined,
      content: content || '',
      pageType: ((page.pageType as MemoryPageType) || 'leaf') as MemoryPageType,
      visibility,
      encrypted: storeEncryptedFlag,
      // R1.4 — land at the cloud head version (store adopts max(local+1, this))
      // so the next local write's outbox parentVersion matches the cloud head.
      ...(typeof page.version === 'number' && page.version > 0 ? { version: page.version } : {}),
      actorImUserId: 'cloud-sync',
      actorKind: 'agent',
    });

    // memory203 doc 07 — learn-on-re-pull: the cloud is the conflict authority.
    // `write()` always stamps the local row `'local-only'`, so we explicitly set
    // the post-sync state from the cloud's per-page `syncStatus`. When the cloud
    // reports a LIVE remote-conflict for this page (this device's write may have
    // lost LWW), mark the local row `'remote-conflict'` so the host surfaces it
    // (and `/local/memory/conflicts` lists it) without polling the cloud. When
    // the cloud reports no live conflict, mark `'acked'` — the down-sync mirrors
    // the cloud truth source, so a previously-conflicted page that the cloud has
    // since reconciled is cleared. Keyed on the just-written page id (== cloud
    // id), workspace-scoped.
    const cloudStatus = page.syncStatus;
    slot.store.setSyncStatus(written.id, cloudStatus === 'remote-conflict' ? 'remote-conflict' : 'acked');
    return true;
  } catch (err) {
    log.warn(`write failed for ${page.path}: ${(err as Error).message}`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// product209/16 §9.3 — snapshot-fenced full reconcile (Runtime side)
// ═════════════════════════════════════════════════════════════════════════
//
// Wire mirror of the Task 11 manifest/content contract (Cloud:
// src/im/services/memory-replica-{manifest,content}.ts). The ten steps:
//   1. status=reconciling (agent recall closed by the store gate);
//   2. the FIRST manifest page pins accessVersion + subject hash + content
//      high watermark;
//   3. pagination follows the signed cursor chain within the watermark;
//   4. every page re-verifies the pinned epoch/subject (drift → abort);
//   5. content is fetched ONLY via POST /memory/sync/content with the
//      snapshotToken + sourceRevisionId + both hashes; encrypted-pkf verifies
//      transportHash → decrypts → verifies plaintext contentHash; legacy-html
//      lands via the compat text path (never the local PKF write/outbox path);
//   6. every row writes its SORTED replicaActorIds;
//   7. the complete set is diffed against the local CONTROLLED rows
//      (replicaActorIdsJson NOT NULL) — the remainder is deleted;
//   8. epoch/subject re-verified against the LIVE registered snapshot before
//      committing (snapshot invalidated mid-reconcile → abort);
//   9. head mutations + diff/tombstone deletes + cursor/accessVersion/hash/
//      high-watermark/lease/ready commit in ONE SQLite transaction;
//  10. a catch-up pass (fresh no-cursor manifest = new snapshot) re-applies
//      content created DURING the reconcile window (upsert-only, no diff).
//
// Failure at any step → status=suspended (never ready, never half-applied).
// There is no per-replica Cloud ledger: safety comes from the fixed snapshot,
// the final re-verify and the local full diff.

export interface ReconcileResult {
  status: 'ready' | 'suspended';
  pagesApplied: number;
  pagesDeleted: number;
  upgradeRequired?: SyncUpgradeRequired;
}

interface ManifestHeadWire {
  pageId: string;
  path: string;
  title: string | null;
  description: string | null;
  pageType: string;
  version: number;
  sourceKind: MemoryReplicaSourceKind;
  sourceRevisionId: string;
  contentEncoding: 'utf-8' | 'prismer-gcm-packed-v1';
  contentHash: string;
  transportHash: string;
  visibility?: { kind?: string; subjectId?: string } | null;
  replicaActorIds?: readonly string[] | null;
  encrypted?: boolean | null;
  stale?: boolean | null;
  sourceRefs?: readonly string[] | null;
  updatedAt?: string | null;
}

interface ManifestTombstoneWire {
  pageId: string;
  path?: string;
}

interface ManifestDataWire {
  schemaVersion?: number;
  mode?: string;
  snapshotAccessVersion: number;
  replicaSubjectHash: string;
  snapshotToken: string;
  contentHighWatermark: { updatedAt: string; id: string };
  nextCursor: string | null;
  hasMore: boolean;
  heads: ManifestHeadWire[];
  tombstones: ManifestTombstoneWire[];
}

interface ContentDataWire {
  schemaVersion?: number;
  pageId: string;
  sourceKind: MemoryReplicaSourceKind;
  contentHash: string;
  transportHash: string;
  contentEncoding: 'utf-8' | 'prismer-gcm-packed-v1';
  content: string;
}

const REPLICA_SCHEMA_VERSION = 1;

function sha256Hex(s: string): string {
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

/** Project the manifest visibility wire onto the daemon visibility kind. */
function manifestVisibility(
  v: ManifestHeadWire['visibility'],
): { kind: string; imUserId: string | null } {
  const kind = v?.kind;
  const subject = v?.subjectId ?? null;
  if (!kind) return { kind: 'workspace', imUserId: null };
  switch (kind) {
    case 'workspace':
      return { kind: 'workspace', imUserId: null };
    case 'agent':
      return { kind: 'agent', imUserId: subject };
    case 'role':
      return { kind: 'role', imUserId: subject }; // slug stored in visibilityImUserId
    case 'council':
      return { kind: 'council', imUserId: subject };
    case 'task':
      return { kind: 'task', imUserId: subject };
    case 'human':
      // §8.3 — down-synced as private:<member>; the boundary predicate reads
      // it via the cap's principal claim (strict principal-id equality).
      return { kind: 'private', imUserId: subject };
    default:
      return { kind: 'private', imUserId: subject };
  }
}

async function fetchManifestPage(
  cloud: CloudClient,
  workspaceId: string,
  daemonId: string,
  cursor: string | undefined,
): Promise<ManifestDataWire> {
  const params = new URLSearchParams({ workspaceId, daemonId, limit: '200' });
  if (cursor) params.set('cursor', cursor);
  const resp = await cloud.request<{ ok: boolean; data?: ManifestDataWire }>(
    'GET',
    `/api/im/memory/sync/manifest?${params.toString()}`,
    { timeoutMs: 15_000 },
  );
  if (!resp.ok) {
    throw new Error(
      `manifest request failed (status=${resp.status} code=${resp.error?.code ?? 'unknown'})`,
    );
  }
  const data = resp.data?.data;
  if (!data) throw new Error('manifest response missing data envelope');
  if (data.schemaVersion !== REPLICA_SCHEMA_VERSION) {
    throw new Error(`manifest schemaVersion ${data.schemaVersion} unsupported`);
  }
  return data;
}

async function fetchContent(
  cloud: CloudClient,
  workspaceId: string,
  daemonId: string,
  snapshotToken: string,
  head: ManifestHeadWire,
): Promise<string> {
  const resp = await cloud.request<{ ok: boolean; data?: ContentDataWire }>(
    'POST',
    `/api/im/memory/sync/content`,
    {
      body: {
        schemaVersion: REPLICA_SCHEMA_VERSION,
        workspaceId,
        daemonId,
        rawCredential: cloud.apiKey,
        snapshotToken,
        pageId: head.pageId,
        sourceKind: head.sourceKind,
        sourceRevisionId: head.sourceRevisionId,
        contentHash: head.contentHash,
        transportHash: head.transportHash,
      },
      timeoutMs: 15_000,
    },
  );
  if (!resp.ok) {
    throw new Error(
      `content fetch failed for ${head.pageId} (status=${resp.status} code=${resp.error?.code ?? 'unknown'})`,
    );
  }
  const data = resp.data?.data;
  if (!data) throw new Error(`content response missing data envelope (${head.pageId})`);
  return data.content;
}

/** §9.3 step 5 — per-sourceKind validation before anything is staged. */
function validateContent(
  head: ManifestHeadWire,
  transportBytes: string,
  keyManager: MemoryKeyManager | undefined,
  workspaceId: string,
): string {
  const transportActual = sha256Hex(transportBytes);
  if (transportActual !== head.transportHash) {
    throw new Error(`transport hash mismatch for ${head.pageId}`);
  }
  if (head.sourceKind === 'encrypted-pkf') {
    // Verify the packed ciphertext FIRST, then decrypt, then verify the
    // plaintext contentHash (the version row's plaintext hash column).
    if (!isPackedCiphertext(transportBytes)) {
      throw new Error(`encrypted-pkf ${head.pageId}: not packed ciphertext`);
    }
    const key = keyManager?.getKey(workspaceId, systemCap()) ?? null;
    if (!key) {
      throw new Error(`encrypted-pkf ${head.pageId}: no local key (fail closed)`);
    }
    let plaintext: string;
    try {
      plaintext = gcmDecrypt(transportBytes, key);
    } catch (err) {
      throw new Error(`encrypted-pkf ${head.pageId}: decrypt failed: ${(err as Error).message}`);
    }
    if (sha256Hex(plaintext) !== head.contentHash) {
      throw new Error(`encrypted-pkf ${head.pageId}: plaintext contentHash mismatch`);
    }
    return plaintext;
  }
  if (sha256Hex(transportBytes) !== head.contentHash) {
    throw new Error(`content hash mismatch for ${head.pageId}`);
  }
  // pkf and legacy-html both land as plaintext; legacy-html is NEVER routed
  // into the local PKF write/patch/outbox path (its sourceKind is preserved
  // on the row and local writes never re-interpret it as canonical PKF).
  return transportBytes;
}

/**
 * §9.3 — full reconcile for a strict workspace. All-or-nothing: on ANY
 * failure the store is left `suspended` (never ready, never half-applied).
 * Steps are numbered per the spec above.
 */
export async function reconcileReplicaFromCloud(
  runtime: MemoryRuntime,
  cloud: CloudClient,
  workspaceId: string,
  keyManager?: MemoryKeyManager,
): Promise<ReconcileResult> {
  const slot = runtime.resolve(workspaceId);
  const store = slot.store;

  // §8.2/§8.3 — the reconcile is fenced by the registered Cloud authority
  // snapshot (workspace/daemon matched, hash-verified, unexpired). No
  // snapshot → nothing to authorize against → suspended (fail closed).
  const snapshot = getMemoryAuthoritySnapshot(workspaceId);
  if (!snapshot || snapshot.replicaMode !== 'strict') {
    store.setReplicaStatus('suspended');
    return { status: 'suspended', pagesApplied: 0, pagesDeleted: 0 };
  }
  const daemonId = snapshot.daemonId;

  // step 1 — reconciling (agent recall closed by the store gate).
  store.setReplicaStatus('reconciling');

  interface Pinned {
    accessVersion: number;
    subjectHash: string;
    watermark: { updatedAt: string; id: string };
  }
  let pinned: Pinned | null = null;

  const abort = (err: unknown): ReconcileResult => {
    // Reconcile failure NEVER advances state: reconciling → suspended.
    store.setReplicaStatus('suspended');
    log.warn(`reconcile aborted for workspace=${workspaceId}: ${(err as Error).message}`);
    return { status: 'suspended', pagesApplied: 0, pagesDeleted: 0 };
  };

  try {
    const heads: ReplicaHeadWrite[] = [];
    const tombstones: string[] = [];

    // steps 2-4 — paginate the manifest; the first page pins the epoch.
    let cursor: string | undefined;
    for (;;) {
      const data = await fetchManifestPage(cloud, workspaceId, daemonId, cursor);
      if (!pinned) {
        pinned = {
          accessVersion: data.snapshotAccessVersion,
          subjectHash: data.replicaSubjectHash,
          watermark: data.contentHighWatermark,
        };
        // step 2 — fix the epoch on the store (still reconciling).
        store.pinReconcileEpoch(
          pinned.accessVersion,
          pinned.subjectHash,
          JSON.stringify(pinned.watermark),
        );
        // The pinned epoch must BE the registered snapshot's epoch — anything
        // else is a drifted/mismatched authority (abort before any write).
        if (
          pinned.accessVersion !== snapshot.accessVersion ||
          pinned.subjectHash !== snapshot.replicaSubjectHash
        ) {
          throw new Error('manifest epoch/subject does not match the registered snapshot');
        }
      } else if (
        // step 4 — every page re-verifies; drift aborts the whole reconcile.
        data.snapshotAccessVersion !== pinned.accessVersion ||
        data.replicaSubjectHash !== pinned.subjectHash
      ) {
        throw new Error('authority drift during manifest pagination');
      }

      for (const head of data.heads) {
        // step 5 — content ONLY via the snapshot-fenced content port.
        const transport = await fetchContent(cloud, workspaceId, daemonId, data.snapshotToken, head);
        const content = validateContent(head, transport, keyManager, workspaceId);
        const vis = manifestVisibility(head.visibility);
        heads.push({
          id: head.pageId,
          path: head.path,
          title: head.title ?? null,
          description: head.description ?? null,
          contentHash: head.contentHash,
          version: head.version,
          pageType: head.pageType,
          visibilityKind: vis.kind,
          visibilityImUserId: vis.imUserId,
          stale: head.stale === true,
          sourceRefsJson: JSON.stringify(head.sourceRefs ?? []),
          sourceKind: head.sourceKind,
          // step 6 — SORTED exact actor set (server-sorted; sorted again here
          // so the persisted column is canonical regardless of wire order).
          replicaActorIdsJson: JSON.stringify([...(head.replicaActorIds ?? [])].sort()),
          content,
          updatedAtMs: head.updatedAt ? Date.parse(head.updatedAt) : Date.now(),
        });
      }
      for (const t of data.tombstones) tombstones.push(t.pageId);

      if (!data.hasMore) break;
      if (!data.nextCursor) throw new Error('manifest hasMore=true without nextCursor');
      cursor = data.nextCursor;
    }

    // step 7 — diff the complete set against the local controlled rows.
    const completeSet = new Set(heads.map((h) => h.id));
    const diffDelete = store.loadReplicaPageIds().filter((id) => !completeSet.has(id));

    // step 8 — re-verify epoch/subject against the LIVE snapshot before commit.
    const live = getMemoryAuthoritySnapshot(workspaceId);
    if (
      !live ||
      live.accessVersion !== pinned!.accessVersion ||
      live.replicaSubjectHash !== pinned!.subjectHash ||
      Date.parse(live.validUntil) <= Date.now()
    ) {
      throw new Error('snapshot invalidated/drifted during reconcile');
    }

    // step 9 — ONE atomic commit: heads + diff/tombstone deletes + state.
    store.applyReplicaCommit({
      heads,
      diffDeletePageIds: diffDelete,
      tombstonePageIds: tombstones,
      state: {
        cursor: null,
        accessVersion: pinned!.accessVersion,
        replicaSubjectHash: pinned!.subjectHash,
        contentHighWatermarkJson: JSON.stringify(pinned!.watermark),
        leaseExpiresAt: Date.parse(live.validUntil),
        status: 'ready',
      },
    });
    const pagesApplied = heads.length;
    const pagesDeleted = diffDelete.length + tombstones.length;

    // step 10 — catch-up pass: a fresh no-cursor manifest (new snapshot token)
    // re-lists everything up to NOW, picking up content created during the
    // reconcile window. Upsert-only (no diff: a partial view must never
    // delete), best-effort (a failure here leaves the state ready — the next
    // reconcile re-catches the window).
    try {
      const again = await fetchManifestPage(cloud, workspaceId, daemonId, undefined);
      if (
        again.snapshotAccessVersion === pinned!.accessVersion &&
        again.replicaSubjectHash === pinned!.subjectHash
      ) {
        const catchUpHeads: ReplicaHeadWrite[] = [];
        for (const head of again.heads) {
          const transport = await fetchContent(cloud, workspaceId, daemonId, again.snapshotToken, head);
          const content = validateContent(head, transport, keyManager, workspaceId);
          const vis = manifestVisibility(head.visibility);
          catchUpHeads.push({
            id: head.pageId,
            path: head.path,
            title: head.title ?? null,
            description: head.description ?? null,
            contentHash: head.contentHash,
            version: head.version,
            pageType: head.pageType,
            visibilityKind: vis.kind,
            visibilityImUserId: vis.imUserId,
            stale: head.stale === true,
            sourceRefsJson: JSON.stringify(head.sourceRefs ?? []),
            sourceKind: head.sourceKind,
            replicaActorIdsJson: JSON.stringify([...(head.replicaActorIds ?? [])].sort()),
            content,
            updatedAtMs: head.updatedAt ? Date.parse(head.updatedAt) : Date.now(),
          });
        }
        store.applyReplicaCommit({
          heads: catchUpHeads,
          diffDeletePageIds: [],
          tombstonePageIds: again.tombstones.map((t) => t.pageId),
          state: {
            cursor: null,
            accessVersion: pinned!.accessVersion,
            replicaSubjectHash: pinned!.subjectHash,
            contentHighWatermarkJson: JSON.stringify(again.contentHighWatermark),
            leaseExpiresAt: Date.parse(live.validUntil),
            status: 'ready',
          },
        });
        log.info(
          `reconcile catch-up for workspace=${workspaceId}: ${catchUpHeads.length} head(s) refreshed`,
        );
      }
    } catch (err) {
      log.warn(
        `reconcile catch-up failed for workspace=${workspaceId} (non-blocking, ready retained): ${(err as Error).message}`,
      );
    }

    log.info(
      `reconcile complete for workspace=${workspaceId}: ${pagesApplied} applied, ${pagesDeleted} deleted`,
    );
    return { status: 'ready', pagesApplied, pagesDeleted };
  } catch (err) {
    return abort(err);
  }
}

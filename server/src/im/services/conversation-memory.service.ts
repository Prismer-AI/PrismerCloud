/**
 * Prismer IM — Conversation Memory Service (release201/26 Phase 1)
 *
 * Cloud-side builder for the L3 input contract `ConversationContextEnvelope`
 * (decision E: envelope is built cloud-side for central observability / A/B /
 * flag rollback). The dispatcher threads the result through
 * `metadata.contextEnvelope`; each adapter implements `renderContextEnvelope`
 * to translate it into its native history shape.
 *
 * Ground truth: docs/release201/26-conversational-memory-plan.md
 *   - §5     envelope protocol
 *   - §5.1   message type → visibility table (dispatch-aware)
 *   - §6     budget (8000 cl100k) + cache-stable ordering + floors
 *   - §10    failure modes — overflow discard order, never drop `recent`
 *   - §9     observability hooks
 *
 * Phase scoping (what this file does NOT do):
 *   - Does NOT touch the dispatcher (task #6). It only exposes
 *     `buildEnvelope` / `buildEnvelopeIfEnabled`; the dispatcher integration
 *     (read `CONTEXT_ENVELOPE_ENABLED`, attach `metadata.contextEnvelope`,
 *     keep the legacy last-20 path on flag-off) is wired separately. See
 *     "Dispatcher integration (#6)" note at the bottom.
 *   - L2 segment *producer* is Phase 2 — Phase 1 only READS segments and must
 *     tolerate an empty set.
 *   - `identifierIndex` / `recentTaskTrace` are Phase 3 — left undefined here,
 *     their budget floors stay reserved but unused (§6).
 */

import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
import type {
  ConversationContextEnvelope,
  EnvelopeRecentEntry,
  EnvelopeSegment,
  EnvelopeQuote,
  EnvelopeBudget,
  ParticipantRef,
  EnvelopeRole,
  EnvelopeSalientFacts,
  EnvelopeAssets,
  EnvelopeIdentifier,
  EnvelopeRecentTaskTrace,
} from '../types/conversation-envelope';
import type { AssetRef } from '../types/im-events';

const log = createModuleLogger('ConversationMemory');

// ─── Budget constants (docs/release201/26 §6) ────────────────────────────────
//
// Total 8000 cl100k tokens. Floors guarantee a minimum slice per category;
// remaining headroom is distributed by the §6 proportions. identifierIndex /
// recentTaskTrace floors are reserved but only bite from Phase 3.
const ENVELOPE_TOTAL_TOKENS = 8000;
const BUDGET_FLOORS = {
  recent: 2000,
  compressedSegments: 800,
  quotes: 300,
  identifierIndex: 200, // Phase 3
  recentTaskTrace: 300, // Phase 3
} as const;
// §6 proportions (recent 50 / segments 25 / quotes 10 / id 7 / trace 8).
const BUDGET_PROPORTIONS = {
  recent: 0.5,
  compressedSegments: 0.25,
  quotes: 0.1,
  identifierIndex: 0.07,
  recentTaskTrace: 0.08,
} as const;

// How many raw L1 messages to pull as the candidate `recent` tail before
// visibility filtering + budget trimming. Larger than the eventual window so
// that visibility-stripped lifecycle/system rows don't starve the tail.
const RECENT_RAW_FETCH_LIMIT = 60;

// Phase 3 — top-K identifiers surfaced in the envelope (§6 floor 200 token).
// Ordered most-recently-referenced first.
const IDENTIFIER_INDEX_TOP_K = 20;

export interface IMMessageLike {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  /** JSON string or already-parsed metadata object. */
  metadata?: string | Record<string, unknown> | null;
  quotedMessageId?: string | null;
  createdAt: Date | string;
}

/**
 * Optional dispatch-time hints. Phase 1 keeps this minimal; later phases may
 * pass intent overrides, model context-window sizing, etc.
 */
export interface DispatchHints {
  /** Override the total token budget (Phase 2 sizes this per model). */
  totalTokens?: number;
  /** Explicit asset intent partition by assetId (Phase 1 UI doesn't set it). */
  assetIntents?: Record<string, 'input' | 'archive'>;
}

// ─── Token estimation (docs/release201/26 §6 — unit is cl100k/tiktoken) ───────
//
// The repo has no tiktoken / gpt-tokenizer dependency (grep-verified
// 2026-05-29). Rather than pull a heavy WASM/native tokenizer into the IM
// request path, Phase 1 uses a conservative chars/4 approximation. Centralised
// here so the Phase 1 `tokenCountCl100k` backfill worker (doc §4 / migration
// 455) can reuse the exact same estimator until it is replaced by a real
// tiktoken pass.
//
// TODO(release201/26 Phase 2): swap for a real cl100k encoder (tiktoken /
// gpt-tokenizer) once the token-count worker is built; keep this signature so
// callers don't change.
export function estimateCl100kTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // chars/4 is the classic OpenAI rule-of-thumb; ceil so non-empty strings
  // never round to 0 tokens.
  return Math.ceil(text.length / 4);
}

// ─── Observability (docs/release201/26 §9) ───────────────────────────────────
//
// The repo's only metrics primitive (`src/lib/metrics.ts`) is a latency-focused
// endpoint/external-API store — not a generic labelled counter/histogram
// registry. Rather than bolt category counters onto it, Phase 1 emits
// structured logs that a log-based metric (or the Phase 2 Prometheus exporter)
// can scrape by name. Names match §9 exactly.
//
// TODO(release201/26 Phase 2): route these through a real counter/histogram
// registry when one lands; the metric names below are the contract.
function emitBuiltMetric(flag: boolean, success: boolean, durationMs: number) {
  // context_envelope_built_total{flag,success} + context_envelope_build_duration_ms
  log.info(
    { metric: 'context_envelope_built_total', flag, success, durationMs },
    `[ConversationMemory] context_envelope_built_total flag=${flag} success=${success} duration_ms=${durationMs}`,
  );
}
function emitOverflowMetric(category: string, droppedTokens: number) {
  // context_envelope_overflow_total{category}
  log.info(
    { metric: 'context_envelope_overflow_total', category, droppedTokens },
    `[ConversationMemory] context_envelope_overflow_total category=${category} dropped_tokens=${droppedTokens}`,
  );
}

function parseMetadata(meta: IMMessageLike['metadata']): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === 'object') return meta as Record<string, unknown>;
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/**
 * docs/release201/26 §5.1 — message type → recent visibility.
 *
 * The doc's row names ("agent_reply", "task.*", "awaiting_human_approval") are
 * a mix of the persisted `type` column and `metadata.kind`. We resolve both:
 *   - `text`/`markdown`/`code`/`image`/`file` + agent_reply  → visible
 *   - `system_event`/`system`/`thinking`/`tool_call`/`tool_result` → stripped
 *   - any `metadata.kind` starting `task.` or approval events  → stripped
 *     (those are metric-only for L2; never fed back into the prompt)
 */
function isVisibleInRecent(type: string, metaKind: unknown): boolean {
  const kind = typeof metaKind === 'string' ? metaKind : '';
  // metric-only / infrastructure kinds — never in recent (§5.1).
  if (
    kind.startsWith('task.') ||
    kind === 'task_status_event' ||
    kind === 'awaiting_human_approval' ||
    kind === 'system_event'
  ) {
    return false;
  }
  // agent_reply rides on a content message type and IS visible.
  if (kind === 'agent_reply') return true;
  switch (type) {
    case 'text':
    case 'markdown':
    case 'code':
    case 'image':
    case 'file':
    case 'artifact':
      return true;
    // Infrastructure / non-content — stripped from recent.
    case 'system':
    case 'system_event':
    case 'thinking':
    case 'tool_call':
    case 'tool_result':
    default:
      return false;
  }
}

/** Map an IMUser.role string onto the envelope role union (best-effort). */
function toEnvelopeRole(role: string | undefined): EnvelopeRole {
  // EnvelopeRole reuses TaskDispatchContextEntry['senderRole']; keep the raw
  // string and let TS narrow — IMUser.role is 'human' | 'agent' | 'admin' and
  // dispatch context already accepts those.
  return (role ?? 'human') as EnvelopeRole;
}

export class ConversationMemoryService {
  /**
   * Build the L3 envelope for a dispatch. Pure read path — never writes.
   *
   * Steps follow docs/release201/26 §5 + §6:
   *   1. conversation base info (type, participants)
   *   2. recent: L1 raw tail, §5.1 visibility-filtered
   *   3. compressedSegments: latest non-superseded range segments (may be empty)
   *   4. quotes: resolve from triggerMessage's quote ref via QuoteCache snapshot
   *   5. assets: partition inputs / archives (Phase 1 heuristic → all inputs)
   *   6. budget: floor-first, then proportional headroom + overflow trimming
   *   7. identifierIndex / recentTaskTrace: Phase 3 (left undefined)
   */
  async buildEnvelope(
    conversationId: string,
    triggerMessage: IMMessageLike,
    hints?: DispatchHints,
  ): Promise<ConversationContextEnvelope> {
    const startedAt = Date.now();
    try {
      // ── 1. conversation base info ──────────────────────────────────────────
      const conversation = await prisma.iMConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, type: true },
      });
      const conversationType: 'direct' | 'group' =
        conversation?.type === 'direct' ? 'direct' : 'group';

      const participantRows = await prisma.iMParticipant.findMany({
        where: { conversationId, leftAt: null },
        include: {
          imUser: {
            select: {
              id: true,
              username: true,
              displayName: true,
              role: true,
              agentType: true,
            },
          },
        },
      });
      type ParticipantRow = {
        imUser: {
          id: string;
          username: string;
          displayName: string;
          role: string;
          agentType: string | null;
        } | null;
      };
      const participants: ParticipantRef[] = (participantRows as ParticipantRow[])
        .filter((p) => p.imUser)
        .map((p) => ({
          imUserId: p.imUser!.id,
          username: p.imUser!.username,
          displayName: p.imUser!.displayName,
          role: p.imUser!.role,
          agentType: p.imUser!.agentType ?? null,
        }));

      // ── 2. recent (L1 raw tail, §5.1 visibility-filtered) ──────────────────
      const rawRecent = await prisma.iMMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_RAW_FETCH_LIMIT,
        select: {
          id: true,
          senderId: true,
          type: true,
          content: true,
          metadata: true,
          createdAt: true,
          attachments: true,
        },
      });
      // findMany returned newest-first; envelope wants oldest-first (§5).
      rawRecent.reverse();

      type RawRow = {
        id: string;
        senderId: string;
        type: string;
        content: string;
        metadata: string | null;
        createdAt: Date;
        attachments: unknown;
      };
      const rawRecentTyped = rawRecent as RawRow[];
      const senderIds = Array.from(new Set(rawRecentTyped.map((m) => m.senderId)));
      const senders = await prisma.iMUser.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, username: true, role: true },
      });
      type SenderRow = { id: string; username: string; role: string };
      const senderById = new Map<string, SenderRow>(
        (senders as SenderRow[]).map((s) => [s.id, s]),
      );

      const recent: EnvelopeRecentEntry[] = [];
      for (const m of rawRecentTyped) {
        const meta = parseMetadata(m.metadata as string);
        if (!isVisibleInRecent(m.type, meta.kind)) continue;
        const sender = senderById.get(m.senderId);
        recent.push({
          messageId: m.id,
          role: toEnvelopeRole(sender?.role),
          sender: sender?.username ?? m.senderId,
          content: m.content ?? '',
          createdAt: toIso(m.createdAt),
          // Asset refs in recent never inline bytes (§5.1). Phase 1 keeps the
          // recent[] asset linkage in the dedicated `assets` partition; per-row
          // assetRefs stay undefined until a UI need surfaces.
        });
      }

      // ── 3. compressedSegments (L2 range, latest non-superseded) ────────────
      // Phase 1 producer doesn't exist yet — this set is routinely empty and
      // MUST be handled gracefully.
      const segmentRows = await prisma.iMConversationCompressedSegment.findMany({
        where: {
          conversationId,
          segmentKind: 'range',
          supersededBy: null,
        },
        orderBy: { segmentSeq: 'asc' },
      });
      type SegmentRow = {
        segmentSeq: number;
        coversFromCreatedAt: Date;
        coversToCreatedAt: Date;
        summary: string;
        salientFactsJson: string;
        coveredRawMessageIdsJson: string;
        tokenCountCl100k: number | null;
      };
      let compressedSegments: EnvelopeSegment[] = (segmentRows as SegmentRow[]).map((s) => {
        let salientFacts: EnvelopeSalientFacts = {};
        try {
          salientFacts = JSON.parse(s.salientFactsJson || '{}') as EnvelopeSalientFacts;
        } catch {
          salientFacts = {};
        }
        let sourceCount = 0;
        try {
          const covered = JSON.parse(s.coveredRawMessageIdsJson || '[]');
          sourceCount = Array.isArray(covered) ? covered.length : 0;
        } catch {
          sourceCount = 0;
        }
        return {
          segmentSeq: s.segmentSeq,
          coversFromAt: toIso(s.coversFromCreatedAt),
          coversToAt: toIso(s.coversToCreatedAt),
          summary: s.summary ?? '',
          salientFacts,
          sourceCount,
          tokenCountCl100k: s.tokenCountCl100k ?? estimateCl100kTokens(s.summary),
        };
      });

      // ── 4. quotes (decision C: ref always raw messageId) ───────────────────
      let quotes: EnvelopeQuote[] = await this.resolveQuotes(
        conversationId,
        triggerMessage,
      );

      // ── 4b. identifierIndex (Phase 3) ─────────────────────────────────────
      // Top-K most-recently-referenced identifiers for this conversation. The
      // schema bumps `updatedAt` on every sighting (upsert), so updatedAt-desc
      // is the "lastReferenced new→old" order; `lastSeenAt` surfaces it.
      const identifierIndex = await this.loadIdentifierIndex(conversationId);

      // ── 4c. recentTaskTrace (Phase 3) ─────────────────────────────────────
      // The single most-recent task_trace L2 segment for this conversation.
      const recentTaskTrace = await this.loadRecentTaskTrace(conversationId);

      // ── 5. assets (decision D heuristic → Phase 1 defaults all to inputs) ──
      const assets = this.partitionAssets(rawRecentTyped, hints);

      // ── 6. budget (floor-first, proportional headroom, overflow trimming) ──
      const totalTokens = hints?.totalTokens ?? ENVELOPE_TOTAL_TOKENS;
      const budget: EnvelopeBudget = {
        totalTokens,
        floors: { ...BUDGET_FLOORS },
      };

      const trimmed = this.enforceBudget(totalTokens, {
        recent,
        compressedSegments,
        quotes,
        identifierIndex,
      });
      compressedSegments = trimmed.compressedSegments;
      quotes = trimmed.quotes;

      const envelope: ConversationContextEnvelope = {
        envelopeVersion: 1,
        conversationId,
        conversationType,
        participants,
        recent: trimmed.recent,
        compressedSegments,
        quotes,
        // ── 7. Phase 3 — identifierIndex + recentTaskTrace ────────────────────
        // Only emitted when non-empty/present so flag-off shape (Phase 1/2)
        // stays byte-identical for adapters that don't consume them yet.
        ...(trimmed.identifierIndex.length ? { identifierIndex: trimmed.identifierIndex } : {}),
        ...(recentTaskTrace ? { recentTaskTrace } : {}),
        assets,
        budget,
      };

      emitBuiltMetric(true, true, Date.now() - startedAt);
      return envelope;
    } catch (err) {
      emitBuiltMetric(true, false, Date.now() - startedAt);
      log.error(
        { err, conversationId },
        '[ConversationMemory] ❌ buildEnvelope failed',
      );
      throw err;
    }
  }

  /**
   * Flag-gated entry point for the dispatcher (#6). Returns the envelope when
   * `CONTEXT_ENVELOPE_ENABLED` is on, otherwise `null` so the caller falls back
   * to the legacy `metadata.context` (last-20) path in message.service.ts.
   *
   * Imported lazily so this service has no eager dependency on the feature-flag
   * module's Nacos init order.
   */
  async buildEnvelopeIfEnabled(
    conversationId: string,
    triggerMessage: IMMessageLike,
    hints?: DispatchHints,
  ): Promise<ConversationContextEnvelope | null> {
    const { FEATURE_FLAGS } = await import('../../lib/feature-flags');
    if (!FEATURE_FLAGS.CONTEXT_ENVELOPE_ENABLED) {
      emitBuiltMetric(false, true, 0);
      return null;
    }
    return this.buildEnvelope(conversationId, triggerMessage, hints);
  }

  /**
   * Resolve quote snapshots for the trigger message. Decision C: the ref always
   * points at the raw `quotedMessageId`. We read the `IMConversationQuoteCache`
   * snapshot (resilient to source deletion via `sourceDeletedAt`); if no
   * snapshot row exists yet (the quote-cache write is always-on but may lag),
   * fall back to a live read of the quoted raw message.
   */
  private async resolveQuotes(
    conversationId: string,
    triggerMessage: IMMessageLike,
  ): Promise<EnvelopeQuote[]> {
    // Collect quoted ids from the first-class column and metadata.quotes[].
    const quotedIds = new Set<string>();
    if (triggerMessage.quotedMessageId) quotedIds.add(triggerMessage.quotedMessageId);
    const meta = parseMetadata(triggerMessage.metadata);
    const metaQuotes = meta.quotes;
    if (Array.isArray(metaQuotes)) {
      for (const q of metaQuotes) {
        if (typeof q === 'string') quotedIds.add(q);
        else if (q && typeof q === 'object' && typeof (q as any).quotedMessageId === 'string') {
          quotedIds.add((q as any).quotedMessageId);
        }
      }
    }
    if (quotedIds.size === 0) return [];

    const ids = Array.from(quotedIds);
    const snapshots = await prisma.iMConversationQuoteCache.findMany({
      where: {
        quotingMessageId: triggerMessage.id,
        quotedMessageId: { in: ids },
      },
    });
    type QuoteSnapshotRow = {
      quotedMessageId: string;
      snapshotContent: string;
      snapshotSender: string;
      snapshotCreatedAt: Date;
      sourceDeletedAt: Date | null;
    };
    const snapById = new Map<string, QuoteSnapshotRow>(
      (snapshots as QuoteSnapshotRow[]).map((s) => [s.quotedMessageId, s]),
    );

    // Any ids missing a snapshot → live fallback read of the raw message.
    const missing = ids.filter((id) => !snapById.has(id));
    const liveById = new Map<
      string,
      { content: string; senderId: string; createdAt: Date }
    >();
    if (missing.length > 0) {
      const rawRows = await prisma.iMMessage.findMany({
        where: { id: { in: missing } },
        select: { id: true, content: true, senderId: true, createdAt: true },
      });
      type LiveRawRow = { id: string; content: string; senderId: string; createdAt: Date };
      const rawRowsTyped = rawRows as LiveRawRow[];
      const liveSenderIds = Array.from(new Set(rawRowsTyped.map((r) => r.senderId)));
      const liveSenders = await prisma.iMUser.findMany({
        where: { id: { in: liveSenderIds } },
        select: { id: true, username: true },
      });
      type LiveSenderRow = { id: string; username: string };
      const liveSenderName = new Map<string, string>(
        (liveSenders as LiveSenderRow[]).map((s) => [s.id, s.username]),
      );
      for (const r of rawRowsTyped) {
        liveById.set(r.id, {
          content: r.content ?? '',
          senderId: liveSenderName.get(r.senderId) ?? r.senderId,
          createdAt: r.createdAt,
        });
      }
    }

    // release201/26 §13.4a P2 — re-attach image assets from the quoted (older)
    // messages so the adapter can re-inject them as image parts in the current
    // turn. The quote text snapshot does NOT carry asset linkage (it's a plain
    // content/sender/createdAt snapshot), so this is resolved LIVE off the
    // quoted message's metadata/attachments (asset storage is immutable; a
    // persisted-at-quote-time snapshot is a future TODO). Skipped silently for
    // quotes with no image assets (the common case).
    const imageRefsByQuoted = await this.resolveQuoteImageRefs(ids);

    const quotes: EnvelopeQuote[] = [];
    for (const id of ids) {
      const imgRefs = imageRefsByQuoted.get(id);
      const imgPart = imgRefs && imgRefs.length > 0 ? { imageAssetRefs: imgRefs } : {};
      const snap = snapById.get(id);
      if (snap) {
        quotes.push({
          quotedMessageId: id,
          snippet: snap.snapshotContent ?? '',
          quotedSender: snap.snapshotSender,
          quotedAt: toIso(snap.snapshotCreatedAt),
          ...(snap.sourceDeletedAt
            ? { sourceDeletedAt: toIso(snap.sourceDeletedAt) }
            : {}),
          ...imgPart,
        });
        continue;
      }
      const live = liveById.get(id);
      if (live) {
        quotes.push({
          quotedMessageId: id,
          snippet: live.content,
          quotedSender: live.senderId,
          quotedAt: toIso(live.createdAt),
          ...imgPart,
        });
      }
      // id with neither snapshot nor live row = quoted source fully gone and
      // no snapshot was ever written; silently skip (cannot fabricate a
      // snippet). Phase 1 always-on quote-cache write should make this rare.
    }
    return quotes;
  }

  /**
   * release201/26 §13.4a P2 — resolve the image AssetRefs attached to each
   * quoted message id, keyed by quotedMessageId. Returns an empty map when no
   * quoted message has image assets.
   *
   * Asset-id discovery mirrors message.service's `extractAttachedAssetIds`
   * (attachments[] + metadata.attachments[]); we then query IMAsset for the
   * image-mime/image-kind subset and project each into an `AssetRef` that
   * CARRIES `cdnUrl` so the adapter can re-inject it as an image_url part
   * without the daemon having to re-resolve a message it never saw.
   */
  private async resolveQuoteImageRefs(
    quotedIds: string[],
  ): Promise<Map<string, AssetRef[]>> {
    const out = new Map<string, AssetRef[]>();
    if (quotedIds.length === 0) return out;

    let msgRows: Array<{ id: string; metadata: string | null; attachments: unknown }> = [];
    try {
      msgRows = ((await prisma.iMMessage.findMany({
        where: { id: { in: quotedIds } },
        select: { id: true, metadata: true, attachments: true },
      })) ?? []) as Array<{ id: string; metadata: string | null; attachments: unknown }>;
    } catch (err) {
      // Image re-injection is best-effort: a query failure must never break the
      // text quote path. Log and return no image refs.
      log.warn(
        { err, quotedIds: quotedIds.slice(0, 5) },
        '[ConversationMemory] quote image-ref lookup failed — quotes degrade to text-only',
      );
      return out;
    }

    // assetId → list of quotedMessageIds that reference it (an asset may be
    // quoted from more than one message; we attach it to each).
    const assetToQuoted = new Map<string, Set<string>>();
    const allAssetIds = new Set<string>();
    for (const m of msgRows) {
      const ids = this.extractMessageAssetIds(m.attachments, m.metadata);
      for (const aid of ids) {
        allAssetIds.add(aid);
        let set = assetToQuoted.get(aid);
        if (!set) {
          set = new Set<string>();
          assetToQuoted.set(aid, set);
        }
        set.add(m.id);
      }
    }
    if (allAssetIds.size === 0) return out;

    type AssetRow = {
      id: string;
      contentHash: string;
      mime: string | null;
      sizeBytes: bigint | null;
      kind: string;
      workspaceId: string;
      cdnUrl: string | null;
    };
    let assetRows: AssetRow[] = [];
    try {
      assetRows = ((await prisma.iMAsset.findMany({
        where: { id: { in: Array.from(allAssetIds) }, deletedAt: null },
        select: {
          id: true,
          contentHash: true,
          mime: true,
          sizeBytes: true,
          kind: true,
          workspaceId: true,
          cdnUrl: true,
        },
      })) ?? []) as AssetRow[];
    } catch (err) {
      log.warn(
        { err },
        '[ConversationMemory] quote image-asset hydrate failed — quotes degrade to text-only',
      );
      return out;
    }

    for (const a of assetRows) {
      // Image-only: mime image/* OR kind 'image'. Non-image quoted attachments
      // (pdf/pptx/text) are out of scope — they don't suffer the cross-turn
      // vision blindness and are surfaced via the normal asset-block path.
      const isImage = a.kind === 'image' || (a.mime?.startsWith('image/') ?? false);
      if (!isImage) continue;
      const ref: AssetRef = {
        assetId: a.id,
        contentHash: a.contentHash,
        mime: a.mime,
        sizeBytes: a.sizeBytes !== null ? Number(a.sizeBytes) : null,
        kind: a.kind,
        workspaceId: a.workspaceId,
        role: 'attachment',
        ...(a.cdnUrl ? { cdnUrl: a.cdnUrl } : {}),
      };
      const quotedFor = assetToQuoted.get(a.id);
      if (!quotedFor) continue;
      for (const qid of quotedFor) {
        const list = out.get(qid) ?? [];
        list.push(ref);
        out.set(qid, list);
      }
    }
    return out;
  }

  /**
   * Extract asset ids referenced by a message's `attachments` array +
   * `metadata.attachments` / `metadata.assetIds` (mirrors message.service's
   * `extractAttachedAssetIds`, tolerant of the `String @db.Text` metadata blob).
   */
  private extractMessageAssetIds(attachments: unknown, metadata: unknown): string[] {
    const out = new Set<string>();
    const fromArray = (raw: unknown): void => {
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const obj = item as Record<string, unknown>;
        const id =
          (typeof obj.assetId === 'string' && obj.assetId) ||
          (typeof obj.id === 'string' && obj.id) ||
          '';
        if (id) out.add(id);
      }
    };
    fromArray(attachments);
    let meta: Record<string, unknown> = {};
    if (typeof metadata === 'string') {
      try {
        const parsed = JSON.parse(metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        meta = {};
      }
    } else if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      meta = metadata as Record<string, unknown>;
    }
    fromArray(meta.attachments);
    if (meta.asset) fromArray([meta.asset]);
    if (Array.isArray(meta.assetIds)) {
      for (const id of meta.assetIds) {
        if (typeof id === 'string' && id.length > 0) out.add(id);
      }
    }
    return Array.from(out);
  }

  /**
   * Phase 3 — load the conversation's top-K identifier index entries, ordered
   * most-recently-referenced first. `lastSeenAt` is the row's `updatedAt` (bumped
   * on every sighting upsert in conversation-identifier.service).
   */
  private async loadIdentifierIndex(conversationId: string): Promise<EnvelopeIdentifier[]> {
    const rows = (await prisma.iMConversationIdentifierIndex.findMany({
      where: { conversationId },
      orderBy: { updatedAt: 'desc' },
      take: IDENTIFIER_INDEX_TOP_K,
      select: {
        identifierKind: true,
        canonicalId: true,
        displayLabel: true,
        updatedAt: true,
      },
    })) as Array<{
      identifierKind: string;
      canonicalId: string;
      displayLabel: string | null;
      updatedAt: Date;
    }>;
    return rows.map((r) => ({
      kind: r.identifierKind,
      canonicalId: r.canonicalId,
      displayLabel: r.displayLabel ?? r.canonicalId,
      lastSeenAt: toIso(r.updatedAt),
    }));
  }

  /**
   * Phase 3 — load the most-recent non-superseded task_trace L2 segment and
   * project it into the envelope's `recentTaskTrace` shape. Returns undefined
   * when no task has completed in this conversation yet.
   */
  private async loadRecentTaskTrace(
    conversationId: string,
  ): Promise<EnvelopeRecentTaskTrace | undefined> {
    const row = (await prisma.iMConversationCompressedSegment.findFirst({
      where: { conversationId, segmentKind: 'task_trace', supersededBy: null },
      orderBy: { segmentSeq: 'desc' },
      select: { salientFactsJson: true },
    })) as { salientFactsJson: string } | null;
    if (!row) return undefined;
    let facts: {
      taskId?: unknown;
      toolsUsed?: unknown;
      outputs?: unknown;
      decisions?: unknown;
    } = {};
    try {
      facts = JSON.parse(row.salientFactsJson || '{}');
    } catch {
      facts = {};
    }
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
      taskId: typeof facts.taskId === 'string' ? facts.taskId : '',
      toolsUsed: arr(facts.toolsUsed),
      outputs: arr(facts.outputs),
      decisions: arr(facts.decisions),
    };
  }

  /**
   * Partition recent-message assets into inputs vs archives (decision D).
   *
   * Phase 1: there's no UI intent signal on `AssetRef` (the wire type carries
   * `role: 'attachment' | 'context'`, not an input/archive intent), so the
   * heuristic ("≤3 = input, 4th+ = archive") cannot be applied without intent
   * metadata. We default everything to `inputs` and honour an explicit
   * `hints.assetIntents` override when the dispatcher supplies one.
   *
   * TODO(release201/26 Phase 2/D): once the single-Attach UI stamps an intent
   * onto the asset (or a derived metadata field), apply the ≤3-input / 4th+-
   * archive heuristic here and drop the all-inputs default.
   */
  private partitionAssets(
    rawRecent: Array<{
      attachments?: unknown;
      metadata?: unknown;
    }>,
    hints?: DispatchHints,
  ): EnvelopeAssets {
    const inputs: AssetRef[] = [];
    const archives: AssetRef[] = [];
    const seen = new Set<string>();

    for (const m of rawRecent) {
      const refs = this.extractAssetRefs(m.attachments, m.metadata);
      for (const ref of refs) {
        if (seen.has(ref.assetId)) continue;
        seen.add(ref.assetId);
        const intent = hints?.assetIntents?.[ref.assetId];
        if (intent === 'archive') archives.push(ref);
        else inputs.push(ref); // Phase 1 default → input
      }
    }
    return { inputs, archives };
  }

  /**
   * Best-effort AssetRef extraction from a message's `attachments` JSON.
   * Tolerant of shape drift — anything missing the required fields is skipped.
   */
  private extractAssetRefs(attachments: unknown, _metadata: unknown): AssetRef[] {
    const out: AssetRef[] = [];
    const list = Array.isArray(attachments) ? attachments : [];
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      const att = a as Record<string, unknown>;
      const assetId = att.assetId;
      if (typeof assetId !== 'string') continue;
      out.push({
        assetId,
        contentHash: typeof att.contentHash === 'string' ? att.contentHash : '',
        mime: typeof att.mime === 'string' ? att.mime : null,
        sizeBytes: typeof att.sizeBytes === 'number' ? att.sizeBytes : null,
        kind: typeof att.kind === 'string' ? att.kind : 'file',
        workspaceId: typeof att.workspaceId === 'string' ? att.workspaceId : '',
        role: att.role === 'context' ? 'context' : 'attachment',
      });
    }
    return out;
  }

  /**
   * Enforce the 8000-token budget (docs/release201/26 §6 + §10).
   *
   * Algorithm:
   *   1. Floor-first: each category keeps at least its floor.
   *   2. Headroom (total − sum(floors)) distributed by §6 proportions.
   *   3. Per-category cap = floor + proportional share.
   *   4. Overflow discard order (§10): identifierIndex → quotes → oldest
   *      segment → NEVER drop `recent`.
   *
   * `recent` is sacrosanct: even if it alone blows the cap we keep it whole
   * (§10 "永不丢 recent"). The trimming targets identifierIndex/segments/quotes.
   */
  private enforceBudget(
    totalTokens: number,
    parts: {
      recent: EnvelopeRecentEntry[];
      compressedSegments: EnvelopeSegment[];
      quotes: EnvelopeQuote[];
      identifierIndex: EnvelopeIdentifier[];
    },
  ): {
    recent: EnvelopeRecentEntry[];
    compressedSegments: EnvelopeSegment[];
    quotes: EnvelopeQuote[];
    identifierIndex: EnvelopeIdentifier[];
  } {
    const recentTokens = parts.recent.reduce(
      (sum, e) => sum + estimateCl100kTokens(e.content),
      0,
    );

    // Per-category caps: floor + proportional headroom.
    const sumFloors =
      BUDGET_FLOORS.recent +
      BUDGET_FLOORS.compressedSegments +
      BUDGET_FLOORS.quotes +
      BUDGET_FLOORS.identifierIndex +
      BUDGET_FLOORS.recentTaskTrace;
    const headroom = Math.max(0, totalTokens - sumFloors);
    const segCap =
      BUDGET_FLOORS.compressedSegments +
      Math.floor(headroom * BUDGET_PROPORTIONS.compressedSegments);
    const quoteCap =
      BUDGET_FLOORS.quotes + Math.floor(headroom * BUDGET_PROPORTIONS.quotes);
    const idCap =
      BUDGET_FLOORS.identifierIndex +
      Math.floor(headroom * BUDGET_PROPORTIONS.identifierIndex);

    // recent is never trimmed (§10). Its overrun eats into the global budget,
    // which we then recover from identifierIndex/segments/quotes below.
    const recentOverrun = Math.max(0, recentTokens - BUDGET_FLOORS.recent);

    let quotes = parts.quotes;
    let compressedSegments = parts.compressedSegments;
    let identifierIndex = parts.identifierIndex;

    // ── discard step 0: identifierIndex (first to go, §10 order) ────────────
    // Each entry's token cost ≈ "kind canonicalId displayLabel" string. Drop
    // from the TAIL (least-recently-referenced; array is most-recent-first).
    const idTokenOf = (e: EnvelopeIdentifier): number =>
      estimateCl100kTokens(`${e.kind} ${e.canonicalId} ${e.displayLabel}`);
    let idTokens = identifierIndex.reduce((sum, e) => sum + idTokenOf(e), 0);
    if (idTokens > idCap) {
      let dropped = 0;
      while (identifierIndex.length > 0 && idTokens > idCap) {
        const removed = identifierIndex[identifierIndex.length - 1];
        identifierIndex = identifierIndex.slice(0, -1);
        const t = idTokenOf(removed);
        idTokens -= t;
        dropped += t;
      }
      if (dropped > 0) emitOverflowMetric('identifierIndex', dropped);
    }

    // ── discard step 1: quotes (after identifierIndex, which is empty) ──────
    let quoteTokens = quotes.reduce(
      (sum, q) => sum + estimateCl100kTokens(q.snippet),
      0,
    );
    const quoteBudget = Math.max(0, quoteCap - recentOverrun);
    if (quoteTokens > quoteBudget) {
      // Drop oldest quotes (front of array) until under budget. Quotes are
      // appended in trigger order, so index 0 is the least-recently referenced.
      let dropped = 0;
      while (quotes.length > 0 && quoteTokens > quoteBudget) {
        const removed = quotes[0];
        quotes = quotes.slice(1);
        const t = estimateCl100kTokens(removed.snippet);
        quoteTokens -= t;
        dropped += t;
      }
      if (dropped > 0) emitOverflowMetric('quotes', dropped);
    }

    // ── discard step 2: oldest segments ─────────────────────────────────────
    let segTokens = compressedSegments.reduce(
      (sum, s) => sum + (s.tokenCountCl100k || estimateCl100kTokens(s.summary)),
      0,
    );
    // Recover any remaining recent overrun from the segment budget too.
    const consumedByQuotes = quoteTokens;
    const segBudget = Math.max(
      0,
      segCap - Math.max(0, recentOverrun - (quoteCap - consumedByQuotes)),
    );
    if (segTokens > segBudget) {
      let dropped = 0;
      // compressedSegments is segmentSeq-ascending → index 0 is the OLDEST.
      while (compressedSegments.length > 0 && segTokens > segBudget) {
        const removed = compressedSegments[0];
        compressedSegments = compressedSegments.slice(1);
        const t = removed.tokenCountCl100k || estimateCl100kTokens(removed.summary);
        segTokens -= t;
        dropped += t;
      }
      if (dropped > 0) emitOverflowMetric('compressedSegments', dropped);
    }

    return { recent: parts.recent, compressedSegments, quotes, identifierIndex };
  }
}

// Singleton convenience (mirrors other IM services' usage pattern).
export const conversationMemoryService = new ConversationMemoryService();

// ─── tokenCountCl100k backfill worker (release201/26 Phase 1, task #3) ────────
//
// `IMMessage.tokenCountCl100k Int?` is a nullable cache of each message's
// cl100k token estimate, used by the envelope budget (§6) so it doesn't have
// to re-estimate every recent row on every dispatch. New rows are written
// without it (the send() hot path stays cheap), so a low-frequency background
// worker fills the gap for `tokenCountCl100k IS NULL` rows.
//
// SAFETY: `tokenCountCl100k` is NOT part of the message canonical signing
// string (grep-verified: signing.service builds its canonical string from
// type/content/createdAt/sequence/hashes, never tokenCountCl100k). Updating
// this column therefore does NOT invalidate any message signature — it's a
// pure server-side cache column.
const BACKFILL_DEFAULT_BATCH = 200;

function emitBackfillMetric(scanned: number, updated: number, durationMs: number): void {
  // token_backfill_total{scanned,updated} + token_backfill_duration_ms
  log.info(
    { metric: 'token_backfill_total', scanned, updated, durationMs },
    `[ConversationMemory] token_backfill_total scanned=${scanned} updated=${updated} duration_ms=${durationMs}`,
  );
}

/**
 * Backfill `tokenCountCl100k` for one batch of messages where it is NULL.
 *
 * Returns the number of rows updated. A caller that wants to drain the table
 * can loop while the return value === batchSize. Designed to be safe to call
 * from a low-frequency interval (server.ts sweep) or a one-off script.
 *
 * Never throws — DB errors are logged and reported as 0 updated so a transient
 * failure can't crash the host interval.
 */
export async function backfillMessageTokenCounts(
  batchSize: number = BACKFILL_DEFAULT_BATCH,
): Promise<number> {
  const startedAt = Date.now();
  let rows: Array<{ id: string; content: string | null }> = [];
  try {
    rows = (await prisma.iMMessage.findMany({
      where: { tokenCountCl100k: null },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true, content: true },
    })) as Array<{ id: string; content: string | null }>;
  } catch (err) {
    log.error({ err }, '[ConversationMemory] ❌ token backfill scan failed');
    emitBackfillMetric(0, 0, Date.now() - startedAt);
    return 0;
  }
  if (rows.length === 0) {
    emitBackfillMetric(0, 0, Date.now() - startedAt);
    return 0;
  }

  let updated = 0;
  for (const r of rows) {
    const count = estimateCl100kTokens(r.content);
    try {
      await prisma.iMMessage.update({
        where: { id: r.id },
        data: { tokenCountCl100k: count },
      });
      updated += 1;
    } catch (err) {
      // A row deleted mid-batch (P2025) or any other update error must not
      // abort the whole batch — log and move on.
      log.warn(
        { err, messageId: r.id },
        `[ConversationMemory] token backfill update skipped: ${(err as Error).message}`,
      );
    }
  }
  emitBackfillMetric(rows.length, updated, Date.now() - startedAt);
  return updated;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Dispatcher integration (task #6) — how to wire this in:
 *
 * In message.service.ts `dispatchToAgent` (currently builds the last-20
 * `metadata.context` at ~lines 963-1020), add at the top of context assembly:
 *
 *     const envelope = await conversationMemoryService.buildEnvelopeIfEnabled(
 *       triggerMessage.conversationId,
 *       triggerMessage,            // IMMessageLike-compatible
 *     );
 *     if (envelope) {
 *       // flag-on: attach to dispatch metadata; adapters consume natively.
 *       metadata.contextEnvelope = envelope;
 *     }
 *     // flag-off (envelope === null): keep the existing last-20 path untouched.
 *
 * The legacy `context` (TaskDispatchContextEntry[]) path stays in place for
 * flag-off and as the adapter fallback until Phase 4 (doc §8). Do NOT remove
 * it in #6.
 * ───────────────────────────────────────────────────────────────────────────── */

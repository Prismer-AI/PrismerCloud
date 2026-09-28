// memory211/01 W4 轴F — lazy span mint on the daemon ingestion/distillation
// chain (local-first half of the provenance closure).
//
// When an agent-authored or extracted distilled page CITES a raw asset chunk
// (the copy+reference content model: a derived-from pointer back to the source),
// that chunk is lazily minted a span sid and PROMOTED out of the T3 raw band
// into T2 asset (spec 轴C: 「每次 derived-from 引用触发惰性 mint → 该 span 从 T3
// 升 T2」). The `pkf_mint_sids` frozen tool (product209/20, memory-tools.ts) is
// the random authoring-plane primitive an LLM calls one sid at a time; the
// ingestion chain needs an INTERNAL, DETERMINISTIC derivation so a daemon mint
// and a cloud re-resolution converge on the same identity — hence the hashed
// form below (cloud twin: `src/im/services/memory-span-sid.ts#mintChunkSid`;
// sdk/ is a separate npm project and cannot import the cloud tree, so the two
// implementations are kept in lockstep by this comment + the pinned test).
//
// Pointer forms recognised (the same set the cloud resolves):
//   prismer://asset/<assetId>                       — bare (compatibility)
//   prismer://workspace/<ws>/asset/<sha256>         — scoped (PKF v1.1 strict;
//                                                     the ONLY form strict
//                                                     validation lets an author
//                                                     write in page content)
//   asset:<assetId>#<sha256>                        — memory provenance token
// each optionally followed by `#chunk-<ordinal>`.
//
// Never throws into the write path: the mint is a derived projection, so a
// failure degrades recall trust (the chunk stays T3) but must never fail a
// page write.

import { createHash } from 'node:crypto';
import type { MemoryOutbox } from './outbox.js';
import type { MemoryStore } from './store.js';

/** `sp-` = span; section sids use `s-`, PKF sids use `sec_`. */
export const SPAN_SID_PATTERN = /^sp-[0-9a-f]{16}$/;

export interface ChunkSidInputs {
  assetId: string;
  contentHash: string;
  ordinal: number;
  text: string;
}

/**
 * Deterministic span sid — MUST stay byte-identical to the cloud twin
 * (`src/im/services/memory-span-sid.ts#mintChunkSid`).
 */
export function mintChunkSid(chunk: ChunkSidInputs): string {
  const textHash = createHash('sha256').update(chunk.text ?? '', 'utf8').digest('hex');
  const digest = createHash('sha256')
    .update(
      ['chunk-span:v1', chunk.assetId, chunk.contentHash.toLowerCase(), String(chunk.ordinal), textHash].join('\n'),
    )
    .digest('hex');
  return `sp-${digest.slice(0, 16)}`;
}

export function isSpanSid(value: unknown): value is string {
  return typeof value === 'string' && SPAN_SID_PATTERN.test(value);
}

export interface AssetSpanRef {
  assetId?: string;
  contentHash?: string;
  ordinal?: number;
}

const ASSET_ID_RE =
  /prismer:\/\/asset\/([A-Za-z0-9._-]+)(?:#chunk-(\d+))?|asset:([A-Za-z0-9._-]+)#([0-9a-fA-F]{64})(?:#chunk-(\d+))?/g;
const SCOPED_RE = /prismer:\/\/workspace\/[^/?#\s]+\/asset\/([0-9a-fA-F]{64})(?:#chunk-(\d+))?/g;

/** Pull every asset provenance pointer out of a slice of page content. */
export function extractAssetRefs(content: string): AssetSpanRef[] {
  const out: AssetSpanRef[] = [];
  const push = (ref: AssetSpanRef): void => {
    if (ref.assetId || ref.contentHash) out.push(ref);
  };
  for (const m of content.matchAll(ASSET_ID_RE)) {
    const assetId = (m[1] ?? m[3] ?? '').trim();
    if (!assetId) continue;
    const ordinal = ordinalFrom(m[2] ?? m[5]);
    push({ assetId, ...(m[4] ? { contentHash: m[4]!.toLowerCase() } : {}), ...(ordinal !== null ? { ordinal } : {}) });
  }
  for (const m of content.matchAll(SCOPED_RE)) {
    const ordinal = ordinalFrom(m[2]);
    push({ contentHash: m[1]!.toLowerCase(), ...(ordinal !== null ? { ordinal } : {}) });
  }
  return out;
}

function ordinalFrom(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface SpanMintResult {
  /** chunks whose mirror row now carries a sid (the local T3→T2 promotion). */
  promoted: Array<{ assetId: string; ordinal: number; sid: string }>;
  /** outbox events enqueued so the cloud authoritative table promotes too. */
  enqueued: number;
}

/**
 * Scan a distilled page's content for asset provenance pointers and mint the
 * cited chunks. Best-effort by contract: any failure is returned as an empty
 * result (and logged by the caller), never thrown.
 *
 * Cloud propagation rides the SAME idempotent `asset.chunk.upsert` channel the
 * initial chunk upload used, now carrying the minted `sid` — the cloud upsert
 * latches the sid onto its authoritative row (one-way), so both sides converge
 * on one tier without a new event family.
 */
export function promoteReferencedAssetSpans(input: {
  store: MemoryStore;
  outbox: MemoryOutbox;
  content: string;
  deviceId?: string | null;
  traceId?: string;
}): SpanMintResult {
  const { store, outbox, content } = input;
  const empty: SpanMintResult = { promoted: [], enqueued: 0 };
  try {
    const refs = extractAssetRefs(content ?? '');
    if (refs.length === 0) return empty;

    const resolved = new Map<string, string>(); // contentHash → assetId (local mirror)
    const assetIds = new Set<string>();
    for (const ref of refs) {
      if (ref.assetId) assetIds.add(ref.assetId);
      if (ref.contentHash && !resolved.has(ref.contentHash)) {
        const id = store.assetIdByContentHash(ref.contentHash);
        if (id) resolved.set(ref.contentHash, id);
      }
    }
    for (const id of assetIds) {
      if (store.currentAssetChunks(id).length === 0) assetIds.delete(id);
    }
    for (const id of resolved.values()) assetIds.add(id);
    if (assetIds.size === 0) return empty;

    const promoted: SpanMintResult['promoted'] = [];
    let enqueued = 0;
    for (const assetId of assetIds) {
      const chunks = store.currentAssetChunks(assetId);
      if (chunks.length === 0) continue;
      const byOrdinal = new Map(chunks.map((c) => [c.ordinal, c]));
      const cited = new Set<number>();
      for (const ref of refs) {
        const refAsset =
          ref.assetId ??
          (ref.contentHash ? resolved.get(ref.contentHash) : undefined) ??
          (ref.contentHash ? store.assetIdByContentHash(ref.contentHash) : undefined);
        if (refAsset !== assetId) continue;
        if (ref.ordinal !== undefined) {
          if (byOrdinal.has(ref.ordinal)) cited.add(ref.ordinal);
        } else {
          // No span anchor ⇒ the pointer cites the WHOLE current revision.
          for (const c of chunks) cited.add(c.ordinal);
        }
      }
      for (const ordinal of [...cited].sort((a, b) => a - b)) {
        const chunk = byOrdinal.get(ordinal)!;
        const sid = chunk.sid ?? mintChunkSid(chunk);
        if (!store.promoteAssetChunkSid({ assetId, contentHash: chunk.contentHash, ordinal, sid })) continue;
        promoted.push({ assetId, ordinal, sid });
        const event = {
          eventId: `span_${assetId}_${chunk.contentHash.slice(0, 8)}_${ordinal}`,
          schemaVersion: 1,
          eventType: 'asset.chunk.upsert',
          workspaceId: store.workspaceId(),
          actorImUserId: 'cloud-sync',
          actorKind: 'agent',
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          createdAt: new Date().toISOString(),
          idempotencyKey: `asset.chunk.span:${store.workspaceId()}:${assetId}:${chunk.contentHash}:${ordinal}`,
          payload: {
            assetId,
            contentHash: chunk.contentHash,
            ordinal,
            text: chunk.text,
            tokenEstimate: estimateTokensLoose(chunk.text),
            sid,
          },
        };
        try {
          const res = outbox.enqueue(event);
          if ((res as { deadLetter?: boolean } | null)?.deadLetter) {
            // The mint already landed locally; a rejected upsync envelope only
            // delays the cloud promotion until the next citation. Say so loudly.
            console.error(`[SpanMint] ❌ upsync envelope rejected asset=${assetId} ordinal=${ordinal}`);
          } else {
            enqueued += 1;
          }
        } catch (err) {
          console.error(`[SpanMint] ❌ upsync enqueue failed asset=${assetId}: ${(err as Error).message}`);
        }
      }
    }
    if (promoted.length > 0) {
      console.log(`[SpanMint] minted ${promoted.length} span(s) (T3 raw → T2 asset) enqueued=${enqueued}`);
    }
    return { promoted, enqueued };
  } catch (err) {
    console.error(`[SpanMint] ❌ span promotion failed: ${(err as Error).message}`);
    return empty;
  }
}

/** Chunk rows carry tokenEstimate; this is only a fallback for older rows. */
function estimateTokensLoose(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af))
      cjk += 1;
  }
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

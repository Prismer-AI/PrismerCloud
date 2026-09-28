// memory211/01 §3 轴A (copy+reference) + 轴H (单一闸) — the deliverable
// admission gate as ONE definition with TWO call sites.
//
// History: product210/03 W1 landed G9 (pointer) + G10 (anti-copy budget) inline
// in `rpc.ts#handleWrite` only, which is exactly the D3 defect — the MAIN
// extraction path (hook-server writeExtractedPage / ExtractedPageApplicator)
// never went through any gate. memory211/01 v3.3 §0.1 keeps the in-flight G9
// gate as-is, redefines G10 IN PLACE at the same gate position, and (轴H) makes
// the main extraction path run the SAME gate. Both consumers import from here,
// so the two surfaces cannot drift again.
//
// G10's old semantics (body ≤ min(32KiB, 10% × source) — "distill, do not
// copy") is SUPERSEDED by memory211/01 轴A: a distilled page is ALLOWED and
// ENCOURAGED to carry the source's near-full content. What remains is the
// sharding trigger, re-thresholded by §6.9 裁决 4: a SOURCE over 64K characters
// must be split by the sharding pipeline, and every PAGE stays under the same
// 64K-character ceiling (每页 ≤64K). The gate enforces the page half — that is
// the fact it can check deterministically (the body it is admitting) — and
// rejects with `sharding_required`; it does NOT attempt to shard here. The
// source half is the cloud ingest pipeline's job (`buildShardPlan`, which plans
// the split BEFORE the task is dispatched).

/** A page distilled FROM a deliverable declares its source with this shape. */
export interface DeliverableSource {
  assetId: string;
  contentHash?: string;
  /**
   * Declared source size in BYTES (the asset row's own measure). Informational
   * to the gate: the ceiling is applied to the PAGE BODY in characters (see
   * `SHARDING_THRESHOLD_CHARS` — the 裁决 4 口径 is characters, which is what a
   * page and a reader actually cost, and which is CJK-friendly).
   */
  sizeBytes?: number;
}

/**
 * 轴A / §0 / §6.9 裁决 4 — the single remaining bound, in CHARACTERS: a source
 * over this many characters must be SHARDED, and a page over this many
 * characters is rejected. Spec §0: "预算=极端情况防护"; 裁决 4 set the number:
 * 64K characters (not bytes — a CJK source is ~3 bytes per char, so a byte
 * threshold would let a 20K-character Chinese document through un-sharded).
 */
export const SHARDING_THRESHOLD_CHARS = 64 * 1024;

export type DeliverableGateCode = 'deliverable_pointer_missing' | 'sharding_required';

export interface DeliverableGateRejection {
  code: DeliverableGateCode;
  /** Both rejections are admission failures — the RPC surface maps them 1:1. */
  httpStatus: 422;
  message: string;
  /** Stage-counter / memory-trace tag for the rejection. */
  stage: 'deliverablePointerMissing' | 'shardingRequired';
}

/**
 * Normalize an untyped `deliverableSource` body field. Returns null when the
 * caller did not declare a source (the gate is then a no-op — an ordinary
 * memory write) or declared nothing usable.
 */
export function parseDeliverableSource(raw: unknown): DeliverableSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const ds = raw as { assetId?: unknown; contentHash?: unknown; sizeBytes?: unknown };
  if (typeof ds.assetId !== 'string' || !ds.assetId.trim()) return null;
  return {
    assetId: ds.assetId.trim(),
    ...(typeof ds.contentHash === 'string' && ds.contentHash.trim()
      ? { contentHash: ds.contentHash.trim() }
      : {}),
    ...(typeof ds.sizeBytes === 'number' && Number.isFinite(ds.sizeBytes) && ds.sizeBytes > 0
      ? { sizeBytes: ds.sizeBytes }
      : {}),
  };
}

/**
 * G9 — the body must carry a materializable derived-from pointer to the
 * DECLARED asset. Matches either attribute order; the bare
 * `prismer://asset/<id>` form is the taught authoring shape (the write path
 * upgrades it to the workspace-scoped form afterwards).
 *
 * P6 — the inline IMAGE pointer `<img src="prismer://asset/<id>">` counts as
 * the same pointer. The pairing side (`extract.ts#parseExtractedPages`) declares
 * a deliverable source on ANY `prismer://asset/<id>` occurrence, and the
 * extraction prompt itself teaches the `<figure><img src>` form as the way to
 * reference an IMAGE/CHART asset — an image cannot be distilled into the page's
 * prose, so the inline embed IS its materializable jump pointer. Accepting it
 * keeps the gate at parity with the pairing; refusing it deterministically
 * gated out every image-only deliverable's whole page. An `<img>` pointing at a
 * DIFFERENT asset still does not satisfy this asset's pointer.
 */
export function hasDerivedFromPointer(content: string, assetId: string): boolean {
  const esc = assetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pointerRe = new RegExp(
    `<a\\b[^>]*rel=["']derived-from["'][^>]*href=["']prismer://asset/${esc}["']` +
      `|<a\\b[^>]*href=["']prismer://asset/${esc}["'][^>]*rel=["']derived-from["']`,
    'i',
  );
  if (pointerRe.test(content)) return true;
  const imgPointerRe = new RegExp(`<img\\b[^>]*src=["']prismer://asset/${esc}["']`, 'i');
  return imgPointerRe.test(content);
}

/**
 * Run the gate. `null` ⇒ admitted (or nothing to admit: no declared source).
 * Deterministic by construction — never a model self-report.
 */
export function checkDeliverableGate(
  ds: DeliverableSource | null,
  content: string,
): DeliverableGateRejection | null {
  if (!ds) return null;

  if (!hasDerivedFromPointer(content, ds.assetId)) {
    return {
      code: 'deliverable_pointer_missing',
      httpStatus: 422,
      stage: 'deliverablePointerMissing',
      message:
        'A page distilled from a deliverable must carry ' +
        '<a rel="derived-from" href="prismer://asset/<assetId>"> pointing at the declared source asset (G9); ' +
        'for an IMAGE/CHART source the inline <img src="prismer://asset/<assetId>"> embed is the equivalent pointer.',
    };
  }

  // §6.9 裁决 4 — the page half of the 64K-character rule: a distilled page
  // (which the copy+reference doctrine lets carry the source's near-full body)
  // must stay under the same ceiling the sharding plan targets. Checked on the
  // BODY the caller is actually admitting, in characters — deterministic, and
  // the only size fact that can't be mis-declared.
  if (content.length > SHARDING_THRESHOLD_CHARS) {
    return {
      code: 'sharding_required',
      httpStatus: 422,
      stage: 'shardingRequired',
      message:
        `This page is ${content.length} characters, over the ${SHARDING_THRESHOLD_CHARS}-character sharding ` +
        'threshold (memory211/01 §6.9). Distill the source into shard pages + a structural index page ' +
        'through the sharding pipeline instead of one whole-source page; the reference chain must stay intact.',
    };
  }

  return null;
}

/**
 * W1-2 idempotency token — deterministic provenance for "this page was
 * distilled from THAT revision of that asset". Null when the caller did not
 * supply the asset content hash (the daemon then cannot dedupe locally; the
 * cloud authoritative row still can).
 */
export function deliverableProvenanceToken(ds: DeliverableSource): string | null {
  return ds.contentHash ? `asset:${ds.assetId}#${ds.contentHash}` : null;
}

/** One page the automatic extraction produced that the gate refused. */
export interface GatedOutExtractedPage {
  page: { path: string; deliverableSource?: { assetId: string } };
  code: DeliverableGateCode;
}

/**
 * memory211/01 轴H — run the gate over an extraction batch. This is the main
 * extraction path's admission point (the D3 gap: the pipeline used to reach no
 * gate at all). It MUST run BEFORE pages are turned into ledger entries: the
 * applicator keys idempotency on `pageIndex`, so dropping a page inside the
 * applicator would silently renumber the batch.
 *
 * Deterministic by construction — the same LLM output always yields the same
 * kept/rejected split, which is what makes the post-turn ledger safe across
 * crash replays.
 */
export function filterGatedExtractedPages<
  T extends { path: string; deliverableSource?: { assetId: string; contentHash?: string; sizeBytes?: number } },
>(pages: readonly T[]): { kept: T[]; rejected: Array<{ page: T; code: DeliverableGateCode }> } {
  const kept: T[] = [];
  const rejected: Array<{ page: T; code: DeliverableGateCode }> = [];
  for (const page of pages) {
    // W3 review B1 — the WHOLE declared source goes through the parser, not just
    // the assetId. Re-projecting `{assetId}` here silently stripped contentHash /
    // sizeBytes, which made the sharding trigger (the only remaining G10
    // semantics) unreachable from the extraction lane no matter what the caller
    // declared.
    const ds = page.deliverableSource ? parseDeliverableSource(page.deliverableSource) : null;
    const rejection = checkDeliverableGate(ds, (page as { content?: string }).content ?? '');
    if (rejection) rejected.push({ page, code: rejection.code });
    else kept.push(page);
  }
  return { kept, rejected };
}

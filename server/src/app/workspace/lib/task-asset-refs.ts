/**
 * Wave-8 W1 / L1–L4 — task description ↔ asset reference utilities.
 *
 * The task description is free-form markdown that may include
 * `prismer://workspace/<wsId>/asset/<contentHash>` URIs. These URIs are
 * the user-visible representation of an attachment, written by the
 * AssetPicker-driven `#filename` autocomplete. At submit time we extract
 * the hashes, look them up in the workspace asset list, and ship a
 * structured `assetRefs[]` alongside the description so the daemon's
 * `resolveAssetRefs` can inline / cache the bytes for the agent.
 *
 * Layout decisions:
 *   - We do NOT mutate the description on save (URIs stay in the prompt).
 *     The daemon already handles in-text URIs via `uriResolver.rewrite`,
 *     so they remain useful to the LLM even if `assetRefs[]` is dropped
 *     for some reason.
 *   - Extraction is regex-based, not full markdown parse — we don't care
 *     whether the URI is inside `[]()` or bare; we just need every hash
 *     in the text. Order is preserved, dedup'd at the contentHash level
 *     (multiple links to the same asset don't double-attach).
 *   - Hash → asset lookup is delegated to the caller (drawer / picker
 *     receives the workspace asset list as a prop; not all callers have
 *     identical fetch wiring).
 */

import type { AssetDTO } from './types';
import type { AssetRefInput } from './mutations';

/**
 * The shape Cloud + AssetPicker speak: a sha256 contentHash (64 hex chars)
 * embedded in `prismer://workspace/<wsId>/asset/<hash>`. We intentionally
 * accept any hash length ≥ 8 so test fixtures with short hashes still
 * parse — production hashes are always 64 chars.
 */
export const PRISMER_ASSET_URI_RE =
  /prismer:\/\/workspace\/([A-Za-z0-9_-]+)\/asset\/([0-9a-fA-F]{8,})/g;

/**
 * Build the canonical asset URI used in description markdown.
 *
 * Format: `prismer://workspace/<workspaceId>/asset/<contentHash>` —
 * authoritative path documented in daemon's `uriResolver.rewrite` and
 * the IM cookbook §asset-uris.
 */
export function buildAssetUri(workspaceId: string, contentHash: string): string {
  return `prismer://workspace/${workspaceId}/asset/${contentHash}`;
}

/**
 * Build the markdown link form inserted by the picker:
 * `[<filename>](prismer://workspace/<wsId>/asset/<hash>)`.
 *
 * Filename is sanitized so a name containing `]` doesn't break the
 * markdown link. We replace `]` with `)` cheaply — losing exact name
 * round-trip is acceptable; the chip row uses the resolved asset row
 * for display anyway.
 */
export function buildAssetMarkdownLink(
  workspaceId: string,
  contentHash: string,
  filename: string | null,
): string {
  const safeName = (filename || 'attachment').replace(/[\[\]]/g, '_');
  return `[${safeName}](${buildAssetUri(workspaceId, contentHash)})`;
}

export interface ExtractedAssetRef {
  /** Lower-cased contentHash from the URI. */
  contentHash: string;
  /** Workspace id from the URI — usually matches the task's workspace. */
  workspaceId: string;
  /** First occurrence start offset in the source text (UTF-16). */
  matchStart: number;
  /** First occurrence end offset (exclusive). */
  matchEnd: number;
}

/**
 * Extract every `prismer://workspace/.../asset/<hash>` URI from a text
 * blob. Dedup'd by contentHash (first occurrence wins for offsets), order
 * preserved. Returns an empty array on `null` / empty input.
 */
export function extractAssetUris(text: string | null | undefined): ExtractedAssetRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: ExtractedAssetRef[] = [];
  // `RegExp.lastIndex` is stateful — use `matchAll` for the iterator form.
  for (const m of text.matchAll(PRISMER_ASSET_URI_RE)) {
    const wsId = m[1];
    const hash = (m[2] ?? '').toLowerCase();
    if (!wsId || !hash || seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      contentHash: hash,
      workspaceId: wsId,
      matchStart: m.index ?? 0,
      matchEnd: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/**
 * Cross-reference extracted URIs against the workspace asset list. Each
 * hash → first matching `AssetDTO` (workspaceId filtered for safety).
 * Hashes that don't resolve to a known asset are dropped silently — the
 * description still contains the URI so the daemon can attempt resolution
 * via its own asset cache (e.g. assets uploaded after the description was
 * authored but before submit).
 */
export interface ResolvedAssetRef extends ExtractedAssetRef {
  asset: AssetDTO;
}

export function resolveAssetUris(
  extracted: ExtractedAssetRef[],
  workspaceAssets: AssetDTO[],
  workspaceId: string,
): ResolvedAssetRef[] {
  if (extracted.length === 0) return [];
  // Hash → asset lookup map. A single contentHash can theoretically exist
  // across workspaces; we filter by workspaceId to keep boundary clean.
  const byHash = new Map<string, AssetDTO>();
  for (const asset of workspaceAssets) {
    if (asset.workspaceId !== workspaceId) continue;
    if (asset.deletedAt) continue;
    const h = (asset.contentHash || '').toLowerCase();
    if (!h) continue;
    // First match wins — assets are typically de-duplicated by contentHash
    // upstream, but if two rows share a hash (e.g. revision history) we
    // want the live (non-deleted) one which we've already filtered for.
    if (!byHash.has(h)) byHash.set(h, asset);
  }
  const out: ResolvedAssetRef[] = [];
  for (const ref of extracted) {
    const asset = byHash.get(ref.contentHash);
    if (!asset) continue;
    out.push({ ...ref, asset });
  }
  return out;
}

/**
 * Turn the resolved set into the `assetRefs[]` payload shape the cloud
 * accepts on POST/PATCH /tasks. Only `assetId` is strictly required on
 * the wire; we include `contentHash` + `workspaceId` for cross-workspace
 * detection and `mime` / `sizeBytes` so server-side logs can render
 * useful debug output without re-fetching.
 */
export function toAssetRefsPayload(resolved: ResolvedAssetRef[]): AssetRefInput[] {
  return resolved.map((r) => ({
    assetId: r.asset.id,
    contentHash: r.asset.contentHash,
    mime: r.asset.mime,
    sizeBytes: r.asset.sizeBytes,
    workspaceId: r.asset.workspaceId,
  }));
}

/**
 * Convenience for the common pipeline: description text + workspace
 * asset list → AssetRefInput[]. Returns empty when no URIs resolve.
 */
export function buildAssetRefsFromDescription(
  description: string | null | undefined,
  workspaceAssets: AssetDTO[] | undefined,
  workspaceId: string | null | undefined,
): AssetRefInput[] {
  if (!description || !workspaceAssets || !workspaceId) return [];
  const extracted = extractAssetUris(description);
  if (extracted.length === 0) return [];
  const resolved = resolveAssetUris(extracted, workspaceAssets, workspaceId);
  return toAssetRefsPayload(resolved);
}

/**
 * Remove the first occurrence of an asset URI from a text blob. Used by
 * the chip row's X button to drop an attachment from the description.
 *
 * Strategy: if the URI is wrapped in markdown link syntax
 * `[label](prismer://...)`, drop the whole link. Otherwise drop just the
 * URI. Trailing whitespace around the removed span is collapsed to a
 * single space to avoid leaving "double-space scars."
 */
export function removeAssetUri(text: string, contentHash: string): string {
  const hash = contentHash.toLowerCase();
  // Try matching `[label](prismer://workspace/<ws>/asset/<hash>)` first.
  const linkRe = new RegExp(
    `\\[[^\\]]*\\]\\(prismer:\\/\\/workspace\\/[A-Za-z0-9_-]+\\/asset\\/${hash}\\)`,
    'i',
  );
  let next = text.replace(linkRe, '');
  if (next !== text) return collapseSpacing(next);
  // Fall back to bare URI form (the picker writes link form, but a user
  // could have hand-typed the bare URI).
  const bareRe = new RegExp(
    `prismer:\\/\\/workspace\\/[A-Za-z0-9_-]+\\/asset\\/${hash}`,
    'gi',
  );
  next = text.replace(bareRe, '');
  return collapseSpacing(next);
}

/**
 * Collapse runs of horizontal whitespace introduced by URI removal back
 * to a single space, and strip leading/trailing whitespace on each line
 * that's now blank because the URI was the sole content. Newlines are
 * preserved.
 */
function collapseSpacing(text: string): string {
  return text
    // Collapse 2+ spaces (NOT newlines) into a single space.
    .replace(/[ \t]{2,}/g, ' ')
    // Strip a stray space before punctuation we tend to leave behind.
    .replace(/ +([.,;:!?\)\]])/g, '$1')
    // Trim trailing space on any line.
    .replace(/[ \t]+$/gm, '');
}

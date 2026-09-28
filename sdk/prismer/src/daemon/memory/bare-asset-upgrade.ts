// pkf v1.1 §4.7 — write-time bare-asset-URI upgrade for the memory_write path.
//
// Background: PKF v1.1 strict validation rejects bare `prismer://asset/<id>`
// URIs (compatibility-read only — packages/pkf/src/core/validator.ts
// 'bare-asset-uri'); the canonical AUTHORING form is the workspace-scoped
// `prismer://workspace/<wsId>/asset/<contentHash>` (packages/pkf/src/core/uri.ts
// assetForm 'scoped'). But the memory skill, dispatch guidance and the
// extraction prompt all teach agents the bare pointer form (G9:
// `<a rel="derived-from" href="prismer://asset/<id>">`, plus `<img src>`
// figure pointers), so daemon-authored pages kept failing v1.1 validation on
// read-back. Rather than re-teaching every producer at once, the write path
// deterministically upgrades the pointers at write time.
//
// Rewrites bare `prismer://asset/<id>` values inside href/src attributes:
//   - asset resolves to a contentHash → canonical
//     `prismer://workspace/<ws>/asset/<contentHash>`
//   - otherwise (resolver absent / miss / throws) → degrade to the
//     workspace-scoped assetId form `prismer://workspace/<ws>/asset/<assetId>`
//     — still v1.1-valid, still strictly better than the bare form.
// Only the URI text between the quotes is replaced: rel, link text, quote
// style and attribute order survive untouched. Every failure mode keeps the
// write flowing — this is hygiene, never a gate.

/** `href`/`src` attribute carrying a bare prismer asset URI (either quote style). */
const BARE_ASSET_ATTR_RE =
  /(href|src)=(["'])prismer:\/\/asset\/([^"'#?\s]+)(#[^"'\s]*)?\2/gi;

export type ResolveAssetContentHash = (
  workspaceId: string,
  assetId: string,
) => Promise<string | null>;

export interface BareAssetUpgradeResult {
  /** Content after the rewrite (byte-identical input when nothing matched). */
  content: string;
  /** True when at least one bare pointer was rewritten. */
  changed: boolean;
  /** Pointers upgraded to the canonical contentHash form. */
  canonical: number;
  /** Pointers degraded to the scoped assetId form (hash unresolvable). */
  scopedDegrade: number;
}

/**
 * Upgrade every bare `prismer://asset/<id>` href/src in `content`.
 * Never throws: a throwing resolver counts as "unresolvable" (degrade path).
 */
export async function upgradeBareAssetUris(
  content: string,
  workspaceId: string,
  resolve?: ResolveAssetContentHash,
): Promise<BareAssetUpgradeResult> {
  const matches = [...content.matchAll(BARE_ASSET_ATTR_RE)];
  if (matches.length === 0) {
    return { content, changed: false, canonical: 0, scopedDegrade: 0 };
  }

  // One resolution per UNIQUE assetId — repeated pointers share the verdict.
  const suffix = new Map<string, string>();
  for (const m of matches) {
    const assetId = m[3] ?? '';
    if (!assetId || suffix.has(assetId)) continue;
    let contentHash: string | null = null;
    try {
      contentHash = resolve ? await resolve(workspaceId, assetId) : null;
    } catch {
      contentHash = null; // resolver failure = unresolvable (never blocks the write)
    }
    suffix.set(assetId, contentHash || assetId);
  }

  // Splice the rewritten URIs back at their exact match offsets.
  let out = '';
  let cursor = 0;
  let canonical = 0;
  let scopedDegrade = 0;
  for (const m of matches) {
    const [full, attr, quote, assetId, fragment] = m as RegExpMatchArray & {
      0: string; 1: string; 2: string; 3: string; 4?: string;
    };
    const start = m.index ?? 0;
    out += content.slice(cursor, start);
    const scoped = suffix.get(assetId) ?? assetId;
    const upgradedHash = scoped !== assetId;
    if (upgradedHash) canonical += 1;
    else scopedDegrade += 1;
    out += `${attr}=${quote}prismer://workspace/${workspaceId}/asset/${scoped}${fragment ?? ''}${quote}`;
    cursor = start + full.length;
  }
  out += content.slice(cursor);

  return { content: out, changed: true, canonical, scopedDegrade };
}

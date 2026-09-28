// memory202 doc 05 §4.2a — INDEX dynamic core-inject SOURCE (daemon, pure).
//
// The workspace INDEX page (pageType='index') is the curated memory MAP, which
// is becoming HIERARCHICAL: a bounded top-INDEX = a TOC of HUB pages, each hub
// owning its own sub-TOC. `buildIndexToc` turns that map into a BOUNDED,
// section-aware table of contents string suitable for a core-inject carrier
// (e.g. the hermes MEMORY.md managed section).
//
// PURE over (indexMarkdown, budget) so it unit-tests trivially: no I/O, no store
// handle, no clock. The wiring that reads the INDEX page and pushes the result
// through `coreInject` lives in `index-toc-inject.ts` (flag-gated, daemon-side).
//
// Bounding strategy (never cut mid-section, prefer the HUB SPINE, stay loud):
//   1. Empty / whitespace-only INDEX → '' (caller no-ops, never injects junk).
//   2. Whole map (optionally prefixed with a short "# Memory Map" header) fits
//      the budget → return it verbatim.
//   3. Over budget → DROP to the SKELETON: the map's headings only (the section
//      titles), so the agent still gets the full map SHAPE, just without the
//      per-section prose.
//   4. Skeleton still over budget → STRUCTURE-PRESERVING truncation: drop
//      headings DEEPEST-LEVEL-FIRST (leaves before hubs), so the TOP-LEVEL HUB
//      SPINE — the navigational backbone the agent reaches via memory_load —
//      survives complete even when deep leaf detail is trimmed. We never drop a
//      shallow heading while a deeper one remains.
//   5. Whenever ANYTHING is dropped (prose or headings), append an OBSERVABLE
//      truncation marker so the agent KNOWS the map is partial and should drill
//      into the index page rather than assume it saw everything. Truncation is
//      never silent.
//
// `scanHeadingsForToc` is reused from `section.ts` (the same fence-aware ATX
// scanner the recall path uses), so "what counts as a section" is identical
// across the section-slice path and this TOC builder.
//
// CARRIER NOTE: the hermes MEMORY.md managed section is the production carrier
// and its budget is a HARD limit (hermes injects the WHOLE MEMORY.md into the
// system prompt with a ~2200-char file cap → DEFAULT_CHAR_BUDGET=1800 for the
// managed body, leaving headroom for delimiters + the agent's own curated
// entries; see hermes-memory-bridge.ts). The injector therefore passes the
// CARRIER budget (1800) here so this builder's output never overflows what the
// carrier can hold. The larger DEFAULT_CHAR_BUDGET below is for the hierarchical
// top-index in general (and non-hermes / future carriers); callers always
// override with their carrier's real budget.

import { scanHeadingsForToc } from './section.js';

/** Short header prefixed to the injected map so the agent knows what the block is. */
export const MEMORY_MAP_HEADER = '# Memory Map';

/**
 * Default char budget for a hierarchical top-index TOC. This is a SENSIBLE
 * DEFAULT for the bounded HUB-level map, NOT a carrier limit — every real caller
 * overrides it with its carrier's budget. The hermes core-inject carrier passes
 * its own hard ≤1,800 managed-section budget (see hermes-memory-bridge
 * DEFAULT_CHAR_BUDGET), which this builder must not exceed; this larger default
 * only applies to direct callers / non-hermes carriers that can hold more.
 */
export const DEFAULT_CHAR_BUDGET = 4000;

export interface BuildIndexTocOptions {
  /**
   * Prefix `MEMORY_MAP_HEADER` so the injected block self-identifies. Default
   * true. The header is counted against the budget. When the INDEX already
   * starts with a top-level heading we still prepend our header — the carrier
   * body is a managed section, the extra line is the map's own title.
   */
  withHeader?: boolean;
}

/** Build the observable truncation marker for `dropped` omitted sections. */
function truncationMarker(dropped: number): string {
  const n = Math.max(1, dropped);
  return `> … ${n} more section${n === 1 ? '' : 's'} — load the index page for the full map`;
}

/** Marker for when only per-section PROSE was elided (the heading SHAPE is whole). */
const SKELETON_MARKER = '> … section bodies elided — load the index page for the full map';

/**
 * Build a bounded, section-aware TOC string from the workspace INDEX page
 * markdown. Pure. See module header for the bounding strategy.
 *
 * @param indexMarkdown  the current content of the workspace's pageType='index'
 *                       page (the curated memory map). '' / whitespace ⇒ ''.
 * @param budget         max chars of the returned string (the core-inject
 *                       carrier budget). Defaults to {@link DEFAULT_CHAR_BUDGET}
 *                       but callers MUST pass their carrier's real budget. ≤0 ⇒ ''.
 */
export function buildIndexToc(
  indexMarkdown: string,
  budget: number = DEFAULT_CHAR_BUDGET,
  opts?: BuildIndexTocOptions,
): string {
  if (budget <= 0) return '';
  const map = (indexMarkdown ?? '').trim();
  if (!map) return '';

  const withHeader = opts?.withHeader ?? true;
  const headerPrefix = withHeader ? `${MEMORY_MAP_HEADER}\n` : '';

  // (2) whole map fits → verbatim (with header).
  const whole = `${headerPrefix}${map}`;
  if (whole.length <= budget) return whole;

  // (3)/(4) over budget → skeleton of headings.
  const lines = map.split('\n');
  const heads = scanHeadingsForToc(lines);

  // No headings at all (a flat INDEX with no ## sections) → there is no section
  // boundary to cut at, so fall back to a header-only block (with the marker, so
  // the agent knows the body was elided) if it fits, else ''. We never cut the
  // flat body mid-line.
  if (heads.length === 0) {
    const marker = truncationMarker(1);
    const headerOnly = `${headerPrefix}${marker}`;
    if (headerOnly.length <= budget) return headerOnly;
    if (headerPrefix.trimEnd().length > 0 && headerPrefix.trimEnd().length <= budget) {
      return headerPrefix.trimEnd();
    }
    return '';
  }

  // Render each heading as an indented map line: nesting reflects the heading
  // level so the skeleton reads as a tree. Level-1 (shallowest present) headings
  // sit flush; deeper levels indent two spaces per level below the shallowest.
  const minLevel = heads.reduce((m, h) => Math.min(m, h.level), Infinity);
  type Entry = { level: number; line: string };
  const entries: Entry[] = heads.map((h) => {
    const indent = '  '.repeat(Math.max(0, h.level - minLevel));
    return { level: h.level, line: `${indent}- ${h.text}` };
  });

  // STRUCTURE-PRESERVING selection. Keep as many WHOLE heading lines as fit, but
  // when we cannot keep them all, drop DEEPEST-FIRST so the hub spine (shallowest
  // levels) survives complete. Navigability (headings) takes priority over the
  // marker: we admit headings up to budget WITHOUT pre-charging the marker, then
  // append the marker only if room remains. At any realistic carrier budget
  // (hundreds+ of chars) the marker always fits; only at pathologically tiny
  // budgets do we prefer one more hub line over the notice.
  //
  // Admission order is by LEVEL (shallow→deep), and within a level by document
  // order. So entries are sorted level-major; this is the depth-first DROP
  // restated as a depth-first KEEP. Document order is preserved in the final
  // render via a stable index, so the tree still reads top-to-bottom.
  const indexed = entries.map((e, i) => ({ ...e, docIdx: i }));
  const byLevelThenDoc = [...indexed].sort(
    (a, b) => (a.level - b.level) || (a.docIdx - b.docIdx),
  );

  const kept: Array<Entry & { docIdx: number }> = [];
  let used = headerPrefix.length;
  for (const e of byLevelThenDoc) {
    const sep = kept.length === 0 ? 0 : 1; // '\n' between heading lines
    if (used + sep + e.line.length > budget) {
      // This level doesn't fully fit. Because we admit shallow-first, every hub
      // shallower than this entry's level is already in; stop here so we never
      // partially admit a shallower level after skipping a deeper one. Continue
      // scanning ONLY same-or-shallower level entries (there are none left at a
      // shallower level by construction), so just break — deeper entries can't
      // fit either once a shallower-or-equal one didn't.
      break;
    }
    kept.push(e);
    used += sep + e.line.length;
  }

  const droppedCount = entries.length - kept.length;

  if (kept.length === 0) {
    // Not even the shallowest hub fits alongside the header. Degrade: try a
    // single hub line without the header; if even that overflows, return ''.
    const first = entries[0];
    if (first && first.line.length <= budget) {
      const withMarker = `${first.line}\n${truncationMarker(entries.length - 1)}`;
      return withMarker.length <= budget ? withMarker : first.line;
    }
    return '';
  }

  // Restore document order for the final render (level-major was only for the
  // depth-first KEEP decision).
  kept.sort((a, b) => a.docIdx - b.docIdx);
  const body = kept.map((e) => e.line).join('\n');

  if (droppedCount <= 0) {
    // Every heading survived as a skeleton (no headings dropped, only the
    // per-section prose). The prose loss still warrants a marker so the agent
    // knows this is the SHAPE, not the full content. Append if it fits.
    const withMarker = `${headerPrefix}${body}\n${SKELETON_MARKER}`;
    return withMarker.length <= budget ? withMarker : `${headerPrefix}${body}`;
  }

  // Headings were dropped → an OBSERVABLE marker is mandatory whenever it fits.
  // Append if room remains; if the marker would overflow, drop the deepest kept
  // heading(s) to make room, so truncation is NEVER silent (the navigability we
  // sacrifice for the notice is the deepest leaf, never a hub).
  const marker = truncationMarker(droppedCount);
  let withMarker = `${headerPrefix}${body}\n${marker}`;
  if (withMarker.length <= budget) return withMarker;

  // Make room for the marker by shedding deepest-kept headings one at a time.
  // `kept` is doc-ordered; find and drop by deepest level. Recompute the marker
  // count as we shed (more sections become "dropped").
  let working = [...kept];
  while (working.length > 1) {
    // Remove the deepest-level entry (last one at the max kept level).
    const maxKept = working.reduce((m, e) => Math.max(m, e.level), -Infinity);
    let removeAt = -1;
    for (let i = working.length - 1; i >= 0; i--) {
      if (working[i]!.level === maxKept) { removeAt = i; break; }
    }
    if (removeAt < 0) break;
    working.splice(removeAt, 1);
    const dropped = entries.length - working.length;
    const m = truncationMarker(dropped);
    const b = working.map((e) => e.line).join('\n');
    withMarker = `${headerPrefix}${b}\n${m}`;
    if (withMarker.length <= budget) return withMarker;
  }

  // Could not fit even one heading + marker. Keep the headings (navigability >
  // notice) rather than return nothing.
  return `${headerPrefix}${body}`;
}

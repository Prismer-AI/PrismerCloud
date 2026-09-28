// memory211/01 W3 轴E — STABLE MEMORY DIGEST (turn-start warmup, memory side).
//
// The spec's responsibility split (§0 / 轴E): the MEMORY SYSTEM produces a
// stable digest; the PROMPT ASSEMBLY (hermes adapter) owns where it goes and
// the cache-invariance contract. "Stable" is a hard contract, not a preference:
//
//   • DETERMINISTIC — same store state ⇒ byte-identical text. No timestamps, no
//     clocks, no volatile counters, no insertion-order leakage: hubs are sorted
//     by path, leaves by path, and the only per-page fields are
//     path / title / description (the same fields a TOC renders).
//   • CONTENT-HASH VERSIONED — `version` is sha256 of the body (first 16 hex),
//     so a consumer can key a cache line on it and detect any content change.
//   • UNBOUNDED EXCEPT FOR THE EXTREME GUARD — memory211/01 §6.9 裁决 2: the
//     W3-era ~2K-token default cap is GONE. The digest is injected IN FULL
//     (INDEX-TOC + every hub summary); the only remaining bound is the extreme
//     guard (>32K tokens) above which the body is cut with an OBSERVABLE marker,
//     never a silent cut. 预算只防极端，不做常规约束 (spec §0).
//
// Why this exists: turn-start injection means the agent answers structural
// questions ("我们的记忆体方案 golden gate 是什么" — spec §1) with ZERO tool
// calls instead of a browse/search round trip. That only works if the injected
// text is cache-friendly: a stable prefix, changed only when the digest version
// changes (see the hermes assembly site).
//
// MUTATION TARGET (negative control): adding ANY volatile field (a timestamp, a
// read counter) makes two consecutive builds differ —
// `memory-digest.test.ts`「确定性」goes red, which is the control for the whole
// stability contract.

import { createHash } from 'node:crypto';
import type { MemoryStore } from './store.js';
import { buildIndexToc } from './index-toc.js';
import { isIndexInjectEnabled } from './index-toc-inject.js';

/**
 * §6.9 裁决 2 — the ONLY remaining bound, and it is an extreme guard, not a
 * budget: a digest above this many tokens is cut (with a marker). 32K tokens ≈
 * 128K ASCII chars / 32K CJK chars — a workspace hub spine large enough that no
 * ordinary map ever reaches it. env/Nacos key: `PRISMER_MEMORY_DIGEST_BUDGET_TOKENS`
 * (kept as the knob name so an existing Nacos override keeps working; it now
 * tunes the GUARD, not a routine cap).
 */
export const MEMORY_DIGEST_EXTREME_GUARD_TOKENS = 32_000;

/** chars → tokens heuristic for the budget (ASCII/4 + CJK/1, chunker parity). */
export function estimateDigestTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    }
  }
  const other = text.length - cjk;
  return Math.ceil(other / 4) + cjk;
}

/** env/Nacos tunable extreme guard: `PRISMER_MEMORY_DIGEST_BUDGET_TOKENS`. */
export function resolveDigestTokenBudget(): number {
  const raw = Number(process.env.PRISMER_MEMORY_DIGEST_BUDGET_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MEMORY_DIGEST_EXTREME_GUARD_TOKENS;
}

export interface MemoryDigest {
  /** sha256(body)[0..16) — the cache/version key. */
  version: string;
  /** The injectable body INCLUDING the version line (stable for a given body). */
  text: string;
  tokenEstimate: number;
  /** True when the body was cut to fit the budget (always marked in the text). */
  truncated: boolean;
}

export interface BuildMemoryDigestOptions {
  /**
   * Extreme-guard ceiling (default `resolveDigestTokenBudget()` = 32K tokens).
   * NOT a routine budget: a digest under the guard is injected IN FULL. ≤0
   * disables building.
   */
  tokenBudget?: number;
  /**
   * memory211/10 R4 W-1 — the "Verified" section, rendered VERBATIM from
   * harness-owned receipts (task state machine's current state, the last
   * turn's terminal receipt summary, completed artifact pointers). The digest
   * builder is a pure renderer: it never derives these lines itself, and the
   * STABILITY contract applies unchanged — same receipts ⇒ byte-identical; no
   * receipts ⇒ no section at all (byte-identical to the pre-W-1 digest).
   */
  verified?: { lines: string[] };
}

/** One-line summary of a page: description, else the first non-heading line. */
function oneLineSummary(page: { description: string | null; content: string }): string {
  if (page.description && page.description.trim()) {
    return page.description.trim().replace(/\s+/g, ' ').slice(0, 160);
  }
  for (const line of page.content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

// ── turn-start injection seam (hermes assembly ⇄ memory system) ─────────────
//
// The hermes adapter composes the system prompt WITHOUT owning a MemoryStore
// (the store lives in the daemon runner), so the digest crosses that boundary as
// a lazily-called provider — the same registry pattern as run-session-map /
// daemon RPC sender. The RUNNER registers a provider bound to its runtime; the
// ADAPTER calls it per dispatch and renders the block. Nothing is injected when
// no provider is registered (standalone adapter / tests) or the flag is off.

export type MemoryDigestProvider = (
  workspaceId: string,
) => Pick<MemoryDigest, 'text' | 'version' | 'tokenEstimate'> | null;

let digestProvider: MemoryDigestProvider | null = null;

/** Register the process-wide digest provider (the daemon runner does this). */
export function setMemoryDigestProvider(provider: MemoryDigestProvider | null): void {
  digestProvider = provider;
}

/** The stable system-prompt section header. Stable ⇒ cache-friendly. */
export const MEMORY_DIGEST_HEADER = '## Memory Map (auto — stable digest)';

/**
 * Render the digest block for one dispatch, or '' when there is nothing to
 * inject (flag off / no provider / empty workspace). PURE formatting: the byte
 * stability of the result is exactly the byte stability of `digest.text`.
 */
export function renderMemoryDigestBlock(workspaceId: string): string {
  if (!isIndexInjectEnabled()) return '';
  const digest = digestProvider?.(workspaceId) ?? null;
  if (!digest || !digest.text.trim()) return '';
  return [
    MEMORY_DIGEST_HEADER,
    '',
    digest.text.trimEnd(),
    '',
    '(This block is generated and stable: it changes only when the workspace',
    'memory map changes — its version is the content hash above. Do not edit it;',
    'answer structural questions from it before calling memory_search.)',
  ].join('\n');
}

/**
 * Build the stable workspace digest: the FULL INDEX-TOC plus one line per hub.
 * Deterministic and content-hash versioned. Nothing is bounded here except the
 * extreme guard (§6.9 裁决 2) — the W3-era ~2K-token routine cap is gone, which
 * is the point: a digest that stops half-way through the hub spine is a digest
 * that cannot answer the structural question it exists to answer.
 *
 * An empty workspace (no INDEX, no hubs) yields `null` — the caller injects
 * nothing rather than a stub (turn-start injection must never spend budget on
 * an empty map).
 */
export function buildMemoryDigest(
  store: MemoryStore,
  opts: BuildMemoryDigestOptions = {},
): MemoryDigest | null {
  const tokenBudget = opts.tokenBudget ?? resolveDigestTokenBudget();
  if (tokenBudget <= 0) return null;

  // §6.9 裁决 2 — the INDEX-TOC is NOT pre-budgeted to a SHARE of the guard. An
  // earlier draft passed `tokenBudget * share * 4` chars here, which quietly
  // re-introduced a soft cap BEFORE the extreme guard: a workspace whose INDEX
  // map alone was ~66K chars (≈16K tokens — well under a 32K-token guard) had
  // its TOC skeletonized anyway. The TOC renders IN FULL; the only cut in this
  // function is the whole-body extreme guard below, and it marks itself.
  // (`buildIndexToc` still takes a ceiling — the guard expressed in chars, ≈4
  // chars/token — so a map larger than the guard itself is at least shaped
  // before the token walk; in that case the guard fires too, observably.)
  let indexToc = '';
  try {
    indexToc = buildIndexToc(store.loadIndexPageContent() ?? '', Math.floor(tokenBudget * 4), {
      withHeader: true,
    });
  } catch {
    indexToc = '';
  }

  // Deterministic hub ordering: path sort (locale-independent), bounded so a
  // 10k-page workspace cannot blow the guard before the TOC is rendered.
  const hubs = store
    .list({ pageType: 'hub', limit: 1000 })
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const lines: string[] = [];
  if (indexToc) lines.push(indexToc.trimEnd());
  const hubLines: string[] = [];
  for (const hub of hubs) {
    if (hub.encrypted) continue; // fail-closed: never put ciphertext in a digest
    let content = '';
    try {
      content = store.loadContent(hub.id, hub.version)?.content ?? '';
    } catch {
      content = '';
    }
    const summary = oneLineSummary({ description: hub.description, content });
    hubLines.push(summary ? `- ${hub.path} — ${summary}` : `- ${hub.path}`);
  }
  if (hubLines.length > 0) {
    lines.push('', '# Memory Hubs', ...hubLines);
  }

  // memory211/10 R4 W-1 — verified working state, receipts only. Rendered
  // AFTER the hub spine, INSIDE the extreme guard (it is digest content like
  // any other). Absent receipts render nothing — the section does not exist
  // as an empty stub (same rule as the empty-workspace null).
  const verifiedLines = (opts.verified?.lines ?? []).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (verifiedLines.length > 0) {
    lines.push('', '# Verified this turn', ...verifiedLines.map((l) => `- ${l}`));
  }

  const body = lines.join('\n').trim();
  if (!body) return null;

  // Extreme guard (§6.9 裁决 2): cut at the last whole line that fits, then
  // mark the cut (never a silent truncation, never a partial line). A digest
  // under the guard passes through byte-identical.
  let text = body;
  let truncated = false;
  if (estimateDigestTokens(body) > tokenBudget) {
    truncated = true;
    const kept: string[] = [];
    let used = 0;
    for (const line of body.split('\n')) {
      const cost = estimateDigestTokens(line) + 1;
      if (used + cost > tokenBudget) break;
      kept.push(line);
      used += cost;
    }
    text = `${kept.join('\n')}\n> … digest truncated — use memory_search for the rest`;
  }

  const version = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  const withVersion = `${text}\n<!-- memory-digest:${version} -->`;
  return {
    version,
    text: withVersion,
    tokenEstimate: estimateDigestTokens(withVersion),
    truncated,
  };
}

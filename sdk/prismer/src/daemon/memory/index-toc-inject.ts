// memory202 doc 05 §4.2a — INDEX dynamic core-inject WIRING (daemon, flag-gated).
//
// Glues the pure `buildIndexToc` SOURCE to the EXISTING core-inject carrier
// (`createHermesMemoryIntegration(...).coreInject` → MEMORY.md managed section,
// which recall-stats already tracks via recordCoreInject). "Dynamic" = re-run
// whenever the map changes, so the agent always has the current memory map in
// context.
//
// SCOPE GUARDRAIL (doc 05 §4.2a): this wiring stops at "build TOC → call the
// EXISTING coreInject carrier". The turn-start PROMPT injection (轴E) is a
// separate seam — `buildMemoryDigest` (digest.ts) + the hermes adapter's
// system-prompt tail assembly — which is where the cache-invariance contract is
// documented and enforced.
//
// Flag: FF_MEMORY_INDEX_INJECT_ENABLED (env, DEFAULT ON since memory211/01 W3
// 轴E — the spec's 翻 ON 裁决; an explicit `false|0|off` is the only way off).
// When OFF: zero behaviour change — no INDEX read, no buildIndexToc, no
// coreInject call.

import type { MemoryStore } from './store.js';
import { buildIndexToc } from './index-toc.js';
import { createHermesMemoryIntegration } from '../../adapters/shared/memory-integration.js';
import { DEFAULT_CHAR_BUDGET } from './hermes-memory-bridge.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('MemoryIndexInject');

/**
 * Feature flag — gates the memory turn-start injection. DEFAULT ON as of
 * memory211/01 W3 轴E (the spec's `FF_MEMORY_INDEX_INJECT_ENABLED` 翻 ON 裁决);
 * only an explicit `false|0|off` turns it off, so an unset env no longer
 * suppresses the inject (the pre-W3 `=== 'true'` gate made OFF the default and
 * the inject never ran in production). The ops kill-switch therefore stays a
 * deliberate act, not an omission.
 *
 * When OFF the inject helpers are pure no-ops (return { injected: false }).
 */
export function isIndexInjectEnabled(): boolean {
  const raw = (process.env.FF_MEMORY_INDEX_INJECT_ENABLED ?? '').trim().toLowerCase();
  if (raw === '') return true; // default ON (memory211/01 W3 轴E)
  return !(raw === 'false' || raw === '0' || raw === 'off');
}

export interface IndexInjectTarget {
  /** Local memory store for the workspace whose INDEX page is the map source. */
  store: MemoryStore;
  /** Absolute path to the agent's native MEMORY.md (the core-inject carrier). */
  memoryFilePath: string;
  /** Workspace id (forwarded to the integration; used only for logging here). */
  workspaceId: string;
  /** core-inject char budget; defaults to the bridge's ≤1,800 budget. */
  charBudget?: number;
}

export interface IndexInjectResult {
  /** Whether a coreInject write actually happened. */
  injected: boolean;
  /** Bytes written into the managed section (0 when not injected). */
  bytes: number;
  /** Reason a no-op occurred (for observability), when injected=false. */
  reason?: 'flag-off' | 'no-index' | 'empty-toc';
}

/**
 * Build the INDEX TOC from the workspace's local INDEX page and push it through
 * the EXISTING coreInject carrier for ONE target (store + MEMORY.md path).
 *
 * No-op (injected:false) when: the flag is off; the workspace has no INDEX page;
 * or the bounded TOC is empty. Never throws into the caller — read/build errors
 * are logged and degrade to injected:false (memory inject is best-effort).
 */
export function injectIndexTocForTarget(target: IndexInjectTarget): IndexInjectResult {
  if (!isIndexInjectEnabled()) return { injected: false, bytes: 0, reason: 'flag-off' };

  // CARRIER BUDGET. We pass the HERMES managed-section budget (≤1,800, the hard
  // limit derived from hermes' ~2,200-char whole-file cap — see
  // hermes-memory-bridge DEFAULT_CHAR_BUDGET) to BOTH buildIndexToc and the
  // coreInject carrier, so the structure-preserving TOC we build never overflows
  // what writeManagedSection can hold (which would otherwise re-truncate it
  // blindly mid-line). buildIndexToc's own larger default budget is irrelevant
  // here precisely because we always override it with the carrier's real limit.
  const budget = target.charBudget ?? DEFAULT_CHAR_BUDGET;
  let indexMarkdown: string | null = null;
  try {
    indexMarkdown = target.store.loadIndexPageContent();
  } catch (err) {
    log.warn(`[MemoryIndexInject] read INDEX failed ws=${target.workspaceId}: ${(err as Error).message}`);
    return { injected: false, bytes: 0, reason: 'no-index' };
  }
  if (!indexMarkdown) return { injected: false, bytes: 0, reason: 'no-index' };

  const toc = buildIndexToc(indexMarkdown, budget);
  if (!toc) return { injected: false, bytes: 0, reason: 'empty-toc' };

  try {
    const integration = createHermesMemoryIntegration({
      workspaceId: target.workspaceId,
      memoryFilePath: target.memoryFilePath,
      coreInjectCharBudget: budget,
    });
    const res = integration.coreInject(toc);
    if (res.written) {
      log.info(
        `[MemoryIndexInject] injected memory map ws=${target.workspaceId} bytes=${res.bytes}`,
      );
    }
    return { injected: res.written, bytes: res.bytes };
  } catch (err) {
    log.warn(`[MemoryIndexInject] coreInject failed ws=${target.workspaceId}: ${(err as Error).message}`);
    return { injected: false, bytes: 0, reason: 'empty-toc' };
  }
}

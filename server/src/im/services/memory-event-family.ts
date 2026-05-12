/**
 * Memory sync-inbox event family classifier.
 *
 * Single dispatch table for `POST /memory/sync/inbox` routing. Adding a new
 * observability eventType (e.g. a future `recall_*` variant) means adding it
 * to one set here — the route handler in MemoryWriteService.routeOneEvent
 * doesn't need a new branch.
 *
 * **Keep in sync with the daemon-side authority:**
 *   `sdk/prismer-cloud/runtime/src/daemon/memory/envelope.ts` (Line C).
 *
 * Why mirror instead of cross-package import:
 *   - Cloud (this package) → daemon SDK is an awkward dependency direction;
 *     the daemon SDK ships independently to npm.
 *   - The set is small + stable; the daemon owns adds and we follow.
 *   - Prevents an accidental mass change cascading from daemon-side refactor.
 *
 * Why not prefix-only routing:
 *   - `memory.feedback` shares the `memory.` prefix with mirror events
 *     (`memory.page.*`, `memory.link.*`) but is semantically observability,
 *     not a page/link mirror. Explicit set membership is the only correct
 *     classifier.
 */

export type EventFamily = 'observability' | 'memory' | 'asset' | 'ingest' | 'unknown';

/** Events written to `im_memory_observability_events`. */
const OBSERVABILITY_TYPES = new Set<string>([
  'recall_preload',
  'recall_inject',
  'recall_pull',
  'recall_reject',
  'access_denied',
  'feedback',
  'memory.feedback',
  // M-B (doc 25 §3 支柱 2): one event per fork-driven recall cycle.
  'recall_fork',
]);

/** Events that mirror to `im_memory_pages` / `im_memory_page_versions` / `im_memory_links`. */
const MEMORY_MIRROR_TYPES = new Set<string>([
  'memory.page.upsert',
  'memory.page.delete',
  'memory.link.upsert',
  'memory.link.delete',
  // M-C (doc 25 §3 支柱 3): session-end fork extract proposal.
  // Routes to im_memory_proposals via memoryProposalService.create —
  // not a page/link mirror, but lives in the same family for routing
  // simplicity.
  'memory.proposal',
]);

export function eventFamily(eventType: string): EventFamily {
  if (OBSERVABILITY_TYPES.has(eventType)) return 'observability';
  if (MEMORY_MIRROR_TYPES.has(eventType)) return 'memory';
  if (eventType.startsWith('asset.')) return 'asset';
  if (eventType.startsWith('ingest.')) return 'ingest';
  return 'unknown';
}

/**
 * Test-only escape hatch: enumerate the locked observability types so
 * tests can assert coverage without re-declaring the set.
 */
export const _OBSERVABILITY_TYPES_FOR_TEST: readonly string[] = [...OBSERVABILITY_TYPES];
export const _MEMORY_MIRROR_TYPES_FOR_TEST: readonly string[] = [...MEMORY_MIRROR_TYPES];

// Local TS types for the daemon memory module.
//
// Distinct from envelope.ts: types here can evolve freely (they are
// in-process); envelope.ts schemas are FROZEN as the cross-process wire
// contract per doc 18 §C4. Cloud mirror tables (im_memory_pages etc.) have
// their own Prisma model — bridged via memory.page.upsert envelope on the
// outbox, not via a shared TS type.

export type MemoryPageType = 'hub' | 'leaf' | 'decision' | 'glossary' | 'archive';

export type MemoryVisibility =
  | { kind: 'workspace' }
  | { kind: 'agent'; imUserId: string }
  | { kind: 'private'; imUserId: string }
  // E4 (product204) — role/council-scoped writes. The subject is a role SLUG
  // or a council ID (not an im_user), mirroring the cloud's `role:<slug>` /
  // `council:<id>` visibility string (memory-acl.ts grants an orchestrator
  // caller these prefixes). The daemon persists the subject in the same
  // `visibilityImUserId` column; the boundary ACL treats these coarse shared
  // scopes as workspace-visible (real role/council membership governance stays
  // cloud-side — see acl-predicate.ts).
  | { kind: 'role'; slug: string }
  | { kind: 'council'; id: string }
  | { kind: 'task'; id: string };

export type ActorKind = 'human' | 'agent';

export type MemorySyncStatus = 'local-only' | 'pending' | 'acked' | 'remote-conflict';

export interface MemoryPage {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  description: string | null;
  contentHash: string;
  version: number;
  pageType: MemoryPageType;
  visibility: MemoryVisibility;
  encrypted: boolean;
  stale: boolean;
  archivedAt: number | null;
  sourceAssetId: string | null;
  sourceRefs: string[];
  syncStatus: MemorySyncStatus;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPageContent {
  pageId: string;
  version: number;
  content: string;
}

export interface MemoryLink {
  sourceUri: string;
  targetUri: string;
  relation: string;
  weight: number;
  extractedFromPageId: string | null;
}

export interface MemorySearchResult {
  pageId: string;
  path: string;
  title: string | null;
  snippet: string;
  score: number;
  tokenCount: number;
  /**
   * Provenance: 'fts' = direct FTS5/BM25 match; 'graph' = pulled via
   * link-graph expansion from an FTS seed (lower score band). Absent ⇒ 'fts'.
   * Mirrors the cloud MemorySearchResult.via field.
   */
  via?: 'fts' | 'graph';
  /**
   * memory202/09 P0: the `#section` anchor this hit was reached through (e.g. a
   * graph-expanded `页B#节y` link). Absent ⇒ whole-page hit. Used by the recall
   * injector to prefer a section slice over the query-window snippet.
   */
  section?: string;
  /**
   * memory202/09 P0: the markdown of the addressed section (heading → next
   * same/higher heading), pre-sliced by the search/graph layer when `section`
   * resolved. When present the recall injector injects THIS verbatim instead of
   * `snippet`. Absent ⇒ injector falls back to `snippet` (page-level behaviour
   * unchanged).
   */
  sectionBody?: string;
  //
  // ── memory211/01 §3 轴C W1a — hop-decision payload ────────────────────────
  //
  // The fields below are the spec's "足以判断「多跳还是直读」" contract: a hit
  // now tells the agent WHERE it sits in the tree (hubPath/childrenCount), HOW
  // connected it is (inboundLinkCount), WHAT it links to (outboundPreview) and
  // WHICH corpus tier produced it (tier). They are ADDITIVE — path/title/
  // snippet/score/tokenCount/via above are unchanged so pre-existing tool and
  // plugin consumers keep working. `hybrid()` populates every one of them for
  // every returned hit; they are optional in the type only because
  // MemorySearchResult objects are also constructed outside the search layer
  // (recall-injector merges, hook filters), which must not be forced to fake
  // graph context they did not compute.
  //
  /** Spec-canonical page path. Byte-identical to `path` (kept for compat). */
  pagePath?: string;
  /**
   * The hub this hit hangs under, derived REVERSE via the local `child-of`
   * edges (hit page --child-of--> hub). `null` for a root / INDEX page (no
   * outbound child-of edge) — the agent's "this is a top-level page" signal.
   */
  hubPath?: string | null;
  /** Page version in the local subset (cloud head when down-synced). */
  version?: number;
  /** Spec name for `section`: the anchor this hit was reached through. */
  sectionAnchor?: string;
  /** Short preview of the addressed section body (≤200 chars) when sliced. */
  sectionPreview?: string;
  /**
   * Recall corpus tier (memory211/01 §3 轴C). 'wiki' = T1 curated/distilled
   * pages; 'raw' = T3 raw-asset chunk (W3 ingestion pipeline — the upload's own
   * text, no synthesis, lowest trust band). A raw hit addresses an ASSET, so its
   * `path` is the provenance token `asset:<id>#<hash>` and `assetId`/`chunkOrdinal`
   * carry the jump coordinates (轴F).
   */
  tier?: 'wiki' | 'asset' | 'raw';
  /** T3 only: the upload this chunk came from (`path` mirrors it in the token). */
  assetId?: string;
  /** T3 only: 0-based chunk ordinal (`sectionAnchor` carries `chunk-<ordinal>`). */
  chunkOrdinal?: number;
  /**
   * memory211/01 W4 轴F — the lazy-minted span sid (`sp-<16hex>`), present only
   * on a chunk a distilled page already cited (⇒ `tier:'asset'`). The agent's
   * one-hop jump coordinate back to the exact raw paragraph.
   */
  spanSid?: string;
  /** Edges in the local link graph pointing AT this page (any relation). */
  inboundLinkCount?: number;
  /** Distinct child-of children of this page (0 for a leaf). */
  childrenCount?: number;
  /**
   * First few outbound edges (strongest weight first) so the agent can decide
   * a follow-on load without a second browse.
   */
  outboundPreview?: Array<{ relation: string; targetPath: string }>;
  /**
   * memory211/01 P3 — the score DECOMPOSITION the local ranker can compute:
   * `matchScore` is the raw BM25-normalized lexical relevance BEFORE the
   * temporal/supersede adjustments are folded into `score`. Cloud parity: the
   * cloud `MemorySearchResult.components` (memory-search.service.ts) is the same
   * decomposition, and cross-tier merging on BOTH sides compares THIS field, not
   * the composite `score` — workspace priors (recency/linkBoost) must never be
   * read as evidence that a query term lives in a page. Optional because
   * MemorySearchResult objects are also built outside the search layer
   * (recall-injector merges, hook filters) and must not fake a decomposition
   * they did not compute; `search.ts#lexicalEvidence` falls back to `score`.
   */
  components?: { matchScore: number };
}

/**
 * memory211/01 §6.9 裁决 1 — one structural entry point offered on a text miss.
 * A start point is a ROUTING node, never an answer: the payload states what the
 * page IS (index/hub), how many children it fans out to, and why it is here.
 */
export interface MemoryNavigationStartPoint {
  path: string;
  title: string | null;
  pageType: 'index' | 'hub';
  childrenCount: number;
  why: 'structural-entry';
}

/**
 * memory211/01 §6.9 裁决 1 — the miss-path payload, replacing the W1a "dynamic
 * miss band". A text miss carries no rank evidence, so the structural layer no
 * longer masquerades as a ranked hit list: it travels in its own field, labelled
 * as start points, with the walking instructions attached. The cloud mirror lives
 * in `src/im/services/memory-search.service.ts` (`MemoryNavigation`).
 */
export interface MemoryNavigation {
  reason: 'text-miss';
  startPoints: MemoryNavigationStartPoint[];
  guidance: string;
}

export interface MemorySearchOptions {
  topK?: number;
  relevanceThreshold?: number;
  maxBytes?: number;
  pageType?: MemoryPageType[];
  /**
   * Composite recall: when true (default) FTS5 hits are supplemented with
   * link-graph neighbors at a lower score band. Set false to measure / debug
   * the FTS-only path (cloud-side graph recall is hardened always-ON since
   * product204/18 Wave 1; this daemon-local knob remains for eval/debug).
   */
  graph?: boolean;
  /**
   * Max link-graph hops from an FTS seed. Default 1 (1-hop, aligns with cloud
   * expandViaGraph). Hard-capped at 5 (memory202/05 §4.2). 0 disables graph.
   */
  maxDepth?: number;
  /** Per-hop fan-out: keep only the top-N neighbors by edge weight. Default 8. */
  graphFanOut?: number;
}

export interface MemoryWriteInput {
  workspaceId: string;
  /**
   * Canonical page id to use for a FRESH insert. The daemon subset is a
   * projection of the cloud superset, so a page synced DOWN from the cloud
   * (cloud-sync `materialisePage`) MUST carry the cloud's canonical id — every
   * id-forwarding op (memory_curate promote-to-hub / supersede, load-by-id,
   * resolve) addresses the cloud by this id. Omitted → the store mints a local
   * `page_<uuid>` (daemon-authored pages that don't yet have a cloud id). On a
   * path conflict the existing row's id is RETAINED (never repointed — content/
   * fts/links FK to it).
   */
  id?: string;
  path: string;
  content: string;
  pageType?: MemoryPageType;
  title?: string;
  description?: string;
  visibility?: MemoryVisibility;
  sourceAssetId?: string;
  sourceRefs?: string[];
  stale?: boolean;
  /**
   * memory203/18 R1.4 — authoritative base version for a page materialised
   * FROM the cloud superset (cloud-sync passes the cloud row's version). The
   * store adopts `max(localExisting+1, version)` so a down-synced page lands at
   * the cloud head and the next local write's outbox `parentVersion` matches it
   * (no false base-v1 remote-conflict). Omitted → today's `existing+1`.
   */
  version?: number;
  actorImUserId: string;
  actorKind: ActorKind;
  /**
   * memory202 doc 06 (at-rest encryption MVP): mark this page encrypted-at-rest.
   * Local SQLite ALWAYS stores plaintext (the daemon is the trusted local store
   * and local FTS/recall need plaintext); this flag only travels to the cloud on
   * the outbox `memory.page.upsert` payload, where the OUTBOX FLUSH encrypts the
   * content and the cloud stores ciphertext. Default false (no behavior change).
   */
  encrypted?: boolean;
}

export interface MemoryStats {
  workspaceId: string | null;
  pageCount: number;
  pendingOutbox: number;
  deadLetterCount: number;
  lastSyncAt: number | null;
  dbPath: string;
}

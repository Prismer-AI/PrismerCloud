// Shared memory tool spec — locked across all 4 host adapters (Claude Code,
// Hermes, OpenClaw, Codex) so an LLM running in any of them sees the same
// tool surface and the same daemon RPC under the hood.
//
// Per Line C plan §C5:
//   - Tool names: `memory_search` and `memory_load` (FROZEN)
//   - JSONSchema input shapes: locked here; per-adapter wrappers translate
//     this into the adapter's expected tool definition format
//   - Implementation calls daemon RPC `/local/memory/search` and
//     `/local/memory/load` (phase-0 routes from C1)
//
// recall_pull emission (M-RECALL-EMIT): the tool client forwards the calling
// agent's identity (`actorImUserId` + `actorKind`) as query params so the
// daemon RPC handler (rpc.ts handleSearch / handleLoad) can enqueue a
// `recall_pull` observability event into the per-workspace outbox. The
// emission itself lives daemon-side (single chokepoint for in-process AND
// out-of-process callers); this client's only job is to pass the actor
// identity through. When no actor identity is supplied (legacy / anonymous
// callers) the daemon skips emission rather than fabricating an actor.

import { createHash, randomBytes } from 'node:crypto';
import { auditPkfSvg, parsePkf, validatePkf } from '@prismer/pkf';

export interface MemorySearchInput {
  query: string;
  /**
   * Optional granting workspace to search through an active cross-workspace
   * memory grant. Omit (default) to search this agent's own workspace.
   */
  sourceWorkspaceId?: string;
  /**
   * memory211/01 §3 轴C W1a — batch recall: run up to 8 related questions in ONE
   * call and get them back grouped. Optional; `query` stays the single-question
   * form. When both are sent the daemon answers `queries` and ignores `query`.
   */
  queries?: string[];
  limit?: number;
  pageType?: Array<'hub' | 'leaf' | 'decision' | 'glossary' | 'archive'>;
}

/**
 * memory211/01 §3 轴C W1a — one search hit. The first six fields are the frozen
 * legacy shape; everything below is the ADDITIVE hop-decision payload (does the
 * agent read this page directly, or follow the graph?). The daemon populates
 * every one of them; they are optional here so an older daemon response still
 * type-checks.
 */
export interface MemorySearchHit {
  pageId: string;
  path: string;
  title: string | null;
  snippet: string;
  score: number;
  tokenCount: number;
  /** Spec-canonical path field, byte-identical to `path`. */
  pagePath?: string;
  /** Reverse `child-of` placement; null for a root / INDEX page. */
  hubPath?: string | null;
  version?: number;
  /** Anchor when the hit was reached at a `#section`. */
  sectionAnchor?: string;
  /** ≤200-char preview of the addressed section body. */
  sectionPreview?: string;
  /** Corpus tier. Only T1 (wiki) exists daemon-side today; T2/T3 land in W3. */
  tier?: 'wiki';
  /** 'fts' = lexical match; 'graph' = link-graph expansion. */
  via?: 'fts' | 'graph';
  inboundLinkCount?: number;
  childrenCount?: number;
  outboundPreview?: Array<{ relation: string; targetPath: string }>;
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
 * memory211/01 §6.9 裁决 1 — the miss-path payload. When a query text-missed the
 * wiki corpus the tool returns the structural entry points (INDEX + hubs,
 * children-first) plus the walking instructions, instead of a fabricated rank
 * list. Optional in the type so an older daemon response still type-checks.
 */
export interface MemoryNavigation {
  reason: 'text-miss';
  startPoints: MemoryNavigationStartPoint[];
  guidance: string;
}

export interface MemorySearchOutput {
  query: string;
  results: MemorySearchHit[];
  /**
   * memory211/01 §6.9 裁决 1 — present only when the query text-missed the wiki
   * corpus: the structural entries to walk from. A hit list with lexical
   * evidence comes back WITHOUT this field (ranked semantics, no navigation).
   */
  navigation?: MemoryNavigation;
  /**
   * memory211/01 §3 轴C W1a — batch recall: one entry per requested query, in
   * request order. Absent from an older daemon (single-`q` responses). Each
   * entry carries its OWN `navigation` — miss is judged per query.
   */
  resultsByQuery?: Array<{ query: string; results: MemorySearchHit[]; navigation?: MemoryNavigation }>;
  /** Set when more than 8 queries were requested and the list was cut to 8. */
  truncated?: boolean;
}

export interface MemoryLoadInput {
  /** Either `uri` (prismer://workspace/<id>/memory/<path>) or `workspaceId` + `path`. */
  uri?: string;
  /**
   * Optional granting workspace to load from through an active memory grant.
   * Requires `path`; the consuming workspace stays the agent's bound workspace.
   */
  sourceWorkspaceId?: string;
  workspaceId?: string;
  path?: string;
}

/**
 * One memory_link row in the `links` envelope (memory211/01 轴C W1a). Shape
 * follows the cloud `GET /memory/pages/:id/links` rows; the daemon's OFFLINE
 * fallback rows carry a subset of it (`broken` / `extractedFromVersion` are
 * cloud-only).
 */
export interface MemoryLinkRow {
  sourceUri: string;
  targetUri: string;
  sourcePageId?: string | null;
  targetPageId?: string | null;
  relation: string;
  weight: number;
  sourceSection?: string | null;
  targetSection?: string | null;
  updatedAt: string;
}

export interface MemoryLoadOutput {
  page: {
    id: string;
    path: string;
    title: string | null;
    pageType: string;
    version: number;
    contentHash: string;
  };
  content: string | null;
  /**
   * memory211/01 §3 轴C W1a — `{ outbound, backlinks }`. Served by the cloud
   * when it answers, else by the daemon's LOCAL link mirror (offline links), so
   * 「顺着索引往下看」no longer silently disappears off the network.
   */
  links?: { outbound: MemoryLinkRow[]; backlinks: MemoryLinkRow[] };
}

/**
 * memory_curate (memory203 MVP4 phase-1) — a THIRD memory tool, additive to the
 * FROZEN memory_search / memory_load pair. Unlike those two (which read the
 * daemon LOCAL subset), curation is a CLOUD-superset governance op: the daemon
 * forwards it to the cloud curation endpoints, which enforce orchestrator-only
 * authority (memory-acl.ts). Offered to ALL agents, but the cloud returns 403
 * for non-orchestrators — surfaced cleanly here, not as a crash.
 */
export type MemoryCurateOp =
  | 'candidates'
  | 'promote_to_hub'
  | 'supersede'
  | 'rebuild_index'
  // memory211/01 W5 轴 G — section-level curation verbs.
  | 'section_merge'
  | 'section_supersede'
  | 'rewire';

export interface MemoryCurateInput {
  op: MemoryCurateOp;
  /**
   * Required for `promote_to_hub` and `supersede` (the target page). For
   * `section_merge` this is the WINNER page; for `section_supersede` the page
   * whose section retires.
   */
  pageId?: string;
  /**
   * `promote_to_hub` only (memory203/18 R1.3) — existing page paths to attach
   * under the promoted hub as its children (child-of edges), same transaction.
   */
  childPaths?: string[];
  /** Optional human-readable reason, recorded by `supersede` / section verbs. */
  reason?: string;
  // ── memory211/01 W5 轴 G — section-level verb inputs ────────────────────────
  /** `section_supersede` only — anchor slug of the section to retire. */
  section?: string;
  /** `section_merge` only — anchor slug of the WINNER section. */
  targetSection?: string;
  /** `section_merge` only — id of the LOSER page. */
  sourcePageId?: string;
  /** `section_merge` only — anchor slug of the LOSER section. */
  sourceSection?: string;
  /** `section_merge` only — merged body written into the winner section. */
  mergedContent?: string;
  /** `section_supersede` only — optional surviving page. */
  supersededByPageId?: string;
  /** `section_supersede` only — anchor slug on {@link supersededByPageId}. */
  supersededBySection?: string;
  /** `rewire` only — id of the link to re-point. */
  linkId?: string;
  /** `rewire` only — new target page id (exclusive with {@link toPath}). */
  toPageId?: string;
  /** `rewire` only — new target page path (exclusive with {@link toPageId}). */
  toPath?: string;
  /** `rewire` only — optional new target section anchor. */
  toSection?: string;
  /**
   * `candidates` only — which candidate surface to read (default `all`):
   * `orphans` | `duplicates` | `stale` | `conflicts` (remote-conflict pages
   * awaiting semantic review) | `oversized` (memory203/20 §1.2 hub/INDEX size
   * ADVISORIES — record-not-limit; suggest splitting, never machine-enforced).
   */
  kind?: 'orphans' | 'duplicates' | 'stale' | 'conflicts' | 'oversized' | 'all';
  /** `candidates` only — max items per kind. */
  limit?: number;
}

export interface MemoryCurateOutput {
  ok: boolean;
  op: MemoryCurateOp;
  /** The cloud curation result (updated page / rebuild summary). */
  data?: unknown;
  /**
   * `candidates` op result: the Dream convergence candidate surfaces keyed by
   * kind (`orphans` / `duplicates` / `stale` / `conflicts` / `oversized`),
   * each `{ items, total }`.
   */
  candidates?: Record<string, { items: unknown[]; total: number }>;
  /** Set when the daemon ran offline (no cloud) — the op was a no-op. */
  degraded?: boolean;
  /** Error code on failure (e.g. cloud `orchestrator_only` 403 passthrough). */
  error?: string;
  message?: string;
}

/**
 * memory_write (memory203/18 R6.5 spec alignment — the tool has shipped in the
 * Hermes provider since memory203/13; the FROZEN spec had drifted by not
 * listing it). The WRITE正门: the agent DIRECTLY authors a PKF page it already
 * extracted in its own runtime; the daemon (POST /local/memory/write) does a
 * direct store.write + outbox up-sync. `parentHubPath`/`relation` (R1.1) declare
 * structural placement — the daemon emits the page→hub edge as a
 * `memory.link.upsert` graph event, which is what actually nests the page.
 */
export interface MemoryWriteToolInput {
  /** Workspace-relative semantic path; reuse an existing page's path to extend/replace it. */
  path: string;
  /** Page body the agent authored (PKF; markdown accepted and normalized). */
  content: string;
  title?: string;
  /** R1.1 — attach this page under an existing hub (get hub paths from memory_browse). */
  parentHubPath?: string;
  /** Edge type for `parentHubPath`. Default `child-of`. */
  relation?: 'child-of' | 'related';
  /**
   * R6.4 — write op. `replace` (default) overwrites/creates the whole page;
   * `append-section` adds a new section to an EXISTING page (preferred when
   * extending someone else's page); `rewrite-section` overwrites just the
   * addressed section. Section ops are applied by the cloud (authoritative
   * section index) and require `section`.
   */
  op?: 'replace' | 'append-section' | 'rewrite-section';
  /** Heading id (slug) the section ops target. Required for section ops. */
  section?: string;
  /**
   * E4 (product204) — visibility scope for the page. One of `workspace`
   * (default), `agent:<imUserId>`, `private:<imUserId>`, `role:<slug>`, or
   * `council:<councilId>`. Absent → `workspace`. Role/council scopes are
   * granted only to an orchestrator caller (the cloud memory-acl enforces
   * `canWrite`); a non-orchestrator page silently falls back to workspace
   * cloud-side. Unknown strings are ignored safely (treated as workspace).
   */
  visibility?: string;
}

export interface MemoryWriteToolOutput {
  page: {
    id: string;
    path: string;
    title: string | null;
    pageType: string;
    version: number;
    contentHash: string;
  };
  /** Echoed when a placement was declared (the edge was queued to the outbox). */
  link?: { targetPath: string; relation: string };
}

/**
 * memory_browse (memory203/18 R6.2) — the READ half of write-time placement.
 * GET /local/memory/place-context returns the SAME structure view the daemon's
 * background-extraction leg assembles (shared helper — the two cannot drift):
 * INDEX + hubs with a "what is this about" snippet + (given `query`) nearest
 * pages via the same local hybrid search.
 */
export interface MemoryBrowseInput {
  /** Optional topic — adds the nearest existing pages to the structure view. */
  query?: string;
}

export interface MemoryBrowseOutput {
  index: { path: string; title: string | null; pageType: string; snippet: string } | null;
  hubs: Array<{
    path: string;
    title: string | null;
    pageType: string;
    snippet: string;
    /**
     * memory211/01 §3 轴C W1a — tree-shaped browse: the hub's child-of children
     * so placement/planning is one call, not hub-by-hub loads.
     */
    children: Array<{ path: string; title: string | null }>;
    /**
     * memory211/03 §7 B1 — freshness signal. Epoch ms (`Date.now()`), the
     * finest granularity the browse shape gives: the hub row's own updatedAt
     * spread with the latest of its direct child-of children (a hub row is not
     * re-touched when a leaf under it is written).
     */
    updatedAt: number;
  }>;
  /**
   * memory211/03 §7 B1 (v1.1 V3) — the same hub set in recency order (hub
   * `updatedAt` DESC). Additive: `hubs[]` keeps its existing structural order
   * and `index`/`nearest` are unchanged.
   */
  hubsByRecent: Array<{
    path: string;
    title: string | null;
    pageType: string;
    snippet: string;
    children: Array<{ path: string; title: string | null }>;
    updatedAt: number;
  }>;
  nearest: Array<{ path: string; title: string | null; pageType: string; snippet: string }>;
}

/** Locked human-readable description used in every adapter's tool definition.
 *
 * Selective wording (doc 25 §3 支柱 1, M-A): the description steers the LLM
 * to call this only when a specific question genuinely warrants prior memory,
 * not as a habit. Empty results are normal — the agent should proceed without
 * memory rather than padding the prompt with low-relevance hits. */
export const MEMORY_SEARCH_DESCRIPTION =
  'Search workspace memory (prior decisions, user preferences, knowledge pages). ' +
  'Use this only when you have a specific question that you believe past memory ' +
  'would answer — not on every turn. Most queries do not need this. ' +
  'Returns 0–N ranked snippets with prismer:// URIs; empty results are normal. ' +
  'Each hit reports where it sits in the wiki (hubPath, children), how linked it is ' +
  '(inboundLinkCount, outboundPreview) and whether it is distilled knowledge or raw ' +
  'source (tier) — use those to decide whether to load the page or follow a link. ' +
  'When your wording matched nothing, the response instead carries `navigation`: ' +
  'startPoints are NOT answers, they are the INDEX/hub entries to walk from — ' +
  'browse their children, batch-load what looks relevant, then follow links. ' +
  'Pass several related questions at once via `queries` instead of calling this ' +
  'tool repeatedly.';

export const MEMORY_LOAD_DESCRIPTION =
  'Load a specific memory page by URI (prismer://workspace/<workspaceId>/memory/<path>) ' +
  'or by (workspaceId + path). Returns the full page content plus metadata and the ' +
  "page's outbound links (backlinks included) — served from the local link index even " +
  'when the cloud is unreachable.';

export const MEMORY_WRITE_DESCRIPTION =
  'Write a durable memory page to the workspace knowledge wiki (the WRITE path). ' +
  'Use this to persist a fact, decision, definition, or piece of project context ' +
  'that should survive across sessions. YOU author the page: write the `content` ' +
  'and choose its `path`, deciding placement from the memory structure (call ' +
  'memory_browse FIRST) — extend/replace an existing page by reusing its path, or ' +
  'create a new leaf under the right topic and ATTACH it via `parentHubPath`. ' +
  'An unanchored new leaf is rejected with `placement_required`; create a hub first when no existing hub fits. ' +
  "To extend someone else's existing page, prefer op=append-section (with `section`) " +
  'over overwriting the whole page. ' +
  'One memory per distinct topic. A returned {"ok":true} means the mutation succeeded: ' +
  'for that fact/path, do not call memory_write again in this turn to polish or verify; ' +
  'use memory_load instead. Canonical content is PKF; markdown exists only as a legacy compatibility input and is normalized before storage.';

export const MEMORY_BROWSE_DESCRIPTION =
  'See the current memory structure BEFORE writing: the INDEX, existing hubs ' +
  '(with what each is about), and pages nearest to your query. Use it to decide ' +
  'placement (attach under a hub via memory_write parentHubPath, extend an ' +
  'existing page, or create a new hub).';

/** memory_curate description. memory203/13 §0.5: Dream is the orchestrator's
 * `memory-dream` skill calling these WRITE VERBS directly — there is NO cloud-LLM
 * `run_dream` op (that autonomous cloud clustering path is retired). All curate
 * write ops are ORCHESTRATOR-ONLY. */
export const MEMORY_CURATE_DESCRIPTION =
  'Curate workspace memory (knowledge-base maintenance). Ops: ' +
  '`candidates` READS what to converge (unplaced leaves + near-duplicate clusters + ' +
  'stale, remote-conflict, and oversized pages) — call this FIRST to decide clusters; ' +
  '`promote_to_hub` turns a leaf page into a hub; ' +
  '`supersede` archives a page and marks it stale; ' +
  '`rebuild_index` rebuilds machine-owned hub TOCs; top INDEX Contents is derived live from the graph. ' +
  'Section-level verbs (memory211 W5): `section_merge` folds one near-duplicate section into another ' +
  '(the cloud lands the supersedes/derived-from provenance edges for you), ' +
  '`section_supersede` retires one section in place, ' +
  '`rewire` re-points a broken or wrong link. ' +
  '`candidates` is read-only (any agent). Every other op is ORCHESTRATOR-ONLY — ' +
  'if you are not the workspace orchestrator they return an error.';

/**
 * Adapter-agnostic JSONSchema for memory_search input. Per-adapter wrappers
 * (claude-code, hermes, etc.) re-shape this into their host's tool schema
 * (Anthropic SDK tool, Hermes plugin tool, OpenClaw extension tool, Codex
 * MCP tool) but the field names and constraints are FROZEN here.
 */
export const MEMORY_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Free-text search query. Whitespace-separated terms are ANDed.',
      minLength: 1,
    },
    queries: {
      type: 'array',
      description:
        'Batch recall: up to 8 related questions answered in ONE call, returned grouped ' +
        'in `resultsByQuery`. Prefer this over several separate memory_search calls.',
      items: { type: 'string', minLength: 1 },
      maxItems: 8,
    },
    limit: {
      type: 'integer',
      description: 'Max number of results (default 5, max 20).',
      minimum: 1,
      maximum: 20,
      default: 5,
    },
    sourceWorkspaceId: {
      type: 'string',
      description:
        'Optional granting workspace id. When set, memory_search uses an active cross-workspace memory grant and returns hits tagged tier=grant/sourceWorkspaceId.',
    },
    pageType: {
      type: 'array',
      description: 'Optional filter on page kind.',
      items: {
        type: 'string',
        enum: ['hub', 'leaf', 'decision', 'glossary', 'archive'],
      },
    },
  },
  required: ['query'],
} as const;

export const MEMORY_LOAD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    uri: {
      type: 'string',
      description: 'Full prismer:// URI (preferred). Mutually exclusive with workspaceId+path.',
      pattern: '^prismer://',
    },
    workspaceId: {
      type: 'string',
      description: 'Workspace identifier (used with `path`).',
    },
    sourceWorkspaceId: {
      type: 'string',
      description:
        'Optional granting workspace id. When set with `path`, memory_load reads through an active cross-workspace memory grant.',
    },
    path: {
      type: 'string',
      description: 'Workspace-relative memory file path (used with `workspaceId`).',
    },
  },
} as const;

export const MEMORY_WRITE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        "Workspace-relative semantic path for the page, e.g. 'decisions/auth-model.pkf'. " +
        "Reuse an existing page's path to extend/replace it.",
      minLength: 1,
    },
    content: {
      type: 'string',
      description: 'Canonical PKF page body. Markdown is accepted only for legacy compatibility and is normalized.',
      minLength: 1,
    },
    title: { type: 'string', description: 'Short page title.' },
    parentHubPath: {
      type: 'string',
      description:
        'Attach this page under an existing hub — get hub paths from memory_browse. ' +
        'The daemon records a graph edge (page → hub) so the page nests under the ' +
        'hub instead of hanging flat off INDEX.',
    },
    relation: {
      type: 'string',
      description: 'Edge type for parentHubPath (default child-of).',
      enum: ['child-of', 'related'],
    },
    op: {
      type: 'string',
      description:
        'Write operation (default replace = whole page). append-section appends a new ' +
        "section to an EXISTING page instead of overwriting it — preferred for extending someone else's " +
        'page. rewrite-section overwrites just the section addressed by `section`.',
      enum: ['replace', 'append-section', 'rewrite-section'],
    },
    section: {
      type: 'string',
      description: 'Heading id (slug) of the target section. Required for op=append-section / rewrite-section.',
    },
    visibility: {
      type: 'string',
      description:
        'Visibility scope for the page (default workspace). One of: workspace, ' +
        'agent:<imUserId>, private:<imUserId>, role:<slug>, council:<councilId>. ' +
        'role:/council: are for orchestrator writeback (e.g. a council roundtable ' +
        'writing a shared decision as council:<councilId>); a non-orchestrator ' +
        'caller falls back to workspace. Unknown values are treated as workspace.',
    },
  },
  required: ['path', 'content'],
} as const;

export const MEMORY_BROWSE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Optional topic — adds the nearest existing pages to the structure view.',
    },
  },
} as const;

export const MEMORY_CURATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      description:
        'Curation operation. candidates = READ unplaced/near-dup/stale/conflict/oversized surfaces (call first); ' +
        'promote_to_hub = leaf→hub; ' +
        'supersede = archive+stale; rebuild_index = rebuild hub TOCs (INDEX Contents is derived); ' +
        'section_merge = fold a near-duplicate section into another; ' +
        'section_supersede = retire one section; rewire = re-point a link.',
      enum: [
        'candidates',
        'promote_to_hub',
        'supersede',
        'rebuild_index',
        'section_merge',
        'section_supersede',
        'rewire',
      ],
    },
    pageId: {
      type: 'string',
      description:
        'Target page id. Required for promote_to_hub and supersede. For section_merge this is the WINNER page ' +
        '(the section that absorbs the duplicate). For section_supersede this is the page whose section retires.',
    },
    childPaths: {
      type: 'array',
      items: { type: 'string' },
      description: 'promote_to_hub only — existing page paths to attach under the new hub as its children.',
    },
    reason: {
      type: 'string',
      description: 'Optional reason recorded by supersede / section_merge / section_supersede.',
    },
    kind: {
      type: 'string',
      description: 'candidates only — which surface to read (default all).',
      enum: ['orphans', 'duplicates', 'stale', 'conflicts', 'oversized', 'all'],
    },
    limit: {
      type: 'integer',
      description: 'candidates only — max items per kind.',
      minimum: 1,
      maximum: 500,
    },
    section: {
      type: 'string',
      description: 'section_supersede only — anchor slug of the section to retire.',
    },
    targetSection: {
      type: 'string',
      description: 'section_merge only — anchor slug of the WINNER section that absorbs the duplicate.',
    },
    sourcePageId: {
      type: 'string',
      description: 'section_merge only — id of the LOSER page whose section is folded away.',
    },
    sourceSection: {
      type: 'string',
      description: 'section_merge only — anchor slug of the LOSER section.',
    },
    mergedContent: {
      type: 'string',
      description:
        'section_merge only — the merged section body to write into the winner (PKF per pkf-writing). ' +
        'The cloud writes the supersedes/derived-from provenance edges automatically.',
    },
    supersededByPageId: {
      type: 'string',
      description: 'section_supersede only — optional surviving page the retired section points at.',
    },
    supersededBySection: {
      type: 'string',
      description: 'section_supersede only — anchor slug on supersededByPageId.',
    },
    linkId: {
      type: 'string',
      description: 'rewire only — id of the link to re-point.',
    },
    toPageId: {
      type: 'string',
      description: 'rewire only — new target page id (mutually exclusive with toPath).',
    },
    toPath: {
      type: 'string',
      description: 'rewire only — new target page path (mutually exclusive with toPageId).',
    },
    toSection: {
      type: 'string',
      description: 'rewire only — optional new target section anchor.',
    },
  },
  required: ['op'],
} as const;

/**
 * Generic tool spec carrier — adapter wrappers re-export this in their host's
 * preferred shape. The 4 adapter integrations only need to map these three
 * fields into their tool registration surface.
 */
export interface SharedToolSpec {
  name:
    | 'memory_search'
    | 'memory_load'
    | 'memory_browse'
    | 'memory_write'
    | 'memory_curate'
    | 'pkf_mint_sids'
    | 'pkf_validate'
    | 'pkf_outline'
    | 'pkf_search'
    | 'pkf_read'
    | 'pkf_bundle_commit'
    | 'pkf_checkout_file'
    | 'pkf_status_file'
    | 'pkf_commit_file'
    | 'pkf_normalize_file'
    | 'pkf_svg_check'
    | 'pkf_reply_inline';
  description: string;
  inputSchema: object;
}

export const MEMORY_SEARCH_TOOL: SharedToolSpec = {
  name: 'memory_search',
  description: MEMORY_SEARCH_DESCRIPTION,
  inputSchema: MEMORY_SEARCH_INPUT_SCHEMA,
};

export const MEMORY_LOAD_TOOL: SharedToolSpec = {
  name: 'memory_load',
  description: MEMORY_LOAD_DESCRIPTION,
  inputSchema: MEMORY_LOAD_INPUT_SCHEMA,
};

// memory203/18 R6.5 (partial — spec alignment for what now exists): the write +
// browse tools join the FROZEN spec. The Hermes provider shell
// (plugins/memory/prismer/__init__.py) mirrors these schemas 1:1.
export const MEMORY_WRITE_TOOL: SharedToolSpec = {
  name: 'memory_write',
  description: MEMORY_WRITE_DESCRIPTION,
  inputSchema: MEMORY_WRITE_INPUT_SCHEMA,
};

export const MEMORY_BROWSE_TOOL: SharedToolSpec = {
  name: 'memory_browse',
  description: MEMORY_BROWSE_DESCRIPTION,
  inputSchema: MEMORY_BROWSE_INPUT_SCHEMA,
};

export const MEMORY_CURATE_TOOL: SharedToolSpec = {
  name: 'memory_curate',
  description: MEMORY_CURATE_DESCRIPTION,
  inputSchema: MEMORY_CURATE_INPUT_SCHEMA,
};

/**
 * Implementation factory. Returns two callables (`search`, `load`) bound to
 * a daemon URL + workspace context. Each callable hits the daemon's
 * `/local/memory/*` routes via plain HTTP and parses the JSON response.
 *
 * Created once per agent process boot (or per task — adapter's choice).
 * Workspace context is captured at construction so tool calls don't need to
 * pass it on each invocation; the LLM only sees the user-facing input shape.
 */
export interface MemoryToolBindings {
  daemonUrl: string;
  workspaceId: string;
  /**
   * The agent's IM user id, forwarded so the daemon can attribute the
   * `recall_pull` observability event to the right actor. Omit for anonymous
   * callers — the daemon then skips emission rather than fabricating an actor.
   */
  actorImUserId?: string;
  /** Actor kind for the recall_pull event. Defaults to 'agent' daemon-side. */
  actorKind?: 'human' | 'agent';
  /**
   * Per-agent scoped capability token (memory203 doc 08 §2, F4). Sent on every
   * memory RPC as the `x-prismer-memory-cap` header so the daemon can verify
   * the caller's workspace scope. Defaults to `process.env.PRISMER_MEMORY_CAP`,
   * which the daemon injects into the spawned agent process env — so an
   * in-process tool client picks it up with no extra wiring. The daemon is
   * FAIL-CLOSED (spec16 §8.1 MA-0S): no cap → 401 `memory_cap_required`,
   * invalid cap → 401 `memory_cap_invalid` (the tool call throws); cross-ws →
   * 403. There is no enforce-off mode — the tool must carry a cap or every
   * call fails.
   */
  cap?: string;
}

export function buildMemoryToolImpls(bindings: MemoryToolBindings): {
  search(input: MemorySearchInput): Promise<MemorySearchOutput>;
  load(input: MemoryLoadInput): Promise<MemoryLoadOutput>;
  curate(input: MemoryCurateInput): Promise<MemoryCurateOutput>;
} {
  const base = bindings.daemonUrl.replace(/\/$/, '');
  let currentCap = bindings.cap ?? process.env.PRISMER_MEMORY_CAP;
  const capHeaders = (): Record<string, string> => (currentCap ? { 'x-prismer-memory-cap': currentCap } : {});
  const fetchWithCapRefresh = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const request = () =>
      fetch(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), ...capHeaders() },
      });
    const first = await request();
    if (first.status !== 401 || !currentCap) return first;
    const failure = (await first
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null;
    if (failure?.error !== 'memory_cap_invalid') return first;

    // A stale signed v2 cap can be renewed only while the daemon still holds
    // a valid Cloud authority snapshot for this actor/workspace. Renewal is
    // attempted exactly once; revocation, lease expiry and tampering remain a
    // 401 and the original operation is never retried with wider authority.
    const refresh = await fetch(`${base}/local/memory/cap/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...capHeaders() },
      body: '{}',
    });
    if (!refresh.ok) return first;
    const body = (await refresh.json().catch(() => null)) as { cap?: unknown } | null;
    if (typeof body?.cap !== 'string' || !body.cap.trim()) return first;
    currentCap = body.cap.trim();
    return request();
  };
  const applyActor = (params: URLSearchParams): void => {
    if (bindings.actorImUserId) {
      params.set('actorImUserId', bindings.actorImUserId);
      params.set('actorKind', bindings.actorKind ?? 'agent');
    }
  };
  return {
    async search(input: MemorySearchInput): Promise<MemorySearchOutput> {
      const params = new URLSearchParams({
        workspaceId: bindings.workspaceId,
        q: input.query,
      });
      // memory211/01 轴C W1a — batch: the RPC is a GET, so the array travels
      // JSON-encoded in one `queries` param. When `queries` is supplied the
      // daemon answers it and ignores `q`; `q` is still sent so an OLDER daemon
      // (no batch support) keeps working with just the first query.
      if (input.queries && input.queries.length > 0) {
        params.set('queries', JSON.stringify(input.queries.slice(0, 8)));
      }
      if (input.sourceWorkspaceId) params.set('sourceWorkspaceId', input.sourceWorkspaceId);
      applyActor(params);
      if (input.limit !== undefined) params.set('topK', String(input.limit));
      if (input.pageType && input.pageType.length > 0) {
        // Daemon's /local/memory/search accepts a single pageType per query
        // string param; multi-value support is phase-1. Phase-0: take first.
        params.set('pageType', input.pageType[0]!);
      }
      const url = `${base}/local/memory/search?${params.toString()}`;
      const res = await fetchWithCapRefresh(url);
      if (!res.ok) {
        throw new Error(`memory_search: daemon returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as MemorySearchOutput;
      return body;
    },

    async load(input: MemoryLoadInput): Promise<MemoryLoadOutput> {
      const params = new URLSearchParams();
      if (input.uri) {
        params.set('uri', input.uri);
      } else if (input.sourceWorkspaceId && input.path) {
        params.set('workspaceId', bindings.workspaceId);
        params.set('sourceWorkspaceId', input.sourceWorkspaceId);
        params.set('path', input.path);
      } else if (input.workspaceId && input.path) {
        params.set('workspaceId', input.workspaceId);
        params.set('path', input.path);
      } else {
        throw new Error('memory_load: requires either `uri` or `workspaceId`+`path`');
      }
      applyActor(params);
      const url = `${base}/local/memory/load?${params.toString()}`;
      const res = await fetchWithCapRefresh(url);
      if (res.status === 404) {
        throw new Error(`memory_load: page not found`);
      }
      if (!res.ok) {
        throw new Error(`memory_load: daemon returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as MemoryLoadOutput;
      return body;
    },

    async curate(input: MemoryCurateInput): Promise<MemoryCurateOutput> {
      // `candidates` is the READ half (memory203/13 §P4): a GET passthrough to
      // /local/memory/health → cloud /memory/health/*. Read-only (not
      // orchestrator-gated), so the orchestrator can SEE orphan leaves /
      // near-dup clusters / stale pages BEFORE deciding clusters + enacting the
      // write verbs below. The other three ops are POST write verbs.
      if (input.op === 'candidates') {
        const params = new URLSearchParams({ workspaceId: bindings.workspaceId });
        if (input.kind) params.set('kind', input.kind);
        if (input.limit !== undefined) params.set('limit', String(input.limit));
        const url = `${base}/local/memory/health?${params.toString()}`;
        const res = await fetchWithCapRefresh(url);
        const body = (await res.json().catch(() => null)) as MemoryCurateOutput | null;
        if (!res.ok) {
          return {
            ok: false,
            op: input.op,
            error: body?.error ?? 'memory_candidates_failed',
            message: body?.message ?? `memory_curate(candidates): daemon returned HTTP ${res.status}`,
          };
        }
        return body ?? { ok: true, op: input.op };
      }

      // memory_curate forwards to the daemon's POST /local/memory/curate, which
      // in turn forwards to the CLOUD curation endpoints (the verbs live
      // cloud-side, operating on the superset). The workspace comes from the
      // bound context — the LLM only supplies op/pageId/reason. The cap header
      // is the same x-prismer-memory-cap the frozen tools send.
      const url = `${base}/local/memory/curate`;
      const res = await fetchWithCapRefresh(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: bindings.workspaceId,
          op: input.op,
          ...(input.pageId ? { pageId: input.pageId } : {}),
          ...(input.childPaths && input.childPaths.length > 0 ? { childPaths: input.childPaths } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          // memory211/01 W5 轴 G — section-level verbs (pass-through, same
          // posture as childPaths: the daemon forwards, the cloud authorizes).
          ...(input.section ? { section: input.section } : {}),
          ...(input.targetSection ? { targetSection: input.targetSection } : {}),
          ...(input.sourcePageId ? { sourcePageId: input.sourcePageId } : {}),
          ...(input.sourceSection ? { sourceSection: input.sourceSection } : {}),
          ...(input.mergedContent ? { mergedContent: input.mergedContent } : {}),
          ...(input.supersededByPageId ? { supersededByPageId: input.supersededByPageId } : {}),
          ...(input.supersededBySection ? { supersededBySection: input.supersededBySection } : {}),
          ...(input.linkId ? { linkId: input.linkId } : {}),
          ...(input.toPageId ? { toPageId: input.toPageId } : {}),
          ...(input.toPath ? { toPath: input.toPath } : {}),
          ...(input.toSection ? { toSection: input.toSection } : {}),
        }),
      });
      // The daemon passes the cloud status through verbatim. A 403
      // (orchestrator_only) is NOT thrown — it is returned as a structured
      // result so the agent gets a clear "you are not the orchestrator" signal
      // rather than a tool crash. Only genuine transport failures throw.
      const body = (await res.json().catch(() => null)) as MemoryCurateOutput | null;
      if (res.status === 403) {
        return {
          ok: false,
          op: input.op,
          error: body?.error ?? 'orchestrator_only',
          message: body?.message ?? 'This curation op is orchestrator-only — you are not the workspace orchestrator.',
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          op: input.op,
          error: body?.error ?? 'memory_curate_failed',
          message: body?.message ?? `memory_curate: daemon returned HTTP ${res.status}`,
        };
      }
      return body ?? { ok: true, op: input.op };
    },
  };
}

// ── pkf_mint_sids (product209/20 Runtime authoring plane) ─────────────────

export interface PkfMintSidsInput {
  count?: number;
}

export interface PkfMintSidsOutput {
  sids: string[];
}

export const PKF_MINT_SIDS_TOOL: SharedToolSpec = {
  name: 'pkf_mint_sids',
  description:
    'Mint canonical stable PKF section identities (`sec_` + 26 lowercase Crockford base32). Call once before authoring sections; preserve returned ids across renames and edits. Native function tool, never write a generator script.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 50, default: 1 },
    },
    additionalProperties: false,
  },
};

export type PkfBundleResourceUsage =
  | 'harness-manifest'
  | 'harness-script'
  | 'harness-style'
  | 'harness-resource'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'data';

export interface PkfBundleCommitInput {
  idempotencyKey: string;
  root: { filename: string; source: string; sourceHash: string };
  resources: Array<{
    path: string;
    fromPath?: string;
    bytesBase64: string;
    contentHash: string;
    integrity: string;
    mime: string;
    usage: PkfBundleResourceUsage;
  }>;
}

export const PKF_BUNDLE_COMMIT_TOOL: SharedToolSpec = {
  name: 'pkf_bundle_commit',
  description:
    'Atomically commit one logical PKF root plus every declared dependency, then verify the canonical Cloud readback. Use one stable idempotencyKey across retries. Provide CONTENT (bytesBase64 or text), paths, mime and usage — the Runtime computes every sha256/SRI/sourceHash, generates the harness manifest (or pass harnessDecl) and rewrites bundle-internal references to scoped asset URIs. Self-supplied hashes are verified locally. Never upload JS/CSS/media/CSV separately and never claim relationships from prose.',
  inputSchema: {
    type: 'object',
    properties: {
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 191 },
      root: {
        type: 'object',
        properties: {
          filename: { type: 'string', minLength: 1, maxLength: 191 },
          source: { type: 'string', minLength: 1 },
          sourceHash: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$',
            description: 'Optional — computed by the Runtime when omitted; verified against the source bytes when supplied.',
          },
        },
        required: ['filename', 'source'],
        additionalProperties: false,
      },
      resources: {
        type: 'array',
        minItems: 1,
        maxItems: 256,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 500 },
            fromPath: { type: 'string', minLength: 1, maxLength: 500 },
            bytesBase64: { type: 'string', minLength: 1 },
            text: {
              type: 'string',
              description: 'utf-8 text alternative to bytesBase64 — exactly one of the two per resource.',
            },
            contentHash: {
              type: 'string',
              pattern: '^[0-9a-f]{64}$',
              description: 'Optional — computed by the Runtime when omitted; verified when supplied.',
            },
            integrity: {
              type: 'string',
              pattern: '^sha256-[A-Za-z0-9+/]+={0,2}$',
              description: 'Optional — computed by the Runtime when omitted; verified when supplied.',
            },
            mime: { type: 'string', minLength: 1, maxLength: 191 },
            usage: {
              type: 'string',
              enum: [
                'harness-manifest',
                'harness-script',
                'harness-style',
                'harness-resource',
                'image',
                'video',
                'audio',
                'file',
                'data',
              ],
            },
          },
          required: ['path', 'mime', 'usage'],
          additionalProperties: false,
          anyOf: [{ required: ['bytesBase64'] }, { required: ['text'] }],
        },
      },
      harnessDecl: {
        type: 'object',
        description:
          'Optional harness declaration — the Runtime generates the manifest.json resource (usage harness-manifest) with real SRI and scoped URIs.',
        properties: {
          scripts: { type: 'array', items: { type: 'string' }, description: 'bundle paths of the JS entries' },
          styles: { type: 'array', items: { type: 'string' }, description: 'bundle paths of the CSS entries' },
          entry: { type: 'string', description: 'output path for the generated manifest (default manifest.json)' },
          csp: { type: 'string' },
          sandbox: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
    required: ['idempotencyKey', 'root', 'resources'],
    additionalProperties: false,
  },
};

const PKF_SID_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

function encodePkfSidPart(value: bigint, length: number): string {
  let current = value;
  let out = '';
  for (let i = 0; i < length; i++) {
    out = PKF_SID_BASE32[Number(current % 32n)] + out;
    current /= 32n;
  }
  return out;
}

/** ULID-shaped, cryptographically random section identities. */
export function runPkfMintSidsLocal(input: PkfMintSidsInput = {}): PkfMintSidsOutput {
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error('pkf_mint_sids count must be an integer between 1 and 50');
  }
  const timestamp = BigInt(Date.now());
  const sids = new Set<string>();
  while (sids.size < count) {
    const random = BigInt(`0x${randomBytes(10).toString('hex')}`);
    sids.add(`sec_${encodePkfSidPart(timestamp, 10)}${encodePkfSidPart(random, 16)}`);
  }
  return { sids: [...sids] };
}

// ── pkf_validate (product209/15 PKF-D3) ──────────────────────────────────────
//
// Pure LOCAL tool — validates PKF source in-process against the bundled
// @prismer/pkf (no daemon RPC, no shell-out, no cloud). Offline by
// construction: Cloud unreachable ⇒ validation still works.

export interface PkfValidateInput {
  source: string;
  /** structure (default) | resolved — resolved needs a workspaceId. */
  level?: 'structure' | 'resolved';
  workspaceId?: string;
  /** optional harness manifest object for interactive PKF. */
  harnessManifest?: unknown;
}

export interface PkfValidateOutput {
  sourceHash: string;
  schemaVersion: string | null;
  structureStatus: 'pass' | 'fail';
  resourceStatus: 'pass' | 'fail' | 'unverified';
  strictOk: boolean;
  diagnostics: Array<{ code: string; level: 'error' | 'warning'; message: string; at?: string }>;
}

export const PKF_VALIDATE_TOOL: SharedToolSpec = {
  name: 'pkf_validate',
  description:
    'Validate PKF source in-process (structure rules; resolved adds workspace resource checks). Offline — never shells out. Exit semantics: structure fail = reject the write.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Full PKF source (v1.1 or legacy v1.0).' },
      level: { type: 'string', enum: ['structure', 'resolved'], description: 'structure default.' },
      workspaceId: { type: 'string', description: 'Required for resolved level.' },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

/** Local implementation — bundled core only, no I/O beyond pure parse. */
export function runPkfValidateLocal(input: PkfValidateInput): PkfValidateOutput {
  const parsed = parsePkf(input.source);
  const result = validatePkf(parsed, { harnessManifest: input.harnessManifest });
  return {
    sourceHash: createHash('sha256').update(input.source).digest('hex'),
    schemaVersion: parsed.schemaVersion,
    structureStatus: result.structureStatus,
    resourceStatus: result.resourceStatus,
    strictOk: result.strictOk,
    diagnostics: result.diagnostics.map((d) => ({ code: d.code, level: d.level, message: d.message, at: d.at })),
  };
}

// ── pkf_svg_check (pkf209/07 §5 Phase 3) ─────────────────────────────────────
//
// Pure LOCAL tool — the controlled-svg authoring loop: write → check → fix
// without spending a commit round. Runs the same @prismer/pkf audit as the
// server validator (frozen D19 whitelist + the §5 quality floors), in-process,
// offline. NOT part of REQUIRED_PKF_NATIVE_TOOLS: runtimes without it must
// not report the PKF plane unavailable.

export interface PkfSvgCheckInput {
  /** The complete controlled svg markup (the `<svg>…</svg>` inner block). */
  svg: string;
}

export interface PkfSvgCheckOutput {
  structureStatus: 'pass' | 'fail';
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  budgets: { elements: number; attributes: number; viewBox: string | null };
}

export const PKF_SVG_CHECK_TOOL: SharedToolSpec = {
  name: 'pkf_svg_check',
  description:
    'Validate one controlled svg markup in-process (frozen whitelist + quality floors; stable svg-* codes with fix-oriented diagnostics). Offline — never shells out. Check-then-fix loop for prismer-svg authoring; a fail means the svg must be repaired before persisting.',
  inputSchema: {
    type: 'object',
    properties: {
      svg: {
        type: 'string',
        description: 'Complete controlled svg markup (the <svg>…</svg> inner block of a prismer-svg element).',
      },
    },
    required: ['svg'],
    additionalProperties: false,
  },
};

/** Local implementation — pure audit over the bundled core, no I/O. */
export function runPkfSvgCheckLocal(input: PkfSvgCheckInput): PkfSvgCheckOutput {
  const svg = typeof input.svg === 'string' ? input.svg : '';
  if (!svg.trim()) throw new Error('pkf_svg_check input "svg" must be a non-empty string');
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]*)"/i.exec(svg)?.[1]?.trim() ?? null;
  const audit = auditPkfSvg({
    width: null,
    height: null,
    viewBox: viewBox && viewBox.length > 0 ? viewBox : null,
    svg,
    raw: svg,
    sourceSection: null,
  });
  return {
    structureStatus: audit.issues.length === 0 ? 'pass' : 'fail',
    errors: audit.issues,
    warnings: audit.warnings,
    budgets: audit.budgets,
  };
}

// ── pkf_reply_inline (pkf209 mechanical inline-PKF delivery) ────────────────
//
// 2026-08-20 matrix root cause: weak models author + validate a compliant PKF
// and then fail the FINAL step — pasting the sentinel-wrapped bytes verbatim
// into the reply text. This tool removes that burden: the model passes only a
// FILE PATH; the daemon validates the bytes and the dispatch terminal state
// mechanically attaches the inline ContentBlock. NOT part of
// REQUIRED_PKF_NATIVE_TOOLS (an old runtime without it must not report the
// PKF plane unavailable — those agents keep the sentinel wire path).

export interface PkfReplyInlineToolInput {
  /**
   * Path of the validated `.pkf` file (relative to the task scratch dir, or
   * absolute inside the task scratch/workdir). Must resolve inside this
   * task's scratch dir or workdir — no `../` escape.
   */
  path: string;
}

export const PKF_REPLY_INLINE_TOOL: SharedToolSpec = {
  name: 'pkf_reply_inline',
  description:
    'Deliver your final report as the message-inline PKF ContentBlock, mechanically. Write the complete PKF v1.1 to a file in your task scratch dir, pass pkf_validate on it, then call this tool ONCE with the file path — the Runtime re-validates the file and attaches the inline ContentBlock to your reply for you. Never paste sentinel comments into the reply; never attach the .pkf as a file. Keep the reply text as the readable markdown projection.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Path of the validated .pkf file — relative to your task scratch dir (e.g. "memo.pkf") or absolute inside the task scratch/workdir.',
        minLength: 1,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

// ── pkf_outline / pkf_search / pkf_read (product209/15 PKF-H2) ──────────────
//
// Bounded local query tools over the bundled core: outline/search/read operate
// on PKF source in-process — bounded output (32 KiB), signed cursors, no
// includeSource escape. Fully offline.

import { outlinePkf, parsePkfSource, readPkf, searchPkf } from '@prismer/pkf';

export interface PkfQueryInput {
  source: string;
  documentUri?: string;
  revisionId?: string;
  query?: string;
  anchorSlug?: string;
  sectionSid?: string;
  limit?: number;
  maxBytes?: number;
  cursor?: string;
}

export interface PkfQueryOutput {
  sourceHash: string;
  revisionId: string | null;
  complete: boolean;
  nextCursor: string | null;
  sections?: unknown[];
  matches?: unknown[];
  content?: string;
  ok: boolean;
  code?: string;
}

export const PKF_OUTLINE_TOOL: SharedToolSpec = {
  name: 'pkf_outline',
  description:
    'Bounded semantic outline of a PKF source (sections, typed-block counts). Output ≤32 KiB; paginate via nextCursor.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      documentUri: { type: 'string' },
      revisionId: { type: 'string' },
      cursor: { type: 'string' },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

export const PKF_SEARCH_TOOL: SharedToolSpec = {
  name: 'pkf_search',
  description:
    'Bounded text search over a PKF source (UTF-8 substring, no regex). Returns snippets + opaque match ids.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      documentUri: { type: 'string' },
      revisionId: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['source', 'query'],
    additionalProperties: false,
  },
};

export const PKF_READ_TOOL: SharedToolSpec = {
  name: 'pkf_read',
  description: 'Bounded section read of a PKF source (default 16 KiB, hard cap 64 KiB — no includeSource).',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      documentUri: { type: 'string' },
      revisionId: { type: 'string' },
      anchorSlug: { type: 'string' },
      sectionSid: { type: 'string' },
      maxBytes: { type: 'number' },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

/** Local outline implementation over the bundled core. */
export function runPkfOutlineLocal(input: PkfQueryInput): PkfQueryOutput {
  const doc = parsePkfSource(input.source);
  const out = outlinePkf(doc, {
    documentUri: input.documentUri,
    revisionId: input.revisionId,
    cursor: input.cursor,
  });
  return {
    sourceHash: out.sourceHash,
    revisionId: out.revisionId,
    complete: out.complete,
    nextCursor: out.nextCursor,
    sections: out.sections,
    ok: true,
  };
}

/** Local search implementation over the bundled core. */
export function runPkfSearchLocal(input: PkfQueryInput): PkfQueryOutput {
  const doc = parsePkfSource(input.source);
  const out = searchPkf(doc, input.query ?? '', {
    documentUri: input.documentUri,
    revisionId: input.revisionId,
    limit: input.limit,
  });
  return {
    sourceHash: out.sourceHash,
    revisionId: out.revisionId,
    complete: out.complete,
    nextCursor: out.nextCursor,
    matches: out.matches,
    ok: true,
  };
}

/** Local read implementation over the bundled core. */
export function runPkfReadLocal(input: PkfQueryInput): PkfQueryOutput {
  const doc = parsePkfSource(input.source);
  const out = readPkf(
    doc,
    { anchorSlug: input.anchorSlug, sectionSid: input.sectionSid, maxBytes: input.maxBytes },
    { documentUri: input.documentUri, revisionId: input.revisionId },
  );
  return {
    sourceHash: out.sourceHash,
    revisionId: out.revisionId,
    complete: out.complete,
    nextCursor: null,
    content: out.content,
    ok: out.ok,
    code: out.code,
  };
}

// ── pkf_checkout_file / pkf_status_file / pkf_commit_file / pkf_normalize_file
// (product209/15 PKF-H5 §7.6.2 — path-only lifecycle tools) ─────────────────
// The model NEVER passes document bytes as arguments: these tools take paths
// only; the host reads files from the task root and delegates to the same H5
// service the CLI uses.

export const PKF_CHECKOUT_TOOL: SharedToolSpec = {
  name: 'pkf_checkout_file',
  description:
    'Check out a PKF document revision as an ordinary UTF-8 file in the task workspace (path-only — the model never passes source). Binds a durable checkout record.',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string' },
      revisionId: { type: 'string' },
      workspaceRelativePath: { type: 'string' },
    },
    required: ['uri', 'workspaceRelativePath'],
    additionalProperties: false,
  },
};

export const PKF_STATUS_TOOL: SharedToolSpec = {
  name: 'pkf_status_file',
  description:
    'Report the checkout state of a PKF file (clean/dirty/missing), whole-page validation and a bounded diff vs the base revision. Never commits.',
  inputSchema: {
    type: 'object',
    properties: { workspaceRelativePath: { type: 'string' }, diffCursor: { type: 'string' } },
    required: ['workspaceRelativePath'],
    additionalProperties: false,
  },
};

export const PKF_COMMIT_TOOL: SharedToolSpec = {
  name: 'pkf_commit_file',
  description:
    'Commit the FINAL file bytes through the carrier CAS (path-only). Requires the worktree dirty + whole-page validation pass; normalization churn needs the explicit flag.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRelativePath: { type: 'string' },
      message: { type: 'string' },
      dryRun: { type: 'boolean' },
      dryRunReceiptToken: { type: 'string' },
      allowSourceNormalization: { type: 'boolean' },
    },
    required: ['workspaceRelativePath', 'message'],
    additionalProperties: false,
  },
};

export const PKF_NORMALIZE_TOOL: SharedToolSpec = {
  name: 'pkf_normalize_file',
  description:
    'Normalize a checked-out PKF file into canonical <section> form (structural markers only, never business bytes).',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRelativePath: { type: 'string' },
      dryRun: { type: 'boolean' },
      dryRunReceiptToken: { type: 'string' },
    },
    required: ['workspaceRelativePath'],
    additionalProperties: false,
  },
};

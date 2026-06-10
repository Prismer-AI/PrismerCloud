// Fork SPI types — M-B (doc 25 §3 支柱 2).
//
// The daemon's job is to stage candidate memory pages and parse the LLM
// selector's output. The host (Hermes / CC / OpenClaw / Codex) runs the
// LLM call so the daemon never holds API keys (option A from doc 25 §7
// judgment 4).
//
// The types here describe the contract between daemon and host:
//
//   1. Daemon Stage-1: enumerate candidates → ManifestEntry[]
//   2. Host Stage-2:   build prompt + call LLM → selector text response
//   3. Daemon parse:   selector text → RelevantMemory[]
//
// All types are JSON-serializable so they cross the daemon RPC boundary
// cleanly. Buffer / Date / class instances are off-limits.

/**
 * One candidate memory page in a Stage-1 manifest. Contains only the
 * surface metadata the LLM selector needs to make a "is this useful?"
 * decision — no content body, no history, no provenance. Keeps the
 * manifest small enough to fit a Sonnet/Haiku context budget even for
 * workspaces with thousands of pages.
 */
export interface ManifestEntry {
  /** Workspace-relative path (e.g. "memory/feedback/sdk-naming.md"). */
  path: string;
  /** Human-readable title. Null when the page never had one set. */
  title: string | null;
  /** Page type: hub, leaf, decision, glossary, archive. */
  pageType: string;
  /** Short description (first line of body, ≤200 chars). Null when absent. */
  description: string | null;
  /** Last-modified epoch millis. Used by the host to surface freshness. */
  mtimeMs: number;
}

/**
 * Manifest payload emitted by the daemon's Stage-1 endpoint. The
 * manifest is bounded — see `recall/manifest` route options for caps.
 */
export interface ManifestResponse {
  workspaceId: string;
  /** Free-text query that produced this manifest (echoed for observability). */
  query: string;
  /** Candidate entries, ranked by FTS relevance when q is non-empty;
   *  recently-updated when q is empty. */
  entries: ManifestEntry[];
  /** True if the corpus had more pages than `entries.length` and was capped. */
  truncated: boolean;
}

/**
 * One memory page returned by the finalize endpoint after the host
 * picked a subset of manifest entries. Includes a content snippet so the
 * agent can decide whether to call `memory_load` for the full body.
 */
export interface RelevantMemory {
  pageId: string;
  path: string;
  title: string | null;
  /** Short content excerpt — first ~500 bytes by default. */
  snippet: string;
  /** Last-modified epoch millis. */
  mtimeMs: number;
  /** `prismer://workspace/<id>/memory/<path>` for tool callbacks. */
  uri: string;
}

/**
 * Cache-safe LLM call parameters (M-B fork SPI). The host uses these to
 * build a request body whose system + tools + model + messages prefix
 * are byte-identical to the parent session, so prompt-cache hits stack
 * across the fork. The daemon doesn't actually run the LLM — these
 * values are passed-through into the daemon's `runForkedRecall` only so
 * tracing can record what got run.
 *
 * Modeled on CC's `CacheSafeParams` (luminclaw/ref/CC-Source/src/utils/
 * forkedAgent.ts:489-512). We omit `userContext`, `systemContext`, and
 * `toolUseContext` because they're CC-specific runtime state; for our
 * use case (single-shot LLM selector with no tool use) the parent
 * session's system+tools is enough to keep the cache coherent.
 */
export interface CacheSafeParams {
  /** Model name passed to the host's LLM client. */
  model: string;
  /** Parent session's system prompt verbatim. */
  systemPrompt: string;
  /** Parent's tool definitions verbatim, even though the fork won't use them. */
  tools?: ReadonlyArray<unknown>;
  /** Parent message prefix this fork inherits (cache-warmth carrier). Empty
   *  means a cold fork — accepted but expected to miss the cache. */
  forkContextMessages?: ReadonlyArray<unknown>;
}

/**
 * Result of `parseSelectorOutput` — the host calls this after the LLM
 * returns. The daemon then resolves these filenames into full
 * RelevantMemory rows via the finalize endpoint.
 */
export interface SelectedFilenames {
  selected: string[];
  /** Raw selector output for tracing / debugging. */
  rawText: string;
}

/**
 * Fork tracing event — emitted to the daemon outbox so observability
 * dashboards see fork-driven recall the same way as recall_pull /
 * recall_inject. Mirrors CC's `tengu_fork_agent_query` payload.
 */
export interface ForkTraceEvent {
  /** Workspace this fork ran inside. */
  workspaceId: string;
  /** Fork label — e.g. "memory_recall", "session_extract". */
  forkLabel: string;
  /** Stable ID for joining fork start / finish events. */
  forkId: string;
  /** Wallclock start / end (UTC ISO). */
  startedAt: string;
  /** Total wall time of the fork (start of Stage-1 to end of parse). */
  durationMs: number;
  /** Number of manifest entries passed to the LLM. */
  manifestEntryCount: number;
  /** Number of paths the LLM selected (after filename validation). */
  selectedCount: number;
  /** Cache stats reported back by the host's LLM call (when available). */
  promptCache?: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
}

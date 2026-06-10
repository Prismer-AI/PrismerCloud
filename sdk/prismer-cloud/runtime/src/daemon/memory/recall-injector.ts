// v2.0 Wave 4-E6 — Recall auto-inject for turn orchestration.
//
// Doc reference: docs/release200/14-messaging-state-machine-reliability.md §4.7
//
// Purpose
// -------
// At the START of every agent turn (before the LLM call) the daemon should:
//   1. Take the user's incoming message (text from contentBlocks)
//   2. Search this agent's memory (workspace-shared + agent-private buckets)
//   3. If top-N relevant memory snippets exceed a relevance threshold,
//      inject them as a `[Relevant memory]` system block before the user
//      message — exactly the pattern Hermes uses in `conversation_loop.py`
//      §thinking_callback.
//
// Why daemon-side (not cloud-side)?
//   - 0 network round-trips (local SQLite FTS5 < 5ms typical)
//   - Cloud is fallback (FF_MEMORY_SEARCH_DAEMON_FIRST drives the routing)
//   - operatingPrinciples in agent SKILL.md frontmatter can opt out of auto-inject
//     ("recallTrigger: off") — the orchestrator passes that flag here, this
//     function never decides to inject when disabled.
//
// Q1 A clarification (from task brief):
//   operatingPrinciples (incl. recallTrigger preference) lives in SKILL.md
//   frontmatter, NOT in the cloud im_agents row. The orchestrator parses
//   SKILL.md and passes `enabled: false` to suppress injection — no cloud
//   schema change.

import type { MemorySearchResult } from './types.js';
import type { ScopedMemoryStore } from './scoped-store.js';

export interface RecallInjectInput {
  /** Free-form text the agent is about to react to (typically the user message). */
  text: string;
  /** This agent's IM user id — used to query its agent-private bucket. */
  agentImUserId: string;
  /** When false, returns an empty injection regardless of search results. */
  enabled?: boolean;
  /** Top-N results to inject. Defaults to 5. */
  topK?: number;
  /** Minimum normalized BM25 score (0..1) to include. Defaults to 0.3. */
  minScore?: number;
  /** Max bytes for the entire injected block. Defaults to 2048. */
  maxBytes?: number;
}

export interface RecallInjection {
  /**
   * The system block to prepend to the LLM prompt, or null when there's
   * nothing relevant to inject. Format:
   *
   *   [Relevant memory]
   *   - path/to/page.md: snippet text...
   *   - other/note.md: snippet text...
   */
  systemBlock: string | null;
  /** Results selected for injection (for observability / metrics). */
  selectedResults: MemorySearchResult[];
  /** Why injection was skipped, when systemBlock is null. */
  skipReason?: 'disabled' | 'empty-query' | 'no-results' | 'no-results-above-threshold';
}

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_MAX_BYTES = 2048;

/**
 * Build the `[Relevant memory]` system block for the next turn.
 *
 * This is a pure function over the search results — the orchestrator
 * decides what to do with the returned block (e.g. prepend to LLM messages,
 * log to outbox as `recall_inject` event, etc.).
 *
 * Both invariants from §4.7 are preserved:
 *   - 0 round-trips to cloud (search runs against local SQLite FTS5)
 *   - agent-scope isolation (search merges shared + this agent's private bucket
 *     ONLY; other agents' private buckets are never read by this call)
 */
export function buildRecallInjection(
  store: ScopedMemoryStore,
  input: RecallInjectInput,
): RecallInjection {
  if (input.enabled === false) {
    return { systemBlock: null, selectedResults: [], skipReason: 'disabled' };
  }
  const text = input.text.trim();
  if (text.length === 0) {
    return { systemBlock: null, selectedResults: [], skipReason: 'empty-query' };
  }

  const topK = input.topK ?? DEFAULT_TOP_K;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  const results = store.searchForAgent(text, input.agentImUserId, {
    topK: topK * 2, // pull more so threshold filter has headroom
    maxBytes,
  });
  if (results.length === 0) {
    return { systemBlock: null, selectedResults: [], skipReason: 'no-results' };
  }

  const filtered = results.filter((r) => r.score >= minScore).slice(0, topK);
  if (filtered.length === 0) {
    return { systemBlock: null, selectedResults: [], skipReason: 'no-results-above-threshold' };
  }

  // Build the injection block. We use a strict deterministic format so the
  // observability layer (outbox `recall_inject` events) can re-parse it for
  // structured logging without a separate metadata field.
  const header = '[Relevant memory]';
  const lines: string[] = [header];
  let byteBudget = maxBytes - header.length - 1;
  for (const r of filtered) {
    const title = r.title?.trim() || r.path;
    const snippet = r.snippet.replace(/\s+/g, ' ').trim();
    const line = `- ${title}: ${snippet}`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > byteBudget) break;
    lines.push(line);
    byteBudget -= lineBytes + 1;
  }

  if (lines.length === 1) {
    return { systemBlock: null, selectedResults: [], skipReason: 'no-results-above-threshold' };
  }

  return {
    systemBlock: lines.join('\n'),
    selectedResults: filtered,
  };
}

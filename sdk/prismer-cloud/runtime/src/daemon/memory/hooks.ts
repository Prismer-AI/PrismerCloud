// Recall hooks — phase-1 C3 + C4 (M-A revised per doc 25 §3 支柱 1).
//
// Two hook factories:
//
//   onSessionStart(ctx)        → preload INDEX.md (≤200 lines / ≤25 KB) + emit recall_preload
//   onIdleRecallHint(ctx)      → optional opt-in workspace search building a
//                                <memory-context> fence (top-3 / ≤2 KB /
//                                relevance ≥ 0.5) + recall_inject per hit
//
// onIdleRecallHint replaced phase-1's `onBeforeLlmCall`. Per doc 25 §1.1, the
// previous "every turn auto-inject" behavior was over-engineered — it spammed
// noisy memory into idle conversation, polluted the prompt cache key, and
// gave the agent no agency. The hook still exists as a content producer for
// adapters that explicitly opt into idle-time recall (e.g. when the LLM
// signaled uncertainty), but no caller invokes it on every turn.
//
// These return the content for the adapter to inject; the adapter owner
// decides WHERE in the prompt the content goes (system-prompt section,
// user-message side, etc.) per doc 18 line 308 + dispatcher §"per-adapter
// declared". The hooks themselves don't touch any prompt — they're
// content-producers, not injection-performers.
//
// The agent-driven path is `memory_search` (the LLM-callable tool) — see
// adapters/memory-tools.ts for the selective tool description that steers
// agents to call it only when a specific question warrants prior memory.
//
// All observability events emit through the daemon's outbox channel, NOT a
// separate POST endpoint. The C2 outbox worker picks them up on the next
// tick and delivers to Line A's `/api/im/memory/sync/inbox`.

import { randomUUID } from 'node:crypto';
import type { MemoryRuntime } from './runtime.js';
import type { ActorKind, MemorySearchResult } from './types.js';

export interface SessionStartContext {
  workspaceId: string;
  agentImUserId: string;
  actorKind: ActorKind;
  sessionId: string;
  /** Override CC-baseline 200 lines. */
  maxLines?: number;
  /** Override CC-baseline 25 KB. */
  maxBytes?: number;
}

export interface SessionStartResult {
  content: string;
  truncated: boolean;
  pageId: string;
}

export interface IdleRecallHintContext {
  workspaceId: string;
  agentImUserId: string;
  actorKind: ActorKind;
  sessionId: string;
  turnIndex: number;
  /** Pre-built query string. Adapter is responsible for assembling it from
   *  lastUserMessage + activeTask?.title + openFiles[].name etc. — the hook
   *  doesn't peek at session state. */
  query: string;
  /** Override defaults. */
  topK?: number;
  maxBytes?: number;
  relevanceThreshold?: number;
}

export interface IdleRecallHintResult {
  fence: string;
  results: MemorySearchResult[];
}

const DEFAULT_PRELOAD_MAX_LINES = 200;
const DEFAULT_PRELOAD_MAX_BYTES = 25 * 1024;
const DEFAULT_INJECT_TOP_K = 3;
const DEFAULT_INJECT_MAX_BYTES = 2 * 1024;
const DEFAULT_INJECT_THRESHOLD = 0.5;

export class MemoryRecallHooks {
  constructor(
    private readonly runtime: MemoryRuntime,
    private readonly deviceId: string,
  ) {}

  /**
   * Agent session-start preload. Loads `INDEX.md` and returns its content
   * (truncated to budget) so the adapter can inject it into the prompt prefix.
   * Returns null if no INDEX.md exists or the workspace store cannot be opened.
   */
  onSessionStart(ctx: SessionStartContext): SessionStartResult | null {
    const slot = this.runtime.resolve(ctx.workspaceId);
    const indexPage = slot.store.loadByPath('INDEX.md');
    if (!indexPage) return null;

    const content = slot.store.loadContent(indexPage.id)?.content ?? '';
    const { output, truncated } = truncateToBudget(content, {
      maxLines: ctx.maxLines ?? DEFAULT_PRELOAD_MAX_LINES,
      maxBytes: ctx.maxBytes ?? DEFAULT_PRELOAD_MAX_BYTES,
    });

    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    slot.outbox.enqueue({
      eventId,
      schemaVersion: 1,
      eventType: 'recall_preload',
      workspaceId: ctx.workspaceId,
      actorImUserId: ctx.agentImUserId,
      actorKind: ctx.actorKind,
      deviceId: this.deviceId,
      createdAt,
      idempotencyKey: `obs:recall_preload:${ctx.agentImUserId}:${createdAt}:${eventId.slice(0, 8)}`,
      pageId: indexPage.id,
      metadataJson: {
        sessionId: ctx.sessionId,
        truncated,
        originalBytes: Buffer.byteLength(content, 'utf8'),
      },
      metricsJson: { tokenCount: estimateTokens(output) },
    });

    return { content: output, truncated, pageId: indexPage.id };
  }

  /**
   * Opt-in idle-time recall hint. Runs hybrid search on the workspace memory
   * store, builds a `<memory-context>` fence from the top-K results that fit
   * the byte budget, and emits one recall_inject event per included result.
   *
   * Returns null when:
   *   - query is empty / whitespace
   *   - search returns 0 results above the relevance threshold
   *
   * **Not** an automatic per-turn hook. Adapters call this only when they
   * have a deliberate signal that prior memory might help (e.g. the LLM
   * emitted "I don't recall" or the turn returned a low-token reply). The
   * default Hermes / CC / OpenClaw / Codex wiring does NOT call it on every
   * turn — see doc 25 §3 支柱 1 (M-A) for the rationale.
   *
   * Adapter owner integrates this by calling `onIdleRecallHint` from their
   * own opt-in code path, then injecting `result.fence` into whichever
   * prompt slot their host uses (per-adapter declared).
   */
  onIdleRecallHint(ctx: IdleRecallHintContext): IdleRecallHintResult | null {
    if (!ctx.query.trim()) return null;
    const slot = this.runtime.resolve(ctx.workspaceId);
    const results = slot.search.hybrid(ctx.query, {
      topK: ctx.topK ?? DEFAULT_INJECT_TOP_K,
      maxBytes: ctx.maxBytes ?? DEFAULT_INJECT_MAX_BYTES,
      relevanceThreshold: ctx.relevanceThreshold ?? DEFAULT_INJECT_THRESHOLD,
    });
    if (results.length === 0) return null;

    const fence = buildFence(results);

    for (const r of results) {
      const eventId = randomUUID();
      const createdAt = new Date().toISOString();
      slot.outbox.enqueue({
        eventId,
        schemaVersion: 1,
        eventType: 'recall_inject',
        workspaceId: ctx.workspaceId,
        actorImUserId: ctx.agentImUserId,
        actorKind: ctx.actorKind,
        deviceId: this.deviceId,
        createdAt,
        idempotencyKey: `obs:recall_inject:${ctx.agentImUserId}:${createdAt}:${eventId.slice(0, 8)}`,
        pageId: r.pageId,
        query: ctx.query,
        metadataJson: { sessionId: ctx.sessionId, turnIndex: ctx.turnIndex },
        metricsJson: {
          tokenCount: r.tokenCount,
          relevanceScore: r.score,
          topK: results.length,
        },
      });
    }

    return { fence, results };
  }
}

/** Truncate to first N lines AND under M bytes (stricter constraint wins). */
export function truncateToBudget(
  content: string,
  opts: { maxLines: number; maxBytes: number },
): { output: string; truncated: boolean } {
  let truncated = false;
  let out = content;
  const lines = out.split('\n');
  if (lines.length > opts.maxLines) {
    out = lines.slice(0, opts.maxLines).join('\n');
    truncated = true;
  }
  // Tighten to byte budget if still too big. Slice from the end iteratively
  // (90% reduction per pass) so we converge in a few iterations even for very
  // long lines that survived the line cap.
  while (Buffer.byteLength(out, 'utf8') > opts.maxBytes && out.length > 0) {
    const cut = Math.max(1, Math.floor(out.length * 0.9));
    out = out.slice(0, cut);
    truncated = true;
  }
  return { output: out, truncated };
}

function buildFence(results: MemorySearchResult[]): string {
  const body = results.map((r) => `## ${r.path}\n${r.snippet}`).join('\n\n');
  return `<memory-context>\n${body}\n</memory-context>`;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

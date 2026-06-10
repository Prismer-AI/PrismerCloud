// Fork-recall runner — M-B (doc 25 §3 支柱 2).
//
// Orchestrates the daemon-side half of fork-driven recall:
//
//   Stage 1 — `buildManifest()` enumerates candidate pages (zero LLM)
//   Stage 2 — host runs the LLM selector via its own `fork_query` impl
//   Stage 3 — `finalizeSelected()` resolves filenames into RelevantMemory[]
//
// The host (Hermes / CC / OpenClaw / Codex) drives the orchestration —
// it calls `GET /local/memory/recall/manifest`, runs `fork_query` itself,
// then POSTs the parsed selection to `/local/memory/recall/finalize`.
// The daemon doesn't know about the LLM; it only stages candidates and
// resolves selections. Two-call protocol keeps the daemon stateless and
// the host in control of the cache-warming sequence (so it can interleave
// fork_query with its own session messages for cache stickiness).
//
// `runForkedRecallInProcess()` is a convenience wrapper for when daemon
// + host live in the same process (TS-only paths, e.g. unit tests). It
// takes a `forkLLM` callable — the caller's stand-in for the host's
// `fork_query` — and walks the three stages in one call.

import { buildManifest, type ManifestOptions } from './manifest.js';
import {
  buildSelectorUserMessage,
  parseSelectorOutput,
  SELECT_MEMORIES_SYSTEM_PROMPT,
} from './select-memories.js';
import { emitForkTrace, newForkId } from './tracing.js';
import type {
  ManifestEntry,
  ManifestResponse,
  RelevantMemory,
  ForkTraceEvent,
} from './types.js';
import type { MemoryRuntime } from '../runtime.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('memory.fork.runner');

/** What the host's LLM call must hand back. Exposed to keep the
 *  in-process runner test-friendly. */
export interface ForkLLMResult {
  text: string;
  /** Optional cache-stat passthrough so tracing can report hit-rate. */
  promptCache?: ForkTraceEvent['promptCache'];
}

export interface RunForkedRecallInProcessParams {
  runtime: MemoryRuntime;
  workspaceId: string;
  query: string;
  /** Forwarded into Stage-1 manifest builder. */
  manifestOptions?: ManifestOptions;
  recentTools?: ReadonlyArray<string>;
  /** Snippet byte cap per finalized result. Default 500. */
  snippetMaxBytes?: number;
  /** Host's LLM call. Receives the system prompt + user message. */
  forkLLM: (input: { system: string; user: string }) => Promise<ForkLLMResult>;
  /** Tracing context — same fields as `EmitForkTraceOptions`. */
  trace: {
    deviceId: string;
    actorImUserId: string;
    actorKind: 'agent' | 'user';
    sessionId?: string;
    forkLabel?: string;
  };
  /** Optional abort signal forwarded into the LLM call. Default: never. */
  signal?: AbortSignal;
}

export interface ForkedRecallResult {
  query: string;
  manifestSize: number;
  selectedPaths: string[];
  results: RelevantMemory[];
  rawSelectorText: string;
  forkId: string;
  durationMs: number;
}

const DEFAULT_SNIPPET_MAX_BYTES = 500;

/**
 * In-process orchestration helper. Runs Stage-1 + Stage-2 + Stage-3
 * with the host-supplied `forkLLM` standing in for the LLM call.
 *
 * Used by:
 *   - daemon-internal callers (e.g. session-end extract runner — M-C)
 *   - unit tests where mocking the LLM is easier than running a real fork
 *
 * The Hermes / CC / OpenClaw / Codex production path goes through the
 * 2-call HTTP protocol instead (`/recall/manifest` + `/recall/finalize`).
 */
export async function runForkedRecallInProcess(
  params: RunForkedRecallInProcessParams,
): Promise<ForkedRecallResult> {
  const startedAt = Date.now();
  const forkId = newForkId();
  const forkLabel = params.trace.forkLabel ?? 'memory_recall';

  // Stage 1 — manifest.
  const manifest: ManifestResponse = buildManifest(
    params.runtime,
    params.workspaceId,
    params.query,
    params.manifestOptions,
  );

  // Empty workspace / FTS miss → return early. No LLM call, no trace.
  // (Selectors that get an empty manifest are tempted to invent paths.)
  if (manifest.entries.length === 0) {
    return {
      query: params.query,
      manifestSize: 0,
      selectedPaths: [],
      results: [],
      rawSelectorText: '',
      forkId,
      durationMs: Date.now() - startedAt,
    };
  }

  // Stage 2 — host LLM call.
  const userMessage = buildSelectorUserMessage(
    params.query,
    manifest.entries,
    params.recentTools ?? [],
  );
  let llm: ForkLLMResult;
  try {
    llm = await params.forkLLM({
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      user: userMessage,
    });
  } catch (err) {
    if (params.signal?.aborted) {
      // Aborted recalls are normal — agent moved on. Return empty without
      // emitting a fork trace (we'd be polluting the dashboard with
      // "user cancelled" rows that aren't real failures).
      return {
        query: params.query,
        manifestSize: manifest.entries.length,
        selectedPaths: [],
        results: [],
        rawSelectorText: '',
        forkId,
        durationMs: Date.now() - startedAt,
      };
    }
    log.warn(
      `forkLLM failed for ws=${params.workspaceId}: ${(err as Error).message}`,
    );
    return {
      query: params.query,
      manifestSize: manifest.entries.length,
      selectedPaths: [],
      results: [],
      rawSelectorText: '',
      forkId,
      durationMs: Date.now() - startedAt,
    };
  }

  // Stage 3 — parse + resolve.
  const { selected, rawText } = parseSelectorOutput(llm.text, manifest.entries);
  const results = finalizeSelected(
    params.runtime,
    params.workspaceId,
    selected,
    params.snippetMaxBytes ?? DEFAULT_SNIPPET_MAX_BYTES,
  );

  const durationMs = Date.now() - startedAt;
  emitForkTrace(
    {
      workspaceId: params.workspaceId,
      forkLabel,
      forkId,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      manifestEntryCount: manifest.entries.length,
      selectedCount: selected.length,
      ...(llm.promptCache ? { promptCache: llm.promptCache } : {}),
    },
    {
      runtime: params.runtime,
      deviceId: params.trace.deviceId,
      actorImUserId: params.trace.actorImUserId,
      actorKind: params.trace.actorKind,
      ...(params.trace.sessionId ? { sessionId: params.trace.sessionId } : {}),
    },
  );

  return {
    query: params.query,
    manifestSize: manifest.entries.length,
    selectedPaths: selected,
    results,
    rawSelectorText: rawText,
    forkId,
    durationMs,
  };
}

/**
 * Stage-3 helper: resolve filenames the LLM picked into full
 * `RelevantMemory[]` rows with content snippets. Skips paths the
 * selector hallucinated (parseSelectorOutput already validates against
 * the manifest, but a defensive re-check here is cheap insurance for
 * the HTTP path where manifest + selection arrive in separate calls).
 */
export function finalizeSelected(
  runtime: MemoryRuntime,
  workspaceId: string,
  paths: ReadonlyArray<string>,
  snippetMaxBytes = DEFAULT_SNIPPET_MAX_BYTES,
): RelevantMemory[] {
  const slot = runtime.peek(workspaceId);
  if (!slot) return [];

  const out: RelevantMemory[] = [];
  for (const path of paths) {
    const page = slot.store.loadByPath(path);
    if (!page) continue;
    const content = slot.store.loadContent(page.id)?.content ?? '';
    out.push({
      pageId: page.id,
      path: page.path,
      title: page.title,
      snippet: truncateBytes(content, snippetMaxBytes),
      mtimeMs: page.updatedAt,
      uri: `prismer://workspace/${workspaceId}/memory/${page.path}`,
    });
  }
  return out;
}

function truncateBytes(s: string, maxBytes: number): string {
  let out = s;
  // Iteratively shorten if the UTF-8 byte length exceeds the cap. Same
  // approach as `hooks.ts truncateToBudget` so the snippet shape is
  // consistent across recall paths.
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
    const cut = Math.max(1, Math.floor(out.length * 0.9));
    out = out.slice(0, cut);
  }
  return out;
}

// Convenience re-exports keep callers off the per-file imports.
export { buildManifest } from './manifest.js';
export type { ManifestOptions } from './manifest.js';
export { SELECT_MEMORIES_SYSTEM_PROMPT, buildSelectorUserMessage, parseSelectorOutput } from './select-memories.js';
export { emitForkTrace, newForkId } from './tracing.js';
export type {
  ManifestEntry,
  ManifestResponse,
  RelevantMemory,
  ForkTraceEvent,
  CacheSafeParams,
  SelectedFilenames,
} from './types.js';

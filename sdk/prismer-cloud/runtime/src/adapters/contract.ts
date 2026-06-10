// See docs/refactor/05-adapter-contract.md §AdapterDef trait.

import type { ChildProcess } from 'node:child_process';
import type { z } from 'zod';
import type { ResolvedAssetRef } from '../types/im-events.js';
import type { ScopedMemoryStore } from '../daemon/memory/scoped-store.js';
// release201/25 §7 — typed L3 envelope. Each adapter's `context-render.ts`
// turns this into its native history shape.
import type { ConversationContextEnvelope } from '../types/conversation-envelope.js';

export type AdapterKind = 'long-running' | 'interactive';

/**
 * Adapter definition: how the daemon hosts one class of agent
 * (Hermes, Claude Code, OpenClaw, ...).
 *
 * One Adapter ←(1:N)─ Agent ←(1:N)─ AgentProfile
 *
 * Long-running adapters implement {@link AdapterDef.ensureService} and
 * return a reusable {@link AdapterService} (e.g. HTTP client to
 * `hermes gateway`). Interactive adapters implement
 * {@link AdapterDef.dispatch} and spawn a fresh subprocess per task
 * (e.g. `claude --headless`).
 */
export interface AdapterDef {
  /** Unique name, e.g. 'hermes', 'claude-code'. Matches `IMAgentCard.adapterName`. */
  name: string;

  /** Long-running services expose ensureService; interactive adapters expose dispatch. */
  kind: AdapterKind;

  /** Capability tags surfaced to mobile (e.g. ['shell', 'code', 'mcp']). */
  capabilities: string[];

  /** Zod schema validating `AgentProfile.config` for this adapter. */
  workspaceSchema: z.ZodSchema;

  /** Long-running: ensure the underlying service is reachable. May spawn or just connect. */
  ensureService?(profile: AgentProfile): Promise<AdapterService>;

  /**
   * Optional preflight called when the daemon syncs a profile. This should
   * prepare local profile files/config without starting a long-running service.
   */
  prepareProfile?(profile: AgentProfile): Promise<void>;

  /** Interactive: one-shot dispatch (spawn-per-task). */
  dispatch?(profile: AgentProfile, task: TaskInput): Promise<TaskResult>;

  /** Validate config before persisting `AgentProfile.config`. */
  validate(config: unknown): ValidationResult;

  /** Health probe — binary in PATH, HTTP endpoint reachable, etc. */
  health(): Promise<HealthStatus>;
}

/**
 * AgentProfile mirrors the cloud `im_agent_profiles` row.
 *
 * Field names match Track A's `IMAgentProfile` Prisma model + `AgentProfileDTO`
 * in `src/im/api/agent-profiles.ts` (m1, merged in d5186ca / a4b3d89).
 *
 * Daemon-local SQLite mirror columns use snake_case
 * (workspace_id / agent_im_user_id) per docs/refactor/04-daemon-runtime.md
 * §SQLite schema; the TS types stay camelCase across the boundary.
 */
export interface AgentProfile {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  config: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * IMUser.username of the agent bound to this profile. Used by long-running
   * adapters (e.g. Hermes) to derive a stable, human-readable per-agent
   * profile directory and to scope MCP env so per-call agent identity is not
   * lost when multiple agents share a daemon. Parallel task F1 populates this
   * on the cloud DTO; runtime treats it as optional to stay backwards-compat
   * with snapshots produced before F1 lands.
   */
  agentUsername?: string;
}

export interface TaskHeartbeatHandle {
  setPhase(phase: string): void;
  touchStep(): void;
}

export interface StepRecorderHandle {
  recordPhaseChange(phase: string): void;
  recordToolCall(toolName: string, input: unknown, toolCallId?: string): void;
  recordToolResult(toolCallId: string, output: unknown): void;
  recordReasoningChunk(text: string): void;
  recordError(message: string, payload?: Record<string, unknown>): void;
}

export interface TaskInput {
  taskId: string;
  /**
   * release202/09 §3.2 — whether this dispatch is a chat-dispatch RUN or a
   * kanban TASK. Threaded from `TaskDispatchRequestPayload.kind`. When 'run',
   * `runId` carries the run id and `taskId` mirrors it (back-compat); adapters
   * surface `<run_id>` (not `<task_id>`) in execution_context. Optional —
   * adapters that don't read it fall back to the id shape (`run_` prefix).
   */
  kind?: 'run' | 'task';
  /** The run id when `kind === 'run'` (release202/09 §3.2). */
  runId?: string;
  prompt: string;
  /**
   * Adapter-private input metadata. release202/05 C2 — `metadata.conversationId`
   * + `metadata.agentImUserId` are already populated on dispatch and are the
   * keys ProviderSessionMapper.get()/put() use to scope a provider session to
   * one (conversation × agent × adapter) triple.
   */
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  onProgress?: (p: { progress: number; message?: string; detail?: Record<string, unknown> }) => void;
  signal?: AbortSignal;
  /**
   * Wave-3 D2 observability handles. Optional — pre-Wave-3 adapters that
   * don't read these still function (heartbeat keeps ticking with the
   * adapter's last-set phase; no step timeline is emitted).
   *
   * `heartbeat`:
   *   - Adapter calls `heartbeat.setPhase('thinking' | 'tool_use' | ...)`
   *     when the lifecycle advances. The 15s timer is owned by dispatch.ts;
   *     adapters MUST NOT start/stop it themselves.
   *   - Adapter may call `heartbeat.touchStep()` around observable boundaries
   *     (tool call, token emission) so cloud's 45s "stuck" reaper can
   *     distinguish slow-but-alive from truly silent.
   *
   * `recorder`:
   *   - Per-task run step uploader. Adapter calls `recordToolCall`,
   *     `recordToolResult`, `recordReasoningChunk`, `recordPhaseChange`,
   *     `recordError` at the relevant moments. Implementation is throttled
   *     for reasoning_chunk (500ms batched).
   *   - Per §3.0.2 Gap C-⑤, short skill calls (<10s) may rely solely on
   *     the default 'tool_use' phase; long-running ones SHOULD self-report.
   *
   * See sdk/prismer-cloud/runtime/src/daemon/task-heartbeat.ts and
   *     sdk/prismer-cloud/runtime/src/daemon/step-recorder.ts.
   */
  heartbeat?: TaskHeartbeatHandle;
  recorder?: StepRecorderHandle;
  /**
   * 14b rev.3 §3.0.4 / §9 P3 — assets the daemon has resolved (cdnUrl
   * reachability probed, base64 prefetched if necessary). Multimodal-aware
   * adapters (Hermes `/v1/chat/completions`, OpenClaw `/v1/responses`) lift
   * image/file blocks into their wire format; text-like inlining is still
   * handled by `dispatch.ts:composePrompt` (it stays in the `prompt` string).
   * Empty/undefined preserves the legacy text-only contract.
   */
  assetRefs?: ResolvedAssetRef[];
  /**
   * v2.0 Wave 4-E6 (doc 14 §4.7 Track-F) — scoped daemon memory store.
   *
   * Optional handle the adapter may use to:
   *   - Search this agent's memory buckets (workspace-shared + agent-private)
   *     for daemon-first FTS5 lookup (0 round-trips to cloud)
   *   - Build a `[Relevant memory]` system block via the recall-injector for
   *     prompt enrichment before the LLM call
   *
   * When undefined, the adapter MUST NOT attempt local memory recall (legacy
   * behaviour pre-Wave-4 — cloud `/memory/search` is the only path). When
   * defined, FF_MEMORY_SEARCH_DAEMON_FIRST and operatingPrinciples drive
   * whether the adapter actually injects.
   *
   * Wiring is owned by dispatch.ts (resolves per-agent slot → ScopedMemoryStore
   * → passes here). Adapters never instantiate the store themselves.
   */
  memoryStore?: ScopedMemoryStore;
  /**
   * Raw structured conversation history. Adapters that natively understand
   * role-tagged messages (Hermes /v1/runs, OpenAI Responses) should consume
   * this instead of parsing `prompt`. Adapters that don't (claude-code,
   * codex CLI) can ignore it — dispatch.ts still concats into `prompt` as
   * a fallback. 2026-05-29 — added to fix Hermes context-dropout where
   * dispatch concatenated history into a single user-input string and
   * Hermes treated it as one new turn (api_server.py:3537-3590).
   */
  contextEntries?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    sender?: string;
    senderRole?: string;
    /**
     * release201/30 — original IM message createdAt (ISO 8601). Consumed by
     * sessions-dispatcher to stamp the `at="..."` attribute on each
     * <prior_message> tag inside the conversation context XML so the model
     * can reason about chronology. Optional for back-compat; missing
     * timestamps degrade to "now" at compose time.
     */
    createdAt?: string;
    /**
     * release201/30 §XML-context P0 (2026-05-31) — asset attachments
     * carried alongside this prior chat message. Forwarded verbatim from
     * cloud's `TaskDispatchContextEntry.attachedAssetIds /
     * attachedAssets` so sessions-dispatcher can stamp
     * `<attached_assets>` children inside `<prior_message>` and the agent
     * sees prior PDF/image references even though the chat surface only
     * carried the user's text body. Optional; absence is treated as "no
     * attachments on this turn".
     */
    attachedAssetIds?: string[];
    attachedAssets?: Array<{
      id: string;
      mime?: string;
      filename?: string;
      sizeBytes?: number;
    }>;
  }>;
  /**
   * Unconcatenated original user prompt for adapters that take history
   * separately via `contextEntries`. When set, Hermes /v1/runs sends this
   * as `input` and the history as `conversation_history`. When unset,
   * adapters fall back to `prompt` (already concatenated by dispatch.ts).
   */
  currentPrompt?: string;
  /**
   * 2026-05-29 — asset reminder/inline blocks produced by
   * `dispatch.ts:resolveAssetRefs` for non-image / text-like assets
   * aggregated from the chat context window (W1).
   *
   * These blocks are also baked into `prompt` (so legacy text-only
   * adapters keep working), but adapters that send only `currentPrompt`
   * to a stateful upstream (Hermes sessions API, OpenAI Responses with
   * server-side history) would otherwise drop them and the agent would
   * be told "no file was attached" even though the cloud W1 collector
   * picked the asset up. Sessions-dispatcher must prepend these to the
   * current-turn message text.
   *
   * Empty / undefined → no assets resolved into prompt blocks; the
   * adapter sends the bare currentPrompt.
   */
  assetPromptBlocks?: string[];
  /**
   * release201/30 — fields required by sessions-style adapters (Hermes
   * /api/sessions/{id}/chat/stream) to build a <conversation_context> XML
   * block that disambiguates first-person voice across participants in
   * group chats. Legacy /v1/runs path and non-Hermes adapters ignore these.
   *
   * See `daemon/conversation-context.ts` for the composer that consumes
   * these fields.
   */
  conversationType?: 'direct' | 'group' | 'unknown';
  conversationId?: string;
  /** profile.agentUsername — agent's human handle (ceo / engineer / etc). */
  profileAgentUsername?: string;
  /** profile.agentImUserId — agent's IM user id. */
  profileAgentImUserId?: string;
  /** Authoritative recipient list of the originating conversation. */
  participants?: Array<{
    imUserId: string;
    username: string;
    displayName: string;
    role: string;
    agentType?: string | null;
  }>;
  /** Username of the human/agent who sent the dispatch trigger message. */
  currentMessageSender?: string;
  /** Role of the dispatch trigger sender (human / agent / admin / system). */
  currentMessageSenderRole?: 'human' | 'agent' | 'admin' | 'system';
  /**
   * release201/25 §7 / release201/26 — typed L3 input contract (cloud built
   * via `ConversationMemoryService.buildEnvelope`). Envelope-aware adapter
   * paths import their adapter's `context-render.ts` module
   * (`adapters/<name>/context-render.ts`) and call `renderContextEnvelope`
   * to translate this into their native history shape (Hermes XML body,
   * OpenClaw `/v1/responses` input array, CLI markdown, ...).
   *
   * Optional + forward-compat: when undefined, adapters fall back to the
   * legacy fields above (`contextEntries` + `participants` +
   * `currentMessageSender*`) and compose the body themselves.
   */
  contextEnvelope?: ConversationContextEnvelope;
}

export interface TaskResult {
  ok: boolean;
  output?: string;
  error?: { code: string; message: string };
  artifacts?: Array<{ kind: string; storageUri: string; mime?: string; size?: number }>;
  metrics?: { tokensUsed?: number; durationMs?: number };
  /**
   * Adapter-private metadata used by daemon-side bridges/observability.
   *
   * release202/05 C2 — interactive adapters (codex / claude-code) MAY set
   * `metadata.providerSessionId?: string` here: the provider/CLI session
   * (thread) id to persist via ProviderSessionMapper so the next turn on the
   * same (conversation, agent, adapter) can `resume` it. No type change needed
   * (metadata is `Record<string, unknown>`); the daemon dispatch bridge reads
   * the key and persists when present.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Reusable handle to a long-running adapter's underlying service.
 * For Hermes this wraps an HTTP client to `hermes gateway`; for OpenClaw
 * (1.9.5+) it wraps an in-process TS worker.
 */
export interface AdapterService {
  /** Service-specific identifier (e.g. 'http://127.0.0.1:8642' for hermes). */
  id: string;

  dispatch(task: TaskInput): Promise<TaskResult>;

  healthy(): Promise<boolean>;

  /** Optional: stop the service. May be no-op if user owns lifecycle. */
  shutdown?(): Promise<void>;

  /** Optional: subscribe to crash events. */
  on?(event: 'crash', cb: (err: Error) => void): void;
}

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

export interface HealthStatus {
  available: boolean;
  reason?: string;
  hint?: string;
}

// ─────────────────────────────────────────────────────────────
// Shared dispatch helpers (v2.0 — A6 dedup)
// ─────────────────────────────────────────────────────────────
//
// Spawn-style adapters (codex, claude-code, openclaw HTTP, hermes SSE) all
// share two pieces of boilerplate around child-process cancellation:
//
//   1. Wire `task.signal` so an external abort SIGTERMs the child.
//   2. Map the resulting exception (AbortError vs. real failure) into the
//      standard {ok:false, error:{code,message}} TaskResult shape.
//
// Pre-v2.0 these were duplicated across all four adapters (~15-20 lines
// each). Now adapters call `withCancellation()` once and use
// `categorizeDispatchError()` in their catch block.

/**
 * Wire cancellation + timeout for a spawned child process.
 *
 * - When `task.signal` aborts → SIGTERM the child.
 * - When the abort fires before this returns → SIGTERM immediately.
 * - When `task.timeoutMs` is set → SIGTERM after the timeout.
 *
 * Returns a teardown function the caller MUST invoke once the child has
 * exited (typically in a `finally` block), to remove the listener and
 * clear any pending timeout. Idempotent: safe to call multiple times.
 */
export function withCancellation(task: TaskInput, child: ChildProcess): () => void {
  const onAbort = (): void => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* child may have already exited */
    }
  };
  if (task.signal) {
    if (task.signal.aborted) {
      onAbort();
    } else {
      task.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (task.timeoutMs && task.timeoutMs > 0) {
    timeoutHandle = setTimeout(onAbort, task.timeoutMs);
  }
  let torn = false;
  return () => {
    if (torn) return;
    torn = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (task.signal) {
      try {
        task.signal.removeEventListener('abort', onAbort);
      } catch {
        /* removeEventListener never throws in standards-compliant runtimes */
      }
    }
  };
}

/**
 * Map a thrown error from an adapter dispatch into the standard TaskResult
 * failure shape. Distinguishes cancellation (signal.aborted or AbortError
 * name) from genuine failures so the daemon's reaper / cloud cancel
 * tracking can branch on `error.code === 'task_cancelled'`.
 *
 * Callers may pass a richer per-adapter `defaultCode` (e.g. 'adapter_dispatch_failed')
 * to keep telemetry granularity.
 */
export function categorizeDispatchError(
  err: unknown,
  taskSignal?: AbortSignal,
  defaultCode = 'adapter_dispatch_failed',
): TaskResult {
  const name = (err as { name?: string } | null)?.name;
  if (taskSignal?.aborted || name === 'AbortError') {
    return {
      ok: false,
      error: { code: 'task_cancelled', message: 'Task cancelled by client' },
    };
  }
  return {
    ok: false,
    error: {
      code: defaultCode,
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

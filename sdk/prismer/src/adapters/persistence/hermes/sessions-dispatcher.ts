// release201/25 §16.4 A1.3 — dispatch via /api/sessions/{id}/chat/stream.
//
// New Hermes-native primary endpoint. Replaces the dual-path approach
// (/v1/runs for text + /v1/chat/completions for multimodal) with a
// single stateful SSE stream that:
//
//   * keeps history on the hermes side (no 8KB conversation_history
//     resend per turn, hermes prefix cache benefits)
//   * carries multimodal content in the same shape via a `content` array
//     (§16.12 S4 verified: image_url parts are accepted)
//   * surfaces the most structured lifecycle (assistant.delta / tool.* /
//     approval.request) — replaces the lower-fidelity /v1/runs event set
//
// Pre-existing infrastructure reused verbatim:
//   * `idempotencyKey` (LLM proxy cache; built upstream in dispatch())
//   * `RunSessionRegistry` (runId → context for shell hooks)
//   * `task.recorder` + `task.heartbeat` + `task.onProgress`

import type { TaskInput, TaskResult } from '../../contract.js';
import { categorizeDispatchError } from '../../contract.js';
import type { ResolvedAssetRef, TaskDispatchContextEntry } from '../../../types/im-events.js';
import { getRunSessionRegistry } from '../../../daemon/memory/run-session-map.js';
import {
  composeConversationContextXml,
  EXECUTION_CONTEXT_ROUND_BUDGET,
  type ConversationContextParticipant,
  type ExecutionContextInput,
  type ExecutionContextType,
} from '../../../daemon/conversation-context.js';
import { CONVERSATION_CONTEXT_SCHEMA_DOC } from '../../../daemon/conversation-context-schema-doc.js';
// release201/25 §7 — envelope-aware renderer. Used when cloud-built
// `TaskInput.contextEnvelope` is present (FF_CONTEXT_ENVELOPE_ENABLED on);
// otherwise we fall back to the legacy flat-field path below for one
// release window.
import { renderContextEnvelope as renderHermesEnvelope } from './context-render.js';
import { gateImageRefsByVision } from '../../shared/image-reference.js';
import { HermesSessionMapper, type HermesSessionRow } from './sessions-mapper.js';
import { consumeSessionsSse, type SessionsSseState } from './sessions-sse.js';
import { getHermesCloudIO, type HermesCloudMessageRow } from './cloud-io.js';
import {
  sessionKeyOf,
  tryAcquireInFlight,
  releaseInFlight,
  recordEmptyReply,
  recordSuccess,
  recordInterrupted,
  shouldRotate,
  clearRotationState,
  emptyRotateThreshold,
} from './session-health.js';

export interface SessionsDispatchDeps {
  baseUrl: string;
  apiKey: string;
  profileName: string;
  /** Stable id (profileId) for HermesService.id passthrough. */
  serviceId: string;
  /** model id surfaced as bridge metadata. */
  model: string;
  /** Named Hermes provider paired with model when creating a locked session. */
  providerName: string;
  /**
   * release202/04 §3.3 P3 — effective vision capability for `deps.model`,
   * computed by hermes/index.ts (config.supportsVision ?? VISION_CAPABLE_MODELS
   * membership). Surfaced in `<execution_context><model supports_vision=…>` so
   * the agent never tries to "look at" an image on a non-vision model. Optional
   * for the unit-test dep bag; production callers MUST set it.
   */
  supportsVision?: boolean;
  /** §16.4 A4 capability map; only present when v0.15+ probe succeeded. */
  capabilities: Record<string, boolean>;
  /** Composed instructions string (capsSection + artifactsDirective + sysPrompt + skillPrompt). */
  instructions: string;
  /**
   * release201/30 — schema explainer telling the model how to read the
   * <conversation_context> XML wrapper carried on the user message. Caller
   * passes `CONVERSATION_CONTEXT_SCHEMA_DOC`; sessions-dispatcher prepends
   * it to `system_message` so the schema arrives at the start of the
   * system prompt (highest model attention). Optional only so the adapter
   * can be unit-tested with a bare minimum dep bag; production callers
   * MUST set it.
   */
  contextSchemaDoc?: string;
  /** Idempotency key shared with the /v1/runs path. */
  idempotencyKey: string;
  /** Daemon SQLite handle used by HermesSessionMapper. */
  sessionMapper: HermesSessionMapper;
}

/**
 * Build the multimodal-aware `message` body field. Per §16.12 S4:
 *
 *   text-only      → `message: "<prompt>"` (string)
 *   multimodal     → `message: [{type:'text',text}, {type:'image_url',...}]`
 *
 * Critically, hermes' `_session_chat_user_message` (api_server.py:323)
 * takes `message` as the *content* itself, NOT as `{role, content}` —
 * the v2.3 doc §16.4 body draft had this wrong; §16.12 S4 corrects it.
 */
export function buildMessage(
  text: string,
  imageRefs: ResolvedAssetRef[],
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }> {
  if (imageRefs.length === 0) return text;
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  > = [{ type: 'text', text }];
  for (const r of imageRefs) {
    const url =
      r.reachable === 'cdn' && r.cdnUrl
        ? r.cdnUrl
        : r.base64
          ? `data:${r.mime ?? 'image/png'};base64,${r.base64}`
          : (r.cdnUrl ?? '');
    if (!url) {
      // Neither cdn reachable nor base64 prefetched — fall back to a
      // descriptive text part so the model can tell the user.
      parts.push({
        type: 'text',
        text: `[image attachment id=${r.assetId} mime=${r.mime ?? 'unknown'} unavailable: cdn not reachable and bytes exceeded inline cap]`,
      });
      continue;
    }
    parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
  }
  return parts;
}

/**
 * Resolve (or create) the hermes-side session id for a given task.
 *
 * Cached on (conversationId, agentImUserId). When the task carries no
 * conversationId/agentImUserId, returns null — the upstream caller in
 * hermes/index.ts dispatch() now pre-checks these and rejects with a
 * typed adapter error before reaching this path (release201/25 §16.4 A3,
 * 2026-05-29; the legacy /v1/runs fallback was removed).
 */
async function resolveSession(
  task: TaskInput,
  deps: SessionsDispatchDeps,
  forceNew = false,
): Promise<{ session: HermesSessionRow; isNew: boolean } | null> {
  const conversationId =
    typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : null;
  const agentImUserId =
    typeof task.metadata?.agentImUserId === 'string' ? task.metadata.agentImUserId : null;
  if (!conversationId || !agentImUserId) return null;

  // release203/27 S10 — rotation: when the prior turn(s) polluted this session
  // (N consecutive empty_reply, or a prior interrupt/abort), skip the reuse
  // lookup and mint a FRESH hermes session below. The stale mapping row stays
  // but `get` returns the newest, so future turns ride the fresh session.
  if (!forceNew) {
    // Existing mapping = the hermes session was created on a prior turn and the
    // server already holds its transcript → REUSED (thin: send only the delta).
    const existing = deps.sessionMapper.get(conversationId, agentImUserId);
    if (existing) return { session: existing, isNew: false };
  }

  const workspaceId =
    typeof task.metadata?.workspaceId === 'string'
      ? task.metadata.workspaceId
      : typeof task.metadata?.prismerWorkspaceId === 'string'
        ? task.metadata.prismerWorkspaceId
        : '';
  // No mapping yet → first turn on a fresh hermes session → NEW (seed: send the
  // full envelope so the server-side transcript starts populated).
  const session = await deps.sessionMapper.createForConversation(
    deps.baseUrl,
    deps.apiKey,
    conversationId,
    agentImUserId,
    deps.profileName,
    workspaceId,
    { model: deps.model },
  );
  return { session, isNew: true };
}

export interface SessionsDispatchOutcome {
  result: TaskResult;
  /** runId captured from `run.started`, used by the caller to update HermesService.currentRunId. */
  runId: string | null;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * release202/04 §3.3 P3 — derive the `<execution_context>` input from the
 * dispatch task, applying the per-trigger field subset (§3.3.2 matrix).
 *
 * Threaded HERE (not deep in the composer) because the dispatcher is the only
 * place that holds `task.metadata` (P1/P2 scope ids + dirs) AND the resolved
 * model/vision deps. The composer just renders whatever fields are present.
 *
 * type derivation: conversationType 'group' → group-session; 'direct' →
 * dm-session; otherwise (absent/unknown + a task) → task-run.
 *
 * Per-trigger subset:
 *   task-run     : NO participants/mention targets, NO current_turn_sender;
 *                  session_id only if present; INCLUDE hop/budget + linked_task.
 *   group-session: full incl current_turn_sender + hop/budget + workspace_contacts hint.
 *                  (participants list itself is the envelope's <participants>.)
 *   dm-session   : current_turn_sender, NO hop/budget, NO workspace_contacts.
 */
/**
 * release202/08 Phase 1 — `deriveExecutionContext` only ever reads
 * `model` / `supportsVision` / `profileName` off the dep bag, so we type its
 * parameter to that minimal shape (which `SessionsDispatchDeps` structurally
 * satisfies). This lets the runs-dispatcher reuse the exact same derivation
 * without fabricating the full sessions dep bag (sessionMapper, instructions…).
 */
export interface ExecutionContextDeps {
  model: string;
  supportsVision?: boolean;
  profileName: string;
  /**
   * S7 (spec 07 Task 1) — freeze `<now>` to an already-stamped ISO timestamp
   * instead of re-computing it at dispatch time. The /v1/runs idempotency
   * fingerprint is sha256 over the WHOLE request body, so a timestamp that
   * moves between attempts turns every retry into an
   * `idempotency_key_conflict` (409). Callers pass
   * `task.metadata.dispatchedAt` (stamped once when the run row is created);
   * absent ⇒ the live behaviour is unchanged.
   */
  nowIso?: string;
}

export function deriveExecutionContext(task: TaskInput, deps: ExecutionContextDeps): ExecutionContextInput {
  const meta = task.metadata ?? {};
  // Prefer the task's explicit conversationType; fall back to the envelope's
  // (cloud always stamps it there even when the dispatch metadata omits it) so
  // a group/dm chat trigger isn't mis-derived as a bare task-run.
  const convType = task.conversationType ?? task.contextEnvelope?.conversationType;
  const type: ExecutionContextType =
    convType === 'group' ? 'group-session' : convType === 'direct' ? 'dm-session' : 'task-run';

  const ec: ExecutionContextInput = { type };

  // Scope ids — workspace/project/task/agent always (when known); session only
  // when present (task-run on a pure kanban run has none).
  const conversationId =
    task.conversationId ?? metaString(meta, 'conversationId');
  if (conversationId) ec.conversationId = conversationId;
  const sessionId = metaString(meta, 'prismerSessionId');
  if (sessionId) ec.sessionId = sessionId;
  // release202/09 §3.2 — split run-id from task-id so the execution_context
  // emits `<run_id>` for chat runs and `<task_id>` for kanban tasks. Trust the
  // typed `task.kind`/`task.runId` first, then dispatch.ts's stamped
  // `prismerKind`/`prismerRunId`, then fall back to the `run_`-prefixed id
  // shape. `task.taskId` (= payload.taskId) mirrors the run id on the wire, so
  // for runs we route it to `ec.runId`, NOT `ec.taskId`.
  const prismerRunId = metaString(meta, 'prismerRunId');
  const prismerKind = metaString(meta, 'prismerKind');
  const prismerTaskId = metaString(meta, 'prismerTaskId');
  const isRun =
    task.kind === 'run' ||
    prismerKind === 'run' ||
    !!task.runId ||
    !!prismerRunId ||
    (typeof task.taskId === 'string' && task.taskId.startsWith('run_'));
  if (isRun) {
    const runId = task.runId ?? prismerRunId ?? task.taskId ?? prismerTaskId;
    if (runId) ec.runId = runId;
  } else {
    const taskId = task.taskId ?? prismerTaskId;
    if (taskId) ec.taskId = taskId;
  }
  const workspaceId = metaString(meta, 'prismerWorkspaceId') ?? metaString(meta, 'workspaceId');
  if (workspaceId) ec.workspaceId = workspaceId;
  const projectId = metaString(meta, 'prismerActiveProjectId');
  if (projectId) ec.projectId = projectId;

  // Self-identity (NEW vs <participants>: tells the agent its own @handle).
  const agentUsername =
    metaString(meta, 'prismerAgentUsername') ?? task.profileAgentUsername ?? deps.profileName;
  if (agentUsername) ec.agentUsername = agentUsername;
  const agentImUserId = metaString(meta, 'prismerAgentImUserId') ?? task.profileAgentImUserId;
  if (agentImUserId) ec.agentImUserId = agentImUserId;
  const role = metaString(meta, 'roleTemplateSlug');
  if (role) ec.role = role;

  // Scoped dirs.
  const artifactsDir = metaString(meta, 'prismerArtifactsDir');
  if (artifactsDir) ec.artifactsDir = artifactsDir;
  const scratchDir = metaString(meta, 'prismerScratchDir');
  if (scratchDir) ec.scratchDir = scratchDir;

  // now (ISO8601 + tz offset) — kills date hallucination, computed at dispatch.
  // S7 — a caller-supplied frozen value wins (run-body stability, see
  // ExecutionContextDeps.nowIso); otherwise unchanged live computation.
  ec.now = deps.nowIso ?? isoWithOffset(new Date());

  // model + vision.
  if (deps.model) ec.model = deps.model;
  if (typeof deps.supportsVision === 'boolean') ec.supportsVision = deps.supportsVision;

  // current_turn_sender — group + dm only (task-run has no chat trigger sender).
  if (type !== 'task-run') {
    const sender = task.currentMessageSender ?? metaString(meta, 'triggerSenderUsername');
    if (sender) {
      ec.currentTurnSender = sender;
      const senderRole = task.currentMessageSenderRole ?? metaString(meta, 'triggerSenderRole');
      if (senderRole) ec.currentTurnSenderRole = senderRole;
    }
  }

  // hop/budget — task-run + group-session (fan-out chains); NOT dm-session.
  if (type !== 'dm-session') {
    const rawHop = meta.hopCount;
    const mentionChain = Array.isArray(meta.mentionChain) ? meta.mentionChain.length : undefined;
    const hop =
      typeof rawHop === 'number' && Number.isFinite(rawHop)
        ? rawHop
        : typeof mentionChain === 'number'
          ? mentionChain
          : 0;
    ec.hop = hop;
    ec.roundBudget = EXECUTION_CONTEXT_ROUND_BUDGET;
  }

  // linked_task — emitted whenever a linked kanban task is available
  // (task-run: produce-definition matters most; group/dm: only if present).
  // Derived from the goal mirror payload the daemon stamps on
  // task.metadata.prismerGoals.
  // release202/09 §3.2 — match against the kanban task id only (`ec.taskId`,
  // unset for chat runs). Run dispatches fall through to the first goal row,
  // matching the prior behaviour (the linked-task hint is best-effort context).
  const linked = pickLinkedTask(meta, ec.taskId);
  if (linked) {
    ec.linkedTaskTitle = linked.title;
    if (linked.status) ec.linkedTaskStatus = linked.status;
  }

  // workspace_contacts hint — group-session only, degrade-gracefully (no ready
  // out-of-conversation member list at dispatch → pointer to `cloud team list`).
  if (type === 'group-session') ec.workspaceContactsHint = true;

  return ec;
}

/**
 * Pick the linked kanban task title/status from `metadata.prismerGoals`
 * (daemon-stamped goal mirror). Prefer the goal whose id matches the current
 * taskId; else the first goal. Returns undefined when none available.
 */
function pickLinkedTask(
  meta: Record<string, unknown>,
  taskId: string | undefined,
): { title: string; status?: string } | undefined {
  const goals = meta.prismerGoals;
  if (!Array.isArray(goals) || goals.length === 0) return undefined;
  const rows = goals.filter((g): g is Record<string, unknown> => !!g && typeof g === 'object');
  const match = taskId ? rows.find((g) => g.id === taskId) : undefined;
  const row = match ?? rows[0];
  if (!row) return undefined;
  const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : undefined;
  if (!title) return undefined;
  const status = typeof row.status === 'string' && row.status.length > 0 ? row.status : undefined;
  return status ? { title, status } : { title };
}

/** ISO8601 timestamp with the local timezone offset (e.g. 2026-06-01T15:30:00+08:00). */
function isoWithOffset(d: Date): string {
  const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset(); // getTimezoneOffset is minutes BEHIND UTC
  const sign = tzMin >= 0 ? '+' : '-';
  const tz = tzMin === 0 ? 'Z' : `${sign}${pad(Math.floor(Math.abs(tzMin) / 60))}:${pad(Math.abs(tzMin) % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`
  );
}

/**
 * memory203/18 W5 (final-round5 P0) — recover a lost reply from the hermes
 * session transcript tail.
 *
 * Failure shape this exists for: attempt1's stream is watchdog-aborted, but
 * hermes keeps generating server-side (`_run_agent` runs `run_conversation`
 * in a thread executor — api_server.py — which the aiohttp disconnect-cancel
 * cannot preempt) and flushes its turn into the session SQLite store on
 * completion (`_flush_messages_to_session_db`, run_agent.py). The retry then
 * re-sends the SAME prompt into the SAME session concurrently; the retried
 * stream can complete with an EMPTY final content while the real answer sits
 * (or later lands) in the session transcript. When that happens we pull the
 * transcript via GET /api/sessions/{id}/messages and surface the assistant
 * content written AFTER our own turn's user row.
 *
 * Anchor: the dispatch id (`task.taskId`) is stamped into the
 * `<execution_context>` of the XML body we send as the user message, and is
 * unique per turn — so "the FIRST user row containing it" marks where THIS
 * turn's generations begin (both the killed attempt and the retry embed it).
 * We return the LAST non-empty assistant row after that anchor (the final
 * response; mid-turn tool-call assistant rows may also carry text).
 *
 * Bounded: 2 fetches ~2.5s apart — enough to catch a flush that raced our
 * stream close, without parking the dispatch on a generation that may need
 * minutes more (that case falls through to the loud `empty_reply` failure).
 */
const REPLY_RECOVERY_POLL_DELAYS_MS = [0, 2_500];

/** One transcript row as served by `GET /api/sessions/{id}/messages`. */
export interface TranscriptRow {
  role: string;
  content: string;
  timestamp: number | string | null;
}

/**
 * Read a hermes session transcript window. Shared by the reply-recovery
 * salvage (below) and the rotation reseed (S5 §3.4-1).
 *
 * Never throws: any transport/HTTP failure resolves to `[]` so callers can
 * treat "no transcript" as "nothing to recover / seed" instead of aborting a
 * dispatch on a diagnostic side channel.
 */
export async function fetchSessionTranscript(
  deps: Pick<SessionsDispatchDeps, 'baseUrl' | 'apiKey'>,
  hermesSessionId: string,
  hermesSessionKey: string | null | undefined,
  opts: { limit?: number; order?: 'latest' | 'oldest' } = {},
): Promise<TranscriptRow[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
  if (hermesSessionKey) headers['X-Hermes-Session-Key'] = hermesSessionKey;
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.order) params.set('order', opts.order);
  const qs = params.toString();
  try {
    const res = await fetch(
      `${deps.baseUrl}/api/sessions/${encodeURIComponent(hermesSessionId)}/messages${qs ? `?${qs}` : ''}`,
      { headers, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(json?.data) ? json.data : [];
    return rows.map((r) => ({
      role: typeof r?.role === 'string' ? r.role : '',
      content: typeof r?.content === 'string' ? r.content : '',
      timestamp: (r?.timestamp as number | string | null | undefined) ?? null,
    }));
  } catch {
    return [];
  }
}

/** Per-turn anchor shape as stamped into the XML body (run/task id). */
const PER_TURN_ANCHOR_RE = /\brun_[a-z0-9]+/gi;

/**
 * S5 §3.4-2 (docs/organization/specs/05 Task 3) — is this recovered answer
 * really THIS turn's?
 *
 * The anchorIdx scan already establishes rule 1 (the answer sits after a user
 * row carrying our anchor). Two failure modes survive it:
 *   • rule 2 — a foreign per-turn anchor between our anchor row and the
 *     recovered row: two turns interleaved their flushes into one window;
 *   • rule 3 — the recovered row is OLDER than our anchor row. This is the
 *     discriminating one: an answer born in the previous turn keeps that
 *     turn's timestamp however late it lands, so a late flush of the previous
 *     attempt can never pass. (On the old hermes pin the aborted attempt kept
 *     generating server-side and flushed minutes later — exactly this shape.)
 *
 * Returns a rejection reason, or null when the salvage is admissible.
 * Missing timestamps degrade to rules 1/2 with an observable stderr note
 * rather than rejecting on absent evidence.
 */
function rejectRecoveredAnswer(
  rows: TranscriptRow[],
  anchorIdx: number,
  recoveredIdx: number,
  anchor: string,
): string | null {
  for (let i = anchorIdx + 1; i < recoveredIdx; i++) {
    const r = rows[i]!;
    if (r.role !== 'user') continue;
    const ids = r.content.match(PER_TURN_ANCHOR_RE);
    const foreign = ids?.find((id) => id !== anchor);
    if (foreign) return `foreign anchor ${foreign} between anchor row and recovered row`;
  }
  const anchorTs = transcriptTimestampMs(rows[anchorIdx]!.timestamp);
  const recoveredTs = transcriptTimestampMs(rows[recoveredIdx]!.timestamp);
  if (anchorTs === null || recoveredTs === null) {
    process.stderr.write(
      '[hermes-adapter] recovery_anchor_ts_missing: transcript rows carry no usable timestamp — anchor/timestamp ordering rule skipped\n',
    );
    return null;
  }
  if (recoveredTs < anchorTs) {
    return `recovered answer timestamp ${recoveredTs} predates this turn's anchor row ${anchorTs}`;
  }
  return null;
}

export async function recoverReplyFromSessionTail(
  deps: Pick<SessionsDispatchDeps, 'baseUrl' | 'apiKey'>,
  hermesSessionId: string,
  hermesSessionKey: string | null | undefined,
  anchor: string,
): Promise<string | null> {
  if (!anchor) return null;
  for (const delay of REPLY_RECOVERY_POLL_DELAYS_MS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const rows = await fetchSessionTranscript(deps, hermesSessionId, hermesSessionKey);
      if (rows.length === 0) continue;
      // FIRST user row carrying the per-turn anchor — rows before it belong to
      // earlier turns; using the LAST match would skip an answer the killed
      // attempt flushed between the two user rows.
      let anchorIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r?.role === 'user' && r.content.includes(anchor)) {
          anchorIdx = i;
          break;
        }
      }
      if (anchorIdx < 0) continue;
      let recovered: string | null = null;
      let recoveredIdx = -1;
      for (let i = anchorIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (r?.role === 'assistant' && r.content.trim().length > 0) {
          recovered = r.content.trim();
          recoveredIdx = i;
        }
      }
      if (recovered) {
        const rejected = rejectRecoveredAnswer(rows, anchorIdx, recoveredIdx, anchor);
        if (rejected) {
          // Refuse the salvage outright: the caller's loud `empty_reply`
          // failure path takes over ("fail visibly rather than fabricate").
          process.stderr.write(
            `[hermes-adapter] recovery rejected: ${rejected} (session=${hermesSessionId} anchor=${anchor})\n`,
          );
          return null;
        }
        return recovered;
      }
    } catch {
      /* best-effort — fall through to the next poll / loud failure */
    }
  }
  return null;
}

// ---- S5 §3.4-1a (docs/organization/specs/05 Task 1) — rotation reseed ------
//
// When a rotation mints a FRESH hermes session (404 session_not_found, S10
// empty-reply streak, interrupt) the new transcript starts empty and the FULL
// seed carries only the cloud envelope. If the envelope itself is thin or was
// assembled before the last exchange landed, the agent answers the second
// message of a DM with no memory of the first (A1/A2).
//
// Fix: read the OLD session's transcript tail and fold it into the new
// session's seed as system-role prior rows.

/** Rows read back from the previous session (≈4 exchanges). */
export const RESEED_TAIL_ROWS = 8;
/** Per-row character cap before truncation. */
export const RESEED_ROW_CHAR_CAP = 1_500;
/** Total injected characters; rows are dropped oldest-first once exceeded. */
export const RESEED_TOTAL_CHAR_CAP = 6_000;
/** Prefix length used to detect a row already carried by the envelope. */
const RESEED_DEDUP_PREFIX_CHARS = 120;

/** Sender stamped on reseeded transcript rows (visible in the XML `author` attr). */
export const RESEED_SENDER = 'transcript_continuity';

function normalizeTranscriptRow(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Row timestamps arrive as unix seconds, unix millis, or ISO strings depending
 * on the hermes pin. Returns epoch millis, or null when unusable.
 */
function transcriptTimestampMs(ts: number | string | null): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    return ts > 1e12 ? ts : ts * 1_000;
  }
  if (typeof ts === 'string' && ts.length > 0) {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Normalize a transcript row timestamp to ISO. Unparseable values fall back to
 * a synthetic clock walked backwards from the dispatch start so the composer's
 * createdAt sort still yields a stable order.
 */
function normalizeTranscriptTimestamp(
  ts: number | string | null,
  fallbackBase: number,
  offsetMs: number,
): string {
  const ms = transcriptTimestampMs(ts);
  return ms === null ? new Date(fallbackBase - offsetMs).toISOString() : new Date(ms).toISOString();
}

/**
 * Map chronological transcript rows into seed entries, newest-first walk so
 * the total-char cap drops the OLDEST rows (the newest exchange is the one
 * that actually matters for continuity). Exported for direct unit coverage.
 */
export function buildTranscriptTailEntries(
  chronologicalRows: TranscriptRow[],
  recentContents: string[],
  startedAt: number,
): TaskDispatchContextEntry[] {
  const recentNorms = recentContents
    .map((c) => normalizeTranscriptRow(c).slice(0, RESEED_DEDUP_PREFIX_CHARS))
    .filter((c) => c.length > 0);

  const picked: TaskDispatchContextEntry[] = [];
  let total = 0;
  for (let i = chronologicalRows.length - 1; i >= 0; i--) {
    const row = chronologicalRows[i]!;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const body = row.content.trim();
    if (body.length === 0) continue;

    // The transcript tail and the envelope's `recent` naturally overlap —
    // never bill the same exchange twice. Dedup is LITERAL EQUALITY of the two
    // 120-char slices (owner ruling I-1). A bidirectional prefix match was
    // wrong in the same direction as N-1: a short row ("好") shares a prefix
    // with any longer row that opens the same way, so it swallowed a genuinely
    // different exchange out of the seed.
    const norm = normalizeTranscriptRow(body).slice(0, RESEED_DEDUP_PREFIX_CHARS);
    if (norm.length > 0 && recentNorms.some((r) => norm === r)) {
      continue;
    }

    const clipped =
      body.length > RESEED_ROW_CHAR_CAP
        ? `${body.slice(0, RESEED_ROW_CHAR_CAP)}…[truncated]`
        : body;
    const content = `[rotated session · transcript tail]\n${clipped}`;
    // Over cap ⇒ this row and every older one are dropped.
    if (total + content.length > RESEED_TOTAL_CHAR_CAP) break;
    total += content.length;
    picked.push({
      sender: RESEED_SENDER,
      senderRole: 'system',
      content,
      createdAt: normalizeTranscriptTimestamp(
        row.timestamp,
        startedAt,
        (chronologicalRows.length - i) * 1_000,
      ),
    });
  }
  return picked.reverse();
}

/**
 * Fire the reseed read for one rotation. Returns `[]` on any failure — the
 * rotation itself must never be blocked by a diagnostic read.
 */
async function readPreviousSessionTail(
  deps: SessionsDispatchDeps,
  previous: { hermesSessionId: string; hermesSessionKey: string | null },
  recentContents: string[],
  startedAt: number,
): Promise<TaskDispatchContextEntry[]> {
  const rows = await fetchSessionTranscript(
    deps,
    previous.hermesSessionId,
    previous.hermesSessionKey,
    { limit: RESEED_TAIL_ROWS, order: 'latest' },
  );
  if (rows.length === 0) return [];
  // Rows arrive ALREADY in chronological order and are passed through as-is.
  // `order=latest` does NOT mean "newest-first on the wire": the gateway pages
  // back from the newest but returns the page in insertion order
  // (`get_messages`: "``latest`` pages back from the newest but returns
  // chronological order", then `rows.reverse()` — v2026.9.14,
  // hermes_state_messages.py:779 + :817-818). Reversing here fed
  // `buildTranscriptTailEntries` a newest-first array, so the total-char cap
  // dropped the NEWEST rows and kept the oldest — the exact inverse of its
  // contract, and the exact A1/A2 failure this feature exists to fix.
  return buildTranscriptTailEntries(rows, recentContents, startedAt);
}

// ---- S5 §3.4-1b (docs/organization/specs/05 Task 2) — reconciliation -------
//
// The agent's working memory lives in TWO stores that never talked to each
// other: the hermes transcript (agent-rt pod, per-profile SQLite) and the
// cloud envelope (rebuilt per dispatch from the IM projection). Three separate
// silent failures — an async flush losing the previous exchange (A1), an
// envelope assembled before the last message landed (A2), a gateway restart
// vacating sessions — all present the same way to the user: the agent answers
// the second DM message with no memory of the first, and nothing anywhere says
// so.
//
// This is the cheap detector: after a REUSED turn settles, compare the anchor
// of our own last agent_reply (`metadata.taskId`, stamped into the per-turn
// `<execution_context>` of the user row we sent) against the live transcript.
// Aligned → do nothing. Misaligned → say so (system_event) and drop the stale
// mapping so the next turn rotates and reseeds (Task 1).

/** Reconcile every Nth reused turn on a given (conversation, agent) key. */
export const RECONCILE_EVERY_N_TURNS = 5;
/** …and never more often than this per key, whatever the turn count says. */
export const RECONCILE_MIN_INTERVAL_MS = 30 * 60 * 1_000;
/** How many recent IM rows / transcript rows the alignment check reads. */
const RECONCILE_READ_LIMIT = 20;
/**
 * Why a dispatch is rotating away from a session — carried into the
 * `context_rebuilt` visibility row so the metadata says which repair ran.
 */
type RotationReason = 'session_not_found' | 'empty_reply_streak' | 'reconcile_mismatch';

/** Bound on remembered `session:task` mismatch keys ("post it only once"). */
const RECONCILE_MISMATCH_LRU_SIZE = 100;

const reconcileTurnCounters = new Map<string, number>();
const reconcileLastReconciledAt = new Map<string, number>();
const reconcileMismatchSeen = new Set<string>();

/**
 * FIX ROUND 1 (review Important-1) — abandoned sessions awaiting a reseed.
 *
 * `HermesSessionMapper.invalidate()` DELETEs the mapping row
 * (sessions-mapper.ts:114). So the turn after a reconcile finds no live
 * predecessor — `rotate` is false and `mapper.get()` is null — which is
 * indistinguishable from a first turn. Left at that, the "repair" turn would
 * mint an empty session with no readback and no visibility row, i.e. the A1
 * chain would silently degrade to envelope-only seeding (specs/05:208 promised
 * the opposite: 「补种 = 下一 turn 铸新 session 走 Task 1 回读老 transcript 播种」).
 *
 * The reconcile therefore PARKS the abandoned session here (keyed on the stable
 * conversation+agent identity, which survives the rotation) and the next
 * dispatch consumes it when it has no live mapping of its own. One-shot:
 * consuming removes it, so a later turn that has a live session again is
 * unaffected.
 *
 * In-memory on purpose — same lifetime class as the reconcile counters above
 * (single-process daemon, mirrors compactionTurnCounter / recall-stats). A
 * daemon restart in the gap loses the handoff and degrades to today's
 * envelope-only behaviour, never to something worse.
 */
const pendingReseedSources = new Map<
  string,
  { hermesSessionId: string; hermesSessionKey: string | null; reason: RotationReason }
>();

/**
 * Advance the per-(conversation, agent) reused-turn counter. The caller bumps;
 * `maybeReconcileSessionContinuity` only reconciles when the counter is a
 * multiple of `RECONCILE_EVERY_N_TURNS`.
 */
export function bumpReconcileCounter(conversationId: string, agentImUserId: string): number {
  const key = `${conversationId}:${agentImUserId}`;
  const next = (reconcileTurnCounters.get(key) ?? 0) + 1;
  reconcileTurnCounters.set(key, next);
  return next;
}

/** Test-only: drop the module-level rate-limit state between cases. */
export function __resetReconcileState(): void {
  reconcileTurnCounters.clear();
  reconcileLastReconciledAt.clear();
  reconcileMismatchSeen.clear();
  pendingReseedSources.clear();
}

/** Park the session a reconcile just abandoned, for the next dispatch to reseed from. */
function parkPendingReseedSource(
  conversationId: string,
  agentImUserId: string,
  source: { hermesSessionId: string; hermesSessionKey: string | null },
): void {
  pendingReseedSources.set(`${conversationId}:${agentImUserId}`, {
    hermesSessionId: source.hermesSessionId,
    hermesSessionKey: source.hermesSessionKey,
    reason: 'reconcile_mismatch',
  });
}

/** One-shot handoff read; removes the entry so it can never apply twice. */
function consumePendingReseedSource(
  conversationId: string,
  agentImUserId: string,
): { hermesSessionId: string; hermesSessionKey: string | null; reason: RotationReason } | null {
  const key = `${conversationId}:${agentImUserId}`;
  const hit = pendingReseedSources.get(key);
  if (!hit) return null;
  pendingReseedSources.delete(key);
  return hit;
}

/** `metadata` is a JSON string on the wire and an object on some read paths. */
function parseRowMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * Anchor of OUR newest agent_reply in the conversation window, if any.
 *
 * Owner ruling I-3 — restricted to rows this agent sent. A conversation can
 * carry agent_reply rows from several agents, and their turns were never in
 * OUR transcript: anchoring on one reports a mismatch we never had, costing a
 * spurious rotation plus a misleading "错位" notice to the user.
 */
function lastAgentReplyAnchor(
  recent: HermesCloudMessageRow[],
  agentImUserId: string,
): string | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i];
    if (row?.senderId !== agentImUserId) continue;
    const meta = parseRowMetadata(row.metadata);
    if (meta.kind !== 'agent_reply') continue;
    return typeof meta.taskId === 'string' && meta.taskId.length > 0 ? meta.taskId : null;
  }
  return null;
}

/**
 * The anchor must be present on a user row AND be followed by a non-empty
 * assistant row — the transcript only "has" the exchange when the answer is
 * there too.
 */
function transcriptHoldsAnchor(rows: TranscriptRow[], anchor: string): boolean {
  let anchorIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.role === 'user' && r.content.includes(anchor)) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return false;
  for (let i = anchorIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.role === 'assistant' && r.content.trim().length > 0) return true;
  }
  return false;
}

function rememberMismatch(key: string): void {
  reconcileMismatchSeen.add(key);
  while (reconcileMismatchSeen.size > RECONCILE_MISMATCH_LRU_SIZE) {
    const oldest = reconcileMismatchSeen.values().next().value;
    if (oldest === undefined) break;
    reconcileMismatchSeen.delete(oldest);
  }
}

/**
 * Post-turn continuity reconciliation for a REUSED hermes session (S5 §3.4-1b).
 *
 * Fire-and-forget: never throws, never blocks a dispatch. No-ops when the cloud
 * IO seam is unwired, when the turn counters / interval gates say "not yet",
 * when the conversation has no agent_reply of ours in the window (nothing to
 * anchor on), or when the transcript already holds the anchor.
 *
 * On mismatch: one `system_event` (exactly once per session+anchor) + drop the
 * mapping, so the next turn mints a fresh session and Task 1's reseed rebuilds
 * continuity from the old transcript tail.
 */
export async function maybeReconcileSessionContinuity(
  deps: Pick<SessionsDispatchDeps, 'baseUrl' | 'apiKey' | 'sessionMapper'>,
  conversationId: string,
  agentImUserId: string,
  hermesSessionId: string,
  hermesSessionKey: string | null | undefined,
): Promise<void> {
  try {
    const io = getHermesCloudIO();
    if (!io) return;

    const key = `${conversationId}:${agentImUserId}`;
    if ((reconcileTurnCounters.get(key) ?? 0) % RECONCILE_EVERY_N_TURNS !== 0) return;
    const lastAt = reconcileLastReconciledAt.get(key);
    if (lastAt !== undefined && Date.now() - lastAt < RECONCILE_MIN_INTERVAL_MS) return;

    const [recent, rows] = await Promise.all([
      io.readRecentMessages(conversationId, RECONCILE_READ_LIMIT),
      fetchSessionTranscript(deps, hermesSessionId, hermesSessionKey, {
        limit: RECONCILE_READ_LIMIT,
        order: 'latest',
      }),
    ]);

    const anchor = lastAgentReplyAnchor(recent, agentImUserId);
    if (!anchor) return; // no turn of ours in the window → nothing to compare
    reconcileLastReconciledAt.set(key, Date.now());
    if (transcriptHoldsAnchor(rows, anchor)) return;

    // Guard precedence matters when reasoning about "why did it not fire":
    // the interval check at the top of this function runs FIRST, so a second
    // reconcile inside RECONCILE_MIN_INTERVAL_MS never gets here. This LRU is
    // the independent backstop that keeps a still-unfixed mismatch from being
    // re-announced once the interval window has passed.
    const mismatchKey = `${hermesSessionId}:${anchor}`;
    if (reconcileMismatchSeen.has(mismatchKey)) return;
    rememberMismatch(mismatchKey);

    process.stderr.write(
      `[hermes-adapter] continuity mismatch: session=${hermesSessionId} anchor=${anchor} absent from transcript tail — posting visibility event and dropping the mapping\n`,
    );
    await io.postSystemEvent(
      conversationId,
      '检测到上下文记录与会话记录错位，已重建连续性（更早内容以摘要保留）。',
      { kind: 'context_continuity_reconciled', hermesSessionId, missingTaskId: anchor },
    );
    // Park BEFORE invalidating: `invalidate` deletes the row, and the next
    // dispatch has to be able to find the abandoned transcript anyway.
    parkPendingReseedSource(conversationId, agentImUserId, {
      hermesSessionId,
      hermesSessionKey: hermesSessionKey ?? null,
    });
    deps.sessionMapper.invalidate(conversationId, agentImUserId, hermesSessionId);
    // Restart the turn count so the rebuilt session is measured from scratch.
    reconcileTurnCounters.set(key, 0);
  } catch (err) {
    process.stderr.write(
      `[hermes-adapter] continuity reconcile skipped: ${(err as Error).message}\n`,
    );
  }
}

export async function dispatchViaSessions(
  task: TaskInput,
  deps: SessionsDispatchDeps,
): Promise<SessionsDispatchOutcome> {
  const startedAt = Date.now();
  const sseState: SessionsSseState = { approvalRequested: false, runId: null };

  // release203/27 S10 — single-flight guard. At most one in-flight turn per
  // (conversation, agent) hermes session; a concurrent second dispatch is
  // rejected as a TRANSIENT precondition so the cloud re-queues it (spacing the
  // retry) instead of interleaving two turns into one stateful transcript.
  const conversationId =
    typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : null;
  const agentImUserId =
    typeof task.metadata?.agentImUserId === 'string' ? task.metadata.agentImUserId : null;
  const sessionKey = conversationId && agentImUserId ? sessionKeyOf(conversationId, agentImUserId) : null;

  if (sessionKey && !tryAcquireInFlight(sessionKey)) {
    return {
      result: {
        ok: false,
        output: '',
        error: {
          code: 'dispatch_precondition_unavailable',
          message: `session_busy: a turn is already in-flight for this (conversation, agent) hermes session — re-queueing to avoid transcript interleave.`,
        },
        metrics: { durationMs: Date.now() - startedAt },
        metadata: { hermes: { status: 'session_busy', hermesSessionId: null } },
      },
      runId: null,
    };
  }

  try {
    return await dispatchViaSessionsInner(task, deps, startedAt, sseState, sessionKey);
  } finally {
    if (sessionKey) releaseInFlight(sessionKey);
  }
}

async function dispatchViaSessionsInner(
  task: TaskInput,
  deps: SessionsDispatchDeps,
  startedAt: number,
  sseState: SessionsSseState,
  sessionKey: string | null,
  /**
   * Set on the ONE self-retry taken after hermes answered `404 session_not_found`
   * for the mapped session (see the 404 branch below). Forces a fresh session and
   * — because we re-enter from the top — rebuilds the body with `sessionIsNew`
   * true, so the new empty transcript is seeded with the full envelope instead of
   * a thin delta that would reference history the server no longer has.
   */
  forceFreshSession = false,
  /**
   * S5 §3.4-1a — the session this dispatch is ROTATING AWAY from. Captured from
   * the mapper before `resolveSession` mints the replacement; on the 404 retry
   * the mapping row has already been invalidated, so the caller passes it
   * explicitly. Its transcript tail is read back into the new session's seed.
   */
  previousSession: { hermesSessionId: string; hermesSessionKey: string | null } | null = null,
): Promise<SessionsDispatchOutcome> {
  let registeredRunId: string | null = null;
  let providerSessionId: string | null = null;
  const registerNativeRunContext = (nativeRunId: string): void => {
    if (!nativeRunId || registeredRunId === nativeRunId) return;
    const registry = getRunSessionRegistry();
    if (!registry) return;
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const conversationId =
      typeof meta.conversationId === 'string' ? meta.conversationId : null;
    const agentImUserId =
      typeof meta.agentImUserId === 'string' ? meta.agentImUserId : '';
    const workspaceIdMeta =
      typeof meta.workspaceId === 'string'
        ? meta.workspaceId
        : typeof meta.prismerWorkspaceId === 'string'
          ? meta.prismerWorkspaceId
          : '';
    const roleSlug =
      typeof meta.roleTemplateSlug === 'string' ? meta.roleTemplateSlug : null;
    const messageId =
      typeof meta.triggerMessageId === 'string'
        ? meta.triggerMessageId
        : typeof meta.messageId === 'string'
          ? meta.messageId
          : null;
    const canonicalTurnId = metaString(meta, 'runtimeCanonicalTurnId') ?? task.taskId ?? null;
    if (!workspaceIdMeta || (!agentImUserId && !canonicalTurnId)) return;
    try {
      registry.register({
        runId: nativeRunId,
        providerSessionId,
        conversationId,
        // Historical column name; value is the Cloud canonical turn id used by
        // memory durability commit keys, not the provider-native run id.
        taskId: canonicalTurnId,
        messageId,
        agentImUserId: agentImUserId || 'unknown',
        workspaceId: workspaceIdMeta,
        profileId: deps.serviceId,
        profileName: deps.profileName,
        roleTemplateSlug: roleSlug,
        adapterName: 'hermes',
        model: deps.model,
        proxyProvider: deps.providerName,
      });
      registeredRunId = nativeRunId;
    } catch (err) {
      process.stderr.write(
        `[hermes-adapter] sessions run-session register failed run=${nativeRunId}: ${(err as Error).message}\n`,
      );
    }
  };
  sseState.onRunStarted = registerNativeRunContext;

  // release203/27 S10 — rotation: if the prior turn(s) polluted this session,
  // mint a fresh one instead of reusing the polluted transcript.
  const rotate = (sessionKey ? shouldRotate(sessionKey) : false) || forceFreshSession;
  if (rotate && !forceFreshSession) {
    process.stderr.write(
      `[hermes-adapter] S10 rotating hermes session for ${sessionKey} (prior empty_reply streak / interrupt) — minting fresh session\n`,
    );
  }
  // S5 §3.4-1a — snapshot the session we are about to abandon BEFORE
  // resolveSession mints its replacement (mapper.get returns the newest row).
  // Rotation is the only path that needs it: a reused session already holds
  // its own transcript server-side.
  let rotationSource: {
    hermesSessionId: string;
    hermesSessionKey: string | null;
    reason?: RotationReason;
  } | null = previousSession;
  const rotationConvId =
    typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : '';
  const rotationAgentId =
    typeof task.metadata?.agentImUserId === 'string' ? task.metadata.agentImUserId : '';
  if (!rotationSource && sessionKey) {
    const prior = deps.sessionMapper.get(rotationConvId, rotationAgentId);
    if (prior) {
      // A live mapping exists → it is the predecessor, and only a rotation
      // (S10 streak / interrupt) makes us read its tail.
      if (rotate) {
        rotationSource = {
          hermesSessionId: prior.hermesSessionId,
          hermesSessionKey: prior.hermesSessionKey ?? null,
        };
      }
    } else {
      // No live mapping. If a reconcile just abandoned one, THIS is the turn
      // that owes it a reseed — without this the repair is a no-op.
      rotationSource = consumePendingReseedSource(rotationConvId, rotationAgentId);
    }
  }
  const resolved = await resolveSession(task, deps, rotate);
  if (!resolved) {
    // Surface a typed error so the caller can fall back to /v1/runs.
    throw new Error(
      'sessions path requires conversationId + agentImUserId in task.metadata — falling back',
    );
  }
  if (rotate && sessionKey) clearRotationState(sessionKey);
  // §13.4 — NEW session ⇒ seed full envelope; REUSED ⇒ thin to the IM-delta
  // (server already holds the transcript). Previously hardcoded `true` (always
  // seed) as a safe-but-wasteful placeholder; now threaded from the mapper.
  const session = resolved.session;
  providerSessionId = session.hermesSessionId;
  const sessionIsNew = resolved.isNew;

  // S5 §3.4-1a — rotation reseed. A brand-new session starts with an empty
  // server-side transcript; fold the abandoned session's last exchanges into
  // the FULL seed so the SECOND message of a DM still sees the first.
  // First turn (no rotation source) has no transcript to read by definition.
  const transcriptTail: TaskDispatchContextEntry[] =
    sessionIsNew && rotationSource
      ? await readPreviousSessionTail(
          deps,
          rotationSource,
          (task.contextEnvelope?.recent ?? []).map((r) => r.content),
          startedAt,
        )
      : [];

  // S5 §3.4-4a / §3.4-7 — FULL seed visibility. Minting a new session while a
  // previous one existed is the repair path, and it used to be silent: the
  // agent's transcript is gone, the cloud rebuilds from a summary, and the user
  // sees a reply that stopped referencing the conversation with nothing in the
  // timeline explaining it.
  //
  // One honest state statement, identical on EVERY rotation surface (404
  // session_not_found / S10 empty-reply streak / interrupt / reconcile
  // reseed): what was kept, what was reloaded, and the one thing the user can
  // do about it. The row is a `system_event`, which all three consumers strip
  // (envelope recent / compaction L2 / channel outbound) — it reaches the human
  // timeline and nothing else.
  const rotationConversationId =
    typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : '';
  const cloudIO = sessionIsNew && rotationSource ? getHermesCloudIO() : null;
  if (cloudIO && rotationConversationId) {
    void cloudIO
      .postSystemEvent(
        rotationConversationId,
        '上下文窗口已重建：更早的对话内容已按摘要保留，最近的交流已重新载入。如有需要请提醒我补充关键背景。',
        {
          kind: 'context_rebuilt',
          reason: forceFreshSession
            ? 'session_not_found'
            : ((rotationSource!.reason ?? 'empty_reply_streak') as RotationReason),
          previousSessionId: rotationSource!.hermesSessionId,
          reseededRows: transcriptTail.length,
        },
      )
      .catch(() => {
        /* unwired seam or dead cloud is not a dispatch failure */
      });
  }

  let imageRefs = (task.assetRefs ?? []).filter((r) => r.mime?.startsWith('image/'));
  // release201/26 §13.4a P2 — re-inject IMAGES quoted from OLDER messages as
  // real image_url parts. On a reused (thin) session the recent body is
  // dropped and Hermes' own history holds only a `[screenshot]` placeholder,
  // so a text quote line can't convey the pixels. Fold quote `imageAssetRefs`
  // into the multimodal imageRefs (dedup by assetId; cdnUrl-reachable).
  const quoteImageRefs: ResolvedAssetRef[] = [];
  const seenAssetIds = new Set(imageRefs.map((r) => r.assetId));
  for (const q of task.contextEnvelope?.quotes ?? []) {
    for (const ref of q.imageAssetRefs ?? []) {
      if (!ref.mime?.startsWith('image/') || seenAssetIds.has(ref.assetId)) continue;
      seenAssetIds.add(ref.assetId);
      quoteImageRefs.push({ ...ref, reachable: ref.cdnUrl ? 'cdn' : 'unknown' } as ResolvedAssetRef);
    }
  }
  imageRefs.push(...quoteImageRefs);
  // release202/17 — DEFENSIVE vision gate: never lift pixels into image_url for
  // a non-vision model even if the cloud routed them into task.assetRefs. The
  // degraded `[image: …]` lines are appended to the XML body below so the model
  // still knows an image exists, is named, and can be referenced.
  const imageGate = gateImageRefsByVision(imageRefs, deps.supportsVision);
  imageRefs = imageGate.imageRefs;
  const rawCurrentPrompt = task.currentPrompt ?? task.prompt;

  // release201/30 — replace the bare `currentPrompt` with an XML-wrapped
  // <conversation_context> block that disambiguates first-person voice across
  // group-chat participants. Sessions API is stateful (hermes tracks history
  // server-side), so prior turns are sent only as <prior_message> tags inside
  // the new context block — the agent uses them as identity scaffolding for
  // THIS turn, not as raw chat history. See conversation-context.ts header
  // for the root-cause analysis ("我是 Winshare" identity confusion).
  const youUsername = task.profileAgentUsername ?? deps.profileName ?? 'this_agent';
  const youImUserId = task.profileAgentImUserId;
  const participants: ConversationContextParticipant[] = Array.isArray(task.participants)
    ? task.participants.map((p) => ({
        imUserId: p.imUserId,
        username: p.username,
        displayName: p.displayName,
        role: p.role,
        agentType: p.agentType ?? null,
      }))
    : [];
  const nowIso = new Date().toISOString();
  const priorMessages: TaskDispatchContextEntry[] = Array.isArray(task.contextEntries)
    ? task.contextEntries.map((e) => ({
        sender: e.sender ?? 'unknown',
        senderRole: ((e.senderRole as TaskDispatchContextEntry['senderRole']) ?? 'human'),
        content: e.content,
        createdAt: e.createdAt ?? nowIso,
        // release201/30 §XML-context P0 (2026-05-31) — forward asset
        // attachments cloud surfaced on each prior chat turn so the XML
        // composer can stamp `<attached_assets>` inside `<prior_message>`.
        // Without these the prior PDF/image attachments would silently
        // drop and the agent would reply "请提供文件" mid-chain.
        ...(e.attachedAssetIds && e.attachedAssetIds.length > 0
          ? { attachedAssetIds: e.attachedAssetIds }
          : {}),
        ...(e.attachedAssets && e.attachedAssets.length > 0
          ? { attachedAssets: e.attachedAssets }
          : {}),
      }))
    : [];
  // release201/30 §XML-context P0 (2026-05-31) — derive the current
  // message's attached assets directly from `task.assetRefs`. dispatch.ts
  // hydrates `assetRefs` from the cloud-supplied list which equals the
  // current-turn attachments (no prior-turn refs join the current set on
  // dispatch, see message.service.ts:aggregatedAssetIds — only ids of the
  // trigger message reach `payload.assetRefs`). Mapping it here gives the
  // composer enough to emit `<attached_assets>` inside `<current_message>`.
  const currentAttachedAssets = (task.assetRefs ?? []).map((r) => {
    const m: { id: string; mime?: string; filename?: string; sizeBytes?: number } = {
      id: r.assetId,
    };
    if (r.mime) m.mime = r.mime;
    if (r.filename) m.filename = r.filename;
    if (typeof r.sizeBytes === 'number' && r.sizeBytes >= 0) m.sizeBytes = r.sizeBytes;
    return m;
  });
  const currentMessage: TaskDispatchContextEntry = {
    sender: task.currentMessageSender ?? task.profileAgentUsername ?? 'unknown',
    senderRole: task.currentMessageSenderRole ?? 'human',
    content: rawCurrentPrompt,
    createdAt: nowIso,
    ...(currentAttachedAssets.length > 0
      ? {
          attachedAssets: currentAttachedAssets,
          attachedAssetIds: currentAttachedAssets.map((a) => a.id),
        }
      : {}),
  };
  // 2026-05-31 release201/30 §XML-context P0 — feed the non-image asset
  // body blocks (PDF text, docx text, etc.) into the XML composer instead
  // of prepending them ABOVE the `<conversation_context>` envelope. The
  // composer renders them as `<inline_content>` children of
  // `<current_message>` so the model sees the inline body structurally
  // attached to the message it belongs to.
  const inlineBlocks = task.assetPromptBlocks ?? [];

  // release202/04 §3.3 P3 — derive the per-trigger execution scope once and
  // thread it into BOTH the envelope path and the legacy composer path so the
  // `<execution_context>` block lands regardless of FF_CONTEXT_ENVELOPE_ENABLED.
  const executionContext = deriveExecutionContext(task, deps);

  // release201/25 §7 envelope path — when the cloud built a typed envelope
  // (FF_CONTEXT_ENVELOPE_ENABLED on at dispatch time), source the XML body
  // from it via the hermes envelope renderer. The renderer wraps the proven
  // composeConversationContextXml so the XML grammar is byte-identical to
  // the legacy path (same 15-case conversation-context.test.ts schema doc
  // contract); we just feed it a typed structure instead of grubbing through
  // the flat task.participants / task.contextEntries / task.currentMessage*
  // fields. Legacy path stays in place verbatim for one release window so
  // envelope-naive cloud builds keep working unchanged.
  const baseContextXml = task.contextEnvelope
    ? renderHermesEnvelope(task.contextEnvelope, {
        currentPrompt: rawCurrentPrompt,
        youUsername,
        ...(youImUserId ? { youImUserId } : {}),
        ...(inlineBlocks.length > 0 ? { currentMessageInlineContent: inlineBlocks } : {}),
        // §13.4 — real new/reused signal from resolveSession (was hardcoded
        // `true`). NEW ⇒ seed full envelope; REUSED ⇒ thin to the IM-delta
        // (the hermes server already holds the transcript for a session that
        // exists in local_run_sessions, so re-sending recent+compressed every
        // turn was pure token waste).
        sessionIsNew,
        executionContext,
        // S5 §3.4-1a — transcript rows read back from the session this dispatch
        // rotated away from. Rendered as system-role prior rows; the composer
        // sorts by createdAt, so they land after the compression segments and
        // before the envelope's recent rows without manual ordering.
        ...(transcriptTail.length > 0 ? { transcriptTail } : {}),
        // release202/17 — forward the recipient's resolved vision capability so
        // the envelope renderer renders imageReferences + degrades inputs.
        ...(typeof deps.supportsVision === 'boolean' ? { supportsVision: deps.supportsVision } : {}),
      }).body
    : composeConversationContextXml({
        conversationType: task.conversationType ?? 'unknown',
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
        youUsername,
        ...(youImUserId ? { youImUserId } : {}),
        participants,
        priorMessages: [...priorMessages, ...transcriptTail],
        currentMessage,
        ...(inlineBlocks.length > 0 ? { currentMessageInlineContent: inlineBlocks } : {}),
        executionContext,
      });

  // release202/17 — append the defensively-degraded image reference lines (for a
  // non-vision recipient whose images came in via task.assetRefs, not the
  // envelope) so the model still sees `[image: …]` pointers in the body.
  const contextXml =
    imageGate.degradedLines.length > 0
      ? `${baseContextXml}\n\n${imageGate.degradedLines.join('\n')}`
      : baseContextXml;

  const message = buildMessage(contextXml, imageRefs);

  // System prompt: schema doc explains the <conversation_context> wrapper to
  // the model, then the upstream-composed instructions (caps + artifacts +
  // persona + skill prompts) follow. Schema goes FIRST so identity rules
  // dominate the system attention window.
  const schemaDoc = deps.contextSchemaDoc ?? CONVERSATION_CONTEXT_SCHEMA_DOC;
  const composedSystemMessage = deps.instructions
    ? `${schemaDoc}\n\n${deps.instructions}`
    : schemaDoc;
  // Reconfirm the model on every turn so pre-lock durable mappings self-heal.
  // The dedicated gateway already resolved its authoritative named provider;
  // omitting provider avoids Hermes v2026.8.3's named→custom identity mismatch.
  const body: Record<string, unknown> = {
    message,
    system_message: composedSystemMessage,
    model: deps.model,
    require_model_lock: true,
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.apiKey}`,
    'Content-Type': 'application/json',
    'X-Prismer-Idempotency-Key': deps.idempotencyKey,
  };
  if (session.hermesSessionKey) {
    headers['X-Hermes-Session-Key'] = session.hermesSessionKey;
  }

  try {
    const res = await fetch(
      `${deps.baseUrl}/api/sessions/${encodeURIComponent(session.hermesSessionId)}/chat/stream`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: task.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');

      // The mapped session is GONE server-side. hermes holds sessions in memory,
      // so ANY gateway restart vacates them all while every local.db mapping row
      // survives — and skill-sync restarts the gateway on purpose whenever it
      // installs a skill. Without this branch the daemon just retries the SAME
      // dead id (3× at the dispatch layer) and the (conversation, agent) pair is
      // bricked for good: observed 2026-07-15, where installing the council
      // skills left the owner↔Team Manager DM 404-ing on one dead session id across every
      // later dispatch.
      //
      // A dead session is not a dispatch failure — it is a stale pointer. Drop it
      // and re-enter ONCE with a freshly minted session (rebuilding the body with
      // the full seed envelope, since the new transcript starts empty). Guarded by
      // `forceFreshSession` so a genuinely broken sessions API can't loop.
      if (res.status === 404 && text.includes('session_not_found') && !forceFreshSession) {
        const convId = task.metadata?.conversationId;
        const agentId = task.metadata?.agentImUserId;
        if (typeof convId === 'string' && typeof agentId === 'string') {
          deps.sessionMapper.invalidate(convId, agentId, session.hermesSessionId);
          process.stderr.write(
            `[hermes-adapter] session ${session.hermesSessionId} is gone server-side (404 session_not_found) — ` +
              `dropped the stale mapping and re-dispatching on a fresh session\n`,
          );
          // S5 §3.4-1a — hand the dead session to the retry so the fresh
          // transcript can be seeded from whatever the gateway still holds.
          return await dispatchViaSessionsInner(task, deps, startedAt, sseState, sessionKey, true, {
            hermesSessionId: session.hermesSessionId,
            hermesSessionKey: session.hermesSessionKey ?? null,
          });
        }
      }

      return {
        result: {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message: `Hermes sessions ${res.status}: ${text || '<no body>'}`,
          },
        },
        runId: null,
      };
    }
    if (!res.body) {
      return {
        result: {
          ok: false,
          error: {
            code: 'adapter_dispatch_failed',
            message: 'Hermes sessions returned no body',
          },
        },
        runId: null,
      };
    }

    // B-P0 — thread the turn clock so the SSE consumer can derive
    // `firstEventMs` (dispatch start → first model-activity event).
    const sseResult = await consumeSessionsSse(res.body, task, sseState, startedAt);

    // Defensive fallback for alternate/test SSE consumers that return a run id
    // without invoking the run.started callback. The production consumer
    // registers at run.started, before MemoryProvider.sync_turn can race us.
    if (sseResult.runId) {
      registerNativeRunContext(sseResult.runId);
    }
    const terminalRunId = sseResult.runId ?? registeredRunId;
    if (terminalRunId) {
      getRunSessionRegistry()?.recordTerminalRouting(terminalRunId, {
        servedModel: sseResult.servedModel ?? null,
        servedProvider: sseResult.servedProvider ?? null,
        routingEvidenceSource: 'adapter',
      });
    }

    // S5 §3.4-1b — the turn has settled (SSE consumed, not suspended on an
    // approval/clarify). On a REUSED session, occasionally check that the
    // hermes transcript still holds our last exchange; a fresh session was
    // just seeded by Task 1, which is the other half of the same repair.
    // Deliberately after the SSE terminal — reconciliation costs latency and
    // must never sit in front of a dispatch.
    if (
      !sessionIsNew &&
      !sseResult.approvalRequested &&
      !sseState.clarifyRequested &&
      typeof task.metadata?.conversationId === 'string' &&
      typeof task.metadata?.agentImUserId === 'string'
    ) {
      const reconConversationId = task.metadata.conversationId;
      const reconAgentImUserId = task.metadata.agentImUserId;
      bumpReconcileCounter(reconConversationId, reconAgentImUserId);
      void maybeReconcileSessionContinuity(
        deps,
        reconConversationId,
        reconAgentImUserId,
        session.hermesSessionId,
        session.hermesSessionKey,
      ).catch(() => {});
    }

    // release202/12 — an exhausted upstream LLM call (hermes serializes it into
    // assistant.completed content) must surface as a FAILED result, not a
    // fake-successful task whose output is the error string. The status is
    // carried so the daemon retry loop can skip retrying permanent config/auth
    // failures (provider_chain_unconfigured / 4xx).
    if (sseResult.upstreamError) {
      const { status, message } = sseResult.upstreamError;
      return {
        result: {
          ok: false,
          output: '',
          error: { code: 'upstream_llm_error', message },
          metrics: { durationMs: Date.now() - startedAt, firstEventMs: sseResult.firstEventMs },
          metadata: {
            hermes: {
              status: 'failed',
              endpoint: '/api/sessions/{id}/chat/stream',
              baseUrl: deps.baseUrl,
              model: deps.model,
              hermesSessionId: session.hermesSessionId,
              runId: sseResult.runId,
              upstreamStatus: status ?? null,
              error: message,
            },
          },
        },
        runId: sseResult.runId,
      };
    }

    // memory203/18 W5 (final-round5 P0) — silent-empty-completion guard.
    //
    // Observed live: after a stall-abort + retry into the same session, the
    // retried stream completed cleanly (run.completed, no error) with an
    // EMPTY assistant content. The adapter used to forward ok=true output:''
    // → cloud marked the run completed and the message-post gate
    // (`output || attachments`, ws/handler.ts) silently skipped the DM post —
    // credits burned, user saw NOTHING, and the killed attempt's answer later
    // leaked into the head of the next turn. A completed turn with zero
    // user-visible content must never be a silent success:
    //   1. try to RECOVER the reply from the session transcript tail (the
    //      killed attempt's generation flushes there on completion);
    //   2. otherwise fail LOUDLY with `empty_reply` so the cloud posts a
    //      visible failure event instead of a phantom completion.
    // Approval suspension and pending clarify are legitimate empty-output
    // exits and are excluded.
    if (
      sseResult.output.trim().length === 0 &&
      !sseResult.approvalRequested &&
      !sseState.clarifyRequested
    ) {
      const recovered = await recoverReplyFromSessionTail(
        deps,
        session.hermesSessionId,
        session.hermesSessionKey,
        task.taskId ?? '',
      );
      if (recovered) {
        process.stderr.write(
          `[hermes-adapter] task=${task.taskId ?? '?'} sessions turn returned EMPTY content — recovered ${recovered.length} chars from session transcript tail (session=${session.hermesSessionId})\n`,
        );
        // S10 — a recovered reply is a healthy outcome; reset the streak.
        if (sessionKey) recordSuccess(sessionKey);
        return {
          result: {
            ok: true,
            output: recovered,
            metrics: { durationMs: Date.now() - startedAt, firstEventMs: sseResult.firstEventMs },
            metadata: {
              ...(sseResult.servedModel ? { modelUsed: sseResult.servedModel } : {}),
              ...(sseResult.servedProvider ? { providerUsed: sseResult.servedProvider } : {}),
              ...(sseResult.servedChainId ? { chainId: sseResult.servedChainId } : {}),
              hermes: {
                status: 'dispatched',
                endpoint: '/api/sessions/{id}/chat/stream',
                baseUrl: deps.baseUrl,
                model: deps.model,
                hermesSessionId: session.hermesSessionId,
                runId: sseResult.runId,
                replyRecovered: 'session_transcript_tail',
                ...(sseResult.usage ? { usage: sseResult.usage } : {}),
              },
            },
          },
          runId: sseResult.runId,
        };
      }
      // S10 — genuine empty_reply: bump the streak so N-in-a-row rotates the
      // (polluted) session on the next turn.
      //
      // spec 11 T1-3 — the streak is no longer purely internal. With the
      // threshold at 2 the FIRST empty reply does NOT rotate, so without a row
      // of its own that failed turn reaches the timeline unexplained (the user
      // sees a broken reply and no reason to expect the next one to be
      // different). Post the same `system_event` channel the rotation
      // announcement uses, carrying the SAME `reason` enum value the eventual
      // rotation row will carry (`empty_reply_streak`), so the two rows read as
      // one story: "still under the bar" → "the bar was reached, here is the
      // rebuilt window".
      if (sessionKey) {
        const streak = recordEmptyReply(sessionKey);
        const threshold = emptyRotateThreshold();
        if (streak < threshold) {
          const visibilityIO = getHermesCloudIO();
          if (visibilityIO && rotationConversationId) {
            void visibilityIO
              .postSystemEvent(
                rotationConversationId,
                // Threshold-agnostic on purpose (review M1): the operator env
                // override can raise the threshold to 3+, so "the next one will
                // rotate" would be a lie. State what happened and what the rule
                // is, not when it fires.
                `本轮回复为空（连续第 ${streak} 次）：已记录，连续空回复达到阈值时将自动重建上下文窗口后重试。`,
                {
                  kind: 'empty_reply_observed',
                  reason: 'empty_reply_streak',
                  emptyReplyStreak: streak,
                  rotateThreshold: threshold,
                  hermesSessionId: session.hermesSessionId,
                },
              )
              .catch(() => {
                /* unwired seam or dead cloud is not a dispatch failure */
              });
          }
        }
      }
      return {
        result: {
          ok: false,
          output: '',
          error: {
            code: 'empty_reply',
            message:
              `Hermes sessions turn completed with an EMPTY reply (no assistant content on the stream, none recoverable from the session transcript). ` +
              `session=${session.hermesSessionId} run=${sseResult.runId ?? '?'}. ` +
              `Likely cause: a previously aborted attempt left the server-side session turn in a polluted state. Failing loudly instead of completing silently.`,
          },
          metrics: { durationMs: Date.now() - startedAt, firstEventMs: sseResult.firstEventMs },
          metadata: {
            hermes: {
              status: 'failed',
              endpoint: '/api/sessions/{id}/chat/stream',
              baseUrl: deps.baseUrl,
              model: deps.model,
              hermesSessionId: session.hermesSessionId,
              runId: sseResult.runId,
              error: 'empty_reply',
            },
          },
        },
        runId: sseResult.runId,
      };
    }

    // S10 — healthy non-empty turn: reset streak + clear any interrupt flag.
    if (sessionKey) recordSuccess(sessionKey);
    return {
      result: {
        ok: true,
        output: sseResult.output,
        metrics: { durationMs: Date.now() - startedAt, firstEventMs: sseResult.firstEventMs },
        metadata: {
          ...(sseResult.servedModel ? { modelUsed: sseResult.servedModel } : {}),
          ...(sseResult.servedProvider ? { providerUsed: sseResult.servedProvider } : {}),
          ...(sseResult.servedChainId ? { chainId: sseResult.servedChainId } : {}),
          hermes: {
            status: 'dispatched',
            endpoint: '/api/sessions/{id}/chat/stream',
            baseUrl: deps.baseUrl,
            model: deps.model,
            hermesSessionId: session.hermesSessionId,
            runId: sseResult.runId,
            ...(imageRefs.length > 0 ? { multimodal: true, imageRefs: imageRefs.length } : {}),
            ...(sseResult.usage ? { usage: sseResult.usage } : {}),
          },
          ...(sseResult.approvalRequested ? { approvalRequested: true } : {}),
          ...(sseResult.approvalBundle ? { approvalBundle: sseResult.approvalBundle } : {}),
        },
      },
      runId: sseResult.runId,
    };
  } catch (err) {
    // memory203/18 W5 — on a stall-abort, best-effort tell hermes to stop the
    // orphaned server-side generation before the retry re-enters the same
    // session. EFFECTIVE as of the Hermes v2026.9.14 pin (S1,
    // docs/organization/specs/01 audit 1h): the sessions chat/stream handler
    // now registers its run in `_active_run_agents` (api_server.py:3712) and
    // stamps the owner (`_run_owners[run_id]`, api_server.py:3158), so
    // this `/v1/runs/{id}/stop` — which used to 404 for every sessions run —
    // now actually cancels the in-flight turn. On the OLD pin the handler
    // minted its run_id locally and never registered it (only the /v1/runs
    // path did), so the executor-thread generation kept running after a
    // stall-abort and flushed into the transcript later.
    // Kept fire-and-forget regardless: it is a best-effort side channel on an
    // error path (2s AbortSignal, `.catch(() => {})`), and the REAL mitigation
    // for the polluted-session aftermath is still the empty-reply guard +
    // transcript-tail recovery above — v2026.9.14 also interrupts the turn
    // server-side on SSE client disconnect (audit 1g), which is the same
    // defence from the other end.
    if (/^upstream stall:/.test((err as Error)?.message ?? '') && sseState.runId) {
      void fetch(`${deps.baseUrl}/v1/runs/${encodeURIComponent(sseState.runId)}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        signal: AbortSignal.timeout(2_000),
      }).catch(() => {});
    }
    const categorized = categorizeDispatchError(err, task.signal);
    // S10 — an interrupt/abort or upstream stall leaves the server-side turn
    // orphaned (on v2026.9.14 the /stop above now reaches it, but the abort is
    // fire-and-forget and races the server, so the outcome is still unknowable
    // here), so the next turn on THIS session is presumed polluted → force a
    // rotation then.
    // 2.2.9 — same for CONNECTION-level breaks: sessions-sse never throws on
    // application-level failures (those return via sseResult.upstreamError), so
    // anything that reaches this catch apart from the resolveSession fallback
    // is an interrupted turn (gateway killed by adoption re-provision / daemon
    // OTA restart / network drop). Previously only task_cancelled + stall were
    // marked, so a killed-gateway turn silently polluted the session and the
    // next dispatch came back EMPTY (2026-08-07, sandbox agent).
    const errMsg = err instanceof Error ? err.message : String(err);
    const isResolveSessionFallback = errMsg.includes('sessions path requires');
    if (sessionKey && !isResolveSessionFallback) {
      recordInterrupted(sessionKey);
    }
    return {
      result: {
        ...categorized,
        metadata: {
          hermes: {
            status: categorized.error?.code === 'task_cancelled' ? 'cancelled' : 'failed',
            endpoint: '/api/sessions/{id}/chat/stream',
            baseUrl: deps.baseUrl,
            model: deps.model,
            hermesSessionId: session.hermesSessionId,
            runId: sseState.runId,
            ...(categorized.error?.code !== 'task_cancelled'
              ? { error: (err as Error).message }
              : {}),
          },
          ...(sseState.approvalRequested ? { approvalRequested: true } : {}),
          ...(sseState.approvalBundle ? { approvalBundle: sseState.approvalBundle } : {}),
        },
      },
      runId: sseState.runId,
    };
  }
}

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

import type { TaskInput, TaskResult } from '../contract.js';
import { categorizeDispatchError } from '../contract.js';
import type { ResolvedAssetRef, TaskDispatchContextEntry } from '../../types/im-events.js';
import { getRunSessionRegistry } from '../../daemon/memory/run-session-map.js';
import {
  composeConversationContextXml,
  EXECUTION_CONTEXT_ROUND_BUDGET,
  type ConversationContextParticipant,
  type ExecutionContextInput,
  type ExecutionContextType,
} from '../../daemon/conversation-context.js';
import { CONVERSATION_CONTEXT_SCHEMA_DOC } from '../../daemon/conversation-context-schema-doc.js';
// release201/25 §7 — envelope-aware renderer. Used when cloud-built
// `TaskInput.contextEnvelope` is present (FF_CONTEXT_ENVELOPE_ENABLED on);
// otherwise we fall back to the legacy flat-field path below for one
// release window.
import { renderContextEnvelope as renderHermesEnvelope } from './context-render.js';
import { HermesSessionMapper, type HermesSessionRow } from './sessions-mapper.js';
import { consumeSessionsSse, type SessionsSseState } from './sessions-sse.js';

export interface SessionsDispatchDeps {
  baseUrl: string;
  apiKey: string;
  profileName: string;
  /** Stable id (profileId) for HermesService.id passthrough. */
  serviceId: string;
  /** model id surfaced as bridge metadata. */
  model: string;
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
): Promise<{ session: HermesSessionRow; isNew: boolean } | null> {
  const conversationId =
    typeof task.metadata?.conversationId === 'string' ? task.metadata.conversationId : null;
  const agentImUserId =
    typeof task.metadata?.agentImUserId === 'string' ? task.metadata.agentImUserId : null;
  if (!conversationId || !agentImUserId) return null;

  // Existing mapping = the hermes session was created on a prior turn and the
  // server already holds its transcript → REUSED (thin: send only the delta).
  const existing = deps.sessionMapper.get(conversationId, agentImUserId);
  if (existing) return { session: existing, isNew: false };

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
  ec.now = isoWithOffset(new Date());

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

export async function dispatchViaSessions(
  task: TaskInput,
  deps: SessionsDispatchDeps,
): Promise<SessionsDispatchOutcome> {
  const startedAt = Date.now();
  const sseState: SessionsSseState = { approvalRequested: false, runId: null };

  const resolved = await resolveSession(task, deps);
  if (!resolved) {
    // Surface a typed error so the caller can fall back to /v1/runs.
    throw new Error(
      'sessions path requires conversationId + agentImUserId in task.metadata — falling back',
    );
  }
  // §13.4 — NEW session ⇒ seed full envelope; REUSED ⇒ thin to the IM-delta
  // (server already holds the transcript). Previously hardcoded `true` (always
  // seed) as a safe-but-wasteful placeholder; now threaded from the mapper.
  const session = resolved.session;
  const sessionIsNew = resolved.isNew;

  const imageRefs = (task.assetRefs ?? []).filter((r) => r.mime?.startsWith('image/'));
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
  const contextXml = task.contextEnvelope
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
      }).body
    : composeConversationContextXml({
        conversationType: task.conversationType ?? 'unknown',
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
        youUsername,
        ...(youImUserId ? { youImUserId } : {}),
        participants,
        priorMessages,
        currentMessage,
        ...(inlineBlocks.length > 0 ? { currentMessageInlineContent: inlineBlocks } : {}),
        executionContext,
      });

  const message = buildMessage(contextXml, imageRefs);

  // System prompt: schema doc explains the <conversation_context> wrapper to
  // the model, then the upstream-composed instructions (caps + artifacts +
  // persona + skill prompts) follow. Schema goes FIRST so identity rules
  // dominate the system attention window.
  const schemaDoc = deps.contextSchemaDoc ?? CONVERSATION_CONTEXT_SCHEMA_DOC;
  const composedSystemMessage = deps.instructions
    ? `${schemaDoc}\n\n${deps.instructions}`
    : schemaDoc;
  const body: Record<string, unknown> = { message, system_message: composedSystemMessage };

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

    const sseResult = await consumeSessionsSse(res.body, task, sseState);

    // Register runId → context mapping for shell-hook reverse lookup, same
    // as the legacy /v1/runs path (parity with hermes/index.ts onTaskDispatch).
    if (sseResult.runId) {
      try {
        const registry = getRunSessionRegistry();
        if (registry) {
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
          if (workspaceIdMeta && (agentImUserId || task.taskId)) {
            registry.register({
              runId: sseResult.runId,
              conversationId,
              taskId: task.taskId ?? null,
              agentImUserId: agentImUserId || 'unknown',
              workspaceId: workspaceIdMeta,
              profileName: deps.profileName,
              roleTemplateSlug: roleSlug,
              adapterName: 'hermes',
            });
          }
        }
      } catch (err) {
        process.stderr.write(
          `[hermes-adapter] sessions run-session register failed run=${sseResult.runId}: ${(err as Error).message}\n`,
        );
      }
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
          metrics: { durationMs: Date.now() - startedAt },
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

    return {
      result: {
        ok: true,
        output: sseResult.output,
        metrics: { durationMs: Date.now() - startedAt },
        metadata: {
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
        },
      },
      runId: sseResult.runId,
    };
  } catch (err) {
    const categorized = categorizeDispatchError(err, task.signal);
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
        },
      },
      runId: sseState.runId,
    };
  }
}

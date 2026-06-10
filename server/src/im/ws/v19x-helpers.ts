/**
 * Track C v1.9.x — pure helpers for the daemon protocol handlers.
 *
 * Extracted from `handler.ts` and `task.service.ts` so the algorithms can be
 * unit-tested in isolation (no real WebSocket, no Prisma client). Side-effecty
 * code (Prisma writes, rooms.sendToUser, log emissions) stays at the call
 * sites; this file is logic-only.
 */

import type { HostedAgentDeclaration, TaskDispatchContextEntry, TaskDispatchRequestPayload } from '../types/index';
// release201/25 §7 / release201/26 — typed envelope hoist. Imported as type
// only; the runtime value comes off task metadata (defensive narrow below).
import type { ConversationContextEnvelope } from '../types/conversation-envelope';

/**
 * One cloud-side profile snapshot used by `computeProfilesToSync`.
 * Field names mirror the Prisma model so the call site can pass
 * `findMany({ select: { id, agentImUserId, version } })` results directly.
 */
export interface CloudProfileSnapshot {
  id: string;
  agentImUserId: string;
  version: number;
}

/**
 * Compute which profile ids the daemon needs to refetch after handshake.
 *
 * Rules:
 *   - Cloud has a profile whose id the daemon didn't declare → daemon
 *     should pull it (new profile created on another device).
 *   - Daemon's local version < cloud's version → cloud is ahead, daemon
 *     should pull.
 *   - Daemon's local version >= cloud's version → no action here. If the
 *     daemon's version is strictly greater, that's a daemon-initiated
 *     update sitting in its sync_queue and is handled by the queue
 *     pusher, not this handshake reply.
 *
 * Pure function — no Prisma, no I/O.
 */
export function computeProfilesToSync(
  declared: HostedAgentDeclaration[],
  cloudProfiles: CloudProfileSnapshot[],
): string[] {
  const declaredByAgent = new Map<string, Map<string, number>>();
  for (const d of declared) {
    declaredByAgent.set(d.imUserId, new Map(d.profiles.map((p) => [p.id, p.version])));
  }

  const result: string[] = [];
  for (const cp of cloudProfiles) {
    const localMap = declaredByAgent.get(cp.agentImUserId);
    const localVersion = localMap?.get(cp.id);
    if (localVersion === undefined || localVersion < cp.version) {
      result.push(cp.id);
    }
  }
  return result;
}

/**
 * Compute cloud-authoritative tombstones for profiles declared by accepted
 * agents. The caller must pass only declarations that survived ownership and
 * daemon-binding validation. Ignored declarations are not safe to tombstone:
 * they may be sandbox-local bootstrap rows that are usable for explicit
 * in-pod sync but not yet accepted as hosted runtime agents.
 */
export function computeProfilesToDelete(
  acceptedDeclared: HostedAgentDeclaration[],
  cloudProfiles: CloudProfileSnapshot[],
): string[] {
  const cloudProfileIds = new Set(cloudProfiles.map((profile) => profile.id));
  const result: string[] = [];
  for (const agent of acceptedDeclared) {
    for (const profile of agent.profiles) {
      if (!cloudProfileIds.has(profile.id)) result.push(profile.id);
    }
  }
  return result;
}

/**
 * Trim a chronological list of context entries from the oldest end so that
 * the total `content.length` stays within `maxChars`. Always keeps at
 * least one entry — even if a single entry exceeds the cap, it's kept
 * (the agent's prompt becomes "do something with this oversized message",
 * which is more useful than no context at all).
 *
 * Pure function. Consumes a copy of its input.
 */
export function trimContextWindow(entries: TaskDispatchContextEntry[], maxChars: number): TaskDispatchContextEntry[] {
  if (entries.length === 0) return entries;
  let totalChars = entries.reduce((sum, e) => sum + e.content.length, 0);
  let remaining = entries;
  while (totalChars > maxChars && remaining.length > 1) {
    const dropped = remaining[0];
    remaining = remaining.slice(1);
    totalChars -= dropped.content.length;
  }
  return remaining;
}

/**
 * Build a `task.dispatch.request` payload from a task record.
 *
 * Reads `profileId` and `context` from `task.metadata` (set there by the
 * @-mention dispatcher in message.service). When the task was created
 * directly (not via mention), profileId may be empty — daemon resolves
 * the agent's first profile itself.
 */
export function buildTaskDispatchRequest(
  task: {
    id: string;
    title: string;
    description?: string | null;
    capability?: string | null;
    input?: string | null;
    metadata?: string | null;
    timeoutMs?: number | null;
    conversationId?: string | null;
    runtimeRoute?: string | null;
    /** release201/09 Phase 2 — propagated to daemon for path composition + env injection. */
    projectId?: string | null;
  },
  agentImUserId: string,
): TaskDispatchRequestPayload {
  const taskMeta = parseJsonObject(task.metadata);
  const taskInput = parseJsonObject(task.input);

  const profileId = (taskMeta.profileId as string) ?? '';
  // description is the single source of truth for "what the executing agent
  // should do" — surfaced verbatim on the UI and forwarded here as the LLM's
  // prompt. `taskInput.prompt` is a legacy tail kept ONLY for rows created
  // before the collapse refactor; it MUST NOT be produced by any new write
  // path (MCP create-task and frontend mutations.ts no longer mirror
  // description into input.prompt). Drop the legacy tail after a backfill
  // migrates old rows: `UPDATE im_tasks SET description =
  //   JSON_EXTRACT(input,'$.prompt') WHERE description IS NULL AND
  //   JSON_EXTRACT(input,'$.prompt') IS NOT NULL`.
  const legacyInputPrompt =
    typeof taskInput.prompt === 'string' && taskInput.prompt ? (taskInput.prompt as string) : null;
  const basePrompt =
    (typeof task.description === 'string' && task.description ? task.description : null) ??
    legacyInputPrompt ??
    task.title ??
    '';
  // P1-2 (2026-05-25): when the previous turn produced files that
  // daemon's outbox-watcher quarantined for MIME mismatch (e.g. agent
  // dumped markdown into a `.pdf`), surface that to the agent at the TOP
  // of the next prompt so it can adjust strategy BEFORE re-executing. The
  // warning lives ABOVE the user instruction with a clear separator so it
  // doesn't bleed into the description body.
  const rejectionsBlock = renderOutboxRejectionsBlock(taskMeta.outboxRejections);
  const prompt = rejectionsBlock ? `${rejectionsBlock}\n\n${basePrompt}` : basePrompt;
  const context = Array.isArray(taskMeta.context) ? (taskMeta.context as TaskDispatchContextEntry[]) : undefined;

  // Hoist conversationType off `taskMeta` onto the top-level payload before
  // we strip it from the daemon-facing extraMetadata bag. message.service
  // stamps it on the task_run metadata so the wire payload carries it as a
  // first-class field — daemon's appendChannelContext reads it from there.
  const rawConvType = taskMeta.conversationType;
  const conversationType: 'direct' | 'group' | undefined =
    rawConvType === 'direct' || rawConvType === 'group' ? rawConvType : undefined;

  // Same treatment for `participants` — message.service stamps the
  // authoritative recipient list onto task_run metadata (capped at 50);
  // daemon's appendChannelContext consumes it from the top-level payload
  // field. Defensive shape check: anything that doesn't look like the
  // expected array of {username, ...} records is dropped silently so a
  // malformed stamp can't poison the wire payload.
  const participants = readParticipantList(taskMeta.participants);

  // release201/30 — trigger-sender identity. message.service resolves the
  // sender username + role off the IM user record at dispatch time and
  // stamps both onto task_run metadata. Daemon consumes them via the wire
  // payload to label <current_message author="..."> inside the
  // <conversation_context> XML wrapper the sessions adapter sends.
  // Defensive narrowing: only forward strings that look like a real
  // username / valid senderRole — otherwise drop silently and let the
  // daemon fall back to recipient-self.
  const rawTriggerSender = taskMeta.triggerSenderUsername;
  const triggerSenderUsername =
    typeof rawTriggerSender === 'string' && rawTriggerSender.length > 0
      ? rawTriggerSender
      : undefined;
  const rawTriggerRole = taskMeta.triggerSenderRole;
  const triggerSenderRole: 'human' | 'agent' | 'admin' | 'system' | undefined =
    rawTriggerRole === 'human' ||
    rawTriggerRole === 'agent' ||
    rawTriggerRole === 'admin' ||
    rawTriggerRole === 'system'
      ? rawTriggerRole
      : undefined;

  // release201/25 §7 / release201/26 — typed L3 envelope hoist. message.service
  // stamps `contextEnvelope` on task_run metadata when FF_CONTEXT_ENVELOPE_ENABLED
  // is on; we hoist it to the wire payload's top level so envelope-aware
  // adapters (sessions-dispatcher.renderContextEnvelope) consume the typed
  // structure directly instead of grubbing through the daemon-facing
  // extraMetadata bag. Defensive narrow: only accept envelopes that look
  // like our v1 shape; malformed stamps drop silently so a poisoned metadata
  // blob can't break dispatch (the legacy flat fields above still ship).
  const rawEnvelope = taskMeta.contextEnvelope;
  const contextEnvelope: ConversationContextEnvelope | undefined =
    rawEnvelope &&
    typeof rawEnvelope === 'object' &&
    !Array.isArray(rawEnvelope) &&
    (rawEnvelope as { envelopeVersion?: unknown }).envelopeVersion === 1
      ? (rawEnvelope as ConversationContextEnvelope)
      : undefined;

  // release201/30 §7 Phase 3 — hoist trace id off task metadata onto the
  // top-level dispatch payload so daemon doesn't have to grub through the
  // metadata bag to learn the id. Wire shape matches frontend mint regex
  // (see src/lib/trace-id.ts). When absent, daemon mints a local fallback.
  const traceIdRaw = taskMeta.traceId;
  const traceId =
    typeof traceIdRaw === 'string' && /^[a-z0-9_]{6,40}$/i.test(traceIdRaw)
      ? traceIdRaw
      : undefined;

  // release202/09 §3.2 — promote the run-vs-task signal to typed top-level
  // fields. `runAsDispatchTask` stamps `metadata.kind='agent_run'` +
  // `metadata.runId=run.id` for chat-dispatch runs; kanban tasks carry
  // neither. We map `'agent_run'` → `'run'`. Fallback for legacy/edge rows:
  // a `run_`-prefixed id is also a run even if metadata lost the stamp.
  // Daemon trusts `kind`; missing → it falls back to the id-shape then legacy
  // probe-both. The bare `taskId` field still mirrors the run id on the wire
  // for back-compat with daemons that predate the typed `runId`.
  const isAgentRun = taskMeta.kind === 'agent_run' || task.id.startsWith('run_');
  const kind: 'run' | 'task' = isAgentRun ? 'run' : 'task';
  const runId = isAgentRun
    ? typeof taskMeta.runId === 'string' && taskMeta.runId
      ? (taskMeta.runId as string)
      : task.id
    : undefined;

  // Strip dispatch-control keys from the metadata that gets shipped to the
  // daemon — those are server-side concerns.
  const extraMetadata: Record<string, unknown> = { ...taskMeta };
  delete extraMetadata.profileId;
  delete extraMetadata.context;
  delete extraMetadata.delivery;
  // traceId hoisted to top-level payload field above; strip from metadata bag
  // so daemon's prompt-builder doesn't redundantly fold the id back into the
  // agent's system prompt.
  delete extraMetadata.traceId;
  // conversationType is hoisted to the top-level payload field above.
  delete extraMetadata.conversationType;
  // participants is hoisted to the top-level payload field above.
  delete extraMetadata.participants;
  // release201/30 — trigger sender hoisted above; strip from metadata bag.
  delete extraMetadata.triggerSenderUsername;
  delete extraMetadata.triggerSenderRole;
  // release201/25 §7 / release201/26 — envelope hoisted above; strip from
  // metadata bag so daemon's metadata pass-through doesn't redundantly
  // duplicate the envelope (it now rides on the wire payload's top level).
  delete extraMetadata.contextEnvelope;
  // Wave-8 W1: `assets.{linkedAssetIds,aggregatedAssetIds}` is the
  // server-side asset registry. The daemon receives the hydrated
  // `assetRefs[]` (mime + contentHash) on the top level of the payload,
  // so we strip the raw id list here. `observability` is also strictly
  // server-side accounting.
  delete extraMetadata.assets;
  delete extraMetadata.observability;
  // P1-2 (2026-05-25): `outboxRejections` is consumed above to build the
  // top-of-prompt warning. Daemon doesn't need it as raw metadata (it was
  // the originator) — dropping prevents redundant duplication on the wire.
  delete extraMetadata.outboxRejections;

  const execution = readRecord(extraMetadata.execution);
  const targetDaemonId =
    typeof execution.targetDaemonId === 'string' && execution.targetDaemonId.trim()
      ? execution.targetDaemonId.trim()
      : undefined;

  return {
    taskId: task.id,
    // release202/09 §3.2 — typed run-vs-task signal. `taskId` above still
    // mirrors the run id for legacy daemons; `kind`/`runId` are the new
    // structural truth the daemon's env-split + execution_context read.
    kind,
    ...(runId ? { runId } : {}),
    agentImUserId: agentImUserId || undefined,
    targetDaemonId,
    profileId,
    capability: task.capability ?? 'chat',
    prompt,
    runtimeRoute:
      task.runtimeRoute === 'shell' || task.runtimeRoute === 'sandbox' || task.runtimeRoute === 'agent'
        ? task.runtimeRoute
        : undefined,
    metadata: Object.keys(extraMetadata).length > 0 ? extraMetadata : undefined,
    timeoutMs: task.timeoutMs ?? undefined,
    context,
    conversationId: task.conversationId ?? undefined,
    conversationType,
    participants,
    // release201/09 Phase 2 — propagate task.projectId (may be NULL). Daemon
    // turns NULL into `_unscoped` sentinel for path composition; non-null is
    // also injected into agent env as `PRISMER_ACTIVE_PROJECT_ID`.
    projectId: task.projectId ?? null,
    // release201/30 §7 Phase 3 — see hoist comment above.
    traceId,
    // release201/30 — trigger sender identity for the daemon's XML
    // <conversation_context> wrapper.
    triggerSenderUsername,
    triggerSenderRole,
    // release201/25 §7 / release201/26 — typed L3 envelope (envelope-aware
    // adapter path). Forward-compat: undefined when flag was off at dispatch
    // build time; adapter falls back to the legacy flat fields above.
    contextEnvelope,
  };
}

/**
 * Validate + narrow the participants blob pulled off task metadata.
 *
 * Returns `undefined` (not an empty array) when the input is missing or
 * unusable — that way `buildTaskDispatchRequest` produces a payload with no
 * `participants` field at all for non-mention dispatches, instead of an
 * empty list that would still trigger the daemon's "Participants in this
 * group (0)" render path.
 */
function readParticipantList(raw: unknown):
  | Array<{
      imUserId: string;
      username: string;
      displayName: string;
      role: string;
      agentType: string | null;
    }>
  | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Array<{
    imUserId: string;
    username: string;
    displayName: string;
    role: string;
    agentType: string | null;
  }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const imUserId = typeof r.imUserId === 'string' ? r.imUserId : '';
    const username = typeof r.username === 'string' ? r.username : '';
    if (!imUserId || !username) continue;
    out.push({
      imUserId,
      username,
      displayName: typeof r.displayName === 'string' ? r.displayName : username,
      role: typeof r.role === 'string' ? r.role : 'human',
      agentType: typeof r.agentType === 'string' ? r.agentType : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * P1-2 (2026-05-25): build the top-of-prompt warning block from the
 * `outboxRejections` array persisted on `task.metadata` by handler.ts.
 *
 * Returns `null` when the field is missing or empty so the prompt builder
 * skips the section entirely (no spurious heading on the first turn).
 * Defensively narrows each entry — anything missing `filename`/`reason` is
 * dropped silently rather than emitted as `undefined` text. Caps the list
 * surface at 10 entries to keep the prompt section bounded even when the
 * full daemon-side buffer (20) is exhausted.
 *
 * Exported for unit tests (see `test/v19x-helpers.test.ts` if added) but
 * primarily called from `buildTaskDispatchRequest`.
 */
export function renderOutboxRejectionsBlock(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const filename = typeof r.filename === 'string' ? r.filename : '';
    const reason = typeof r.reason === 'string' ? r.reason : '';
    if (!filename || !reason) continue;
    const inferred = typeof r.inferredMime === 'string' ? r.inferredMime : 'unknown';
    const detected = typeof r.detectedMime === 'string' ? r.detectedMime : 'unknown';
    lines.push(`- \`${filename}\`: expected ${inferred}, detected ${detected} (${reason})`);
    if (lines.length >= 10) break;
  }
  if (lines.length === 0) return null;
  return [
    '## Previous turn outbox rejections',
    'The following files you wrote in the previous turn were rejected because their byte content did not match the file extension. Adjust your strategy — for example, write actual binary PDFs with reportlab instead of dumping markdown to a `.pdf` extension.',
    '',
    ...lines,
  ].join('\n');
}

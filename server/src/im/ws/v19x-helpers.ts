/**
 * Track C v1.9.x — pure helpers for the daemon protocol handlers.
 *
 * Extracted from `handler.ts` and `task.service.ts` so the algorithms can be
 * unit-tested in isolation (no real WebSocket, no Prisma client). Side-effecty
 * code (Prisma writes, rooms.sendToUser, log emissions) stays at the call
 * sites; this file is logic-only.
 */

import type { HostedAgentDeclaration, TaskDispatchContextEntry, TaskDispatchRequestPayload } from '../types/index';

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
  const prompt =
    (typeof task.description === 'string' && task.description ? task.description : null) ??
    legacyInputPrompt ??
    task.title ??
    '';
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

  // Strip dispatch-control keys from the metadata that gets shipped to the
  // daemon — those are server-side concerns.
  const extraMetadata: Record<string, unknown> = { ...taskMeta };
  delete extraMetadata.profileId;
  delete extraMetadata.context;
  delete extraMetadata.delivery;
  // conversationType is hoisted to the top-level payload field above.
  delete extraMetadata.conversationType;
  // participants is hoisted to the top-level payload field above.
  delete extraMetadata.participants;
  // Wave-8 W1: `assets.{linkedAssetIds,aggregatedAssetIds}` is the
  // server-side asset registry. The daemon receives the hydrated
  // `assetRefs[]` (mime + contentHash) on the top level of the payload,
  // so we strip the raw id list here. `observability` is also strictly
  // server-side accounting.
  delete extraMetadata.assets;
  delete extraMetadata.observability;

  const execution = readRecord(extraMetadata.execution);
  const targetDaemonId =
    typeof execution.targetDaemonId === 'string' && execution.targetDaemonId.trim()
      ? execution.targetDaemonId.trim()
      : undefined;

  return {
    taskId: task.id,
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

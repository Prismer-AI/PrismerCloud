// release202/09 P2 — explicit file-delivery sink for the daemon local-server
// `POST /local/deliver` route.
//
// The in-container agent has the agent IDENTITY (PRISMER_AGENT_USERNAME) but
// NOT a usable IM credential — so its `cloud file send` / `cloud deliver`
// commands cannot call the IM API directly ("Agent ceo not active for this API
// key"). Only the daemon holds a working credential. This handler is the
// proxy: the agent posts `{ taskId, path, mode, conversationId? }` to the
// daemon, the daemon uploads the file with its own credential (reusing the
// ArtifactsWatcher upload path + agent-output-policy + magic-bytes), then:
//
//   - mode:'attach' (动作 A) → records the assetId onto the watcher's
//     pendingByTask[taskId] so dispatch-end flushPending(taskId) rides it on
//     `task.dispatch.reply.assetIds` (the EXISTING reply-attachment plumbing).
//   - mode:'send'   (动作 B) → posts a standalone message carrying the asset
//     attachment to `conversationId` as the agent.
//   - mode:'task-attach' (动作 ③, release202/09 P5#2) → uploads the file as a
//     TASK-bound asset for a REAL kanban task. `deliverFile` already stamps
//     `sourceTaskId=taskId` on the upload, and the cloud `POST /assets` handler
//     auto-rolls it onto the task (`appendOutputAssetIdToTask` +
//     `reemitTerminalDigestForAssetArrival`, src/im/api/assets.ts ~3577) so the
//     deliverable lands on the kanban card + asset library. Unlike 'attach' it
//     does NOT ride a chat reply (a kanban task may run without one) — the
//     sourceTaskId column + digest re-emit are what surface it on the card.
//   - mode:'message-attach' (动作 A2, release202/09 P5#3) → appends the asset to
//     an ALREADY-SENT message (`cloud attach <messageId> <path>`). The agent has
//     already replied (`cloud send` / `cloud file send` returned a messageId)
//     and now wants a fresh file on THAT message. After uploading, the daemon
//     POSTs the resulting assetId to the cloud
//     `POST /api/im/messages/:conversationId/:messageId/attach` (X-IM-Agent
//     stamped), which appends it to the message's first-class `attachments[]`
//     column and re-emits `message.updated` so the UI patches it in-place.
//     Complements 'attach' (which rides a reply that does NOT exist yet) — A2 is
//     for a reply that already exists.
//
// Body validation lives here so local-server stays transport-only.

import type { CloudClient } from '../../auth.js';
import type { ArtifactsWatcher, DeliverFileResult } from '../artifacts-watcher.js';
import type { DeliverHandlerResult } from '../local-server.js';
import { getRunSessionRegistry } from '../memory/run-session-map.js';

export interface DeliverRequest {
  /**
   * Run/task id the agent is executing under (PRISMER_TASK_ID / PRISMER_RUN_ID).
   * release203/15c WS-E3: may be empty when `resolveActiveDispatch` is set — a
   * hermes agent has no per-dispatch env and the daemon reverse-looks it up
   * from `local_run_sessions` keyed by `agentImUserId`.
   */
  taskId: string;
  /** Absolute (or daemon-resolvable) path to the file the agent wrote. */
  path: string;
  /**
   * 'attach' = ride the agent's reply (动作 A); 'send' = standalone message
   * (动作 B); 'task-attach' = task-bound kanban deliverable (动作 ③, P5#2);
   * 'message-attach' = append to an already-sent message (动作 A2, P5#3).
   */
  mode: 'attach' | 'send' | 'task-attach' | 'message-attach';
  /**
   * Required for mode:'send' AND mode:'message-attach'. The conversation/session
   * the target message lives in (the cloud attach route is conversation-scoped).
   */
  conversationId?: string;
  /**
   * Required for mode:'message-attach'. The id of the ALREADY-SENT message to
   * append the asset to (returned by `cloud send` / `cloud file send`).
   */
  messageId?: string;
  /**
   * Optional agent handle (PRISMER_AGENT_USERNAME) forwarded by the
   * in-container CLI so a `send`-mode message is stamped as the agent. The
   * daemon prefers this over its own `resolveAgentUsername(taskId)` lookup —
   * the CLI is the agent's own process and is the authoritative source of its
   * identity.
   */
  agentUsername?: string;
  /**
   * release203/15c WS-E3 — agent IM user id (PRISMER_AGENT_IM_USER_ID),
   * forwarded by the in-container CLI as the disambiguation key for active-
   * dispatch reverse-lookup when `resolveActiveDispatch` is set.
   */
  agentImUserId?: string;
  /**
   * release203/15c WS-E3 — when set and `taskId` is absent, the daemon
   * reverse-looks-up the agent's current in-flight dispatch (by
   * `agentImUserId` + adapter='hermes' [+ conversationId]) to auto-complete
   * taskId(=runId)/conversationId. Hermes agents set this because they have no
   * per-dispatch env (§2). An explicit `taskId` / `--run-id` skips the lookup.
   */
  resolveActiveDispatch?: boolean;
}

export interface DeliverSinkOptions {
  watcher: ArtifactsWatcher;
  cloud: CloudClient;
  /**
   * Resolve the agent identity for a `send`-mode post so cloud stamps the
   * message sender as the agent (X-IM-Agent), not the daemon owner. Returns
   * the agent username (the human-readable handle, e.g. `ceo`) when known.
   */
  resolveAgentUsername?: (taskId: string) => string | undefined;
  /** Adapter name (observability) tagged onto the upload metadata. */
  resolveAdapter?: (taskId: string) => string | undefined;
}

function validate(body: unknown): { ok: true; value: DeliverRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const resolveActiveDispatch = b.resolveActiveDispatch === true;
  const hasTaskId = typeof b.taskId === 'string' && b.taskId.length > 0;
  // release203/15c WS-E3 — taskId may be absent IF resolveActiveDispatch is set
  // AND we have an agentImUserId to reverse-look-up the current dispatch.
  if (!hasTaskId) {
    if (!resolveActiveDispatch || typeof b.agentImUserId !== 'string' || b.agentImUserId.length === 0) {
      return { ok: false, error: 'taskId is required' };
    }
  }
  if (typeof b.path !== 'string' || b.path.length === 0) return { ok: false, error: 'path is required' };
  const mode = b.mode ?? 'attach';
  if (mode !== 'attach' && mode !== 'send' && mode !== 'task-attach' && mode !== 'message-attach') {
    return { ok: false, error: "mode must be 'attach', 'send', 'task-attach', or 'message-attach'" };
  }
  if (mode === 'send' && (typeof b.conversationId !== 'string' || b.conversationId.length === 0)) {
    return { ok: false, error: "conversationId is required when mode='send'" };
  }
  if (mode === 'message-attach') {
    if (typeof b.conversationId !== 'string' || b.conversationId.length === 0) {
      return { ok: false, error: "conversationId is required when mode='message-attach'" };
    }
    if (typeof b.messageId !== 'string' || b.messageId.length === 0) {
      return { ok: false, error: "messageId is required when mode='message-attach'" };
    }
  }
  return {
    ok: true,
    value: {
      taskId: hasTaskId ? (b.taskId as string) : '',
      path: b.path,
      mode,
      ...(typeof b.conversationId === 'string' ? { conversationId: b.conversationId } : {}),
      ...(typeof b.messageId === 'string' ? { messageId: b.messageId } : {}),
      ...(typeof b.agentUsername === 'string' && b.agentUsername.length > 0 ? { agentUsername: b.agentUsername } : {}),
      ...(typeof b.agentImUserId === 'string' && b.agentImUserId.length > 0 ? { agentImUserId: b.agentImUserId } : {}),
      ...(resolveActiveDispatch ? { resolveActiveDispatch: true } : {}),
    },
  };
}

/**
 * Build the `onDeliver` handler wired onto LocalServer. Returns a structured
 * `{ status, body }` the local-server relays verbatim.
 */
export function attachDeliver(opts: DeliverSinkOptions): (body: unknown) => Promise<DeliverHandlerResult> {
  return async (body: unknown): Promise<DeliverHandlerResult> => {
    const parsed = validate(body);
    if (!parsed.ok) {
      return { status: 400, body: { ok: false, error: parsed.error } };
    }
    let {
      taskId,
      conversationId,
    } = parsed.value;
    /**
     * desktop205 R1-c — the `/runs/<key>` folder key for a NON-bound (chat run)
     * delivery. Deliberately a SEPARATE variable from `taskId`: `taskId` keeps
     * feeding `bindSourceTask` / `metadata` / `resolveAgentUsername`, and
     * swapping it wholesale would flip the `bindSourceTask` shape-guard (a
     * cloud dispatch id is a ≤30-char cuid and would start binding
     * `sourceTaskId` to a non-existent kanban card). Only the folder key moves.
     */
    let folderKey: string | undefined;
    /**
     * desktop205 R1-d — the `pendingByTask` key for mode:'attach'.
     *
     * `pendingByTask` is keyed by the CLOUD DISPATCH ID everywhere else:
     * dispatch.ts writes `addActiveTask({ taskId })` and drains with
     * `flushPending(taskId)` (both `payload.taskId`), and the watcher's
     * auto-scan files uploads under that same `task.taskId`. Only the
     * auto-resolve branch below diverged: it filed under `hit.runId`, the
     * daemon/Hermes-local id — so a hermes `cloud deliver --mode attach`
     * landed in a bucket `flushPending` never reads and the asset NEVER
     * reached `reply.assetIds` (probe: `flushPending(cloudDispatchId) = []`
     * while `flushPending(hermesRunId) = ['ast_…']`).
     *
     * Same reason as `folderKey` this is a separate variable and not a swap of
     * `taskId`: a cloud dispatch id is cuid-shaped, and feeding it to `taskId`
     * flips `bindSourceTask` true → the `sourceTaskId` 500 R1 堵掉的那个.
     *
     * Left `undefined` for the synthetic `session:` row (`hit.taskId` NULL,
     * sessions-mapper): those have no cloud dispatch at all — see
     * `autoResolvedWithoutDispatch` below, which is why we then record NOTHING.
     */
    let dispatchKey: string | undefined;
    /**
     * desktop205 R1-e — the auto-resolve landed on a row with NO cloud dispatch
     * id (`hit.taskId` NULL: `HermesSessionMapper.persist`'s synthetic
     * `session:<id>` row, or a `/v1/runs` registration whose `task.taskId` was
     * absent). There is no dispatch to ride, so mode:'attach' must NOT record.
     *
     * R1-d filed those under `taskId` (= `hit.runId`, `session:…`). Nothing ever
     * drains that bucket: BOTH `flushPending` call sites (dispatch.ts reply-build
     * + the `finally{}` orphan drain) key on `payload.taskId`, the cloud dispatch
     * id, and a `session:` / hermes-local run id is by construction never one.
     * So the entry was unreachable-by-design and simply accumulated in the map
     * for the daemon's lifetime — a bucket with a writer and no reader.
     *
     * Chosen over a TTL sweeper because a TTL only bounds the garbage; there is
     * no consumer to preserve (grep: `pendingByTask` is written by
     * `recordDeliveredAsset` + the auto-scan `upload()`, and read ONLY by
     * `flushPending`, whose only production callers are those two dispatch.ts
     * sites). The asset is not lost — it is uploaded and anchored at
     * `/runs/<hit.runId>` (R1/R1-c), and the response says so.
     */
    let autoResolvedWithoutDispatch = false;
    /**
     * desktop205 R1-e — the auto-resolve branch ran (with or without a cloud
     * dispatch id). Either way `taskId` is now `hit.runId`, a daemon/hermes-local
     * id, so it is NEVER a kanban card. Feeds the run-vs-task ladder below.
     */
    let autoResolved = false;
    const {
      path: filePath,
      mode,
      messageId,
      agentUsername: reqAgentUsername,
      agentImUserId,
      resolveActiveDispatch,
    } = parsed.value;

    // release203/15c WS-E3 — auto-resolve the agent's CURRENT in-flight
    // dispatch when taskId is absent (hermes has no per-dispatch env, §2). An
    // explicit taskId / --run-id never reaches here (validate keeps it), so
    // the explicit flag ALWAYS WINS (§5.3). Conversation-narrowed lookups are
    // unambiguous; >1 active run with no narrowing → 409, never mis-attach.
    if (!taskId && resolveActiveDispatch && agentImUserId) {
      const registry = getRunSessionRegistry();
      if (!registry) {
        return {
          status: 400,
          body: { ok: false, error: '未找到活跃 dispatch（registry 未就绪），请传 --run-id' },
        };
      }
      const hit = registry.lookupActiveByAgent(agentImUserId, {
        adapterName: 'hermes',
        ...(conversationId ? { conversationId } : {}),
      });
      if (!hit) {
        return {
          status: 400,
          body: { ok: false, error: '未找到活跃 dispatch，请传 --run-id' },
        };
      }
      if ('ambiguous' in hit) {
        return {
          status: 409,
          body: {
            ok: false,
            error:
              '检测到多个并发 dispatch，无法确定目标；请传 --run-id（并按需 --conversation-id）。',
            candidates: hit.candidates.map((c) => ({
              runId: c.runId,
              conversationId: c.conversationId,
            })),
          },
        };
      }
      taskId = hit.runId;
      // desktop205 R1-c — anchor the artifact on the id the FRONTEND holds.
      // `hit.runId` is the daemon/hermes-local id (`run_<uuid>` / `session:<id>`
      // / `psession:<adapter>:<id>`); the UI only ever sees the cloud dispatch
      // id (`message.metadata.taskId`), and cloud persists NO mapping between
      // the two — so `/runs/<hit.runId>` is a folder no deep link can reach.
      // `hit.taskId` IS that cloud dispatch id (registered from `task.taskId`,
      // hermes/index.ts + sessions-dispatcher.ts). It is NULL for the mapper's
      // synthetic `session:` row (sessions-mapper.ts `persist`), which has no
      // cloud dispatch at all — those fall back to `hit.runId`.
      dispatchKey = hit.taskId && hit.taskId.length > 0 ? hit.taskId : undefined;
      autoResolved = true;
      autoResolvedWithoutDispatch = dispatchKey === undefined;
      folderKey = dispatchKey ?? hit.runId;
      if (!conversationId && hit.conversationId) conversationId = hit.conversationId;
      process.stdout.write(
        `[deliver] active-dispatch auto-resolve: agent=${agentImUserId} → runId=${taskId} conversationId=${conversationId ?? '-'}\n`,
      );
    }
    const adapter = opts.resolveAdapter?.(taskId);

    // desktop205 R1-e — resolve run-vs-task from a SOURCE THAT KNOWS, not from
    // the id's shape.
    //
    // The old guard was `taskId.length <= 30 && !/^(session:|run[:_])/`. That is
    // unsound and was live-wrong, not merely fragile: cloud sends a chat
    // dispatch's `payload.taskId` = `IMTaskRun.id`, declared
    // `@default(cuid()) @db.VarChar(30)` — byte-for-byte the same shape as
    // `IMTask.id`. That id reaches this function verbatim on the two explicit
    // paths (`PRISMER_RUN_ID` for spawn adapters; a `--run-id` copied out of
    // `<execution_context>`'s `<run_id>` for hermes), where the shape guard
    // answered "kanban" and stamped `sourceTaskId` = a run id that exists in NO
    // `im_tasks` row. It never 500'd (it fits VarChar(30)) — it silently
    // mis-bound and filed the artifact under `/tasks/<runId>`.
    //
    // The information exists upstream and is only destroyed at the CLI seam
    // (`detectDeliverProxy` collapses `PRISMER_TASK_ID || PRISMER_RUN_ID` into
    // one string). Rather than change the wire + ship a new CLI, we read it back
    // from the daemon's own in-flight registry: dispatch.ts stamps
    // `payload.kind` onto the ArtifactsWatcher's active-task entry, and any id an
    // in-container agent can name IS that entry's key. Ladder, most-authoritative
    // first:
    //
    //   1. auto-resolve  → `taskId` is `hit.runId`, a daemon/hermes-local id by
    //      construction. Never a kanban card.
    //   2. active dispatch on this daemon → `payload.kind` verbatim (cloud
    //      derived it from `metadata.kind==='agent_run'`).
    //   3. mode:'task-attach' → the caller DECLARED a kanban task (`cloud task
    //      attach --task`, guarded upstream by `assertNotRunId`).
    //   4. legacy shape guard → the id belongs to no dispatch we know (old CLI,
    //      cross-dispatch delivery, container mode). Kept so behaviour does not
    //      change under us, but it is a guess — we say so in the log so the next
    //      mis-bind is audible instead of silent.
    const activeKind = opts.watcher.activeTaskKind?.(taskId);
    const resolvedKind: 'run' | 'task' | 'unknown' = autoResolved
      ? 'run'
      : (activeKind ?? (mode === 'task-attach' ? 'task' : 'unknown'));
    const shapeGuessBinds = taskId.length <= 30 && !/^(session:|run[:_])/i.test(taskId);
    const bindSourceTask = resolvedKind === 'unknown' ? shapeGuessBinds : resolvedKind === 'task';
    if (resolvedKind === 'unknown' && shapeGuessBinds) {
      // The one branch where we bind on a guess. `im_task_runs.id` and
      // `im_tasks.id` are the same shape, so this line is the only warning a
      // future mis-bind will ever produce.
      process.stdout.write(
        `[deliver] WARN taskId=${taskId} is not an in-flight dispatch on this daemon and its kind is unknown; ` +
          `falling back to the id-shape guess (binding sourceTaskId). If this artifact lands on a non-existent task, ` +
          `this is the line that predicted it.\n`,
      );
    }

    // Upload with the daemon credential, running the same agent-output-policy
    // + magic-bytes guards the auto-scan path uses.
    let delivered: DeliverFileResult;
    try {
      delivered = await opts.watcher.deliverFile({
        taskId,
        filePath,
        ...(adapter ? { adapter } : {}),
        bindSourceTask,
        snapshotScopeKey: dispatchKey ?? (autoResolvedWithoutDispatch ? null : taskId),
        ...(folderKey ? { folderKey } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish the agent-readable rejection classes for a useful status.
      if (/^file not found:/i.test(message)) {
        return { status: 404, body: { ok: false, error: message } };
      }
      if (/MIME_MISMATCH|agent output rejected/i.test(message)) {
        return { status: 422, body: { ok: false, error: message } };
      }
      return { status: 502, body: { ok: false, error: message } };
    }

    // desktop205 O14 — cloud was unreachable; the bytes are durably in the
    // OriginOutbox and the daemon's UploadRunner will retransmit them.
    //
    // The two modes split here because only two of them are COMPLETE at that
    // point. 'attach' / 'task-attach' deliver purely by uploading (reply
    // assetIds are a best-effort adornment; the kanban landing is the
    // sourceTaskId stamp the deferred upload still carries), so the agent is
    // told 202 + queued and can move on. 'send' / 'message-attach' need a
    // SECOND cloud call with the assetId — which does not exist yet and could
    // not be made offline anyway — so they report failure. The artifact is
    // still queued (never lost); what failed is the message action, and saying
    // otherwise would be a lie the agent acts on.
    if (delivered.status === 'queued') {
      if (mode === 'attach' || mode === 'task-attach') {
        return {
          status: 202,
          body: {
            ok: true,
            queued: true,
            mode,
            filename: delivered.filename,
            outboxId: delivered.outboxId,
            taskId,
          },
        };
      }
      return {
        status: 502,
        body: {
          ok: false,
          queued: true,
          outboxId: delivered.outboxId,
          error:
            `cloud unreachable: ${delivered.filename} 已入 outbox（复联后自动补传），` +
            `但 mode='${mode}' 的消息动作未执行，请在恢复联网后重试。`,
        },
      };
    }
    const uploaded = delivered;

    if (mode === 'attach') {
      // 动作 A — record onto pendingByTask so dispatch-end flushPending rides
      // it on reply.assetIds (the existing chat-attachment + kanban plumbing).
      // desktop205 R1-d — the key must be the one dispatch.ts flushes with
      // (the cloud dispatch id); `dispatchKey` carries it on the auto-resolve
      // branch, and is undefined everywhere `taskId` already IS that id.
      //
      // desktop205 R1-e — …EXCEPT when auto-resolve found no cloud dispatch id
      // at all. Then there is no bucket anyone drains (see
      // `autoResolvedWithoutDispatch`), so recording is not "best effort", it is
      // writing into a map with no reader. We skip it and say so, rather than
      // return a bare `ok:true` that implies a reply the agent will never get.
      const ridesReply = !autoResolvedWithoutDispatch;
      if (ridesReply) {
        opts.watcher.recordDeliveredAsset(dispatchKey ?? taskId, uploaded.assetId);
      }
      return {
        status: 200,
        body: {
          ok: true,
          assetId: uploaded.assetId,
          mode: 'attach',
          filename: uploaded.filename,
          ridesReply,
          ...(ridesReply
            ? {}
            : {
                note:
                  `已上传并归档到 /runs/${folderKey ?? taskId}，但当前会话没有可搭载的 dispatch ` +
                  `（活跃会话行没有 cloud dispatch id），本次不会出现在回复附件里。`,
              }),
        },
      };
    }

    if (mode === 'task-attach') {
      // 动作 ③ (release202/09 P5#2) — task-bound kanban deliverable. The upload
      // above already stamped `sourceTaskId=taskId` (see deliverFile), so the
      // cloud `POST /assets` handler set boundKind='task-bound' and ran the
      // append-to-task + terminal-digest re-emit (src/im/api/assets.ts
      // rollupAndReemitDigest, ~3577). There is NO separate cloud HTTP call to
      // make: the sourceTaskId column + digest re-emit ARE the kanban-card +
      // asset-library landing. Unlike 'attach' we deliberately do NOT
      // recordDeliveredAsset — a kanban task may run without a chat reply, and
      // task products belong on the card, not a turn reply.
      return {
        status: 200,
        body: { ok: true, assetId: uploaded.assetId, mode: 'task-attach', filename: uploaded.filename, taskId },
      };
    }

    if (mode === 'message-attach') {
      // 动作 A2 (release202/09 P5#3) — append the freshly-uploaded asset to an
      // ALREADY-SENT message. The cloud attach route is conversation-scoped and
      // sender-only; we stamp X-IM-Agent so the cloud resolves the SAME agent
      // identity that authored the original message (so the sender check
      // passes). The cloud appends to the message's first-class attachments[]
      // and re-emits message.updated for the UI.
      const agentHandle = reqAgentUsername ?? opts.resolveAgentUsername?.(taskId);
      const res = await opts.cloud.request(
        'POST',
        `/api/im/messages/${encodeURIComponent(conversationId!)}/${encodeURIComponent(messageId!)}/attach`,
        {
          body: { assetId: uploaded.assetId },
          ...(agentHandle ? { headers: { 'X-IM-Agent': agentHandle } } : {}),
        },
      );
      if (!res.ok) {
        return {
          status: 502,
          body: {
            ok: false,
            error: `message attach failed: ${res.error?.code ?? res.status} ${res.error?.message ?? ''}`.trim(),
            assetId: uploaded.assetId,
          },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          assetId: uploaded.assetId,
          mode: 'message-attach',
          filename: uploaded.filename,
          messageId,
          conversationId,
        },
      };
    }

    // 动作 B — post a standalone message carrying the attachment to the
    // conversation, stamped as the agent (X-IM-Agent) so the sender is the
    // agent rather than the daemon owner.
    const agentUsername = reqAgentUsername ?? opts.resolveAgentUsername?.(taskId);
    const res = await opts.cloud.request(
      'POST',
      `/api/im/messages/${encodeURIComponent(conversationId!)}`,
      {
        body: {
          type: 'file',
          content: '',
          attachments: [{ kind: 'asset', assetId: uploaded.assetId, role: 'attachment' }],
        },
        ...(agentUsername ? { headers: { 'X-IM-Agent': agentUsername } } : {}),
      },
    );
    if (!res.ok) {
      return {
        status: 502,
        body: {
          ok: false,
          error: `message send failed: ${res.error?.code ?? res.status} ${res.error?.message ?? ''}`.trim(),
          assetId: uploaded.assetId,
        },
      };
    }
    return {
      status: 200,
      body: { ok: true, assetId: uploaded.assetId, mode: 'send', filename: uploaded.filename, conversationId },
    };
  };
}

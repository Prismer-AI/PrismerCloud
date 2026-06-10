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
import type { ArtifactsWatcher } from '../artifacts-watcher.js';
import type { DeliverHandlerResult } from '../local-server.js';

export interface DeliverRequest {
  /** Run/task id the agent is executing under (PRISMER_TASK_ID / PRISMER_RUN_ID). */
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
  if (typeof b.taskId !== 'string' || b.taskId.length === 0) return { ok: false, error: 'taskId is required' };
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
      taskId: b.taskId,
      path: b.path,
      mode,
      ...(typeof b.conversationId === 'string' ? { conversationId: b.conversationId } : {}),
      ...(typeof b.messageId === 'string' ? { messageId: b.messageId } : {}),
      ...(typeof b.agentUsername === 'string' && b.agentUsername.length > 0 ? { agentUsername: b.agentUsername } : {}),
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
    const {
      taskId,
      path: filePath,
      mode,
      conversationId,
      messageId,
      agentUsername: reqAgentUsername,
    } = parsed.value;
    const adapter = opts.resolveAdapter?.(taskId);

    // Upload with the daemon credential, running the same agent-output-policy
    // + magic-bytes guards the auto-scan path uses.
    let uploaded: { assetId: string; mime: string; filename: string; sizeBytes: number };
    try {
      uploaded = await opts.watcher.deliverFile({ taskId, filePath, ...(adapter ? { adapter } : {}) });
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

    if (mode === 'attach') {
      // 动作 A — record onto pendingByTask so dispatch-end flushPending rides
      // it on reply.assetIds (the existing chat-attachment + kanban plumbing).
      opts.watcher.recordDeliveredAsset(taskId, uploaded.assetId);
      return {
        status: 200,
        body: { ok: true, assetId: uploaded.assetId, mode: 'attach', filename: uploaded.filename },
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

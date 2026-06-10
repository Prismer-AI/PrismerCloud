/**
 * Prismer IM — WebSocket connection handler
 *
 * Manages the full lifecycle of a WebSocket connection:
 *   authenticate → join rooms → handle events → disconnect
 */

import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type Redis from 'ioredis';

import { verifyToken } from '../auth/jwt';
import { ownerIdentityKeys } from '../auth/middleware';
import { config } from '../config';
import { WebSocketTransport } from './transport';
import { RoomManager, type ConnectedClient } from './rooms';
import {
  ServerEvents,
  type AuthenticatePayload,
  type MessageSendPayload,
  type StreamStartPayload,
  type StreamChunkPayload,
  type StreamEndPayload,
  type TypingPayload,
  type PresenceUpdatePayload,
  type ConversationJoinPayload,
  type AgentHeartbeatPayload,
  type AgentCapabilityDeclarePayload,
  type AckPayload,
  type ReconnectPayload,
  type TaskHeartbeatPayload,
  type TaskStepAppendPayload,
} from './events';
import { AckTracker } from './ack-tracker';
import type { WSAckPersistentService } from '../services/ws-ack-persistent.service';
import { MessageService } from '../services/message.service';
import { ApprovalService } from '../services/approval.service';
import { ConversationService } from '../services/conversation.service';
import { PresenceService } from '../services/presence.service';
import { AgentService } from '../services/agent.service';
import { StreamService } from '../services/stream.service';
import type { TaskService } from '../services/task.service';
import { MemoryService } from '../services/memory.service';
import type { SyncService } from '../services/sync.service';
import { TaskStepRecorderService } from '../services/task-step-recorder.service';
import { AgentBindingService } from '../services/agent-binding.service';
import { WS_RPC_REPLY_TYPES, type WsRpcService } from '../services/ws-rpc.service';
import type {
  WSMessage,
  AssetAttachment,
  AgentHostDeclarePayload,
  HostAckedPayload,
  AgentStatusChangedPayload,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskDispatchResumeFailedPayload,
} from '../types/index';
import type { AssetDispatchObservation, OutboxRejectionRecord } from '../types/im-events';
import { computeProfilesToDelete, computeProfilesToSync } from './v19x-helpers';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
import { isDaemonForgotten } from '../services/runtime-binding.service';
import { generateIMUserId } from '../utils/id-gen';

const log = createModuleLogger('WS');
const DAEMON_ROUTE_PREFIX = 'daemon:';
const rememberPattern = /\bremember\s+(?:that\s+)?(.{4,800})|(?:记住|请记住|帮我记住)[:：]?\s*(.{2,800})/i;

function daemonRouteKey(daemonId: string): string {
  return `${DAEMON_ROUTE_PREFIX}${daemonId}`;
}

/**
 * release201/26 §8 Phase 4 — core effect of a `task.dispatch.resume_failed`
 * report, extracted from the WS closure so it is unit-testable independently
 * of the daemon-ownership resolution (which stays in the closure).
 *
 * Effects (ownership already validated by the caller):
 *   1. write `IMTaskRun.status='resume_failed'` + `error=reason` +
 *      `metadata.resumeFailedReason/At` (status is a free String column —
 *      schema.prisma:797 — so no enum / migration needed),
 *   2. post a `system_event` message carrying `metadata.status='resume_failed'`
 *      so the conversation-timeline strip renders the retry affordance.
 *
 * Distinct from `updateTaskRun` (which publishes terminal task.completed/failed
 * SSE + reconciles the board projection) — resume_failed is a retryable,
 * NON-terminal interruption, so we write the row + status-event directly.
 *
 * Never throws — DB / message failures are logged and swallowed so a bad
 * report can't crash the daemon WS connection.
 */
export async function applyResumeFailed(opts: {
  prisma: Pick<typeof prisma, 'iMTaskRun'>;
  messageService: Pick<MessageService, 'send'> | undefined;
  runId: string;
  taskId?: string;
  reason: string;
  run: { assigneeId: string; conversationId: string | null; metadata: string | null; sourceKind: string };
}): Promise<void> {
  const { runId, taskId, reason, run } = opts;
  let priorMeta: Record<string, unknown> = {};
  try {
    priorMeta = run.metadata ? (JSON.parse(run.metadata) as Record<string, unknown>) : {};
  } catch {
    priorMeta = {};
  }
  try {
    await opts.prisma.iMTaskRun
      .update({
        where: { id: runId },
        data: {
          status: 'resume_failed',
          error: reason,
          metadata: JSON.stringify({
            ...priorMeta,
            resumeFailedReason: reason,
            resumeFailedAt: new Date().toISOString(),
          }),
        },
      })
      .catch((err: unknown) => {
        console.warn('[WS] task.dispatch.resume_failed run update failed:', (err as Error).message);
      });
  } catch (err) {
    console.warn('[WS] task.dispatch.resume_failed run update threw:', (err as Error).message);
  }
  // Surface the interruption to the conversation timeline. Mirrors the
  // run-failure system_event shape so the existing readTaskStatusEvent picks
  // it up — only the status value differs.
  if (run.conversationId && opts.messageService) {
    const isChatMention = run.sourceKind === 'chat_mention';
    try {
      await opts.messageService.send({
        conversationId: run.conversationId,
        senderId: run.assigneeId,
        type: 'system_event',
        content: `⚠️ 任务中断，点击重试: ${reason}`,
        metadata: {
          kind: isChatMention ? 'agent_status_event' : 'task_status_event',
          status: 'resume_failed',
          taskId: taskId ?? runId,
          runId,
          sourceKind: run.sourceKind,
          error: reason,
        },
      });
    } catch (postErr) {
      console.warn('[WS] failed to post resume_failed system message:', (postErr as Error).message);
    }
  }
}

/**
 * v2.0.8 P0 (doc 21 §3.1) — detect agent's "I generated a file" claim.
 *
 * Why: office-artifacts SKILL.md says "Never claim 已落盘 / 已生成 without
 * an uploaded asset", but enforcement was prompt-only. The 2026-05-22
 * regression of 25/27 completed office-artifact tasks (per SKILL.md HARD
 * RULE preamble) where agents wrote the claim but uploaded zero files
 * means the prompt rule is insufficient — we need a server-side guard.
 *
 * Trigger: reply.output matches one of the patterns below AND assetIds
 * resolved to zero IMAsset rows. We DELIBERATELY do not look at
 * payload.assetIds alone — even if the daemon declared an id, that id
 * might not have an IMAsset row yet (artifacts-watcher race), so the user
 * still doesn't have a file. The criterion that matters is "did the
 * chat reply attach a real attachment". Patterns are tight enough to
 * avoid catching "我会生成 / I will create" future-tense statements,
 * generic enumerations ("生成了一份大纲"), or references to existing
 * assets the user uploaded.
 *
 * Edge cases consciously skipped:
 *   - "已为你写好如下大纲" — no file extension, no 附件 keyword → ignored
 *   - "已生成 3 个点子" — no file extension → ignored
 *   - "I'll prepare the PDF in a minute" — future tense, no past-perfect → ignored
 *
 * Returns true only when the text clearly asserts past-tense file delivery.
 */
// 2026-05-29 — DOWNGRADED from a content-rewrite to metadata-only flag.
//
// Why: the regex-based content rewrite was treating a symptom (agent text
// says "PDF generated" while cloud sees zero attached assets) as the root
// cause. The actual root cause for the lying-CEO screenshot today was
// architectural: release201/09 renamed `_outbox/` to `result/` (later
// renamed again to `artifacts/` in release202/04 §3.1) and retired the
// artifacts-watcher (née outbox-watcher) auto-upload for the new host-mode
// layout (dispatch.ts, §9.4a.1). Agents now MUST explicitly call
// `cloud asset upload --task-id` to surface deliverables — but
// office-artifacts SKILL.md never made that obvious enough for hermes
// to consistently obey it. The CEO agent literally generated 3 PDFs
// into `tasks/<id>/result/` but never called the upload command, so
// cloud reply.assetIds came back empty. The agent wasn't lying; the
// asset bridge was just broken.
//
// Rewriting the chat text papered over the real fix (close the asset
// bridge so reply.assetIds reflects reality) and made user-visible
// content drift from what the agent actually produced. A user pointed
// this out today: "为什么全部是硬编码 — 这是业界最佳实践吗？" — fair.
//
// 2026-05-31 release201/30 §8 — FURTHER DOWNGRADED to warn-only telemetry.
//
// Phase 1 of release201/30 闭合了 asset bridge 的两条新路径：(a) typescript
// SDK 的 `cloud file send` 在 daemon host-mode 下 cp 源文件进 PRISMER_ARTIFACTS_DIR
// (release202/04;旧 PRISMER_OUTBOX_DIR 仍兼容) → artifacts-watcher.flushPending
// 自动把 assetId 挂到 reply.assetIds；
// (b) cloud message handler 看到 type='file' 时从 metadata.uploadId 反查
// IMFileUpload + lookup-or-create IMAsset + 加进 attachments[]。两路打通后，
// "claimedFile && !hasRealAsset" 的真实 false-positive 大幅下降。
//
// detect 函数 + LIE_PATTERNS 保留作为兜底 telemetry，但**不再写**
// metadata.systemFlags = ['lie_intercepted'] / originalOutput / lieReason，
// **不再以 disagreement 触发** dispatch.lifecycle='failed'。Agent reply 永远
// 走 'completed' lifecycle；如有 disagreement，落 log.warn 供 SRE 追溯。
// 原 2026-05-29 systemFlags 立场（doc 21 §3.1）正式 DEPRECATED。
// LIE_PATTERNS + detectAgentFileClaim extracted to ./lie-detector so the
// patterns are unit-testable without importing this whole handler
// (release201/31 §4.1). Behaviour unchanged.
import { detectAgentFileClaim } from './lie-detector';

interface DaemonAgentAuthorizationPrisma {
  iMAgentBinding?: {
    findUnique(args: {
      where: { agentImUserId: string };
      select: { boundDaemonId: true };
    }): Promise<{ boundDaemonId: string | null } | null>;
  };
  iMAgentCard: {
    findUnique(args: {
      where: { imUserId: string };
      select: { metadata: true };
    }): Promise<{ metadata: string | null } | null>;
  };
}

export async function isDaemonAuthorizedForAgentBinding(
  prismaClient: DaemonAgentAuthorizationPrisma,
  agentImUserId: string,
  daemonId: string | null,
  context = 'task.dispatch.*',
): Promise<boolean> {
  if (!daemonId) return false;

  try {
    const binding = await prismaClient.iMAgentBinding?.findUnique({
      where: { agentImUserId },
      select: { boundDaemonId: true },
    });
    if (binding) {
      const boundDaemonId = typeof binding.boundDaemonId === 'string' ? binding.boundDaemonId.trim() : '';
      return boundDaemonId === daemonId;
    }
  } catch (err) {
    console.warn(
      `[WS] ${context} im_agent_bindings lookup failed for ${agentImUserId}; falling back to metadata.daemonId: ${(err as Error).message}`,
    );
    return isDaemonAuthorizedByLegacyMetadata(prismaClient, agentImUserId, daemonId);
  }

  return isDaemonAuthorizedByLegacyMetadata(prismaClient, agentImUserId, daemonId);
}

async function isDaemonAuthorizedByLegacyMetadata(
  prismaClient: DaemonAgentAuthorizationPrisma,
  agentImUserId: string,
  daemonId: string,
): Promise<boolean> {
  const card = await prismaClient.iMAgentCard
    .findUnique({ where: { imUserId: agentImUserId }, select: { metadata: true } })
    .catch(() => null);
  try {
    const meta = card?.metadata ? (JSON.parse(card.metadata) as { daemonId?: unknown }) : {};
    const metadataDaemonId = typeof meta.daemonId === 'string' ? meta.daemonId.trim() : '';
    return metadataDaemonId === daemonId;
  } catch {
    return false;
  }
}

export interface WebSocketDeps {
  redis: Redis;
  rooms: RoomManager;
  messageService: MessageService;
  conversationService: ConversationService;
  presenceService: PresenceService;
  agentService: AgentService;
  streamService: StreamService;
  /** Required for v1.9.x daemon protocol completion/progress handling. */
  taskService: TaskService;
  /**
   * v2.0 §4.8.2 (Wave 2-B2) — needed by handleAgentHostDeclare to emit
   * `agent.binding.contested` sync events when a second daemon tries to host
   * an agent already bound elsewhere. Optional so existing tests/dev paths
   * that wire a bare deps object still type-check; absence falls back to a
   * no-op syncService (binding row still records the contest).
   */
  syncService?: SyncService;
  /**
   * Wave-4 E3 (§4.5) — persistent ack tracker. Mirrors high-priority
   * outbound events into `im_ws_acks` so a reconnecting client can ask
   * "what did I miss since cursor?" and the server can replay them
   * across Pod restarts / drift. Optional — if absent, only the in-memory
   * AckTracker (5min TTL, single-Pod) is used.
   */
  wsAckPersistent?: WSAckPersistentService;
  /**
   * v2.0 §4.8.1 (Wave 4-E4) — webhook dispatch RPC reply correlator.
   * When set, incoming frames whose `type ∈ WS_RPC_REPLY_TYPES` are routed
   * into `wsRpc.handleReply()` instead of (or in addition to) regular
   * IM event handling. Optional so tests and the standalone IM dev runner
   * keep type-checking without the webhook path.
   */
  wsRpc?: WsRpcService;
}

export function setupWebSocket(wss: WebSocketServer, deps: WebSocketDeps): void {
  const { rooms, messageService, conversationService, presenceService, agentService, streamService, taskService } =
    deps;
  if (!taskService) {
    throw new Error('setupWebSocket requires taskService for daemon task.dispatch.* handling');
  }
  const memoryService = new MemoryService();

  // v2.0 §4.8.2 (Wave 2-B2) — service that owns IMAgentBinding lifecycle.
  // Replaces the silent-reject branch on contested host.declare with an
  // explicit binding row + sync event the user can see and act on.
  const agentBindingService = new AgentBindingService(prisma as any, deps.syncService);

  // v2.0 §4.4 (Wave 3.5 W4 — P4a) — durable activity timeline writer for
  // daemon-pushed `task.step.append` frames. Fans out a
  // `task.step.appended` IMSyncEvent on each new row so the front-end
  // InlineActivityStream (P4c — Wave 4) updates without polling.
  const taskStepRecorder = new TaskStepRecorderService({ syncService: deps.syncService });

  // Shared ACK tracker for all connections on this Pod
  const ackTracker = new AckTracker();
  rooms.setAckTracker(ackTracker);

  // Wave-4 E3 (§4.5) — mirror high-priority outbound events to im_ws_acks.
  // RoomManager calls the hook on every local sendToUser (before serialize)
  // so the row exists before the client could possibly ACK. Pure side-channel:
  // failure to insert never blocks delivery.
  const wsAckPersistent = deps.wsAckPersistent;
  if (wsAckPersistent) {
    rooms.setLocalSendHook((userId, event) => {
      const payload = event as unknown as Record<string, unknown>;
      const ackId = (payload as { ackId?: string }).ackId;
      if (!ackId) return; // skipped event types (SKIP_ACK_TYPES) → no row
      void wsAckPersistent.trackOutbound(userId, ackId, payload);
    });
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let client: ConnectedClient | null = null;
    let authTimeout: ReturnType<typeof setTimeout>;

    /**
     * Set of agent imUserIds the daemon on this connection has declared as
     * hosting (via `agent.host.declare`). Used to validate inbound
     * `task.dispatch.progress` / `task.dispatch.reply` messages — daemon
     * can only report on its own agents' tasks. Empty set for non-daemon
     * (mobile, web) connections — they never call task.dispatch.* anyway.
     */
    const declaredAgents = new Set<string>();
    const pendingRejectedAgents = new Set<string>();
    let declaredDaemonId: string | null = null;
    let declaredWorkspaceId: string | null = null;

    /**
     * `agent.host.declare` is sent on first reconnect AND every 30s as a
     * heartbeat (see runtime/daemon/runner.ts). We only want to fire
     * `redispatchPending` on the first declare per WS connection — if it
     * fires on every heartbeat the cloud pushes the same pending tasks
     * back to the daemon every 30s, multiplying network traffic and
     * (worse) re-running tasks that the daemon already executed and is
     * waiting to flush a `task.dispatch.reply` for.
     */
    let didRedispatch = false;

    /**
     * "Shadow" ConnectedClient entries registered under each declared
     * agent's imUserId and this runtime's `daemon:<daemonId>` route so
     * task.service reaches the same physical socket. Tracked here so the
     * `close` handler can remove them (RoomManager keys by userId, not by
     * transport, so we have to clean up explicitly).
     */
    const shadowClients: ConnectedClient[] = [];

    // Require authentication within configured timeout (default 10s)
    authTimeout = setTimeout(() => {
      if (!client) {
        ws.send(JSON.stringify(ServerEvents.error('Authentication timeout')));
        ws.close(4001, 'Authentication timeout');
      }
    }, config.ws.authTimeoutMs);

    // Check for token in query string (for initial connection)
    const url = new URL(req.url || '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      tryAuthenticate(queryToken);
    }

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg: WSMessage = JSON.parse(raw.toString());
        handleEvent(msg);
      } catch (err) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid JSON')));
      }
    });

    ws.on('close', () => {
      if (client) {
        const userId = client.userId;
        ackTracker.handleDisconnect(userId);
        rooms.removeClient(client);
        presenceService.setOffline(userId);
        // §4.5 — if this was the LAST connection on this Pod for the user,
        // SREM us from `im:user:<userId>:pods` so other Pods stop routing
        // here. Check AFTER removeClient.
        const wasLast = !rooms.isOnline(userId);
        void rooms.onClientDisconnected(userId, wasLast);
        // Tear down per-agent shadow registrations so RoomManager doesn't
        // route to a closed socket on the next dispatch.
        for (const shadow of shadowClients) {
          rooms.removeClient(shadow);
        }
        if (shadowClients.length > 0) {
          console.log(`[WS] Disconnected: ${client.username} (${userId}) + ${shadowClients.length} shadow route(s)`);
          shadowClients.length = 0;
        } else {
          console.log(`[WS] Disconnected: ${client.username} (${userId})`);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });

    // ─── Event router ────────────────────────────────────────

    function handleEvent(msg: WSMessage) {
      const { type, payload, requestId } = msg;

      if (type === 'authenticate') {
        const { token } = payload as AuthenticatePayload;
        tryAuthenticate(token, requestId);
        return;
      }

      if (type === 'ping') {
        ws.send(JSON.stringify(ServerEvents.pong(requestId)));
        return;
      }

      if (type === 'ack') {
        const { ackId } = payload as AckPayload;
        if (ackId) {
          ackTracker.ack(ackId);
          // §4.5 — also mark the persistent row acked. Fire-and-forget; the
          // in-memory tracker already covers the fast path.
          if (wsAckPersistent && client) {
            void wsAckPersistent.markAcked(client.userId, ackId);
          }
        }
        return;
      }

      // All other events require authentication
      if (!client) {
        ws.send(JSON.stringify(ServerEvents.error('Not authenticated', 'AUTH_REQUIRED', requestId)));
        return;
      }

      // v2.0 §4.8.1 (Wave 4-E4) — RPC reply correlation. Daemon-originated
      // replies (currently only `webhook.dispatch.reply`) carry an
      // embedded `_rpcId` matching the request the server issued via
      // `WsRpcService.invoke`. Route those into the RPC service instead of
      // (or in addition to) the regular handler table. We do this BEFORE
      // the handler dispatch so a missing handler entry doesn't generate a
      // bogus `UNKNOWN_EVENT` error frame back to the daemon.
      if (typeof type === 'string' && WS_RPC_REPLY_TYPES.has(type)) {
        if (deps.wsRpc) {
          const { handled } = deps.wsRpc.handleReply(payload);
          if (!handled) {
            // Reply without an `_rpcId` — daemon bug or stale message; log
            // but do NOT emit an error frame (the daemon already moved on
            // and we don't want to spam its WS receive loop).
            console.warn(`[WS] ${type} arrived without _rpcId — dropped`);
          }
        }
        return;
      }

      const handlers: Record<string, () => void | Promise<void>> = {
        'message.send': () => handleMessageSend(payload as MessageSendPayload, requestId),
        'message.stream.start': () => handleStreamStart(payload as StreamStartPayload, requestId),
        'message.stream.chunk': () => handleStreamChunk(payload as StreamChunkPayload),
        'message.stream.end': () => handleStreamEnd(payload as StreamEndPayload, requestId),
        'typing.start': () => handleTyping(payload as TypingPayload, true),
        'typing.stop': () => handleTyping(payload as TypingPayload, false),
        'presence.update': () => handlePresenceUpdate(payload as PresenceUpdatePayload),
        'conversation.join': () => handleConversationJoin(payload as ConversationJoinPayload, requestId),
        'conversation.leave': () => handleConversationLeave(payload as ConversationJoinPayload, requestId),
        'agent.heartbeat': () => handleAgentHeartbeat(payload as AgentHeartbeatPayload),
        'agent.capability.declare': () =>
          handleAgentCapabilityDeclare(payload as AgentCapabilityDeclarePayload, requestId),
        // ─── v1.9.x daemon protocol (Track C m2) ───
        'agent.host.declare': () => handleAgentHostDeclare(payload as AgentHostDeclarePayload, requestId),
        'agent.status.changed': () => handleAgentStatusChanged(payload as AgentStatusChangedPayload),
        'task.dispatch.progress': () => handleTaskDispatchProgress(payload as TaskDispatchProgressPayload),
        'task.dispatch.reply': () => handleTaskDispatchReply(payload as TaskDispatchReplyPayload, requestId),
        // release201/26 §8 Phase 4 — daemon couldn't resume an interrupted
        // run from its local checkpoint. Mark the run resume_failed and surface
        // a retry strip in the conversation timeline.
        'task.dispatch.resume_failed': () => handleTaskDispatchResumeFailed(payload as TaskDispatchResumeFailedPayload),
        // v2.0 §4.2 Track B-1 — per-task phase heartbeat (distinct from
        // `agent.heartbeat` which is agent-process-level liveness).
        'task.heartbeat': () => handleTaskHeartbeat(payload as TaskHeartbeatPayload),
        // v2.0 §4.4 (Wave 3.5 W4 — P4a) — durable per-step activity timeline.
        // Sibling channel to task.heartbeat (which only carries phase signal);
        // this one persists per phase change / tool call / reasoning chunk so
        // the front-end InlineActivityStream can render history.
        'task.step.append': () => handleTaskStepAppend(payload as TaskStepAppendPayload),
        reconnect: () => handleReconnect(payload as ReconnectPayload, requestId),
      };

      const handler = handlers[type as string];
      if (handler) {
        Promise.resolve(handler()).catch((err) => {
          console.error(`[WS] Error handling ${type}:`, err);
          ws.send(JSON.stringify(ServerEvents.error(`Internal error handling ${type}`, 'INTERNAL', requestId)));
        });
      } else {
        ws.send(JSON.stringify(ServerEvents.error(`Unknown event type: ${type}`, 'UNKNOWN_EVENT', requestId)));
      }
    }

    // ─── Authentication ──────────────────────────────────────

    /**
     * Authenticate the WS connection. Supports two token shapes:
     *   • `sk-prismer-*` — daemon API key. Resolves the cloud user via
     *     `pc_api_keys` (SHA-256 lookup), then maps to the human IMUser
     *     via `IMUser.userId` field. Daemon connections always bind under
     *     the human's IMUser id; per-agent routing happens through the
     *     `declaredAgents` shadow registrations in handleAgentHostDeclare.
     *   • Anything else — JWT (existing 1.8.2 path for mobile/web).
     */
    function tryAuthenticate(token: string, requestId?: string): void {
      if (token.startsWith('sk-prismer-')) {
        // Async path; fire-and-forget but surface errors via WS.
        tryAuthenticateApiKey(token, requestId).catch((err) => {
          console.error('[WS] API key auth error:', (err as Error).message);
          ws.send(JSON.stringify(ServerEvents.error('Auth error', 'AUTH_FAILED', requestId)));
        });
        return;
      }

      try {
        const payload = verifyToken(token);
        completeAuthentication({ userId: payload.sub, username: payload.username, requestId });
      } catch (err) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid token', 'AUTH_FAILED', requestId)));
      }
    }

    /**
     * Resolve an `sk-prismer-*` token to its IMUser cuid. Validation:
     *   1. SHA-256 hash lookup in pc_api_keys (status='ACTIVE') →
     *      cloud user id (numeric).
     *   2. IMUser lookup by `userId === String(cloudUserId)` AND
     *      `role === 'human'`. Multiple agent IMUsers can share a userId,
     *      but the daemon binds under the human owner's IMUser; agent-level
     *      routing is via shadow connections in handleAgentHostDeclare.
     */
    async function tryAuthenticateApiKey(token: string, requestId?: string): Promise<void> {
      const { validateApiKeyFromDb } = await import('../../lib/db-api-keys');
      const result = await validateApiKeyFromDb(token);
      if (!result) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid API key', 'AUTH_FAILED', requestId)));
        return;
      }

      let humanImUser = await prisma.iMUser.findFirst({
        where: {
          role: 'human',
          OR: [{ numericId: result.userId }, { userId: String(result.userId) }],
        },
        select: { id: true, username: true },
      });
      if (!humanImUser) {
        // Mirror the HTTP path: if a daemon races ahead of /register or
        // /me on a brand-new cloud account, auto-create the human IMUser
        // here instead of bouncing the WS connection. Without this fix,
        // first-boot hits a deterministic AUTH_FAILED loop until the
        // daemon happens to retry after the HTTP-side ensureIMUser fires.
        const fallbackUsername = `user-${String(result.userId)}`;
        const { generateUserId } = await import('../utils/id-gen');
        try {
          const created = await prisma.iMUser.create({
            data: {
              id: generateUserId(),
              username: fallbackUsername,
              displayName: fallbackUsername,
              role: 'human',
              userId: String(result.userId),
              numericId: result.userId,
              metadata: JSON.stringify({ autoCreated: true, source: 'ws-api-key' }),
            },
            select: { id: true, username: true },
          });
          humanImUser = created;
          console.log(`[Auth] Auto-created human IMUser ${created.id} for cloud user ${result.userId} (WS path)`);
        } catch (err) {
          // Race: someone else (HTTP middleware) just created it. Retry the lookup once.
          humanImUser = await prisma.iMUser.findFirst({
            where: {
              role: 'human',
              OR: [{ numericId: result.userId }, { userId: String(result.userId) }],
            },
            select: { id: true, username: true },
          });
          if (!humanImUser) {
            ws.send(
              JSON.stringify(
                ServerEvents.error(
                  `API key valid but failed to provision IM user: ${(err as Error).message}`,
                  'NO_IMUSER_LINKED',
                  requestId,
                ),
              ),
            );
            return;
          }
        }
      }

      completeAuthentication({
        userId: humanImUser.id,
        username: humanImUser.username,
        requestId,
      });
    }

    /**
     * Common path for both JWT and API-key auth. Registers the connection,
     * marks online, sends `authenticated` ack, delivers any unacked
     * messages, and auto-joins conversations.
     */
    function completeAuthentication(args: { userId: string; username: string; requestId?: string }) {
      clearTimeout(authTimeout);
      client = {
        transport: new WebSocketTransport(ws),
        userId: args.userId,
        username: args.username,
        connectedAt: Date.now(),
      };
      rooms.addClient(client);
      presenceService.setOnline(args.userId);
      // §4.5 — record this Pod in the user's pod-membership set so other
      // Pods know to forward sendToUser via backplane.sendToPod.
      void rooms.onClientConnected(args.userId);
      ws.send(JSON.stringify(ServerEvents.authenticated(args.userId, args.requestId)));
      console.log(`[WS] Authenticated: ${args.username} (${args.userId})`);
      deliverUnackedMessages(args.userId);
      // §4.5 — also drain im_ws_acks (durable) for cross-Pod / cross-restart
      // recovery. Independent path: in-memory deliverUnackedMessages above
      // handles the fast same-Pod case; this catches everything else.
      void deliverPersistentUnacked(args.userId);
      autoJoinConversations(args.userId);
    }

    /**
     * §4.5 — replay un-acked HIGH-PRIORITY events from im_ws_acks. Called on
     * authenticate AND reconnect. Independent of in-memory ackTracker, so a
     * client reconnecting to a freshly-started Pod still gets its missed
     * messages.
     */
    async function deliverPersistentUnacked(userId: string): Promise<void> {
      if (!wsAckPersistent) return;
      try {
        const rows = await wsAckPersistent.getUnacked(userId);
        if (rows.length === 0) return;
        console.log(`[WS] Delivering ${rows.length} persisted-unacked events to ${userId}`);
        for (const row of rows) {
          // Mark isRetry so the client UI can dedupe if it already showed
          // this event from a prior session. The ackId is preserved — same
          // ack confirms both the in-memory and DB rows.
          const retryPayload = { ...row.payload, ackId: row.ackId, isRetry: true };
          try {
            ws.send(JSON.stringify(retryPayload));
          } catch (err) {
            console.warn('[WS] persistent replay send failed:', (err as Error).message);
            break;
          }
        }
      } catch (err) {
        console.warn('[WS] deliverPersistentUnacked error:', (err as Error).message);
      }
    }

    async function autoJoinConversations(userId: string) {
      try {
        const participations = await conversationService.listByUser(userId);
        for (const p of participations) {
          rooms.joinRoom(p.conversation.id, userId);
        }
      } catch (err) {
        console.error('[WS] Error auto-joining conversations:', err);
      }
    }

    // ─── ACK / Reconnect helpers ───────────────────────────────

    function deliverUnackedMessages(userId: string) {
      const undelivered = ackTracker.getUndelivered(userId);
      if (undelivered.length === 0) return;

      console.log(`[WS] Delivering ${undelivered.length} unacked messages to ${userId}`);
      for (const msg of undelivered) {
        const retryPayload = { ...msg.payload, ackId: msg.ackId, isRetry: true };
        ws.send(JSON.stringify(retryPayload));
        // Re-track for ACK on this new connection
        msg.retries++;
        ackTracker.track(userId, retryPayload);
      }
    }

    async function handleReconnect(payload: ReconnectPayload, requestId?: string) {
      if (!client) return;

      // Deliver unacked messages (in case authenticate didn't catch them all)
      deliverUnackedMessages(client.userId);
      // §4.5 — also drain persisted unacks (covers cross-Pod / restart gaps)
      await deliverPersistentUnacked(client.userId);

      // Tell the client to use /sync for any gap beyond what ACK covers
      ws.send(
        JSON.stringify(
          ServerEvents.reconnectAck(
            {
              userId: client.userId,
              undeliveredCount: 0, // Already delivered above
              syncAdvised: true,
            },
            requestId,
          ),
        ),
      );
      console.log(`[WS] Reconnect handled for ${client.username} (${client.userId})`);
    }

    // ─── Message handlers ────────────────────────────────────

    async function handleMessageSend(payload: MessageSendPayload, requestId?: string) {
      if (!client) return;

      const result = await messageService.send({
        conversationId: payload.conversationId,
        senderId: client.userId,
        type: payload.type,
        content: payload.content,
        metadata: payload.metadata,
        attachments: payload.attachments,
        parentId: payload.parentId,
      });

      const msg = result.message;
      const routing = result.routing;

      // Build metadata with routing info
      const messageMetadata = msg.metadata ? JSON.parse(msg.metadata) : {};
      if (routing && routing.targets.length > 0) {
        messageMetadata.routeTargets = routing.targets.map((t) => t.userId);
        messageMetadata.routingMode = routing.mode;
      }

      // Broadcast to room
      rooms.broadcastToRoom(
        payload.conversationId,
        ServerEvents.messageNew({
          id: msg.id,
          conversationId: msg.conversationId,
          senderId: msg.senderId,
          type: msg.type as any,
          content: msg.content,
          metadata: messageMetadata,
          attachments: msg.attachments ?? undefined,
          parentId: msg.parentId ?? undefined,
          createdAt: msg.createdAt.toISOString(),
        }),
      );
    }

    async function handleStreamStart(payload: StreamStartPayload, requestId?: string) {
      if (!client) return;
      // v2.0 §4.4.7 — async; allocates per-stream flush timer + recipient fan-out cache.
      await streamService.startStream({
        streamId: payload.streamId,
        conversationId: payload.conversationId,
        senderId: client.userId,
        type: payload.type,
        metadata: payload.metadata,
      });
    }

    function handleStreamChunk(payload: StreamChunkPayload) {
      if (!client) return;
      const stream = streamService.getStream(payload.streamId);
      if (!stream) return;

      // v2.0 §4.4.7 — just append; the 200ms flush timer inside StreamService
      // batches chunks into SSE `message.partial` envelopes + im_message_partials
      // rows. We still emit the legacy WS `message.stream.chunk` for any
      // pre-2.0 daemon that's listening on the WS room.
      streamService.appendChunk(payload.streamId, payload.chunk);

      rooms.broadcastToRoom(
        stream.conversationId,
        ServerEvents.streamChunk({
          streamId: payload.streamId,
          conversationId: stream.conversationId,
          senderId: client.userId,
          chunk: payload.chunk,
          index: payload.index,
        }),
      );
    }

    async function handleStreamEnd(payload: StreamEndPayload, requestId?: string) {
      if (!client) return;
      const result = await streamService.endStream(payload.streamId, payload.finalContent);
      if (!result) return;

      // Persist final message via the standard Wave 2-B1 outbox path.
      // Use the stream's reserved messageId so the partial-row buffer
      // (im_message_partials.messageId) keys to the final im_messages row.
      const sendResult = await messageService.send({
        conversationId: result.conversationId,
        senderId: client.userId,
        type: result.type,
        content: result.finalContent,
        metadata: {
          ...result.metadata,
          wasStreamed: true,
          streamId: payload.streamId,
          streamMessageId: result.messageId,
        },
      });

      rooms.broadcastToRoom(
        result.conversationId,
        ServerEvents.streamEnd({
          streamId: payload.streamId,
          conversationId: result.conversationId,
          messageId: sendResult.message.id,
          finalContent: result.finalContent,
        }),
      );
    }

    function handleTyping(payload: TypingPayload, isTyping: boolean) {
      if (!client) return;
      rooms.broadcastToRoom(
        payload.conversationId,
        ServerEvents.typingIndicator({
          conversationId: payload.conversationId,
          userId: client.userId,
          isTyping,
        }),
        client.userId,
      );
    }

    function handlePresenceUpdate(payload: PresenceUpdatePayload) {
      if (!client) return;
      presenceService.setStatus(client.userId, payload.status);
      rooms.broadcastGlobal(
        ServerEvents.presenceChanged({
          userId: client.userId,
          status: payload.status,
          lastSeen: Date.now(),
        }),
      );
    }

    async function handleConversationJoin(payload: ConversationJoinPayload, requestId?: string) {
      if (!client) return;
      rooms.joinRoom(payload.conversationId, client.userId);
    }

    async function handleConversationLeave(payload: ConversationJoinPayload, requestId?: string) {
      if (!client) return;
      rooms.leaveRoom(payload.conversationId, client.userId);
    }

    async function handleAgentHeartbeat(payload: AgentHeartbeatPayload) {
      if (!client) return;
      await agentService.heartbeat(client.userId, {
        status: payload.status,
        load: payload.load,
        activeConversations: payload.activeConversations,
      });
    }

    async function handleAgentCapabilityDeclare(payload: AgentCapabilityDeclarePayload, requestId?: string) {
      if (!client) return;
      await agentService.declareCapabilities(client.userId, payload.capabilities);
      ws.send(
        JSON.stringify(
          ServerEvents.agentRegistered({
            agentId: client.userId,
            name: client.username,
            capabilities: payload.capabilities,
          }),
        ),
      );
    }

    // ═════════════════════════════════════════════════════════
    // v1.9.x daemon protocol handlers (Track C m2)
    //
    // Auth note: m2 still uses the JWT path; daemons authenticate over WS
    // with API key in m3 (extending tryAuthenticate for `sk-prismer-`
    // tokens). For now `client.userId` is the cloud user — for declared
    // agents we trust the daemon's claim that they're hosted by this user
    // and rely on Track A's PATCH /agents/:id ACL elsewhere to keep the
    // IMAgentCard.imUserId ↔ owner relationship clean.
    // ═════════════════════════════════════════════════════════

    /**
     * Handshake message after a daemon WS connects. Reconciles the IMAgent
     * cards (status='online' for declared, 'offline' for cloud-known but
     * not declared), computes which AgentProfiles are stale on the daemon,
     * and replies with `host.acked`. Then triggers a re-dispatch of any
     * tasks that were pending while the daemon was offline.
     */
    async function handleAgentHostDeclare(payload: AgentHostDeclarePayload, requestId?: string) {
      if (!client) return;

      const userId = client.userId;

      // Resolve the connected human's cloud-user link so we can verify
      // ownership of declared agents. Both human IMUser and its agent
      // IMUsers share `userId` field (= cloud pc_users.id as string).
      const owner = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { userId: true, numericId: true, role: true },
      });
      if (!owner) {
        ws.send(JSON.stringify(ServerEvents.error('Connected user not found', 'NO_USER', requestId)));
        return;
      }

      // Resolve workspace before accepting the daemon declaration. A local
      // daemon forgotten from this workspace must not register shadow routes,
      // stamp agent metadata, or refresh runtime presence.
      const workspace = await prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: userId, isDefault: true, deletedAt: null },
        select: { id: true, updatedAt: true, metadata: true },
      });
      const workspaceId = workspace?.id ?? '';
      if (workspace && isDaemonForgotten(workspace.metadata, payload.daemonId)) {
        for (const shadow of shadowClients) rooms.removeClient(shadow);
        shadowClients.length = 0;
        declaredAgents.clear();
        declaredDaemonId = null;
        declaredWorkspaceId = null;
        log.warn({ workspaceId, daemonId: payload.daemonId }, 'agent.host.declare rejected for forgotten daemon');
        ws.send(JSON.stringify(ServerEvents.error('Daemon forgotten from workspace', 'DAEMON_FORGOTTEN', requestId)));
        return;
      }

      // Verify each declared agent IMUser belongs to the same cloud user
      // and is role='agent'. Invalid/stale local rows are ignored one by
      // one: a daemon may have old local SQLite rows from another account,
      // but that must not prevent the physical device from declaring online
      // for its current API-key owner. A fresh daemon also legitimately
      // declares zero agents before the workspace installs the first one.
      const candidateIds = payload.agents.map((a) => a.imUserId);
      const verifiedAgents = await prisma.iMUser.findMany({
        where: { id: { in: candidateIds }, role: 'agent' },
        select: { id: true, userId: true },
      });
      type VerifiedAgent = (typeof verifiedAgents)[number];
      const verifiedById = new Map<string, VerifiedAgent>(verifiedAgents.map((a: VerifiedAgent) => [a.id, a]));
      const rejectedAgents: NonNullable<HostAckedPayload['rejectedAgents']> = [];
      // release202/08 — numericId-aware ownership match (same bug class as
      // register.ts). The human owner and a register-created agent do NOT
      // always share the same `userId` field value: api-key register sets the
      // agent's `userId = cloudUserId` (= numericId string), while the human
      // owner may carry userId=null and only `numericId` set. So compare the
      // agent's userId against the owner's identity SET {userId, numericId}.
      const ownerKeys = ownerIdentityKeys(owner);
      const ownedAgents = payload.agents.filter((candidate) => {
        const v = verifiedById.get(candidate.imUserId);
        if (!v || !v.userId || !ownerKeys.has(v.userId)) {
          console.warn(
            `[WS] Ignoring host declaration for agent ${candidate.imUserId} not owned by user ${owner.userId ?? owner.numericId}`,
          );
          rejectedAgents.push({ imUserId: candidate.imUserId, reason: 'not-owned' });
          return false;
        }
        return true;
      });
      const cards = await prisma.iMAgentCard.findMany({
        where: { imUserId: { in: ownedAgents.map((a) => a.imUserId) } },
        select: { imUserId: true, metadata: true },
      });
      type AgentCardBinding = { imUserId: string; metadata: string };
      const cardByAgentId = new Map(
        (cards as AgentCardBinding[]).map((card: AgentCardBinding) => [card.imUserId, card]),
      );

      // v2.0 §4.8.2 (Wave 2-B2) — consult IMAgentBinding (im_agent_bindings)
      // for ownership decisions. Replaces the old silent-reject branch that
      // dropped contested agents (the smoking-gun fix from §1.5 jasonzhou
      // production case). Three outcomes per agent:
      //   created   — first-ever declare for this agent → bound
      //   refreshed — same daemon re-declaring → lastHostDeclareAt updated
      //   contested — different daemon → row stays with current owner, but
      //               contestedSince + contestCount marker + sync event
      //               'agent.binding.contested' flow to the user UI. The
      //               contender does NOT win dispatch until the user issues
      //               POST /agent-bindings/:agentImUserId/rebind.
      const declaredDaemonKind: 'k8s' | 'local' | 'edge' =
        payload.daemonKind ?? (payload.daemonId.startsWith('daemon-') ? 'local' : 'k8s');
      const declaredDaemonLabel =
        payload.daemonLabel?.trim() ||
        (payload.daemonId.startsWith('daemon-') ? payload.daemonId.slice('daemon-'.length) : payload.daemonId);

      const validAgents: typeof ownedAgents = [];
      const contestedAgents: { imUserId: string; ownerDaemonId: string; contestCount: number }[] = [];
      for (const candidate of ownedAgents) {
        if (pendingRejectedAgents.has(candidate.imUserId)) {
          rejectedAgents.push({
            imUserId: candidate.imUserId,
            reason: 'bound-to-other-daemon',
          });
          await agentBindingService.clearContestMarker(candidate.imUserId, userId, 'rejected-daemon-redeclare');
          continue;
        }
        try {
          const decision = await agentBindingService.handleHostDeclare({
            agentImUserId: candidate.imUserId,
            daemonId: payload.daemonId,
            daemonKind: declaredDaemonKind,
            daemonLabel: declaredDaemonLabel,
            ownerImUserId: userId,
          });
          if (decision.outcome === 'contested') {
            contestedAgents.push({
              imUserId: candidate.imUserId,
              ownerDaemonId: decision.ownerDaemonId,
              contestCount: decision.contestCount,
            });
            rejectedAgents.push({
              imUserId: candidate.imUserId,
              reason: 'bound-to-other-daemon',
              ownerDaemonId: decision.ownerDaemonId,
            });
            console.warn(
              `[WS] agent.binding.contested agent=${candidate.imUserId} contender=${payload.daemonId} owner=${decision.ownerDaemonId} count=${decision.contestCount} — silent reject replaced with marker + sync event`,
            );
            continue;
          }
          validAgents.push(candidate);
        } catch (err) {
          // Binding service failure should NOT lose the entire declare.
          // Fall back to the legacy metadata-derived check so a transient
          // DB blip on im_agent_bindings does not break online presence.
          const card = cardByAgentId.get(candidate.imUserId);
          let metadata: Record<string, unknown> = {};
          try {
            metadata = card?.metadata ? (JSON.parse(card.metadata) as Record<string, unknown>) : {};
          } catch {
            metadata = {};
          }
          const boundDaemonId = typeof metadata.daemonId === 'string' ? metadata.daemonId.trim() : '';
          if (boundDaemonId && boundDaemonId !== payload.daemonId) {
            console.warn(
              `[WS] (fallback) Ignoring host declaration for agent ${candidate.imUserId} on ${payload.daemonId}; bound to ${boundDaemonId} (binding service err: ${(err as Error).message})`,
            );
            rejectedAgents.push({
              imUserId: candidate.imUserId,
              reason: 'bound-to-other-daemon',
              ownerDaemonId: boundDaemonId,
            });
            continue;
          }
          validAgents.push(candidate);
          log.warn(
            { err, agentImUserId: candidate.imUserId, daemonId: payload.daemonId },
            'agent-binding service threw during host.declare — fell back to metadata-derived check',
          );
        }
      }

      if (contestedAgents.length > 0) {
        log.warn(
          {
            daemonId: payload.daemonId,
            contender: payload.daemonId,
            contestedCount: contestedAgents.length,
            agents: contestedAgents.map((c) => c.imUserId),
          },
          `agent.host.declare: ${contestedAgents.length} agent(s) contested — see im_agent_bindings + sync events`,
        );
      }

      const declaredAgentIds = new Set(validAgents.map((a) => a.imUserId));
      const acceptedAgents = Array.from(declaredAgentIds);
      const payloadAgentIds = new Set(payload.agents.map((a) => a.imUserId));
      const releasedRejectedAgents = Array.from(pendingRejectedAgents).filter((agentImUserId) => {
        return !payloadAgentIds.has(agentImUserId);
      });
      for (const agentImUserId of releasedRejectedAgents) {
        pendingRejectedAgents.delete(agentImUserId);
        await agentBindingService.clearContestMarker(agentImUserId, userId, 'rejected-daemon-stopped-declaring');
      }
      for (const rejected of rejectedAgents) {
        pendingRejectedAgents.add(rejected.imUserId);
      }

      // Stash on the connection so subsequent task.dispatch.* events can be
      // validated. Refresh-on-redeclare semantics — the latest declare wins.
      // Drop any prior shadow connections first; we'll add fresh ones below.
      for (const shadow of shadowClients) rooms.removeClient(shadow);
      shadowClients.length = 0;
      declaredAgents.clear();
      declaredDaemonId = payload.daemonId;
      declaredWorkspaceId = workspaceId || null;
      for (const id of declaredAgentIds) declaredAgents.add(id);

      const daemonShadow: ConnectedClient = {
        transport: client.transport,
        userId: daemonRouteKey(payload.daemonId),
        username: `daemon:${payload.daemonId}`,
        connectedAt: client.connectedAt,
      };
      rooms.addClient(daemonShadow);
      shadowClients.push(daemonShadow);

      // Register a shadow ConnectedClient under each declared agent's
      // imUserId so `rooms.sendToUser(agentImUserId, ...)` from
      // task.service reaches the same physical socket. Each shadow shares
      // the underlying transport. Auto-join each agent into the rooms it
      // participates in — without this, broadcastToRoom() never reaches
      // the daemon when a message arrives mentioning the agent.
      for (const agentId of declaredAgentIds) {
        const shadow: ConnectedClient = {
          transport: client.transport,
          userId: agentId,
          username: `agent:${agentId}`,
          connectedAt: client.connectedAt,
        };
        rooms.addClient(shadow);
        shadowClients.push(shadow);
        try {
          const parts = await conversationService.listByUser(agentId);
          for (const p of parts) {
            rooms.joinRoom(p.conversation.id, agentId);
          }
        } catch (err) {
          // Roll back the shadow registration on auto-join failure. Otherwise
          // the shadow lives in `rooms.clients[agentId]` (sendToUser keeps
          // working) but never appears in any room (broadcastToRoom can't
          // reach it). That asymmetry is the worst diagnostic shape: tasks
          // dispatch fine, group @-mentions never land.
          rooms.removeClient(shadow);
          shadowClients.pop();
          declaredAgents.delete(agentId);
          const errMsg = (err as Error).message;
          log.error(
            { err, agentId, userId: client.userId },
            `shadow agent auto-join failed for ${agentId} (declare aborted): ${errMsg}`,
          );
          ws.send(
            JSON.stringify(
              ServerEvents.error(
                `auto-join failed for shadow agent ${agentId}: ${errMsg}`,
                'SHADOW_JOIN_FAILED',
                requestId,
              ),
            ),
          );
          return;
        }
      }

      // 1. Reconcile IMAgentCard status + stamp daemonId into metadata.
      // The runtime endpoint (`workspace-runtime.ts::buildSnapshot`) groups
      // agents under `metadata.daemonId` to render the LeftRail tree. Without
      // stamping here, daemon-declared agents land in the `__unbound__`
      // bucket forever — the daemon is correctly heartbeating but the UI
      // (and CHECKPOINTS §1.4 evidence) never shows the device.
      const newlyDeclared: { imUserId: string; runtimeInstallationId: string | null; agentLabel: string }[] = [];
      for (const declared of validAgents) {
        const card = await prisma.iMAgentCard
          .findFirst({
            where: { imUserId: declared.imUserId },
            select: { metadata: true, name: true, imUser: { select: { displayName: true, username: true } } },
          })
          .catch(() => null);

        let mergedMetadata: string | undefined;
        let isFirstDeclare = false;
        let runtimeInstallationId: string | null = null;
        if (card) {
          let meta: Record<string, unknown> = {};
          try {
            meta = card.metadata ? (JSON.parse(card.metadata) as Record<string, unknown>) : {};
          } catch {
            /* malformed metadata — restamp from scratch */
          }
          if (meta.daemonId !== payload.daemonId) {
            meta.daemonId = payload.daemonId;
            mergedMetadata = JSON.stringify(meta);
            // Wave-8 W9 — first declaration for this (agent, daemon) pair
            // (or after a re-stamp). Heartbeat redeclares (every 30s) skip
            // the metadata update and won't trigger this branch, so the
            // Bell row only fires on a genuine first declare.
            isFirstDeclare = true;
          }
          if (typeof meta.runtimeInstallationId === 'string') runtimeInstallationId = meta.runtimeInstallationId;
        }

        await prisma.iMAgentCard
          .updateMany({
            where: { imUserId: declared.imUserId },
            data: {
              status: 'online',
              lastHeartbeat: new Date(),
              ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
            },
          })
          .catch((err: unknown) =>
            console.warn('[WS] agent.host.declare update online failed:', (err as Error)?.message),
          );

        if (isFirstDeclare) {
          newlyDeclared.push({
            imUserId: declared.imUserId,
            runtimeInstallationId,
            agentLabel: card?.imUser?.displayName ?? card?.name ?? card?.imUser?.username ?? 'Hosted agent',
          });
        }
      }

      // (Wave-8 W9 emit happens once the workspace lookup completes a few
      // statements below — see `// 3. Resolve workspace`.)

      // 2. Compute profilesToSync — pure helper (see v19x-helpers.ts).
      const cloudProfiles = await prisma.iMAgentProfile.findMany({
        where: {
          agentImUserId: { in: Array.from(declaredAgentIds) },
          deletedAt: null,
        },
        select: { id: true, agentImUserId: true, version: true },
      });
      const profilesToSync = computeProfilesToSync(validAgents, cloudProfiles);

      // 2b. Compute profilesToDelete — profiles the daemon declared (cached
      // locally) that no longer exist as non-deleted rows on the cloud. These
      // are tombstones: the profile was soft-deleted while the daemon was
      // offline, so it missed the agent_profile.changed event. Returning them
      // lets the daemon purge dead profiles from its local SQLite store.
      const profilesToDelete = computeProfilesToDelete(validAgents, cloudProfiles);

      // 3. Resolve workspace — v1.9.x is 1:1 user ↔ default Personal
      // workspace; Track A's m1 backfill guarantees one exists for every
      // human user. Agents (role='agent') don't own workspaces; they live
      // inside their human owner's. The current WS connection is the
      // daemon authenticating as the cloud user (mapped to the human
      // imUserId), so look up by ownerImUserId === userId.
      // Wave-8 W9 — emit Bell notifications for first-time agent declarations
      // detected above. We defer until here because the emit needs the
      // resolved workspaceId (the Bell row carries it as the routing target).
      if (newlyDeclared.length > 0 && workspaceId) {
        try {
          const { emitRuntimeAgentDeclaredNotification } = await import('../../lib/notification-emitter');
          for (const declared of newlyDeclared) {
            if (!declared.runtimeInstallationId) continue; // pre-W5 daemons (no install metadata) — skip
            void emitRuntimeAgentDeclaredNotification({
              ownerImUserId: userId,
              workspaceId,
              runtimeInstallationId: declared.runtimeInstallationId,
              daemonId: payload.daemonId,
              agentImUserId: declared.imUserId,
              agentLabel: declared.agentLabel,
            });
          }
        } catch (err) {
          log.warn(
            { err, userId, agentCount: newlyDeclared.length },
            `runtime_agent_declared emit failed: ${(err as Error).message}`,
          );
        }
      }

      if (workspaceId) {
        if (!payload.daemonId) {
          log.warn({ workspaceId }, 'host.declare missing daemonId — skipping device presence + container upsert');
        } else {
          await deps.redis.sadd(`runtime:devices:${workspaceId}`, payload.daemonId).catch((err: unknown) => {
            log.warn({ err, workspaceId, daemonId: payload.daemonId }, 'runtime device presence set add failed');
          });
          // device name: strip "daemon-" prefix to show the hostname.
          const deviceName = payload.daemonId.startsWith('daemon-')
            ? payload.daemonId.slice('daemon-'.length)
            : payload.daemonId;
          const presencePayload = JSON.stringify({
            daemonId: payload.daemonId,
            deviceId: payload.daemonId,
            name: deviceName,
            lastSeenAt: Date.now(),
            hostedAgents: validAgents.length,
            daemonVersion: payload.daemonVersion ?? null,
          });
          const presenceKey = `runtime:device:${workspaceId}:${payload.daemonId}`;
          await deps.redis.set(presenceKey, presencePayload, 'EX', 90).catch((err: unknown) => {
            log.warn({ err, workspaceId, daemonId: payload.daemonId }, 'runtime device presence write failed');
          });

          // Upsert im_containers row so device capacity checks at agent.register
          // find this daemon (they query MySQL im_containers, not Redis).
          // Fire-and-forget: a failed upsert does NOT block the host.acked
          // reply — the daemon stays connected and Redis presence works. But
          // agent.register will fail with UNKNOWN_DAEMON if the row is absent,
          // so log at ERROR level when it happens.
          // agentImUserId is varchar(30) in MySQL; daemonId can be longer, so
          // we use the last 30 chars as the lookup key. register.ts matches
          // by BOTH agentImUserId AND daemonId (OR) so the full daemonId
          // column handles finding the device even with truncation.
          const containerImUserId = payload.daemonId.slice(-30);

          // Also store a presence key for the runtime-instance alias
          // (container:<agentImUserId>) so that agent.register which looks up
          // by container:xxx format can find this daemon.
          const aliasKey = `runtime:device:${workspaceId}:container:${containerImUserId}`;
          if (aliasKey !== presenceKey) {
            await deps.redis.set(aliasKey, presencePayload, 'EX', 90).catch(() => {
              /* best-effort alias key */
            });
          }

          const containerId = generateIMUserId('container');
          const now = new Date();

          // 2026-05-19 dup-row guard: if this daemonId is already represented
          // by a non-local IMContainer row (K8S sandbox provisioned via Pro
          // flow → /api/workspace/runtime-installations, which threads
          // PRISMER_DAEMON_ID env into the pod), the K8S row is the canonical
          // record. Skip the legacy `deviceType=local` upsert so we don't
          // end up with two rows for the same daemon — the bug surfaced as
          // "K8S device daemon offline" in the runtime-manager UI because
          // Redis presence was keyed once but matched the local row first.
          //
          // agent.register::lookup uses `OR: [{ agentImUserId }, { daemonId }]`
          // (src/im/api/register.ts:357) so the K8S row satisfies the
          // UNKNOWN_DAEMON gate without the local row.
          //
          // 2026-05-20 — DROPPED the `stoppedAt: null` constraint. Real bug
          // observed in test env: user creates K8S device → row created with
          // stoppedAt=null. Daemon boots, host.declare succeeds, K8S row
          // found. User clicks Delete → K8S row becomes stoppedAt=now. The
          // daemon process (or a leftover container/pod) re-emits host.declare
          // before WS closes → with the old filter `stoppedAt: null`, the K8S
          // row is no longer matched → fallthrough creates a `daemon:<short>`
          // local row with the same daemonId UUID → user sees TWO device
          // cards on next list. Matching on daemonId alone (ignoring stop
          // state) keeps the K8S row authoritative throughout its lifecycle.
          const k8sRow = await prisma.iMContainer.findFirst({
            where: {
              workspaceId,
              daemonId: payload.daemonId,
              deviceType: { not: 'local' },
            },
            select: { id: true, podName: true, deviceType: true, stoppedAt: true },
          });
          if (k8sRow) {
            log.info(
              {
                daemonId: payload.daemonId,
                workspaceId,
                k8sContainerId: k8sRow.id,
                k8sPodName: k8sRow.podName,
                k8sDeviceType: k8sRow.deviceType,
              },
              'host.declare: K8S container row exists for this daemon — skipping legacy local row upsert',
            );
          } else {
            await prisma.iMContainer
              .updateMany({
                where: {
                  workspaceId,
                  taskId: null,
                  deviceType: 'local',
                  daemonId: { not: payload.daemonId },
                  stoppedAt: null,
                },
                data: { status: 'stopped', stoppedAt: now },
              })
              .catch((err: unknown) => {
                log.warn(
                  { err, workspaceId, daemonId: payload.daemonId, msg: (err as Error).message },
                  'failed to stop superseded local daemon rows',
                );
              });
            await prisma.iMContainer
              .upsert({
                where: { podName: `daemon:${containerImUserId}` },
                create: {
                  id: containerId,
                  workspaceId,
                  tenantId: userId,
                  agentImUserId: containerImUserId,
                  podName: `daemon:${containerImUserId}`,
                  namespace: 'default',
                  image: 'prismer-daemon:local',
                  imageTag: 'local',
                  status: 'running',
                  runtimeKind: 'docker',
                  deviceType: 'local',
                  daemonId: payload.daemonId,
                  maxAgents: 10,
                  cpuRequest: '250m',
                  cpuLimit: '2000m',
                  memoryRequest: '2Gi',
                  memoryLimit: '4Gi',
                  startedAt: now,
                },
                update: {
                  status: 'running',
                  daemonId: payload.daemonId,
                  // Intentionally NOT updating startedAt — heartbeat redeclares
                  // (every 30s) must not reset the original boot timestamp.
                  stoppedAt: null,
                },
              })
              .catch((err: unknown) => {
                log.error(
                  { err, workspaceId, daemonId: payload.daemonId, msg: (err as Error).message },
                  'im_containers upsert failed — subsequent agent.register calls will fail with UNKNOWN_DAEMON',
                );
              });
          }
        }
      }

      // 4. ACK
      ws.send(
        JSON.stringify(
          ServerEvents.hostAcked(
            {
              workspaceId,
              syncCursor: {
                workspaces: workspace ? workspace.updatedAt.getTime() : 0,
                agent_profiles: 0, // Track A m2/m3 fills cursor semantics
              },
              profilesToSync,
              profilesToDelete,
              acceptedAgents,
              rejectedAgents,
            },
            requestId,
          ),
        ),
      );

      // 5. Re-dispatch tasks that accumulated while the daemon was offline.
      // Fire-and-forget — don't block the ACK reply on this. Only on the
      // FIRST declare for this WS connection: heartbeat redeclares fire
      // every 30s and re-emitting all pending tasks each time would (a)
      // dominate the WS and (b) collide with the daemon's per-taskId
      // dedupe map, which would itself slow-leak entries. Retry once on
      // transient DB blips.
      if (taskService && !didRedispatch) {
        didRedispatch = true;
        const tryRedispatch = async (attempt: number): Promise<void> => {
          try {
            await taskService.redispatchPending(userId);
          } catch (err) {
            const msg = (err as Error).message;
            if (attempt < 1) {
              log.warn({ err, userId, attempt: attempt + 1 }, `redispatchPending failed (retrying in 5s): ${msg}`);
              setTimeout(() => void tryRedispatch(attempt + 1), 5_000);
            } else {
              log.error(
                { err, userId },
                `redispatchPending FAILED after retries — pending tasks will wait for next reconnect: ${msg}`,
              );
            }
          }
        };
        void tryRedispatch(0);
      }

      console.log(
        `[WS] agent.host.declare from ${client.username}: ${validAgents.length}/${payload.agents.length} agents, ${profilesToSync.length} sync, ${profilesToDelete.length} delete`,
      );
    }

    /**
     * Daemon-emitted status change for a hosted agent. Updates the
     * IMAgentCard and broadcasts to the user's other WS connections (mobile
     * UI). Note: the broadcast goes to the **human owner's** imUserId so
     * mobile sees it; the daemon (which sent this) won't echo back because
     * it's keyed under the agent's imUserId, not the human's.
     */
    async function handleAgentStatusChanged(payload: AgentStatusChangedPayload) {
      if (!client) return;

      // Validate: the daemon can only change status of agents it declared
      // it hosts. Stops cross-tenant tampering.
      if (!declaredAgents.has(payload.agentImUserId)) {
        console.warn(`[WS] agent.status.changed for undeclared agent ${payload.agentImUserId} — ignored`);
        return;
      }

      // Update agent card.
      await prisma.iMAgentCard
        .updateMany({
          where: { imUserId: payload.agentImUserId },
          data: {
            status: payload.status,
            lastHeartbeat: new Date(),
          },
        })
        .catch((err: unknown) => console.warn('[WS] agent.status.changed update failed:', (err as Error)?.message));

      // Broadcast to the human owner's WS connections so mobile/web UI
      // refresh. We deliberately don't broadcastGlobal — see CLAUDE.md /
      // session-C-prompt §m2: must scope to user.
      rooms.sendToUser(client.userId, ServerEvents.agentStatusChanged(payload));
    }

    /**
     * Resolve the agent imUserId that owns a task and confirm the daemon
     * on this connection actually hosts it. Returns null on any mismatch
     * — caller should drop the message silently (daemon could be racing
     * with cancellation, no point shouting).
     */
    async function resolveDeclaredAssignee(taskId: string): Promise<string | null> {
      if (await isDeclaredDaemonForgotten()) {
        console.warn(
          `[WS] task.dispatch.* for task ${taskId} rejected — daemon ${declaredDaemonId ?? '(none)'} forgotten from workspace ${declaredWorkspaceId ?? '(unknown)'}`,
        );
        return null;
      }
      const task = await prisma.iMTask
        .findUnique({ where: { id: taskId }, select: { assigneeId: true } })
        .catch(() => null);
      if (!task?.assigneeId) return null;
      if (declaredAgents.has(task.assigneeId)) {
        return task.assigneeId;
      }
      if (
        await isDaemonAuthorizedForAgentBinding(
          prisma,
          task.assigneeId,
          declaredDaemonId,
          `task.dispatch.* for task ${taskId}`,
        )
      ) {
        return task.assigneeId;
      }
      {
        console.warn(
          `[WS] task.dispatch.* for task ${taskId} — assignee ${task.assigneeId} not bound to daemon ${declaredDaemonId ?? '(none)'}`,
        );
        return null;
      }
    }

    async function resolveDeclaredRun(taskId: string): Promise<{
      assigneeId: string;
      conversationId: string | null;
      metadata: string | null;
      sourceKind: string;
      source: 'task_run' | 'task';
    } | null> {
      // Primary lookup — IMTaskRun keyed by its own CUID. Many dispatch flows
      // create IMTaskRun rows whose id matches IMTask.id (legacy + some chat
      // mention paths); others mint a separate run id with `taskId=null`. The
      // wire-level `payload.taskId` always carries IMTask.id (see
      // v19x-helpers.buildTaskDispatchRequest L185), so this query misses
      // whenever the run row used a distinct id.
      const run = await prisma.iMTaskRun
        .findUnique({
          where: { id: taskId },
          select: { assigneeId: true, conversationId: true, metadata: true, sourceKind: true },
        })
        .catch(() => null);
      if (run?.assigneeId) {
        if (declaredAgents.has(run.assigneeId)) {
          return {
            assigneeId: run.assigneeId,
            conversationId: run.conversationId,
            metadata: run.metadata,
            sourceKind: run.sourceKind,
            source: 'task_run',
          };
        }
        if (
          await isDaemonAuthorizedForAgentBinding(
            prisma,
            run.assigneeId,
            declaredDaemonId,
            `task.dispatch.* for run ${taskId}`,
          )
        ) {
          return {
            assigneeId: run.assigneeId,
            conversationId: run.conversationId,
            metadata: run.metadata,
            sourceKind: run.sourceKind,
            source: 'task_run',
          };
        }
        console.warn(
          `[WS] task.dispatch.* for run ${taskId} — assignee ${run.assigneeId} not bound to daemon ${declaredDaemonId ?? '(none)'}`,
        );
        return null;
      }
      // 2026-05-24 fallback — IMTaskRun row missing. The dispatch wire
      // payload always uses IMTask.id, but several creation paths
      // (taskService.createTaskRun(null, ...) from chat @-mention) never
      // backfill a corresponding IMTaskRun row keyed by that id. Without
      // this fallback the entire reply branch silently no-ops, leaving the
      // agent's text + attachments stranded in IMTaskRun.output and never
      // appearing in chat. Reading IMTask directly recovers conversationId +
      // assigneeId so the same message-send path can run.
      const task = await prisma.iMTask
        .findUnique({
          where: { id: taskId },
          select: { assigneeId: true, conversationId: true, metadata: true },
        })
        .catch(() => null);
      if (!task?.assigneeId) {
        log.warn(
          { taskId, declaredDaemonId },
          'task.dispatch.reply: neither IMTaskRun nor IMTask resolved an assignee — message-post path skipped',
        );
        return null;
      }
      const taskAuthorized =
        declaredAgents.has(task.assigneeId) ||
        (await isDaemonAuthorizedForAgentBinding(
          prisma,
          task.assigneeId,
          declaredDaemonId,
          `task.dispatch.* for task ${taskId} (fallback)`,
        ));
      if (!taskAuthorized) {
        log.warn(
          { taskId, assigneeId: task.assigneeId, declaredDaemonId },
          'task.dispatch.reply IMTask fallback rejected — assignee not bound to declared daemon',
        );
        return null;
      }
      log.info(
        { taskId, assigneeId: task.assigneeId, conversationId: task.conversationId },
        'task.dispatch.reply: resolved via IMTask fallback (no matching IMTaskRun row)',
      );
      return {
        assigneeId: task.assigneeId,
        conversationId: task.conversationId,
        metadata: task.metadata,
        sourceKind: 'task_fallback',
        source: 'task',
      };
    }

    async function resolveRuntimeDaemon(taskId: string): Promise<string | null> {
      if (!declaredDaemonId) {
        console.warn(`[WS] runtime task.dispatch.* for task ${taskId} without declared daemon — ignored`);
        return null;
      }
      if (await isDeclaredDaemonForgotten()) {
        console.warn(
          `[WS] runtime task.dispatch.* for task ${taskId} rejected — daemon ${declaredDaemonId} forgotten from workspace ${declaredWorkspaceId ?? '(unknown)'}`,
        );
        return null;
      }
      const task = await prisma.iMTask
        .findUnique({ where: { id: taskId }, select: { runtimeRoute: true, metadata: true } })
        .catch(() => null);
      if (!task || task.runtimeRoute !== 'shell') return null;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(task.metadata ?? '{}') as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const execution =
        meta.execution && typeof meta.execution === 'object' && !Array.isArray(meta.execution)
          ? (meta.execution as Record<string, unknown>)
          : {};
      const targetDaemonId = typeof execution.targetDaemonId === 'string' ? execution.targetDaemonId : '';
      if (targetDaemonId !== declaredDaemonId) {
        console.warn(
          `[WS] runtime task.dispatch.* for task ${taskId} — daemon ${declaredDaemonId} does not match target ${targetDaemonId}`,
        );
        return null;
      }
      return declaredDaemonId;
    }

    async function isDeclaredDaemonForgotten(): Promise<boolean> {
      if (!declaredDaemonId || !declaredWorkspaceId) return false;
      const workspace = await prisma.iMWorkspace
        .findFirst({
          where: { id: declaredWorkspaceId, deletedAt: null },
          select: { metadata: true },
        })
        .catch(() => null);
      return workspace ? isDaemonForgotten(workspace.metadata, declaredDaemonId) : false;
    }

    /**
     * Daemon reports task progress. The numeric `progress` (0..1) and
     * `detail` ride along in `metadata` — `TaskProgressInput` only types
     * `message` and `metadata`, so we serialize the rest in there.
     */
    async function handleTaskDispatchProgress(payload: TaskDispatchProgressPayload) {
      if (!client || !taskService) return;
      const daemonId = await resolveRuntimeDaemon(payload.taskId);
      if (daemonId) {
        try {
          await taskService.reportRuntimeProgress(payload.taskId, daemonId, {
            message: payload.message,
            metadata: {
              progress: payload.progress,
              ...(payload.detail ?? {}),
            },
          });
        } catch (err) {
          console.warn('[WS] runtime task.dispatch.progress failed:', (err as Error).message);
        }
        return;
      }
      const agentId = await resolveDeclaredAssignee(payload.taskId);
      if (agentId) {
        try {
          await taskService.reportProgress(payload.taskId, agentId, {
            message: payload.message,
            metadata: {
              progress: payload.progress,
              ...(payload.detail ?? {}),
            },
          });
        } catch (err) {
          console.warn('[WS] task.dispatch.progress failed:', (err as Error).message);
        }
        return;
      }
      // Run-style chat dispatch path. Daemon protocol uses the same
      // task.dispatch.progress wire whether the dispatch came from a
      // board task or a run; the lookup falls through here when payload
      // .taskId names a run.id. Without this the typing-dot row in
      // im-channel.tsx never advances past 'assigned'.
      const run = await resolveDeclaredRun(payload.taskId);
      if (!run) return;
      try {
        await taskService.reportRunProgress(payload.taskId, run.assigneeId, {
          message: payload.message,
          progress: typeof payload.progress === 'number' ? payload.progress : null,
          detail: payload.detail,
        });
      } catch (err) {
        console.warn('[WS] run task.dispatch.progress failed:', (err as Error).message);
      }
    }

    /**
     * release201/26 §8 Phase 4 — daemon reports it could NOT resume an
     * interrupted run from its local checkpoint (kill -9 / crash / corrupt
     * checkpoint). We:
     *   1. mark `IMTaskRun.status='resume_failed'` (free-string column, no
     *      enum / migration — see schema.prisma:797) and stash the reason in
     *      `error` + `metadata.resumeFailedReason`,
     *   2. post a `system_event` message with `metadata.status='resume_failed'`
     *      so the conversation timeline strip renders "任务中断，点击重试",
     *   3. emit the `task_dispatch_resume_failed_total` metric (§9).
     *
     * Unlike `task.dispatch.reply { ok:false }` this is NOT a normal terminal
     * failure — the run never finished and there is no agent reply. We do NOT
     * call `updateTaskRun` (that publishes task.completed/failed SSE +
     * reconciles the board projection as a terminal state); resume_failed is a
     * retryable non-terminal interruption, so we write the run row + the
     * status-event message directly.
     *
     * Auth: daemon ownership is validated via `resolveDeclaredRun` keyed by
     * `payload.runId` (the IMTaskRun.id). Unowned / unknown runs are dropped
     * with a warn (graceful — never throws).
     */
    async function handleTaskDispatchResumeFailed(payload: TaskDispatchResumeFailedPayload) {
      log.info(
        { metric: 'task_dispatch_resume_failed_total', runId: payload?.runId, taskId: payload?.taskId },
        `[WS] task.dispatch.resume_failed run=${payload?.runId ?? '(none)'} reason=${payload?.reason ?? ''}`,
      );
      if (!client || !taskService) {
        console.warn(`[WS] task.dispatch.resume_failed skipped: client=${!!client} taskService=${!!taskService}`);
        return;
      }
      const runId = typeof payload?.runId === 'string' ? payload.runId : '';
      if (!runId) {
        console.warn('[WS] task.dispatch.resume_failed missing runId');
        return;
      }
      // resolveDeclaredRun looks up IMTaskRun by id and validates the run's
      // assignee is bound to this declared daemon (same guard as the other
      // task.dispatch.* handlers). resume_failed always carries the run id.
      const run = await resolveDeclaredRun(runId);
      if (!run) {
        console.warn(
          `[WS] task.dispatch.resume_failed: run ${runId} not resolved / not owned by daemon ${declaredDaemonId ?? '(none)'} — dropped`,
        );
        return;
      }
      const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : 'resume_failed';
      await applyResumeFailed({
        prisma,
        messageService,
        runId,
        taskId: payload.taskId,
        reason,
        run,
      });
    }

    /**
     * Daemon reports a per-task phase heartbeat (v2.0 §4.2 Track B-1).
     *
     * Distinct from `agent.heartbeat` (process liveness) — this is a fine-
     * grained "I'm still actively working on task X, currently in phase Y"
     * signal pushed every ~15s while the task runs. The cloud-side reaper
     * (`SchedulerService.sweepStuckPhases`) writes `currentPhase='stuck'`
     * when 45s of silence elapses; this handler clears that marker when
     * the daemon resumes.
     *
     * Auth: must come from a declared daemon WS connection. We reuse the
     * existing daemon-owner resolvers (`resolveRuntimeDaemon` and
     * `resolveDeclaredAssignee`) so unowned reports are silently dropped —
     * matching the behavior of `task.dispatch.*`.
     *
     * Per §12.4 contract, this handler NEVER updates the `status` column.
     * It only writes the phase signal triple
     * (`lastHeartbeatAt`/`heartbeatVersion`/`currentPhase`).
     */
    async function handleTaskHeartbeat(payload: TaskHeartbeatPayload) {
      if (!client || !taskService) return;
      if (!payload?.taskId || typeof payload.taskId !== 'string') {
        console.warn('[WS] task.heartbeat missing taskId');
        return;
      }
      if (typeof payload.currentPhase !== 'string' || payload.currentPhase.length === 0) {
        console.warn(`[WS] task.heartbeat ${payload.taskId} missing currentPhase`);
        return;
      }
      if (typeof payload.heartbeatVersion !== 'number' || !Number.isFinite(payload.heartbeatVersion)) {
        console.warn(`[WS] task.heartbeat ${payload.taskId} missing heartbeatVersion`);
        return;
      }

      // Validate sender owns the task. Try runtime daemon first (shell-
      // route), then declared agent assignee (agent-route). Either branch
      // returning null means "this WS connection is not authoritative for
      // this task" and we silently no-op (consistent with task.dispatch.*).
      const runtimeDaemon = await resolveRuntimeDaemon(payload.taskId);
      if (!runtimeDaemon) {
        const assignee = await resolveDeclaredAssignee(payload.taskId);
        if (!assignee) {
          console.warn(`[WS] task.heartbeat ${payload.taskId} — sender not authorized (no runtime/assignee binding)`);
          return;
        }
      }

      try {
        const lastStepAt =
          typeof payload.lastStepAt === 'number'
            ? new Date(payload.lastStepAt)
            : typeof payload.lastStepAt === 'string'
              ? new Date(payload.lastStepAt)
              : undefined;
        await taskService.recordTaskHeartbeat(payload.taskId, {
          heartbeatVersion: payload.heartbeatVersion,
          currentPhase: payload.currentPhase,
          lastStepAt,
        });
      } catch (err) {
        console.warn('[WS] task.heartbeat persist failed:', (err as Error).message);
      }
    }

    /**
     * Daemon reports a per-task observable step (v2.0 §4.4 Wave 3.5 W4-P4a).
     *
     * Wire (from `sdk/prismer-cloud/runtime/src/daemon/step-recorder.ts`):
     *   `{ taskRunId, step: { seq, kind, payload, occurredAt, durationMs? } }`
     *
     * Server-side responsibility:
     *   1. Resolve the IMTaskRun row — must exist (otherwise the daemon is
     *      reporting on an orphan; silently drop).
     *   2. Ownership: the WS sender must be the run.assigneeId OR the
     *      daemon that owns the agent (existing `declaredAgents` /
     *      `daemonId` binding rules from B3's task.heartbeat). We reuse
     *      the same authorisation surface as task.heartbeat so a daemon
     *      that's authoritative for the run can push BOTH signals on the
     *      same socket.
     *   3. Persist via TaskStepRecorderService — deterministic id ⇒
     *      idempotent under daemon reconnect re-send.
     *   4. Recorder emits `task.step.appended` IMSyncEvent on new rows
     *      (skipped for duplicates).
     *
     * Distinct from task.heartbeat: heartbeat = "I'm alive, current
     * phase=X", step = "here is what I just did (tool call, reasoning,
     * phase transition)". Heartbeat is volatile (only the latest matters);
     * steps are durable timeline.
     */
    async function handleTaskStepAppend(payload: TaskStepAppendPayload) {
      if (!client) return;
      if (!payload?.taskRunId || typeof payload.taskRunId !== 'string') {
        console.warn('[WS] task.step.append missing taskRunId');
        return;
      }
      const step = payload.step;
      if (!step || typeof step !== 'object') {
        console.warn(`[WS] task.step.append ${payload.taskRunId} missing step`);
        return;
      }
      if (typeof step.seq !== 'number' || !Number.isFinite(step.seq) || step.seq < 1) {
        console.warn(`[WS] task.step.append ${payload.taskRunId} invalid step.seq=${step.seq}`);
        return;
      }
      if (typeof step.kind !== 'string' || step.kind.length === 0) {
        console.warn(`[WS] task.step.append ${payload.taskRunId} missing step.kind`);
        return;
      }

      // Resolve the run. Distinct from task.heartbeat which keys by taskId
      // — steps are per-RUN so a single task with multiple retries gets
      // segregated timelines (matches IMTaskRun.id PK semantics).
      const run = await taskStepRecorder.resolveRun(payload.taskRunId);
      if (!run) {
        console.warn(`[WS] task.step.append ${payload.taskRunId} — run not found`);
        return;
      }

      // Ownership: sender must own the run. Three accepted paths:
      //   (a) sender_userId === run.assigneeId — direct ownership (mobile
      //       app uploading its own LLM steps, test driver in this suite).
      //   (b) sender declared this agent via agent.host.declare — the
      //       daemon path. `declaredAgents` is the shadow-route registry.
      //   (c) sender's declared daemonId matches im_agent_bindings
      //       boundDaemonId; legacy metadata.daemonId is only used when the
      //       binding row is missing or the binding lookup fails.
      //   (d) Fallback: `resolveRuntimeDaemon(taskId)` matches — runtime
      //       route='shell' case where the daemon owns the task without
      //       per-agent binding.
      let authorized = false;
      if (run.assigneeId && run.assigneeId === client.userId) authorized = true;
      if (!authorized && run.assigneeId && declaredAgents.has(run.assigneeId)) authorized = true;
      if (!authorized && declaredDaemonId && run.assigneeId) {
        authorized = await isDaemonAuthorizedForAgentBinding(
          prisma,
          run.assigneeId,
          declaredDaemonId,
          `task.step.append ${payload.taskRunId}`,
        );
      }
      if (!authorized && run.taskId) {
        // Fall back to the task-level resolver (handles runtime-route='shell'
        // where the daemon owns the task without per-agent binding).
        const fallback = await resolveRuntimeDaemon(run.taskId);
        if (fallback) authorized = true;
      }
      if (!authorized) {
        console.warn(
          `[WS] task.step.append ${payload.taskRunId} — sender not authorized (assignee=${run.assigneeId ?? 'none'} declaredDaemon=${declaredDaemonId ?? 'none'})`,
        );
        return;
      }

      // taskRun.taskId may be null (legacy run without parent task). The
      // recorder requires a taskId; in that case use the runId as a stand-in
      // so the row's task_occurred_idx still has a stable key.
      const taskId = run.taskId ?? run.id;

      try {
        await taskStepRecorder.recordStep(
          payload.taskRunId,
          taskId,
          {
            seq: step.seq,
            kind: step.kind,
            payload: (step.payload ?? {}) as Record<string, unknown>,
            occurredAt: step.occurredAt,
            durationMs: typeof step.durationMs === 'number' ? step.durationMs : null,
          },
          {
            conversationId: run.conversationId ?? null,
            // Default recipient is the human creator so a single-recipient
            // event still surfaces in their sync stream. Conversation
            // participants get fan-out via SyncPublisher.publishPending.
            recipientImUserId: run.creatorId ?? run.assigneeId ?? client.userId,
          },
        );
      } catch (err) {
        console.warn(`[WS] task.step.append ${payload.taskRunId} persist failed:`, (err as Error).message);
      }
    }

    /**
     * Daemon reports task completion. Success → completeTask; failure →
     * failTask. Error code / assetIds ride in metadata since the
     * TaskCompleteInput / TaskFailInput shapes don't have first-class
     * fields for them.
     */
    async function handleTaskDispatchReply(payload: TaskDispatchReplyPayload, requestId?: string) {
      // v2.0 (A5) — requestId was previously underscored (`_requestId`) and
      // silently dropped. Log it so we can correlate daemon-side dispatch
      // logs with the originating cloud envelope. Correlation logic (e.g.
      // resolving back to the originating request, deduping duplicate
      // replies) is intentionally deferred to v2.1+ — this fix just stops
      // the silent discard.
      console.log(
        `[WS] task.dispatch.reply task=${payload.taskId} ok=${payload.ok} outputLen=${payload.output?.length ?? 0}${requestId ? ` requestId=${requestId}` : ''}`,
      );
      if (!client || !taskService) {
        console.warn(`[WS] task.dispatch.reply skipped: client=${!!client} taskService=${!!taskService}`);
        return;
      }
      // P1-2 (2026-05-25): persist daemon-reported outbox MIME-mismatch
      // rejections onto the task's metadata so the next dispatch's prompt
      // can warn the agent. Done BEFORE branching into runtime/declared/
      // fallback paths so the persistence is universal (rejection feedback
      // matters regardless of which dispatch path settled the task). REPLACE
      // semantics — fresh reply overwrites prior rejection set; see
      // mergeOutboxRejectionsIntoTask for the rationale.
      if (Array.isArray(payload.outboxRejections) && payload.outboxRejections.length > 0) {
        await mergeOutboxRejectionsIntoTask(payload.taskId, payload.outboxRejections);
      }
      const daemonId = await resolveRuntimeDaemon(payload.taskId);
      if (daemonId) {
        try {
          if (payload.ok) {
            await taskService.completeRuntimeTask(payload.taskId, daemonId, {
              result: {
                output: payload.output,
                assetIds: payload.assetIds,
                metrics: payload.metrics,
              },
            });
          } else {
            await taskService.failRuntimeTask(payload.taskId, daemonId, {
              error: payload.error?.message ?? 'unknown',
              result:
                payload.output !== undefined
                  ? {
                      output: payload.output,
                      assetIds: payload.assetIds,
                      metrics: payload.metrics,
                    }
                  : undefined,
              metadata: {
                errorCode: payload.error?.code,
              },
            });
          }
        } catch (err) {
          console.warn('[WS] runtime task.dispatch.reply failed:', (err as Error).message);
        }
        return;
      }
      const run = await resolveDeclaredRun(payload.taskId);
      log.info(
        {
          taskId: payload.taskId,
          ok: payload.ok,
          outputLen: payload.output?.length ?? 0,
          assetCount: payload.assetIds?.length ?? 0,
          runResolved: !!run,
          runSource: run?.source ?? null,
          conversationId: run?.conversationId ?? null,
        },
        'task.dispatch.reply: declared-path resolution',
      );
      if (run) {
        try {
          if (payload.ok) {
            await taskService.updateTaskRun(payload.taskId, run.assigneeId, {
              status: 'completed',
              output: {
                output: payload.output,
                assetIds: payload.assetIds,
                metrics: payload.metrics,
              },
            });

            const rawOutput = (payload.output ?? '').trim();
            const attachments = await buildAgentReplyAttachments(payload.assetIds);

            // 2026-05-31 release201/30 §8 — lie-detector 降级为 warn-only telemetry.
            //
            // 既然 `cloud file send` CLI 现在会把源文件 cp 进 PRISMER_ARTIFACTS_DIR
            // （release202/04;旧 PRISMER_OUTBOX_DIR 仍兼容；typescript SDK §6）+
            // cloud message handler 会 dual-write attachments[]
            // （message.service.ts §7），`claimedFile && !hasRealAsset` 的真实
            // false-positive 大幅下降。但保留 detect 函数 + LIE_PATTERNS 作为兜底
            // telemetry — 如果还有 disagreement，记录足够字段供后续追溯，
            // **不再触发 UI banner / systemFlags.lie_intercepted / lifecycle=failed**。
            //
            // 原 2026-05-29 注释（systemFlags=['lie_intercepted'] + UI banner）
            // 已废止；旧 doc 21 §lie-detector 同步 DEPRECATED。
            const hasRealAsset = attachments != null && attachments.length > 0;
            const claimedFile = detectAgentFileClaim(rawOutput);
            const claimAssetDisagreement = claimedFile && !hasRealAsset;
            const output = rawOutput;
            if (claimAssetDisagreement) {
              log.warn(
                {
                  dispatchId: payload.taskId,
                  agentImUserId: run.assigneeId,
                  sample: rawOutput.slice(0, 200),
                  declaredAssetIds: payload.assetIds ?? [],
                  attachmentsResolved: attachments?.length ?? 0,
                },
                '[dispatch.reply] claim/asset disagreement (warn-only, see release201/30 §8 — telemetry only, no UI flag)',
              );
            }

            // P0-1 (2026-05-25): mirror the resolved assetIds into the
            // task's metadata so the kanban TaskCard's paperclip badge +
            // any downstream consumer that re-reads `task.metadata.assets.
            // linkedAssetIds` (e.g. `task.service.resolveAssetRefs` on the
            // next dispatch) sees them. Only fires when attachments
            // actually resolved — otherwise the daemon-reported ids are
            // unverified and the invariant_violation branch below handles
            // the chat-side warning.
            if (attachments && attachments.length > 0) {
              await mergeLinkedAssetIdsIntoTask(payload.taskId, payload.assetIds);
            }
            // 2026-05-24 — assetId mismatch invariant (P0-2). When daemon
            // sends N assetIds but buildAgentReplyAttachments returns 0/undef,
            // the row(s) either weren't committed yet (race) or were never
            // minted (artifacts-watcher gap / asset-cache ingest failure). The
            // text-only reply still goes through below, but the user has no
            // way to know "agent claims to have written 3 files but I see
            // none" — surface a calm warning chip into chat AND log.error
            // for admin/CI invariant tripwire.
            if (Array.isArray(payload.assetIds) && payload.assetIds.length > 0 && !attachments) {
              log.error(
                {
                  invariant: 'asset_ids_unresolved',
                  taskId: payload.taskId,
                  assetIds: payload.assetIds,
                  conversationId: run.conversationId,
                },
                'task.dispatch.reply invariant: daemon reported asset ids but none resolved to IMAsset rows',
              );
              if (run.conversationId && messageService) {
                try {
                  await messageService.send({
                    conversationId: run.conversationId,
                    senderId: run.assigneeId,
                    type: 'system_event',
                    content: `⚠ Agent 报告了 ${payload.assetIds.length} 个产物但 cloud 未收到记录,可能是 outbox-ingest 链路异常。已记录原始 assetIds=${payload.assetIds.slice(0, 5).join(',')} 至日志,可用 \`scripts/debug/task-trace.ts ${payload.taskId}\` 追溯。`,
                    metadata: {
                      kind: 'invariant_violation',
                      invariant: 'asset_ids_unresolved',
                      taskId: payload.taskId,
                      assetIds: payload.assetIds,
                    },
                  });
                } catch (writeErr) {
                  log.warn(
                    { err: writeErr, taskId: payload.taskId },
                    'asset_ids_unresolved system_event post failed (chat surface skipped)',
                  );
                }
              }
            }
            // Post when EITHER text or attachments are present. File-only
            // replies ("send the report to me" → daemon-collected files,
            // empty text) used to be silently dropped because the legacy
            // gate only checked `output`.
            if (run.conversationId && (output || attachments) && messageService) {
              let triggerMessageId: string | undefined;
              let runHopCount: number | undefined;
              let runConversationType: 'direct' | 'group' | undefined;
              // Sequential @-mention cursor (v1.9.x). When a single human
              // message @-mentions multiple agents (`@A @B X`), the dispatch
              // path sends only to A and stamps the rest into
              // `run.metadata.pendingMentionTargets`. We pop the head off
              // here AFTER A's reply is posted, then dispatch the next
              // target using the just-posted reply as its trigger — so B
              // sees A's response as context. See
              // message.service.ts §dispatchPendingMention.
              let pendingMentionTargets: string[] = [];
              // Chain-wide de-dupe set: every agent already dispatched/queued in
              // this mention chain. Admits only NEW @mentions an agent introduces
              // in its reply (echoes coalesce away); bounds each agent to one
              // dispatch per chain.
              let chainMentionedUserIds: string[] = [];
              try {
                const meta = run.metadata ? (JSON.parse(run.metadata) as Record<string, unknown>) : {};
                triggerMessageId = typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : undefined;
                runHopCount =
                  typeof meta.hopCount === 'number' && Number.isFinite(meta.hopCount) ? meta.hopCount : undefined;
                runConversationType =
                  meta.conversationType === 'direct' || meta.conversationType === 'group'
                    ? meta.conversationType
                    : undefined;
                // Defensive: malformed metadata (not an array of strings)
                // → treat as empty, no fan-out. The chain terminates rather
                // than crashing the reply path.
                if (Array.isArray(meta.pendingMentionTargets)) {
                  pendingMentionTargets = meta.pendingMentionTargets.filter(
                    (v): v is string => typeof v === 'string' && v.length > 0,
                  );
                }
                if (Array.isArray(meta.chainMentionedUserIds)) {
                  chainMentionedUserIds = meta.chainMentionedUserIds.filter(
                    (v): v is string => typeof v === 'string' && v.length > 0,
                  );
                }
              } catch {
                triggerMessageId = undefined;
                runHopCount = undefined;
                runConversationType = undefined;
                pendingMentionTargets = [];
                chainMentionedUserIds = [];
              }
              // In-flight chains dispatched before this field existed (deploy
              // straddle): seed from the known cursor + self so echoes are still
              // suppressed and we never re-dispatch an already-queued target.
              if (chainMentionedUserIds.length === 0) {
                chainMentionedUserIds = [...pendingMentionTargets, run.assigneeId];
              }
              const replyMetadata: Record<string, unknown> = {
                kind: 'agent_reply',
                taskId: payload.taskId,
              };
              if (triggerMessageId) replyMetadata.triggerMessageId = triggerMessageId;
              if (attachments) replyMetadata.attachments = attachments;
              // 2026-05-31 release201/30 §8 — lie-detector 降级 warn-only。
              // 不再写 metadata.systemFlags = ['lie_intercepted'] / originalOutput /
              // lieReason，因此前端 InlineActivityStrip 不会再 surface 红色 banner。
              // disagreement 仍走上面的 log.warn telemetry（含 dispatchId / sample /
              // declaredAssetIds），可后台追溯。原 2026-05-28 (doc 21 §3.1) UI banner
              // 立场废止。
              // Propagate hopCount so downstream @-mentions in the reply
              // are bounded by MAX_AGENT_HOPS (see message.service.ts).
              if (typeof runHopCount === 'number') replyMetadata.hopCount = runHopCount;
              // Propagate conversationType so an @-mention in the reply
              // (e.g. agent → @other_agent) preserves the channel context
              // when it triggers the next dispatch hop.
              if (runConversationType) replyMetadata.conversationType = runConversationType;
              // NOTE: pendingMentionTargets is INTERNAL — never propagated
              // onto reply metadata. It lives only on task_run.metadata
              // and is consumed here in the WS handler.
              const replyResult = await messageService.send({
                conversationId: run.conversationId,
                senderId: run.assigneeId,
                type: 'text',
                content:
                  output ||
                  (attachments ? `📎 Sent ${attachments.length} file${attachments.length === 1 ? '' : 's'}` : ''),
                metadata: replyMetadata,
                attachments,
              });

              // 2026-05-28 (doc 21 §5.1) — emit dispatch.lifecycle so the
              // AgentStateStrip drops the agent's in-flight ring as soon
              // as the reply lands. `failed` covers the lie-guard
              // interception path; success path emits `completed`.
              if (deps.syncService) {
                void deps.syncService
                  .writeEvent(
                    'dispatch.lifecycle',
                    {
                      workspaceId: null,
                      conversationId: run.conversationId,
                      agentImUserId: run.assigneeId,
                      dispatchId: payload.taskId,
                      // 2026-05-31 release201/30 §8 — lifecycle 始终 'completed'，
                      // lie-detector 降级 warn-only 后不再以 disagreement 触发 failed。
                      lifecycle: 'completed',
                      occurredAt: Date.now(),
                    },
                    run.conversationId,
                    run.assigneeId,
                  )
                  .catch((err: Error) =>
                    log.warn(
                      { err, taskId: payload.taskId },
                      'dispatch.lifecycle(completed|failed) writeEvent failed (non-fatal)',
                    ),
                  );
              }

              // Admit NEW @mentions the agent introduced in THIS reply — the
              // delegation case (orchestrator → @engineer @marketer). Only
              // `explicit` routing (real @mentions) counts; `capability`/
              // `broadcast` (a reply that merely ends with "?") must NOT fan
              // out to everyone. Targets already in the chain are filtered, so
              // an echo of the original @a @b coalesces away (no ping-pong),
              // and self is filtered. This restores pre-2026-06-05 agent→agent
              // delegation that `88f47d55`'s `!isAgentReply` guard had fully
              // blocked, without reintroducing the double-dispatch the guard
              // was added to fix.
              const replyRouting = replyResult.routing;
              if (replyRouting?.mode === 'explicit') {
                const replyNewTargets = replyRouting.targets
                  .filter((t) => t.role === 'agent')
                  .map((t) => t.userId)
                  .filter((uid) => uid && uid !== run.assigneeId && !chainMentionedUserIds.includes(uid));
                if (replyNewTargets.length > 0) {
                  pendingMentionTargets = [...pendingMentionTargets, ...replyNewTargets];
                  chainMentionedUserIds = [...chainMentionedUserIds, ...replyNewTargets];
                }
              }

              // Sequential mention fan-out: dispatch the next target with
              // the just-posted reply as the trigger message. The new
              // task_run inherits one-shorter `pendingMentionTargets` so
              // the recursion bottoms out when the queue is exhausted.
              // hopCount increments — pending-mention fan-out is treated
              // as a hop just like a direct @-mention, so MAX_AGENT_HOPS
              // still caps the chain length.
              if (pendingMentionTargets.length > 0) {
                const [nextUserId, ...rest] = pendingMentionTargets;
                try {
                  const nextUser = await prisma.iMUser.findUnique({
                    where: { id: nextUserId },
                    select: { id: true, username: true, displayName: true, role: true, agentType: true },
                  });
                  if (nextUser) {
                    const nextHop = (runHopCount ?? 0) + 1;
                    // Defer to messageService for the actual dispatch so
                    // it reuses the same context-building + profile
                    // resolution as the initial @-mention path. The
                    // role-changed-between-dispatches edge case (e.g.
                    // agent demoted to human) is handled inside
                    // dispatchPendingMention — it logs and terminates
                    // the chain rather than fan out to a human target.
                    await messageService.dispatchPendingMention(
                      replyResult.message.id,
                      {
                        userId: nextUser.id,
                        username: nextUser.username,
                        displayName: nextUser.displayName,
                        role: nextUser.role,
                        agentType: nextUser.agentType ?? undefined,
                      },
                      rest,
                      nextHop,
                      runConversationType,
                      chainMentionedUserIds,
                    );
                  } else {
                    log.warn(
                      { taskId: payload.taskId, nextUserId },
                      `pending mention chain: target user ${nextUserId} not found — chain terminates`,
                    );
                  }
                } catch (chainErr) {
                  // Fan-out failure must not break the run-completion
                  // flow. Log so an operator can see why the chain
                  // stopped; the prior agents' replies are already in
                  // the conversation, so the user is not left in silence.
                  log.warn(
                    { err: chainErr, taskId: payload.taskId, nextUserId: pendingMentionTargets[0] },
                    `pending mention dispatch failed: ${(chainErr as Error).message}`,
                  );
                }
              }
            }
          } else {
            // 2026-05-22 (doc 12) — approval deadlock fix.
            //
            // When the daemon's hermes adapter observed an approval-request
            // MCP tool call before the reaper killed the run, it emits a
            // dispatch reply with `error.code === 'awaiting_human_approval'`.
            // Treat this as a non-terminal suspension, NOT a failure:
            //   - park the run at status='awaiting_approval' (new in v2.0
            //     TaskStatus union)
            //   - post a calm "⏳ waiting for human review" system_event
            //     instead of the red "⚠️ Agent failed" pill
            //   - do NOT emit task.failed downstream
            // When the human decides, task.service.ts
            // `applyApprovalDecisionAndRedispatch` resumes the run by
            // dispatching a fresh request labelled `approval.decided`.
            const isAwaitingApproval = payload.error?.code === 'awaiting_human_approval';
            // P2 (2026-05-24): daemon-side retry exhaustion. The daemon has
            // already attempted dispatch N=3 times with exponential backoff;
            // surface a dedicated chat message so the user sees "retried 3
            // times" rather than the raw last-attempt error.
            const isRetryExhausted = payload.error?.code === 'daemon_local_retry_exhausted';
            await taskService.updateTaskRun(payload.taskId, run.assigneeId, {
              status: isAwaitingApproval ? 'awaiting_approval' : 'failed',
              error: isAwaitingApproval ? undefined : (payload.error?.message ?? 'unknown'),
              metadata: { errorCode: payload.error?.code },
            });

            // 2026-05-28 (doc 21 §5.1) — emit dispatch.lifecycle 'failed'
            // so AgentStateStrip drops the in-flight ring. Awaiting
            // approval is NOT a terminal state, so suppress the signal —
            // the strip stays "active" with awaiting status carried by
            // the approval card. Reapply 'received' lifecycle happens
            // when applyApprovalDecisionAndRedispatch re-emits the
            // dispatch frame via emitDaemonDispatchRequest.
            if (!isAwaitingApproval && deps.syncService && run.conversationId) {
              void deps.syncService
                .writeEvent(
                  'dispatch.lifecycle',
                  {
                    workspaceId: null,
                    conversationId: run.conversationId,
                    agentImUserId: run.assigneeId,
                    dispatchId: payload.taskId,
                    lifecycle: 'failed',
                    errorCode: payload.error?.code ?? 'adapter_dispatch_failed',
                    occurredAt: Date.now(),
                  },
                  run.conversationId,
                  run.assigneeId,
                )
                .catch((err: Error) =>
                  log.warn({ err, taskId: payload.taskId }, 'dispatch.lifecycle(failed) writeEvent failed (non-fatal)'),
                );
            }
            // Why: without this, the UI shows a "thinking…" indicator that
            // simply disappears when the run fails — no error feedback to the
            // user, no way to know dispatch died. Surface the error as a
            // system_event message in the same conversation so the operator
            // sees adapter_dispatch_failed / task_cancelled / etc. and can
            // act. Posted as the agent itself so it threads with the chat.
            // Chat mentions are agent runs, not kanban tasks, so keep their
            // system-event kind separate from task_status_event.
            if (run.conversationId && messageService) {
              const errMsg = payload.error?.message ?? 'unknown error';
              const errCode = payload.error?.code ?? 'adapter_dispatch_failed';
              let triggerMessageId: string | undefined;
              try {
                const meta = run.metadata ? (JSON.parse(run.metadata) as Record<string, unknown>) : {};
                triggerMessageId = typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : undefined;
              } catch {
                triggerMessageId = undefined;
              }
              const isChatMention = run.sourceKind === 'chat_mention';

              // Bug 1(b) (2026-05-29) — when the daemon signals
              // `awaiting_human_approval`, the agent already submitted an
              // ApprovalRequest row via the MCP tool
              // `prismer.approval.request_human_approval` with its own
              // structured title + context + risk. The previous code path
              // ALSO minted a second row here with a template title
              // ("Approve: Agent xxxxxx 任务") and a template context
              // ("Agent requested human approval and is suspended pending
              // decision...") which is literally just the daemon's reply
              // error.message echoed back to the user. That violated
              // SKILL.md §Workflow #3 ("reason mandatory") and produced
              // duplicate cards (because the agent's row uses
              // category='general' and the fallback used 'agent_tool_call',
              // so intentHash dedup didn't collapse them).
              //
              // The right contract: cloud LOOKS UP the agent-submitted row
              // and only mints a fallback if the agent skipped the MCP
              // tool. The fallback warns explicitly (no fake reason
              // template) — the missing-reason case is itself a contract
              // violation worth surfacing, not papering over.
              let createdApprovalId: string | null = null;
              if (isAwaitingApproval && taskService) {
                try {
                  const approvalService = new ApprovalService({
                    rooms: deps.rooms,
                    taskService,
                  });
                  const taskRow = await prisma.iMTask
                    .findUnique({
                      where: { id: payload.taskId },
                      select: { title: true, workspaceId: true },
                    })
                    .catch(() => null);

                  // Lookup: agent-submitted pending approvals for this run.
                  // listApprovals runs ACL through the actor (the agent's
                  // imUserId, who can always see their own submitted
                  // approvals). If we find one, reuse it.
                  const existingAgentSubmitted = await approvalService
                    .listApprovals(run.assigneeId, {
                      taskId: payload.taskId,
                      status: 'pending',
                      limit: 5,
                    })
                    .catch(() => [] as Awaited<ReturnType<ApprovalService['listApprovals']>>);

                  if (existingAgentSubmitted.length > 0) {
                    // Agent already wrote a real ApprovalRequest with its
                    // own reason / context / options via the MCP tool.
                    // Reuse the earliest one — that's the user-visible
                    // card; no duplicate mint.
                    const earliest = existingAgentSubmitted.reduce(
                      (acc, cur) =>
                        Date.parse(
                          cur.createdAt instanceof Date ? cur.createdAt.toISOString() : String(cur.createdAt),
                        ) <
                        Date.parse(acc.createdAt instanceof Date ? acc.createdAt.toISOString() : String(acc.createdAt))
                          ? cur
                          : acc,
                      existingAgentSubmitted[0],
                    );
                    createdApprovalId = earliest.id;
                  } else {
                    // Agent flagged `approvalRequested` in the SSE stream
                    // but didn't actually call the MCP tool — this is a
                    // malformed contract. Surface the issue honestly
                    // instead of fabricating a reason: the title says
                    // "missing reason", the context names the contract
                    // violation explicitly, so the human reviewer sees
                    // there's no real "why" attached and the agent gets
                    // a debuggable signal.
                    const titleSeed =
                      taskRow?.title && taskRow.title.trim().length > 0
                        ? taskRow.title.trim().slice(0, 80)
                        : `Agent ${run.assigneeId.slice(-6)} task`;
                    const approval = await approvalService.createApproval(run.assigneeId, {
                      workspaceId: taskRow?.workspaceId ?? undefined,
                      conversationId: run.conversationId,
                      taskId: payload.taskId,
                      category: 'agent_tool_call',
                      title: `Approve (missing reason): ${titleSeed}`,
                      context:
                        'Agent paused itself awaiting approval but did NOT call ' +
                        '`prismer.approval.request_human_approval` with a reason / risk / context. ' +
                        'This is a SKILL.md contract violation — review with caution; reject and ' +
                        'ask the agent to re-submit with a real explanation.',
                      options: [
                        { value: 'approve', label: '批准' },
                        { value: 'reject', label: '拒绝' },
                      ],
                      metadata: {
                        taskRunId: payload.taskId,
                        triggerMessageId,
                        source: 'dispatch_reply_awaiting_human_approval_fallback_no_mcp_submission',
                      },
                    });
                    createdApprovalId = approval.id;
                  }
                } catch (apprErr) {
                  log.warn(
                    { err: apprErr, taskId: payload.taskId },
                    'awaiting_human_approval: approval lookup/createApproval failed — user will see only the system_event pill',
                  );
                }
              }

              try {
                await messageService.send({
                  conversationId: run.conversationId,
                  senderId: run.assigneeId,
                  type: 'system_event',
                  content: isAwaitingApproval
                    ? '⏳ Waiting for human approval'
                    : isRetryExhausted
                      ? `⚠ Agent 已重试 3 次仍失败: ${errMsg}. 可用 \`scripts/debug/task-trace.ts ${payload.taskId}\` 追溯每次 attempt 的错误.`
                      : `⚠️ Agent failed: ${errMsg}`,
                  metadata: {
                    kind: isChatMention ? 'agent_status_event' : 'task_status_event',
                    // 'awaiting_approval' is a new chat-side status the
                    // frontend renders as a yellow pill (im-channel.tsx).
                    // It must NOT be conflated with 'failed' / 'cancelled'
                    // — those are terminal; this one is reversible by a
                    // human decision.
                    status: isAwaitingApproval ? 'awaiting_approval' : 'failed',
                    taskId: payload.taskId,
                    runId: payload.taskId,
                    sourceKind: run.sourceKind,
                    ...(triggerMessageId ? { triggerMessageId } : {}),
                    ...(createdApprovalId ? { approvalId: createdApprovalId } : {}),
                    errorCode: errCode,
                    error: errMsg,
                  },
                });
              } catch (postErr) {
                console.warn('[WS] failed to post run-failure system message:', (postErr as Error).message);
              }
            }
          }
        } catch (err) {
          console.warn('[WS] run task.dispatch.reply failed:', (err as Error).message);
        }
        return;
      }
      const agentId = await resolveDeclaredAssignee(payload.taskId);
      if (!agentId) {
        // 2026-05-24 P0-2 invariant: all 3 resolution paths exhausted
        // (resolveDeclaredRun via IMTaskRun, IMTask fallback inside it,
        // and now resolveDeclaredAssignee). daemon ok=true but cloud has
        // nowhere to write the reply — the user-facing chat goes silent.
        // Best-effort surface: pull IMTask directly so we can at least
        // post a "lost reply" system_event to the right conversation.
        log.error(
          {
            invariant: 'dispatch_reply_orphan',
            taskId: payload.taskId,
            ok: payload.ok,
            outputLen: payload.output?.length ?? 0,
            assetCount: payload.assetIds?.length ?? 0,
          },
          'task.dispatch.reply invariant: no declared agent + no IMTask fallback — reply orphaned',
        );
        try {
          const orphanTask = await prisma.iMTask
            .findUnique({
              where: { id: payload.taskId },
              select: { conversationId: true, assigneeId: true },
            })
            .catch(() => null);
          if (orphanTask?.conversationId && orphanTask.assigneeId && messageService) {
            await messageService.send({
              conversationId: orphanTask.conversationId,
              senderId: orphanTask.assigneeId,
              type: 'system_event',
              content: `⚠ Agent 已完成处理但 cloud 无法定位任务归属 — reply 丢失。\`scripts/debug/task-trace.ts ${payload.taskId}\` 可追溯。`,
              metadata: {
                kind: 'invariant_violation',
                invariant: 'dispatch_reply_orphan',
                taskId: payload.taskId,
              },
            });
          }
        } catch (writeErr) {
          log.warn(
            { err: writeErr, taskId: payload.taskId },
            'dispatch_reply_orphan emergency system_event also failed',
          );
        }
        return;
      }

      // Wave-8 W1: merge daemon-side asset observability into the task
      // record BEFORE we settle the task — so a downstream consumer (UI,
      // e2e, retry worker) reading the task's metadata after `completed`
      // already sees `observability.assets.{resolved,strategies}`. We
      // don't fail the dispatch on observability merge errors.
      if (payload.assetObservability && payload.assetObservability.length > 0) {
        await mergeAssetObservability(payload.taskId, payload.assetObservability);
      }

      try {
        if (payload.ok) {
          await taskService.completeTask(payload.taskId, agentId, {
            result: {
              output: payload.output,
              assetIds: payload.assetIds,
              metrics: payload.metrics,
            },
          });

          // Multi-agent collab: when a mention-driven task completes, post
          // the agent's output back to the originating conversation as a
          // chat message authored by the agent. Without this the LLM reply
          // dies inside the task store and downstream @-mentions never
          // chain. Only fires when output is non-empty + task has a
          // conversationId (i.e. came from @-mention dispatch).
          const taskRow = await prisma.iMTask.findUnique({
            where: { id: payload.taskId },
            select: { conversationId: true, metadata: true },
          });
          const output = (payload.output ?? '').trim();
          const attachments = await buildAgentReplyAttachments(payload.assetIds);
          // P0-1 (2026-05-25): mirror resolved assetIds into the task's
          // metadata.assets.linkedAssetIds so the kanban paperclip badge
          // reflects produced artifacts. Fires only when buildAgentReply
          // successfully resolved at least one asset row (so we don't
          // record ghost ids that lost a write-vs-read race upstream).
          if (attachments && attachments.length > 0) {
            await mergeLinkedAssetIdsIntoTask(payload.taskId, payload.assetIds);
          }
          if (taskRow?.conversationId && (output || attachments) && messageService) {
            const conversationId = taskRow.conversationId;
            let triggerMessageId: string | undefined;
            let taskHopCount: number | undefined;
            let taskConversationType: 'direct' | 'group' | undefined;
            let existingTaskMetadata: Record<string, unknown> = {};
            try {
              existingTaskMetadata = JSON.parse(taskRow.metadata ?? '{}') as Record<string, unknown>;
              triggerMessageId = existingTaskMetadata.triggerMessageId as string | undefined;
              const rawHop = existingTaskMetadata.hopCount;
              taskHopCount = typeof rawHop === 'number' && Number.isFinite(rawHop) ? rawHop : undefined;
              const rawConvType = existingTaskMetadata.conversationType;
              taskConversationType = rawConvType === 'direct' || rawConvType === 'group' ? rawConvType : undefined;
            } catch {
              triggerMessageId = undefined;
              taskHopCount = undefined;
              taskConversationType = undefined;
            }
            try {
              const replyMetadata: Record<string, unknown> = {
                kind: 'agent_reply',
                taskId: payload.taskId,
              };
              if (triggerMessageId) replyMetadata.triggerMessageId = triggerMessageId;
              if (attachments) replyMetadata.attachments = attachments;
              // Propagate hopCount so downstream @-mentions in the reply
              // are bounded by MAX_AGENT_HOPS (see message.service.ts).
              if (typeof taskHopCount === 'number') replyMetadata.hopCount = taskHopCount;
              // Propagate conversationType so an @-mention in the reply
              // (agent → @other_agent) preserves the channel context for
              // the next dispatch hop.
              if (taskConversationType) replyMetadata.conversationType = taskConversationType;
              await messageService.send({
                conversationId,
                senderId: agentId,
                type: 'text',
                content:
                  output ||
                  (attachments ? `📎 Sent ${attachments.length} file${attachments.length === 1 ? '' : 's'}` : ''),
                metadata: replyMetadata,
                attachments,
              });
              await maybeWriteSessionMemory({
                taskId: payload.taskId,
                agentId,
                triggerMessageId,
                conversationId,
                existingTaskMetadata,
              });
            } catch (postErr) {
              // Critical: task is marked completed but the agent's reply
              // failed to land in the conversation. Without surfacing this
              // the user sees their @-mention go unanswered. Record on the
              // task and post a system_event so downstream consumers (UI,
              // webhooks, retry workers) have something to act on.
              const errMsg = (postErr as Error).message;
              log.error({ err: postErr, taskId: payload.taskId, conversationId }, `agent_reply post failed: ${errMsg}`);
              try {
                const prevMeta = JSON.parse(taskRow.metadata ?? '{}');
                await prisma.iMTask.update({
                  where: { id: payload.taskId },
                  data: {
                    metadata: JSON.stringify({
                      ...prevMeta,
                      replyPostError: errMsg,
                      replyPostFailedAt: new Date().toISOString(),
                    }),
                  },
                });
              } catch (metaErr) {
                log.error(
                  { err: metaErr, taskId: payload.taskId },
                  `failed to record replyPostError on task: ${(metaErr as Error).message}`,
                );
              }
              try {
                await messageService.send({
                  conversationId,
                  senderId: agentId,
                  type: 'system_event',
                  content: `Agent reply post failed: ${errMsg}`,
                  metadata: {
                    kind: 'agent_reply_post_failed',
                    taskId: payload.taskId,
                    triggerMessageId,
                  },
                });
              } catch (sysErr) {
                log.error(
                  { err: sysErr, taskId: payload.taskId },
                  `failed to post agent_reply_post_failed system_event: ${(sysErr as Error).message}`,
                );
              }
            }
          }
        } else {
          // P2 (2026-05-24): friendlier task-level error when daemon
          // exhausted its local retry budget. The raw last-attempt message
          // (e.g. "fetch failed") is preserved but prefixed so anyone
          // reading the task feed knows N=3 retries were already burnt.
          const rawErr = payload.error?.message ?? 'unknown';
          const isRetryExhausted = payload.error?.code === 'daemon_local_retry_exhausted';
          await taskService.failTask(payload.taskId, agentId, {
            error: isRetryExhausted ? `Agent 已重试 3 次仍失败: ${rawErr}` : rawErr,
            metadata: {
              errorCode: payload.error?.code,
            },
          });
        }
      } catch (err) {
        console.warn('[WS] task.dispatch.reply failed:', (err as Error).message);
      }
    }

    async function maybeWriteSessionMemory(input: {
      taskId: string;
      agentId: string;
      triggerMessageId?: string;
      conversationId: string;
      existingTaskMetadata: Record<string, unknown>;
    }): Promise<void> {
      const startedAt = Date.now();
      if (!input.triggerMessageId) return;
      const trigger = await prisma.iMMessage
        .findUnique({
          where: { id: input.triggerMessageId },
          select: { id: true, content: true, senderId: true },
        })
        .catch(() => null);
      const content = trigger?.content?.trim() ?? '';
      const match = rememberPattern.exec(content);
      const fact = (match?.[1] ?? match?.[2] ?? '').trim();
      if (!fact) return;

      const ownerId = trigger?.senderId ?? '';
      if (!ownerId) return;
      // memory layer became workspace-scoped post-W1; need conversation's
      // workspaceId to write a session memory.
      const conv = await prisma.iMConversation
        .findUnique({ where: { id: input.conversationId }, select: { workspaceId: true } })
        .catch(() => null);
      const memWorkspaceId = conv?.workspaceId ?? '';
      if (!memWorkspaceId) return;
      const path = `agents/${input.agentId}/sessions/${input.conversationId}/memory.md`;
      const now = new Date().toISOString();
      let writeStatus: Record<string, unknown>;
      try {
        const memory = await memoryService.writeMemoryFile(
          memWorkspaceId,
          ownerId,
          'agent',
          path,
          `# Session Memory\n\n- ${fact}\n`,
          'global',
          'fact',
          `Remembered from session ${input.conversationId}`,
        );
        writeStatus = {
          status: 'written',
          memoryId: memory.id,
          path: memory.path,
          durationMs: Date.now() - startedAt,
          at: now,
        };
        log.info(
          { taskId: input.taskId, agentId: input.agentId, ownerId, memoryId: memory.id },
          `memory.write completed from session trigger`,
        );
      } catch (err) {
        writeStatus = {
          status: 'failed',
          error: (err as Error).message,
          durationMs: Date.now() - startedAt,
          at: now,
        };
        log.warn(
          { err, taskId: input.taskId, agentId: input.agentId, ownerId },
          'memory.write failed from session trigger',
        );
      }

      const previousObs =
        input.existingTaskMetadata.observability &&
        typeof input.existingTaskMetadata.observability === 'object' &&
        !Array.isArray(input.existingTaskMetadata.observability)
          ? (input.existingTaskMetadata.observability as Record<string, unknown>)
          : {};
      const previousMemory =
        previousObs.memory && typeof previousObs.memory === 'object' && !Array.isArray(previousObs.memory)
          ? (previousObs.memory as Record<string, unknown>)
          : {};
      await prisma.iMTask
        .update({
          where: { id: input.taskId },
          data: {
            metadata: JSON.stringify({
              ...input.existingTaskMetadata,
              observability: {
                ...previousObs,
                memory: {
                  ...previousMemory,
                  write: writeStatus,
                },
                lastSyncedAt: now,
              },
            }),
          },
        })
        .catch((err: unknown) => {
          log.warn({ err, taskId: input.taskId }, 'failed to stamp memory.write observability on task');
        });
    }
  });
}

/**
 * Wave-8 W1: merge daemon-side asset observations into a task's metadata.
 *
 * Cloud already wrote `observability.assets.requested` + `requestedRefs`
 * at dispatch time (see TaskService.recordAssetRequestObservability).
 * Here we add the daemon's verdict — which strategy each asset took, and
 * how many of them actually became part of the prompt (`resolved`). e2e
 * specs assert on `observability.assets.resolved` ≥ 1.
 *
 * Failure of this merge is non-fatal — the task is allowed to settle
 * regardless. Observability is supposed to make silent failures visible,
 * not become the new silent failure.
 */
/**
 * Build the `attachments` array for an `agent_reply` chat message from the
 * `task.dispatch.reply.assetIds` returned by the daemon. Cloud has the
 * authoritative IMAsset metadata (mime / kind / sizeBytes), so we hydrate
 * here instead of forwarding raw IDs and forcing the client to round-trip
 * for every thumbnail.
 *
 * Shape matches `parseAttachmentsFromMetadata` in
 * src/app/workspace/components/im-channel.tsx — `MessageAssetAttachment`
 * accepts both the singular `metadata.asset` (legacy user→agent path) and
 * plural `metadata.attachments[]` (this path). Title falls back to the
 * IMAsset.metadata.title set by the producer (ArtifactsWatcher, etc).
 *
 * Returns undefined when the input is empty or no assets resolved — caller
 * decides whether to omit the field entirely from the message metadata.
 */
async function buildAgentReplyAttachments(
  assetIds: readonly string[] | undefined,
): Promise<AssetAttachment[] | undefined> {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return undefined;
  const dedup = Array.from(new Set(assetIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (dedup.length === 0) return undefined;
  const rows = await prisma.iMAsset
    .findMany({
      where: { id: { in: dedup }, deletedAt: null },
      select: {
        id: true,
        mime: true,
        kind: true,
        sizeBytes: true,
        contentHash: true,
        thumbnailUrl: true,
        previewUrls: true,
        revision: true,
        filename: true,
        metadata: true,
      },
    })
    .catch(
      () =>
        [] as Array<{
          id: string;
          mime: string | null;
          kind: string;
          sizeBytes: bigint | null;
          contentHash: string;
          thumbnailUrl: string | null;
          previewUrls: unknown;
          revision: number;
          filename: string | null;
          metadata: string | null;
        }>,
    );
  type AssetRow = {
    id: string;
    mime: string | null;
    kind: string;
    sizeBytes: bigint | null;
    contentHash: string;
    thumbnailUrl: string | null;
    previewUrls: unknown;
    revision: number;
    filename: string | null;
    metadata: string | null;
  };
  const byId = new Map<string, AssetRow>(rows.map((r: AssetRow) => [r.id, r]));
  const out: AssetAttachment[] = [];
  for (const id of dedup) {
    const row = byId.get(id);
    if (!row) {
      log.warn({ assetId: id }, `agent_reply attachment: assetId ${id} not found in im_assets — dropping`);
      continue;
    }
    let title: string | null = null;
    try {
      const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      if (typeof meta.title === 'string' && meta.title) title = meta.title;
    } catch {
      // best-effort — metadata blob is owner-controlled
    }
    out.push({
      assetId: id,
      title: title ?? `[${row.kind}]`,
      filename: row.filename ?? undefined,
      mime: row.mime,
      kind: attachmentKindFromAsset(row.kind, row.mime),
      sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
      contentHash: row.contentHash,
      thumbnailUrl: row.thumbnailUrl,
      previewUrls: normalizeAttachmentPreviewUrls(row.previewUrls),
      revision: row.revision,
      role: 'output',
    });
  }
  return out.length > 0 ? out : undefined;
}

function attachmentKindFromAsset(kind: string, mime: string | null): AssetAttachment['kind'] {
  if (kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'asset') return kind;
  const normalizedMime = mime ?? '';
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  if (normalizedMime.startsWith('video/')) return 'video';
  return 'file';
}

function normalizeAttachmentPreviewUrls(raw: unknown): AssetAttachment['previewUrls'] {
  const parsed = typeof raw === 'string' ? parsePreviewUrls(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: NonNullable<AssetAttachment['previewUrls']> = {};
  for (const key of ['small', 'medium', 'large'] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parsePreviewUrls(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function mergeAssetObservability(taskId: string, observations: AssetDispatchObservation[]): Promise<void> {
  try {
    const row = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { metadata: true },
    });
    if (!row) return;
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(row.metadata ?? '{}');
    } catch {
      prev = {};
    }
    const observability = (
      prev.observability && typeof prev.observability === 'object'
        ? { ...(prev.observability as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const assets = (
      observability.assets && typeof observability.assets === 'object'
        ? { ...(observability.assets as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const resolved = observations.filter((o) => o.strategy !== 'error').length;
    assets.strategies = observations;
    assets.resolved = resolved;
    observability.assets = assets;
    await prisma.iMTask.update({
      where: { id: taskId },
      data: { metadata: JSON.stringify({ ...prev, observability }) },
    });
  } catch (err) {
    log.warn(
      { err, taskId, count: observations.length },
      `failed to merge asset observability: ${(err as Error).message}`,
    );
  }
}

/**
 * P0-1 (2026-05-25): mirror the assetIds the daemon just reported on
 * task.dispatch.reply into `IMTask.metadata.assets.linkedAssetIds`. The
 * kanban TaskCard's paperclip badge + multiple back-references (e.g.
 * `task.service.ts::resolveAssetRefs` which rehydrates assetRefs[] on the
 * next dispatch from the same slot) read from this metadata field, so
 * without this mirror a task that produced N files perpetually shows "0
 * attachments" in the board even though the rows + chat attachments exist.
 *
 * Dedup-union with the existing list (a task can produce more files on
 * subsequent dispatches; we keep the cumulative set). Capped at 100
 * entries to bound the JSON column size.
 *
 * Non-fatal: the chat attachment and IMAsset row are already written by
 * the time we get here; this is purely a kanban-side mirror. We `log.warn`
 * on failure but never throw — never destabilize the reply path for a
 * cosmetic mirror.
 */
async function mergeLinkedAssetIdsIntoTask(taskId: string, newIds: string[] | undefined): Promise<void> {
  if (!Array.isArray(newIds) || newIds.length === 0) return;
  try {
    const row = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { metadata: true },
    });
    if (!row) return;
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(row.metadata ?? '{}');
    } catch {
      prev = {};
    }
    const assets = (
      prev.assets && typeof prev.assets === 'object' && !Array.isArray(prev.assets)
        ? { ...(prev.assets as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const existingRaw = Array.isArray(assets.linkedAssetIds) ? (assets.linkedAssetIds as unknown[]) : [];
    const existing = existingRaw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    const seen = new Set<string>(existing);
    const merged = [...existing];
    for (const id of newIds) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    if (merged.length > 100) merged.splice(0, merged.length - 100);
    // Skip the write when nothing actually changed — avoids burning a row
    // update on every reply that re-confirms an already-recorded asset id
    // (e.g. when the cloud receives the same reply twice via ack retry).
    if (merged.length === existing.length && merged.every((id, i) => id === existing[i])) return;
    assets.linkedAssetIds = merged;
    await prisma.iMTask.update({
      where: { id: taskId },
      data: { metadata: JSON.stringify({ ...prev, assets }) },
    });
  } catch (err) {
    log.warn({ err, taskId, newIds: newIds.slice(0, 5) }, `failed to merge linkedAssetIds: ${(err as Error).message}`);
  }
}

/**
 * P1-2 (2026-05-25): persist the daemon's just-reported outbox rejection
 * records onto `IMTask.metadata.outboxRejections`. The next dispatch's
 * `v19x-helpers.buildTaskDispatchRequest` reads them and prepends a
 * warning section to the prompt so the agent learns its previous output
 * was rejected (e.g. wrote markdown into a `.pdf` file) BEFORE retrying
 * the same broken strategy.
 *
 * REPLACE semantics: each reply carries the latest set; stale rejections
 * from earlier turns do not stay in metadata. The buffer on the daemon
 * side already drains atomically per turn (see
 * `flushRejections(taskId)`).
 *
 * Non-fatal: log.warn on failure but don't throw — the task is already
 * settled and the cloud still has the local rejection event log surface
 * (POST /tasks/:id/event with `OUTBOX_MIME_MISMATCH`).
 */
async function mergeOutboxRejectionsIntoTask(taskId: string, rejections: OutboxRejectionRecord[]): Promise<void> {
  if (!Array.isArray(rejections) || rejections.length === 0) return;
  try {
    const row = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { metadata: true },
    });
    if (!row) return;
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(row.metadata ?? '{}');
    } catch {
      prev = {};
    }
    // Defensive: clamp to the same cap the daemon uses (20) to keep
    // metadata bounded even if a future daemon version forgets to.
    const capped = rejections.slice(-20);
    await prisma.iMTask.update({
      where: { id: taskId },
      data: { metadata: JSON.stringify({ ...prev, outboxRejections: capped }) },
    });
  } catch (err) {
    log.warn({ err, taskId, count: rejections.length }, `failed to merge outbox rejections: ${(err as Error).message}`);
  }
}

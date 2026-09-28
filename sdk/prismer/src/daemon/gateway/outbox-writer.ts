// Phase 8a / M2 — local IM gateway optimistic write path + ack remap.
// (docs/desktop202/13-sync-protocol-spec.md §7 outbox shape & id 重映射, §8 合流).
//
// This module is the WRITE half of the local gateway (the read half is
// gateway.ts SWR). It is constructed only when the gateway is enabled, sharing
// the SAME local.db + sync-queue + sync-worker as the daemon's own outbox
// (we do NOT build a second queue — 11 §M2).
//
// FLOW (§7):
//   gateway POST  → enqueueMessageSend() / enqueueTaskMutation():
//                     ① optimistic rm_* write (cmsg temp id, dirty=1, pending)
//                     ② enqueue sync_queue row keyed by the idempotency key cmsg
//                     ③ caller immediately returns the optimistic row (乐观 UI)
//   sync-worker   → flushRow() drains the queue:
//                     POST cloud (with X-Idempotency-Key) → server message
//                     → ack remap (cmsg→serverId+boundarySeq, dirty cleared)
//                     → broadcast the synced row on the local SSE relay so the
//                       renderer reconciles without waiting for the cloud echo.
//
// IDEMPOTENCY KEY (§7): `cmsg_<uuid v4>` generated once at enqueue; it is the
// sync_queue.resource_id, the rm_messages temp id + client_msg_id, and the
// `X-Idempotency-Key` header / `clientMsgId` body field sent to cloud. Retries /
// daemon restarts reuse the SAME row (and thus the SAME key) — never regenerated.

import { randomUUID } from 'node:crypto';
import type { CloudClient } from '../../auth.js';
import type { LocalDb } from '../../sync/store.js';
import type { SyncQueue, SyncQueueRow } from '../../sync/sync-queue.js';
import type { FlushResult } from '../../sync/sync-worker.js';
import type { LocalRelay, LocalSyncEvent } from './local-relay.js';
import {
  applyOptimisticTask,
  clearTaskDirty,
  getMessageByClientMsgId,
  getTask,
  insertOptimisticMessage,
  remapMessageAck,
  setMessageSyncStatus,
  setTaskSyncStatus,
  type RmMessageRow,
  type RmTaskRow,
} from './read-model.js';

/** Mint a fresh idempotency key. `cmsg_` prefix per §7. */
export function newClientMsgId(): string {
  return `cmsg_${randomUUID()}`;
}

/** Outbox payload for an `im_message` row (§7). Self-contained so a restart can
 *  re-flush without the originating HTTP request. */
export interface MessageOutboxPayload {
  kind: 'im_message';
  clientMsgId: string;
  conversationId: string;
  /** Renderer request body, forwarded verbatim to cloud (content/type/etc.). */
  body: Record<string, unknown>;
}

/** Outbox payload for a `task_mutation` row (§7). */
export interface TaskOutboxPayload {
  kind: 'task_mutation';
  clientMsgId: string;
  taskId: string;
  workspaceId: string;
  /** HTTP method + path to replay against cloud (PATCH/POST). */
  method: 'POST' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
}

export interface OutboxWriterDeps {
  db: LocalDb;
  queue: SyncQueue;
  cloud: CloudClient;
  relay: LocalRelay;
}

export class OutboxWriter {
  constructor(private readonly deps: OutboxWriterDeps) {}

  /**
   * Optimistic send-message (§7 write path). Writes the optimistic rm_messages
   * row and enqueues the cloud push, then returns the optimistic row so the
   * gateway can answer the POST immediately (乐观 UI). Returns the client_msg_id
   * and the optimistic row snapshot.
   */
  enqueueMessageSend(input: {
    conversationId: string;
    body: Record<string, unknown>;
  }): { clientMsgId: string; row: RmMessageRow } {
    const clientMsgId = newClientMsgId();
    const optimisticPayload = {
      ...input.body,
      id: clientMsgId,
      conversationId: input.conversationId,
      clientMsgId,
      // boundarySeq omitted (NULL) — assigned by cloud on ack.
      _optimistic: true,
    };
    insertOptimisticMessage(this.deps.db, {
      clientMsgId,
      conversationId: input.conversationId,
      payload: optimisticPayload,
    });
    const payload: MessageOutboxPayload = {
      kind: 'im_message',
      clientMsgId,
      conversationId: input.conversationId,
      body: input.body,
    };
    this.deps.queue.enqueue({
      resourceType: 'im_message',
      resourceId: clientMsgId,
      operation: 'create',
      payload,
    });
    const row = getMessageByClientMsgId(this.deps.db, clientMsgId)!;
    return { clientMsgId, row };
  }

  /**
   * Optimistic task board mutation (§7 write path). Marks the existing task row
   * dirty + pending with the optimistic payload merged in, then enqueues the
   * cloud replay. Returns the client_msg_id and the optimistic row.
   */
  enqueueTaskMutation(input: {
    taskId: string;
    workspaceId: string;
    method: 'POST' | 'PATCH';
    path: string;
    body: Record<string, unknown>;
    /** Optional optimistic patch to apply locally (defaults to body). */
    optimisticPatch?: Record<string, unknown>;
  }): { clientMsgId: string; row: RmTaskRow | undefined } {
    const clientMsgId = newClientMsgId();
    const existing = getTask(this.deps.db, input.taskId);
    const basePayload = existing ? safeParse(existing.payload_json) : { id: input.taskId };
    const merged = {
      ...basePayload,
      ...(input.optimisticPatch ?? input.body),
      id: input.taskId,
      _optimistic: true,
    };
    applyOptimisticTask(this.deps.db, {
      id: input.taskId,
      workspaceId: input.workspaceId,
      payload: merged,
    });
    const payload: TaskOutboxPayload = {
      kind: 'task_mutation',
      clientMsgId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      method: input.method,
      path: input.path,
      body: input.body,
    };
    this.deps.queue.enqueue({
      resourceType: 'task_mutation',
      resourceId: clientMsgId,
      operation: input.method === 'POST' ? 'create' : 'update',
      payload,
    });
    return { clientMsgId, row: getTask(this.deps.db, input.taskId) };
  }

  /**
   * sync-worker FlushFn for `im_message` / `task_mutation` rows (§7 drain). The
   * runner routes these two resource types here; all other resource types keep
   * the existing flushSyncRow path. Returns a {@link FlushResult} the worker
   * uses for backoff/conflict classification, AND performs the ack remap / state
   * transition as a side effect.
   *
   * On a transient failure the row's sync_status is bumped to 'retrying' so the
   * UI can render a retry badge; on a permanent failure (409 / 4xx) it goes
   * 'failed' (needs explicit user resend = a NEW cmsg key).
   */
  async flushRow(row: SyncQueueRow): Promise<FlushResult> {
    const payload = safeParse(row.payload);
    if (isMessagePayload(payload)) return this.flushMessage(payload, row);
    if (isTaskPayload(payload)) return this.flushTask(payload, row);
    return { ok: false, status: 400, message: 'unknown outbox payload' };
  }

  private async flushMessage(payload: MessageOutboxPayload, row: SyncQueueRow): Promise<FlushResult> {
    const res = await this.deps.cloud.request<unknown>('POST', `/api/im/messages/${encodeURIComponent(payload.conversationId)}`, {
      headers: { 'X-Idempotency-Key': payload.clientMsgId },
      body: { ...payload.body, clientMsgId: payload.clientMsgId },
    });

    if (res.ok) {
      const server = extractServerMessage(res.data);
      if (server) {
        const ok = remapMessageAck(this.deps.db, {
          clientMsgId: payload.clientMsgId,
          serverId: server.id,
          boundarySeq: server.boundarySeq,
          payload: server.raw,
        });
        // Broadcast the now-synced message so the renderer reconciles its
        // optimistic row immediately (cursor 恒等; the real SSE echo will be a
        // seq-dup the renderer already drops, §7).
        if (ok) this.broadcastSynced(server, payload.conversationId);
      }
      return { ok: true, status: res.status };
    }
    return this.classifyMessageFailure(payload.clientMsgId, res.status);
  }

  private async flushTask(payload: TaskOutboxPayload, _row: SyncQueueRow): Promise<FlushResult> {
    const res = await this.deps.cloud.request<unknown>(payload.method, payload.path, {
      headers: { 'X-Idempotency-Key': payload.clientMsgId },
      body: payload.body,
    });

    if (res.ok) {
      const server = extractServerTask(res.data, payload.taskId);
      clearTaskDirty(this.deps.db, {
        id: payload.taskId,
        payload: server?.raw,
        updatedAt: server?.updatedAt,
      });
      return { ok: true, status: res.status };
    }
    return this.classifyTaskFailure(payload.taskId, res.status);
  }

  // ── failure三态 (§7) ───────────────────────────────────────────────────────

  private classifyMessageFailure(clientMsgId: string, status: number): FlushResult {
    if (status === 0 || status === 408 || status === 429 || status >= 500) {
      // transient → worker backs off + re-queues; surface 'retrying' on the row.
      setMessageSyncStatus(this.deps.db, clientMsgId, 'retrying');
      return { ok: false, status };
    }
    // permanent (409 conflict or other 4xx) → 'failed'; resend = new cmsg.
    setMessageSyncStatus(this.deps.db, clientMsgId, 'failed');
    return { ok: false, status };
  }

  private classifyTaskFailure(taskId: string, status: number): FlushResult {
    if (status === 0 || status === 408 || status === 429 || status >= 500) {
      setTaskSyncStatus(this.deps.db, taskId, 'retrying');
      return { ok: false, status };
    }
    setTaskSyncStatus(this.deps.db, taskId, 'failed');
    return { ok: false, status };
  }

  private broadcastSynced(server: ServerMessage, conversationId: string): void {
    const event: LocalSyncEvent = {
      type: 'message.new',
      ...(typeof server.boundarySeq === 'number' ? { boundarySeq: server.boundarySeq } : {}),
      conversationId,
      data: server.raw,
    };
    this.deps.relay.broadcast(event);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface ServerMessage {
  id: string;
  boundarySeq: number | null;
  raw: Record<string, unknown>;
}

interface ServerTask {
  id: string;
  updatedAt?: number;
  raw: Record<string, unknown>;
}

/** Unwrap the cloud POST /api/im/messages response → server message (§7). */
export function extractServerMessage(data: unknown): ServerMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // { ok, data: { message: {...} } } | { data: {...} } | bare message
  const inner = (d['data'] as Record<string, unknown> | undefined) ?? d;
  const msg = (inner['message'] as Record<string, unknown> | undefined) ?? inner;
  const id = typeof msg['id'] === 'string' ? (msg['id'] as string) : undefined;
  if (!id) return null;
  const bs = msg['boundarySeq'];
  return { id, boundarySeq: typeof bs === 'number' ? bs : null, raw: msg };
}

function extractServerTask(data: unknown, fallbackId: string): ServerTask | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const inner = (d['data'] as Record<string, unknown> | undefined) ?? d;
  const task = (inner['task'] as Record<string, unknown> | undefined) ?? inner;
  const id = typeof task['id'] === 'string' ? (task['id'] as string) : fallbackId;
  const ua = task['updatedAt'] ?? task['updated_at'];
  let updatedAt: number | undefined;
  if (typeof ua === 'number') updatedAt = ua;
  else if (typeof ua === 'string') {
    const ms = Date.parse(ua);
    if (Number.isFinite(ms)) updatedAt = ms;
  }
  return { id, updatedAt, raw: task };
}

function isMessagePayload(p: unknown): p is MessageOutboxPayload {
  return !!p && typeof p === 'object' && (p as { kind?: string }).kind === 'im_message';
}

function isTaskPayload(p: unknown): p is TaskOutboxPayload {
  return !!p && typeof p === 'object' && (p as { kind?: string }).kind === 'task_mutation';
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

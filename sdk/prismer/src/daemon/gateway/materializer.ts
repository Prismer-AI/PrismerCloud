// Phase 6 / M1 — WS event materializer (docs/desktop202/13-sync-protocol-spec.md §5).
//
// Per spec §5, each cloud WS IM event is, when the gateway is enabled:
//   ① upsert rm_* (with boundary_seq)
//   ② advance rm_watermarks
//   ③ forwarded AS-IS (same shape + same boundarySeq) to local SSE subscribers
//
// The daemon's cloud WS today carries task/agent/workspace/asset events; this
// tap recognizes IM-sync-shaped events (`message.new`/`updated`, `conversation.*`,
// `task.*`) and materializes them. Events it doesn't recognize are ignored
// (the tap is side-effect-only and never disturbs the runner's own switch).
// This is forward-compatible: if/when cloud broadcasts message.new onto the
// daemon WS, materialization lights up with zero further wiring.
//
// Gap detection (§5): when an incoming per-conversation event's boundarySeq
// jumps past `watermark.cursor + 1`, the scope is reset (rm_* cleared, watermark
// zeroed) and a sync.reset frame is emitted so the renderer re-pulls.

import type { LocalDb } from '../../sync/store.js';
import {
  advanceWatermark,
  getMessageByClientMsgId,
  getWatermark,
  remapMessageAck,
  resetScope,
  upsertConversation,
  upsertMessage,
  upsertTask,
} from './read-model.js';
import type { LocalRelay, LocalSyncEvent } from './local-relay.js';

/** Raw event as it arrives — either the cloud SSE `sync` shape (preferred) or
 *  a bare daemon-WS envelope `{ type, payload }`. We normalize both. */
export interface RawWsEvent {
  type?: string;
  // cloud SSE sync shape
  seq?: number;
  boundarySeq?: number | null;
  data?: unknown;
  conversationId?: string | null;
  at?: string;
  // daemon-WS envelope shape
  payload?: unknown;
}

const MESSAGE_TYPES = new Set(['message.new', 'message.updated', 'message.edit', 'message.deleted']);
const CONVERSATION_TYPES = new Set(['conversation.new', 'conversation.updated', 'conversation.changed']);
const TASK_TYPES = new Set(['task.new', 'task.updated', 'task.changed', 'task.status']);

export interface MaterializeResult {
  /** Did this event materialize into an rm_* row? */
  materialized: boolean;
  /** Did it trigger a domain-level reset (gap detected)? */
  reset?: { domain: 'chats' | 'tasks'; scopeId: string };
}

export interface MaterializerDeps {
  db: LocalDb;
  relay: LocalRelay;
  /** Workspace id for task rows (tasks DDL requires workspace_id NOT NULL). */
  workspaceId: () => string | null;
}

/**
 * The materializer is gateway-scoped: construct it only when the local gateway
 * capability is enabled. It is purely additive — feeding it events the runner
 * also handles elsewhere is safe (rm_* upsert is idempotent).
 */
export class Materializer {
  constructor(private readonly deps: MaterializerDeps) {}

  /**
   * Process one raw WS event. Returns whether it was materialized. Never throws
   * to the caller — materialization failures are swallowed so a malformed event
   * can't take down the runner's WS loop (rm_* is a rebuildable cache).
   */
  ingest(raw: RawWsEvent): MaterializeResult {
    try {
      return this.ingestInner(raw);
    } catch {
      return { materialized: false };
    }
  }

  private ingestInner(raw: RawWsEvent): MaterializeResult {
    const type = raw.type;
    if (!type) return { materialized: false };

    // Normalize to the cloud SSE shape. Daemon-WS envelopes nest the body in
    // `payload`; cloud SSE events carry it in `data`.
    const body = (raw.data ?? raw.payload) as Record<string, unknown> | undefined;

    if (MESSAGE_TYPES.has(type)) return this.ingestMessage(type, raw, body);
    if (CONVERSATION_TYPES.has(type)) return this.ingestConversation(raw, body);
    if (TASK_TYPES.has(type)) return this.ingestTask(raw, body);
    return { materialized: false };
  }

  private ingestMessage(
    _type: string,
    raw: RawWsEvent,
    body: Record<string, unknown> | undefined,
  ): MaterializeResult {
    if (!body) return { materialized: false };
    const id = pickString(body, 'id', 'messageId');
    const conversationId = raw.conversationId ?? pickString(body, 'conversationId', 'conversation_id');
    if (!id || !conversationId) return { materialized: false };

    const boundarySeq = raw.boundarySeq ?? pickNumber(body, 'boundarySeq', 'boundary_seq');

    // ── Echo 对账 (§8 ②) ─────────────────────────────────────────────────────
    // If the cloud event carries the idempotencyKey/clientMsgId of a local
    // optimistic (dirty) row, this event IS our own write echoing back. Remap
    // the optimistic row to its server identity + clear dirty (§7) instead of
    // inserting a duplicate. Must run BEFORE gap detection: an optimistic row
    // has boundary_seq=NULL, so the echo's seq is the FIRST seq we apply for it
    // and would otherwise look like a jump.
    const clientMsgId = extractClientMsgId(body);
    if (clientMsgId) {
      const optimistic = getMessageByClientMsgId(this.deps.db, clientMsgId);
      if (optimistic && optimistic.dirty === 1) {
        remapMessageAck(this.deps.db, {
          clientMsgId,
          serverId: id,
          boundarySeq: typeof boundarySeq === 'number' ? boundarySeq : null,
          payload: body,
        });
        this.forward(raw);
        return { materialized: true };
      }
    }

    // Gap detection (§5.1): a boundarySeq jump past cursor+1 → domain reset.
    if (typeof boundarySeq === 'number') {
      const wm = getWatermark(this.deps.db, 'chats', conversationId);
      const cursor = wm?.cursor ?? 0;
      if (boundarySeq > cursor + 1 && cursor > 0) {
        resetScope(this.deps.db, 'chats', conversationId);
        this.deps.relay.broadcastReset({ domain: 'chats', scopeId: conversationId });
        // Don't materialize the out-of-order event; the re-pull will fill the gap.
        return { materialized: false, reset: { domain: 'chats', scopeId: conversationId } };
      }
    }

    upsertMessage(this.deps.db, {
      id,
      conversationId,
      clientMsgId: pickString(body, 'clientMsgId', 'client_msg_id') ?? null,
      boundarySeq: boundarySeq ?? null,
      payload: body,
      createdAt: epochFrom(body, raw) ?? Date.now(),
    });

    if (typeof boundarySeq === 'number') {
      advanceWatermark(this.deps.db, 'chats', conversationId, boundarySeq);
    }
    this.forward(raw);
    return { materialized: true };
  }

  private ingestConversation(
    raw: RawWsEvent,
    body: Record<string, unknown> | undefined,
  ): MaterializeResult {
    if (!body) return { materialized: false };
    const id = pickString(body, 'id', 'conversationId', 'conversation_id');
    if (!id) return { materialized: false };

    upsertConversation(this.deps.db, {
      id,
      payload: body,
      updatedAt: epochFrom(body, raw) ?? Date.now(),
    });
    // Conversation-list watermark is a freshness marker only (no per-row seq
    // continuity); advance by the per-user seq when present, else just touch.
    if (typeof raw.seq === 'number') {
      advanceWatermark(this.deps.db, 'chats', '', raw.seq);
    }
    this.forward(raw);
    return { materialized: true };
  }

  private ingestTask(raw: RawWsEvent, body: Record<string, unknown> | undefined): MaterializeResult {
    if (!body) return { materialized: false };
    const id = pickString(body, 'id', 'taskId', 'task_id');
    if (!id) return { materialized: false };
    const workspaceId =
      pickString(body, 'workspaceId', 'workspace_id') ?? this.deps.workspaceId() ?? '';
    if (!workspaceId) return { materialized: false };

    upsertTask(this.deps.db, {
      id,
      workspaceId,
      payload: body,
      updatedAt: epochFrom(body, raw) ?? Date.now(),
    });
    if (typeof raw.seq === 'number') {
      advanceWatermark(this.deps.db, 'tasks', '', raw.seq);
    }
    this.forward(raw);
    return { materialized: true };
  }

  /** Forward the event to local SSE subscribers, preserving shape + seqs (§5). */
  private forward(raw: RawWsEvent): void {
    const event: LocalSyncEvent = {
      type: raw.type!,
      ...(typeof raw.seq === 'number' ? { seq: raw.seq } : {}),
      ...(raw.boundarySeq != null ? { boundarySeq: raw.boundarySeq } : {}),
      ...(raw.conversationId != null ? { conversationId: raw.conversationId } : {}),
      ...(raw.at ? { at: raw.at } : {}),
      data: raw.data ?? raw.payload,
    };
    this.deps.relay.broadcast(event);
  }
}

/**
 * Extract the idempotency key (== client_msg_id) from a cloud message event for
 * echo 对账 (§8 ②). Cloud carries it in one of:
 *   - top-level `clientMsgId` / `idempotencyKey` (forward-compat / C5 SSE echo),
 *   - `metadata._idempotencyKey` (cloud message.service stores it there today,
 *     src/im/services/message.service.ts:302).
 */
function extractClientMsgId(body: Record<string, unknown>): string | undefined {
  const direct = pickString(body, 'clientMsgId', 'client_msg_id', 'idempotencyKey', 'idempotency_key');
  if (direct) return direct;
  const meta = body['metadata'];
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    const v = m['_idempotencyKey'] ?? m['idempotencyKey'];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickString(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(body: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Best-effort epoch-ms extraction from `updatedAt`/`createdAt`/`at` (ISO or ms). */
function epochFrom(body: Record<string, unknown>, raw: RawWsEvent): number | undefined {
  const candidates = [body['updatedAt'], body['createdAt'], body['updated_at'], body['created_at'], raw.at];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
      const ms = Date.parse(c);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

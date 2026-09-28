// Phase 6 / M1 — local SSE relay (docs/desktop202/13-sync-protocol-spec.md §5).
//
// The materializer (materializer.ts) forwards each cloud WS IM event to every
// connected local SSE subscriber AS-IS — same event shape, same boundarySeq
// value (§5 "cursor 映射 = 恒等"). This module is just the in-memory fan-out
// registry; the actual HTTP `GET /api/im/sync/stream` wire framing lives in
// gateway.ts (it owns the ServerResponse).

import type { ServerResponse } from 'node:http';

/**
 * The exact wire shape the cloud `/api/im/sync/stream` emits per `sync` event
 * (src/im/services/sync.service.ts:142 — `{ seq, boundarySeq, type, data,
 * conversationId, at }`). The local relay forwards this verbatim so the
 * renderer's `use-reconciled-stream` / `sse-cursor` consumers can't tell the
 * two sources apart.
 */
export interface LocalSyncEvent {
  /** Per-user monotonic cursor (IMSyncEvent.id on cloud). May be absent on
   *  control frames (sync.reset / heartbeat). */
  seq?: number;
  /** Per-conversation monotonic seq; null for non-message events. */
  boundarySeq?: number | null;
  type: string;
  data?: unknown;
  conversationId?: string | null;
  at?: string;
  /** Set by §5 domain-reset path; renderer runs its existing reload(). */
  [k: string]: unknown;
}

interface Subscriber {
  id: number;
  res: ServerResponse;
}

export class LocalRelay {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 1;

  /** Number of currently-connected local SSE clients (surfaced on /healthz). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Register a ServerResponse already primed as an SSE stream (headers written
   * by the caller). Returns an unsubscribe fn; also auto-removes on socket
   * close. The caller is responsible for the initial `caught_up` frame.
   */
  subscribe(res: ServerResponse): () => void {
    const id = this.nextId++;
    this.subscribers.set(id, { id, res });
    const remove = () => {
      this.subscribers.delete(id);
    };
    res.on('close', remove);
    return remove;
  }

  /**
   * Forward one event to every subscriber. Frame format matches the cloud SSE
   * relay: `event: sync\n` + `id: <seq>\n` (when present) + `data: <json>\n\n`.
   * A dead socket is dropped silently (best-effort fan-out).
   */
  broadcast(event: LocalSyncEvent): void {
    const json = JSON.stringify(event);
    const idLine = typeof event.seq === 'number' ? `id: ${event.seq}\n` : '';
    const frame = `event: sync\n${idLine}data: ${json}\n\n`;
    for (const sub of this.subscribers.values()) {
      try {
        sub.res.write(frame);
      } catch {
        this.subscribers.delete(sub.id);
      }
    }
  }

  /** Emit a `sync.reset` control frame so the renderer runs its reload() path
   *  (§5 断档→域级重拉). */
  broadcastReset(scope: { domain: string; scopeId?: string }): void {
    this.broadcast({
      type: 'sync.reset',
      data: { domain: scope.domain, scopeId: scope.scopeId ?? '' },
    });
  }

  /** Close all subscriber sockets (daemon shutdown). */
  closeAll(): void {
    for (const sub of this.subscribers.values()) {
      try {
        sub.res.end();
      } catch {
        /* ignore */
      }
    }
    this.subscribers.clear();
  }
}

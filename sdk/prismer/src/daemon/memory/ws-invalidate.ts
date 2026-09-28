// WS invalidate handler — phase-1 C2.
//
// Listens on the daemon's primary WsClient for `memory.invalidate` events
// pushed from cloud (Line A) and applies them to the local SQLite mirror by
// calling `MemoryStore.invalidate(pageIds, reason)` on the matching workspace.
//
// Cloud pushes this event when:
//   - a memory page is soft-deleted (Line A POST /memory/pages/:id, DELETE)
//   - a page is archived
//   - visibility is shifted (e.g. agent → workspace)
//   - a page is promoted (workspace → agent)
//
// Daemon-offline catch-up: when the daemon reconnects after being offline,
// invalidate events emitted during downtime are NOT replayed by the WS
// channel. Phase-1 ships a simple "trust the next refresh" model — the
// daemon's next sync inbox tick + cloud's next outbox replay will eventually
// re-derive consistency. A proper cursor-based catch-up (`GET /api/im/memory
// /sync/events?since=<cursor>`) is in the phase-1 follow-up TODO doc since
// Line A has not yet shipped that endpoint.

import type { EventEmitter } from 'node:events';
import type { MemoryRuntime } from './runtime.js';
import type { CloudClient } from '../../auth.js';
import type { MemoryKeyManager } from './key-manager.js';
import { initialSyncFromCloud } from './cloud-sync.js';

export interface MemoryInvalidatePayload {
  workspaceId: string;
  pageIds: string[];
  reason: 'soft_delete' | 'archive' | 'visibility_changed' | 'promoted';
  createdAt?: string;
}

interface WsMessage {
  type: string;
  payload?: unknown;
}

export interface AttachWsInvalidateOptions {
  /** The daemon's WsClient (extends EventEmitter; emits 'message' with parsed JSON). */
  wsClient: EventEmitter;
  runtime: MemoryRuntime;
  /**
   * memory203 doc 07 §4 — when wired, a non-delete invalidate (the page still
   * exists but changed: visibility/promote/archive) triggers a best-effort
   * re-pull of the fresh SUBSET projection from the cloud superset
   * (`initialSyncFromCloud`, watermark-bounded, subset fields only — NOT the
   * full aclJson). Absent ⇒ legacy "mark stale + trust next sync tick".
   */
  cloud?: CloudClient;
  /** Per-workspace key for decrypting re-pulled encrypted pages (fail-closed). */
  keyManager?: MemoryKeyManager;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * Register a `message` listener that filters for `memory.invalidate` events
 * and routes them to the matching workspace's MemoryStore. Returns a
 * disposer that removes the listener (used for tests + clean shutdown).
 */
export function attachWsInvalidate(opts: AttachWsInvalidateOptions): () => void {
  const log = opts.log ?? defaultLog();
  const handler = (msg: unknown): void => {
    if (!isWsMessage(msg) || msg.type !== 'memory.invalidate') return;
    const payload = msg.payload;
    if (!isInvalidatePayload(payload)) {
      log.warn(`memory.invalidate received with malformed payload: ${JSON.stringify(payload)}`);
      return;
    }
    // Only act on workspaces this daemon already has a store for; opening
    // a new store on an invalidate would spin up empty SQLite for a
    // workspace we never wrote to (defensive — invalidate of a never-seen
    // page is a noop conceptually).
    const slot = opts.runtime.peek(payload.workspaceId);
    if (!slot) {
      log.info(`memory.invalidate for workspace=${payload.workspaceId} ignored (no local store)`);
      return;
    }
    slot.store.invalidate(payload.pageIds, payload.reason);
    log.info(
      `memory.invalidate workspace=${payload.workspaceId} pages=${payload.pageIds.length} reason=${payload.reason}`,
    );
    // doc 07 §4 — re-pull the fresh subset projection for changed-but-extant
    // pages. soft_delete needs no re-pull (the page is gone; the local
    // invalidate above suffices, and a deleted page won't re-list anyway).
    // Fire-and-forget: a re-pull failure (offline) must never block the WS
    // handler — local-first stays intact and the next sync tick re-converges.
    if (opts.cloud && payload.reason !== 'soft_delete') {
      void initialSyncFromCloud(opts.runtime, opts.cloud, payload.workspaceId, opts.keyManager).catch(
        (err: unknown) => {
          log.warn(
            `memory.invalidate re-pull failed for workspace=${payload.workspaceId} (non-blocking): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    }
  };

  opts.wsClient.on('message', handler);
  return () => opts.wsClient.off('message', handler);
}

function isWsMessage(msg: unknown): msg is WsMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && typeof (msg as WsMessage).type === 'string';
}

function isInvalidatePayload(p: unknown): p is MemoryInvalidatePayload {
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  return (
    typeof x.workspaceId === 'string' &&
    Array.isArray(x.pageIds) &&
    x.pageIds.every((id) => typeof id === 'string') &&
    typeof x.reason === 'string'
  );
}

function defaultLog(): { info: (m: string) => void; warn: (m: string) => void } {
  return {
    info: (m) => process.stdout.write(`[ws-invalidate] ${m}\n`),
    warn: (m) => process.stderr.write(`[ws-invalidate] ${m}\n`),
  };
}

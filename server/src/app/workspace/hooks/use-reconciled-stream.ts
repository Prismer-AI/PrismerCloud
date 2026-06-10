'use client';

/**
 * useReconciledStream — Wave 3 §4.1 / §4.4.2 implementation.
 *
 * Maintains a per-scope item map driven by an SSE stream of events that carry
 * a per-conversation monotonically increasing `boundarySeq`. The hook detects
 * gaps in the seq sequence and self-heals via a gap-fill REST call. Cursor
 * (`lastSeq`) is persisted to `localStorage` so F5 / browser kill resumes
 * from the last applied event rather than reloading the whole history.
 *
 * Why a generic hook (not message-specific):
 *   - §4.1 (rev.2) frames the contract around any `IMSyncEvent` payload that
 *     ships `boundarySeq`. The same shape will be reused for task-run steps
 *     (§4.4.4) and other per-conversation streams later — this hook is the
 *     single reconcile path that owns gap detection + cursor persistence.
 *
 * Semantics (per §4.1):
 *   evt.boundarySeq <  lastSeq + 1 → dup, drop silently
 *   evt.boundarySeq == lastSeq + 1 → apply, advance cursor, persist
 *   evt.boundarySeq >  lastSeq + 1 → gap; buffer + fire catch-up REST call
 *                                    that drains [lastSeq+1 .. evt.seq-1]
 *                                    from the cloud, then re-applies the
 *                                    buffered event.
 *
 * Storage layout:
 *   localStorage key = `cursor:<scope.kind>:<scope.id>` → stringified bigint
 *
 *   We do NOT persist the full item map — only the cursor. The map is
 *   rebuilt from `initialLoader()` on mount; once the cursor is replayed
 *   forward from there, the user sees the latest server state.
 *
 * Caller contract:
 *   - `initialLoader()` is invoked exactly once per scope.id change. It
 *     should return the current items AND the highest `boundarySeq` it has
 *     seen, so the hook knows the starting cursor without an extra round
 *     trip. If the cursor in localStorage is HIGHER than the loader's
 *     reported seq, the cursor wins (this is the F5 path — server state
 *     may have advanced but we still trust what we already applied).
 *   - The caller pipes SSE events to `applyExternal(evt)`. The hook does
 *     not open its own EventSource because the SSE channel is shared with
 *     other event types (approvals, task progress) in the current
 *     `im-channel.tsx`. Decoupling the transport lets one EventSource
 *     fan out into multiple reconciled streams.
 *   - The caller can also use `markLocal(item, boundarySeq)` to apply an
 *     item it received synchronously (e.g. POST /messages response that
 *     includes `boundarySeq`). This advances the cursor without waiting
 *     for the SSE echo of that same event — the SSE echo will then arrive
 *     with `boundarySeq < expected`, get dropped as a dup. Avoids the
 *     race where a fast POST response races the SSE fan-out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ReconciledItem {
  id: string;
  /**
   * Per-conversation monotonic seq, or null/undefined for items that
   * pre-date §4.1 (boundarySeq column not populated) or are optimistic
   * locals not yet echoed by the server. Items with null/undefined seq
   * are applied by id only — they do not advance the cursor.
   */
  boundarySeq?: number | null;
}

export interface ReconciledScope {
  kind: 'conversation' | 'task' | 'workspace';
  id: string;
}

export interface InitialLoad<T> {
  items: T[];
  /** Highest boundarySeq among `items`. 0 if no items yet seen. */
  lastSeq: number;
}

export interface UseReconciledStreamOptions<T extends ReconciledItem> {
  scope: ReconciledScope;
  /** Loads the current items + cursor for this scope. Invoked on mount. */
  initialLoader: () => Promise<InitialLoad<T>>;
  /**
   * Fills `[afterSeq+1 .. ∞)` from the server. Called when the hook detects
   * a gap in the SSE stream. Owner returns the events in `boundarySeq` ASC
   * order; events with `boundarySeq <= afterSeq` are silently dropped by
   * `applyExternal`.
   */
  catchUp: (afterSeq: number) => Promise<{ items: T[] }>;
  /**
   * Optional sort comparator for the derived `items` array. Defaults to
   * `boundarySeq` ASC then `id` lex — message lists override with a
   * `createdAt`-based comparator so optimistic locals (no boundarySeq yet)
   * interleave correctly with their eventually-echoed server twins.
   */
  compareItems?: (a: T, b: T) => number;
  /**
   * Optional override for localStorage key prefix (mainly for tests).
   * Defaults to `'cursor'`.
   */
  storagePrefix?: string;
}

export interface UseReconciledStreamResult<T extends ReconciledItem> {
  /** Items sorted by createdAt + insertion order. */
  items: T[];
  /** The current cursor — highest applied boundarySeq. */
  lastSeq: number;
  /**
   * Apply an externally-received event (SSE, etc.). Returns whether the
   * event was applied (`true`), dropped as dup (`false`), or buffered for
   * catch-up (`'buffered'`).
   */
  applyExternal: (item: T) => 'applied' | 'dropped' | 'buffered';
  /**
   * Apply a locally-known item (e.g. POST response) WITHOUT advancing the
   * cursor. Use this for optimistic inserts where `boundarySeq` is not yet
   * known. The SSE echo will overwrite by id when it lands.
   */
  markLocal: (item: T) => void;
  /**
   * Remove an item from the local view by id. Used by the `failed-send`
   * path when the optimistic row times out.
   */
  removeLocal: (id: string) => void;
  /**
   * Replace an item by id. Used when the optimistic insert needs to be
   * rewritten (e.g. mark as failed) without changing its position.
   */
  patchLocal: (id: string, patch: Partial<T>) => void;
  /** Force-reload from initialLoader (e.g. conversation switch). */
  reload: () => void;
}

const DEFAULT_PREFIX = 'cursor';

function cursorKey(prefix: string, scope: ReconciledScope): string {
  return `${prefix}:${scope.kind}:${scope.id}`;
}

function readCursor(key: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(key: string, seq: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(seq));
  } catch {
    /* localStorage quota / SSR / private mode — silently no-op */
  }
}

export function useReconciledStream<T extends ReconciledItem>(
  opts: UseReconciledStreamOptions<T>,
): UseReconciledStreamResult<T> {
  const { scope, initialLoader, catchUp, compareItems, storagePrefix = DEFAULT_PREFIX } = opts;
  const storageKey = useMemo(() => cursorKey(storagePrefix, scope), [storagePrefix, scope]);
  // `compareItems` may be re-created every render by callers using inline
  // closures; we stash it in a ref so the memoized derived items don't
  // thrash on identity churn alone.
  const compareRef = useRef(compareItems);
  compareRef.current = compareItems;

  // Items keyed by id; we keep the Map in a ref so frequent SSE-driven
  // updates don't tear down the closure identity for the public API. The
  // `version` state exists solely to trigger a re-render when the ref
  // mutates.
  const itemsRef = useRef<Map<string, T>>(new Map());
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  const lastSeqRef = useRef<number>(0);
  const buffer = useRef<T[]>([]);
  const catchUpInFlight = useRef<boolean>(false);
  // Local item id → optimistic items not yet acknowledged by the server.
  // We keep this separate from `itemsRef` so the SSE echo can replace the
  // optimistic row by id (since the optimistic row's id starts as the
  // idempotencyKey, and the server replaces it with the persisted id on
  // echo). Owner code is expected to insert optimistic with id = uuid
  // (the idempotencyKey) and look up the echo's `idempotencyKey` field
  // to match.
  const reloadSeq = useRef(0);

  // ─── Reload from initialLoader ───────────────────────────────────
  const reload = useCallback(() => {
    const myReload = ++reloadSeq.current;
    itemsRef.current = new Map();
    buffer.current = [];
    lastSeqRef.current = 0;
    bumpVersion();

    initialLoader()
      .then(({ items, lastSeq }) => {
        if (myReload !== reloadSeq.current) return; // superseded
        const m = new Map<string, T>();
        for (const it of items) m.set(it.id, it);
        itemsRef.current = m;
        // The cursor we trust is `max(loader.lastSeq, localStorage)`. The
        // loader's `lastSeq` is the highest seq in the items we hydrated;
        // localStorage may have a HIGHER cursor if the user has since
        // applied events but the rows aren't in the initial page (e.g.
        // pagination scrolled past). We respect the higher one.
        const storedCursor = readCursor(storageKey);
        const effective = Math.max(lastSeq, storedCursor);
        lastSeqRef.current = effective;
        writeCursor(storageKey, effective);
        bumpVersion();
      })
      .catch(() => {
        /* swallow — caller surfaces fetch failures via its own error state */
      });
  }, [initialLoader, storageKey, bumpVersion]);

  // Initial mount + scope change.
  useEffect(() => {
    reload();
    // We intentionally rebuild on storageKey change (which encodes scope).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ─── Internal apply (cursor-advancing) ───────────────────────────
  const applyOne = useCallback(
    (item: T): void => {
      itemsRef.current.set(item.id, item);
      if (item.boundarySeq != null) {
        lastSeqRef.current = Math.max(lastSeqRef.current, item.boundarySeq);
        writeCursor(storageKey, lastSeqRef.current);
      }
    },
    [storageKey],
  );

  // ─── Public: applyExternal (SSE-driven) ──────────────────────────
  const applyExternal = useCallback(
    (item: T): 'applied' | 'dropped' | 'buffered' => {
      // Items without boundarySeq are non-reconcilable — apply by id only,
      // don't advance cursor. This is the legacy path for events that
      // pre-date the §4.1 migration (boundarySeq column NULL).
      if (item.boundarySeq == null) {
        applyOne(item);
        bumpVersion();
        return 'applied';
      }

      const expected = lastSeqRef.current + 1;

      if (item.boundarySeq < expected) {
        // Duplicate / already-applied. The SSE echo of a POST that the
        // client already advanced via `markLocal` lands here.
        return 'dropped';
      }

      if (item.boundarySeq > expected) {
        // Gap — buffer and trigger catch-up. We never apply the future
        // event eagerly; catch-up gives us the [expected..future-1]
        // window and then we drain the buffer.
        buffer.current.push(item);
        if (!catchUpInFlight.current) {
          catchUpInFlight.current = true;
          const since = lastSeqRef.current;
          catchUp(since)
            .then(({ items: filled }) => {
              // Apply filled events in seq order (caller guarantees ASC).
              for (const f of filled) {
                if (f.boundarySeq == null) continue;
                if (f.boundarySeq <= lastSeqRef.current) continue;
                applyOne(f);
              }
              // Now drain the buffer for any events still in-order.
              buffer.current.sort((a, b) => {
                const aS = a.boundarySeq ?? 0;
                const bS = b.boundarySeq ?? 0;
                return aS - bS;
              });
              const stillBuffered: T[] = [];
              for (const b of buffer.current) {
                if (b.boundarySeq == null) continue;
                if (b.boundarySeq <= lastSeqRef.current) continue; // already drained
                if (b.boundarySeq === lastSeqRef.current + 1) {
                  applyOne(b);
                } else {
                  stillBuffered.push(b);
                }
              }
              buffer.current = stillBuffered;
              bumpVersion();
            })
            .catch(() => {
              /* swallow — leave buffer in place, next event triggers retry */
            })
            .finally(() => {
              catchUpInFlight.current = false;
            });
        }
        return 'buffered';
      }

      // expected — apply directly.
      applyOne(item);
      bumpVersion();
      return 'applied';
    },
    [applyOne, catchUp, bumpVersion],
  );

  // ─── Public: markLocal (optimistic / synchronous POST response) ──
  const markLocal = useCallback(
    (item: T): void => {
      // Insert/overwrite by id. If the item DOES have a boundarySeq (e.g.
      // POST response carries one), advance the cursor too — this is the
      // "no wait for SSE echo" optimization in §4.1.
      itemsRef.current.set(item.id, item);
      if (item.boundarySeq != null && item.boundarySeq > lastSeqRef.current) {
        lastSeqRef.current = item.boundarySeq;
        writeCursor(storageKey, lastSeqRef.current);
      }
      bumpVersion();
    },
    [storageKey, bumpVersion],
  );

  const removeLocal = useCallback(
    (id: string): void => {
      if (itemsRef.current.delete(id)) bumpVersion();
    },
    [bumpVersion],
  );

  const patchLocal = useCallback(
    (id: string, patch: Partial<T>): void => {
      const existing = itemsRef.current.get(id);
      if (!existing) return;
      itemsRef.current.set(id, { ...existing, ...patch });
      bumpVersion();
    },
    [bumpVersion],
  );

  // ─── Derived: items[] (caller-supplied sort, default boundarySeq ASC) ─
  const items = useMemo(() => {
    void version; // re-derive on every applyExternal / markLocal
    const arr = Array.from(itemsRef.current.values());
    const cmp =
      compareRef.current ??
      ((a: T, b: T) => {
        const aS = a.boundarySeq;
        const bS = b.boundarySeq;
        if (aS != null && bS != null) return aS - bS;
        if (aS != null) return -1;
        if (bS != null) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    arr.sort(cmp);
    return arr;
  }, [version]);

  return {
    items,
    lastSeq: lastSeqRef.current,
    applyExternal,
    markLocal,
    removeLocal,
    patchLocal,
    reload,
  };
}

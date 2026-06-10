/**
 * `asset-event-bus` — process-wide, per-asset-id pub/sub for `asset.changed`
 * signals.
 *
 * Why this exists: the page-level `/sync/stream` EventSource (page.tsx) reacts
 * to `asset.changed` with a blanket `invalidate('assets')` — a full workspace
 * asset-list re-pull. That is the right move for the Library list, but it is
 * far too coarse for an individual chat-message attachment card that just wants
 * to learn "my derivative (thumbnail) landed, re-fetch MY row". Re-pulling the
 * whole list does not even touch the message-attachment surface, because chat
 * attachments resolve their own preview by asset id (not the library list).
 *
 * So we add a thin in-process bus: page.tsx (the single owner of the SSE
 * connection) forwards every `asset.changed` envelope here via
 * `publishAssetChanged(assetId)`, and any `MessageAssetCard` (via the
 * `useAssetThumbnail` hook) subscribes to exactly its own asset id and
 * re-fetches `/api/im/assets/:id/detail` when its derivative lands.
 *
 * This is deliberately NOT another EventSource — there is already one per page;
 * adding a second would double the cloud SSE fan-out. We piggyback on the
 * existing connection and only fan out in-memory.
 */

type AssetChangedListener = (assetId: string) => void;

// Per-asset-id listener sets — keyed so a card subscribing to one asset id is
// not woken by every other asset's change.
const perAssetListeners = new Map<string, Set<AssetChangedListener>>();

/**
 * Forward an `asset.changed` signal into the bus. Called by the single
 * page-level SSE handler. No-op when no card is listening for that id.
 */
export function publishAssetChanged(assetId: string | null | undefined): void {
  if (!assetId) return;
  const set = perAssetListeners.get(assetId);
  if (!set || set.size === 0) return;
  for (const cb of set) {
    try {
      cb(assetId);
    } catch {
      // one listener throwing must not starve the rest
    }
  }
}

/**
 * Subscribe to `asset.changed` for a single asset id. Returns an unsubscribe
 * function. Safe to call with a null/empty id (returns a no-op disposer) so
 * hooks can call it unconditionally.
 */
export function subscribeAssetChanged(
  assetId: string | null | undefined,
  listener: AssetChangedListener,
): () => void {
  if (!assetId) return () => {};
  let set = perAssetListeners.get(assetId);
  if (!set) {
    set = new Set();
    perAssetListeners.set(assetId, set);
  }
  set.add(listener);
  return () => {
    const current = perAssetListeners.get(assetId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) perAssetListeners.delete(assetId);
  };
}

/** Test-only: drop all listeners. */
export function __resetAssetEventBusForTests(): void {
  perAssetListeners.clear();
}

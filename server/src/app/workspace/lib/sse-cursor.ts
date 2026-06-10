/**
 * Per-user, per-stream localStorage cursor for SSE replay (P2 2026-05-25).
 *
 * Keyed by `stream:<endpoint>:<userId>` so multiple workspaces / accounts
 * on the same browser don't cross-contaminate. Capped TTL of 24h — older
 * cursors are treated as expired and reset to 0 to avoid a stale client
 * triggering BACKFILL_CAP truncation every connect.
 *
 * Wire shape: callers persist the monotonic `seq` they see on `sync` events
 * (IMSyncEvent.id on the cloud), then pass it back via `&since=<seq>` on
 * EventSource reconnect. Server replays gap → live tail.
 *
 * Stream key conventions (used today):
 *   - 'sync'         — /api/im/sync/stream (workspace-wide fan-out)
 *   - 'tasks-events' — /api/im/tasks/events (task lifecycle SSE)
 */

const TTL_MS = 24 * 60 * 60 * 1000;

export function loadCursor(stream: string, userId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(cursorKey(stream, userId));
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { seq: number; ts: number };
    if (Date.now() - parsed.ts > TTL_MS) return 0;
    return Number.isFinite(parsed.seq) ? parsed.seq : 0;
  } catch {
    return 0;
  }
}

export function saveCursor(stream: string, userId: string, seq: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isFinite(seq) || seq <= 0) return;
  try {
    window.localStorage.setItem(cursorKey(stream, userId), JSON.stringify({ seq, ts: Date.now() }));
  } catch {
    /* private browsing / quota — silently degrade to "no cursor" */
  }
}

export function resetCursor(stream: string, userId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(cursorKey(stream, userId));
  } catch {
    /* ignore */
  }
}

function cursorKey(stream: string, userId: string): string {
  return `prismer.sse-cursor.${stream}.${userId}`;
}

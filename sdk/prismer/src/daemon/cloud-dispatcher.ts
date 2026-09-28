// Bounded global fetch dispatcher for the daemon process.
//
// WHY THIS EXISTS (APC gap C, 2026-07-25):
// The daemon's cloud HTTP client (`auth.ts CloudClient`) uses Node's built-in
// `fetch`, i.e. undici's *default* global Agent — which has NO cap on the number
// of connections it opens per origin. Under any request storm (e.g. a churning
// adopt/ownership loop re-firing memory-sync + transport-probe + skill-sync-ack
// on every `host.acked`, with no backoff) against a *slow* cloud (a local
// `npm run dev` server on HTTP/1.1), undici opens a brand-new socket per
// concurrent request instead of reusing a pooled one. The connections balloon
// (observed: a single daemon holding 345 idle ESTABLISHED sockets to :3000),
// which starves the single-threaded dev server's event loop — even a static
// route went 0.005s → 24s — and feeds a vicious cycle (slow server → 30s
// timeouts → retries → more sockets → slower). Deleting the daemon dropped the
// server's connections 711 → 5 and latency 24s → 5ms, isolating the cause to the
// daemon's unbounded pool.
//
// This installs a *bounded* undici Agent as the global dispatcher so no amount
// of churn can open more than `connections` sockets to cloud: excess requests
// queue inside undici (FIFO) instead of hammering the server with new sockets.
// It caps the blast radius structurally; it does NOT fix the upstream churn loop
// that generates the storm (that is a separate, deeper bug — see report).
//
// Scope notes:
//   - The daemon's WS transport uses the `ws` package (not undici), so it is
//     unaffected by this cap.
//   - The daemon's long-lived SSE subscriber DOES use `fetch`; it holds 1–2 of
//     the `connections` slots for the stream's lifetime, so the default cap
//     leaves ample headroom for sync fan-out.
//   - `asset-cache.ts` passes its own per-request `dispatcher` (with a DNS
//     `lookup` hook), which bypasses the global dispatcher — asset downloads are
//     not affected by this cap.

import { Agent, setGlobalDispatcher } from 'undici';

let installed = false;

function num(envVal: string | undefined, fallback: number): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Install a bounded global fetch dispatcher for this daemon process. Idempotent
 * — safe to call more than once (subsequent calls are no-ops).
 *
 * Tunable via env (ops kill-switches; defaults are sane for a local-first daemon
 * whose cloud sync is not latency-critical):
 *   - PRISMER_DAEMON_MAX_CLOUD_CONNECTIONS  (default 24) — max sockets per origin
 *   - PRISMER_DAEMON_CLOUD_KEEPALIVE_MS     (default 10000) — idle keep-alive
 */
export function installBoundedCloudDispatcher(log?: (msg: string) => void): void {
  if (installed) return;
  installed = true;

  const connections = num(process.env.PRISMER_DAEMON_MAX_CLOUD_CONNECTIONS, 24);
  const keepAliveTimeout = num(process.env.PRISMER_DAEMON_CLOUD_KEEPALIVE_MS, 10_000);

  const agent = new Agent({
    // Hard cap on concurrent sockets to any one origin (cloud). This is the leak
    // guard: a storm queues here instead of spawning unbounded connections.
    connections,
    // Reuse idle sockets rather than churning new ones; close them after this
    // idle window so we don't sit on 24 open sockets forever when idle.
    keepAliveTimeout,
    keepAliveMaxTimeout: 30_000,
    // The app-level AbortController in CloudClient (30–60s) governs request
    // lifetime; keep undici's own ceilings above it so they never pre-empt it.
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
  });

  setGlobalDispatcher(agent);
  log?.(
    `[daemon] bounded cloud dispatcher installed (connections=${connections} keepAlive=${keepAliveTimeout}ms)\n`,
  );
}

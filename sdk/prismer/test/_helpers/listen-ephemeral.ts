/**
 * Ephemeral listen ports for the runtime test suite (desktop205 O16-b).
 *
 * ## Why
 *
 * ~25 test files used to pick their listen port with `BASE + Math.random() *
 * RANGE`, and the ranges overlapped heavily (39000–41999). vitest runs test
 * files in parallel workers, so two files could be handed the same port and
 * one of them died with `listen EADDRINUSE`. Measured in a clean container:
 * **2 red runs out of 7**, a different file each time (`hook-server` /
 * `web-rpc` / `memory-write-w2`). Once `check_runtime_tests` went into CI this
 * stopped being a local annoyance and became a randomly red pipeline.
 *
 * ## The fix
 *
 * Bind with `listen(0)` and let the kernel assign the port, then read the
 * **actual** port back off the bound socket via `server.address()`. Two workers
 * can then never be handed the same port: the collision becomes structurally
 * impossible instead of merely improbable.
 *
 * ## What NOT to do if this ever goes red again
 *
 * Do not widen a random range, do not add a retry loop, and do not put
 * `retry: script_failure` on the CI job. All three convert a real defect into
 * silence, which is strictly worse than a red run. Go find the actual binder.
 */
import type { AddressInfo } from 'node:net';

/** Minimal shape of a bound node server (`http.Server` / `net.Server`). */
interface BoundServer {
  address(): AddressInfo | string | null;
}

function hasAddress(v: unknown): v is BoundServer {
  return typeof v === 'object' && v !== null && typeof (v as BoundServer).address === 'function';
}

/**
 * Read the port the kernel actually assigned to a listening server.
 *
 * Accepts either a bound node server, or a wrapper that keeps one in a
 * `server` field — `LocalServer` (src/daemon/local-server.ts) does. The field
 * is `private` in TypeScript, but this is a genuine `server.address()` read of
 * the live socket, not a guess; TS `private` is compile-time only.
 *
 * Throws loudly when the server is not listening yet or the wrapper shape
 * changed, so a refactor surfaces as a clear failure instead of silently
 * producing `http://127.0.0.1:undefined`.
 */
export function boundPort(target: unknown): number {
  const inner = hasAddress(target)
    ? target
    : hasAddress((target as { server?: unknown } | undefined)?.server)
      ? ((target as { server: BoundServer }).server as BoundServer)
      : undefined;
  if (!inner) {
    throw new Error(
      'boundPort(): no listening server found — pass a bound http/net server, ' +
        'or an object holding one in `.server` (did the wrapper shape change?)',
    );
  }
  const addr = inner.address();
  if (addr === null || typeof addr === 'string' || typeof addr.port !== 'number' || addr.port === 0) {
    throw new Error(
      `boundPort(): server is not listening on a TCP port yet (address() = ${JSON.stringify(addr)}) — ` +
        'call it after `await server.start()` / the `listen` callback',
    );
  }
  return addr.port;
}

/** `http://127.0.0.1:<the port the kernel actually assigned>`. */
export function boundBaseUrl(target: unknown): string {
  return `http://127.0.0.1:${boundPort(target)}`;
}

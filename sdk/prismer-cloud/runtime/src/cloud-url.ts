/**
 * Prismer Runtime — Cloud URL derivation
 *
 * Single source for building WSS URLs from the cloud HTTP base.
 * v1.9.0 decision: WSS relay reuses the main cloud host
 * (e.g. `cloud.prismer.dev` / `prismer.cloud`); there is no separate
 * relay subdomain. All relay/WS paths live under `/ws/*` on the same host.
 */

/**
 * Derive the base WSS URL from an HTTP(S) cloud base URL.
 *
 * Examples:
 *   https://cloud.prismer.dev      → wss://cloud.prismer.dev
 *   http://localhost:3000          → ws://localhost:3000
 *   https://prismer.cloud/         → wss://prismer.cloud
 *
 * Returns `undefined` when the input is falsy, so callers can gate WS
 * startup on "do we have a cloud base configured at all".
 */
export function deriveWsFromHttp(httpUrl: string | undefined): string | undefined {
  if (!httpUrl) return undefined;
  return httpUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
}

/**
 * Extract the host[:port] portion from a cloud base URL.
 *
 *   https://cloud.prismer.dev      → cloud.prismer.dev
 *   http://localhost:3000          → localhost:3000
 *
 * Used by probes that want a bare host tuple, not a full URL.
 */
export function deriveHostFromHttp(httpUrl: string | undefined): string | undefined {
  if (!httpUrl) return undefined;
  try {
    const u = new URL(httpUrl);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return undefined;
  }
}

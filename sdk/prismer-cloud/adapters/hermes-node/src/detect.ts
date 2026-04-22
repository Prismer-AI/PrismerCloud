/**
 * Probe a local Hermes gateway-mode instance for its Mode B /health endpoint.
 *
 * Called by autoRegisterHermes() before deciding Mode B vs CLI shim.
 * Defaults to `http://127.0.0.1:${HERMES_DEFAULT_PORT}/health`; callers can
 * pass an override for non-default deployments (config file or env var
 * DISPATCH_PORT on the Python side).
 *
 * Short timeout on purpose — this runs on daemon startup and must not
 * block for several seconds if Hermes isn't up.
 */

import {
  HERMES_DEFAULT_PORT,
  HERMES_HEALTH_PROBE_TIMEOUT_MS,
} from './defaults.js';

export interface DetectResult {
  /** True iff loopback /health returned 2xx within the timeout. */
  found: boolean;
  /** The loopback origin we probed (http://127.0.0.1:<port>). */
  loopbackUrl: string;
  /** Reason for a negative result — "timeout" / "refused" / "http_<status>" / "<error>". */
  reason?: string;
}

export interface DetectOptions {
  /** Override the port Hermes's dispatch adapter listens on. */
  port?: number;
  /** Override the timeout for the health probe (ms). */
  timeoutMs?: number;
  /** Inject a custom fetch for testing. */
  fetchImpl?: typeof fetch;
}

export async function detectHermesLoopback(
  opts: DetectOptions = {},
): Promise<DetectResult> {
  const port = opts.port ?? HERMES_DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? HERMES_HEALTH_PROBE_TIMEOUT_MS;
  const loopbackUrl = `http://127.0.0.1:${port}`;
  const healthUrl = `${loopbackUrl}/health`;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(healthUrl, { signal: controller.signal });
    if (!resp.ok) {
      return { found: false, loopbackUrl, reason: `http_${resp.status}` };
    }
    return { found: true, loopbackUrl };
  } catch (err) {
    const e = err as Error;
    // AbortError surfaces as DOMException on browsers, Error on Node 20+.
    const reason =
      e?.name === 'AbortError'
        ? 'timeout'
        : e?.message?.includes('ECONNREFUSED')
          ? 'refused'
          : e?.message || 'unknown_error';
    return { found: false, loopbackUrl, reason };
  } finally {
    clearTimeout(timer);
  }
}

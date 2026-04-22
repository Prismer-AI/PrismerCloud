/**
 * Prismer Runtime — Mode B AdapterImpl factory (v1.9.x Task 3).
 *
 * The "Mode B HTTP loopback" pattern from
 * docs/version190/22-adapter-integration-contract.md §3.2:
 *
 *   - The agent runtime (e.g. OpenClaw, Hermes) keeps a long-lived
 *     process alive and exposes a tiny HTTP listener on
 *     127.0.0.1:<port>.
 *   - On startup it POSTs to the daemon's
 *     /api/v1/adapters/register-mode-b endpoint to announce its
 *     loopback URL.
 *   - The daemon builds a Mode B AdapterImpl whose `dispatch()` is an
 *     HTTP POST to that loopback URL — this REPLACES whatever CLI
 *     shim auto-register installed.
 *
 * Why a *factory* and not a static module export: each registration
 * carries different metadata (adapter name, tiers, capability tags,
 * loopback URL) and the daemon needs to be able to register many
 * Mode B adapters dynamically. The factory keeps the AdapterImpl
 * shape uniform with the rest of the registry.
 *
 * Security boundary: only loopback URLs (http://127.0.0.1:<port>)
 * are accepted. Anything else is rejected at construction time so
 * a compromised plugin cannot point the daemon at a remote host.
 *
 * Failure vocabulary (per 22-adapter-integration-contract.md §4):
 *   mode_b_<status>          — non-2xx response from loopback
 *   mode_b_network:<msg>     — fetch/network error talking to loopback
 *   mode_b_invalid_response  — loopback returned non-JSON or malformed JSON
 */

import type {
  AdapterDispatchInput,
  AdapterDispatchResult,
  AdapterImpl,
} from '../adapter-registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModeBAdapterConfig {
  /** Adapter name (must match catalog name to compete with auto-register CLI shim). */
  name: string;
  /** Loopback URL the agent runtime is listening on. Must be http://127.0.0.1:<port>. */
  loopbackUrl: string;
  /** PARA tiers this adapter supports (e.g. [1,2,3,4,5,6]). */
  tiersSupported: number[];
  /** Capability tags the adapter advertises (e.g. ["code","shell"]). */
  capabilityTags: string[];
  /** Optional: per-dispatch HTTP timeout, default 30s. */
  timeoutMs?: number;
  /** Optional metadata propagated on the descriptor. */
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// validateLoopbackUrl
// ---------------------------------------------------------------------------

/**
 * Accept only http://127.0.0.1:<explicit-port> (origin only). Reject:
 *   - https (TLS on loopback adds attack surface; not needed)
 *   - non-127.0.0.1 hosts (including 'localhost' which can hijack via /etc/hosts)
 *   - implicit port (URL.port becomes '' when omitted)
 *   - non-http schemes (ftp://, etc.)
 *   - any pathname / search / hash components — these would let a compromised
 *     plug-in smuggle traffic to arbitrary local services. e.g.
 *     `http://127.0.0.1:6379/proxy?target=evil` would, after string-concat
 *     with `/dispatch`, become a request to a Redis-front proxy on the box.
 *     Origin-only is the only safe construction.
 */
export function validateLoopbackUrl(url: string): ValidationResult {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'loopback URL must be a non-empty string' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'loopback URL malformed' };
  }
  if (parsed.protocol !== 'http:') {
    return { ok: false, error: `loopback URL must use http: scheme, got ${parsed.protocol}` };
  }
  if (parsed.hostname !== '127.0.0.1') {
    return { ok: false, error: `loopback URL must point to 127.0.0.1, got ${parsed.hostname}` };
  }
  if (!parsed.port || parsed.port.length === 0) {
    return { ok: false, error: 'loopback URL must include an explicit port' };
  }
  // Origin-only: reject any pathname (other than '/' which `new URL()` injects),
  // query string, or fragment. Same defense as runner.ts §415 (localhost is the
  // boundary) — but only if we don't bridge into a non-empty path on this side.
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return { ok: false, error: 'loopback_url_must_be_origin_only:pathname not empty' };
  }
  if (parsed.search && parsed.search.length > 0) {
    return { ok: false, error: 'loopback_url_must_be_origin_only:search not empty' };
  }
  if (parsed.hash && parsed.hash.length > 0) {
    return { ok: false, error: 'loopback_url_must_be_origin_only:hash not empty' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// buildModeBAdapter
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildModeBAdapter(config: ModeBAdapterConfig): AdapterImpl {
  const validation = validateLoopbackUrl(config.loopbackUrl);
  if (!validation.ok) {
    throw new Error(`buildModeBAdapter: ${validation.error}`);
  }
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('buildModeBAdapter: name required');
  }

  // Use `new URL(path, base)` rather than string concatenation so that any
  // unexpected characters in the loopback URL can't get smuggled into the
  // dispatch path. validateLoopbackUrl already rejects non-origin URLs but
  // safer composition is cheap.
  const dispatchUrl = new URL('/dispatch', config.loopbackUrl).toString();
  const healthUrl = new URL('/health', config.loopbackUrl).toString();
  const resetUrl = new URL('/reset', config.loopbackUrl).toString();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const adapter: AdapterImpl = {
    name: config.name,
    tiersSupported: config.tiersSupported,
    capabilityTags: config.capabilityTags,
    ...(config.metadata
      ? { metadata: { ...config.metadata, transport: 'mode_b_http_loopback' } }
      : { metadata: { transport: 'mode_b_http_loopback' } }),

    async dispatch(input: AdapterDispatchInput): Promise<AdapterDispatchResult> {
      const body = serializeDispatchInput(input);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(dispatchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          let detail = '';
          try {
            detail = await resp.text();
            if (detail.length > 200) detail = detail.slice(0, 200) + '…';
          } catch {
            // ignore — body read failure is non-fatal for the failure path
          }
          return {
            ok: false,
            error: `mode_b_${resp.status}${detail ? `:${detail}` : ''}`,
          };
        }
        let parsed: unknown;
        try {
          parsed = await resp.json();
        } catch (err) {
          return {
            ok: false,
            error: `mode_b_invalid_response:${(err as Error).message}`,
          };
        }
        if (!parsed || typeof parsed !== 'object') {
          return {
            ok: false,
            error: 'mode_b_invalid_response:body not an object',
          };
        }
        // Pass through the response shape verbatim — the agent runtime
        // already constructed an AdapterDispatchResult.
        return parsed as AdapterDispatchResult;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        return { ok: false, error: `mode_b_network:${msg}` };
      } finally {
        clearTimeout(timer);
      }
    },

    async health() {
      try {
        const resp = await fetch(healthUrl, {
          signal: AbortSignal.timeout(2000),
        });
        return resp.ok ? { healthy: true } : { healthy: false, reason: `loopback_${resp.status}` };
      } catch (err) {
        return { healthy: false, reason: (err as Error).message };
      }
    },

    async reset(agentName?: string) {
      // v1.9.x agent_restart semantic: ask the adapter host to clear any
      // in-memory per-agent session state. 2s timeout matches health() above.
      // Failure is non-fatal — the caller will ack ok:false with a reason.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const resp = await fetch(resetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentName }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          return { ok: false, reason: `mode_b_reset_http_${resp.status}` };
        }
        let parsed: Record<string, unknown> = {};
        try {
          const body = await resp.json();
          if (body && typeof body === 'object') parsed = body as Record<string, unknown>;
        } catch {
          // Treat JSON parse failure as a soft success — the loopback
          // returned 2xx, so the reset itself worked; we just can't
          // surface whatever diagnostic it tried to send.
        }
        // Merge host-reported fields but force ok:true + a default state so
        // the ack path is deterministic even when the host omits them.
        return { ok: true, state: 'mode_b_reset', ...parsed };
      } catch (err) {
        return { ok: false, reason: 'mode_b_reset_network:' + (err as Error).message };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function serializeDispatchInput(input: AdapterDispatchInput): string {
  // Only pass through the v1 contract fields (don't leak internal state).
  const body: Record<string, unknown> = {
    taskId: input.taskId,
    capability: input.capability,
    prompt: input.prompt,
  };
  if (typeof input.stepIdx === 'number') body.stepIdx = input.stepIdx;
  if (typeof input.deadlineAt === 'number') body.deadlineAt = input.deadlineAt;
  if (input.metadata && typeof input.metadata === 'object') body.metadata = input.metadata;
  return JSON.stringify(body);
}

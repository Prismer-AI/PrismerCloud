/**
 * buildHermesAdapter — construct a Mode B HTTP loopback AdapterImpl
 * preconfigured with Hermes identity (name, tiers, capability tags).
 *
 * Thin wrapper around the generic Mode B transport — all the actual
 * dispatch/health logic lives here inline because @prismer/runtime
 * doesn't yet export its internal buildModeBAdapter factory. When
 * that export lands we'll switch to importing it; until then the
 * transport code is duplicated to keep this package self-contained.
 * Duplicated code is explicitly scoped (see "TRANSPORT" section below)
 * and small (~50 lines) — the cost of keeping a shared module loosely
 * coupled.
 */

import type {
  AdapterDispatchInput,
  AdapterDispatchResult,
  AdapterImpl,
} from './types.js';

import {
  HERMES_ADAPTER_NAME,
  HERMES_CAPABILITY_TAGS,
  HERMES_DEFAULT_PORT,
  HERMES_DEFAULT_TIMEOUT_MS,
  HERMES_TIERS_SUPPORTED,
} from './defaults.js';

export interface BuildHermesAdapterConfig {
  /** Override the adapter name. Defaults to "hermes". */
  name?: string;
  /** Port Hermes's gateway-mode dispatch adapter is listening on. */
  port?: number;
  /** Full loopback origin (overrides port if given). */
  loopbackUrl?: string;
  /** Override the PARA tiers advertised. */
  tiersSupported?: readonly number[];
  /** Override the capability tags advertised. */
  capabilityTags?: readonly string[];
  /** Per-dispatch HTTP timeout. Default 30s. */
  timeoutMs?: number;
  /** Extra metadata merged onto the descriptor. */
  metadata?: Record<string, unknown>;
  /** Inject a custom fetch for testing. */
  fetchImpl?: typeof fetch;
}

export function buildHermesAdapter(
  config: BuildHermesAdapterConfig = {},
): AdapterImpl {
  const loopbackUrl =
    config.loopbackUrl ??
    `http://127.0.0.1:${config.port ?? HERMES_DEFAULT_PORT}`;

  const validated = validateLoopbackOrigin(loopbackUrl);
  if (!validated.ok) {
    throw new Error(`buildHermesAdapter: ${validated.error}`);
  }

  const dispatchUrl = new URL('/dispatch', loopbackUrl).toString();
  const healthUrl = new URL('/health', loopbackUrl).toString();
  const timeoutMs = config.timeoutMs ?? HERMES_DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;

  const adapter: AdapterImpl = {
    name: config.name ?? HERMES_ADAPTER_NAME,
    tiersSupported: [...(config.tiersSupported ?? HERMES_TIERS_SUPPORTED)],
    capabilityTags: [...(config.capabilityTags ?? HERMES_CAPABILITY_TAGS)],
    metadata: {
      ...(config.metadata ?? {}),
      transport: 'mode_b_http_loopback',
      loopbackUrl,
    },

    // ──────────── TRANSPORT (duplicated from runtime/src/adapters/mode-b.ts) ────
    async dispatch(input: AdapterDispatchInput): Promise<AdapterDispatchResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetchImpl(dispatchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serializeDispatchInput(input),
          signal: controller.signal,
        });
        if (!resp.ok) {
          let detail = '';
          try {
            detail = await resp.text();
            if (detail.length > 200) detail = detail.slice(0, 200) + '…';
          } catch {
            // Ignore body read failures — status already tells us this is a miss.
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
          return { ok: false, error: 'mode_b_invalid_response:body not an object' };
        }
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
        const resp = await fetchImpl(healthUrl, {
          signal: AbortSignal.timeout(2000),
        });
        return resp.ok
          ? { healthy: true }
          : { healthy: false, reason: `loopback_${resp.status}` };
      } catch (err) {
        return { healthy: false, reason: (err as Error).message };
      }
    },
    // ──────────── END TRANSPORT ────────────────────────────────────────────────
  };

  return adapter;
}

// ─── local helpers ─────────────────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Mirror of runtime's validateLoopbackUrl — only accept
 * http://127.0.0.1:<explicit-port> origin. Rejects https, localhost,
 * other hosts, implicit port, non-empty pathname/search/hash.
 */
function validateLoopbackOrigin(url: string): ValidationResult {
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
    return { ok: false, error: `loopback URL must use http:, got ${parsed.protocol}` };
  }
  if (parsed.hostname !== '127.0.0.1') {
    return { ok: false, error: `loopback URL must point to 127.0.0.1, got ${parsed.hostname}` };
  }
  if (!parsed.port) {
    return { ok: false, error: 'loopback URL must include an explicit port' };
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return { ok: false, error: 'loopback URL must be origin-only (no pathname)' };
  }
  if (parsed.search) {
    return { ok: false, error: 'loopback URL must be origin-only (no search)' };
  }
  if (parsed.hash) {
    return { ok: false, error: 'loopback URL must be origin-only (no hash)' };
  }
  return { ok: true };
}

function serializeDispatchInput(input: AdapterDispatchInput): string {
  // Only pass through the v1 contract fields — don't leak internal state.
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

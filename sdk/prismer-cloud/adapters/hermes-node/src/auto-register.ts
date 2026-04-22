/**
 * autoRegisterHermes — probe the local Hermes Mode B endpoint and,
 * if reachable, register a Mode B AdapterImpl on the given registry.
 *
 * Call this from the runtime daemon's startup path AFTER the generic
 * autoRegisterAdapters() — that installs the CLI shim fallback; this
 * function upgrades Hermes specifically to Mode B when available.
 *
 * Contract:
 *   - probe /health at http://127.0.0.1:<port>
 *   - on success → build Mode B adapter, replace whatever "hermes"
 *     adapter is currently registered (CLI shim or otherwise)
 *   - on failure → no-op, log why at debug level so the daemon keeps
 *     using the existing fallback
 */

import { buildHermesAdapter, type BuildHermesAdapterConfig } from './build.js';
import { detectHermesLoopback } from './detect.js';
import { HERMES_ADAPTER_NAME } from './defaults.js';

// Minimal registry type — avoids a hard dep on the exact runtime version.
// Anything implementing `{ register, unregister? }` works.
export interface MinimalAdapterRegistry {
  register(adapter: unknown): void;
  unregister?(name: string): void;
  has?(name: string): boolean;
}

export interface AutoRegisterHermesOptions extends BuildHermesAdapterConfig {
  /** Probe timeout (ms). Default 500. */
  probeTimeoutMs?: number;
  /** Pre-replace an existing "hermes" adapter (CLI shim) when Mode B is reachable. Default true. */
  replaceExisting?: boolean;
  /** Inject a custom fetch for testing (detect + build both receive it). */
  fetchImpl?: typeof fetch;
}

export interface AutoRegisterHermesResult {
  /** True iff we installed a Mode B adapter. */
  installed: boolean;
  /** The loopback URL we probed. */
  loopbackUrl: string;
  /** Negative-path reason ("not_found:<detect_reason>" / "already_registered" / "register_failed:<msg>"). */
  reason?: string;
}

export async function autoRegisterHermes(
  registry: MinimalAdapterRegistry,
  opts: AutoRegisterHermesOptions = {},
): Promise<AutoRegisterHermesResult> {
  const replaceExisting = opts.replaceExisting ?? true;

  const probe = await detectHermesLoopback({
    port: opts.port,
    timeoutMs: opts.probeTimeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  if (!probe.found) {
    return {
      installed: false,
      loopbackUrl: probe.loopbackUrl,
      reason: `not_found:${probe.reason ?? 'unknown'}`,
    };
  }

  const name = opts.name ?? HERMES_ADAPTER_NAME;

  if (
    !replaceExisting &&
    typeof registry.has === 'function' &&
    registry.has(name)
  ) {
    return {
      installed: false,
      loopbackUrl: probe.loopbackUrl,
      reason: 'already_registered',
    };
  }

  if (
    replaceExisting &&
    typeof registry.has === 'function' &&
    typeof registry.unregister === 'function' &&
    registry.has(name)
  ) {
    registry.unregister(name);
  }

  const adapter = buildHermesAdapter({
    ...opts,
    loopbackUrl: probe.loopbackUrl,
  });

  try {
    registry.register(adapter);
  } catch (err) {
    return {
      installed: false,
      loopbackUrl: probe.loopbackUrl,
      reason: `register_failed:${(err as Error).message}`,
    };
  }

  return { installed: true, loopbackUrl: probe.loopbackUrl };
}

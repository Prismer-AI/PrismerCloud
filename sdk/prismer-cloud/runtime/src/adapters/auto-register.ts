/**
 * Prismer Runtime — Auto-register installed adapters (Sprint C1/C2).
 *
 * On daemon startup, walk the agent catalog, detect which agents are
 * actually installed on this machine, and register an AdapterImpl
 * (built via createCliAdapter) for each. This means cloud's TaskRouter
 * can immediately dispatch to whatever the user has installed without
 * any per-adapter wiring code in daemon-runner.
 *
 * Returns the list of registered adapter names (not just descriptors)
 * so the caller can log which ones came online.
 *
 * Per-adapter overrides
 *   ClaudeCode is the reference shape — see the per-adapter map below
 *   for any divergences (different CLI flag conventions, prompt path).
 *   Adapter teams that need richer integration should publish their
 *   own AdapterImpl module + register on init; this auto-registrar
 *   then yields to the user-supplied implementation.
 *
 * Hermes Mode B upgrade
 *   Hermes is special-cased: after the CLI shim is registered we opt-in
 *   to probe the local Hermes HTTP loopback (`@prismer/adapter-hermes`)
 *   and, if reachable, swap the CLI shim for the Mode B adapter. The
 *   `@prismer/adapter-hermes` dependency is resolved via dynamic import
 *   and is intentionally NOT listed in this package's dependencies —
 *   users opt in by installing it alongside @prismer/runtime. The
 *   fallback chain is: Mode B (if reachable) → CLI shim → nothing.
 *   Swap failures never break CLI-shim registration.
 */

import { AGENT_CATALOG } from '../agents/registry.js';
import type { AdapterRegistry, AdapterImpl } from '../adapter-registry.js';
import { createCliAdapter, type CliAdapterConfig } from './cli-adapter.js';

/**
 * Result of probing `@prismer/adapter-hermes` for a reachable Mode B
 * endpoint. `installed: true` means a Mode B AdapterImpl was registered
 * (replacing any CLI shim); anything else is a no-op.
 */
export interface HermesModeBProbeResult {
  installed: boolean;
  loopbackUrl?: string;
  reason?: string;
}

/**
 * Seam used to resolve + invoke `@prismer/adapter-hermes`. Production
 * code defaults to a dynamic-import-based resolver; tests inject their
 * own to exercise the hit / miss / not-installed branches without
 * depending on a live Hermes instance or the real package being on disk.
 */
export type HermesModeBResolver = (
  registry: AdapterRegistry,
) => Promise<HermesModeBProbeResult | null>;

export interface AutoRegisterOptions {
  /** When true, skip detection and assume every catalog entry is installed.
   *  Useful for tests + local dev where you want the registration path
   *  to run end-to-end without binaries being present. */
  skipDetection?: boolean;
  /** Override the catalog (for tests). Defaults to AGENT_CATALOG. */
  catalog?: typeof AGENT_CATALOG;
  /** Map of adapter-name → spawn config overrides. Useful when an
   *  adapter ships its own dispatch shape (different flags, stdin, etc.). */
  configOverrides?: Record<string, Partial<CliAdapterConfig>>;
  /** Override binary detection result entirely (tests). */
  forceBinaryFor?: Record<string, string>;
  /** Disable the Hermes Mode B upgrade probe — force the CLI shim. Default false. */
  skipHermesModeB?: boolean;
  /** Injectable probe for Hermes Mode B. Defaults to dynamic-importing
   *  `@prismer/adapter-hermes` and calling its `autoRegisterHermes()`. */
  resolveHermesModeB?: HermesModeBResolver;
}

export interface RegisteredEntry {
  name: string;
  binary: string;
  /** Which code path produced this registration. Defaults to "cli_shim"
   *  for adapters registered by the generic catalog path; "mode_b" means
   *  a per-adapter module (currently only Hermes) replaced the shim. */
  source?: 'cli_shim' | 'mode_b';
}

export interface AutoRegisterResult {
  registered: RegisteredEntry[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Per-adapter quirks. Default behavior (`promptVia: 'last-arg'`) works
 * for Claude Code + Codex + OpenClaw out of the box. Hermes is a Python
 * server and prefers stdin; the contract is documented separately
 * (Sprint C3) — this map applies to the local CLI shim only.
 */
const PER_ADAPTER_DEFAULTS: Record<string, Partial<CliAdapterConfig>> = {
  hermes: { promptVia: 'stdin' },
};

/**
 * Default resolver: dynamic-import `@prismer/adapter-hermes` and invoke
 * its autoRegisterHermes(). Returns `null` when the package isn't
 * installed (`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`). Any other
 * failure is surfaced as `{ installed: false, reason }` so the caller
 * can log it but keep the CLI shim.
 */
// Shape of the bit of `@prismer/adapter-hermes` we consume. Kept as a
// local type so this package doesn't need a compile-time dependency on
// the adapter (it's dynamic-imported at runtime and not listed in deps).
interface HermesAdapterModule {
  autoRegisterHermes(
    registry: unknown,
    opts?: unknown,
  ): Promise<{
    installed: boolean;
    loopbackUrl?: string;
    reason?: string;
  }>;
}

const defaultHermesModeBResolver: HermesModeBResolver = async (registry) => {
  let mod: HermesAdapterModule;
  try {
    // NOTE: @prismer/adapter-hermes is NOT listed in this package's deps —
    // users install it separately if they want Hermes Mode B. A missing
    // module here is the expected common case, not an error. The
    // specifier goes through a variable so bundlers don't try to resolve
    // it eagerly at build time.
    const specifier = '@prismer/adapter-hermes';
    mod = (await import(specifier)) as HermesAdapterModule;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      return null;
    }
    return {
      installed: false,
      reason: `import_failed:${(err as Error).message}`,
    };
  }

  try {
    const res = await mod.autoRegisterHermes(registry);
    return {
      installed: res.installed,
      loopbackUrl: res.loopbackUrl,
      reason: res.reason,
    };
  } catch (err) {
    return {
      installed: false,
      reason: `probe_failed:${(err as Error).message}`,
    };
  }
};

export async function autoRegisterAdapters(
  registry: AdapterRegistry,
  opts: AutoRegisterOptions = {},
): Promise<AutoRegisterResult> {
  const catalog = opts.catalog ?? AGENT_CATALOG;
  const result: AutoRegisterResult = { registered: [], skipped: [] };

  for (const entry of catalog) {
    // If the adapter is already registered (e.g. an out-of-band module
    // beat us to it), respect that — don't replace user code with a stub.
    if (registry.has(entry.name)) {
      result.skipped.push({ name: entry.name, reason: 'already_registered' });
      continue;
    }

    let binary: string | undefined;
    if (opts.forceBinaryFor && opts.forceBinaryFor[entry.name]) {
      binary = opts.forceBinaryFor[entry.name];
    } else if (opts.skipDetection) {
      // Fake it — use the catalog's `upstreamBinary` as if `which` returned it.
      binary = entry.upstreamBinary;
    } else {
      try {
        const detected = await entry.detect();
        if (!detected.found || !detected.binaryPath) {
          result.skipped.push({ name: entry.name, reason: 'not_installed' });
          continue;
        }
        binary = detected.binaryPath;
      } catch (err) {
        result.skipped.push({ name: entry.name, reason: `detect_failed:${(err as Error).message}` });
        continue;
      }
    }

    const baseConfig: CliAdapterConfig = {
      name: entry.name,
      binary,
      tiersSupported: entry.tiersSupported,
      capabilityTags: entry.capabilityTags,
      ...(PER_ADAPTER_DEFAULTS[entry.name] ?? {}),
      ...(opts.configOverrides?.[entry.name] ?? {}),
    };

    const adapter: AdapterImpl = createCliAdapter(baseConfig);
    try {
      registry.register(adapter);
      result.registered.push({ name: entry.name, binary, source: 'cli_shim' });
    } catch (err) {
      result.skipped.push({ name: entry.name, reason: `register_failed:${(err as Error).message}` });
    }
  }

  // --- Hermes Mode B upgrade probe ---------------------------------
  // The CLI shim above is the always-available fallback. If the user
  // installed @prismer/adapter-hermes AND has a reachable Hermes gateway,
  // swap the shim for the Mode B adapter. Any failure (package missing,
  // probe timeout, network error, etc.) keeps the CLI shim intact.
  const hermesEntryIdx = result.registered.findIndex((r) => r.name === 'hermes');
  if (hermesEntryIdx >= 0 && !opts.skipHermesModeB) {
    const resolve = opts.resolveHermesModeB ?? defaultHermesModeBResolver;
    try {
      const probe = await resolve(registry);
      if (probe === null) {
        console.log(
          '[AutoRegister] @prismer/adapter-hermes not installed; Hermes stays on CLI shim',
        );
      } else if (probe.installed) {
        result.registered[hermesEntryIdx].source = 'mode_b';
        console.log(
          `[AutoRegister] Hermes upgraded to Mode B at ${probe.loopbackUrl ?? 'loopback'}`,
        );
      } else {
        console.log(
          `[AutoRegister] Hermes Mode B unavailable (${probe.reason ?? 'unknown'}); keeping CLI shim`,
        );
      }
    } catch (err) {
      // Absolute last-resort guard — the default resolver already
      // catches its own errors, so this only trips if a custom resolver
      // throws. Never let it fail the whole auto-register call.
      console.warn(
        `[AutoRegister] Hermes Mode B probe threw: ${(err as Error).message}; keeping CLI shim`,
      );
    }
  }

  return result;
}

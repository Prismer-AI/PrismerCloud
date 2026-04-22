/**
 * @prismer/adapter-hermes — runtime-side Mode B adapter for NousResearch Hermes.
 *
 * This package is the **Node.js** half of the Hermes PARA bridge. It runs
 * inside the Prismer runtime daemon (@prismer/runtime) and forwards
 * dispatched task steps to a local Hermes gateway-mode instance over HTTP
 * loopback (http://127.0.0.1:<port>/dispatch).
 *
 * The **Python** half — `prismer-adapter-hermes` on PyPI — runs inside
 * Hermes itself. It translates Hermes hooks to PARA events (outbound)
 * and (starting in 0.2.0) hosts the /dispatch HTTP server (inbound).
 *
 * Typical daemon integration:
 *
 *   import { autoRegisterHermes } from '@prismer/adapter-hermes';
 *   const result = await autoRegisterHermes(registry);
 *   if (result.installed) {
 *     log.info(`Hermes Mode B adapter installed at ${result.loopbackUrl}`);
 *   } else {
 *     log.debug(`Hermes Mode B not available (${result.reason}); using CLI shim fallback`);
 *   }
 *
 * See docs/version190/22-adapter-integration-contract.md §3.2 for the
 * full contract specification.
 */

export type {
  AdapterDescriptor,
  AdapterDispatchInput,
  AdapterDispatchResult,
  AdapterImpl,
} from './types.js';

export {
  HERMES_ADAPTER_NAME,
  HERMES_DEFAULT_PORT,
  HERMES_TIERS_SUPPORTED,
  HERMES_CAPABILITY_TAGS,
  HERMES_DEFAULT_TIMEOUT_MS,
  HERMES_HEALTH_PROBE_TIMEOUT_MS,
} from './defaults.js';

export { detectHermesLoopback } from './detect.js';
export type { DetectResult, DetectOptions } from './detect.js';

export { buildHermesAdapter } from './build.js';
export type { BuildHermesAdapterConfig } from './build.js';

export { autoRegisterHermes } from './auto-register.js';
export type {
  AutoRegisterHermesOptions,
  AutoRegisterHermesResult,
  MinimalAdapterRegistry,
} from './auto-register.js';

/**
 * Hermes-specific defaults for the Mode B HTTP loopback adapter.
 *
 * These must stay in sync with the Python side (prismer-adapter-hermes)
 * — particularly HERMES_DEFAULT_PORT, which the Python process binds
 * when it starts its /dispatch server. The shared constant lives here
 * for now and is duplicated in Python (prismer_adapter_hermes.dispatch)
 * when that module is added in v0.2.0.
 */

/** npm package name — must match package.json "name" field. */
export const HERMES_ADAPTER_NAME = 'hermes';

/**
 * Default port for the Hermes gateway-mode /dispatch HTTP listener.
 * Chosen from the IANA "dynamic / private port" range (49152–65535)
 * above common service collisions. Configurable at both ends if a
 * port collision occurs — see buildHermesAdapter({ port }).
 */
export const HERMES_DEFAULT_PORT = 8765;

/** PARA tiers Hermes advertises. Matches descriptor.py. */
export const HERMES_TIERS_SUPPORTED: readonly number[] = [1, 2, 3, 4];

/** Capability tags Hermes advertises. Matches descriptor.py. */
export const HERMES_CAPABILITY_TAGS: readonly string[] = [
  'code',
  'llm',
  'cache-safe-inject',
];

/** Default HTTP timeout for a single dispatch call (ms). */
export const HERMES_DEFAULT_TIMEOUT_MS = 30_000;

/** Health-probe timeout (ms). Kept short so daemon startup isn't blocked. */
export const HERMES_HEALTH_PROBE_TIMEOUT_MS = 500;

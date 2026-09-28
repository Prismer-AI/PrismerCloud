/**
 * terminal-sessions/pty-loader.ts — G2-R R-2 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-2).
 *
 * Lazy node-pty loader. node-pty is a NATIVE addon and is deliberately never
 * carried by the OTA runtime bundle (JS-only contract:
 * scripts/ops/build-daemon-runtime-bundle.ts assertNoNativePayload dies on any
 * `.node` file; staging npm ci runs --ignore-scripts). It reaches a pod
 * through the frozen image's native ABI floor instead —
 * /opt/prismer/native/node_modules, the better-sqlite3 precedent
 * (infra/sandbox-image/Dockerfile.base floor install +
 * install-builtin-runtime.mjs `--native-module-root` borrowing) — and through
 * the sdk/prismer devDependencies for local dev/test.
 *
 * Two-path resolution, memoized on the production call:
 *   1. regular require — dev/test (devDependency) and image-built builtin
 *      runtimes (the floor copy is linked into the runtime's node_modules at
 *      install time);
 *   2. the floor module root — OTA-extracted bundles stay JS-only, so the
 *      floor directory is required directly by path;
 *   null ⇒ the caller MUST degrade: no `runtime.terminal` capability claim
 *   and terminal.open answered with the typed `terminal_unavailable`
 *   rejection. Never fabricate a pty.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Lazy type alias — node-pty is never statically imported at runtime. */
export type PtyModule = typeof import('node-pty');

/**
 * Frozen-image native ABI floor npm prefix (infra/sandbox-image/Dockerfile.base
 * installs pinned npm packages there). Overridable per call for tests; pods
 * always use the default.
 */
export const NATIVE_FLOOR_ROOT = '/opt/prismer/native/node_modules';

export interface LoadPtyDeps {
  /** require seam — defaults to createRequire(import.meta.url). */
  require?: (id: string) => unknown;
  /** Floor npm prefix tried second. Defaults to NATIVE_FLOOR_ROOT. */
  floorRoot?: string;
}

let memoized: { value: PtyModule | null } | undefined;

export function loadPty(deps?: LoadPtyDeps): PtyModule | null {
  // Only the production path (no injected seams) is memoized — an injected
  // failure must never poison the real resolution.
  if (deps === undefined) {
    if (memoized) return memoized.value;
    const value = resolvePty({});
    memoized = { value };
    return value;
  }
  return resolvePty(deps);
}

function resolvePty(deps: LoadPtyDeps): PtyModule | null {
  const req = deps.require ?? createRequire(import.meta.url);
  for (const candidate of ['node-pty', join(deps.floorRoot ?? NATIVE_FLOOR_ROOT, 'node-pty')]) {
    try {
      const mod = req(candidate) as PtyModule | undefined;
      if (mod && typeof mod.spawn === 'function') return mod;
    } catch {
      /* try the next path */
    }
  }
  return null;
}

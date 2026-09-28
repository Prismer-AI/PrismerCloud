// Canonical path-jail primitives for the daemon's reverse-RPC surface.
//
// Both properties below are security predicates shared by more than one RPC
// (`agent.git.exec`, `agent.workdir.materialize`, `agent.fs.*`). They live in
// ONE module because a duplicated security predicate drifts — one copy gets
// hardened, the other stays exploitable.
//
//   1. `isSafeSegment` — a path SEGMENT that arrives in a payload (workspaceId,
//      folder name) must not be able to move the jail ROOT. `path.join` and
//      `path.resolve` normalize `..`, so `join(workspacesDir, 'ws_A/..')`
//      silently lifts the root to `workspacesDir` and the jail then contains
//      every workspace on the host.
//
//   2. `resolveWithinJail` — containment must be decided on REALPATHS. A purely
//      lexical `path.resolve` comparison is defeated by a symlink planted
//      inside the root, and the party that can plant one is exactly the party
//      the jail exists to contain: the coding agent has full write access to
//      its own workdir.

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** True when `name` is a single safe folder segment (no separators / traversal). */
export function isSafeSegment(name: string | undefined): name is string {
  if (typeof name !== 'string') return false;
  if (name.trim().length === 0) return false;
  if (name === '.' || name === '..') return false;
  return !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

/**
 * `fs.realpathSync` for a path that may not exist yet.
 *
 * A `clone` / `init` target does not exist at check time, and `realpathSync`
 * throws ENOENT for it — so resolve the longest EXISTING ancestor and re-append
 * the missing tail. Symlinks anywhere in the existing prefix are therefore
 * still resolved, which is the whole point; only components that cannot exist
 * (and so cannot be symlinks) stay lexical.
 */
export function realpathBestEffort(p: string): string {
  const abs = path.resolve(p);
  let current = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      if (tail.length === 0) return real;
      tail.reverse();
      return path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return abs;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `target` (absolute, or relative to `root`) and require that it is
 * `root` itself or lives strictly underneath it — comparing REALPATHS on both
 * sides, so neither a symlinked root nor a symlink planted inside it can move
 * the boundary.
 *
 * Returns the resolved REAL path so the caller runs against the resolved
 * location rather than back through the symlink (which would leave a window to
 * re-point it between the check and the use).
 */
export function resolveWithinJail(
  root: string,
  target: string,
): { ok: true; path: string } | { ok: false } {
  const realRoot = realpathBestEffort(root);
  const realTarget = realpathBestEffort(path.resolve(realRoot, target));
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return { ok: false };
  }
  return { ok: true, path: realTarget };
}

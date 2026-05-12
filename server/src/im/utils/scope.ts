/**
 * Scope utility — legacy compatibility shim.
 *
 * v1.8.x semantics (history): `scope: 'global' | 'ws_{workspaceId}'` was a
 * string convention used to isolate per-workspace data on tables that had
 * no real `workspace_id` FK. The 1.9.x track-A refactor replaced this with
 * a proper `workspaceId` FK and dropped the `scope` column entirely in
 * migration 120 (m3 phase 2).
 *
 * These helpers stay as **no-ops** for the legacy call sites that still
 * thread a scope parameter through their signatures — they no longer
 * touch the Prisma WHERE / CREATE shape so the dropped column is never
 * referenced. Function signatures continue to accept `scope: string` so
 * caller code doesn't have to refactor synchronously; the value is simply
 * ignored.
 *
 * `withWorkspaceOrScope` and `withWorkspaceCreate` (from m2 phase 1) are
 * also retained as no-ops for the same reason — m3+ services that already
 * adopted them in m2 keep working.
 */

/** Legacy: was scope filter; now no-op (scope column is gone). */
export function withScope(where: Record<string, any>, _scope: string): Record<string, any> {
  return where;
}

/** Legacy: was scope writer; now strips scope from create data. */
export function withScopeCreate(data: Record<string, any>, _scope: string): Record<string, any> {
  // Strip any caller-provided scope so it doesn't reach the Prisma client.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { scope, ...rest } = data;
  return rest;
}

/** Validate scope string format (still useful for incoming API params). */
export function isValidScope(scope: string): boolean {
  return scope === 'global' || /^ws_[a-zA-Z0-9_-]+$/.test(scope);
}

/**
 * v1.9.2 Phase 1 dual-read filter — now a workspace-only filter.
 * After m3 phase 2 (migration 120) the `scope` column is gone; we only
 * filter on `workspaceId` if the caller provides one. Otherwise no-op.
 */
export function withWorkspaceOrScope(
  where: Record<string, any>,
  opts: { workspaceId?: string | null; scope?: string },
): Record<string, any> {
  if (opts.workspaceId) return { ...where, workspaceId: opts.workspaceId };
  return where;
}

/**
 * Inject workspaceId into create data. Strips any legacy `scope` field.
 */
export function withWorkspaceCreate(
  data: Record<string, any>,
  opts: { workspaceId?: string | null; scope?: string },
): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { scope, ...rest } = data;
  const out: Record<string, any> = { ...rest };
  if (opts.workspaceId) out.workspaceId = opts.workspaceId;
  return out;
}

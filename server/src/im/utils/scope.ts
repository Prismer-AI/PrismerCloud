/**
 * Scope utility — data domain isolation helpers.
 *
 * Scope values:
 *   "global"         — platform-wide (default, backward compat)
 *   "ws_{workspaceId}" — workspace-scoped private domain
 */

const MULTI_TENANT = () => process.env.MULTI_TENANT === 'true';

/**
 * Add scope filter to a Prisma WHERE clause.
 * When MULTI_TENANT=false (default), global scope queries are unfiltered.
 * When MULTI_TENANT=true, non-global scopes see own scope + global.
 */
export function withScope(where: Record<string, any>, scope: string): Record<string, any> {
  if (scope === 'global' && !MULTI_TENANT()) return where;
  return { ...where, scope: scope === 'global' ? 'global' : { in: [scope, 'global'] } };
}

/**
 * Add scope to a Prisma CREATE data object.
 */
export function withScopeCreate(data: Record<string, any>, scope: string): Record<string, any> {
  return { ...data, scope };
}

/**
 * Validate scope string format.
 */
export function isValidScope(scope: string): boolean {
  return scope === 'global' || /^ws_[a-zA-Z0-9_-]+$/.test(scope);
}

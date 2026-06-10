/**
 * Phase 1 admin RBAC — env-driven email allowlist with dev fallback.
 *
 * Phase 1 deliberate shortcut matching luminpulse's `cluster-admin.ts`
 * pattern. Phase 2 replaces with `im_workspace_members.role` driven RBAC.
 *
 * Allowlist sources (in priority order):
 *   1. `ADMIN_EMAILS` env var (comma-separated, lowercased) — set via
 *      Nacos / .env.local so test / prod can configure without redeploy.
 *   2. Hardcoded fallback (empty by default; append below for emergencies).
 *
 * Dev fallback (`NODE_ENV !== 'production'`):
 *   - `isSandboxAdmin()` short-circuits to `true` regardless of email so
 *     local-dev devices without NextAuth sessions can hit `_admin/*` routes
 *     via `x-dev-user-id` header. Production behaviour is unchanged.
 */

function loadAdminEmails(): Set<string> {
  const fromEnv = process.env.ADMIN_EMAILS;
  if (fromEnv) {
    return new Set(
      fromEnv
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  // Self-host: neutral fallback — INIT_ADMIN_EMAIL (matches the analytics
  // route's bootstrap admin), defaulting to admin@localhost. Env ADMIN_EMAILS
  // is still the production source of truth.
  return new Set<string>([
    (process.env.INIT_ADMIN_EMAIL || 'admin@localhost').toLowerCase(),
  ]);
}

const ADMIN_EMAILS = loadAdminEmails();

export function isSandboxAdmin(email: string | null | undefined): boolean {
  // F9 (2026-05-19) — dev mode short-circuit so the local sandbox-metrics +
  // resources routes (which gate on NextAuth session) are reachable in dev
  // even when ADMIN_EMAILS is empty. Production: unchanged.
  if (process.env.NODE_ENV !== 'production') return true;
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase());
}

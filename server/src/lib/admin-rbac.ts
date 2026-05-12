/**
 * Phase 1 admin RBAC — hardcoded email allowlist.
 *
 * This is a deliberate Phase 1 shortcut matching luminpulse's
 * `cluster-admin.ts` pattern. Phase 2 replaces with
 * `im_workspace_members.role` driven RBAC.
 *
 * To add an admin: append email below + redeploy. Source-controlled
 * audit trail (no UI / DB modification).
 */

const ADMIN_EMAILS = new Set<string>([
  // Add admin emails here. Example:
  // 'admin@prismer.dev',
]);

export function isSandboxAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase());
}

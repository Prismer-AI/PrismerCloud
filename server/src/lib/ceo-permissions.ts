/**
 * CEO permissions helper — §30 §2.8.6 + §31 §2.1.
 *
 * Stores per-user CEO authorization under `im_users.metadata.ceoPermissions`:
 *   {
 *     canCreateAgents: boolean,
 *     canDispatch:     boolean,
 *   }
 *
 * `IMUser.metadata` is a single `String?` (text) column in both SQLite and
 * MySQL schemas (`prisma/schema.prisma` / `schema.mysql.prisma`). We JSON
 * parse/stringify around it, preserving all other metadata sub-keys on
 * write so we never clobber sibling state (e.g. `preferredCreationMode`).
 *
 * No SQL migration needed — the column already exists and other code
 * already writes JSON-encoded blobs into it.
 *
 * Scope note (per spec): for now CEO permissions are stored on the calling
 * user's IM row; workspace-scoped overrides are a §31 follow-up. The
 * `workspaceId` argument is reserved for that future shape — callers can
 * pass it today but it is intentionally ignored when reading/writing.
 */
import prisma from '@/lib/prisma';

// `prisma` is dynamically resolved (SQLite vs MySQL) and typed as `any` in
// the singleton — narrow it here to just the `iMUser` shape we care about,
// so the helper bodies don't need inline `as any` casts.
interface IMUserDelegate {
  findUnique(args: { where: { id: string }; select: { metadata: true } }): Promise<{ metadata: string | null } | null>;
  update(args: { where: { id: string }; data: { metadata: string } }): Promise<unknown>;
}

function imUser(): IMUserDelegate {
  return (prisma as unknown as { iMUser: IMUserDelegate }).iMUser;
}

export interface CeoPermissions {
  canCreateAgents: boolean;
  canDispatch: boolean;
}

export const DEFAULT_CEO_PERMISSIONS: CeoPermissions = {
  canCreateAgents: false,
  canDispatch: false,
};

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // metadata is documented as JSON but historically anything could land
    // here; treat unparseable values as "no metadata" rather than throwing.
    return {};
  }
}

function readPermissionsFromMetadata(metadata: Record<string, unknown>): CeoPermissions {
  const node = metadata.ceoPermissions;
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ...DEFAULT_CEO_PERMISSIONS };
  }
  const obj = node as Record<string, unknown>;
  return {
    canCreateAgents: obj.canCreateAgents === true,
    canDispatch: obj.canDispatch === true,
  };
}

/**
 * Read the calling user's CEO permissions. Missing or malformed metadata
 * resolves to `{ canCreateAgents: false, canDispatch: false }`.
 *
 * **Fail-loud on missing row.** If the IM user row does not exist we throw
 * — `!row` means upstream auth handed us an id that has no `im_users`
 * record (user deleted / migration broken / auth ↔ IM split). Silently
 * returning defaults would, after §31 dispatch enforcement lands, make a
 * previously-authorized CEO appear to suddenly lose permissions with zero
 * signal. Match `setCeoPermissions` semantics — both throw, route handler
 * decides the HTTP status.
 *
 * `workspaceId` is reserved for future per-workspace overrides (§31) and
 * currently ignored — callers can pass it today without breaking when
 * scope-isolation lands.
 */
export async function getCeoPermissions(userId: string, workspaceId?: string): Promise<CeoPermissions> {
  void workspaceId;
  const row = await imUser().findUnique({
    where: { id: userId },
    select: { metadata: true },
  });
  if (!row) {
    throw new Error(`User not found: ${userId}`);
  }
  return readPermissionsFromMetadata(parseMetadata(row.metadata));
}

/**
 * Merge-update CEO permissions on the user's metadata. Other metadata
 * keys (preferredCreationMode, etc.) are preserved verbatim — we only
 * touch the `ceoPermissions` sub-object.
 */
export async function setCeoPermissions(
  userId: string,
  perms: Partial<CeoPermissions>,
  workspaceId?: string,
): Promise<CeoPermissions> {
  void workspaceId;
  const row = await imUser().findUnique({
    where: { id: userId },
    select: { metadata: true },
  });
  if (!row) {
    throw new Error(`User not found: ${userId}`);
  }
  const metadata = parseMetadata(row.metadata);
  const existing = readPermissionsFromMetadata(metadata);
  const merged: CeoPermissions = {
    canCreateAgents: typeof perms.canCreateAgents === 'boolean' ? perms.canCreateAgents : existing.canCreateAgents,
    canDispatch: typeof perms.canDispatch === 'boolean' ? perms.canDispatch : existing.canDispatch,
  };
  const nextMetadata = { ...metadata, ceoPermissions: merged };
  await imUser().update({
    where: { id: userId },
    data: { metadata: JSON.stringify(nextMetadata) },
  });
  return merged;
}

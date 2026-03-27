/**
 * Prismer IM — User Resolution Utility
 *
 * Resolves a user identifier (IM User ID, username, or Cloud User ID)
 * to an IM User ID. Used by direct.ts and groups.ts to accept flexible
 * user references in API endpoints.
 */

import prisma from '../db';

/**
 * Resolve a target user by IM User ID, username, or Cloud User ID.
 * Returns the IM User ID if found, null otherwise.
 */
export async function resolveTargetUser(target: string): Promise<string | null> {
  // Try by IM User ID
  let user = await prisma.iMUser.findUnique({ where: { id: target } });
  if (user) return user.id;

  // Try by username
  user = await prisma.iMUser.findUnique({ where: { username: target } });
  if (user) return user.id;

  // Try by Cloud User ID
  user = await prisma.iMUser.findFirst({ where: { userId: target } });
  if (user) return user.id;

  return null;
}

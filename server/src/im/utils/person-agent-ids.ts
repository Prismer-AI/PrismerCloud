/**
 * Person-level sync: find all IM agent IDs belonging to the same Cloud User.
 * Enables gene/workspace sharing across agent instances for the same person.
 */
import prisma from '../db';

export async function getPersonAgentIds(imUserId: string): Promise<string[]> {
  try {
    const self = await prisma.iMUser.findUnique({
      where: { id: imUserId },
      select: { userId: true },
    });
    if (!self?.userId) return [imUserId];
    const siblings = await prisma.iMUser.findMany({
      where: { userId: self.userId },
      select: { id: true },
    });
    const ids = siblings.map((s: { id: string }) => s.id);
    return ids.length > 0 ? ids : [imUserId];
  } catch {
    return [imUserId];
  }
}

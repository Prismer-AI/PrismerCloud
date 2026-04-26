/**
 * Anti-Cheat Service
 *
 * Rule-based fraud detection embedded in leaderboard computation.
 * Rules are applied at aggregation time, not post-hoc.
 */

import prisma from '../db';

export interface AntiCheatResult {
  excluded: number;
  flagged: number;
  rules: Record<string, number>;
}

/**
 * Check if a capsule should be flagged as suspicious.
 * Called during capsule recording (real-time).
 */
export async function checkCapsuleSuspicion(ownerAgentId: string, signalKey: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await prisma.iMEvolutionCapsule.count({
    where: {
      ownerAgentId,
      signalKey,
      createdAt: { gte: oneHourAgo },
    },
  });

  if (recentCount > 20) {
    await logAntiCheat('frequency_spike', 'capsule', ownerAgentId, {
      signalKey,
      count: recentCount,
      window: '1h',
    });
    return true;
  }
  return false;
}

/**
 * Filter capsules for leaderboard computation.
 * Returns set of capsule IDs to exclude.
 */
export async function getExcludedCapsuleIds(
  capsules: Array<{
    id: string;
    ownerAgentId: string;
    geneId: string;
    signalKey: string;
    createdAt: Date;
    metadata?: string;
  }>,
): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (capsules.length === 0) return excluded;

  // Derive time range from input capsules to avoid full-table scan
  const earliest = capsules.reduce((min, c) => (c.createdAt < min ? c.createdAt : min), capsules[0].createdAt);
  // Look back 90 days before the earliest capsule (generous window)
  const lookbackStart = new Date(earliest.getTime() - 90 * 24 * 60 * 60 * 1000);

  // 1. Query anti-cheat log for capsule-type entries that are excluded or flagged (not cleared)
  const flaggedLogs = await prisma.iMAntiCheatLog.findMany({
    where: {
      entityType: 'capsule',
      action: { in: ['excluded', 'flagged'] },
      createdAt: { gte: lookbackStart },
    },
    select: { entityId: true, detail: true },
  });

  // Build a set of flagged agent+signalKey combos from the log
  const flaggedKeys = new Set<string>();
  for (const log of flaggedLogs) {
    try {
      const detail = JSON.parse(log.detail);
      const signalKey = detail.signalKey as string | undefined;
      if (signalKey) {
        flaggedKeys.add(`${log.entityId}:${signalKey}`);
      } else {
        // If no signalKey in detail, flag all capsules from this entity
        flaggedKeys.add(log.entityId);
      }
    } catch {
      flaggedKeys.add(log.entityId);
    }
  }

  // 2. Check each capsule against flagged entries and metadata.suspicious
  for (const c of capsules) {
    // Check anti-cheat log matches (agent+signalKey combo or agent-only)
    if (flaggedKeys.has(`${c.ownerAgentId}:${c.signalKey}`) || flaggedKeys.has(c.ownerAgentId)) {
      excluded.add(c.id);
      continue;
    }

    // Check metadata.suspicious flag set during capsule recording
    if (c.metadata) {
      try {
        const meta = JSON.parse(c.metadata);
        if (meta.suspicious === true) {
          excluded.add(c.id);
        }
      } catch {
        // Invalid metadata JSON — skip
      }
    }
  }

  return excluded;
}

/**
 * Check anti-cheat rules for gene quality gate.
 */
export async function isGeneEligibleForRanking(geneId: string): Promise<boolean> {
  const gene = await prisma.iMGene.findUnique({
    where: { id: geneId },
    select: { qualityScore: true, breakerState: true },
  });
  if (!gene) return false;
  if (gene.qualityScore < 0.3) return false;
  if (gene.breakerState === 'open') return false;
  return true;
}

/**
 * Check minimum threshold for agent leaderboard eligibility.
 *
 * Dynamic thresholds based on candidate pool size:
 * - < 5 candidates:  no filter (show everyone)
 * - 5-19 candidates: capsules >= 2, genes >= 1
 * - 20-49 candidates: capsules >= 3, genes >= 1
 * - 50+ candidates:  capsules >= 5, genes >= 2
 */
export function meetsAgentThreshold(capsuleCount: number, distinctGenes: number, candidateCount?: number): boolean {
  const n = candidateCount ?? Infinity;
  if (n < 5) return true;
  if (n < 20) return capsuleCount >= 2 && distinctGenes >= 1;
  if (n < 50) return capsuleCount >= 3 && distinctGenes >= 1;
  return capsuleCount >= 5 && distinctGenes >= 2;
}

/**
 * Log anti-cheat event for audit trail.
 */
export async function logAntiCheat(
  ruleKey: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
  action: 'excluded' | 'flagged' = 'flagged',
): Promise<void> {
  try {
    await prisma.iMAntiCheatLog.create({
      data: {
        ruleKey,
        entityType,
        entityId,
        detail: JSON.stringify(detail),
        action,
      },
    });
  } catch {
    // Best-effort logging
  }
}

/**
 * Admin: get anti-cheat log entries.
 */
export async function getAntiCheatLog(opts: { ruleKey?: string; limit?: number; offset?: number }): Promise<unknown[]> {
  const { ruleKey, limit = 50, offset = 0 } = opts;
  const where: Record<string, unknown> = {};
  if (ruleKey) where.ruleKey = ruleKey;

  return prisma.iMAntiCheatLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: offset,
    take: limit,
  });
}

/**
 * Admin: clear a flagged entry.
 */
export async function clearAntiCheatFlag(id: number, reviewedBy: string): Promise<void> {
  await prisma.iMAntiCheatLog.update({
    where: { id },
    data: { action: 'cleared', reviewedBy, reviewedAt: new Date() },
  });
}

#!/usr/bin/env npx tsx
/**
 * Backfill ACP fields into existing IM agent profiles.
 *
 * Usage:
 *   DATABASE_URL="mysql://..." npx tsx scripts/backfill-acp-agent-profiles.ts --dry-run
 *   DATABASE_URL="mysql://..." npx tsx scripts/backfill-acp-agent-profiles.ts --workspace <workspaceId>
 */

import { buildDefaultAcpProfileConfig, mergeMissingAcpProfileDefaults } from '../src/im/acp/profile-defaults';

const DRY_RUN = process.argv.includes('--dry-run');
const workspaceArgIndex = process.argv.indexOf('--workspace');
const WORKSPACE_ID = workspaceArgIndex >= 0 ? process.argv[workspaceArgIndex + 1] : undefined;

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCapabilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function loadPrismaClient() {
  const dbUrl = process.env.DATABASE_URL || '';
  if (dbUrl.startsWith('mysql://') || dbUrl.startsWith('mysql2://')) {
    return await import('../prisma/generated/mysql/index.js');
  }
  return await import('@prisma/client');
}

async function main() {
  const { PrismaClient } = await loadPrismaClient();
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.iMAgentProfile.findMany({
      where: {
        deletedAt: null,
        adapterName: 'hermes',
        ...(WORKSPACE_ID ? { workspaceId: WORKSPACE_ID } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });

    let changed = 0;
    for (const profile of rows) {
      const agent = await prisma.iMUser.findUnique({
        where: { id: profile.agentImUserId },
        select: {
          username: true,
          displayName: true,
          agentType: true,
          agentCard: { select: { agentType: true, capabilities: true } },
        },
      });
      const existing = parseJsonObject(profile.config);
      const defaults = buildDefaultAcpProfileConfig({
        username: agent?.username,
        displayName: agent?.displayName,
        agentType: agent?.agentType || agent?.agentCard?.agentType,
        capabilities: parseCapabilities(agent?.agentCard?.capabilities),
      });
      const next = mergeMissingAcpProfileDefaults(existing, defaults);
      if (JSON.stringify(existing) === JSON.stringify(next)) continue;

      changed++;
      const label = `${profile.workspaceId}/${agent?.username ?? profile.agentImUserId}/${profile.name}`;
      console.log(`${DRY_RUN ? 'would update' : 'updating'} ${label}`);
      if (!DRY_RUN) {
        await prisma.iMAgentProfile.update({
          where: { id: profile.id },
          data: {
            config: JSON.stringify(next),
            version: { increment: 1 },
          },
        });
      }
    }

    console.log(`[backfill-acp-agent-profiles] scanned=${rows.length} changed=${changed} dryRun=${DRY_RUN}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[backfill-acp-agent-profiles] failed:', err);
  process.exit(1);
});

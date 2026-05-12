/**
 * Backfill script: Create one default Personal workspace per human IMUser.
 *
 * Usage:
 *   DATABASE_URL="file:./prisma/data/dev.db" npx tsx scripts/backfill-workspaces.ts
 *   DATABASE_URL="mysql://..." npx tsx scripts/backfill-workspaces.ts
 *   ... --dry-run   # report what would be created without writing
 *
 * Safe to run multiple times — only creates a workspace for users who don't
 * already have an active default one. No-op for users whose default workspace
 * is already present.
 *
 * 1.9.x semantics: 1:1 with IMUser; a single default workspace per human user.
 * Agents (role='agent') don't get their own workspace — they live inside their
 * owner's workspace via IMAgentProfile / IMAgentCard.workspaceId (added in m2).
 *
 * See docs/refactor/02-workspace-data-model.md §"Backfill 脚本".
 */

const dbUrl = process.env.DATABASE_URL ?? '';
// Sync require to avoid top-level-await issues under tsx CJS output.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = dbUrl.startsWith('mysql://')
  ? require('../prisma/generated/mysql')
  : require('@prisma/client');

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

interface Stats {
  totalHumans: number;
  alreadyHaveDefault: number;
  wouldCreate: number;
  created: number;
  failed: number;
}

async function main() {
  const stats: Stats = { totalHumans: 0, alreadyHaveDefault: 0, wouldCreate: 0, created: 0, failed: 0 };
  if (dryRun) console.log('[backfill-workspaces] DRY RUN — no writes will be made');

  // Pull all human users. Agents and admins don't get their own workspace.
  const humans = await prisma.iMUser.findMany({
    where: { role: 'human' },
    select: { id: true, displayName: true },
  });
  stats.totalHumans = humans.length;

  console.log(`[backfill-workspaces] Found ${humans.length} human users`);

  for (const user of humans) {
    try {
      const existing = await prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: user.id, isDefault: true, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        stats.alreadyHaveDefault++;
        continue;
      }

      if (dryRun) {
        stats.wouldCreate++;
        console.log(`[backfill-workspaces] would create: ${user.displayName} (${user.id})`);
        continue;
      }

      const created = await prisma.iMWorkspace.create({
        data: {
          ownerImUserId: user.id,
          name: 'Personal',
          slug: 'personal',
          isDefault: true,
          metadata: '{}',
        },
        select: { id: true },
      });
      stats.created++;
      console.log(`[backfill-workspaces] ✓ ${user.displayName} (${user.id}) → ws ${created.id}`);
    } catch (err) {
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill-workspaces] ✗ ${user.id}: ${msg}`);
    }
  }

  console.log('[backfill-workspaces] Summary:', stats);

  if (stats.failed > 0) {
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error('[backfill-workspaces] fatal:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

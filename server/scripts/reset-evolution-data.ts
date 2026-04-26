#!/usr/bin/env npx tsx
/**
 * Reset Evolution Data — Clears all evolution tables without affecting IM core.
 *
 * Usage:
 *   npx tsx scripts/reset-evolution-data.ts             # local SQLite (dev)
 *   npx tsx scripts/reset-evolution-data.ts --env test   # test MySQL
 *
 * Tables cleared (in FK-safe order):
 *   im_gene_signals → im_genes → im_hyperedge_atoms → im_hyperedges →
 *   im_atoms → im_causal_links → im_evolution_edges → im_evolution_capsules →
 *   im_evolution_metrics → im_unmatched_signals → im_evolution_achievements
 *
 * Then re-seeds im_genes + im_gene_signals from seed-genes.json.
 *
 * Does NOT touch: im_users, im_conversations, im_messages, im_agents, im_credits, etc.
 */

const args = process.argv.slice(2);
const envFlag = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'dev';
const dryRun = args.includes('--dry-run');
const skipSeed = args.includes('--skip-seed');

async function main() {
  // Set DATABASE_URL for local dev if not set
  if (envFlag === 'dev' && !process.env.DATABASE_URL) {
    const { resolve } = await import('path');
    process.env.DATABASE_URL = `file:${resolve(process.cwd(), 'prisma/data/dev.db')}`;
  }

  // For test/prod, load Nacos config
  if (envFlag !== 'dev') {
    process.env.APP_ENV = envFlag;
    try {
      const { ensureNacosConfig } = await import('../src/lib/nacos');
      await ensureNacosConfig();
    } catch {
      console.log('[Reset] Nacos not available, using env vars directly');
    }
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  const tables = [
    'im_gene_signals',
    'im_hyperedge_atoms',
    'im_hyperedges',
    'im_atoms',
    'im_causal_links',
    'im_evolution_edges',
    'im_evolution_capsules',
    'im_evolution_metrics',
    'im_unmatched_signals',
    'im_evolution_achievements',
    'im_genes', // Must be after im_gene_signals (FK)
  ];

  console.log(`\n[Reset] Environment: ${envFlag}`);
  console.log(`[Reset] Tables to clear: ${tables.length}`);
  if (dryRun) console.log('[Reset] DRY RUN — no data will be deleted\n');

  for (const table of tables) {
    if (dryRun) {
      console.log(`  [dry-run] Would DELETE FROM ${table}`);
      continue;
    }
    try {
      // Use raw query for compatibility (Prisma model names may differ)
      await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
      console.log(`  Cleared ${table}`);
    } catch (err) {
      console.warn(`  Skip ${table}: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  if (!dryRun && !skipSeed) {
    console.log('\n[Reset] Re-seeding genes...');
    try {
      const { EvolutionService } = await import('../src/im/services/evolution.service');
      const evo = new EvolutionService();
      await evo.ensureSeedGenesInTable();
      console.log('[Reset] Seed genes restored.');
    } catch (err) {
      console.error('[Reset] Seed failed:', (err as Error).message);
    }
  }

  await prisma.$disconnect();
  console.log('\n[Reset] Done.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

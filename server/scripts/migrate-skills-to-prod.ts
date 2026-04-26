/**
 * Migrate Skills from Test → Production
 *
 * Exports all skills from the test MySQL database and imports them
 * into production via the /api/im/skills/import API endpoint.
 *
 * Usage:
 *   # Step 1: Export from test DB → JSON file
 *   npx tsx scripts/migrate-skills-to-prod.ts export
 *
 *   # Step 2: Import JSON into production via API
 *   PRISMER_API_KEY="sk-prismer-live-..." npx tsx scripts/migrate-skills-to-prod.ts import
 *
 *   # One-shot (export + import)
 *   PRISMER_API_KEY="sk-prismer-live-..." npx tsx scripts/migrate-skills-to-prod.ts
 *
 *   # Dry-run: export only, verify counts
 *   npx tsx scripts/migrate-skills-to-prod.ts export --dry-run
 */

import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Config ─────────────────────────────────────────────────

const TEST_DB = {
  host: process.env.TEST_DB_HOST || '',
  port: Number(process.env.TEST_DB_PORT || 3306),
  user: process.env.TEST_DB_USER || '',
  password: process.env.TEST_DB_PASSWORD || '',
  database: process.env.TEST_DB_NAME || '',
};
if (!TEST_DB.host || !TEST_DB.user || !TEST_DB.password || !TEST_DB.database) {
  console.error(
    'Set TEST_DB_HOST / TEST_DB_USER / TEST_DB_PASSWORD / TEST_DB_NAME before running migrate-skills-to-prod.ts',
  );
  process.exit(1);
}

const PROD_API = 'https://prismer.cloud/api/im';
const PROD_API_KEY = process.env.PRISMER_API_KEY || '';
const EXPORT_PATH = resolve(__dirname, '../tmp/skills-export.json');
const BATCH_SIZE = 500; // /import endpoint allows max 5000

// ─── Types ──────────────────────────────────────────────────

interface SkillRow extends RowDataPacket {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string;
  author: string;
  source: string;
  sourceUrl: string;
  sourceId: string;
  content: string;
  installs: number;
  stars: number;
  status: string;
  metadata: string;
  compatibility: string;
  signals: string;
  requires: string;
  version: string;
  license: string;
  fileCount: number;
}

interface SkillExport {
  name: string;
  description: string;
  category: string;
  author: string;
  source: string;
  sourceUrl: string;
  sourceId: string;
  tags: string[];
  content: string;
  metadata: Record<string, unknown>;
  installs: number;
  stars: number;
  compatibility: string[];
  signals: string[];
  requires: Record<string, unknown>;
  version: string;
  license: string;
  fileCount: number;
}

// ─── Export ──────────────────────────────────────────────────

async function exportFromTestDB(): Promise<SkillExport[]> {
  console.log('Connecting to test DB...');
  const conn: Connection = await createConnection(TEST_DB);

  const [rows] = await conn.query<SkillRow[]>(
    `SELECT id, slug, name, description, category, tags, author,
            source, sourceUrl, sourceId, content, installs, stars,
            status, metadata, compatibility, signals, \`requires\`,
            version, license, fileCount
     FROM im_skills
     WHERE status = 'active'
     ORDER BY installs DESC`,
  );

  console.log(`Exported ${rows.length} active skills from test DB`);

  // Summary by source
  const bySource: Record<string, number> = {};
  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] || 0) + 1;
  }
  console.log('By source:', bySource);

  await conn.end();

  // Transform to export format
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    category: row.category,
    author: row.author,
    source: row.source,
    sourceUrl: row.sourceUrl,
    sourceId: row.sourceId,
    tags: safeParseJSON(row.tags, []),
    content: row.content,
    metadata: { ...safeParseJSON(row.metadata, {}), originalInstalls: row.installs, originalStars: row.stars },
    installs: row.installs,
    stars: row.stars,
    compatibility: safeParseJSON(row.compatibility, []),
    signals: safeParseJSON(row.signals, []),
    requires: safeParseJSON(row.requires, {}),
    version: row.version,
    license: row.license,
    fileCount: row.fileCount,
  }));
}

function safeParseJSON(val: string, fallback: any): any {
  try {
    return val ? JSON.parse(val) : fallback;
  } catch {
    return fallback;
  }
}

// ─── Import ─────────────────────────────────────────────────

async function importToProd(skills: SkillExport[]): Promise<void> {
  if (!PROD_API_KEY) {
    console.error('❌ PRISMER_API_KEY is required for import');
    console.error('   Set: PRISMER_API_KEY="sk-prismer-live-..." npx tsx scripts/migrate-skills-to-prod.ts import');
    process.exit(1);
  }

  // Verify prod is currently empty
  const statsRes = await fetch(`${PROD_API}/skills/stats`);
  const statsData = (await statsRes.json()) as { ok: boolean; data?: { total: number } };
  if (statsData.ok) {
    console.log(`Production current total: ${statsData.data?.total || 0}`);
    if ((statsData.data?.total || 0) > 0) {
      console.log('⚠️  Production already has skills. Import will skip duplicates (by sourceId).');
    }
  }

  let totalImported = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const totalBatches = Math.ceil(skills.length / BATCH_SIZE);

  for (let i = 0; i < skills.length; i += BATCH_SIZE) {
    const batch = skills.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} skills)... `);

    // Map to SkillImportItem format expected by bulkImport
    const importItems = batch.map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      author: s.author,
      source: s.source,
      sourceUrl: s.sourceUrl,
      sourceId: s.sourceId,
      tags: s.tags,
      content: s.content,
      metadata: s.metadata,
    }));

    try {
      const res = await fetch(`${PROD_API}/skills/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PROD_API_KEY}`,
        },
        body: JSON.stringify({ skills: importItems }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        data?: { imported: number; skipped: number; errors: number };
        error?: string;
      };

      if (!data.ok) {
        console.log(`FAILED: ${data.error}`);
        totalErrors += batch.length;
        continue;
      }

      const r = data.data!;
      totalImported += r.imported;
      totalSkipped += r.skipped;
      totalErrors += r.errors;
      console.log(`imported=${r.imported}, skipped=${r.skipped}, errors=${r.errors}`);
    } catch (err) {
      console.log(`NETWORK ERROR: ${(err as Error).message}`);
      totalErrors += batch.length;
    }
  }

  console.log(`\n═══ Import Complete ═══`);
  console.log(`  Imported: ${totalImported}`);
  console.log(`  Skipped:  ${totalSkipped} (already exist)`);
  console.log(`  Errors:   ${totalErrors}`);

  // Verify
  const verifyRes = await fetch(`${PROD_API}/skills/stats`);
  const verifyData = (await verifyRes.json()) as { ok: boolean; data?: any };
  if (verifyData.ok) {
    console.log(`\nProduction after import:`);
    console.log(`  Total: ${verifyData.data.total}`);
    console.log(`  By source:`, verifyData.data.by_source);
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const isDryRun = process.argv.includes('--dry-run');
  const mode = args[0] || 'all'; // 'export', 'import', or 'all'

  console.log('════════════════════════════════════════════════════');
  console.log(' Migrate Skills: Test → Production');
  console.log(`  Mode: ${mode}${isDryRun ? ' (dry-run)' : ''}`);
  console.log('════════════════════════════════════════════════════\n');

  if (mode === 'export' || mode === 'all') {
    const skills = await exportFromTestDB();

    // Ensure tmp dir exists
    const { mkdirSync } = await import('fs');
    mkdirSync(resolve(__dirname, '../tmp'), { recursive: true });

    writeFileSync(EXPORT_PATH, JSON.stringify(skills, null, 2));
    console.log(
      `\nExported to ${EXPORT_PATH} (${(Buffer.byteLength(JSON.stringify(skills)) / 1024 / 1024).toFixed(1)} MB)\n`,
    );

    if (isDryRun) {
      console.log('Dry-run: skipping import');
      return;
    }

    if (mode === 'all') {
      await importToProd(skills);
    }
  } else if (mode === 'import') {
    if (!existsSync(EXPORT_PATH)) {
      console.error(`❌ Export file not found: ${EXPORT_PATH}`);
      console.error('   Run "export" first: npx tsx scripts/migrate-skills-to-prod.ts export');
      process.exit(1);
    }

    const skills: SkillExport[] = JSON.parse(readFileSync(EXPORT_PATH, 'utf-8'));
    console.log(`Loaded ${skills.length} skills from ${EXPORT_PATH}\n`);
    await importToProd(skills);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

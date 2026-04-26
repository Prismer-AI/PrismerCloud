/**
 * v1.8.0 MySQL Migration Runner
 *
 * Loads test env credentials from Nacos (APP_ENV=test),
 * then executes migrations 029-034 in order.
 *
 * Usage:
 *   APP_ENV=test npx tsx scripts/run-migration-v180.ts
 *   APP_ENV=test npx tsx scripts/run-migration-v180.ts --dry-run
 */

import { initNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = [
  '029_v180_convergence.sql',
  '030_v180_leaderboard_v2.sql',
  '031_v180_community.sql',
  '032_v2_community_tags.sql',
  '033_v180_contact_system.sql',
  '034_v180_workspace_scope.sql',
];

const SQL_DIR = join(__dirname, '../src/im/sql');

/**
 * Strip MariaDB-only `IF NOT EXISTS` from ALTER TABLE ADD COLUMN / CREATE INDEX
 * since MySQL 8.0 doesn't support these clauses.
 * We rely on error-code skip (ER_DUP_FIELDNAME / ER_DUP_KEYNAME) instead.
 */
function stripIfNotExists(stmt: string): string {
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS col ...
  let s = stmt.replace(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi, 'ADD COLUMN');
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS (multi-column ALTER in single statement)
  // CREATE INDEX IF NOT EXISTS idx ON tbl ...
  s = s.replace(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/gi, 'CREATE INDEX');
  // ALTER TABLE ... ADD FULLTEXT INDEX IF NOT EXISTS (shouldn't appear, but just in case)
  s = s.replace(/ADD\s+FULLTEXT\s+INDEX\s+IF\s+NOT\s+EXISTS/gi, 'ADD FULLTEXT INDEX');
  return s;
}

/**
 * Transform DELIMITER $$ blocks into plain SQL executable by mysql2.
 * DELIMITER is a mysql CLI directive, not real SQL.
 * Also strips MariaDB-only IF NOT EXISTS from ALTER TABLE / CREATE INDEX.
 */
function transformDelimiterBlocks(sql: string): string[] {
  const statements: string[] = [];
  const lines = sql.split('\n');
  let inDelimiterBlock = false;
  let procBuffer = '';
  let normalBuffer = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip pure comments at top level (but keep them in proc bodies)
    if (!inDelimiterBlock && (trimmed.startsWith('--') || trimmed === '')) {
      continue;
    }

    if (trimmed === 'DELIMITER $$') {
      // Flush any normal SQL accumulated before this block
      if (normalBuffer.trim()) {
        for (const stmt of normalBuffer.split(';').filter((s) => s.trim())) {
          statements.push(stripIfNotExists(stmt.trim()));
        }
        normalBuffer = '';
      }
      inDelimiterBlock = true;
      procBuffer = '';
      continue;
    }

    if (trimmed === 'DELIMITER ;') {
      inDelimiterBlock = false;
      continue;
    }

    if (inDelimiterBlock) {
      // Inside DELIMITER block: accumulate until END$$
      if (trimmed.endsWith('$$')) {
        procBuffer += line.replace(/\$\$$/, '') + '\n';
        // This is a complete CREATE PROCEDURE ... END statement
        if (procBuffer.trim()) {
          statements.push(procBuffer.trim());
        }
        procBuffer = '';
      } else {
        procBuffer += line + '\n';
      }
    } else {
      normalBuffer += line + '\n';
    }
  }

  // Flush remaining normal SQL
  if (normalBuffer.trim()) {
    for (const stmt of normalBuffer.split(';').filter((s) => s.trim())) {
      statements.push(stripIfNotExists(stmt.trim()));
    }
  }

  return statements;
}

function describeStatement(stmt: string): string {
  const first100 = stmt.replace(/\s+/g, ' ').slice(0, 100);
  const m =
    first100.match(/CREATE TABLE.*?`?(\w+)`?/i) ||
    first100.match(/ALTER TABLE\s+`?(\w+)`?.*ADD COLUMN.*?`?(\w+)`?/i) ||
    first100.match(/ALTER TABLE\s+`?(\w+)`?/i) ||
    first100.match(/CREATE INDEX.*?ON\s+`?(\w+)`?/i) ||
    first100.match(/CREATE PROCEDURE\s+`?(\w+)`?/i) ||
    first100.match(/DROP PROCEDURE.*?`?(\w+)`?/i) ||
    first100.match(/CALL\s+`?(\w+)`?/i) ||
    first100.match(/INSERT.*?INTO\s+`?(\w+)`?/i) ||
    first100.match(/UPDATE\s+`?(\w+)`?/i);
  return m ? m[0].trim() : first100;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const appEnv = process.env.APP_ENV || 'test';

  console.log(`\n=== v1.8.0 Migration Runner ===`);
  console.log(`APP_ENV: ${appEnv}${dryRun ? ' (DRY RUN)' : ''}\n`);

  // Load Nacos config to get REMOTE_MYSQL_* env vars
  console.log('Loading Nacos config...');
  await initNacosConfig(true, {
    namespace:
      appEnv === 'prod'
        ? 'bd5fb394-7492-440a-9626-9f8a261c500f'
        : appEnv === 'test'
          ? 'a1ce57f2-0405-45c3-a8b1-35953d1e9aaf'
          : 'a49fb6f9-e461-4b2a-aa66-3cccde46126c',
  });

  const host = process.env.REMOTE_MYSQL_HOST;
  const port = parseInt(process.env.REMOTE_MYSQL_PORT || '3306');
  const user = process.env.REMOTE_MYSQL_USER;
  const password = process.env.REMOTE_MYSQL_PASSWORD;
  const database = process.env.REMOTE_MYSQL_DATABASE || 'prismer_cloud';

  if (!host || !user) {
    console.error('REMOTE_MYSQL_HOST/USER not set after Nacos load. Aborting.');
    process.exit(1);
  }

  console.log(`Connecting to MySQL: ${user}@${host}:${port}/${database}\n`);

  if (dryRun) {
    console.log('[DRY RUN] Would execute the following statements:\n');
    for (const file of MIGRATIONS) {
      const sql = readFileSync(join(SQL_DIR, file), 'utf-8');
      const stmts = transformDelimiterBlocks(sql);
      console.log(`--- ${file} (${stmts.length} statements) ---`);
      for (const stmt of stmts) {
        console.log(`  ${describeStatement(stmt)}`);
      }
      console.log();
    }
    console.log('[DRY RUN] No changes made.');
    return;
  }

  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    multipleStatements: true,
    connectTimeout: 10000,
  });

  console.log('Connected.\n');

  let totalOk = 0;
  let totalSkip = 0;
  let totalFail = 0;

  for (const file of MIGRATIONS) {
    console.log(`=== ${file} ===`);
    const sql = readFileSync(join(SQL_DIR, file), 'utf-8');
    const stmts = transformDelimiterBlocks(sql);

    for (const stmt of stmts) {
      const desc = describeStatement(stmt);
      try {
        await conn.query(stmt);
        console.log(`  ✅ ${desc}`);
        totalOk++;
      } catch (e: any) {
        const code = e.code || '';
        const msg = e.message || '';
        if (
          code === 'ER_TABLE_EXISTS_ERROR' ||
          code === 'ER_DUP_FIELDNAME' ||
          code === 'ER_DUP_KEYNAME' ||
          msg.includes('Duplicate column') ||
          msg.includes('Duplicate key name')
        ) {
          console.log(`  ⏭️  already exists — ${desc}`);
          totalSkip++;
        } else {
          console.log(`  ❌ ${desc}`);
          console.log(`     ${code}: ${msg.slice(0, 120)}`);
          totalFail++;
        }
      }
    }
    console.log();
  }

  await conn.end();

  console.log(`\n=== Summary ===`);
  console.log(`  ✅ Succeeded: ${totalOk}`);
  console.log(`  ⏭️  Skipped:   ${totalSkip}`);
  console.log(`  ❌ Failed:    ${totalFail}`);
  console.log(`\nDone.`);

  if (totalFail > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

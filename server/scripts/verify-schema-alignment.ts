/**
 * Schema Alignment Verification — Local SQLite vs Test MySQL
 *
 * Checks every evolution/security table for:
 *   1. Column existence (scope, encrypted, encryptionKeyId, ephemeralKeys)
 *   2. Index existence (scope indexes, unique constraints)
 *   3. New table existence (im_evolution_acl)
 *   4. Column defaults consistency
 *   5. Data integrity (existing rows have scope='global')
 *
 * Usage: npx tsx scripts/verify-schema-alignment.ts
 */

import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ============================================================================
// SQLite checks
// ============================================================================

function sq(sql: string): string {
  const dbPath = resolve(process.cwd(), 'prisma/data/dev.db');
  try {
    return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function checkSQLite() {
  console.log('\n═══ Local SQLite Schema ═══\n');

  if (!sq('.tables')) {
    console.log('  ⚠️  SQLite DB not found');
    return;
  }

  const tables = [
    { name: 'im_genes', expectCols: ['scope', 'encrypted', 'encryptionKeyId'] },
    { name: 'im_evolution_edges', expectCols: ['scope'] },
    { name: 'im_evolution_capsules', expectCols: ['scope', 'encrypted'] },
    { name: 'im_unmatched_signals', expectCols: ['scope'] },
    { name: 'im_evolution_achievements', expectCols: ['scope'] },
    { name: 'im_conversation_security', expectCols: ['ephemeralKeys'] },
  ];

  for (const { name, expectCols } of tables) {
    const schema = sq(`.schema ${name}`);
    for (const col of expectCols) {
      assert(schema.includes(`"${col}"`), `${name}.${col} exists`);
    }
    if (expectCols.includes('scope')) {
      assert(schema.includes("'global'"), `${name}.scope default = 'global'`);
    }
  }

  // ACL table
  const aclSchema = sq('.schema im_evolution_acl');
  assert(aclSchema.includes('im_evolution_acl'), 'im_evolution_acl table exists');
  for (const col of ['resourceType', 'resourceId', 'subjectType', 'subjectId', 'permission', 'grantedBy']) {
    assert(aclSchema.includes(`"${col}"`), `im_evolution_acl.${col} exists`);
  }

  // Indexes
  const indexes = sq("SELECT name FROM sqlite_master WHERE type='index'");
  assert(indexes.includes('scope'), 'scope indexes exist');

  // Data integrity
  for (const tbl of ['im_genes', 'im_evolution_edges', 'im_evolution_capsules']) {
    const cnt = sq(`SELECT COUNT(*) FROM ${tbl} WHERE scope != 'global'`);
    assert(cnt === '0' || cnt === '', `${tbl}: all rows scope='global'`);
  }
}

// ============================================================================
// MySQL checks
// ============================================================================

async function checkMySQL() {
  console.log('\n═══ Test MySQL Schema ═══\n');

  await ensureNacosConfig();
  const host = process.env.REMOTE_MYSQL_HOST;
  if (!host) {
    console.log('  ⚠️  No MySQL credentials, skipping');
    return;
  }

  const conn = await mysql.createConnection({
    host,
    port: parseInt(process.env.REMOTE_MYSQL_PORT || '3306'),
    user: process.env.REMOTE_MYSQL_USER!,
    password: process.env.REMOTE_MYSQL_PASSWORD!,
    database: process.env.REMOTE_MYSQL_DATABASE!,
  });
  const db = process.env.REMOTE_MYSQL_DATABASE!;

  // Column checks
  const tables = [
    { name: 'im_genes', expectCols: ['scope', 'encrypted', 'encryptionKeyId'] },
    { name: 'im_evolution_edges', expectCols: ['scope'] },
    { name: 'im_evolution_capsules', expectCols: ['scope', 'encrypted'] },
    { name: 'im_unmatched_signals', expectCols: ['scope'] },
    { name: 'im_evolution_achievements', expectCols: ['scope'] },
    { name: 'im_conversation_security', expectCols: ['ephemeralKeys'] },
  ];

  for (const { name, expectCols } of tables) {
    const [rows] = (await conn.execute(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [db, name],
    )) as any[];
    const colMap = new Map(rows.map((r: any) => [r.COLUMN_NAME, r]));

    for (const col of expectCols) {
      assert(colMap.has(col), `${name}.${col} exists`);
      if (col === 'scope' && colMap.has(col)) {
        const colInfo = colMap.get(col);
        assert(
          colInfo.COLUMN_DEFAULT === 'global',
          `${name}.scope default = 'global'`,
          `got: ${colInfo.COLUMN_DEFAULT}`,
        );
        assert(colInfo.DATA_TYPE === 'varchar', `${name}.scope type = varchar`, `got: ${colInfo.DATA_TYPE}`);
      }
    }
  }

  // ACL table
  const [aclRows] = (await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_acl'`,
    [db],
  )) as any[];
  assert(aclRows.length > 0, 'im_evolution_acl table exists');
  const aclCols = new Set(aclRows.map((r: any) => r.COLUMN_NAME));
  for (const col of ['id', 'resourceType', 'resourceId', 'subjectType', 'subjectId', 'permission', 'grantedBy']) {
    assert(aclCols.has(col), `im_evolution_acl.${col} exists`);
  }

  // Index checks
  const [edgeIdx] = (await conn.execute(
    `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_edges' AND COLUMN_NAME = 'scope'`,
    [db],
  )) as any[];
  assert(edgeIdx.length > 0, 'im_evolution_edges has scope in index');
  assert(
    edgeIdx.some((r: any) => r.NON_UNIQUE === 0),
    'im_evolution_edges scope in unique constraint',
  );

  const [geneIdx] = (await conn.execute(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_genes' AND INDEX_NAME = 'idx_genes_scope_vis'`,
    [db],
  )) as any[];
  assert(geneIdx.length > 0, 'im_genes has idx_genes_scope_vis index');

  const [capIdx] = (await conn.execute(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_capsules' AND INDEX_NAME = 'idx_capsules_scope'`,
    [db],
  )) as any[];
  assert(capIdx.length > 0, 'im_evolution_capsules has idx_capsules_scope index');

  // Data integrity
  for (const tbl of ['im_genes', 'im_evolution_edges', 'im_evolution_capsules']) {
    const [countRows] = (await conn.execute(`SELECT COUNT(*) as cnt FROM ${tbl} WHERE scope != 'global'`)) as any[];
    const cnt = countRows[0]?.cnt ?? 0;
    assert(cnt === 0, `${tbl}: all rows scope='global'`, cnt > 0 ? `${cnt} non-global rows` : undefined);
  }

  // Cross-check: total row counts (sanity)
  for (const tbl of ['im_genes', 'im_evolution_capsules', 'im_evolution_edges']) {
    const [countRows] = (await conn.execute(`SELECT COUNT(*) as cnt FROM ${tbl}`)) as any[];
    console.log(`  ℹ️  ${tbl}: ${countRows[0]?.cnt} rows`);
  }

  await conn.end();
}

// ============================================================================
// Cross-check: SQLite vs MySQL column parity
// ============================================================================

async function crossCheck() {
  console.log('\n═══ Cross-Check: SQLite ↔ MySQL Parity ═══\n');

  await ensureNacosConfig();
  const host = process.env.REMOTE_MYSQL_HOST;
  if (!host) {
    console.log('  ⚠️  No MySQL, skipping cross-check');
    return;
  }

  const conn = await mysql.createConnection({
    host,
    port: parseInt(process.env.REMOTE_MYSQL_PORT || '3306'),
    user: process.env.REMOTE_MYSQL_USER!,
    password: process.env.REMOTE_MYSQL_PASSWORD!,
    database: process.env.REMOTE_MYSQL_DATABASE!,
  });
  const db = process.env.REMOTE_MYSQL_DATABASE!;

  const checkTables = [
    'im_genes',
    'im_evolution_edges',
    'im_evolution_capsules',
    'im_unmatched_signals',
    'im_evolution_achievements',
    'im_evolution_acl',
    'im_conversation_security',
  ];

  const relevantCols = [
    'scope',
    'encrypted',
    'encryptionKeyId',
    'ephemeralKeys',
    'resourceType',
    'resourceId',
    'subjectType',
    'subjectId',
    'permission',
    'grantedBy',
  ];

  for (const tbl of checkTables) {
    // SQLite columns (from schema text)
    const schema = sq(`.schema ${tbl}`);
    const sqliteCols = new Set(relevantCols.filter((col) => schema.includes(`"${col}"`)));

    // MySQL columns
    const [mysqlRows] = (await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (${relevantCols.map(() => '?').join(',')})`,
      [db, tbl, ...relevantCols],
    )) as any[];
    const mysqlCols = new Set(mysqlRows.map((r: any) => r.COLUMN_NAME));

    for (const col of relevantCols) {
      if (sqliteCols.has(col) || mysqlCols.has(col)) {
        const both = sqliteCols.has(col) && mysqlCols.has(col);
        if (both) {
          assert(true, `${tbl}.${col}: both ✓`);
        } else if (sqliteCols.has(col)) {
          assert(false, `${tbl}.${col}: only in SQLite`, 'missing from MySQL');
        } else {
          assert(false, `${tbl}.${col}: only in MySQL`, 'missing from SQLite');
        }
      }
    }
  }

  await conn.end();
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Schema Alignment Verification           ║');
  console.log('╚══════════════════════════════════════════╝');

  checkSQLite();
  await checkMySQL();
  await crossCheck();

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

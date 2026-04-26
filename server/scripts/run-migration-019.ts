/**
 * Execute migration 019 on test environment MySQL.
 * Loads credentials from Nacos, then runs the migration steps.
 *
 * Usage: npx tsx scripts/run-migration-019.ts
 */

import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';

async function main() {
  await ensureNacosConfig();
  const conn = await mysql.createConnection({
    host: process.env.REMOTE_MYSQL_HOST!,
    port: parseInt(process.env.REMOTE_MYSQL_PORT || '3306'),
    user: process.env.REMOTE_MYSQL_USER!,
    password: process.env.REMOTE_MYSQL_PASSWORD!,
    database: process.env.REMOTE_MYSQL_DATABASE!,
    multipleStatements: true,
  });
  console.log(`Connected to ${process.env.REMOTE_MYSQL_HOST}/${process.env.REMOTE_MYSQL_DATABASE}`);

  // Helper procedure
  await conn.query('DROP PROCEDURE IF EXISTS add_column_if_not_exists');
  await conn.query(`
    CREATE PROCEDURE add_column_if_not_exists(
      IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition VARCHAR(512)
    )
    BEGIN
      SET @col_exists = (
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column
      );
      IF @col_exists = 0 THEN
        SET @sql = CONCAT('ALTER TABLE \`', p_table, '\` ADD COLUMN \`', p_column, '\` ', p_definition);
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
      END IF;
    END
  `);

  // Phase 1: Scope
  console.log('\n=== Phase 1: Scope fields ===');
  for (const [tbl, col, def] of [
    ['im_genes', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'"],
    ['im_evolution_edges', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'"],
    ['im_evolution_capsules', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'"],
    ['im_unmatched_signals', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'"],
    ['im_evolution_achievements', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'"],
  ]) {
    await conn.query('CALL add_column_if_not_exists(?, ?, ?)', [tbl, col, def]);
    console.log(`  ✅ ${tbl}.${col}`);
  }

  // Indexes
  for (const sql of [
    'CREATE INDEX idx_genes_scope_vis ON im_genes(scope, visibility)',
    'CREATE INDEX idx_capsules_scope ON im_evolution_capsules(scope)',
  ]) {
    try {
      await conn.query(sql);
      console.log(`  ✅ ${sql.split(' ON ')[0]}`);
    } catch {
      console.log(`  ⏭️  ${sql.split(' ON ')[0]} (exists)`);
    }
  }

  // Rebuild unique constraints
  console.log('\n=== Rebuild unique constraints ===');
  for (const { table, colCheck, newIdx, newDef } of [
    {
      table: 'im_evolution_edges',
      colCheck: 'ownerAgentId',
      newIdx: 'uq_edge_scope',
      newDef: '(ownerAgentId, signalKey(200), geneId, mode, scope)',
    },
    {
      table: 'im_unmatched_signals',
      colCheck: 'signalKey',
      newIdx: 'uq_unmatched_scope',
      newDef: '(signalKey(200), agentId, scope)',
    },
    {
      table: 'im_evolution_achievements',
      colCheck: 'agentId',
      newIdx: 'uq_achievement_scope',
      newDef: '(agentId, badgeKey, scope)',
    },
  ]) {
    // Drop old unique
    try {
      const [rows]: any = await conn.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND NON_UNIQUE = 0 LIMIT 1`,
        [table, colCheck],
      );
      if (rows.length > 0 && rows[0].INDEX_NAME !== newIdx) {
        await conn.query(`ALTER TABLE ${table} DROP INDEX \`${rows[0].INDEX_NAME}\``);
        console.log(`  Dropped ${table}.${rows[0].INDEX_NAME}`);
      }
    } catch (e) {
      console.log(`  Skip drop on ${table}: ${(e as Error).message.slice(0, 50)}`);
    }
    // Create new
    try {
      await conn.query(`ALTER TABLE ${table} ADD UNIQUE INDEX ${newIdx} ${newDef}`);
      console.log(`  ✅ Created ${newIdx}`);
    } catch {
      console.log(`  ⏭️  ${newIdx} (exists)`);
    }
  }

  // Phase 2: Encryption
  console.log('\n=== Phase 2: Encryption fields ===');
  for (const [tbl, col, def] of [
    ['im_genes', 'encrypted', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['im_genes', 'encryptionKeyId', 'VARCHAR(30) NULL'],
    ['im_evolution_capsules', 'encrypted', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['im_conversation_security', 'ephemeralKeys', 'TEXT NULL'],
  ]) {
    await conn.query('CALL add_column_if_not_exists(?, ?, ?)', [tbl, col, def]);
    console.log(`  ✅ ${tbl}.${col}`);
  }

  // Phase 3: ACL table
  console.log('\n=== Phase 3: ACL table ===');
  await conn.query(`
    CREATE TABLE IF NOT EXISTS im_evolution_acl (
      id VARCHAR(30) NOT NULL,
      resourceType VARCHAR(20) NOT NULL,
      resourceId VARCHAR(100) NOT NULL,
      subjectType VARCHAR(20) NOT NULL,
      subjectId VARCHAR(100) NOT NULL,
      permission VARCHAR(20) NOT NULL,
      grantedBy VARCHAR(30) NOT NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expiresAt DATETIME(3) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_acl (resourceType, resourceId, subjectType, subjectId, permission),
      INDEX idx_acl_resource (resourceId),
      INDEX idx_acl_subject (subjectType, subjectId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('  ✅ im_evolution_acl');

  // Cleanup
  await conn.query('DROP PROCEDURE IF EXISTS add_column_if_not_exists');
  await conn.end();
  console.log('\n✅ Migration 019 complete on test environment');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

/**
 * Bug Z1 backfill migration test — src/im/sql/449_v207_z1_backfill_personal_ws_owner.sql
 *
 * Validates the migration as SQL semantics:
 *   - adds owner row for active workspaces that lack one
 *   - idempotent (INSERT IGNORE + UNIQUE constraint)
 *   - leaves existing owner rows untouched
 *   - skips workspaces with deletedAt set
 *
 * Run:
 *   npx tsx src/im/services/__tests__/backfill-personal-ws-owner.test.ts
 *
 * Test strategy: connect to local MySQL (DATABASE_URL or 127.0.0.1:3307), seed
 * a scratch schema, copy minimal CREATE TABLE for im_workspaces +
 * im_workspace_members, run the migration body, assert state. This keeps the
 * test self-contained and exercises real MySQL idempotency.
 *
 * Skips silently if MYSQL_HOST not reachable (so CI without docker stack
 * doesn't fail).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIGRATION_PATH = path.join(__dirname, '../../sql/449_v207_z1_backfill_personal_ws_owner.sql');

const MYSQL_HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
const MYSQL_PORT = Number(process.env.MYSQL_PORT ?? 3307);
const MYSQL_USER = process.env.MYSQL_USER ?? 'prismer';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? 'devpass';

let passed = 0;
let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${b}\n    actual:   ${a}`);
  }
}

const MYSQL_DATABASE = process.env.MYSQL_DATABASE ?? 'prismer_cloud';

async function tryConnect() {
  try {
    const conn = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      multipleStatements: true,
    });
    return conn;
  } catch (err) {
    console.log(`[skip] MySQL not reachable @ ${MYSQL_HOST}:${MYSQL_PORT}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function main() {
  console.log('• Bug Z1 backfill migration — 449_v207_z1_backfill_personal_ws_owner.sql');

  const conn = await tryConnect();
  if (!conn) {
    console.log('Result: skipped (no MySQL)');
    return;
  }

  // Scratch tables co-located inside prismer_cloud (test user lacks
  // CREATE DATABASE; we use unique table-name prefix instead).
  const prefix = `z1test_${Date.now()}_`;
  const wsTable = `${prefix}im_workspaces`;
  const memberTable = `${prefix}im_workspace_members`;

  // Rewrite migration SQL to point at our scratch tables (the migration body
  // is small and table-scoped; literal string substitution is sufficient).
  const remap = (sql: string) =>
    sql
      .replace(/im_workspace_members/g, memberTable)
      .replace(/im_workspaces/g, wsTable);

  // Minimal table definitions matching prisma schema (only the columns the
  // migration touches). Keeps test independent of full im_* schema state.
  await conn.query(`
    CREATE TABLE \`${wsTable}\` (
      id VARCHAR(30) PRIMARY KEY,
      ownerImUserId VARCHAR(30) NOT NULL,
      name VARCHAR(255) NOT NULL,
      deletedAt DATETIME(3) NULL,
      createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
    )
  `);
  await conn.query(`
    CREATE TABLE \`${memberTable}\` (
      id VARCHAR(30) PRIMARY KEY,
      workspaceId VARCHAR(30) NOT NULL,
      memberImUserId VARCHAR(30) NOT NULL,
      role VARCHAR(32) NOT NULL,
      joinedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ws_member (workspaceId, memberImUserId)
    )
  `);

  // Seed:
  //   ws_a : owner row MISSING — backfill should add
  //   ws_b : owner row EXISTS  — backfill should not duplicate
  //   ws_c : deleted (deletedAt set) — backfill should skip
  await conn.query(`
    INSERT INTO \`${wsTable}\` (id, ownerImUserId, name, deletedAt) VALUES
      ('ws_a', 'usr_alice', 'Personal A', NULL),
      ('ws_b', 'usr_bob',   'Personal B', NULL),
      ('ws_c', 'usr_carol', 'Deleted C',  '2026-05-01 00:00:00.000')
  `);
  await conn.query(`
    INSERT INTO \`${memberTable}\` (id, workspaceId, memberImUserId, role) VALUES
      ('wsm_existing_bob', 'ws_b', 'usr_bob', 'owner')
  `);

  const migrationSql = remap(await fs.readFile(MIGRATION_PATH, 'utf8'));

  try {
    // ─── pass 1 ───
    await conn.query(migrationSql);

    const [rowsA] = await conn.query<any[]>(
      `SELECT memberImUserId, role FROM \`${memberTable}\` WHERE workspaceId='ws_a'`,
    );
    eq('ws_a: owner row added', rowsA.length, 1);
    eq('ws_a: role=owner', rowsA[0]?.role, 'owner');
    eq('ws_a: memberImUserId=usr_alice', rowsA[0]?.memberImUserId, 'usr_alice');

    const [rowsB] = await conn.query<any[]>(
      `SELECT id, memberImUserId, role FROM \`${memberTable}\` WHERE workspaceId='ws_b'`,
    );
    eq('ws_b: still single row (not duplicated)', rowsB.length, 1);
    eq('ws_b: original id preserved', rowsB[0]?.id, 'wsm_existing_bob');

    const [rowsC] = await conn.query<any[]>(
      `SELECT memberImUserId FROM \`${memberTable}\` WHERE workspaceId='ws_c'`,
    );
    eq('ws_c: deleted workspace skipped', rowsC.length, 0);

    // ─── pass 2 (idempotency) ───
    await conn.query(migrationSql);

    const [allRows] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM \`${memberTable}\``);
    eq('idempotent: rerun does not duplicate', allRows[0]?.n, 2);

    const [rowsA2] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${memberTable}\` WHERE workspaceId='ws_a'`,
    );
    eq('idempotent: ws_a still 1 row', rowsA2[0]?.n, 1);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS \`${memberTable}\``);
    await conn.query(`DROP TABLE IF EXISTS \`${wsTable}\``);
    await conn.end();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * P0 fix script for workspace bootstrap issue (2026-05-09).
 *
 *   STEP 1 — Apply migration 304 (im_containers.runtimeKind) — idempotent
 *   STEP 2 — Backfill default workspace for all human IM users missing one
 *
 * Both steps print preview counts before any write. Pass `--apply` to actually
 * execute writes. Without it, the script runs read-only.
 *
 * Usage:
 *   APP_ENV=test npx tsx scripts/fix-workspace-bootstrap.ts            # dry-run
 *   APP_ENV=test npx tsx scripts/fix-workspace-bootstrap.ts --apply    # apply
 */
import fs from 'fs';
import path from 'path';
import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');

async function main() {
  await ensureNacosConfig();
  const host = process.env.REMOTE_MYSQL_HOST;
  const port = parseInt(process.env.REMOTE_MYSQL_PORT || '3306');
  const user = process.env.REMOTE_MYSQL_USER;
  const password = process.env.REMOTE_MYSQL_PASSWORD;
  const database = process.env.REMOTE_MYSQL_DATABASE;

  console.log(`\n=== fix-workspace-bootstrap (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`APP_ENV=${process.env.APP_ENV} → ${host}:${port}/${database}`);

  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    multipleStatements: true,
  });

  // ─── STEP 1: migration 304 ─────────────────────────────────────────────────
  console.log('\n--- STEP 1: migration 304_v110_runtime_kind ---');
  const [colsBefore] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_containers' AND COLUMN_NAME = 'runtimeKind'`,
    [database],
  );
  const hasCol = (colsBefore as any[]).length > 0;
  console.log(`runtimeKind exists before: ${hasCol ? 'YES (skip)' : 'NO (will add)'}`);

  if (!hasCol) {
    if (APPLY) {
      // mysql2 driver doesn't support DELIMITER (mysql CLI directive), so we
      // run the equivalent ALTER directly. The Prisma schema specifies
      // VARCHAR(16) NOT NULL DEFAULT 'docker'.
      await conn.query(`ALTER TABLE im_containers ADD COLUMN runtimeKind VARCHAR(16) NOT NULL DEFAULT 'docker'`);
      const [colsAfter] = await conn.execute(
        `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_containers' AND COLUMN_NAME = 'runtimeKind'`,
        [database],
      );
      console.log('Migration applied. Column now:', JSON.stringify(colsAfter));
    } else {
      console.log('(dry-run: migration script would run)');
    }
  }

  // ─── STEP 2: backfill default workspaces ───────────────────────────────────
  console.log('\n--- STEP 2: backfill default workspace for human users missing one ---');

  // Find human users who own zero (non-deleted, default) workspaces.
  const [missingRows] = await conn.execute(
    `SELECT u.id AS userId, u.numericId, u.username, u.email, u.createdAt
     FROM im_users u
     LEFT JOIN im_workspaces w
       ON w.ownerImUserId = u.id
       AND w.deletedAt IS NULL
     WHERE u.role = 'human'
       AND w.id IS NULL
     ORDER BY u.createdAt ASC`,
  );
  const missing = missingRows as any[];
  console.log(`Human users missing default workspace: ${missing.length}`);
  if (missing.length > 0) {
    console.log('First 10:');
    console.log(JSON.stringify(missing.slice(0, 10), null, 2));
  }

  if (missing.length === 0) {
    console.log('Nothing to backfill.');
    await conn.end();
    return;
  }

  if (!APPLY) {
    console.log('\n(dry-run: would create one Personal default workspace per user above)');
    console.log('Re-run with --apply to actually write.');
    await conn.end();
    return;
  }

  // Apply: create one default workspace per user. Use cuid()-style id matching
  // Prisma's @default(cuid()): 25 chars, lowercase alnum, prefix "c". We can't
  // call Prisma here (raw mysql conn), so build a cuid-compatible id manually.
  let created = 0;
  for (const u of missing) {
    const id = makeCuid();
    const slug = `personal-${u.userId.slice(-6)}`; // avoid unique conflict if user later wants slug "personal"
    try {
      await conn.execute(
        `INSERT INTO im_workspaces (id, ownerImUserId, name, slug, isDefault, metadata, createdAt, updatedAt)
         VALUES (?, ?, 'Personal', ?, 1, '{}', NOW(3), NOW(3))`,
        [id, u.userId, slug],
      );
      created++;
    } catch (err) {
      console.error(`FAILED user ${u.userId}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`Backfill complete: ${created}/${missing.length} workspaces created.`);

  await conn.end();
}

// Minimal cuid-like generator: 'c' + base36(timestamp + counter + random),
// padded to 25 chars. Not bit-perfect with cuid lib but fits Prisma's
// VARCHAR(30) and won't collide for backfill volume.
let counter = 0;
function makeCuid(): string {
  const ts = Date.now().toString(36);
  const c = (counter++).toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return ('c' + ts + c + rand).slice(0, 25);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});

import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';

async function main() {
  await ensureNacosConfig();
  const host = process.env.REMOTE_MYSQL_HOST;
  const port = parseInt(process.env.REMOTE_MYSQL_PORT || '3306');
  const user = process.env.REMOTE_MYSQL_USER;
  const password = process.env.REMOTE_MYSQL_PASSWORD;
  const database = process.env.REMOTE_MYSQL_DATABASE;
  const conn = await mysql.createConnection({ host, port, user, password, database });

  // Verify post-fix state
  const [rkCheck] = await conn.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_containers' AND COLUMN_NAME = 'runtimeKind'`,
    [database],
  );
  console.log('=== runtimeKind status ===');
  console.log(JSON.stringify(rkCheck, null, 2));

  const [user1667ws] = await conn.execute(
    `SELECT w.id, w.name, w.slug, w.isDefault, w.createdAt
     FROM im_workspaces w
     JOIN im_users u ON u.id = w.ownerImUserId
     WHERE u.numericId = 1667 AND w.deletedAt IS NULL`,
  );
  console.log('\n=== Workspaces for user 1667 (post-fix) ===');
  console.log(JSON.stringify(user1667ws, null, 2));

  // Confirm no other human users still missing workspace
  const [stillMissing] = await conn.execute(
    `SELECT COUNT(*) AS cnt FROM im_users u
     LEFT JOIN im_workspaces w ON w.ownerImUserId = u.id AND w.deletedAt IS NULL
     WHERE u.role = 'human' AND w.id IS NULL`,
  );
  console.log('\n=== Human users still missing workspace ===');
  console.log(JSON.stringify(stillMissing, null, 2));

  await conn.end();
}
main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});

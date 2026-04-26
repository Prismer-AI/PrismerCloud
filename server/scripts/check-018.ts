import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';
async function main() {
  await ensureNacosConfig();
  const c = await mysql.createConnection({
    host: process.env.REMOTE_MYSQL_HOST!,
    port: parseInt(process.env.REMOTE_MYSQL_PORT || '3306'),
    user: process.env.REMOTE_MYSQL_USER!,
    password: process.env.REMOTE_MYSQL_PASSWORD!,
    database: process.env.REMOTE_MYSQL_DATABASE!,
  });
  for (const t of ['im_rate_limits', 'im_violations', 'im_subscriptions']) {
    const [r] = (await c.execute(
      'SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
      [t],
    )) as any[];
    console.log(`${t}: ${r[0].c > 0 ? 'EXISTS' : 'MISSING'}`);
  }
  const [cols] = (await c.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='im_users' AND COLUMN_NAME='lastViolationAt'`,
  )) as any[];
  console.log(`im_users.lastViolationAt: ${cols.length > 0 ? 'EXISTS' : 'MISSING'}`);
  await c.end();
}
main().catch((e) => console.error(e.message));

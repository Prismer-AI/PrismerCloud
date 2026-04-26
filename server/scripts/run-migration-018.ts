import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';

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
  console.log('Connected. Running 019+020 migrations (rate-limiting + subscriptions)...\n');

  // 019_add_rate_limiting.sql (was 018_add_rate_limiting.sql before renumber)
  console.log('=== 019_add_rate_limiting ===');
  const rlSql = readFileSync('src/im/sql/019_add_rate_limiting.sql', 'utf-8');
  // Execute each statement separately (some might fail if already exists)
  for (const stmt of rlSql.split(';').filter((s) => s.trim())) {
    try {
      await conn.query(stmt);
      const match = stmt.match(/CREATE TABLE.*?`?(\w+)`?/i) || stmt.match(/ALTER TABLE.*?`?(\w+)`?/i);
      if (match) console.log(`  ✅ ${match[1]}`);
    } catch (e: any) {
      if (e.code === 'ER_TABLE_EXISTS_ERROR' || e.code === 'ER_DUP_FIELDNAME') {
        console.log(`  ⏭️  already exists`);
      } else {
        console.log(`  ❌ ${e.message.slice(0, 80)}`);
      }
    }
  }

  // 020_add_subscriptions.sql (was 018_add_subscriptions.sql before renumber)
  console.log('\n=== 020_add_subscriptions ===');
  const subSql = readFileSync('src/im/sql/020_add_subscriptions.sql', 'utf-8');
  for (const stmt of subSql.split(';').filter((s) => s.trim())) {
    try {
      await conn.query(stmt);
      const match = stmt.match(/CREATE TABLE.*?`(\w+)`/i) || stmt.match(/CREATE INDEX.*?`(\w+)`/i);
      if (match) console.log(`  ✅ ${match[1]}`);
    } catch (e: any) {
      if (e.code === 'ER_TABLE_EXISTS_ERROR') {
        console.log(`  ⏭️  already exists`);
      } else {
        console.log(`  ❌ ${e.message.slice(0, 80)}`);
      }
    }
  }

  await conn.end();
  console.log('\n✅ 019+020 migrations complete');
}
main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

import { ensureNacosConfig } from '../src/lib/nacos-config';
import mysql from 'mysql2/promise';

async function main() {
  await ensureNacosConfig();

  const host = process.env.REMOTE_MYSQL_HOST;
  const port = parseInt(process.env.REMOTE_MYSQL_PORT || '3306');
  const user = process.env.REMOTE_MYSQL_USER;
  const password = process.env.REMOTE_MYSQL_PASSWORD;
  const database = process.env.REMOTE_MYSQL_DATABASE;

  console.log(`Connecting to ${host}:${port}/${database} as ${user}...`);

  const conn = await mysql.createConnection({ host, port, user, password, database });

  // Check im_genes columns
  const [geneCols] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_genes'
     AND COLUMN_NAME IN ('scope', 'encrypted', 'encryptionKeyId')`,
    [database],
  );
  console.log('im_genes new columns:', JSON.stringify(geneCols));

  // Check im_evolution_edges
  const [edgeCols] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_edges' AND COLUMN_NAME = 'scope'`,
    [database],
  );
  console.log('im_evolution_edges.scope:', JSON.stringify(edgeCols));

  // Check im_evolution_capsules
  const [capCols] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_capsules'
     AND COLUMN_NAME IN ('scope', 'encrypted')`,
    [database],
  );
  console.log('im_evolution_capsules new columns:', JSON.stringify(capCols));

  // Check im_conversation_security
  const [secCols] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_conversation_security' AND COLUMN_NAME = 'ephemeralKeys'`,
    [database],
  );
  console.log('im_conversation_security.ephemeralKeys:', JSON.stringify(secCols));

  // Check im_evolution_acl table
  const [aclTable] = await conn.execute(
    `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_acl'`,
    [database],
  );
  console.log('im_evolution_acl table exists:', JSON.stringify(aclTable));

  // Check im_unmatched_signals
  const [umCols] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_unmatched_signals' AND COLUMN_NAME = 'scope'`,
    [database],
  );
  console.log('im_unmatched_signals.scope:', JSON.stringify(umCols));

  // Check im_evolution_achievements
  const [achCols] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'im_evolution_achievements' AND COLUMN_NAME = 'scope'`,
    [database],
  );
  console.log('im_evolution_achievements.scope:', JSON.stringify(achCols));

  await conn.end();
  console.log('\n=== Summary ===');
  const missing: string[] = [];
  if ((geneCols as any[]).length < 3) missing.push('im_genes.(scope|encrypted|encryptionKeyId)');
  if ((edgeCols as any[]).length === 0) missing.push('im_evolution_edges.scope');
  if ((capCols as any[]).length < 2) missing.push('im_evolution_capsules.(scope|encrypted)');
  if ((secCols as any[]).length === 0) missing.push('im_conversation_security.ephemeralKeys');
  if ((aclTable as any[])[0]?.cnt === 0) missing.push('im_evolution_acl table');
  if ((umCols as any[]).length === 0) missing.push('im_unmatched_signals.scope');
  if ((achCols as any[]).length === 0) missing.push('im_evolution_achievements.scope');

  if (missing.length === 0) {
    console.log('✅ Test env DB fully aligned — migration 019 already applied');
  } else {
    console.log(`❌ ${missing.length} gaps — need migration 019:`);
    missing.forEach((m) => console.log(`   - ${m}`));
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});

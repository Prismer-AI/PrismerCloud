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

  console.log('=== Capsule signal distribution ===');
  const [capsules] = (await c.execute(
    `SELECT signalKey, outcome, summary, geneId FROM im_evolution_capsules ORDER BY createdAt DESC LIMIT 30`,
  )) as any[];
  for (const cap of capsules) {
    console.log(
      `  ${cap.outcome.padEnd(8)} | ${(cap.signalKey || '').slice(0, 50).padEnd(50)} | gene:${(cap.geneId || '').slice(0, 35)}`,
    );
  }

  console.log('\n=== Edge signal-gene pairs ===');
  const [edges] = (await c.execute(
    `SELECT signalKey, geneId, successCount, failureCount FROM im_evolution_edges ORDER BY updatedAt DESC LIMIT 20`,
  )) as any[];
  for (const e of edges) {
    console.log(
      `  s/f: ${e.successCount}/${e.failureCount} | ${(e.signalKey || '').slice(0, 45).padEnd(45)} | ${(e.geneId || '').slice(0, 35)}`,
    );
  }

  console.log('\n=== Unmatched signals (top by count) ===');
  const [unmatched] = (await c.execute(
    `SELECT signalKey, count, context FROM im_unmatched_signals ORDER BY count DESC LIMIT 15`,
  )) as any[];
  for (const u of unmatched) {
    const ctx = u.context ? JSON.parse(u.context) : {};
    console.log(
      `  count:${String(u.count).padEnd(3)} | ${(u.signalKey || '').slice(0, 50)} | ctx:${JSON.stringify(ctx).slice(0, 60)}`,
    );
  }

  console.log('\n=== Gene category distribution ===');
  const [cats] = (await c.execute(
    `SELECT category, visibility, COUNT(*) as cnt FROM im_genes GROUP BY category, visibility ORDER BY cnt DESC`,
  )) as any[];
  for (const cat of cats) {
    console.log(`  ${cat.category.padEnd(12)} ${cat.visibility.padEnd(12)} ${cat.cnt}`);
  }

  console.log('\n=== ClawHub skills category sample (from im_skills) ===');
  const [skills] = (await c.execute(
    `SELECT category, COUNT(*) as cnt FROM im_skills GROUP BY category ORDER BY cnt DESC LIMIT 10`,
  )) as any[];
  for (const s of skills) {
    console.log(`  ${(s.category || 'null').padEnd(20)} ${s.cnt}`);
  }

  // What do agents ACTUALLY ask about?
  console.log('\n=== Signal type distribution (from edges) ===');
  const [signalTypes] = (await c.execute(
    `SELECT signalType, COUNT(*) as cnt FROM im_evolution_edges WHERE signalType IS NOT NULL GROUP BY signalType ORDER BY cnt DESC LIMIT 15`,
  )) as any[];
  for (const st of signalTypes) {
    console.log(`  ${(st.signalType || '').padEnd(30)} ${st.cnt}`);
  }

  await c.end();
}

main().catch((e) => console.error(e.message));

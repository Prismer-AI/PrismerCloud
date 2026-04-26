/**
 * 探测 prismer_info.context_data 表
 * APP_ENV=test npx tsx scripts/probe-context-data.ts
 */
import { ensureNacosConfig } from '../src/lib/nacos-config';
import { query, closePool } from '../src/lib/db';

async function main() {
  await ensureNacosConfig();

  console.log('\n===== 探测 prismer_info.context_data =====\n');

  try {
    // 1. 行数
    const r = await query<any>('SELECT COUNT(*) as cnt FROM prismer_info.context_data');
    console.log('[行数]', r[0].cnt);

    // 2. schema
    const cols = await query<any>(`
      SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = 'prismer_info' AND TABLE_NAME = 'context_data'
      ORDER BY ORDINAL_POSITION
    `);
    console.log('\n[表结构]');
    cols.forEach((c: any) =>
      console.log(`  ${(c.COLUMN_NAME || '').padEnd(22)} ${(c.COLUMN_TYPE || '').padEnd(20)} ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}  ${c.COLUMN_KEY || ''}  ${c.COLUMN_DEFAULT ?? ''}`)
    );

    // 3. 按 visibility
    try {
      const vis = await query<any>('SELECT visibility, COUNT(*) as cnt FROM prismer_info.context_data GROUP BY visibility');
      console.log('\n[按 visibility]');
      vis.forEach((r: any) => console.log(`  ${r.visibility || '(NULL)'}: ${r.cnt}`));
    } catch { console.log('\n[按 visibility] visibility 列不存在'); }

    // 4. 按 user_id
    try {
      const users = await query<any>('SELECT user_id, COUNT(*) as cnt FROM prismer_info.context_data GROUP BY user_id ORDER BY cnt DESC LIMIT 10');
      console.log('\n[按 user_id Top 10]');
      users.forEach((r: any) => console.log(`  ${r.user_id}: ${r.cnt}`));
    } catch {
      // 可能列名不同
      try {
        const users2 = await query<any>('SELECT uid, COUNT(*) as cnt FROM prismer_info.context_data GROUP BY uid ORDER BY cnt DESC LIMIT 10');
        console.log('\n[按 uid Top 10]');
        users2.forEach((r: any) => console.log(`  ${r.uid}: ${r.cnt}`));
      } catch { console.log('\n[按 user] 没有 user_id 或 uid 列'); }
    }

    // 5. 采样 — 先拿列名，动态构建查询
    console.log('\n[最近 5 条采样]');
    const colNames = cols.map((c: any) => c.COLUMN_NAME as string);

    // 构建安全的 SELECT
    const selectParts = colNames.map((name: string) => {
      const lower = name.toLowerCase();
      if (lower.includes('content') || lower.includes('text') || lower.includes('body')) {
        return `LENGTH(\`${name}\`) as \`${name}_bytes\``;
      }
      if (lower === 'meta' || lower === 'metadata') {
        return `LEFT(CAST(\`${name}\` AS CHAR), 150) as \`${name}_preview\``;
      }
      if (lower === 'raw_link' || lower === 'url' || lower === 'link') {
        return `LEFT(\`${name}\`, 100) as \`${name}\``;
      }
      return `\`${name}\``;
    });

    // 找时间列排序
    const timeCol = colNames.find((n: string) => ['created_at', 'create_time', 'created', 'gmt_create'].includes(n.toLowerCase()));
    const orderBy = timeCol ? `ORDER BY \`${timeCol}\` DESC` : '';

    const sampleQuery = `SELECT ${selectParts.join(', ')} FROM prismer_info.context_data ${orderBy} LIMIT 5`;
    const samples = await query<any>(sampleQuery);
    samples.forEach((row: any, i: number) => {
      console.log(`\n  --- #${i + 1} ---`);
      Object.entries(row).forEach(([k, v]) => {
        const val = v instanceof Date ? v.toISOString() : v;
        console.log(`  ${k.padEnd(24)} ${val}`);
      });
    });

    // 6. 存储大小
    console.log('\n[存储统计]');
    const contentCols = colNames.filter((n: string) =>
      n.toLowerCase().includes('content') || n.toLowerCase().includes('text') || n.toLowerCase().includes('body')
    );
    if (contentCols.length > 0) {
      const sizeParts = contentCols.map((n: string) =>
        `ROUND(SUM(COALESCE(LENGTH(\`${n}\`), 0)) / 1048576, 2) as \`${n}_mb\``
      );
      const sizeResult = await query<any>(`SELECT ${sizeParts.join(', ')} FROM prismer_info.context_data`);
      Object.entries(sizeResult[0]).forEach(([k, v]) => console.log(`  ${k}: ${v} MB`));
    }

    // 7. 内容大小分布
    if (contentCols.length > 0) {
      const mainContentCol = contentCols.find((n: string) => n.toLowerCase().includes('hqcc')) || contentCols[0];
      console.log(`\n[${mainContentCol} 大小分布]`);
      const distResult = await query<any>(`
        SELECT
          CASE
            WHEN LENGTH(\`${mainContentCol}\`) IS NULL THEN 'NULL'
            WHEN LENGTH(\`${mainContentCol}\`) < 1024 THEN '< 1KB'
            WHEN LENGTH(\`${mainContentCol}\`) < 10240 THEN '1-10KB'
            WHEN LENGTH(\`${mainContentCol}\`) < 102400 THEN '10-100KB'
            WHEN LENGTH(\`${mainContentCol}\`) < 1048576 THEN '100KB-1MB'
            ELSE '> 1MB'
          END as size_range,
          COUNT(*) as cnt
        FROM prismer_info.context_data
        GROUP BY size_range
      `);
      distResult.forEach((r: any) => console.log(`  ${(r.size_range || '').padEnd(12)}: ${r.cnt}`));
    }

  } catch (e: any) {
    console.error('失败:', e.message);
    // 尝试列出所有可访问的表
    console.log('\n尝试列出 prismer_info 中的所有表...');
    try {
      const tables = await query<any>(`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = 'prismer_info'
        ORDER BY TABLE_NAME
      `);
      console.log(`找到 ${tables.length} 张表:`);
      tables.forEach((t: any) => console.log(`  ${t.TABLE_NAME}`));
    } catch (e2: any) {
      console.error('列表也失败:', e2.message);
    }
  } finally {
    await closePool();
  }
}

main().catch(console.error);

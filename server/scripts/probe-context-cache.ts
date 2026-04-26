/**
 * 探测 context_cache 表的实际数据情况
 *
 * 用法:
 *   APP_ENV=test npx tsx scripts/probe-context-cache.ts
 *   APP_ENV=prod npx tsx scripts/probe-context-cache.ts
 *
 * 输出:
 *   - 表是否存在
 *   - 实际 schema (DESCRIBE)
 *   - 行数
 *   - 数据采样 (最近 5 条)
 *   - 按 visibility 统计
 *   - 按 user_id 统计
 *   - 内容大小分布
 */

import { ensureNacosConfig } from '../src/lib/nacos-config';

async function main() {
  const env = process.env.APP_ENV || 'test';
  console.log(`\n========================================`);
  console.log(`  探测 context_cache 表 (${env} 环境)`);
  console.log(`========================================\n`);

  // 1. 加载 Nacos 配置
  console.log('[1/7] 加载 Nacos 配置...');
  await ensureNacosConfig();

  // 动态导入 db（需要 Nacos 先加载完 REMOTE_MYSQL_* 变量）
  const { query, closePool } = await import('../src/lib/db');

  const dbInfo = {
    host: process.env.REMOTE_MYSQL_HOST,
    database: process.env.REMOTE_MYSQL_DATABASE,
    user: process.env.REMOTE_MYSQL_USER,
  };
  console.log('  数据库连接:', dbInfo);

  try {
    // 2. 检查表是否存在
    console.log('\n[2/7] 检查 context_cache 表是否存在...');
    try {
      const tables = await query<any>(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'context_cache'`,
        [process.env.REMOTE_MYSQL_DATABASE || '']
      );
      if (tables.length === 0) {
        console.log('  ❌ context_cache 表不存在于当前数据库');
        console.log('  尝试查找所有数据库中的 context_cache...');
        const allTables = await query<any>(
          `SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES
           WHERE TABLE_NAME = 'context_cache'`
        );
        if (allTables.length > 0) {
          console.log('  找到 context_cache 在以下数据库中:');
          allTables.forEach((t: any) => console.log(`    - ${t.TABLE_SCHEMA}.${t.TABLE_NAME}`));
        } else {
          console.log('  ❌ 所有数据库中都没有 context_cache 表');
        }
        await closePool();
        return;
      }
      console.log('  ✅ context_cache 表存在');
    } catch (err: any) {
      // 可能连的是 prismer_cloud 而不是 prismer_info
      // 尝试跨库查询
      console.log(`  当前库查询出错: ${err.message}`);
      console.log('  尝试跨库检查 prismer_info.context_cache...');
      try {
        const crossCheck = await query<any>(
          `SELECT COUNT(*) as cnt FROM prismer_info.context_cache LIMIT 1`
        );
        console.log('  ✅ prismer_info.context_cache 可访问 (跨库)');
      } catch (err2: any) {
        console.log(`  ❌ 跨库也失败: ${err2.message}`);
        await closePool();
        return;
      }
    }

    // 确定表的完整名称（可能需要跨库）
    let tableName = 'context_cache';
    try {
      await query<any>(`SELECT 1 FROM context_cache LIMIT 1`);
    } catch {
      tableName = 'prismer_info.context_cache';
      try {
        await query<any>(`SELECT 1 FROM ${tableName} LIMIT 1`);
        console.log(`  使用跨库名称: ${tableName}`);
      } catch (err: any) {
        console.log(`  ❌ 无法访问 context_cache: ${err.message}`);
        await closePool();
        return;
      }
    }

    // 3. Schema
    console.log('\n[3/7] 表结构 (DESCRIBE)...');
    try {
      const schema = await query<any>(`DESCRIBE ${tableName}`);
      console.log('  列名                  | 类型              | Null | Key | Default');
      console.log('  ' + '-'.repeat(80));
      schema.forEach((col: any) => {
        const name = col.Field?.padEnd(22) || '';
        const type = (col.Type || '').padEnd(18);
        const nullable = (col.Null || '').padEnd(5);
        const key = (col.Key || '').padEnd(4);
        const def = col.Default ?? 'NULL';
        console.log(`  ${name}| ${type}| ${nullable}| ${key}| ${def}`);
      });
    } catch (err: any) {
      console.log(`  DESCRIBE 失败: ${err.message}`);
      // 用 information_schema 兜底
      const columns = await query<any>(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
         WHERE TABLE_NAME = 'context_cache'
         ORDER BY ORDINAL_POSITION`
      );
      columns.forEach((col: any) => {
        console.log(`  ${col.COLUMN_NAME}: ${col.COLUMN_TYPE} ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'} ${col.COLUMN_KEY || ''}`);
      });
    }

    // 4. 行数
    console.log('\n[4/7] 数据统计...');
    const countResult = await query<any>(`SELECT COUNT(*) as total FROM ${tableName}`);
    const total = countResult[0]?.total || 0;
    console.log(`  总行数: ${total}`);

    if (total === 0) {
      console.log('  表为空，无需迁移');
      await closePool();
      return;
    }

    // 5. 按 visibility 统计
    console.log('\n[5/7] 按 visibility 统计...');
    try {
      const visCounts = await query<any>(
        `SELECT visibility, COUNT(*) as cnt FROM ${tableName} GROUP BY visibility`
      );
      visCounts.forEach((r: any) => {
        console.log(`  ${r.visibility || '(NULL)'}: ${r.cnt} 条`);
      });
    } catch (err: any) {
      console.log(`  统计失败: ${err.message}`);
    }

    // 6. 按 user_id 统计 (top 10)
    console.log('\n[6/7] 按 user_id 统计 (Top 10)...');
    try {
      const userCounts = await query<any>(
        `SELECT user_id, COUNT(*) as cnt FROM ${tableName} GROUP BY user_id ORDER BY cnt DESC LIMIT 10`
      );
      userCounts.forEach((r: any) => {
        console.log(`  ${r.user_id}: ${r.cnt} 条`);
      });
    } catch (err: any) {
      console.log(`  统计失败: ${err.message}`);
    }

    // 7. 最近 5 条采样（不含 content 全文，只看结构）
    console.log('\n[7/7] 最近 5 条采样...');
    try {
      const samples = await query<any>(
        `SELECT id, user_id, content_uri,
                LEFT(raw_link, 80) as raw_link_preview,
                LENGTH(hqcc_content) as hqcc_bytes,
                LENGTH(intr_content) as intr_bytes,
                visibility,
                LEFT(CAST(meta AS CHAR), 100) as meta_preview,
                expires_at, created_at, updated_at
         FROM ${tableName}
         ORDER BY created_at DESC
         LIMIT 5`
      );
      samples.forEach((row: any, i: number) => {
        console.log(`\n  --- 样本 ${i + 1} ---`);
        console.log(`  id:           ${row.id}`);
        console.log(`  user_id:      ${row.user_id}`);
        console.log(`  content_uri:  ${row.content_uri}`);
        console.log(`  raw_link:     ${row.raw_link_preview}${row.raw_link_preview?.length >= 80 ? '...' : ''}`);
        console.log(`  hqcc_bytes:   ${row.hqcc_bytes || 0} bytes`);
        console.log(`  intr_bytes:   ${row.intr_bytes || 0} bytes`);
        console.log(`  visibility:   ${row.visibility}`);
        console.log(`  meta:         ${row.meta_preview}${row.meta_preview?.length >= 100 ? '...' : ''}`);
        console.log(`  expires_at:   ${row.expires_at}`);
        console.log(`  created_at:   ${row.created_at}`);
      });
    } catch (err: any) {
      console.log(`  采样失败: ${err.message}`);
    }

    // 内容大小分布
    console.log('\n[附] 内容大小分布...');
    try {
      const sizeDist = await query<any>(
        `SELECT
           CASE
             WHEN LENGTH(hqcc_content) < 1024 THEN '< 1KB'
             WHEN LENGTH(hqcc_content) < 10240 THEN '1-10KB'
             WHEN LENGTH(hqcc_content) < 102400 THEN '10-100KB'
             WHEN LENGTH(hqcc_content) < 1048576 THEN '100KB-1MB'
             ELSE '> 1MB'
           END as size_range,
           COUNT(*) as cnt,
           ROUND(SUM(LENGTH(hqcc_content)) / 1048576, 2) as total_mb
         FROM ${tableName}
         GROUP BY size_range
         ORDER BY MIN(LENGTH(hqcc_content))`
      );
      sizeDist.forEach((r: any) => {
        console.log(`  ${(r.size_range || '').padEnd(12)}: ${String(r.cnt).padStart(6)} 条, ${r.total_mb} MB`);
      });
    } catch (err: any) {
      console.log(`  分布统计失败: ${err.message}`);
    }

    // 总存储量
    try {
      const totalSize = await query<any>(
        `SELECT
           ROUND(SUM(LENGTH(hqcc_content)) / 1048576, 2) as hqcc_mb,
           ROUND(SUM(LENGTH(intr_content)) / 1048576, 2) as intr_mb,
           ROUND((SUM(LENGTH(hqcc_content)) + SUM(COALESCE(LENGTH(intr_content), 0))) / 1048576, 2) as total_mb
         FROM ${tableName}`
      );
      console.log(`\n  总存储: hqcc=${totalSize[0]?.hqcc_mb}MB, intr=${totalSize[0]?.intr_mb}MB, 合计=${totalSize[0]?.total_mb}MB`);
    } catch (err: any) {
      console.log(`  存储统计失败: ${err.message}`);
    }

    console.log('\n========================================');
    console.log('  探测完成');
    console.log('========================================\n');

  } catch (err: any) {
    console.error('探测失败:', err.message);
  } finally {
    await closePool();
  }
}

main().catch(console.error);

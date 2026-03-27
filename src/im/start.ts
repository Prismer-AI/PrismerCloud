/**
 * IM Server Entry Point
 *
 * 启动命令: npx tsx src/im/start.ts
 * 或通过 package.json: npm run im:start
 */

import { createServer } from './server';
import path from 'path';

// 在启动前构建 DATABASE_URL
function buildDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;

  // 本地开发默认使用 SQLite
  if (process.env.NODE_ENV !== 'production') {
    const dbPath = path.resolve(process.cwd(), 'prisma/data/dev.db');
    return `file:${dbPath}`;
  }

  // 生产环境从 MySQL 环境变量构建
  const host = process.env.REMOTE_MYSQL_HOST || process.env.MYSQL_HOST || 'localhost';
  const port = process.env.REMOTE_MYSQL_PORT || process.env.MYSQL_PORT || '3306';
  const user = process.env.REMOTE_MYSQL_USER || process.env.MYSQL_USER || 'root';
  const password = process.env.REMOTE_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '';
  const database = process.env.REMOTE_MYSQL_DATABASE || process.env.MYSQL_DATABASE || 'prismer_cloud';

  return `mysql://${user}:${password}@${host}:${port}/${database}`;
}

// 设置环境变量
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = buildDatabaseUrl();
}

console.log('[IM Server] Starting...');
console.log('[IM Server] DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 30) + '...');

createServer()
  .then(() => {
    console.log('[IM Server] Ready');
  })
  .catch((error) => {
    console.error('[IM Server] Failed to start:', error);
    process.exit(1);
  });

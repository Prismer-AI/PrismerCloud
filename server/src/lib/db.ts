/**
 * Database Connection Pool
 * 
 * 用于前端先行实现，直连 MySQL 数据库
 * 表使用 pc_ 前缀，与后端开发解耦
 * 
 * 环境变量配置：
 * - REMOTE_MYSQL_HOST
 * - REMOTE_MYSQL_PORT
 * - REMOTE_MYSQL_USER
 * - REMOTE_MYSQL_PASSWORD
 * - REMOTE_MYSQL_DATABASE
 */

import * as mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

// 单例连接池
let pool: Pool | null = null;

/**
 * 获取数据库连接池（单例模式）
 * 
 * 注意：使用前必须确保 Nacos 配置已加载（调用 ensureNacosConfig）
 * 
 * 数据库配置来源：
 * - REMOTE_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE 环境变量
 * - 或通过 Nacos 配置中心加载
 */
export function getPool(): Pool {
  if (!pool) {
    // 检查必要的环境变量
    if (!process.env.REMOTE_MYSQL_HOST) {
      console.error('[DB] REMOTE_MYSQL_HOST not set! Ensure Nacos config is loaded.');
    }
    
    const config = {
      host: process.env.REMOTE_MYSQL_HOST || 'localhost',
      port: parseInt(process.env.REMOTE_MYSQL_PORT || '3306'),
      user: process.env.REMOTE_MYSQL_USER || 'root',
      password: process.env.REMOTE_MYSQL_PASSWORD || '',
      database: process.env.REMOTE_MYSQL_DATABASE || 'prismer_cloud',
      waitForConnections: true,
      connectionLimit: 10,  // Vercel 限制，不宜过大
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      // BigInt handling: return numbers (not JS BigInt) for safe-range values,
      // strings for values exceeding Number.MAX_SAFE_INTEGER
      supportBigNumbers: true,
      bigNumberStrings: false,
      // 超时设置
      connectTimeout: 10000,
      // 时区
      timezone: '+00:00',
    };
    
    console.log('[DB] Creating connection pool:', {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      connectionLimit: config.connectionLimit
    });
    
    pool = mysql.createPool(config);
  }
  return pool;
}

/**
 * 执行查询（自动获取连接并释放）
 */
export async function query<T extends RowDataPacket[]>(
  sql: string, 
  params?: (string | number | boolean | null | Date)[]
): Promise<T> {
  const pool = getPool();
  const [rows] = await pool.execute<T>(sql, params);
  return rows;
}

/**
 * 执行插入/更新/删除（返回 ResultSetHeader）
 */
export async function execute(
  sql: string,
  params?: (string | number | boolean | null | Date)[]
): Promise<ResultSetHeader> {
  const pool = getPool();
  const [result] = await pool.execute<ResultSetHeader>(sql, params);
  return result;
}

/**
 * 获取单条记录
 */
export async function queryOne<T extends RowDataPacket>(
  sql: string,
  params?: (string | number | boolean | null | Date)[]
): Promise<T | null> {
  const rows = await query<T[]>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 事务支持
 */
export async function withTransaction<T>(
  callback: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 生成 UUID (cryptographically secure)
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * 关闭连接池（用于测试或优雅关闭）
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] Connection pool closed');
  }
}

const db = {
  getPool,
  query,
  execute,
  queryOne,
  withTransaction,
  generateUUID,
  closePool
};

export default db;

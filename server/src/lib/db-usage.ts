/**
 * Database Operations for Usage Records
 *
 * 操作表：pc_usage_records
 * 前端先行实现，与后端 usage_records 解耦
 */

import { query, execute, queryOne, generateUUID } from './db';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';

// ============================================================================
// Types
// ============================================================================

export interface UsageRecordInput {
  task_id: string;
  task_type: string;
  input: {
    type: 'query' | 'url' | 'urls' | 'file' | 'content';
    value: string;
  };
  metrics?: {
    exa_searches?: number;
    urls_processed?: number;
    urls_cached?: number;
    urls_compressed?: number;
    tokens_input?: number;
    tokens_output?: number;
    processing_time_ms?: number;
    pages_parsed?: number;
    images_extracted?: number;
    parse_mode?: string;
  };
  cost: {
    search_credits?: number;
    compression_credits?: number;
    parse_credits?: number;
    total_credits: number;
  };
  sources?: Array<{
    url: string;
    cached: boolean;
    tokens: number;
  }>;
  status?: 'completed' | 'failed' | 'processing';
  error_message?: string;
}

export interface UsageRecordRow extends RowDataPacket {
  id: string;
  user_id: number;
  task_id: string;
  task_type: string;
  input_type: string;
  input_value: string;
  exa_searches: number;
  urls_processed: number;
  urls_cached: number;
  urls_compressed: number;
  tokens_input: number;
  tokens_output: number;
  processing_time_ms: number;
  pages_parsed: number;
  images_extracted: number;
  parse_mode: string | null;
  search_credits: string;
  compression_credits: string;
  parse_credits: string;
  total_credits: string;
  sources_json: string | null;
  error_message: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

// Activity 格式 - 匹配前端 types/index.ts 中的 Activity 接口
export interface Activity {
  id: string;
  url: string; // 显示 URL 或 query
  strategy: string; // 显示 task_type，如 "load", "save", "parse"
  status: 'Completed' | 'Processing' | 'Failed';
  cost: string; // 字符串格式，如 "0.78 credits"
  time: string; // 相对时间，如 "2 min ago"
  // 扩展字段 (用于获取 hqcc)
  taskId?: string; // 任务 ID
  inputType?: string; // 输入类型: url, urls, query, file
  sources?: Array<{
    // 来源 URL 列表 (用于 /api/context/load 获取 hqcc)
    url: string;
    cached: boolean;
  }>;
  metrics?: {
    urlsProcessed?: number;
    urlsCached?: number;
    tokensInput?: number;
    tokensOutput?: number;
    pagesParsed?: number;
    imagesExtracted?: number;
  };
}

// ============================================================================
// Create
// ============================================================================

/**
 * 创建使用记录
 */
export async function createUsageRecord(
  userId: number,
  input: UsageRecordInput,
  externalConn?: PoolConnection,
): Promise<{ id: string; credits_deducted: number }> {
  const id = generateUUID();
  const metrics = input.metrics || {};
  const cost = input.cost;

  const sql = `
    INSERT INTO pc_usage_records (
      id, user_id, task_id, task_type,
      input_type, input_value,
      exa_searches, urls_processed, urls_cached, urls_compressed,
      tokens_input, tokens_output, processing_time_ms,
      pages_parsed, images_extracted, parse_mode,
      search_credits, compression_credits, parse_credits, total_credits,
      sources_json, error_message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    userId,
    input.task_id,
    input.task_type,
    input.input.type,
    input.input.value,
    metrics.exa_searches || 0,
    metrics.urls_processed || 0,
    metrics.urls_cached || 0,
    metrics.urls_compressed || 0,
    metrics.tokens_input || 0,
    metrics.tokens_output || 0,
    metrics.processing_time_ms || 0,
    metrics.pages_parsed || 0,
    metrics.images_extracted || 0,
    metrics.parse_mode || null,
    cost.search_credits || 0,
    cost.compression_credits || 0,
    cost.parse_credits || 0,
    cost.total_credits,
    input.sources ? JSON.stringify(input.sources) : null,
    input.error_message || null,
    input.status || 'completed',
  ];

  if (externalConn) {
    await externalConn.execute(sql, params);
  } else {
    await execute(sql, params);
  }

  return {
    id,
    credits_deducted: cost.total_credits,
  };
}

// ============================================================================
// Read
// ============================================================================

/**
 * 获取用户的使用记录列表（分页）
 */
export async function getUserUsageRecords(
  userId: number,
  page: number = 1,
  limit: number = 20,
): Promise<{ records: UsageRecordRow[]; total: number }> {
  const offset = (page - 1) * limit;

  // 获取总数
  const countSql = `SELECT COUNT(*) as total FROM pc_usage_records WHERE user_id = ?`;
  const countResult = await queryOne<{ total: number } & RowDataPacket>(countSql, [userId]);
  const total = Number(countResult?.total || 0);

  // 获取记录
  // Note: LIMIT/OFFSET inlined (not parameterized) because mysql2 pool.execute()
  // sends JS numbers as DOUBLE in binary protocol, which MySQL rejects for LIMIT/OFFSET
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const sql = `
    SELECT * FROM pc_usage_records
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `;
  const records = await query<UsageRecordRow[]>(sql, [userId]);

  return { records, total };
}

/**
 * 格式化相对时间
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

/**
 * 格式化 credits 显示
 */
function formatCredits(credits: string | number): string {
  const num = typeof credits === 'string' ? parseFloat(credits) : credits;
  if (num === 0) return 'Free';
  return `${num.toFixed(4)} credits`;
}

/**
 * 转换状态为前端期望的格式（首字母大写）
 */
function formatStatus(status: string): 'Completed' | 'Processing' | 'Failed' {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'processing':
      return 'Processing';
    case 'failed':
      return 'Failed';
    default:
      return 'Completed';
  }
}

/**
 * 转换为 Activity 格式（用于前端显示）
 * 匹配 types/index.ts 中的 Activity 接口
 */
export function toActivity(record: UsageRecordRow): Activity {
  // 解析 sources JSON
  let sources: Array<{ url: string; cached: boolean }> | undefined;
  if (record.sources_json) {
    try {
      const parsed = JSON.parse(record.sources_json);
      sources = parsed.map((s: { url: string; cached: boolean; tokens?: number }) => ({
        url: s.url,
        cached: s.cached,
      }));
    } catch {
      // ignore parse error
    }
  }

  return {
    id: record.id,
    url: truncate(record.input_value, 80), // 显示 URL 或 query
    strategy: record.task_type, // load, save, parse 等
    status: formatStatus(record.status),
    cost: formatCredits(record.total_credits),
    time: formatRelativeTime(record.created_at),
    // 扩展字段
    taskId: record.task_id,
    inputType: record.input_type,
    sources,
    metrics: {
      urlsProcessed: record.urls_processed || undefined,
      urlsCached: record.urls_cached || undefined,
      tokensInput: record.tokens_input ? Number(record.tokens_input) : undefined,
      tokensOutput: record.tokens_output ? Number(record.tokens_output) : undefined,
      pagesParsed: record.pages_parsed || undefined,
      imagesExtracted: record.images_extracted || undefined,
    },
  };
}

/**
 * 获取用户活动列表（转换后的格式）
 */
export async function getUserActivities(
  userId: number,
  page: number = 1,
  limit: number = 20,
): Promise<{ activities: Activity[]; total: number; page: number; limit: number }> {
  const { records, total } = await getUserUsageRecords(userId, page, limit);
  const activities = records.map(toActivity);

  return {
    activities,
    total,
    page,
    limit,
  };
}

// ============================================================================
// Stats
// ============================================================================

export interface DashboardStats {
  chartData: Array<{
    date: string;
    requests: number;
    credits: number;
  }>;
  monthlyRequests: number;
  cacheHitRate: number;
  creditsRemaining: number;
  totalCreditsUsed: number;
  savings: {
    monthlyTokensInput: number;
    monthlyTokensOutput: number;
    monthlyTokensSaved: number;
    monthlyMoneySaved: number;
  };
}

/**
 * 获取 Dashboard 统计数据
 */
export async function getDashboardStats(
  userId: number,
  period: string = '7d',
  creditsRemaining: number = 0,
): Promise<DashboardStats> {
  // 解析时间范围
  const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;

  // 获取每日统计
  const chartSql = `
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as requests,
      SUM(total_credits) as credits
    FROM pc_usage_records 
    WHERE user_id = ? 
      AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      AND status = 'completed'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  const chartRows = await query<
    Array<
      {
        date: Date;
        requests: number;
        credits: string;
      } & RowDataPacket
    >
  >(chartSql, [userId, days]);

  // 填充缺失的日期
  const chartData = fillMissingDates(chartRows, days);

  // 获取本月统计
  const monthlySql = `
    SELECT 
      COUNT(*) as total_requests,
      SUM(urls_cached) as cache_hits,
      SUM(urls_processed) as total_urls,
      SUM(total_credits) as total_credits
    FROM pc_usage_records 
    WHERE user_id = ? 
      AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
      AND status = 'completed'
  `;

  const monthlyRow = await queryOne<
    {
      total_requests: number;
      cache_hits: number;
      total_urls: number;
      total_credits: string;
    } & RowDataPacket
  >(monthlySql, [userId]);

  const monthlyRequests = monthlyRow?.total_requests || 0;
  const cacheHits = monthlyRow?.cache_hits || 0;
  const totalUrls = monthlyRow?.total_urls || 0;
  const totalCreditsUsed = parseFloat(monthlyRow?.total_credits || '0');

  // 计算缓存命中率
  const cacheHitRate = totalUrls > 0 ? Math.round((cacheHits / totalUrls) * 100) : 0;

  // Token savings aggregation (monthly + all-time)
  const savingsSql = `
    SELECT
      SUM(tokens_input) as total_tokens_input,
      SUM(tokens_output) as total_tokens_output
    FROM pc_usage_records
    WHERE user_id = ?
      AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
      AND status = 'completed'
      AND tokens_input > 0
  `;
  const savingsRow = await queryOne<
    {
      total_tokens_input: string;
      total_tokens_output: string;
    } & RowDataPacket
  >(savingsSql, [userId]);

  const monthlyTokensInput = parseInt(savingsRow?.total_tokens_input || '0', 10);
  const monthlyTokensOutput = parseInt(savingsRow?.total_tokens_output || '0', 10);
  const monthlyTokensSaved = Math.max(0, monthlyTokensInput - monthlyTokensOutput);
  // $0.009 per 1K tokens (Claude Sonnet pricing)
  const monthlyMoneySaved = Math.round((monthlyTokensSaved / 1000) * 0.009 * 100) / 100;

  return {
    chartData,
    monthlyRequests,
    cacheHitRate,
    creditsRemaining,
    totalCreditsUsed,
    savings: {
      monthlyTokensInput,
      monthlyTokensOutput,
      monthlyTokensSaved,
      monthlyMoneySaved,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

function fillMissingDates(
  rows: Array<{ date: Date; requests: number; credits: string }>,
  days: number,
): Array<{ date: string; requests: number; credits: number }> {
  const result: Array<{ date: string; requests: number; credits: number }> = [];
  const dataMap = new Map<string, { requests: number; credits: number }>();

  // 建立已有数据的 map
  for (const row of rows) {
    const dateStr = row.date.toISOString().split('T')[0];
    dataMap.set(dateStr, {
      requests: row.requests,
      credits: parseFloat(row.credits || '0'),
    });
  }

  // 填充所有日期
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    const data = dataMap.get(dateStr);
    result.push({
      date: dateStr,
      requests: data?.requests || 0,
      credits: data?.credits || 0,
    });
  }

  return result;
}

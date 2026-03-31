import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { query, queryOne } from '@/lib/db';
import type { RowDataPacket } from 'mysql2/promise';

/**
 * GET /api/parse/history
 * 
 * 获取用户的 Parse 任务历史
 * 
 * Query params:
 * - page: 页码 (默认 1)
 * - limit: 每页数量 (默认 20，最大 100)
 * - status: 筛选状态 'completed' | 'failed' | 'processing' (可选)
 * 
 * Response:
 * - data: ParseHistoryItem[]
 * - pagination: { page, limit, total, totalPages }
 */
export async function GET(request: NextRequest) {
  try {
    await ensureNacosConfig();
    
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    // 验证用户
    const authResult = await getUserFromAuth(authHeader);
    if (!authResult.success || !authResult.user) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: authResult.error || 'Invalid token' }
      }, { status: 401 });
    }

    const userId = authResult.user.id;

    // 解析查询参数
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const status = searchParams.get('status');
    const offset = (page - 1) * limit;

    // 构建查询条件
    const conditions = ['user_id = ?', "task_type = 'parse'"];
    const params: (string | number)[] = [userId];

    if (status && ['completed', 'failed', 'processing'].includes(status)) {
      conditions.push('status = ?');
      params.push(status);
    }

    const whereClause = conditions.join(' AND ');

    // 获取总数
    const countSql = `SELECT COUNT(*) as total FROM pc_usage_records WHERE ${whereClause}`;
    const countResult = await queryOne<{ total: number } & RowDataPacket>(countSql, params);
    const total = countResult?.total || 0;

    // 获取记录
    const sql = `
      SELECT 
        id,
        task_id,
        input_type,
        input_value,
        pages_parsed,
        images_extracted,
        parse_mode,
        tokens_output,
        total_credits,
        status,
        processing_time_ms,
        created_at
      FROM pc_usage_records 
      WHERE ${whereClause}
      ORDER BY created_at DESC 
      LIMIT ${limit} OFFSET ${offset}
    `;
    
    const records = await query<ParseHistoryRow[]>(sql, params);

    // 格式化响应
    const data = records.map(formatParseHistoryItem);

    console.log(`[Parse History] User: ${userId}, Found: ${data.length}/${total}`);

    return NextResponse.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('[Parse History] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch parse history' }
    }, { status: 500 });
  }
}

// ============================================================================
// Types
// ============================================================================

interface ParseHistoryRow extends RowDataPacket {
  id: string;
  task_id: string;
  input_type: string;
  input_value: string;
  pages_parsed: number;
  images_extracted: number;
  parse_mode: string;
  tokens_output: number;
  total_credits: number;
  status: string;
  processing_time_ms: number;
  created_at: Date;
}

interface ParseHistoryItem {
  id: string;
  taskId: string;
  inputType: string;  // 'file', 'url', 'base64'
  inputValue: string; // 文件名或 URL
  pages: number;
  images: number;
  mode: string;       // 'fast', 'hires', 'auto'
  outputTokens: number;
  credits: number;
  status: 'completed' | 'processing' | 'failed';
  processingTimeMs: number;
  createdAt: string;  // ISO string
  // 结果获取端点
  endpoints?: {
    result: string;
    stream: string;
  };
}

function formatParseHistoryItem(row: ParseHistoryRow): ParseHistoryItem {
  const item: ParseHistoryItem = {
    id: row.id,
    taskId: row.task_id,
    inputType: row.input_type || 'file',
    inputValue: row.input_value || '',
    pages: row.pages_parsed || 0,
    images: row.images_extracted || 0,
    mode: row.parse_mode || 'auto',
    outputTokens: row.tokens_output || 0,
    credits: Number(row.total_credits) || 0,
    status: row.status as 'completed' | 'processing' | 'failed',
    processingTimeMs: row.processing_time_ms || 0,
    createdAt: row.created_at.toISOString(),
  };

  // 如果任务完成，提供结果获取端点
  if (row.status === 'completed' && row.task_id) {
    item.endpoints = {
      result: `/api/parse/result/${row.task_id}`,
      stream: `/api/parse/stream/${row.task_id}`,
    };
  }

  return item;
}

import { NextRequest, NextResponse } from 'next/server';
import { deposit } from '@/lib/context-api';
import {
  generateTaskId,
  createSaveUsageRecord,
  recordUsageBackground
} from '@/lib/usage-recorder';
import { apiGuard } from '@/lib/api-guard';

/**
 * POST /api/context/save
 *
 * 统一保存 API - 自动检测单条/批量
 *
 * 两种模式:
 * 1. 单条保存: { url: "...", hqcc: "..." }
 * 2. 批量保存: { items: [...] }
 *
 * 认证: 必需 (API Key 或 JWT) — tracked (free, record only)
 */

interface SaveItem {
  url: string;
  hqcc: string;
  raw?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  meta?: Record<string, any>;
}

export async function POST(request: NextRequest) {
  // Auth validation (tracked — no balance check, save is free)
  const guard = await apiGuard(request, { tier: 'tracked' });
  if (!guard.ok) return guard.response;

  const authHeader = guard.auth.authHeader;
  const userId = guard.auth.userId;

  try {
    const body = await request.json();

    // 2. 检测模式: 单条 vs 批量
    const isBatch = Array.isArray(body.items);

    if (isBatch) {
      return handleBatchSave(request, body.items, authHeader, userId);
    } else {
      return handleSingleSave(request, body, authHeader, userId);
    }

  } catch (error) {
    console.error('[Save API] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to process request' }
    }, { status: 500 });
  }
}

/**
 * 处理单条保存
 */
async function handleSingleSave(
  request: NextRequest,
  body: any,
  authHeader: string,
  userId: string
): Promise<NextResponse> {
  const startTime = Date.now();
  const { url, hqcc, raw, meta, visibility } = body;
  const taskId = generateTaskId('save');

  // 验证必填字段
  if (!url || !hqcc) {
    return NextResponse.json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'url and hqcc are required'
      }
    }, { status: 400 });
  }

  try {
    const result = await deposit(
      {
        url,
        hqcc,
        raw,
        visibility: visibility || 'private',
        meta: {
          ...meta,
          source: meta?.source || 'save_api',
          saved_at: new Date().toISOString()
        }
      },
      authHeader,
      userId
    );

    if (!result.ok) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'DEPOSIT_ERROR',
          message: result.error || 'Failed to deposit content'
        }
      }, { status: 500 });
    }

    // 记录使用量
    recordUsageBackground(
      createSaveUsageRecord({
        taskId,
        url,
        itemCount: 1,
        processingTimeMs: Date.now() - startTime
      }),
      authHeader
    );

    return NextResponse.json({
      success: true,
      status: result.data?.status || 'created',
      url,
      content_uri: result.data?.content_uri,
      visibility: result.data?.visibility
    });

  } catch (error) {
    console.error('[handleSingleSave] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'PROCESS_ERROR', message: 'Failed to save content' }
    }, { status: 500 });
  }
}

/**
 * 处理批量保存
 * 使用并发 deposit() 替代后端 batch endpoint（后端 batch 有 bug）
 */
async function handleBatchSave(
  request: NextRequest,
  items: SaveItem[],
  authHeader: string,
  userId: string
): Promise<NextResponse> {
  const startTime = Date.now();
  const taskId = generateTaskId('save_batch');

  // 验证 items
  if (!items || items.length === 0) {
    return NextResponse.json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'items array is required and cannot be empty'
      }
    }, { status: 400 });
  }

  if (items.length > 50) {
    return NextResponse.json({
      success: false,
      error: {
        code: 'BATCH_TOO_LARGE',
        message: 'Maximum 50 items per batch request'
      }
    }, { status: 400 });
  }

  // 验证每个 item
  for (const item of items) {
    if (!item.url || !item.hqcc) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Each item must have url and hqcc'
        }
      }, { status: 400 });
    }
  }

  try {
    // 并发 deposit (同 withdrawBatch 策略，避免后端 batch bug)
    const settled = await Promise.allSettled(
      items.map(item =>
        deposit(
          {
            url: item.url,
            hqcc: item.hqcc,
            raw: item.raw,
            visibility: item.visibility || 'private',
            meta: {
              ...item.meta,
              source: item.meta?.source || 'save_api',
              saved_at: new Date().toISOString()
            }
          },
          authHeader,
          userId
        )
      )
    );

    const results = items.map((item, i) => {
      const result = settled[i];
      if (result.status === 'fulfilled' && result.value.ok) {
        return {
          url: item.url,
          status: result.value.data?.status || 'created',
          content_uri: result.value.data?.content_uri
        };
      }
      return {
        url: item.url,
        status: 'failed',
        error: result.status === 'fulfilled' ? result.value.error : String(result.reason)
      };
    });

    const created = results.filter(r => r.status === 'created').length;
    const updated = results.filter(r => r.status === 'updated').length;
    const failed = results.filter(r => r.status === 'failed').length;

    // 记录使用量
    recordUsageBackground(
      createSaveUsageRecord({
        taskId,
        url: items.map(i => i.url).join(', ').substring(0, 200),
        itemCount: items.length,
        processingTimeMs: Date.now() - startTime
      }),
      authHeader
    );

    return NextResponse.json({
      success: true,
      results,
      summary: {
        total: items.length,
        created,
        updated,
        failed
      }
    });

  } catch (error) {
    console.error('[handleBatchSave] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'PROCESS_ERROR', message: 'Failed to save content batch' }
    }, { status: 500 });
  }
}




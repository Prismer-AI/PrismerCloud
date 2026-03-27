import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { createUsageRecord, type UsageRecordInput } from '@/lib/db-usage';
import { deductCredits, getUserCredits } from '@/lib/db-credits';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/usage/record
 * 
 * 功能：记录 API 使用量并扣除积分
 * 
 * Feature Flag: FF_USAGE_RECORD_LOCAL
 * - true: 直连数据库 (写入 pc_usage_records)
 * - false: 代理到后端 /api/v1/cloud/usage/record
 * 
 * Request body:
 * - task_id: unique task identifier
 * - task_type: 'load' | 'save' | 'parse' | etc.
 * - input: { type: 'query' | 'url', value: string }
 * - metrics: { exa_searches, urls_processed, tokens_input, tokens_output, ... }
 * - cost: { search_credits, compression_credits, total_credits }
 * - sources: [{ url, cached, tokens }]
 */
export async function POST(request: NextRequest) {
  try {
    // 确保 Nacos 配置已加载
    await ensureNacosConfig();
    
    const authHeader = request.headers.get('authorization');
    
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    const body = await request.json();
    
    // Validate required fields
    if (!body.task_id) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'task_id is required' }
      }, { status: 400 });
    }

    // =========================================================================
    // Feature Flag: 使用本地实现还是代理到后端
    // =========================================================================
    const useLocal = FEATURE_FLAGS.USAGE_RECORD_LOCAL;
    console.log(`[Usage Record] FF_USAGE_RECORD_LOCAL=${process.env.FF_USAGE_RECORD_LOCAL}, useLocal=${useLocal}`);
    
    if (useLocal) {
      return handleUsageRecordLocal(authHeader, body);
    } else {
      return handleUsageRecordProxy(authHeader, body);
    }
  } catch (error) {
    console.error('[Usage Record] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to record usage' }
    }, { status: 500 });
  }
}

/**
 * 本地实现：直连数据库
 */
async function handleUsageRecordLocal(
  authHeader: string,
  body: UsageRecordInput
): Promise<NextResponse> {
  console.log('[Usage Record] Using LOCAL implementation');
  
  // 解析用户 ID
  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' }
    }, { status: 401 });
  }
  
  const userId = authResult.user.id;
  const totalCredits = body.cost?.total_credits || 0;
  
  console.log(`[Usage Record] User: ${userId}, Task: ${body.task_id}, Credits: ${totalCredits}`);
  
  // 1. 创建使用记录
  const { id: recordId } = await createUsageRecord(userId, body);
  
  // 2. 扣除积分（如果有费用）
  let creditsRemaining = 0;
  if (totalCredits > 0) {
    const description = `${body.task_type}: ${body.input?.value?.substring(0, 50) || 'unknown'}`;
    const deductResult = await deductCredits(userId, totalCredits, description, recordId);
    
    if (!deductResult.success) {
      console.warn('[Usage Record] Credits deduction failed:', deductResult.error);
      // 即使扣费失败，也记录使用量（可以后续补扣）
    }
    creditsRemaining = deductResult.balance_after;
  } else {
    // 没有费用，获取当前余额
    const credits = await getUserCredits(userId);
    creditsRemaining = credits.balance;
  }
  
  console.log(`[Usage Record] Success: record=${recordId}, remaining=${creditsRemaining}`);
  
  return NextResponse.json({
    success: true,
    data: {
      record_id: recordId,
      credits_deducted: totalCredits,
      credits_remaining: creditsRemaining
    }
  }, { status: 201 });
}

/**
 * 代理实现：转发到后端
 */
async function handleUsageRecordProxy(
  authHeader: string,
  body: UsageRecordInput
): Promise<NextResponse> {
  const backendBase = await getBackendApiBase();
  const backendUrl = `${backendBase}/cloud/usage/record`;
  
  console.log(`[Usage Record] Proxying to ${backendUrl}`);
  console.log(`[Usage Record] task_id: ${body.task_id}, task_type: ${body.task_type}`);
  
  const backendRes = await fetch(backendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify(body)
  });

  const data = await backendRes.json();
  
  if (!backendRes.ok) {
    console.error('[Usage Record] Backend error:', data);
    return NextResponse.json(data, { status: backendRes.status });
  }

  console.log('[Usage Record] Success:', data);
  return NextResponse.json(data, { status: 201 });
}

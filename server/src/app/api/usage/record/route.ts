import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { createUsageRecord, type UsageRecordInput } from '@/lib/db-usage';
import { deductCredits, getUserCredits } from '@/lib/db-credits';
import { withTransaction } from '@/lib/db';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { metrics } from '@/lib/metrics';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('UsageRecord');

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
  const reqStart = Date.now();
  try {
    // 确保 Nacos 配置已加载
    await ensureNacosConfig();

    const authHeader = request.headers.get('authorization');

    if (!authHeader) {
      metrics.recordRequest('/api/usage/record', Date.now() - reqStart, 401);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    const body = await request.json();

    // Validate required fields
    if (!body.task_id) {
      metrics.recordRequest('/api/usage/record', Date.now() - reqStart, 400);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'task_id is required' },
        },
        { status: 400 },
      );
    }

    // =========================================================================
    // Feature Flag: 使用本地实现还是代理到后端
    // =========================================================================
    const useLocal = FEATURE_FLAGS.USAGE_RECORD_LOCAL;
    log.debug({ FF_USAGE_RECORD_LOCAL: process.env.FF_USAGE_RECORD_LOCAL, useLocal }, 'Feature flag check');

    let result: NextResponse;
    if (useLocal) {
      result = await handleUsageRecordLocal(authHeader, body);
    } else {
      result = await handleUsageRecordProxy(authHeader, body);
    }
    metrics.recordRequest('/api/usage/record', Date.now() - reqStart, result.status);
    return result;
  } catch (error) {
    log.error({ err: error }, 'Usage record error');
    metrics.recordRequest('/api/usage/record', Date.now() - reqStart, 500);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to record usage' },
      },
      { status: 500 },
    );
  }
}

/**
 * 本地实现：直连数据库
 */
async function handleUsageRecordLocal(authHeader: string, body: UsageRecordInput): Promise<NextResponse> {
  log.debug('Using LOCAL implementation');

  // 解析用户 ID
  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' },
      },
      { status: 401 },
    );
  }

  const userId = authResult.user.id;
  const totalCredits = body.cost?.total_credits || 0;

  log.debug({ userId, taskId: body.task_id, credits: totalCredits }, 'Recording usage');

  // Atomic: create usage record + deduct credits in single transaction
  let recordId = '';
  let creditsRemaining = 0;

  if (totalCredits > 0) {
    const txResult = await withTransaction(async (conn) => {
      const { id } = await createUsageRecord(userId, body, conn);
      const description = `${body.task_type}: ${body.input?.value?.substring(0, 50) || 'unknown'}`;
      const deductResult = await deductCredits(userId, totalCredits, description, id, conn);
      return { id, deductResult };
    });
    recordId = txResult.id;
    creditsRemaining = txResult.deductResult.balance_after;

    if (!txResult.deductResult.success) {
      log.warn({ error: txResult.deductResult.error }, 'Credits deduction failed within transaction');
    }
  } else {
    // No cost — just record usage, no transaction needed
    const { id } = await createUsageRecord(userId, body);
    recordId = id;
    const credits = await getUserCredits(userId);
    creditsRemaining = credits.balance;
  }

  log.info({ recordId, creditsRemaining }, 'Usage record success');

  return NextResponse.json(
    {
      success: true,
      data: {
        record_id: recordId,
        credits_deducted: totalCredits,
        credits_remaining: creditsRemaining,
      },
    },
    { status: 201 },
  );
}

/**
 * 代理实现：转发到后端
 */
async function handleUsageRecordProxy(authHeader: string, body: UsageRecordInput): Promise<NextResponse> {
  const backendBase = await getBackendApiBase();
  const backendUrl = `${backendBase}/cloud/usage/record`;

  log.debug({ backendUrl, taskId: body.task_id, taskType: body.task_type }, 'Proxying to backend');

  const backendRes = await fetch(backendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  });

  const data = await backendRes.json();

  if (!backendRes.ok) {
    log.error({ data }, 'Backend error');
    return NextResponse.json(data, { status: backendRes.status });
  }

  log.info({ data }, 'Proxy success');
  return NextResponse.json(data, { status: 201 });
}

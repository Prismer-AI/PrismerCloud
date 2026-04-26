import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { getDashboardStats } from '@/lib/db-usage';
import { getUserCredits } from '@/lib/db-credits';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { metrics } from '@/lib/metrics';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('DashboardStats');

/**
 * GET /api/dashboard/stats
 *
 * 功能：获取 Dashboard 统计数据
 *
 * Feature Flag: FF_DASHBOARD_STATS_LOCAL
 * - true: 直连数据库 (聚合 pc_usage_records)
 * - false: 代理到后端 /api/v1/cloud/dashboard/stats
 *
 * Query params:
 * - period: 时间范围 '7d' | '30d' | '90d' (默认 7d)
 */
export async function GET(request: NextRequest) {
  const reqStart = Date.now();
  try {
    // 确保 Nacos 配置已加载
    await ensureNacosConfig();

    const authHeader = request.headers.get('authorization');

    if (!authHeader) {
      metrics.recordRequest('/api/dashboard/stats', Date.now() - reqStart, 401);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '7d';

    // =========================================================================
    // Feature Flag: 使用本地实现还是代理到后端
    // =========================================================================
    const useLocal = FEATURE_FLAGS.DASHBOARD_STATS_LOCAL;
    log.debug({ FF_DASHBOARD_STATS_LOCAL: process.env.FF_DASHBOARD_STATS_LOCAL, useLocal }, 'Feature flag check');

    let result: NextResponse;
    if (useLocal) {
      result = await handleDashboardStatsLocal(authHeader, period);
    } else {
      result = await handleDashboardStatsProxy(authHeader, period);
    }
    metrics.recordRequest('/api/dashboard/stats', Date.now() - reqStart, result.status);
    return result;
  } catch (error) {
    log.error({ err: error }, 'Dashboard stats error');
    metrics.recordRequest('/api/dashboard/stats', Date.now() - reqStart, 500);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch dashboard stats' },
      },
      { status: 500 },
    );
  }
}

/**
 * 本地实现：直连数据库
 */
async function handleDashboardStatsLocal(authHeader: string, period: string): Promise<NextResponse> {
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

  // 获取用户积分余额
  const credits = await getUserCredits(userId);

  // 获取统计数据
  const stats = await getDashboardStats(userId, period, credits.balance);

  log.info({ userId, period, requests: stats.monthlyRequests }, 'Dashboard stats');

  return NextResponse.json({
    success: true,
    data: {
      chartData: stats.chartData,
      monthlyRequests: stats.monthlyRequests,
      cacheHitRate: stats.cacheHitRate,
      creditsRemaining: stats.creditsRemaining,
      totalCreditsUsed: stats.totalCreditsUsed,
      savings: stats.savings,
      plan: credits.plan,
    },
  });
}

/**
 * 代理实现：转发到后端
 */
async function handleDashboardStatsProxy(authHeader: string, period: string): Promise<NextResponse> {
  const backendBase = await getBackendApiBase();
  const backendUrl = `${backendBase}/cloud/dashboard/stats?period=${period}`;

  log.debug({ backendUrl }, 'Proxying to backend');

  const backendRes = await fetch(backendUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
  });

  const data = await backendRes.json();

  if (!backendRes.ok) {
    log.error({ data }, 'Backend error');
    return NextResponse.json(data, { status: backendRes.status });
  }

  return NextResponse.json(data);
}

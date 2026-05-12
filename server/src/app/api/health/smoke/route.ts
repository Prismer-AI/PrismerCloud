import { NextResponse } from 'next/server';
import { xmovbngcw, Xmovbngcw } from '@/lib/x-movbngcw';
import { VERSION } from '@/lib/version';

/**
 * GET /api/health/smoke
 *
 * X-movbngcw Smoke Test 端点
 * M3/M4 MVP 健康检查 - 公开端点，无需认证
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode') || 'full';

  try {
    let result;

    if (mode === 'quick') {
      // 快速健康检查
      result = await xmovbngcw.quickHealthCheck();
      return NextResponse.json(
        {
          status: result.success ? 'healthy' : 'unhealthy',
          message: result.message,
          timestamp: result.timestamp,
          durationMs: result.durationMs,
        },
        { status: result.success ? 200 : 503 },
      );
    } else {
      // 完整 smoke test
      result = await xmovbngcw.runSmokeTest();
      const statusCode = result.overall === 'healthy' ? 200 : result.overall === 'degraded' ? 200 : 503;

      return NextResponse.json(
        {
          ...result,
          service: 'prismer-cloud',
          serviceVersion: VERSION,
        },
        { status: statusCode },
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/health/smoke
 *
 * 高级 smoke test，支持自定义配置
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { timeoutMs = 30000, retries = 3, detailed = true } = body;

    const checker = new Xmovbngcw({
      timeoutMs,
      retries,
      enableDetailedLogging: detailed,
    });

    const result = await checker.runSmokeTest();

    return NextResponse.json({
      ...result,
      service: 'prismer-cloud',
      serviceVersion: VERSION,
      config: { timeoutMs, retries, detailed },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

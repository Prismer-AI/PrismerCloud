import { NextResponse } from 'next/server';
import { xmovbngcw, Xmovbngcw } from '@/lib/x-movbngcw';

/**
 * GET /api/health/movbngcw
 *
 * X-movbngcw 健康检查端点 - M3/M4 MVP Smoke Test
 * 公开端点，无需认证
 */
export async function GET() {
  try {
    const result = await xmovbngcw.quickHealthCheck();

    return NextResponse.json(
      {
        success: result.success,
        message: result.message,
        module: result.module,
        timestamp: result.timestamp,
        durationMs: result.durationMs,
        details: result.details,
      },
      { status: result.success ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: `Health check failed: ${error}`,
        module: 'movbngcw',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/health/movbngcw
 *
 * 运行完整的 smoke test 套件
 * 可选请求体: { timeoutMs?: number, retries?: number, enableDetailedLogging?: boolean }
 */
export async function POST(request: Request) {
  try {
    let config = {};
    try {
      const body = await request.json();
      config = {
        timeoutMs: body.timeoutMs,
        retries: body.retries,
        enableDetailedLogging: body.enableDetailedLogging,
      };
    } catch {
      // 忽略请求体解析错误，使用默认配置
    }

    const checker = new Xmovbngcw(config);
    const result = await checker.runSmokeTest();

    const statusCode = result.overall === 'healthy' ? 200 : result.overall === 'degraded' ? 503 : 500;

    return NextResponse.json(result, { status: statusCode });
  } catch (error) {
    return NextResponse.json(
      {
        overall: 'unhealthy',
        checks: [],
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        version: 'error',
        error: String(error),
      },
      { status: 500 },
    );
  }
}

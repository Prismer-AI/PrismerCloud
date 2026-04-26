import { NextResponse } from 'next/server';
import { VERSION } from '@/lib/version';

/**
 * GET /api/health
 *
 * 健康检查端点 — K8s liveness/readiness probe + 负载均衡器
 * 公开端点，无需认证
 */
export async function GET() {
  const checks: Record<string, { status: string; latency?: number }> = {};

  // DB ping (MySQL via db.ts — only available after Nacos config loaded)
  if (process.env.REMOTE_MYSQL_HOST) {
    try {
      const { query } = await import('@/lib/db');
      const dbStart = Date.now();
      await query('SELECT 1');
      checks.database = { status: 'up', latency: Date.now() - dbStart };
    } catch {
      checks.database = { status: 'down' };
    }
  } else {
    checks.database = { status: 'not_configured' };
  }

  // IM server (in-process via globalThis.__imApp)
  const imApp = (globalThis as Record<string, unknown>).__imApp;
  checks.im = { status: imApp ? 'up' : 'not_started' };

  const allUp = Object.values(checks).every((c) => c.status === 'up');

  return NextResponse.json(
    {
      status: allUp ? 'healthy' : 'degraded',
      version: VERSION,
      uptime: Math.round(process.uptime()),
      checks,
      timestamp: new Date().toISOString(),
    },
    { status: allUp ? 200 : 503 },
  );
}

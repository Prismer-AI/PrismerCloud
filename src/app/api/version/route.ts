import { NextResponse } from 'next/server';
import { VERSION_INFO, getVersionString } from '@/lib/version';

/**
 * GET /api/version
 *
 * 返回 API 版本信息
 * 公开端点，无需认证
 */
export async function GET() {
  return NextResponse.json({
    success: true,
    ...VERSION_INFO,
    description: getVersionString(),
    documentation: 'https://prismer.cloud/docs',
    timestamp: new Date().toISOString()
  });
}

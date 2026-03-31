import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { getUserActivities } from '@/lib/db-usage';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * GET /api/activities
 * 
 * 功能：获取用户活动列表（最近的 API 调用记录）
 * 
 * Feature Flag: FF_ACTIVITIES_LOCAL
 * - true: 直连数据库 (读取 pc_usage_records)
 * - false: 代理到后端 /api/v1/cloud/activities
 * 
 * Query params:
 * - page: 页码 (默认 1)
 * - limit: 每页数量 (默认 20)
 */
export async function GET(request: NextRequest) {
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

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');

    // =========================================================================
    // Feature Flag: 使用本地实现还是代理到后端
    // =========================================================================
    const useLocal = FEATURE_FLAGS.ACTIVITIES_LOCAL;
    console.log(`[Activities] FF_ACTIVITIES_LOCAL=${process.env.FF_ACTIVITIES_LOCAL}, useLocal=${useLocal}`);
    
    if (useLocal) {
      return await handleActivitiesLocal(authHeader, page, limit);
    } else {
      return await handleActivitiesProxy(authHeader, page, limit);
    }
  } catch (error) {
    console.error('[Activities] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch activities' }
    }, { status: 500 });
  }
}

/**
 * 本地实现：直连数据库
 */
async function handleActivitiesLocal(
  authHeader: string,
  page: number,
  limit: number
): Promise<NextResponse> {
  console.log('[Activities] Using LOCAL implementation');
  
  // 解析用户 ID
  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' }
    }, { status: 401 });
  }
  
  const userId = authResult.user.id;
  
  // 获取活动列表
  const { activities, total } = await getUserActivities(userId, page, limit);
  
  console.log(`[Activities] User: ${userId}, Found: ${activities.length}/${total}`);
  
  return NextResponse.json({
    success: true,
    data: activities,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
}

/**
 * 代理实现：转发到后端
 */
async function handleActivitiesProxy(
  authHeader: string,
  page: number,
  limit: number
): Promise<NextResponse> {
  const backendBase = await getBackendApiBase();
  const backendUrl = `${backendBase}/cloud/activities?page=${page}&limit=${limit}`;
  
  console.log(`[Activities] Proxying to ${backendUrl}`);
  
  const backendRes = await fetch(backendUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    }
  });

  const data = await backendRes.json();
  
  if (!backendRes.ok) {
    console.error('[Activities] Backend error:', data);
    return NextResponse.json(data, { status: backendRes.status });
  }

  return NextResponse.json(data);
}


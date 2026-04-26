import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { apiGuard } from '@/lib/api-guard';
import { createApiKey, getUserApiKeys } from '@/lib/db-api-keys';
import { metrics } from '@/lib/metrics';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('ApiKeys');

/**
 * GET /api/keys
 * Fetch all API keys for the current user
 *
 * FF_API_KEYS_LOCAL=true  → 读取 pc_api_keys 表
 * FF_API_KEYS_LOCAL=false → 代理到 backend GET /api/v1/cloud/keys
 */
export async function GET(request: NextRequest) {
  const reqStart = Date.now();
  try {
    if (FEATURE_FLAGS.API_KEYS_LOCAL) {
      // --- Local DB path ---
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;

      const userId = Number(guard.auth.userId);
      if (isNaN(userId)) {
        metrics.recordRequest('/api/keys', Date.now() - reqStart, 403);
        return NextResponse.json(
          {
            success: false,
            error: { code: 'INVALID_USER', message: 'API Key users cannot manage keys via API Key auth' },
          },
          { status: 403 },
        );
      }

      const keys = await getUserApiKeys(userId);
      metrics.recordRequest('/api/keys', Date.now() - reqStart, 200);
      return NextResponse.json({ success: true, data: keys });
    }

    // --- Backend proxy path ---
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      metrics.recordRequest('/api/keys', Date.now() - reqStart, 401);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    const backendBase = await getBackendApiBase();
    log.debug(`GET ${backendBase}/cloud/keys`);

    const backendRes = await fetch(`${backendBase}/cloud/keys`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    const data = await backendRes.json();
    if (!backendRes.ok) {
      log.error({ data }, 'Backend error');
      metrics.recordRequest('/api/keys', Date.now() - reqStart, backendRes.status);
      return NextResponse.json(data, { status: backendRes.status });
    }

    metrics.recordRequest('/api/keys', Date.now() - reqStart, 200);
    return NextResponse.json(data);
  } catch (error) {
    log.error({ err: error }, 'GET keys error');
    metrics.recordRequest('/api/keys', Date.now() - reqStart, 500);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch API keys' },
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/keys
 * Create a new API key
 *
 * FF_API_KEYS_LOCAL=true  → 写入 pc_api_keys 表
 * FF_API_KEYS_LOCAL=false → 代理到 backend POST /api/v1/cloud/keys
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  try {
    if (FEATURE_FLAGS.API_KEYS_LOCAL) {
      // --- Local DB path ---
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;

      const userId = Number(guard.auth.userId);
      if (isNaN(userId)) {
        metrics.recordRequest('/api/keys', Date.now() - reqStart, 403);
        return NextResponse.json(
          {
            success: false,
            error: { code: 'INVALID_USER', message: 'API Key users cannot manage keys via API Key auth' },
          },
          { status: 403 },
        );
      }

      const body = await request.json().catch(() => ({}));
      const label = body.label || 'New Key';
      const newKey = await createApiKey(userId, label);
      metrics.recordRequest('/api/keys', Date.now() - reqStart, 201);
      return NextResponse.json({ success: true, data: newKey }, { status: 201 });
    }

    // --- Backend proxy path ---
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      metrics.recordRequest('/api/keys', Date.now() - reqStart, 401);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    const body = await request.json();
    const backendBase = await getBackendApiBase();
    log.debug({ url: `${backendBase}/cloud/keys`, label: body?.label }, 'POST keys');

    const backendRes = await fetch(`${backendBase}/cloud/keys`, {
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
      metrics.recordRequest('/api/keys', Date.now() - reqStart, backendRes.status);
      return NextResponse.json(data, { status: backendRes.status });
    }

    metrics.recordRequest('/api/keys', Date.now() - reqStart, 201);
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    log.error({ err: error }, 'POST keys error');
    metrics.recordRequest('/api/keys', Date.now() - reqStart, 500);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create API key' },
      },
      { status: 500 },
    );
  }
}

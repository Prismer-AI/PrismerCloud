import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { apiGuard } from '@/lib/api-guard';
import { createApiKey, getUserApiKeys } from '@/lib/db-api-keys';

/**
 * GET /api/keys
 * Fetch all API keys for the current user
 *
 * FF_API_KEYS_LOCAL=true  → 读取 pc_api_keys 表
 * FF_API_KEYS_LOCAL=false → 代理到 backend GET /api/v1/cloud/keys
 */
export async function GET(request: NextRequest) {
  try {
    if (FEATURE_FLAGS.API_KEYS_LOCAL) {
      // --- Local DB path ---
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;

      const userId = Number(guard.auth.userId);
      if (isNaN(userId)) {
        return NextResponse.json({
          success: false,
          error: { code: 'INVALID_USER', message: 'API Key users cannot manage keys via API Key auth' }
        }, { status: 403 });
      }

      const keys = await getUserApiKeys(userId);
      return NextResponse.json({ success: true, data: keys });
    }

    // --- Backend proxy path ---
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    const backendBase = await getBackendApiBase();
    console.log(`[API Keys] GET ${backendBase}/cloud/keys`);

    const backendRes = await fetch(`${backendBase}/cloud/keys`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      }
    });

    const data = await backendRes.json();
    if (!backendRes.ok) {
      console.error('[API Keys] Backend error:', data);
      return NextResponse.json(data, { status: backendRes.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[API Keys] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch API keys' }
    }, { status: 500 });
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
  try {
    if (FEATURE_FLAGS.API_KEYS_LOCAL) {
      // --- Local DB path ---
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;

      const userId = Number(guard.auth.userId);
      if (isNaN(userId)) {
        return NextResponse.json({
          success: false,
          error: { code: 'INVALID_USER', message: 'API Key users cannot manage keys via API Key auth' }
        }, { status: 403 });
      }

      const body = await request.json().catch(() => ({}));
      const label = body.label || 'New Key';
      const newKey = await createApiKey(userId, label);
      return NextResponse.json({ success: true, data: newKey }, { status: 201 });
    }

    // --- Backend proxy path ---
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    const body = await request.json();
    const backendBase = await getBackendApiBase();
    console.log(`[API Keys] POST ${backendBase}/cloud/keys`, body);

    const backendRes = await fetch(`${backendBase}/cloud/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(body)
    });

    const data = await backendRes.json();
    if (!backendRes.ok) {
      console.error('[API Keys] Backend error:', data);
      return NextResponse.json(data, { status: backendRes.status });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('[API Keys] Error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create API key' }
    }, { status: 500 });
  }
}

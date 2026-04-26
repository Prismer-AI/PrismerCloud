import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { apiGuard, flushKeyCache } from '@/lib/api-guard';
import { revokeApiKey, deleteApiKey } from '@/lib/db-api-keys';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('ApiKeys');

/**
 * PATCH /api/keys/:id
 * Revoke an API key
 *
 * FF_API_KEYS_LOCAL=true  → UPDATE pc_api_keys SET status='REVOKED'
 * FF_API_KEYS_LOCAL=false → 代理到 backend PATCH /api/v1/cloud/keys/:id/revoke
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    if (FEATURE_FLAGS.API_KEYS_LOCAL) {
      // --- Local DB path ---
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;

      const userId = Number(guard.auth.userId);
      if (isNaN(userId)) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'INVALID_USER', message: 'API Key users cannot manage keys via API Key auth' },
          },
          { status: 403 },
        );
      }

      const ok = await revokeApiKey(userId, id);
      if (!ok) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'NOT_FOUND', message: 'API key not found' },
          },
          { status: 404 },
        );
      }

      flushKeyCache(); // Ensure revoked key is not served from cache
      return NextResponse.json({ success: true });
    }

    // --- Backend proxy path ---
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const { action } = body;

    const backendBase = await getBackendApiBase();
    const endpoint = action === 'revoke' ? `${backendBase}/cloud/keys/${id}/revoke` : `${backendBase}/cloud/keys/${id}`;

    log.debug({ endpoint }, 'PATCH key');

    const backendRes = await fetch(endpoint, {
      method: 'PATCH',
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

    return NextResponse.json(data);
  } catch (error) {
    log.error({ err: error }, 'PATCH key error');
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update API key' },
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/keys/:id
 * Delete an API key permanently
 *
 * FF_API_KEYS_LOCAL=true  → DELETE FROM pc_api_keys
 * FF_API_KEYS_LOCAL=false → 代理到 backend DELETE /api/v1/cloud/keys/:id
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    if (FEATURE_FLAGS.API_KEYS_LOCAL) {
      // --- Local DB path ---
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;

      const userId = Number(guard.auth.userId);
      if (isNaN(userId)) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'INVALID_USER', message: 'API Key users cannot manage keys via API Key auth' },
          },
          { status: 403 },
        );
      }

      const ok = await deleteApiKey(userId, id);
      if (!ok) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'NOT_FOUND', message: 'API key not found' },
          },
          { status: 404 },
        );
      }

      flushKeyCache(); // Ensure deleted key is not served from cache
      return NextResponse.json({ success: true });
    }

    // --- Backend proxy path ---
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    const backendBase = await getBackendApiBase();
    log.debug({ url: `${backendBase}/cloud/keys/${id}` }, 'DELETE key');

    const backendRes = await fetch(`${backendBase}/cloud/keys/${id}`, {
      method: 'DELETE',
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
  } catch (error) {
    log.error({ err: error }, 'DELETE key error');
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete API key' },
      },
      { status: 500 },
    );
  }
}

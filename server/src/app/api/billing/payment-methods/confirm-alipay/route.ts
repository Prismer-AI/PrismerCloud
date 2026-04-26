import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Billing');

/**
 * POST /api/billing/payment-methods/confirm-alipay
 * Confirm Alipay authorization after redirect from Alipay
 * Proxies to: POST /api/v1/cloud/billing/payment-methods/confirm-alipay
 *
 * Request body:
 * - setup_intent_id: string
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { setup_intent_id } = body;

    if (!setup_intent_id) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'MISSING_SETUP_INTENT', message: 'setup_intent_id is required' },
        },
        { status: 400 },
      );
    }

    const backendBase = await getBackendApiBase();
    const res = await fetch(`${backendBase}/cloud/billing/payment-methods/confirm-alipay`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ setup_intent_id }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    // Transform to frontend format
    return NextResponse.json({
      success: true,
      data: {
        id: data.data.id,
        type: 'alipay',
        email: data.data.email,
        default: data.data.default || false,
      },
      message: 'Alipay payment method added successfully',
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to confirm Alipay');
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm Alipay authorization' },
      },
      { status: 500 },
    );
  }
}

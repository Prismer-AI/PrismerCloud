import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';

/**
 * POST /api/billing/payment-methods/confirm-alipay
 * Confirm Alipay authorization after redirect from Alipay
 *
 * FF_BILLING_LOCAL=true  → not supported (Alipay requires backend)
 * FF_BILLING_LOCAL=false → proxy to backend
 */
export async function POST(request: NextRequest) {
  try {
    if (FEATURE_FLAGS.BILLING_LOCAL) {
      return NextResponse.json({
        success: false,
        error: { code: 'NOT_AVAILABLE', message: 'Alipay confirmation is not available in self-host mode. Use Stripe payment methods instead.' }
      }, { status: 503 });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    const body = await request.json();
    const { setup_intent_id } = body;

    if (!setup_intent_id) {
      return NextResponse.json({
        success: false,
        error: { code: 'MISSING_SETUP_INTENT', message: 'setup_intent_id is required' }
      }, { status: 400 });
    }

    const backendBase = await getBackendApiBase();
    const res = await fetch(`${backendBase}/cloud/billing/payment-methods/confirm-alipay`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ setup_intent_id }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json({
      success: true,
      data: {
        id: data.data.id,
        type: 'alipay',
        email: data.data.email,
        default: data.data.default || false,
      },
      message: 'Alipay payment method added successfully'
    });
  } catch (error) {
    console.error('[API] Failed to confirm Alipay:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm Alipay authorization' }
    }, { status: 500 });
  }
}

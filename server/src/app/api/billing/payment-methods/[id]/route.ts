import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getPaymentMethodById, setDefaultPaymentMethod, deletePaymentMethod } from '@/lib/db-billing';
import { detachPaymentMethod, setDefaultPaymentMethod as setStripeDefault } from '@/lib/stripe';
import { getUserStripeCustomerId } from '@/lib/db-billing';
import { stripeBreaker } from '@/lib/circuit-breaker';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Billing');

/**
 * PATCH /api/billing/payment-methods/:id
 * Update a payment method (e.g., set as default)
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureNacosConfig();

    const { id } = await params;
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
    const { default: setDefault } = body;

    const useLocal = FEATURE_FLAGS.BILLING_LOCAL;
    log.debug({ id, useLocal }, 'PATCH payment-method');

    if (useLocal) {
      return handlePatchLocal(authHeader, id, setDefault);
    } else {
      return handlePatchProxy(authHeader, id, setDefault);
    }
  } catch (error) {
    log.error({ err: error }, 'PATCH payment-method error');
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update payment method' },
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/billing/payment-methods/:id
 * Remove a payment method
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureNacosConfig();

    const { id } = await params;
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

    const useLocal = FEATURE_FLAGS.BILLING_LOCAL;
    log.debug({ id, useLocal }, 'DELETE payment-method');

    if (useLocal) {
      return handleDeleteLocal(authHeader, id);
    } else {
      return handleDeleteProxy(authHeader, id);
    }
  } catch (error) {
    log.error({ err: error }, 'DELETE payment-method error');
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to remove payment method' },
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// Local Implementation
// ============================================================================

async function handlePatchLocal(authHeader: string, id: string, setDefault: boolean): Promise<NextResponse> {
  log.debug('Using LOCAL implementation for PATCH');

  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' },
      },
      { status: 401 },
    );
  }

  const userId = authResult.user.id;

  // 获取支付方式
  const pm = await getPaymentMethodById(id);
  if (!pm || pm.user_id !== userId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment method not found' },
      },
      { status: 404 },
    );
  }

  if (setDefault) {
    // 更新数据库
    await setDefaultPaymentMethod(userId, id);

    // 更新 Stripe (如果有 customer)
    const stripeCustomerId = await getUserStripeCustomerId(userId);
    if (stripeCustomerId) {
      try {
        await stripeBreaker.execute(() => setStripeDefault(stripeCustomerId, pm.stripe_payment_method_id));
      } catch (e) {
        log.warn({ err: e }, 'Failed to set Stripe default');
        // 不影响主流程
      }
    }

    log.info({ id, userId }, 'Set payment method as default');
  }

  return NextResponse.json({
    success: true,
    message: setDefault ? `Payment method ${id} set as default` : `Payment method ${id} updated`,
  });
}

async function handleDeleteLocal(authHeader: string, id: string): Promise<NextResponse> {
  log.debug('Using LOCAL implementation for DELETE');

  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' },
      },
      { status: 401 },
    );
  }

  const userId = authResult.user.id;

  // 获取支付方式
  const pm = await getPaymentMethodById(id);
  if (!pm || pm.user_id !== userId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment method not found' },
      },
      { status: 404 },
    );
  }

  // 检查是否是默认支付方式
  if (pm.is_default) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'CANNOT_DELETE_DEFAULT', message: 'Cannot delete default payment method' },
      },
      { status: 400 },
    );
  }

  // 从 Stripe 分离
  try {
    await stripeBreaker.execute(() => detachPaymentMethod(pm.stripe_payment_method_id));
  } catch (e) {
    log.warn({ err: e }, 'Failed to detach from Stripe');
    // 继续删除本地记录
  }

  // 从数据库删除（软删除）
  await deletePaymentMethod(id, userId);

  log.info({ id, userId }, 'Deleted payment method');

  return NextResponse.json({
    success: true,
    message: `Payment method ${id} removed successfully`,
  });
}

// ============================================================================
// Proxy Implementation
// ============================================================================

async function handlePatchProxy(authHeader: string, id: string, setDefault: boolean): Promise<NextResponse> {
  log.debug('Using PROXY implementation for PATCH');

  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/cloud/billing/payment-methods/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ default: setDefault }),
  });

  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json({
    success: true,
    message: setDefault ? `Payment method ${id} set as default` : `Payment method ${id} updated`,
  });
}

async function handleDeleteProxy(authHeader: string, id: string): Promise<NextResponse> {
  log.debug('Using PROXY implementation for DELETE');

  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/cloud/billing/payment-methods/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json({
    success: true,
    message: `Payment method ${id} removed successfully`,
  });
}

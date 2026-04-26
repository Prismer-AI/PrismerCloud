import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { metrics } from '@/lib/metrics';
import {
  createPayment,
  updatePaymentStatus,
  getPaymentMethodById,
  getUserStripeCustomerId,
  saveUserStripeCustomerId,
} from '@/lib/db-billing';
import { addCredits } from '@/lib/db-credits';
import { getOrCreateCustomer, createAndPayInvoice } from '@/lib/stripe';
import { stripeBreaker } from '@/lib/circuit-breaker';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import crypto from 'crypto';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Billing');

/**
 * POST /api/billing/topup
 *
 * 创建充值请求（使用 Stripe Invoice 生成正式发票）
 *
 * Request body:
 * - amount: number (美分，如 4990 = $49.90)
 * - credits: number (购买的 credits 数量)
 * - paymentMethodId: string (支付方式 ID，pc_payment_methods.id)
 */
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  try {
    await ensureNacosConfig();

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      metrics.recordRequest('/api/billing/topup', Date.now() - reqStart, 401);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
        },
        { status: 401 },
      );
    }

    // Rate limit by auth identity hash (no apiGuard userId available here)
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const rlKey = crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
    const rl = checkRateLimit(rlKey, 'billing/topup');
    if (!rl.allowed) return rateLimitResponse(rl);

    const body = await request.json();
    const { amount, credits, paymentMethodId } = body;

    // 验证参数（允许任意金额，支持增量购买）
    if (!amount || typeof amount !== 'number' || amount < 1) {
      metrics.recordRequest('/api/billing/topup', Date.now() - reqStart, 400);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_AMOUNT', message: 'amount must be at least 1 cent' },
        },
        { status: 400 },
      );
    }

    if (!credits || typeof credits !== 'number' || credits <= 0) {
      metrics.recordRequest('/api/billing/topup', Date.now() - reqStart, 400);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_CREDITS', message: 'credits must be a positive number' },
        },
        { status: 400 },
      );
    }

    if (!paymentMethodId) {
      metrics.recordRequest('/api/billing/topup', Date.now() - reqStart, 400);
      return NextResponse.json(
        {
          success: false,
          error: { code: 'MISSING_PAYMENT_METHOD', message: 'paymentMethodId is required' },
        },
        { status: 400 },
      );
    }

    const useLocal = FEATURE_FLAGS.BILLING_LOCAL;
    log.info({ amount, credits, useLocal }, 'POST topup');

    let result: NextResponse;
    if (useLocal) {
      result = await handleTopupLocal(authHeader, amount, credits, paymentMethodId);
    } else {
      result = await handleTopupProxy(authHeader, body);
    }
    metrics.recordRequest('/api/billing/topup', Date.now() - reqStart, result.status);
    return result;
  } catch (error: any) {
    log.error({ err: error }, 'POST topup error');
    metrics.recordRequest('/api/billing/topup', Date.now() - reqStart, 500);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message || 'Failed to create topup' },
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// Local Implementation (使用 Stripe Invoice)
// ============================================================================

async function handleTopupLocal(
  authHeader: string,
  amountCents: number,
  credits: number,
  paymentMethodId: string,
): Promise<NextResponse> {
  log.debug('Using LOCAL implementation for topup (with Invoice)');

  // 验证用户
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
  const userEmail = authResult.user.email;

  // 获取支付方式
  const pm = await getPaymentMethodById(paymentMethodId);
  if (!pm || pm.user_id !== userId) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INVALID_PAYMENT_METHOD', message: 'Payment method not found' },
      },
      { status: 404 },
    );
  }

  // 获取或创建 Stripe Customer
  let stripeCustomerId = await getUserStripeCustomerId(userId);
  if (!stripeCustomerId) {
    log.info({ userId }, 'Creating Stripe customer');
    const customer = await stripeBreaker.execute(() => getOrCreateCustomer(userId, userEmail));
    stripeCustomerId = customer.id;
    await saveUserStripeCustomerId(userId, stripeCustomerId);
  }

  // 创建本地支付记录
  const payment = await createPayment({
    userId,
    paymentMethodId,
    paymentMethodType: pm.type,
    amountCents,
    creditsPurchased: credits,
    type: 'topup',
    description: `Purchase ${credits.toLocaleString()} Credits`,
  });

  log.info({ paymentId: payment.id, amountCents, credits }, 'Created payment record');

  try {
    // 创建并支付 Stripe Invoice（会生成正式发票 PDF，关联到 Product）
    log.info({ stripeCustomerId, amountCents, credits }, 'Creating Stripe Invoice');

    const invoice = await stripeBreaker.execute(() =>
      createAndPayInvoice(stripeCustomerId, amountCents, credits, pm.stripe_payment_method_id, {
        prismer_payment_id: payment.id,
        prismer_user_id: String(userId),
        credits: String(credits),
      }),
    );

    log.info(
      { invoiceId: invoice.id, status: invoice.status, amountPaid: invoice.amount_paid, total: invoice.total },
      'Created Invoice',
    );

    if (invoice.status === 'paid') {
      // 支付成功
      await updatePaymentStatus(payment.id, 'succeeded');
      await addCredits(
        userId,
        credits,
        'purchase',
        `Purchase ${credits.toLocaleString()} credits`,
        'payment',
        payment.id,
      );

      log.info({ credits }, 'Topup succeeded');

      return NextResponse.json({
        success: true,
        data: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          invoicePdf: invoice.invoice_pdf,
          invoiceUrl: invoice.hosted_invoice_url,
          status: 'succeeded',
          credits,
        },
      });
    } else {
      // 其他状态
      await updatePaymentStatus(payment.id, 'pending');

      return NextResponse.json({
        success: true,
        data: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          status: invoice.status,
        },
      });
    }
  } catch (error: any) {
    log.error({ err: error }, 'Stripe Invoice error');
    // 截断错误信息
    const failureReason = (error.message || 'Payment failed').substring(0, 500);
    await updatePaymentStatus(payment.id, 'failed', failureReason);

    return NextResponse.json(
      {
        success: false,
        error: { code: 'STRIPE_ERROR', message: error.message || 'Payment failed' },
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// Proxy Implementation
// ============================================================================

async function handleTopupProxy(authHeader: string, body: any): Promise<NextResponse> {
  log.debug('Using PROXY implementation for topup');

  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/payment/topup/create`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: body.amount,
      credits: body.credits,
      payment_method_id: body.paymentMethodId,
    }),
  });

  const data = await res.json();

  if (!res.ok || !data.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: data.error?.code || 'TOPUP_FAILED', message: data.error?.msg || data.message || 'Topup failed' },
      },
      { status: res.status >= 400 ? res.status : 500 },
    );
  }

  return NextResponse.json({
    success: true,
    data: data.data,
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import {
  createPayment,
  updatePaymentStatus,
  getPaymentMethodById,
  getUserStripeCustomerId,
  saveUserStripeCustomerId,
} from '@/lib/db-billing';
import { addCredits } from '@/lib/db-credits';
import {
  getOrCreateCustomer,
  createAndPayInvoice,
} from '@/lib/stripe';

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
  try {
    await ensureNacosConfig();
    
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    const body = await request.json();
    const { amount, credits, paymentMethodId } = body;

    // 验证参数（允许任意金额，支持增量购买）
    if (!amount || typeof amount !== 'number' || amount < 1) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_AMOUNT', message: 'amount must be at least 1 cent' }
      }, { status: 400 });
    }

    if (!credits || typeof credits !== 'number' || credits <= 0) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_CREDITS', message: 'credits must be a positive number' }
      }, { status: 400 });
    }

    if (!paymentMethodId) {
      return NextResponse.json({
        success: false,
        error: { code: 'MISSING_PAYMENT_METHOD', message: 'paymentMethodId is required' }
      }, { status: 400 });
    }

    const useLocal = FEATURE_FLAGS.BILLING_LOCAL;
    console.log(`[Billing] POST topup, amount=${amount}, credits=${credits}, useLocal=${useLocal}`);

    if (useLocal) {
      return handleTopupLocal(authHeader, amount, credits, paymentMethodId);
    } else {
      return handleTopupProxy(authHeader, body);
    }
  } catch (error: any) {
    console.error('[Billing] POST topup error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Failed to create topup' }
    }, { status: 500 });
  }
}

// ============================================================================
// Local Implementation (使用 Stripe Invoice)
// ============================================================================

async function handleTopupLocal(
  authHeader: string,
  amountCents: number,
  credits: number,
  paymentMethodId: string
): Promise<NextResponse> {
  console.log('[Billing] Using LOCAL implementation for topup (with Invoice)');
  
  // 验证用户
  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' }
    }, { status: 401 });
  }
  
  const userId = authResult.user.id;
  const userEmail = authResult.user.email;
  
  // 获取支付方式
  const pm = await getPaymentMethodById(paymentMethodId);
  if (!pm || pm.user_id !== userId) {
    return NextResponse.json({
      success: false,
      error: { code: 'INVALID_PAYMENT_METHOD', message: 'Payment method not found' }
    }, { status: 404 });
  }
  
  // 获取或创建 Stripe Customer
  let stripeCustomerId = await getUserStripeCustomerId(userId);
  if (!stripeCustomerId) {
    console.log(`[Billing] Creating Stripe customer for user ${userId}`);
    const customer = await getOrCreateCustomer(userId, userEmail);
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
  
  console.log(`[Billing] Created payment record ${payment.id}, amountCents=${amountCents}, credits=${credits}`);
  
  try {
    // 创建并支付 Stripe Invoice（会生成正式发票 PDF，关联到 Product）
    console.log(`[Billing] Creating Stripe Invoice: customer=${stripeCustomerId}, amount=${amountCents} cents, credits=${credits}`);
    
    const invoice = await createAndPayInvoice(
      stripeCustomerId,
      amountCents,
      credits,
      pm.stripe_payment_method_id,
      {
        prismer_payment_id: payment.id,
        prismer_user_id: String(userId),
        credits: String(credits),
      }
    );
    
    console.log(`[Billing] Created Invoice ${invoice.id}, status: ${invoice.status}, amount_paid: ${invoice.amount_paid}, total: ${invoice.total}`);
    
    if (invoice.status === 'paid') {
      // 支付成功
      await updatePaymentStatus(payment.id, 'succeeded');
      await addCredits(userId, credits, 'purchase', `Purchase ${credits.toLocaleString()} credits`, 'payment', payment.id);
      
      console.log(`[Billing] Topup succeeded, added ${credits} credits`);
      
      return NextResponse.json({
        success: true,
        data: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          invoicePdf: invoice.invoice_pdf,
          invoiceUrl: invoice.hosted_invoice_url,
          status: 'succeeded',
          credits,
        }
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
        }
      });
    }
    
  } catch (error: any) {
    console.error('[Billing] Stripe Invoice error:', error);
    // 截断错误信息
    const failureReason = (error.message || 'Payment failed').substring(0, 500);
    await updatePaymentStatus(payment.id, 'failed', failureReason);
    
    return NextResponse.json({
      success: false,
      error: { code: 'STRIPE_ERROR', message: error.message || 'Payment failed' }
    }, { status: 500 });
  }
}

// ============================================================================
// Proxy Implementation
// ============================================================================

async function handleTopupProxy(
  authHeader: string,
  body: any
): Promise<NextResponse> {
  console.log('[Billing] Using PROXY implementation for topup');
  
  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/payment/topup/create`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
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
    return NextResponse.json({
      success: false,
      error: { code: data.error?.code || 'TOPUP_FAILED', message: data.error?.msg || data.message || 'Topup failed' }
    }, { status: res.status >= 400 ? res.status : 500 });
  }

  return NextResponse.json({
    success: true,
    data: data.data
  });
}

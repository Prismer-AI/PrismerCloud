import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getUserStripeCustomerId, getUserPayments } from '@/lib/db-billing';
import { listInvoices, formatInvoice } from '@/lib/stripe';
import { stripeBreaker } from '@/lib/circuit-breaker';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Billing');

/**
 * GET /api/billing/invoices
 * 从 Stripe 获取用户的所有正式发票
 */
export async function GET(request: NextRequest) {
  try {
    await ensureNacosConfig();

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
    log.debug({ useLocal }, 'GET invoices');

    if (useLocal) {
      return handleGetInvoicesLocal(authHeader);
    } else {
      return handleGetInvoicesProxy(authHeader);
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch invoices');
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch invoices' },
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// Local Implementation - 从 Stripe 拉取发票
// ============================================================================

async function handleGetInvoicesLocal(authHeader: string): Promise<NextResponse> {
  log.debug('Using LOCAL implementation for invoices (Stripe + Local)');

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

  // 并行获取 Stripe Invoice 和本地交易记录
  const stripeCustomerId = await getUserStripeCustomerId(userId);

  const [stripeInvoices, localPayments] = await Promise.all([
    // 获取 Stripe Invoice（如果有 customer ID）
    stripeCustomerId ? stripeBreaker.execute(() => listInvoices(stripeCustomerId, 50)) : Promise.resolve([]),
    // 获取本地交易记录
    getUserPayments(userId, 1, 50),
  ]);

  // 格式化 Stripe Invoice（过滤掉金额为 0 的无效记录）
  const stripeFormatted = stripeInvoices.map(formatInvoice).filter((inv) => inv.amountCents > 0);

  // 用 Stripe Invoice ID 建立索引，用于去重
  const stripeInvoiceIds = new Set(stripeFormatted.map((inv) => inv.stripeId));

  // 格式化本地交易记录（排除已有 Stripe Invoice 的，且金额 > 0）
  const localFormatted = localPayments.payments
    .filter((p) => p.status === 'succeeded')
    .filter((p) => p.amount_cents > 0)
    .filter((p) => !p.stripe_payment_intent_id || !stripeInvoiceIds.has(p.stripe_payment_intent_id))
    .map((p) => ({
      id: p.id,
      stripeId: p.stripe_payment_intent_id || p.id,
      date: new Date(p.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      amount: `$${(p.amount_cents / 100).toFixed(2)}`,
      amountCents: p.amount_cents,
      status: 'Paid',
      pdfUrl: null, // 旧记录没有 PDF
      hostedUrl: null,
      description: p.description || 'Credit Purchase',
      credits: p.credits_purchased,
    }));

  // 合并并按时间排序（新的在前）
  const allInvoices = [...stripeFormatted, ...localFormatted].sort((a, b) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  log.info({ stripeCount: stripeFormatted.length, localCount: localFormatted.length, userId }, 'Found invoices');

  return NextResponse.json({
    success: true,
    data: allInvoices,
  });
}

// ============================================================================
// Proxy Implementation
// ============================================================================

async function handleGetInvoicesProxy(authHeader: string): Promise<NextResponse> {
  log.debug('Using PROXY implementation for invoices');

  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/cloud/billing/invoices`, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    const errorMsg = data.error?.msg || data.message || 'Failed to fetch invoices';
    const errorCode = data.error?.code || res.status;
    return NextResponse.json(
      {
        success: false,
        error: { code: errorCode, message: errorMsg },
      },
      { status: res.status >= 400 ? res.status : 500 },
    );
  }

  const rawData = Array.isArray(data.data) ? data.data : data.invoices || [];
  const invoices = rawData.map((inv: any) => ({
    id: inv.id,
    date:
      inv.date ||
      new Date(inv.created_at || inv.created).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    amount: typeof inv.amount === 'number' ? `$${(inv.amount / 100).toFixed(2)}` : inv.amount,
    status: (inv.status || 'Paid').charAt(0).toUpperCase() + (inv.status || 'paid').slice(1),
    pdfUrl: inv.pdf_url || inv.invoice_pdf,
  }));

  return NextResponse.json({
    success: true,
    data: invoices,
  });
}

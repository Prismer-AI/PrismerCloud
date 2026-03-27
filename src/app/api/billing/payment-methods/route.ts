import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import {
  getUserPaymentMethods,
  createPaymentMethod,
  getUserStripeCustomerId,
  saveUserStripeCustomerId,
} from '@/lib/db-billing';
import {
  getOrCreateCustomer,
  attachPaymentMethod,
  getPaymentMethod,
  formatPaymentMethod,
  createAlipaySetupIntent,
} from '@/lib/stripe';

/**
 * GET /api/billing/payment-methods
 * Fetch all payment methods for the current user
 */
export async function GET(request: NextRequest) {
  try {
    await ensureNacosConfig();
    
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' }
      }, { status: 401 });
    }

    const useLocal = FEATURE_FLAGS.BILLING_LOCAL;
    console.log(`[Billing] GET payment-methods, FF_BILLING_LOCAL=${process.env.FF_BILLING_LOCAL}, useLocal=${useLocal}`);

    if (useLocal) {
      return handleGetPaymentMethodsLocal(authHeader);
    } else {
      return handleGetPaymentMethodsProxy(authHeader);
    }
  } catch (error) {
    console.error('[Billing] GET payment-methods error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch payment methods' }
    }, { status: 500 });
  }
}

/**
 * POST /api/billing/payment-methods
 * Add a new payment method
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
    const { type, token, return_url } = body;

    if (!type || !['card', 'alipay'].includes(type)) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_TYPE', message: 'type must be "card" or "alipay"' }
      }, { status: 400 });
    }

    if (type === 'card' && !token) {
      return NextResponse.json({
        success: false,
        error: { code: 'MISSING_TOKEN', message: 'token (Stripe PaymentMethod ID) required for card' }
      }, { status: 400 });
    }

    if (type === 'alipay' && !return_url) {
      return NextResponse.json({
        success: false,
        error: { code: 'MISSING_RETURN_URL', message: 'return_url required for alipay' }
      }, { status: 400 });
    }

    const useLocal = FEATURE_FLAGS.BILLING_LOCAL;
    console.log(`[Billing] POST payment-methods, type=${type}, useLocal=${useLocal}`);

    if (useLocal) {
      return handleAddPaymentMethodLocal(authHeader, type, token, return_url);
    } else {
      return handleAddPaymentMethodProxy(authHeader, body);
    }
  } catch (error: any) {
    console.error('[Billing] POST payment-methods error:', error);
    return NextResponse.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Failed to add payment method' }
    }, { status: 500 });
  }
}

// ============================================================================
// Local Implementation
// ============================================================================

async function handleGetPaymentMethodsLocal(authHeader: string): Promise<NextResponse> {
  console.log('[Billing] Using LOCAL implementation for GET');
  
  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' }
    }, { status: 401 });
  }
  
  const userId = authResult.user.id;
  const paymentMethods = await getUserPaymentMethods(userId);
  
  // 转换为前端格式
  const data = paymentMethods.map(pm => ({
    id: pm.id,
    stripeId: pm.stripe_payment_method_id,
    type: pm.type,
    brand: pm.card_brand,
    last4: pm.card_last4,
    exp: pm.card_exp_month && pm.card_exp_year
      ? `${String(pm.card_exp_month).padStart(2, '0')}/${pm.card_exp_year}`
      : undefined,
    email: pm.wallet_email,
    default: pm.is_default,
  }));
  
  console.log(`[Billing] Found ${data.length} payment methods for user ${userId}`);
  
  return NextResponse.json({
    success: true,
    data
  });
}

async function handleAddPaymentMethodLocal(
  authHeader: string,
  type: 'card' | 'alipay',
  token?: string,
  returnUrl?: string
): Promise<NextResponse> {
  console.log('[Billing] Using LOCAL implementation for POST');
  
  const authResult = await getUserFromAuth(authHeader);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: authResult.error || 'Invalid token' }
    }, { status: 401 });
  }
  
  const userId = authResult.user.id;
  const userEmail = authResult.user.email;
  
  // 获取或创建 Stripe Customer
  let stripeCustomerId = await getUserStripeCustomerId(userId);
  if (!stripeCustomerId) {
    console.log(`[Billing] Creating Stripe customer for user ${userId}`);
    const customer = await getOrCreateCustomer(userId, userEmail);
    stripeCustomerId = customer.id;
    await saveUserStripeCustomerId(userId, stripeCustomerId);
  }
  
  if (type === 'alipay') {
    // Alipay 需要创建 SetupIntent 并返回重定向 URL
    console.log(`[Billing] Creating Alipay SetupIntent for user ${userId}`);
    const setupIntent = await createAlipaySetupIntent(stripeCustomerId, returnUrl!);
    
    return NextResponse.json({
      success: true,
      data: {
        setup_intent_id: setupIntent.id,
        redirect_url: setupIntent.next_action?.redirect_to_url?.url,
        client_secret: setupIntent.client_secret,
      }
    }, { status: 201 });
  }
  
  // Card: 将 PaymentMethod 附加到 Customer
  console.log(`[Billing] Attaching card ${token} to customer ${stripeCustomerId}`);
  const stripePm = await attachPaymentMethod(token!, stripeCustomerId);
  const pmInfo = formatPaymentMethod(stripePm);
  
  // 检查是否是第一个支付方式（设为默认）
  const existingMethods = await getUserPaymentMethods(userId);
  const isDefault = existingMethods.length === 0;
  
  // 保存到数据库
  const savedPm = await createPaymentMethod({
    userId,
    stripePaymentMethodId: stripePm.id,
    stripeCustomerId,
    type: 'card',
    cardBrand: pmInfo.card?.brand,
    cardLast4: pmInfo.card?.last4,
    cardExpMonth: pmInfo.card?.expMonth,
    cardExpYear: pmInfo.card?.expYear,
    cardFunding: pmInfo.card?.funding,
    isDefault,
  });
  
  console.log(`[Billing] Saved payment method ${savedPm.id} for user ${userId}`);
  
  return NextResponse.json({
    success: true,
    data: {
      id: savedPm.id,
      stripeId: savedPm.stripe_payment_method_id,
      type: savedPm.type,
      brand: savedPm.card_brand,
      last4: savedPm.card_last4,
      exp: savedPm.card_exp_month && savedPm.card_exp_year
        ? `${String(savedPm.card_exp_month).padStart(2, '0')}/${savedPm.card_exp_year}`
        : undefined,
      default: savedPm.is_default,
    }
  }, { status: 201 });
}

// ============================================================================
// Proxy Implementation (to backend)
// ============================================================================

async function handleGetPaymentMethodsProxy(authHeader: string): Promise<NextResponse> {
  console.log('[Billing] Using PROXY implementation for GET');
  
  const backendBase = await getBackendApiBase();
  console.log('[Billing] GET payment-methods from:', `${backendBase}/cloud/billing/payment-methods`);
  
  const res = await fetch(`${backendBase}/cloud/billing/payment-methods`, {
    method: 'GET',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json();
  console.log('[Billing] GET payment-methods response:', res.status);
  
  if (!res.ok || data.error) {
    const errorMsg = data.error?.msg || data.message || 'Failed to fetch payment methods';
    const errorCode = data.error?.code || res.status;
    return NextResponse.json({
      success: false,
      error: { code: errorCode, message: errorMsg }
    }, { status: res.status >= 400 ? res.status : 500 });
  }

  const rawData = Array.isArray(data.data) ? data.data : (data.payment_methods || []);
  const paymentMethods = rawData.map((pm: any) => ({
    id: pm.id || pm.stripe_payment_method_id,
    type: pm.type || pm.payment_method_type,
    brand: pm.brand || pm.card_brand,
    last4: pm.last4 || pm.card_last4,
    exp: pm.exp_month && pm.exp_year 
      ? `${String(pm.exp_month).padStart(2, '0')}/${pm.exp_year}` 
      : pm.exp,
    email: pm.email,
    default: pm.default || pm.is_default || false,
  }));

  return NextResponse.json({
    success: true,
    data: paymentMethods
  });
}

async function handleAddPaymentMethodProxy(
  authHeader: string,
  body: any
): Promise<NextResponse> {
  console.log('[Billing] Using PROXY implementation for POST');
  
  const backendBase = await getBackendApiBase();
  console.log('[Billing] POST payment-methods to:', `${backendBase}/cloud/billing/payment-methods`);
  
  const res = await fetch(`${backendBase}/cloud/billing/payment-methods`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log('[Billing] POST payment-methods response:', res.status);
  
  if (!res.ok || data.error) {
    const errorMsg = data.error?.msg || data.message || 'Failed to add payment method';
    return NextResponse.json({
      success: false,
      error: { code: data.error?.code || res.status, message: errorMsg }
    }, { status: res.status >= 400 ? res.status : 500 });
  }

  if (body.type === 'alipay') {
    return NextResponse.json({
      success: true,
      data: {
        setup_intent_id: data.data?.setup_intent_id,
        redirect_url: data.data?.redirect_url,
        client_secret: data.data?.client_secret,
      }
    }, { status: 201 });
  }

  const pm = data.data || data;
  return NextResponse.json({
    success: true,
    data: {
      id: pm.id || pm.stripe_payment_method_id,
      type: pm.type || 'card',
      brand: pm.brand || pm.card_brand,
      last4: pm.last4 || pm.card_last4,
      exp: pm.exp_month && pm.exp_year 
        ? `${String(pm.exp_month).padStart(2, '0')}/${pm.exp_year}` 
        : pm.exp,
      default: pm.default || pm.is_default || false,
    }
  }, { status: 201 });
}

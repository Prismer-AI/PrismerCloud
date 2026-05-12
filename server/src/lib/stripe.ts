/**
 * Stripe Client
 * 
 * 封装 Stripe SDK 的初始化和常用操作
 * 配置从 Nacos 加载
 */

import Stripe from 'stripe';
import { ensureNacosConfig } from './nacos-config';

// ============================================================================
// Stripe Client Singleton
// ============================================================================

let stripeInstance: Stripe | null = null;

/**
 * 获取 Stripe 客户端实例 (单例)
 */
export async function getStripe(): Promise<Stripe> {
  if (stripeInstance) {
    return stripeInstance;
  }
  
  await ensureNacosConfig();
  
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  
  stripeInstance = new Stripe(secretKey, {
    apiVersion: '2025-12-15.clover',
    typescript: true,
  });
  
  return stripeInstance;
}

/**
 * 获取 Stripe Publishable Key (前端使用)
 */
export async function getStripePublishableKey(): Promise<string> {
  await ensureNacosConfig();
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    throw new Error('STRIPE_PUBLISHABLE_KEY not configured');
  }
  return key;
}

// ============================================================================
// Customer Operations
// ============================================================================

/**
 * 获取或创建 Stripe Customer
 */
export async function getOrCreateCustomer(
  userId: number,
  email: string,
  name?: string
): Promise<Stripe.Customer> {
  const stripe = await getStripe();
  
  // 查找已存在的 Customer (通过 metadata)
  const existing = await stripe.customers.list({
    limit: 1,
    email: email,
  });
  
  if (existing.data.length > 0) {
    const customer = existing.data[0];
    // 确保 metadata 中有 user_id
    if (customer.metadata?.prismer_user_id !== String(userId)) {
      await stripe.customers.update(customer.id, {
        metadata: { prismer_user_id: String(userId) }
      });
    }
    return customer;
  }
  
  // 创建新 Customer
  return stripe.customers.create({
    email,
    name,
    metadata: {
      prismer_user_id: String(userId),
    },
  });
}

/**
 * 获取 Customer by ID
 */
export async function getCustomer(customerId: string): Promise<Stripe.Customer | null> {
  const stripe = await getStripe();
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    return customer as Stripe.Customer;
  } catch {
    return null;
  }
}

// ============================================================================
// Payment Method Operations
// ============================================================================

/**
 * 将 PaymentMethod 附加到 Customer
 */
export async function attachPaymentMethod(
  paymentMethodId: string,
  customerId: string
): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripe();
  return stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  });
}

/**
 * 从 Customer 分离 PaymentMethod
 */
export async function detachPaymentMethod(
  paymentMethodId: string
): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripe();
  return stripe.paymentMethods.detach(paymentMethodId);
}

/**
 * 获取 PaymentMethod 详情
 */
export async function getPaymentMethod(
  paymentMethodId: string
): Promise<Stripe.PaymentMethod | null> {
  const stripe = await getStripe();
  try {
    return await stripe.paymentMethods.retrieve(paymentMethodId);
  } catch {
    return null;
  }
}

/**
 * 列出 Customer 的所有 PaymentMethods
 */
export async function listPaymentMethods(
  customerId: string,
  type?: Stripe.PaymentMethodListParams.Type
): Promise<Stripe.PaymentMethod[]> {
  const stripe = await getStripe();
  const result = await stripe.paymentMethods.list({
    customer: customerId,
    type: type || 'card',
  });
  return result.data;
}

/**
 * 设置默认 PaymentMethod
 */
export async function setDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string
): Promise<Stripe.Customer> {
  const stripe = await getStripe();
  return stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });
}

// ============================================================================
// SetupIntent Operations (用于添加支付方式)
// ============================================================================

/**
 * 创建 SetupIntent (用于添加卡)
 */
export async function createSetupIntent(
  customerId: string,
  paymentMethodTypes: string[] = ['card']
): Promise<Stripe.SetupIntent> {
  const stripe = await getStripe();
  return stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: paymentMethodTypes,
  });
}

/**
 * 创建 Alipay SetupIntent
 */
export async function createAlipaySetupIntent(
  customerId: string,
  returnUrl: string
): Promise<Stripe.SetupIntent> {
  const stripe = await getStripe();
  // 使用 any 类型绕过 Stripe 类型定义的限制
  // Alipay 在某些 API 版本中可能不在官方类型定义中
  const params: any = {
    customer: customerId,
    payment_method_types: ['alipay'],
    confirm: true,
    return_url: returnUrl,
  };
  return stripe.setupIntents.create(params);
}

/**
 * 获取 SetupIntent
 */
export async function getSetupIntent(
  setupIntentId: string
): Promise<Stripe.SetupIntent | null> {
  const stripe = await getStripe();
  try {
    return await stripe.setupIntents.retrieve(setupIntentId);
  } catch {
    return null;
  }
}

// ============================================================================
// PaymentIntent Operations (用于收款)
// ============================================================================

/**
 * 创建 PaymentIntent (充值)
 */
export async function createPaymentIntent(
  customerId: string,
  amountCents: number,
  currency: string = 'usd',
  paymentMethodId?: string,
  metadata?: Record<string, string>
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripe();
  
  const params: Stripe.PaymentIntentCreateParams = {
    customer: customerId,
    amount: amountCents,
    currency,
    metadata,
    // 禁用重定向类型的支付方式，只使用卡支付
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'never',
    },
  };
  
  if (paymentMethodId) {
    params.payment_method = paymentMethodId;
    params.confirm = true; // 自动确认
  }
  
  return stripe.paymentIntents.create(params);
}

/**
 * 确认 PaymentIntent
 */
export async function confirmPaymentIntent(
  paymentIntentId: string,
  paymentMethodId?: string
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripe();
  return stripe.paymentIntents.confirm(paymentIntentId, {
    payment_method: paymentMethodId,
  });
}

/**
 * 获取 PaymentIntent
 */
export async function getPaymentIntent(
  paymentIntentId: string
): Promise<Stripe.PaymentIntent | null> {
  const stripe = await getStripe();
  try {
    return await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch {
    return null;
  }
}

// ============================================================================
// Subscription Operations
// ============================================================================

/**
 * 创建订阅
 */
export async function createSubscription(
  customerId: string,
  priceId: string,
  paymentMethodId?: string
): Promise<Stripe.Subscription> {
  const stripe = await getStripe();
  
  const params: Stripe.SubscriptionCreateParams = {
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  };
  
  if (paymentMethodId) {
    params.default_payment_method = paymentMethodId;
  }
  
  return stripe.subscriptions.create(params);
}

/**
 * 取消订阅
 */
export async function cancelSubscription(
  subscriptionId: string,
  immediately: boolean = false
): Promise<Stripe.Subscription> {
  const stripe = await getStripe();
  
  if (immediately) {
    return stripe.subscriptions.cancel(subscriptionId);
  }
  
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

/**
 * 获取订阅
 */
export async function getSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription | null> {
  const stripe = await getStripe();
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch {
    return null;
  }
}

// ============================================================================
// Invoice Operations
// ============================================================================

/**
 * 创建并支付 Invoice（用于一次性购买）
 * 这会自动生成正式发票 PDF
 */
export async function createAndPayInvoice(
  customerId: string,
  amountCents: number,
  credits: number,
  paymentMethodId: string,
  metadata?: Record<string, string>
): Promise<Stripe.Invoice> {
  const stripe = await getStripe();
  
  // 1. 先创建 Draft Invoice
  const draftInvoice = await stripe.invoices.create({
    customer: customerId,
    auto_advance: false, // 手动控制
    collection_method: 'charge_automatically',
    default_payment_method: paymentMethodId,
    metadata,
    pending_invoice_items_behavior: 'exclude', // 不自动包含 pending items
  });
  
  console.log(`[Stripe] Created draft invoice: ${draftInvoice.id}`);
  
  // 2. 在 Invoice 上添加 Line Item（直接使用金额）
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: draftInvoice.id,
    amount: amountCents,
    currency: 'usd',
    description: `Prismer Cloud - ${credits.toLocaleString()} Credits`,
    metadata: {
      credits: String(credits),
      ...metadata,
    },
  });
  
  console.log(`[Stripe] Added invoice item: ${amountCents} cents for ${credits} credits`);
  
  // 3. Finalize Invoice (生成 PDF)
  const finalizedInvoice = await stripe.invoices.finalizeInvoice(draftInvoice.id);
  
  console.log(`[Stripe] Finalized invoice, total: ${finalizedInvoice.total}, status: ${finalizedInvoice.status}`);
  
  // 4. 如果已自动支付，直接返回
  if (finalizedInvoice.status === 'paid') {
    return finalizedInvoice;
  }
  
  // 5. 手动支付 Invoice
  const paidInvoice = await stripe.invoices.pay(finalizedInvoice.id, {
    payment_method: paymentMethodId,
  });
  
  return paidInvoice;
}

/**
 * 获取用户的所有 Invoices
 */
export async function listInvoices(
  customerId: string,
  limit: number = 50
): Promise<Stripe.Invoice[]> {
  const stripe = await getStripe();
  const result = await stripe.invoices.list({
    customer: customerId,
    limit,
  });
  return result.data;
}

/**
 * 获取单个 Invoice
 */
export async function getInvoice(
  invoiceId: string
): Promise<Stripe.Invoice | null> {
  const stripe = await getStripe();
  try {
    return await stripe.invoices.retrieve(invoiceId);
  } catch {
    return null;
  }
}

/**
 * 格式化 Invoice 为前端显示格式
 */
export interface InvoiceInfo {
  id: string;
  stripeId: string;
  date: string;
  amount: string;
  amountCents: number;
  status: string;
  pdfUrl: string | null;
  hostedUrl: string | null;
  description: string;
  credits?: number;
}

export function formatInvoice(invoice: Stripe.Invoice): InvoiceInfo {
  const date = invoice.created 
    ? new Date(invoice.created * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      })
    : '';
  
  return {
    id: invoice.id,
    stripeId: invoice.id,
    date,
    amount: `$${((invoice.amount_paid || invoice.total || 0) / 100).toFixed(2)}`,
    amountCents: invoice.amount_paid || invoice.total || 0,
    status: invoice.status === 'paid' ? 'Paid' : (invoice.status || 'Unknown'),
    pdfUrl: invoice.invoice_pdf || null,
    hostedUrl: invoice.hosted_invoice_url || null,
    description: invoice.lines?.data?.[0]?.description || 'Credit Purchase',
    credits: invoice.metadata?.credits ? parseInt(invoice.metadata.credits) : undefined,
  };
}

// ============================================================================
// Utility Types
// ============================================================================

export interface PaymentMethodInfo {
  id: string;
  stripeId: string;
  type: 'card' | 'alipay' | 'wechat';
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding: string;
  };
  alipay?: {
    email?: string;
  };
  isDefault: boolean;
}

/**
 * 将 Stripe PaymentMethod 转换为我们的格式
 */
export function formatPaymentMethod(
  pm: Stripe.PaymentMethod,
  isDefault: boolean = false
): PaymentMethodInfo {
  const result: PaymentMethodInfo = {
    id: pm.id,
    stripeId: pm.id,
    type: pm.type as 'card' | 'alipay' | 'wechat',
    isDefault,
  };
  
  if (pm.type === 'card' && pm.card) {
    result.card = {
      brand: pm.card.brand || 'unknown',
      last4: pm.card.last4 || '****',
      expMonth: pm.card.exp_month || 0,
      expYear: pm.card.exp_year || 0,
      funding: pm.card.funding || 'unknown',
    };
  }
  
  if (pm.type === 'alipay') {
    result.alipay = {};
  }
  
  return result;
}

/**
 * Database Operations for Billing
 * 
 * 操作表：pc_payment_methods, pc_payments, pc_subscriptions
 * 前端先行实现，与后端解耦
 */

import { query, execute, queryOne, generateUUID } from './db';
import type { RowDataPacket } from 'mysql2/promise';
import { emitPaymentNotification } from './notification-emitter';

// ============================================================================
// Types
// ============================================================================

export interface PaymentMethod {
  id: string;
  user_id: number;
  stripe_payment_method_id: string;
  stripe_customer_id: string | null;
  type: 'card' | 'alipay' | 'wechat';
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  card_funding: string | null;
  wallet_email: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Payment {
  id: string;
  user_id: number;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_invoice_id: string | null;
  payment_method_id: string | null;
  payment_method_type: 'card' | 'alipay' | 'wechat' | null;
  amount_cents: number;
  currency: string;
  credits_purchased: number;
  type: 'topup' | 'subscription' | 'one_time';
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'refunded';
  description: string | null;
  failure_reason: string | null;
  invoice_pdf_url: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface Subscription {
  id: string;
  user_id: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  plan: 'free' | 'pro' | 'enterprise';
  price_cents: number;
  credits_monthly: number;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'paused';
  current_period_start: Date | null;
  current_period_end: Date | null;
  canceled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Payment Methods
// ============================================================================

export interface CreatePaymentMethodInput {
  userId: number;
  stripePaymentMethodId: string;
  stripeCustomerId?: string;
  type: 'card' | 'alipay' | 'wechat';
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
  cardFunding?: string;
  walletEmail?: string;
  isDefault?: boolean;
}

/**
 * 创建支付方式记录
 */
export async function createPaymentMethod(input: CreatePaymentMethodInput): Promise<PaymentMethod> {
  const id = generateUUID();
  
  const sql = `
    INSERT INTO pc_payment_methods (
      id, user_id, stripe_payment_method_id, stripe_customer_id,
      type, card_brand, card_last4, card_exp_month, card_exp_year, card_funding,
      wallet_email, is_default, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)
  `;
  
  await execute(sql, [
    id,
    input.userId,
    input.stripePaymentMethodId,
    input.stripeCustomerId || null,
    input.type,
    input.cardBrand || null,
    input.cardLast4 || null,
    input.cardExpMonth || null,
    input.cardExpYear || null,
    input.cardFunding || null,
    input.walletEmail || null,
    input.isDefault || false,
  ]);
  
  // 如果设置为默认，取消其他默认
  if (input.isDefault) {
    await execute(
      `UPDATE pc_payment_methods SET is_default = FALSE WHERE user_id = ? AND id != ?`,
      [input.userId, id]
    );
  }
  
  const pm = await getPaymentMethodById(id);
  return pm!;
}

/**
 * 通过 ID 获取支付方式
 */
export async function getPaymentMethodById(id: string): Promise<PaymentMethod | null> {
  const sql = `SELECT * FROM pc_payment_methods WHERE id = ?`;
  const row = await queryOne<PaymentMethod & RowDataPacket>(sql, [id]);
  return row ? formatPaymentMethodRow(row) : null;
}

/**
 * 通过 Stripe PM ID 获取支付方式
 */
export async function getPaymentMethodByStripeId(stripeId: string): Promise<PaymentMethod | null> {
  const sql = `SELECT * FROM pc_payment_methods WHERE stripe_payment_method_id = ?`;
  const row = await queryOne<PaymentMethod & RowDataPacket>(sql, [stripeId]);
  return row ? formatPaymentMethodRow(row) : null;
}

/**
 * 获取用户的所有支付方式
 */
export async function getUserPaymentMethods(userId: number): Promise<PaymentMethod[]> {
  const sql = `
    SELECT * FROM pc_payment_methods 
    WHERE user_id = ? AND is_active = TRUE
    ORDER BY is_default DESC, created_at DESC
  `;
  const rows = await query<(PaymentMethod & RowDataPacket)[]>(sql, [userId]);
  return rows.map(formatPaymentMethodRow);
}

/**
 * 设置默认支付方式
 */
export async function setDefaultPaymentMethod(userId: number, id: string): Promise<void> {
  // 取消其他默认
  await execute(
    `UPDATE pc_payment_methods SET is_default = FALSE WHERE user_id = ?`,
    [userId]
  );
  // 设置新默认
  await execute(
    `UPDATE pc_payment_methods SET is_default = TRUE WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
}

/**
 * 删除支付方式 (软删除)
 */
export async function deletePaymentMethod(id: string, userId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE pc_payment_methods SET is_active = FALSE WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  return (result as any).affectedRows > 0;
}

/**
 * 更新 Stripe Customer ID
 */
export async function updatePaymentMethodCustomerId(
  id: string,
  stripeCustomerId: string
): Promise<void> {
  await execute(
    `UPDATE pc_payment_methods SET stripe_customer_id = ? WHERE id = ?`,
    [stripeCustomerId, id]
  );
}

function formatPaymentMethodRow(row: PaymentMethod & RowDataPacket): PaymentMethod {
  return {
    id: row.id,
    user_id: row.user_id,
    stripe_payment_method_id: row.stripe_payment_method_id,
    stripe_customer_id: row.stripe_customer_id,
    type: row.type,
    card_brand: row.card_brand,
    card_last4: row.card_last4,
    card_exp_month: row.card_exp_month,
    card_exp_year: row.card_exp_year,
    card_funding: row.card_funding,
    wallet_email: row.wallet_email,
    is_default: Boolean(row.is_default),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ============================================================================
// Payments
// ============================================================================

export interface CreatePaymentInput {
  userId: number;
  stripePaymentIntentId?: string;
  paymentMethodId?: string;
  paymentMethodType?: 'card' | 'alipay' | 'wechat';
  amountCents: number;
  currency?: string;
  creditsPurchased: number;
  type: 'topup' | 'subscription' | 'one_time';
  description?: string;
}

/**
 * 创建支付记录
 */
export async function createPayment(input: CreatePaymentInput): Promise<Payment> {
  const id = generateUUID();
  
  const sql = `
    INSERT INTO pc_payments (
      id, user_id, stripe_payment_intent_id, payment_method_id, payment_method_type,
      amount_cents, currency, credits_purchased, type, status, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `;
  
  await execute(sql, [
    id,
    input.userId,
    input.stripePaymentIntentId || null,
    input.paymentMethodId || null,
    input.paymentMethodType || null,
    input.amountCents,
    input.currency || 'USD',
    input.creditsPurchased,
    input.type,
    input.description || null,
  ]);
  
  const payment = await getPaymentById(id);
  return payment!;
}

/**
 * 通过 ID 获取支付记录
 */
export async function getPaymentById(id: string): Promise<Payment | null> {
  const sql = `SELECT * FROM pc_payments WHERE id = ?`;
  const row = await queryOne<Payment & RowDataPacket>(sql, [id]);
  return row ? formatPaymentRow(row) : null;
}

/**
 * 通过 Stripe PaymentIntent ID 获取
 */
export async function getPaymentByStripeId(stripeId: string): Promise<Payment | null> {
  const sql = `SELECT * FROM pc_payments WHERE stripe_payment_intent_id = ?`;
  const row = await queryOne<Payment & RowDataPacket>(sql, [stripeId]);
  return row ? formatPaymentRow(row) : null;
}

/**
 * 获取用户的支付记录
 */
export async function getUserPayments(
  userId: number,
  page: number = 1,
  limit: number = 20
): Promise<{ payments: Payment[]; total: number }> {
  const offset = (page - 1) * limit;
  
  const countSql = `SELECT COUNT(*) as total FROM pc_payments WHERE user_id = ?`;
  const countResult = await queryOne<{ total: number } & RowDataPacket>(countSql, [userId]);
  const total = countResult?.total || 0;
  
  const sql = `
    SELECT * FROM pc_payments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = await query<(Payment & RowDataPacket)[]>(sql, [userId, Number(limit), Number(offset)]);
  
  return {
    payments: rows.map(formatPaymentRow),
    total,
  };
}

/**
 * 更新支付状态
 */
export async function updatePaymentStatus(
  id: string,
  status: Payment['status'],
  failureReason?: string
): Promise<void> {
  const completedAt = ['succeeded', 'failed', 'canceled', 'refunded'].includes(status)
    ? new Date()
    : null;

  await execute(
    `UPDATE pc_payments SET status = ?, failure_reason = ?, completed_at = ? WHERE id = ?`,
    [status, failureReason || null, completedAt, id]
  );

  // Fire-and-forget: emit payment notification for terminal states
  if (status === 'succeeded' || status === 'failed') {
    getPaymentById(id).then(payment => {
      if (payment) {
        emitPaymentNotification(
          payment.user_id,
          status,
          payment.amount_cents,
          payment.credits_purchased,
          id
        );
      }
    }).catch(() => {});
  }
}

/**
 * 更新 Stripe PaymentIntent ID
 */
export async function updatePaymentStripeId(
  id: string,
  stripePaymentIntentId: string
): Promise<void> {
  await execute(
    `UPDATE pc_payments SET stripe_payment_intent_id = ? WHERE id = ?`,
    [stripePaymentIntentId, id]
  );
}

function formatPaymentRow(row: Payment & RowDataPacket): Payment {
  return {
    id: row.id,
    user_id: row.user_id,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    stripe_charge_id: row.stripe_charge_id,
    stripe_invoice_id: row.stripe_invoice_id,
    payment_method_id: row.payment_method_id,
    payment_method_type: row.payment_method_type,
    amount_cents: row.amount_cents,
    currency: row.currency,
    credits_purchased: parseFloat(row.credits_purchased as unknown as string),
    type: row.type,
    status: row.status,
    description: row.description,
    failure_reason: row.failure_reason,
    invoice_pdf_url: row.invoice_pdf_url,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

// ============================================================================
// Subscriptions
// ============================================================================

export interface CreateSubscriptionInput {
  userId: number;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  plan: 'free' | 'pro' | 'enterprise';
  priceCents?: number;
  creditsMonthly?: number;
}

/**
 * 创建或更新用户订阅
 */
export async function upsertSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
  // 检查是否已有订阅
  const existing = await getUserSubscription(input.userId);
  
  if (existing) {
    // 更新
    await execute(
      `UPDATE pc_subscriptions SET 
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        plan = ?,
        price_cents = ?,
        credits_monthly = ?,
        status = 'active'
      WHERE user_id = ?`,
      [
        input.stripeSubscriptionId || null,
        input.stripeCustomerId || null,
        input.plan,
        input.priceCents || 0,
        input.creditsMonthly || 100,
        input.userId,
      ]
    );
    return (await getUserSubscription(input.userId))!;
  }
  
  // 创建
  const id = generateUUID();
  await execute(
    `INSERT INTO pc_subscriptions (
      id, user_id, stripe_subscription_id, stripe_customer_id,
      plan, price_cents, credits_monthly, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      id,
      input.userId,
      input.stripeSubscriptionId || null,
      input.stripeCustomerId || null,
      input.plan,
      input.priceCents || 0,
      input.creditsMonthly || 100,
    ]
  );
  
  return (await getSubscriptionById(id))!;
}

/**
 * 获取用户订阅
 */
export async function getUserSubscription(userId: number): Promise<Subscription | null> {
  const sql = `SELECT * FROM pc_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`;
  const row = await queryOne<Subscription & RowDataPacket>(sql, [userId]);
  return row ? formatSubscriptionRow(row) : null;
}

/**
 * 通过 ID 获取订阅
 */
export async function getSubscriptionById(id: string): Promise<Subscription | null> {
  const sql = `SELECT * FROM pc_subscriptions WHERE id = ?`;
  const row = await queryOne<Subscription & RowDataPacket>(sql, [id]);
  return row ? formatSubscriptionRow(row) : null;
}

/**
 * 更新订阅状态
 */
export async function updateSubscriptionStatus(
  userId: number,
  status: Subscription['status'],
  canceledAt?: Date
): Promise<void> {
  await execute(
    `UPDATE pc_subscriptions SET status = ?, canceled_at = ? WHERE user_id = ?`,
    [status, canceledAt || null, userId]
  );
}

/**
 * 更新订阅周期
 */
export async function updateSubscriptionPeriod(
  userId: number,
  periodStart: Date,
  periodEnd: Date
): Promise<void> {
  await execute(
    `UPDATE pc_subscriptions SET current_period_start = ?, current_period_end = ? WHERE user_id = ?`,
    [periodStart, periodEnd, userId]
  );
}

function formatSubscriptionRow(row: Subscription & RowDataPacket): Subscription {
  return {
    id: row.id,
    user_id: row.user_id,
    stripe_subscription_id: row.stripe_subscription_id,
    stripe_customer_id: row.stripe_customer_id,
    plan: row.plan,
    price_cents: row.price_cents,
    credits_monthly: row.credits_monthly,
    status: row.status,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    canceled_at: row.canceled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ============================================================================
// Stripe Customer ID Management
// ============================================================================

/**
 * 获取用户的 Stripe Customer ID
 */
export async function getUserStripeCustomerId(userId: number): Promise<string | null> {
  // 先从 payment_methods 查
  const pmSql = `SELECT stripe_customer_id FROM pc_payment_methods WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1`;
  const pmRow = await queryOne<{ stripe_customer_id: string } & RowDataPacket>(pmSql, [userId]);
  if (pmRow?.stripe_customer_id) return pmRow.stripe_customer_id;
  
  // 再从 subscriptions 查
  const subSql = `SELECT stripe_customer_id FROM pc_subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1`;
  const subRow = await queryOne<{ stripe_customer_id: string } & RowDataPacket>(subSql, [userId]);
  if (subRow?.stripe_customer_id) return subRow.stripe_customer_id;
  
  return null;
}

/**
 * 保存用户的 Stripe Customer ID
 */
export async function saveUserStripeCustomerId(
  userId: number,
  stripeCustomerId: string
): Promise<void> {
  // 更新该用户所有的 payment_methods
  await execute(
    `UPDATE pc_payment_methods SET stripe_customer_id = ? WHERE user_id = ? AND stripe_customer_id IS NULL`,
    [stripeCustomerId, userId]
  );
  
  // 更新 subscription
  await execute(
    `UPDATE pc_subscriptions SET stripe_customer_id = ? WHERE user_id = ? AND stripe_customer_id IS NULL`,
    [stripeCustomerId, userId]
  );
}

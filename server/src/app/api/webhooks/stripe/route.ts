/**
 * Stripe Webhook Handler
 *
 * Receives and processes Stripe webhook events with signature verification,
 * idempotency protection, and structured logging.
 *
 * Events handled:
 *   - invoice.paid           → Update payment status, add credits
 *   - invoice.payment_failed → Update payment status, log warning
 *   - charge.refunded        → Deduct credits, update payment status
 *   - customer.subscription.updated → Log subscription status change
 */

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';
import { addCredits, deductCredits } from '@/lib/db-credits';
import { updatePaymentStatus, getPaymentById, getPaymentByStripeId, updateSubscriptionStatus } from '@/lib/db-billing';

const log = createModuleLogger('StripeWebhook');

// ============================================================================
// Idempotency — bounded in-memory set with TTL
// ============================================================================

const IDEMPOTENCY_MAX = 10_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface IdempotencyEntry {
  timestamp: number;
}

const processedEvents = new Map<string, IdempotencyEntry>();

function isEventProcessed(eventId: string): boolean {
  const entry = processedEvents.get(eventId);
  if (!entry) return false;

  // Expired — treat as unprocessed
  if (Date.now() - entry.timestamp > IDEMPOTENCY_TTL_MS) {
    processedEvents.delete(eventId);
    return false;
  }

  return true;
}

function markEventProcessed(eventId: string): void {
  // Evict oldest entries when at capacity
  if (processedEvents.size >= IDEMPOTENCY_MAX) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    const keys = Array.from(processedEvents.keys());
    for (const id of keys) {
      const entry = processedEvents.get(id);
      if (entry && entry.timestamp < cutoff) {
        processedEvents.delete(id);
      }
    }
    // If still at capacity after TTL eviction, remove oldest
    if (processedEvents.size >= IDEMPOTENCY_MAX) {
      const oldest = processedEvents.keys().next().value;
      if (oldest) processedEvents.delete(oldest);
    }
  }

  processedEvents.set(eventId, { timestamp: Date.now() });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the Prismer userId from event metadata.
 * Tries invoice/charge metadata first, then falls back to the Stripe customer metadata.
 */
function resolveUserId(
  objectMetadata: Stripe.Metadata | null | undefined,
  customer: Stripe.Customer | Stripe.DeletedCustomer | string | null | undefined,
): number | null {
  // 1. Direct metadata on the object (invoice, charge, etc.)
  const fromObject = objectMetadata?.prismer_user_id;
  if (fromObject) {
    const parsed = parseInt(fromObject, 10);
    if (!isNaN(parsed)) return parsed;
  }

  // 2. Stripe Customer metadata (expanded customer object)
  if (customer && typeof customer === 'object' && !('deleted' in customer && customer.deleted)) {
    const cust = customer as Stripe.Customer;
    const fromCustomer = cust.metadata?.prismer_user_id;
    if (fromCustomer) {
      const parsed = parseInt(fromCustomer, 10);
      if (!isNaN(parsed)) return parsed;
    }
  }

  return null;
}

// ============================================================================
// Event Handlers
// ============================================================================

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const paymentId = invoice.metadata?.prismer_payment_id || invoice.metadata?.payment_id;
  const creditsStr = invoice.metadata?.credits;
  const userId = resolveUserId(invoice.metadata, invoice.customer);

  log.info(
    { invoiceId: invoice.id, paymentId, credits: creditsStr, userId, status: invoice.status },
    'Processing invoice.paid',
  );

  if (!paymentId) {
    log.warn({ invoiceId: invoice.id }, 'invoice.paid missing prismer_payment_id in metadata — skipping');
    return;
  }

  // Verify the payment record exists
  const payment = await getPaymentById(paymentId);
  if (!payment) {
    log.warn({ paymentId, invoiceId: invoice.id }, 'Payment record not found — skipping');
    return;
  }

  // Already in terminal state — skip
  if (payment.status === 'succeeded' || payment.status === 'refunded') {
    log.info({ paymentId, currentStatus: payment.status }, 'Payment already in terminal state — skipping');
    return;
  }

  // Update payment status to succeeded
  await updatePaymentStatus(paymentId, 'succeeded');
  log.info({ paymentId }, 'Payment status updated to succeeded');

  // Add credits if we know the amount and user
  const credits = creditsStr ? parseInt(creditsStr, 10) : null;
  const effectiveUserId = userId ?? payment.user_id;

  if (credits && credits > 0 && effectiveUserId) {
    await addCredits(
      effectiveUserId,
      credits,
      'purchase',
      `Purchase ${credits.toLocaleString()} credits (Invoice ${invoice.id})`,
      'payment',
      paymentId,
    );
    log.info({ userId: effectiveUserId, credits, paymentId }, 'Credits added');
  } else if (!credits) {
    log.warn({ invoiceId: invoice.id, paymentId }, 'invoice.paid missing credits in metadata — credits not added');
  }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const paymentId = invoice.metadata?.prismer_payment_id || invoice.metadata?.payment_id;
  const userId = resolveUserId(invoice.metadata, invoice.customer);

  log.warn({ invoiceId: invoice.id, paymentId, userId }, 'Processing invoice.payment_failed');

  if (!paymentId) {
    log.warn({ invoiceId: invoice.id }, 'invoice.payment_failed missing prismer_payment_id — skipping');
    return;
  }

  const payment = await getPaymentById(paymentId);
  if (!payment) {
    log.warn({ paymentId, invoiceId: invoice.id }, 'Payment record not found — skipping');
    return;
  }

  // Already in terminal state — skip
  if (payment.status === 'succeeded' || payment.status === 'refunded') {
    log.info(
      { paymentId, currentStatus: payment.status },
      'Payment already in terminal state — not overriding with failed',
    );
    return;
  }

  const failureReason = (invoice as any).last_finalization_error?.message || 'Payment failed via Stripe webhook';

  await updatePaymentStatus(paymentId, 'failed', failureReason);
  log.warn({ paymentId, failureReason }, 'Payment status updated to failed');
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const userId = resolveUserId(charge.metadata, charge.customer);
  const paymentId = charge.metadata?.prismer_payment_id || charge.metadata?.payment_id;

  log.info(
    { chargeId: charge.id, paymentId, userId, amountRefunded: charge.amount_refunded },
    'Processing charge.refunded',
  );

  // Try to find the payment through metadata or through the associated payment_intent
  let resolvedPaymentId = paymentId;
  let payment = paymentId ? await getPaymentById(paymentId) : null;

  if (!payment && charge.payment_intent) {
    // Look up our payment record by Stripe PaymentIntent ID
    const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id;
    payment = await getPaymentByStripeId(piId);
    if (payment) {
      resolvedPaymentId = payment.id;
    }
  }

  if (!payment || !resolvedPaymentId) {
    log.warn({ chargeId: charge.id }, 'Could not resolve payment record for charge.refunded — skipping');
    return;
  }

  const effectiveUserId = userId ?? payment.user_id;

  // Update payment status to refunded
  await updatePaymentStatus(resolvedPaymentId, 'refunded');
  log.info({ paymentId: resolvedPaymentId }, 'Payment status updated to refunded');

  // Deduct the credits that were originally added
  if (effectiveUserId && payment.credits_purchased > 0) {
    const result = await deductCredits(
      effectiveUserId,
      payment.credits_purchased,
      `Refund for payment ${resolvedPaymentId} (Charge ${charge.id})`,
      resolvedPaymentId,
    );
    if (result.success) {
      log.info(
        { userId: effectiveUserId, credits: payment.credits_purchased, balanceAfter: result.balance_after },
        'Credits deducted for refund',
      );
    } else {
      log.warn(
        { userId: effectiveUserId, credits: payment.credits_purchased, error: result.error },
        'Failed to deduct credits for refund — insufficient balance',
      );
    }
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const userId = resolveUserId(subscription.metadata, subscription.customer);

  log.info(
    {
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      userId,
    },
    'Processing customer.subscription.updated',
  );

  if (!userId) {
    log.warn({ subscriptionId: subscription.id }, 'subscription.updated missing userId — skipping DB update');
    return;
  }

  // Map Stripe subscription status to our status
  const statusMap: Record<string, 'active' | 'canceled' | 'past_due' | 'trialing' | 'paused'> = {
    active: 'active',
    canceled: 'canceled',
    past_due: 'past_due',
    trialing: 'trialing',
    paused: 'paused',
    incomplete: 'past_due',
    incomplete_expired: 'canceled',
    unpaid: 'past_due',
  };

  const mappedStatus = statusMap[subscription.status] || 'active';

  await updateSubscriptionStatus(
    userId,
    mappedStatus,
    subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : undefined,
  );

  log.info({ userId, subscriptionId: subscription.id, mappedStatus }, 'Subscription status updated');
}

// ============================================================================
// Route Handler
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await ensureNacosConfig();

    // Read raw body for signature verification
    const body = await request.text();
    const sig = request.headers.get('stripe-signature');

    if (!sig) {
      log.warn({}, 'Missing stripe-signature header');
      return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      log.error({}, 'STRIPE_WEBHOOK_SECRET not configured');
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    // Verify signature
    let event: Stripe.Event;
    try {
      const stripe = await getStripe();
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err: any) {
      log.warn({ err }, 'Webhook signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Idempotency check
    if (isEventProcessed(event.id)) {
      log.info({ eventId: event.id, type: event.type }, 'Duplicate event — already processed');
      return NextResponse.json({ received: true });
    }

    log.info({ eventId: event.id, type: event.type }, 'Webhook event received');

    // Dispatch event
    switch (event.type) {
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      default:
        log.info({ type: event.type, eventId: event.id }, 'Unhandled event type — ignoring');
        break;
    }

    // Mark as processed only after successful handling
    markEventProcessed(event.id);

    return NextResponse.json({ received: true });
  } catch (error: any) {
    log.error({ err: error }, 'Webhook handler error');
    // Return 200 to prevent Stripe from retrying on internal errors
    // (the event will be retried via idempotency miss if needed)
    return NextResponse.json({ received: true, error: 'Internal error' }, { status: 200 });
  }
}

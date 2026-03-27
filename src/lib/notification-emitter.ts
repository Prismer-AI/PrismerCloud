/**
 * Notification Emitter — fire-and-forget notification creation
 *
 * All functions are non-blocking. Errors are caught silently.
 * Only emits when FF_NOTIFICATIONS_LOCAL is enabled.
 */

import { createNotification, type CreateNotificationInput } from './db-notifications';
import { queryOne } from './db';
import { FEATURE_FLAGS } from './feature-flags';
import type { RowDataPacket } from 'mysql2/promise';

/**
 * Emit a notification (fire-and-forget).
 */
export function emitNotification(input: CreateNotificationInput): void {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;

  createNotification(input).catch(err => {
    console.error('[NotificationEmitter] Failed to create notification:', err);
  });
}

/**
 * Emit a low-credit alert if balance is below threshold.
 * Deduplicates: skips if one was sent within the last hour.
 */
export function emitLowCreditAlert(userId: number, balance: number): void {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;

  const threshold = parseFloat(process.env.LOW_CREDIT_THRESHOLD || '10');
  if (balance > threshold) return;

  // Check for recent duplicate
  queryOne<{ id: string } & RowDataPacket>(
    `SELECT id FROM pc_notifications
     WHERE user_id = ? AND reference_type = 'credits' AND type = 'warning'
       AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
     LIMIT 1`,
    [userId]
  ).then(existing => {
    if (existing) return; // Already sent recently

    createNotification({
      userId,
      type: 'warning',
      title: 'Low Credits Alert',
      message: `You have ${balance.toFixed(2)} credits remaining. Consider purchasing more.`,
      referenceType: 'credits',
    }).catch(err => {
      console.error('[NotificationEmitter] Low credit alert failed:', err);
    });
  }).catch(() => {});
}

/**
 * Emit a payment status notification.
 */
export function emitPaymentNotification(
  userId: number,
  status: string,
  amountCents: number,
  creditsPurchased: number,
  paymentId: string
): void {
  if (status === 'succeeded') {
    emitNotification({
      userId,
      type: 'success',
      title: 'Payment Successful',
      message: `Your purchase of ${creditsPurchased.toLocaleString()} credits ($${(amountCents / 100).toFixed(2)}) has been confirmed.`,
      referenceType: 'payment',
      referenceId: paymentId,
    });
  } else if (status === 'failed') {
    emitNotification({
      userId,
      type: 'error',
      title: 'Payment Failed',
      message: `Your payment of $${(amountCents / 100).toFixed(2)} could not be processed. Please check your payment method.`,
      referenceType: 'payment',
      referenceId: paymentId,
    });
  }
}

/**
 * Emit a task failure notification.
 */
export function emitTaskFailureNotification(
  userId: number,
  taskType: string,
  inputValue: string,
  errorMessage?: string
): void {
  const truncated = inputValue.length > 80 ? inputValue.substring(0, 80) + '...' : inputValue;
  emitNotification({
    userId,
    type: 'error',
    title: 'Processing Failed',
    message: `Failed to process ${taskType}: ${truncated}. ${errorMessage || ''}`.trim(),
    referenceType: 'usage_record',
  });
}

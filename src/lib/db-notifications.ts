/**
 * Database Operations for Notifications (pc_notifications)
 *
 * Feature Flag: FF_NOTIFICATIONS_LOCAL
 */

import { query, execute, queryOne, generateUUID } from './db';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

// ============================================================================
// Types
// ============================================================================

interface NotificationRow extends RowDataPacket {
  id: string;
  user_id: number;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  read: number;
  reference_type: string | null;
  reference_id: string | null;
  created_at: Date;
}

export interface CreateNotificationInput {
  userId: number;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  referenceType?: string;
  referenceId?: string;
}

export interface NotificationForClient {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  time: string;
  read: boolean;
  referenceType?: string;
  referenceId?: string;
}

// ============================================================================
// CRUD Operations
// ============================================================================

export async function createNotification(input: CreateNotificationInput): Promise<string> {
  const id = generateUUID();
  await execute(
    `INSERT INTO pc_notifications (id, user_id, type, title, message, reference_type, reference_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.type, input.title, input.message,
     input.referenceType || null, input.referenceId || null]
  );
  return id;
}

export async function getNotifications(
  userId: number,
  limit: number = 20
): Promise<{ notifications: NotificationForClient[]; unreadCount: number }> {
  const countRow = await queryOne<{ cnt: number } & RowDataPacket>(
    'SELECT COUNT(*) as cnt FROM pc_notifications WHERE user_id = ? AND `read` = 0',
    [userId]
  );
  const unreadCount = countRow?.cnt || 0;

  const rows = await query<NotificationRow[]>(
    'SELECT * FROM pc_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );

  return {
    notifications: rows.map(toClientNotification),
    unreadCount,
  };
}

export async function markRead(id: string, userId: number): Promise<boolean> {
  const result = await execute(
    'UPDATE pc_notifications SET `read` = 1 WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  return (result as ResultSetHeader).affectedRows > 0;
}

export async function markAllRead(userId: number): Promise<number> {
  const result = await execute(
    'UPDATE pc_notifications SET `read` = 1 WHERE user_id = ? AND `read` = 0',
    [userId]
  );
  return (result as ResultSetHeader).affectedRows;
}

export async function deleteNotification(id: string, userId: number): Promise<boolean> {
  const result = await execute(
    'DELETE FROM pc_notifications WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  return (result as ResultSetHeader).affectedRows > 0;
}

// ============================================================================
// Helpers
// ============================================================================

function toClientNotification(row: NotificationRow): NotificationForClient {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    time: formatRelativeTime(row.created_at),
    read: row.read === 1,
    referenceType: row.reference_type || undefined,
    referenceId: row.reference_id || undefined,
  };
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

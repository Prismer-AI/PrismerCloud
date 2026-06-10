/**
 * Database Operations for Notifications (pc_notifications)
 *
 * Feature Flag: FF_NOTIFICATIONS_LOCAL
 *
 * Wave-8 W9: this module is the canonical writer for the workspace Bell
 * drawer. The schema's `reference_type` column carries the **kind** —
 * `task_status`, `task_assigned`, `task_approval_requested`,
 * `approval_requested`,
 * `contact_request`, `contact_accepted`, `contact_blocked`,
 * `runtime_degraded`, `runtime_install_verified`, `runtime_install_failed`,
 * `runtime_agent_declared` — and `reference_id` carries the kind-specific
 * pointer (taskId / requestId / runtimeInstallationId / etc) so the UI can
 * route a click back into the right surface and select the right item.
 *
 * `payload` (rich event-specific JSON) is **stored in the message column as
 * JSON-prefixed `[[json:{…}]] human-readable summary`** rather than adding a
 * new column — keeps the migration footprint zero. The Bell parses the
 * prefix when present and falls back to the legacy plain-message rendering
 * for old rows. Helper methods `formatPayloadMessage` / `parsePayloadMessage`
 * encapsulate the encoding so callers never see the raw shape.
 */

import { query, execute, generateUUID } from './db';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

// ============================================================================
// Types
// ============================================================================

export type NotificationKind =
  | 'task_status'
  | 'task_assigned'
  | 'task_approval_requested'
  | 'approval_requested'
  | 'contact_request'
  | 'contact_accepted'
  | 'contact_blocked'
  | 'runtime_degraded'
  | 'runtime_install_verified'
  | 'runtime_install_failed'
  | 'runtime_agent_declared'
  | 'credits'
  | 'payment'
  | 'usage_record'
  | 'contact';

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
  referenceType?: NotificationKind | string;
  referenceId?: string;
  payload?: Record<string, unknown>;
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
  payload?: Record<string, unknown>;
  /** ISO string — present so client can sort independently of formatted relative time. */
  createdAt: string;
}

/**
 * Encode a structured payload + human-readable summary into a single
 * TEXT-storeable string. Format: `[[json:{…}]]\n<summary>`. The opening token
 * lets `parsePayloadMessage` reliably tell new rows from legacy plain text.
 */
function formatPayloadMessage(summary: string, payload?: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return summary;
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    json = '{}';
  }
  return `[[json:${json}]]\n${summary}`;
}

function parsePayloadMessage(raw: string): { message: string; payload?: Record<string, unknown> } {
  if (!raw.startsWith('[[json:')) return { message: raw };
  const closeIdx = raw.indexOf(']]');
  if (closeIdx === -1) return { message: raw };
  const jsonPart = raw.slice('[[json:'.length, closeIdx);
  const messagePart = raw.slice(closeIdx + 2).replace(/^\n/, '');
  try {
    const payload = JSON.parse(jsonPart) as Record<string, unknown>;
    return { message: messagePart, payload };
  } catch {
    return { message: raw };
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

export async function createNotification(input: CreateNotificationInput): Promise<string> {
  const id = generateUUID();
  const stored = formatPayloadMessage(input.message, input.payload);
  await execute(
    `INSERT INTO pc_notifications (id, user_id, type, title, message, reference_type, reference_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.type, input.title, stored, input.referenceType || null, input.referenceId || null],
  );
  return id;
}

/**
 * The kinds the workspace Bell groups into its three tabs. We keep the
 * source-of-truth here so route + UI stay in lockstep.
 */
export const TASK_KINDS: readonly string[] = [
  'task_status',
  'task_assigned',
  'task_approval_requested',
  'approval_requested',
];
export const CONTACT_KINDS: readonly string[] = ['contact_request', 'contact_accepted', 'contact_blocked', 'contact'];
export const RUNTIME_KINDS: readonly string[] = [
  'runtime_degraded',
  'runtime_install_verified',
  'runtime_install_failed',
  'runtime_agent_declared',
];

function kindsForFilter(filter: string | null | undefined): readonly string[] | null {
  if (!filter) return null;
  switch (filter) {
    case 'tasks':
      return TASK_KINDS;
    case 'contacts':
      return CONTACT_KINDS;
    case 'runtime':
      return RUNTIME_KINDS;
    default:
      return [filter];
  }
}

export async function getNotifications(
  userId: number,
  options: { limit?: number; kindFilter?: string | null } = {},
): Promise<{ notifications: NotificationForClient[]; unreadCount: number; unreadByKind: Record<string, number> }> {
  const filter = kindsForFilter(options.kindFilter ?? null);

  // Per-tab unread counts (drives the in-tab badges); always computed across
  // all kinds so the All view's group badges stay accurate.
  const unreadAll = await query<Array<{ reference_type: string | null; cnt: number } & RowDataPacket>>(
    'SELECT reference_type, COUNT(*) as cnt FROM pc_notifications WHERE user_id = ? AND `read` = 0 GROUP BY reference_type',
    [userId],
  );
  const unreadByKind: Record<string, number> = {};
  let unreadCount = 0;
  for (const row of unreadAll) {
    const k = row.reference_type ?? 'other';
    unreadByKind[k] = row.cnt;
    unreadCount += row.cnt;
  }

  // LIMIT inlined: mysql2 prepared statements (`pool.execute`) send bound
  // integers as strings via the binary protocol, which MySQL 8 rejects with
  // errno 1210. limit is a validated function arg → safe to inline.
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) || 50)));

  let rows: NotificationRow[];
  if (filter) {
    // Build (`?`,`?`,…) placeholder block for IN — mysql2 doesn't expand arrays
    // in prepared statements automatically.
    const placeholders = filter.map(() => '?').join(',');
    rows = await query<NotificationRow[]>(
      `SELECT * FROM pc_notifications WHERE user_id = ? AND reference_type IN (${placeholders})
         ORDER BY created_at DESC LIMIT ${safeLimit}`,
      [userId, ...filter],
    );
  } else {
    rows = await query<NotificationRow[]>(
      `SELECT * FROM pc_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
      [userId],
    );
  }

  return {
    notifications: rows.map(toClientNotification),
    unreadCount,
    unreadByKind,
  };
}

export async function markRead(id: string, userId: number): Promise<boolean> {
  const result = await execute('UPDATE pc_notifications SET `read` = 1 WHERE id = ? AND user_id = ?', [id, userId]);
  return (result as ResultSetHeader).affectedRows > 0;
}

export async function markAllRead(userId: number, kindFilter?: string | null): Promise<number> {
  const filter = kindsForFilter(kindFilter ?? null);
  if (filter) {
    const placeholders = filter.map(() => '?').join(',');
    const result = await execute(
      `UPDATE pc_notifications SET \`read\` = 1
         WHERE user_id = ? AND \`read\` = 0 AND reference_type IN (${placeholders})`,
      [userId, ...filter],
    );
    return (result as ResultSetHeader).affectedRows;
  }
  const result = await execute('UPDATE pc_notifications SET `read` = 1 WHERE user_id = ? AND `read` = 0', [userId]);
  return (result as ResultSetHeader).affectedRows;
}

export async function deleteNotification(id: string, userId: number): Promise<boolean> {
  const result = await execute('DELETE FROM pc_notifications WHERE id = ? AND user_id = ?', [id, userId]);
  return (result as ResultSetHeader).affectedRows > 0;
}

// ============================================================================
// Helpers
// ============================================================================

function toClientNotification(row: NotificationRow): NotificationForClient {
  const { message, payload } = parsePayloadMessage(row.message);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message,
    time: formatRelativeTime(row.created_at),
    read: row.read === 1,
    referenceType: row.reference_type || undefined,
    referenceId: row.reference_id || undefined,
    payload,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
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

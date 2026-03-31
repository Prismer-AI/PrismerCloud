/**
 * Database Operations for API Key Management
 *
 * 操作表：pc_api_keys
 * 前端先行实现，与后端解耦
 *
 * 设计：
 * - 存储 SHA-256 hash（不存明文 key）
 * - key_prefix 存前 20 字符供列表显示
 * - Feature flag: FF_API_KEYS_LOCAL=true 启用
 */

import { query, execute, queryOne, generateUUID } from './db';
import * as crypto from 'crypto';
import type { RowDataPacket } from 'mysql2/promise';

// ============================================================================
// Types
// ============================================================================

interface ApiKeyRow extends RowDataPacket {
  id: string;
  user_id: number;
  key_hash: string;
  key_prefix: string;
  label: string;
  status: string;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Response format matching frontend expectations */
export interface ApiKeyResponse {
  id: string;
  key: string;
  label: string;
  created: string;
  status: string;
}

// ============================================================================
// Key Generation
// ============================================================================

const KEY_PREFIX = 'sk-prismer-live-';

function generateApiKey(): string {
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function getKeyPrefix(apiKey: string): string {
  return apiKey.substring(0, 20);
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new API key for a user.
 * Returns the full key (only shown once — not stored in DB).
 */
export async function createApiKey(
  userId: number,
  label: string
): Promise<ApiKeyResponse> {
  const id = generateUUID();
  const fullKey = generateApiKey();
  const keyHash = hashApiKey(fullKey);
  const keyPrefix = getKeyPrefix(fullKey);

  const sql = `
    INSERT INTO pc_api_keys (id, user_id, key_hash, key_prefix, label, status)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE')
  `;
  await execute(sql, [id, userId, keyHash, keyPrefix, label]);

  console.log(`[API Keys] Created key ${keyPrefix}... for user ${userId}`);

  return {
    id,
    key: fullKey, // Full key returned only on creation
    label,
    created: new Date().toISOString(),
    status: 'ACTIVE',
  };
}

/**
 * Get all API keys for a user (masked display).
 */
export async function getUserApiKeys(userId: number): Promise<ApiKeyResponse[]> {
  const sql = `
    SELECT id, key_prefix, label, status, created_at
    FROM pc_api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;
  const rows = await query<ApiKeyRow[]>(sql, [userId]);

  return rows.map((row) => ({
    id: row.id,
    key: row.key_prefix + '...', // Masked for list display
    label: row.label || 'API Key',
    created: row.created_at.toISOString(),
    status: row.status,
  }));
}

/**
 * Revoke an API key (set status to REVOKED).
 */
export async function revokeApiKey(userId: number, keyId: string): Promise<boolean> {
  const sql = `
    UPDATE pc_api_keys SET status = 'REVOKED'
    WHERE id = ? AND user_id = ?
  `;
  const result = await execute(sql, [keyId, userId]);
  const affected = (result as any).affectedRows || 0;

  if (affected === 0) {
    console.warn(`[API Keys] Revoke failed: key ${keyId} not found for user ${userId}`);
    return false;
  }

  console.log(`[API Keys] Revoked key ${keyId} for user ${userId}`);
  return true;
}

/**
 * Delete an API key permanently.
 */
export async function deleteApiKey(userId: number, keyId: string): Promise<boolean> {
  const sql = `DELETE FROM pc_api_keys WHERE id = ? AND user_id = ?`;
  const result = await execute(sql, [keyId, userId]);
  const affected = (result as any).affectedRows || 0;

  if (affected === 0) {
    console.warn(`[API Keys] Delete failed: key ${keyId} not found for user ${userId}`);
    return false;
  }

  console.log(`[API Keys] Deleted key ${keyId} for user ${userId}`);
  return true;
}

// ============================================================================
// Validation (used by api-guard.ts)
// ============================================================================

/**
 * Validate an API key by hashing and looking up in DB.
 * Returns user_id if valid, null if invalid/revoked.
 * Updates last_used_at in background.
 */
export async function validateApiKeyFromDb(
  apiKey: string
): Promise<{ userId: number } | null> {
  const keyHash = hashApiKey(apiKey);

  const sql = `
    SELECT user_id FROM pc_api_keys
    WHERE key_hash = ? AND status = 'ACTIVE'
  `;
  const row = await queryOne<{ user_id: number } & RowDataPacket>(sql, [keyHash]);

  if (!row) {
    return null;
  }

  // Update last_used_at in background (fire-and-forget)
  execute(
    `UPDATE pc_api_keys SET last_used_at = NOW() WHERE key_hash = ?`,
    [keyHash]
  ).catch(() => {});

  return { userId: Number(row.user_id) };
}

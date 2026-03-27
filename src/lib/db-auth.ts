/**
 * Local Authentication Service (self-host mode)
 *
 * Provides user registration, login, password reset, and JWT management
 * using the local MySQL database (pc_users table).
 *
 * Activated via FF_AUTH_LOCAL=true
 */

import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { query, queryOne, execute } from '@/lib/db';

// ============================================================================
// Types
// ============================================================================

export interface LocalUser {
  id: number;
  email: string;
  avatar: string;
  is_active: boolean;
  email_verified: boolean;
  google_id: string;
  github_id: string;
  role: string;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuthResult {
  user: LocalUser;
  token: string;
}

// ============================================================================
// Password Hashing (using Node.js crypto — no bcrypt dependency needed)
// ============================================================================

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const ITERATIONS = 100_000;
const DIGEST = 'sha512';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const verify = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
}

// ============================================================================
// JWT
// ============================================================================

function getJWTSecret(): string {
  return process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
}

function signToken(user: LocalUser): string {
  return jwt.sign(
    {
      sub: String(user.id),
      user_id: user.id,
      email: user.email,
      role: user.role,
    },
    getJWTSecret(),
    { expiresIn: '7d' }
  );
}

// ============================================================================
// Registration
// ============================================================================

export async function registerUser(email: string, password: string): Promise<AuthResult> {
  // Check if user already exists
  const existing = await queryOne<{ id: number }>('SELECT id FROM pc_users WHERE email = ? AND deleted_at IS NULL', [email]);
  if (existing) {
    throw new Error('Email already registered');
  }

  const passwordHash = hashPassword(password);
  const result = await execute(
    'INSERT INTO pc_users (email, password_hash, email_verified) VALUES (?, ?, ?)',
    [email, passwordHash, process.env.SKIP_EMAIL_VERIFICATION === 'true' ? 1 : 0]
  );

  const user = await queryOne<LocalUser>('SELECT * FROM pc_users WHERE id = ?', [result.insertId]);
  if (!user) throw new Error('Failed to create user');

  // Initialize credits for new user
  try {
    await execute(
      'INSERT IGNORE INTO pc_user_credits (user_id, balance, total_earned, total_spent, plan) VALUES (?, ?, ?, 0, ?)',
      [user.id, process.env.UNLIMITED_CREDITS === 'true' ? 999999 : 100, process.env.UNLIMITED_CREDITS === 'true' ? 999999 : 100, 'free']
    );
  } catch {
    // pc_user_credits table might not exist yet — non-fatal
  }

  const token = signToken(user);
  await execute('UPDATE pc_users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  return { user, token };
}

// ============================================================================
// Login
// ============================================================================

export async function loginUser(email: string, password: string): Promise<AuthResult> {
  const user = await queryOne<LocalUser & { password_hash: string }>(
    'SELECT * FROM pc_users WHERE email = ? AND deleted_at IS NULL',
    [email]
  );

  if (!user) {
    throw new Error('Invalid email or password');
  }

  if (!user.is_active) {
    throw new Error('Account is deactivated');
  }

  if (!verifyPassword(password, user.password_hash)) {
    throw new Error('Invalid email or password');
  }

  const token = signToken(user);
  await execute('UPDATE pc_users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash: _, ...safeUser } = user;
  return { user: safeUser as LocalUser, token };
}

// ============================================================================
// Password Reset
// ============================================================================

export async function resetUserPassword(email: string, code: string, newPassword: string): Promise<{ message: string }> {
  // Verify code
  const valid = await verifyStoredCode(email, code, 'reset-password');
  if (!valid) {
    throw new Error('Invalid or expired verification code');
  }

  const passwordHash = hashPassword(newPassword);
  const result = await execute(
    'UPDATE pc_users SET password_hash = ? WHERE email = ? AND deleted_at IS NULL',
    [passwordHash, email]
  );

  if (result.affectedRows === 0) {
    throw new Error('User not found');
  }

  return { message: 'Password reset successfully' };
}

// ============================================================================
// Verification Codes
// ============================================================================

export async function sendVerificationCode(email: string, type: 'signup' | 'reset-password'): Promise<{ code: number; message: string; verification_code?: string }> {
  // Self-host mode: skip email verification if configured
  if (process.env.SKIP_EMAIL_VERIFICATION === 'true') {
    const fixedCode = '000000';
    await storeCode(email, fixedCode, type);
    return { code: 0, message: 'Verification code sent', verification_code: fixedCode };
  }

  // Generate random 6-digit code
  const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
  await storeCode(email, verificationCode, type);

  // TODO: Send email via SMTP if configured (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
  // For now, return the code in the response (dev/self-host convenience)
  console.log(`[Auth] Verification code for ${email}: ${verificationCode}`);

  return { code: 0, message: 'Verification code sent', verification_code: verificationCode };
}

export async function verifyUserCode(email: string, code: string, type: 'signup' | 'reset-password'): Promise<{ code: number; message: string }> {
  const valid = await verifyStoredCode(email, code, type);
  if (!valid) {
    throw new Error('Invalid or expired verification code');
  }
  return { code: 0, message: 'Code verified successfully' };
}

async function storeCode(email: string, code: string, type: string): Promise<void> {
  // Expire in 10 minutes
  await execute(
    'INSERT INTO pc_verification_codes (email, code, type, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
    [email, code, type]
  );
}

async function verifyStoredCode(email: string, code: string, type: string): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    'SELECT id FROM pc_verification_codes WHERE email = ? AND code = ? AND type = ? AND expires_at > NOW() AND used = 0 ORDER BY id DESC LIMIT 1',
    [email, code, type]
  );
  if (!row) return false;
  await execute('UPDATE pc_verification_codes SET used = 1 WHERE id = ?', [row.id]);
  return true;
}

// ============================================================================
// Admin: Create initial user
// ============================================================================

export async function ensureAdminUser(): Promise<void> {
  const email = process.env.INIT_ADMIN_EMAIL;
  const password = process.env.INIT_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await queryOne<{ id: number }>('SELECT id FROM pc_users WHERE email = ?', [email]);
  if (existing) return;

  const passwordHash = hashPassword(password);
  await execute(
    'INSERT INTO pc_users (email, password_hash, email_verified, role) VALUES (?, ?, 1, ?)',
    [email, passwordHash, 'admin']
  );
  console.log(`[Auth] Admin user created: ${email}`);
}

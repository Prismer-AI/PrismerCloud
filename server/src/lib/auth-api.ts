/**
 * Authentication API Client
 *
 * FF_AUTH_LOCAL=true  → local auth via pc_users table (self-host mode)
 * FF_AUTH_LOCAL=false → proxy to backend Go service
 */

import { getBackendApiBase } from '@/lib/backend-api';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import * as localAuth from '@/lib/db-auth';

export interface AuthUser {
  id: number;
  email: string;
  avatar: string;
  is_active: boolean;
  email_verified: boolean;
  last_login_at: string;
  google_id: string;
  github_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}

export interface ErrorResponse {
  error?: {
    code: number;
    msg: string;
  };
  message?: string;
  code?: number;
}

/**
 * GitHub OAuth callback
 * Uses /auth/cloud/github/callback (new v7.3+ path)
 */
export async function githubCallback(code: string): Promise<AuthResponse> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    throw new Error('GitHub OAuth is not available in self-host mode. Use email/password login, or configure GITHUB_CLIENT_ID/SECRET and disable FF_AUTH_LOCAL.');
  }

  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/auth/cloud/github/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'GitHub authentication failed');
  }

  return res.json();
}

/**
 * Google OAuth callback
 * Uses /auth/cloud/google/callback (new v7.3+ path)
 */
export async function googleCallback(accessToken: string): Promise<AuthResponse> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    throw new Error('Google OAuth is not available in self-host mode. Use email/password login, or configure GOOGLE_CLIENT_ID/SECRET and disable FF_AUTH_LOCAL.');
  }

  const backendBase = await getBackendApiBase();
  const res = await fetch(`${backendBase}/auth/cloud/google/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'Google authentication failed');
  }

  return res.json();
}

/**
 * Email/Password login
 */
export async function login(email: string, passwordHash: string): Promise<AuthResponse> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    const result = await localAuth.loginUser(email, passwordHash);
    return { user: result.user as unknown as AuthUser, token: result.token };
  }

  const backendBase = await getBackendApiBase();
  const authBase = `${backendBase}/auth`;
  const res = await fetch(`${authBase}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: passwordHash })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'Login failed');
  }

  return res.json();
}

/**
 * Register new user
 */
export async function register(
  email: string,
  passwordHash: string,
  _confirmPasswordHash: string,
  _code: string
): Promise<AuthResponse> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    const result = await localAuth.registerUser(email, passwordHash);
    return { user: result.user as unknown as AuthUser, token: result.token };
  }

  const backendBase = await getBackendApiBase();
  const authBase = `${backendBase}/auth`;
  const res = await fetch(`${authBase}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: passwordHash,
      confirm_password: _confirmPasswordHash,
      code: _code
    })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'Registration failed');
  }

  return res.json();
}

/**
 * Reset password
 */
export async function resetPassword(
  email: string,
  code: string,
  passwordHash: string,
  confirmPasswordHash: string
): Promise<{ message: string }> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    return localAuth.resetUserPassword(email, code, passwordHash);
  }

  const backendBase = await getBackendApiBase();
  const authBase = `${backendBase}/auth`;
  const res = await fetch(`${authBase}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      code,
      password: passwordHash,
      confirm_password: confirmPasswordHash
    })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'Password reset failed');
  }

  return res.json();
}

/**
 * Send verification code
 */
export async function sendCode(
  email: string,
  type: 'signup' | 'reset-password'
): Promise<{ code: number; message: string; verification_code?: string }> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    return localAuth.sendVerificationCode(email, type);
  }

  const backendBase = await getBackendApiBase();
  const authBase = `${backendBase}/auth`;
  const res = await fetch(`${authBase}/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, type })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'Failed to send code');
  }

  return res.json();
}

/**
 * Verify code
 */
export async function verifyCode(
  email: string,
  code: string,
  type: 'signup' | 'reset-password'
): Promise<{ code: number; message: string }> {
  if (FEATURE_FLAGS.AUTH_LOCAL) {
    return localAuth.verifyUserCode(email, code, type);
  }

  const backendBase = await getBackendApiBase();
  const authBase = `${backendBase}/auth`;
  const res = await fetch(`${authBase}/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, type })
  });

  if (!res.ok) {
    const error: ErrorResponse = await res.json();
    throw new Error(error.error?.msg || error.message || 'Code verification failed');
  }

  return res.json();
}


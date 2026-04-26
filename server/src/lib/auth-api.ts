/**
 * Authentication API Client
 * Proxies requests to backend API, whose base URL is provided via:
 * - BACKEND_API_BASE (full base, may already include /api/v1)
 * - BACKGROUND_BASE_URL (root domain, we append /api/v1)
 *
 * See `src/lib/backend-api.ts` for resolution logic.
 */

import { getBackendApiBase } from '@/lib/backend-api';

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
  const backendBase = await getBackendApiBase();
  // New path: /auth/cloud/github/callback (v7.3+)
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
  const backendBase = await getBackendApiBase();
  // New path: /auth/cloud/google/callback (v7.3+)
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
  confirmPasswordHash: string,
  code: string
): Promise<AuthResponse> {
  const backendBase = await getBackendApiBase();
  const authBase = `${backendBase}/auth`;
  const res = await fetch(`${authBase}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: passwordHash,
      confirm_password: confirmPasswordHash,
      code
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


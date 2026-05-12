/**
 * Crypto Utilities
 *
 * 密码加密和安全相关工具函数
 */

/**
 * SHA256 密码加密 (客户端)
 *
 * @param password - 明文密码
 * @returns SHA256 加密后的十六进制字符串
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成随机字符串 (用于 state 参数等)
 *
 * @param length - 字符串长度
 * @returns 随机字符串
 */
export function generateRandomString(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

/**
 * 验证邮箱格式
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * 验证密码强度
 *
 * @returns 密码强度等级: 'weak' | 'medium' | 'strong'
 */
// ============================================================
// PKCE (Proof Key for Code Exchange) — Twitter OAuth 2.0
// ============================================================

/**
 * Base64url encode (no padding, URL-safe)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE code_verifier (43-128 char, URL-safe random string)
 */
export function generateCodeVerifier(length: number = 64): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate a PKCE code_challenge from a code_verifier (S256 method)
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// ============================================================
// Password
// ============================================================

export function getPasswordStrength(password: string): 'weak' | 'medium' | 'strong' {
  if (password.length < 6) return 'weak';

  let score = 0;

  // 长度评分
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;

  // 复杂度评分
  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  if (score >= 5) return 'strong';
  if (score >= 3) return 'medium';
  return 'weak';
}

/**
 * Email Verification Sender
 *
 * Two providers selected by env (first match wins):
 *   1. Resend HTTP API   — RESEND_API_KEY + RESEND_FROM_EMAIL
 *   2. SMTP (nodemailer) — SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS + SMTP_FROM
 *
 * Templates and subject lines are byte-identical to the Go backend
 * (services/email/email.go) so users see the same branded email
 * regardless of which auth path generated it.
 *
 * Transient-error retry: each provider call is retried up to 3 times
 * with linear backoff for connection-like failures (matching Go's
 * sendEmail logic at email.go:254). Permanent failures (auth, bad
 * recipient) short-circuit immediately.
 *
 * If neither provider is configured, returns { success: false,
 * configured: false } and the caller falls back to the dev-only
 * "code in response" behavior (controlled by AUTH_EMAIL_CODE_RETURN_IN_RESPONSE).
 */

import { createModuleLogger } from '@/lib/logger';
import { renderEmailTemplate, type CodePurpose } from '@/lib/auth/email-templates';

export type { CodePurpose };

const log = createModuleLogger('AuthEmail');

const MAX_ATTEMPTS = 3;

export interface EmailSendResult {
  success: boolean;
  configured: boolean;
  provider?: 'resend' | 'smtp';
  error?: string;
  messageId?: string;
  attempts?: number;
  /** Set by the provider when the failure is definitively non-retryable. */
  permanent?: boolean;
}

/**
 * Permanent failures we should NOT retry. Prefer structured signals
 * (HTTP status, SMTP responseCode) over substring matching — the latter
 * can misfire on transient errors whose body happens to contain the
 * permanent-failure substring.
 */
function isPermanentError(result: EmailSendResult): boolean {
  if (result.permanent === true) return true;
  if (result.permanent === false) return false;

  // Last-resort substring fallback for cases where the provider didn't
  // surface a structured permanent flag (older error paths).
  if (!result.error) return false;
  const e = result.error.toLowerCase();
  return e.includes('not configured') || e.includes('not installed');
}

async function sleepLinear(attempt: number): Promise<void> {
  if (attempt === 0) return;
  await new Promise((r) => setTimeout(r, attempt * 1000));
}

// ─── Resend HTTP ─────────────────────────────────────────────

async function sendViaResendOnce(
  to: string,
  rendered: ReturnType<typeof renderEmailTemplate>,
): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.RESEND_FROM_EMAIL || 'Prismer <noreply@prismer.cloud>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch((e) => `<body read failed: ${(e as Error).message}>`);
    // Resend permanent errors: 401 (bad key), 403 (forbidden), 422
    // (validation — bad recipient, missing from). 4xx other (e.g. 429
    // throttling) and all 5xx are transient.
    const permanent = res.status === 401 || res.status === 403 || res.status === 422;
    return {
      success: false,
      configured: true,
      provider: 'resend',
      error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      permanent,
    };
  }

  const data = (await res.json()) as { id?: string };
  return { success: true, configured: true, provider: 'resend', messageId: data.id };
}

// ─── SMTP (nodemailer) ───────────────────────────────────────

async function sendViaSmtpOnce(to: string, rendered: ReturnType<typeof renderEmailTemplate>): Promise<EmailSendResult> {
  let nodemailer: any;
  try {
    nodemailer = await import('nodemailer');
  } catch {
    // nodemailer absent at runtime → treat as NOT configured so the
    // caller can fall back to dev-mode response or 503, rather than
    // returning a 502 "send failed" forever.
    return {
      success: false,
      configured: false,
      provider: 'smtp',
      error: 'nodemailer not installed',
      permanent: true,
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || 'Prismer <noreply@prismer.cloud>',
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    return { success: true, configured: true, provider: 'smtp', messageId: info.messageId };
  } catch (err: any) {
    // SMTP permanent errors: 5xx response codes (per RFC 5321) are
    // permanent failures, 4xx are transient. nodemailer attaches the
    // numeric `responseCode` when available.
    const responseCode = typeof err?.responseCode === 'number' ? err.responseCode : undefined;
    const permanent = responseCode !== undefined && responseCode >= 500 && responseCode < 600;
    return {
      success: false,
      configured: true,
      provider: 'smtp',
      error: err instanceof Error ? err.message : 'SMTP send failed',
      permanent,
    };
  }
}

// ─── Retry wrapper ───────────────────────────────────────────

async function withRetry(label: string, attempt: (n: number) => Promise<EmailSendResult>): Promise<EmailSendResult> {
  let last: EmailSendResult = { success: false, configured: true, error: 'no attempts' };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await sleepLinear(i);
    last = await attempt(i);
    if (last.success) {
      log.info({ provider: last.provider, attempts: i + 1, label }, 'Email sent');
      return { ...last, attempts: i + 1 };
    }
    if (isPermanentError(last)) {
      log.error({ provider: last.provider, error: last.error, label }, 'Email permanent failure (no retry)');
      return { ...last, attempts: i + 1 };
    }
    log.warn({ provider: last.provider, attempt: i + 1, error: last.error, label }, 'Email attempt failed, retrying');
  }
  log.error({ provider: last.provider, error: last.error, label }, 'Email failed after retries');
  return { ...last, attempts: MAX_ATTEMPTS };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Dispatches a verification email. Returns `{ configured: false }` if no
 * provider is wired so the caller can fall back to dev behavior.
 */
export async function sendVerificationEmail(to: string, code: string, purpose: CodePurpose): Promise<EmailSendResult> {
  const rendered = renderEmailTemplate(code, purpose);

  if (process.env.RESEND_API_KEY) {
    return withRetry(`resend:${purpose}`, () => sendViaResendOnce(to, rendered));
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return withRetry(`smtp:${purpose}`, () => sendViaSmtpOnce(to, rendered));
  }
  return { success: false, configured: false };
}

/**
 * External API Circuit Breakers — cockatiel-based
 *
 * Prevents cascading failures when Exa/OpenAI/Stripe/Parser are down.
 * Each service gets its own breaker: 5 consecutive failures → open → 30s cooldown.
 *
 * Usage:
 *   const result = await exaBreaker.execute(() => exa.search(query));
 */

import {
  ConsecutiveBreaker,
  TimeoutStrategy,
  handleAll,
  retry,
  timeout,
  circuitBreaker,
  wrap,
} from 'cockatiel';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('CircuitBreaker');

// ─── Factory ──────────────────────────────────────────────────

function createServiceBreaker(name: string, opts: {
  failureThreshold?: number;
  halfOpenAfterMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}) {
  const {
    failureThreshold = 5,
    halfOpenAfterMs = 30_000,
    timeoutMs = 15_000,
    maxRetries = 1,
  } = opts;

  const breaker = new ConsecutiveBreaker(failureThreshold);
  const cb = circuitBreaker(handleAll, {
    halfOpenAfter: halfOpenAfterMs,
    breaker,
  });

  cb.onBreak(() => {
    log.warn({ service: name, threshold: failureThreshold }, 'OPEN — consecutive failures');
  });
  cb.onReset(() => {
    log.info({ service: name }, 'CLOSED — recovered');
  });
  cb.onHalfOpen(() => {
    log.info({ service: name }, 'HALF-OPEN — testing');
  });

  // Policy stack: circuit breaker → retry → timeout
  // Breaker outermost: open → immediate reject, no wasted retries
  // Retry inside breaker: only retries when breaker is closed
  const timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);

  if (maxRetries > 0) {
    const retryPolicy = retry(handleAll, { maxAttempts: maxRetries });
    return wrap(cb, retryPolicy, timeoutPolicy);
  }

  return wrap(cb, timeoutPolicy);
}

// ─── Service-specific breakers ─────────────────────────────────

/** Exa Search/Content API — 15s timeout, 1 retry */
export const exaBreaker = createServiceBreaker('Exa', {
  timeoutMs: 15_000,
  maxRetries: 1,
});

/** OpenAI Compress API — 30s timeout (LLM can be slow), 1 retry */
export const openaiBreaker = createServiceBreaker('OpenAI', {
  timeoutMs: 30_000,
  maxRetries: 1,
});

/** Stripe Payments — 10s timeout, no retry (payments must not double-charge) */
export const stripeBreaker = createServiceBreaker('Stripe', {
  timeoutMs: 10_000,
  maxRetries: 0,
});

/** Parser Service — 60s timeout (HiRes OCR is slow), 1 retry */
export const parserBreaker = createServiceBreaker('Parser', {
  timeoutMs: 60_000,
  maxRetries: 1,
});

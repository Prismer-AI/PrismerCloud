// release202/12 (D2) — classification of upstream LLM failures into
// permanent (skip the 3× retry, surface the real reason) vs transient (retry).
// Pins the fix that hermes drops `error.type`, so classification must key on the
// human message WORDING (verified against real hermes _summarize output), never
// on the machine token `provider_chain_unconfigured`.
import { describe, it, expect } from 'vitest';
import { isPermanentUpstreamError } from '../src/daemon/dispatch.js';
import type { TaskResult } from '../src/adapters/contract.js';

function res(message: string): TaskResult {
  return { ok: false, output: '', error: { code: 'upstream_llm_error', message } } as TaskResult;
}

describe('isPermanentUpstreamError', () => {
  it('PERMANENT: provider chain unconfigured (real hermes wording, no type token)', () => {
    // This is what real traffic emits — note `provider_chain_unconfigured` is ABSENT.
    expect(
      isPermanentUpstreamError(
        res('API call failed after 3 retries: HTTP 503: Provider chain "deepseek" has no usable upstream source (deepseek: missing-key).'),
      ),
    ).toBe(true);
  });

  it('PERMANENT: billing/credits exhausted (HTTP 402 from the P1 gate)', () => {
    expect(isPermanentUpstreamError(res('Billing or credits exhausted: HTTP 402: Insufficient credits'))).toBe(true);
  });

  it('PERMANENT: 4xx auth / not-found', () => {
    expect(isPermanentUpstreamError(res('API call failed after 3 retries: HTTP 401: invalid api key'))).toBe(true);
    expect(isPermanentUpstreamError(res('API call failed after 3 retries: HTTP 404: model not found'))).toBe(true);
  });

  it('TRANSIENT: generic 503 overload / 429 / network → retryable', () => {
    expect(isPermanentUpstreamError(res('API call failed after 3 retries: HTTP 503: engine overloaded'))).toBe(false);
    expect(isPermanentUpstreamError(res('API call failed after 3 retries: HTTP 429: rate limited'))).toBe(false);
    expect(isPermanentUpstreamError(res('API call failed after 3 retries: Request timed out.'))).toBe(false);
  });

  it('not an upstream error code → not classified here', () => {
    expect(isPermanentUpstreamError({ ok: false, error: { code: 'task_cancelled', message: 'x' } } as TaskResult)).toBe(false);
  });
});

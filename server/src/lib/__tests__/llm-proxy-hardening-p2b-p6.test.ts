/**
 * release202/12 — hardening findings P2b + P6.
 *
 * P2b (billing identity single source of truth): the usage recorder must book
 * the local credit deduction to the caller-provided `guard.auth.userId`, NOT a
 * re-parse of the Authorization header. We mock the DB layer and assert that
 * the userId reaching createUsageRecord / deductCredits is the one threaded in
 * explicitly — and that the legacy header-parse path still works when no id is
 * passed. P3 defense-in-depth: a non-numeric resolved id (phantom apikey_<hash>)
 * is dropped, never booked.
 *
 * P6 (upstream header allowlist): buildUpstreamHeaders forwards ONLY allowlisted
 * headers and the swapped auth — Cookie / X-Api-Key / arbitrary caller headers
 * must NOT reach the upstream URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB / config stubs so recordUsageLocal runs purely in-memory ──
const created: Array<{ userId: number }> = [];
const deducted: Array<{ userId: number; amount: number }> = [];

vi.mock('@/lib/nacos-config', () => ({ ensureNacosConfig: vi.fn(async () => {}) }));
vi.mock('@/lib/notification-emitter', () => ({ emitLowCreditAlert: vi.fn() }));
vi.mock('@/lib/db', () => ({
  // recordUsageLocal wraps create+deduct in withTransaction when credits > 0.
  withTransaction: vi.fn(async (fn: (conn: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('@/lib/db-usage', () => ({
  createUsageRecord: vi.fn(async (userId: number) => {
    created.push({ userId });
    return { id: 'rec_1' };
  }),
}));
vi.mock('@/lib/db-credits', () => ({
  deductCredits: vi.fn(async (userId: number, amount: number) => {
    deducted.push({ userId, amount });
    return { success: true, balance_after: 100 };
  }),
  getUserCredits: vi.fn(async () => ({ balance: 100 })),
}));
// getUserFromAuth is the LEGACY identity source — if P2b works, the explicit-id
// path must NEVER call it. We make it return a DELIBERATELY DIFFERENT user so a
// regression (falling back to header parse) is caught by the userId assertion.
// The mock factory is hoisted, so the spy lives inside it and is read back via
// the mocked module import below.
const HEADER_USER_ID = 999;
vi.mock('@/lib/auth-utils', () => ({
  getUserFromAuth: vi.fn(async () => ({
    success: true,
    user: { id: HEADER_USER_ID, email: 'header@example.com' },
  })),
}));

import { recordUsage, type UsageRecordRequest } from '@/lib/usage-recorder';
import { getUserFromAuth } from '@/lib/auth-utils';
const getUserFromAuthMock = vi.mocked(getUserFromAuth);

function billableRecord(): UsageRecordRequest {
  return {
    task_id: 'llm_test',
    task_type: 'llm_proxy',
    input: { type: 'query', value: '/v1/chat/completions model=x' },
    metrics: { tokens_input: 10, tokens_output: 5, processing_time_ms: 0 },
    cost: { total_credits: 7 },
  };
}

beforeEach(() => {
  created.length = 0;
  deducted.length = 0;
  getUserFromAuthMock.mockClear();
  process.env.FF_USAGE_RECORD_LOCAL = 'true';
});
afterEach(() => {
  delete process.env.FF_USAGE_RECORD_LOCAL;
});

describe('P2b — billing identity is the resolved userId, not a header re-parse', () => {
  it('books credits to the explicitly-passed resolved userId (numeric string)', async () => {
    const ok = await recordUsage(billableRecord(), 'Bearer some-token', '42');
    expect(ok).toBe(true);
    expect(created).toEqual([{ userId: 42 }]);
    expect(deducted).toEqual([{ userId: 42, amount: 7 }]);
    // The explicit-id path must NOT re-derive identity from the header.
    expect(getUserFromAuthMock).not.toHaveBeenCalled();
  });

  it('falls back to header-derived identity when no resolved id is passed (legacy callers)', async () => {
    const ok = await recordUsage(billableRecord(), 'Bearer some-token');
    expect(ok).toBe(true);
    expect(getUserFromAuthMock).toHaveBeenCalledTimes(1);
    expect(created).toEqual([{ userId: HEADER_USER_ID }]);
    expect(deducted).toEqual([{ userId: HEADER_USER_ID, amount: 7 }]);
  });

  it('P3 — drops the record for a non-numeric resolved id (phantom apikey_<hash>), no spend booked', async () => {
    const ok = await recordUsage(billableRecord(), 'Bearer some-token', 'apikey_deadbeef');
    expect(ok).toBe(false);
    expect(created).toEqual([]);
    expect(deducted).toEqual([]);
    // Must NOT silently fall back to the header identity either.
    expect(getUserFromAuthMock).not.toHaveBeenCalled();
  });
});

describe('P6 — buildUpstreamHeaders allowlist (OpenAI proxy)', () => {
  // Import lazily so the DB mocks above are already wired (the module pulls in
  // usage-recorder transitively).
  it('keeps allowlisted headers, drops Cookie / X-Api-Key / arbitrary caller headers, swaps auth', async () => {
    const { __test } = await import('@/lib/llm-proxy');
    const incoming = new Headers();
    incoming.set('content-type', 'application/json');
    incoming.set('accept', 'text/event-stream');
    incoming.set('user-agent', 'OpenAI/Python');
    incoming.set('authorization', 'Bearer sk-prismer-caller');
    incoming.set('cookie', 'session=secret');
    incoming.set('x-api-key', 'sk-caller-leak');
    incoming.set('x-prismer-idempotency-key', 'llm:abc');
    incoming.set('x-evil-custom', 'pwned');

    const out = __test.buildUpstreamHeaders(incoming, 'UPSTREAM_TOKEN');

    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('accept')).toBe('text/event-stream');
    expect(out.get('user-agent')).toBe('OpenAI/Python');
    // Dropped:
    expect(out.get('cookie')).toBeNull();
    expect(out.get('x-api-key')).toBeNull();
    expect(out.get('x-prismer-idempotency-key')).toBeNull();
    expect(out.get('x-evil-custom')).toBeNull();
    // Auth swapped to the upstream bearer, caller's bearer NOT forwarded:
    expect(out.get('authorization')).toBe('Bearer sk-UPSTREAM_TOKEN');
  });
});

describe('P6 — buildUpstreamHeaders allowlist (Anthropic proxy)', () => {
  it('keeps anthropic-version/beta + content negotiation, drops the rest, sets x-api-key', async () => {
    const { __test } = await import('@/lib/llm-proxy-anthropic');
    const incoming = new Headers();
    incoming.set('content-type', 'application/json');
    incoming.set('anthropic-version', '2023-06-01');
    incoming.set('anthropic-beta', 'prompt-caching-2024-07-31');
    incoming.set('x-api-key', 'sk-caller-leak');
    incoming.set('authorization', 'Bearer caller');
    incoming.set('cookie', 'session=secret');
    incoming.set('x-prismer-task-run-id', 'run_1');

    const out = __test.buildUpstreamHeaders(incoming, 'UPSTREAM_TOKEN');

    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('anthropic-version')).toBe('2023-06-01');
    expect(out.get('anthropic-beta')).toBe('prompt-caching-2024-07-31');
    expect(out.get('cookie')).toBeNull();
    expect(out.get('authorization')).toBeNull();
    expect(out.get('x-prismer-task-run-id')).toBeNull();
    // Upstream auth swapped onto x-api-key; caller's leaked key NOT forwarded.
    expect(out.get('x-api-key')).toBe('sk-UPSTREAM_TOKEN');
  });
});

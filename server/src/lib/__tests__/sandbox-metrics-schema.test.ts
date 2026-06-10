/**
 * S7 — schema test for /api/sandboxes/_admin/sandbox-metrics.
 *
 * Validates the response shape matches the SandboxMetrics contract
 * defined in src/types/sandbox-metrics.ts. Calls the GET handler
 * directly with NextAuth + RBAC mocked, against the real local Prisma
 * (SQLite dev DB), so we exercise the full query graph including the
 * new v200 fields (byProviderKind, daemon.*, slo.*, recentFailures).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { SandboxMetrics } from '@/types/sandbox-metrics';

vi.mock('@/lib/auth/nextauth', () => ({
  auth: vi.fn(async () => ({ user: { email: 'dev@local' } })),
}));

vi.mock('@/lib/admin-rbac', () => ({
  isSandboxAdmin: () => true,
}));

// F3 follow-up (2026-05-19): vitest has no DATABASE_URL fixture so
// PrismaClient init throws. Mock the prisma module with empty defaults
// — sub-suites assert the empty-fleet baseline (0 containers, null
// percentiles, ok=true SLOs). Mirrors sandbox-resources-schema.test.ts
// + sandbox-k8s-reconciler.test.ts pattern.
vi.mock('@/lib/prisma', () => {
  const findFirst = vi.fn(async () => null);
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const groupBy = vi.fn(async () => []);
  const aggregate = vi.fn(async () => ({ _avg: {}, _count: {}, _max: {}, _min: {} }));
  const iMContainer = { findFirst, findMany, count, groupBy, aggregate };
  const iMSandboxRunLog = { findMany, count, groupBy, aggregate };
  const iMSandboxResourceSample = { findMany, count, aggregate };
  return {
    default: { iMContainer, iMSandboxRunLog, iMSandboxResourceSample },
    prisma: { iMContainer, iMSandboxRunLog, iMSandboxResourceSample },
  };
});

describe('GET /api/sandboxes/_admin/sandbox-metrics — Release 200 §08 §7.2', () => {
  let response: SandboxMetrics;

  beforeAll(async () => {
    // Dynamic import after mocks are registered.
    const mod = await import('@/app/api/sandboxes/%5Fadmin/sandbox-metrics/route');
    const req = new Request('http://127.0.0.1:3000/api/sandboxes/_admin/sandbox-metrics');
    const res = await mod.GET(req as never);
    expect(res.status).toBe(200);
    response = (await res.json()) as SandboxMetrics;
    if (process.env.S7_DUMP === '1') {
      console.log('[S7-DUMP]', JSON.stringify(response, null, 2));
    }
  }, 30_000);

  it('has top-level required keys', () => {
    expect(response).toHaveProperty('generatedAt');
    expect(response).toHaveProperty('containers');
    expect(response).toHaveProperty('runs');
    expect(response).toHaveProperty('daemon');
    expect(response).toHaveProperty('slo');
    expect(response).toHaveProperty('recent');
    expect(response).toHaveProperty('inFlight');
    expect(response).toHaveProperty('recentFailures');
  });

  it('containers section has byStatus, byRuntimeKind, byProviderKind', () => {
    expect(typeof response.containers.total).toBe('number');
    expect(typeof response.containers.byStatus).toBe('object');
    expect(typeof response.containers.byRuntimeKind).toBe('object'); // legacy preserved
    expect(typeof response.containers.byProviderKind).toBe('object'); // v200 new
  });

  it('runs section includes cold-start p50/p99 + errorRate24h', () => {
    expect(response.runs).toHaveProperty('coldStartP50Sec');
    expect(response.runs).toHaveProperty('coldStartP99Sec');
    expect(response.runs).toHaveProperty('errorRate24h');
    expect(typeof response.runs.errorRate24h).toBe('number');
    expect(response.runs.errorRate24h).toBeGreaterThanOrEqual(0);
    expect(response.runs.errorRate24h).toBeLessThanOrEqual(1);
  });

  it('daemon section has healthPassRateLastHour + avgRttMs + degradedNow', () => {
    expect(response.daemon).toHaveProperty('healthPassRateLastHour');
    expect(response.daemon).toHaveProperty('avgRttMs');
    expect(response.daemon).toHaveProperty('degradedNow');
    expect(typeof response.daemon.healthPassRateLastHour).toBe('number');
    expect(response.daemon.healthPassRateLastHour).toBeGreaterThanOrEqual(0);
    expect(response.daemon.healthPassRateLastHour).toBeLessThanOrEqual(1);
    expect(typeof response.daemon.degradedNow).toBe('number');
  });

  it('slo section has three entries with target + current + ok', () => {
    for (const key of ['coldStartP99', 'daemonHealthPassRate', 'reconcilerLag'] as const) {
      expect(response.slo[key]).toBeDefined();
      expect(response.slo[key]).toHaveProperty('target');
      expect(response.slo[key]).toHaveProperty('current');
      expect(response.slo[key]).toHaveProperty('ok');
      expect(typeof response.slo[key].target).toBe('number');
      expect(typeof response.slo[key].ok).toBe('boolean');
    }
  });

  it('recent rows include providerKind', () => {
    for (const row of response.recent) {
      expect(row).toHaveProperty('providerKind');
      expect(typeof row.providerKind).toBe('string');
    }
  });

  it('recentFailures is an array with expected shape (may be empty)', () => {
    expect(Array.isArray(response.recentFailures)).toBe(true);
    for (const f of response.recentFailures) {
      expect(f).toHaveProperty('id');
      expect(f).toHaveProperty('podName');
      expect(f).toHaveProperty('providerKind');
      expect(f).toHaveProperty('endedAt');
    }
  });
});

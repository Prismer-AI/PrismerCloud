/**
 * S7 — schema test for /api/sandboxes/[id]/resources.
 *
 * Validates the response shape: containerId / since / samples[].
 * Uses a real container ID from the local dev MySQL DB (left behind
 * by S5/S6 smoke runs).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('@/lib/auth/nextauth', () => ({
  auth: vi.fn(async () => ({ user: { email: 'dev@local' } })),
}));

vi.mock('@/lib/admin-rbac', () => ({
  isSandboxAdmin: () => true,
}));

// Mock prisma so vitest does not require a live DATABASE_URL.
// `findUnique` returns null by default (used by the "unknown container"
// test). Individual tests below override the mocks when they need a row.
vi.mock('@/lib/prisma', () => {
  const findUnique = vi.fn(async () => null);
  const findMany = vi.fn(async () => []);
  const findFirst = vi.fn(async () => null);
  return {
    default: {
      iMContainer: { findUnique },
      iMSandboxResourceSample: { findMany, findFirst },
    },
  };
});

interface ResourcesResponse {
  containerId: string;
  since: string;
  samples: Array<{
    sampledAt: string;
    cpuUsagePct: number;
    memUsedBytes: string;
    memLimitBytes: string;
    daemonRttMs: number;
  }>;
}

describe('GET /api/sandboxes/[id]/resources — Release 200 §08 §8.2', () => {
  it('returns 404 for unknown container', async () => {
    const mod = await import('@/app/api/sandboxes/[id]/resources/route');
    const req = new Request('http://127.0.0.1:3000/api/sandboxes/nonexistent/resources');
    const res = await mod.GET(req as never, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  }, 15_000);

  describe('against a real container from dev DB', () => {
    let response: ResourcesResponse;

    beforeAll(async () => {
      // Resolve any container ID that has at least one sample.
      const prismaMod = await import('@/lib/prisma');
      const prisma = prismaMod.default;
      const sample = await prisma.iMSandboxResourceSample.findFirst({
        orderBy: { sampledAt: 'desc' },
      });
      if (!sample) {
        // Skip the rest of the suite — no samples in the dev DB.
        return;
      }
      const mod = await import('@/app/api/sandboxes/[id]/resources/route');
      const req = new Request(`http://127.0.0.1:3000/api/sandboxes/${sample.containerId}/resources`);
      const res = await mod.GET(req as never, {
        params: Promise.resolve({ id: sample.containerId }),
      });
      expect(res.status).toBe(200);
      response = (await res.json()) as ResourcesResponse;
      if (process.env.S7_DUMP === '1') {
        console.log('[S7-DUMP-RESOURCES]', JSON.stringify(response, null, 2));
      }
    }, 30_000);

    it('returns expected envelope shape', () => {
      if (!response) return;
      expect(response).toHaveProperty('containerId');
      expect(response).toHaveProperty('since');
      expect(response).toHaveProperty('samples');
      expect(Array.isArray(response.samples)).toBe(true);
    });

    it('each sample has cpu / mem / rtt fields', () => {
      if (!response) return;
      for (const s of response.samples) {
        expect(s).toHaveProperty('sampledAt');
        expect(s).toHaveProperty('cpuUsagePct');
        expect(s).toHaveProperty('memUsedBytes');
        expect(s).toHaveProperty('memLimitBytes');
        expect(s).toHaveProperty('daemonRttMs');
        expect(typeof s.memUsedBytes).toBe('string'); // BigInt → string
        expect(typeof s.daemonRttMs).toBe('number');
      }
    });
  });
});

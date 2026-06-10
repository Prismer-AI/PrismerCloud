import { describe, expect, it, vi } from 'vitest';
import { ClaimLostError, ParseClaimController } from '../src/daemon/asset/parse-claim.js';
import type { CloudClient } from '../src/auth.js';

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function fakeCloud(handler: (rec: Recorded) => { status: number; body: unknown }): { cloud: CloudClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const cloud = {
    async request<T>(method: string, path: string, init?: { body?: unknown }): Promise<{ ok: boolean; status: number; data?: T; error?: { code: string; message: string } }> {
      const rec: Recorded = { method, path, body: (init?.body as Record<string, unknown>) ?? null };
      calls.push(rec);
      const result = handler(rec);
      const ok = result.status < 400;
      return {
        ok,
        status: result.status,
        ...(ok
          ? { data: result.body as T }
          : { data: result.body as T, error: (result.body as { error?: { code: string; message: string } }).error ?? { code: 'err', message: 'err' } }),
      };
    },
  } as unknown as CloudClient;
  return { cloud, calls };
}

describe('ParseClaimController', () => {
  it('acquire returns acquired on 201 + sends correct payload', async () => {
    const { cloud, calls } = fakeCloud(() => ({
      status: 201,
      body: {
        ok: true,
        data: {
          id: 'cl_1',
          workspaceId: 'ws',
          assetId: 'asset',
          ingestVersion: 1,
          claimantImUserId: 'u',
          claimantDeviceId: 'dev-A',
          status: 'active',
          claimedAt: '2026-05-10T00:00:00Z',
          heartbeatAt: '2026-05-10T00:00:00Z',
          completedAt: null,
        },
      },
    }));
    const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A' });
    const result = await ctrl.acquire({ assetId: 'asset', ingestVersion: 1 });
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') expect(result.claim.id).toBe('cl_1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/api/im/ingest/claims');
    expect(calls[0].body).toEqual({ assetId: 'asset', ingestVersion: 1, deviceId: 'dev-A' });
  });

  it('acquire returns claimed_active on 409 with that code', async () => {
    const { cloud } = fakeCloud(() => ({
      status: 409,
      body: {
        ok: false,
        error: { code: 'claimed_active', message: 'owned by other' },
        meta: {
          claim: {
            id: 'cl_other',
            workspaceId: 'ws',
            assetId: 'asset',
            ingestVersion: 1,
            claimantImUserId: 'someone-else',
            claimantDeviceId: 'dev-B',
            status: 'active',
            claimedAt: '2026-05-10T00:00:00Z',
            heartbeatAt: '2026-05-10T00:00:05Z',
            completedAt: null,
          },
        },
      },
    }));
    const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A' });
    const result = await ctrl.acquire({ assetId: 'asset', ingestVersion: 1 });
    expect(result.kind).toBe('claimed_active');
    if (result.kind === 'claimed_active') expect(result.current.claimantDeviceId).toBe('dev-B');
  });

  it('acquire returns already_complete on 409 with that code', async () => {
    const { cloud } = fakeCloud(() => ({
      status: 409,
      body: {
        ok: false,
        error: { code: 'already_complete', message: 'done' },
        meta: {
          claim: {
            id: 'cl_done',
            workspaceId: 'ws',
            assetId: 'asset',
            ingestVersion: 1,
            claimantImUserId: 'u',
            claimantDeviceId: 'dev-X',
            status: 'completed',
            claimedAt: '2026-05-10T00:00:00Z',
            heartbeatAt: '2026-05-10T00:01:00Z',
            completedAt: '2026-05-10T00:01:00Z',
          },
        },
      },
    }));
    const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A' });
    const result = await ctrl.acquire({ assetId: 'asset', ingestVersion: 1 });
    expect(result.kind).toBe('already_complete');
  });

  it('startHeartbeat fires sendHeartbeat on its interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { cloud, calls } = fakeCloud(() => ({
        status: 200,
        body: {
          ok: true,
          data: {
            id: 'cl_1',
            workspaceId: 'ws',
            assetId: 'asset',
            ingestVersion: 1,
            claimantImUserId: 'u',
            claimantDeviceId: 'dev-A',
            status: 'active',
            claimedAt: '2026-05-10T00:00:00Z',
            heartbeatAt: new Date().toISOString(),
            completedAt: null,
          },
        },
      }));
      const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A', heartbeatIntervalMs: 100 });
      const { stop } = ctrl.startHeartbeat('cl_1');
      await vi.advanceTimersByTimeAsync(250);
      stop();
      await vi.advanceTimersByTimeAsync(500);
      const heartbeatCalls = calls.filter((c) => c.path === '/api/im/ingest/claims/cl_1/heartbeat');
      expect(heartbeatCalls.length).toBe(2); // 100ms and 200ms ticks; 300ms is after stop
      for (const call of heartbeatCalls) {
        expect(call.body).toEqual({ deviceId: 'dev-A' });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // C4 follow-up: heartbeat must stop itself when the server says the claim
  // is lost. Without this, a daemon that hands off to another can spam dead
  // heartbeats and the worker keeps parsing data it no longer owns.
  it('sendHeartbeat throws ClaimLostError on 410 claim_taken_over', async () => {
    const { cloud } = fakeCloud(() => ({
      status: 410,
      body: {
        ok: false,
        error: { code: 'claim_taken_over', message: 'Claim belongs to a different daemon' },
      },
    }));
    const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A' });
    await expect(ctrl.sendHeartbeat('cl_1')).rejects.toBeInstanceOf(ClaimLostError);
    try {
      await ctrl.sendHeartbeat('cl_1');
    } catch (err) {
      expect((err as ClaimLostError).reason).toBe('claim_taken_over');
    }
  });

  it('sendHeartbeat throws plain Error on non-410 failures (preserves diagnostic path)', async () => {
    const { cloud } = fakeCloud(() => ({
      status: 500,
      body: { ok: false, error: { code: 'internal_error', message: 'db down' } },
    }));
    const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A' });
    await expect(ctrl.sendHeartbeat('cl_1')).rejects.not.toBeInstanceOf(ClaimLostError);
  });

  it('startHeartbeat stops itself + fires onLost on 410', async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const { cloud, calls } = fakeCloud(() => {
        callCount += 1;
        // First tick: 410 takeover. Subsequent ticks would 200, but we
        // expect the loop to have stopped — so a second hit indicates a
        // regression of the bug.
        if (callCount === 1) {
          return {
            status: 410,
            body: { ok: false, error: { code: 'claim_taken_over', message: 'lost' } },
          };
        }
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              id: 'cl_1',
              workspaceId: 'ws',
              assetId: 'asset',
              ingestVersion: 1,
              claimantImUserId: 'u',
              claimantDeviceId: 'dev-A',
              status: 'active',
              claimedAt: '2026-05-10T00:00:00Z',
              heartbeatAt: new Date().toISOString(),
              completedAt: null,
            },
          },
        };
      });
      const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A', heartbeatIntervalMs: 100 });
      const onLost = vi.fn();
      ctrl.startHeartbeat('cl_1', { onLost });
      // First tick at 100ms (the 410) — let the microtasks settle so the
      // catch / stop / onLost path runs.
      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(300); // would-be 2nd/3rd/4th tick
      const heartbeatCalls = calls.filter((c) => c.path === '/api/im/ingest/claims/cl_1/heartbeat');
      expect(heartbeatCalls.length).toBe(1);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost).toHaveBeenCalledWith('claim_taken_over');
    } finally {
      vi.useRealTimers();
    }
  });

  it('startHeartbeat returns a Symbol.dispose handle so `using` cleans up', () => {
    const { cloud } = fakeCloud(() => ({
      status: 200,
      body: {
        ok: true,
        data: {
          id: 'cl_1',
          workspaceId: 'ws',
          assetId: 'asset',
          ingestVersion: 1,
          claimantImUserId: 'u',
          claimantDeviceId: 'dev-A',
          status: 'active',
          claimedAt: '2026-05-10T00:00:00Z',
          heartbeatAt: '2026-05-10T00:00:00Z',
          completedAt: null,
        },
      },
    }));
    const ctrl = new ParseClaimController({ cloud, deviceId: 'dev-A', heartbeatIntervalMs: 100 });
    const hb = ctrl.startHeartbeat('cl_1');
    // Either form must release the interval — assert both are present and
    // callable. Calling stop() before any timer tick has the same effect.
    expect(typeof hb.stop).toBe('function');
    expect(typeof hb[Symbol.dispose]).toBe('function');
    hb[Symbol.dispose]();
  });
});

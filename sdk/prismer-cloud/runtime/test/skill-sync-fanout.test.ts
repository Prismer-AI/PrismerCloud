// F16 (2026-05-20) — syncAllAgentSkills helper tests.
//
// Daemon startup + periodic + CLI no-flag paths all call this helper.
// Verifies: bounded concurrency, partial failure isolation, totals
// aggregation across the per-profile SkillSyncResult values.

import { describe, expect, it, vi } from 'vitest';
import { syncAllAgentSkills } from '../src/daemon/skill-sync.js';
import type { AgentProfile } from '../src/adapters/contract.js';
import type { CloudClient } from '../src/auth.js';

function mkProfile(id: string, agentImUserId: string, adapter = 'hermes'): AgentProfile {
  return {
    id,
    workspaceId: 'ws-1',
    agentImUserId,
    adapterName: adapter,
    name: id,
    config: {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mkMockCloud(responder: (path: string) => unknown): CloudClient {
  return {
    get: vi.fn(async (path: string) => responder(path)),
    request: vi.fn(async () => ({ ok: true, data: null, status: 200 })),
  } as unknown as CloudClient;
}

describe('syncAllAgentSkills (F16)', () => {
  it('returns zero totals + empty byProfile for an empty profile list', async () => {
    const cloud = mkMockCloud(() => []);
    const { totals, byProfile } = await syncAllAgentSkills([], cloud);
    expect(totals).toEqual({
      synced: 0,
      skipped: 0,
      unchanged: 0,
      // release201/11 S23 — SkillSyncResult now also returns the per-dispatch
      // skill list; aggregate fan-out leaves it empty (skill.invoked is only
      // emitted in dispatch.ts, not from startup re-sync).
      loadedSkills: [],
      profiles: 0,
      failed: 0,
      // skill backfill aggregate counter (added with the backfill feature);
      // empty profile list → zero.
      backfillFailed: 0,
    });
    expect(byProfile).toEqual([]);
  });

  it('isolates per-profile errors so one bad agent does not poison the batch', async () => {
    const calls: string[] = [];
    const cloud = mkMockCloud((path) => {
      calls.push(path);
      if (path.includes('agent-bad')) throw new Error('cloud 500');
      return []; // empty installed list → SkillSyncResult zero counts
    });
    const profiles = [
      mkProfile('p-good-1', 'agent-good-1'),
      mkProfile('p-bad', 'agent-bad'),
      mkProfile('p-good-2', 'agent-good-2'),
    ];
    const { totals, byProfile } = await syncAllAgentSkills(profiles, cloud, { concurrency: 2 });
    expect(totals.profiles).toBe(3);
    expect(totals.failed).toBe(1);
    expect(byProfile.find((p) => p.profileId === 'p-bad')?.ok).toBe(false);
    expect(byProfile.find((p) => p.profileId === 'p-bad')?.error).toContain('cloud 500');
    expect(byProfile.filter((p) => p.ok).length).toBe(2);
    expect(calls.length).toBe(3);
  });

  it('caps concurrency to the requested value (default 3, max 8)', async () => {
    let active = 0;
    let peak = 0;
    const cloud = mkMockCloud(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 8));
      active--;
      return [];
    });
    const profiles = Array.from({ length: 12 }, (_, i) => mkProfile(`p${i}`, `agent${i}`));
    await syncAllAgentSkills(profiles, cloud, { concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // truly parallel
  });

  it('aborts mid-batch when signal fires', async () => {
    const ctrl = new AbortController();
    let started = 0;
    const cloud = mkMockCloud(async () => {
      started++;
      if (started === 2) ctrl.abort();
      await new Promise((r) => setTimeout(r, 5));
      return [];
    });
    const profiles = Array.from({ length: 10 }, (_, i) => mkProfile(`p${i}`, `agent${i}`));
    const { totals } = await syncAllAgentSkills(profiles, cloud, { concurrency: 1, signal: ctrl.signal });
    // signal aborts the worker loop — remaining profiles never start
    expect(totals.profiles).toBe(10);
    // started count reflects how many were actually attempted; should be < 10
    expect(started).toBeLessThan(10);
  });
});

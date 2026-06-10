/**
 * agent-binding-rebind.test.ts — Wave 2-B2 (v2.0 §4.8.2 R7)
 *
 * Covers `AgentBindingService.rebind` semantics:
 *   - rebind to a different daemon flips ownership + clears contestedSince
 *   - rebind to the SAME daemon is idempotent (clears contestedSince only)
 *   - rebind on a missing binding throws AgentBindingNotFoundError
 *   - inFlightTaskCount is returned so the UI can warn the user
 *   - boundBy='user-explicit' on rebind (vs 'auto-first-declare' on first declare)
 *   - sync event 'agent.binding.rebound' is emitted
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  AgentBindingService,
  AgentBindingNotFoundError,
  type AgentBindingRecord,
} from '../services/agent-binding.service';

const state: { bindings: AgentBindingRecord[] } = { bindings: [] };

function makePrisma(opts: { inFlightTaskCount?: number } = {}): any {
  return {
    iMAgentBinding: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = state.bindings.find((b) => b.agentImUserId === where.agentImUserId);
        // Return a shallow CLONE so updates to the stored row don't retroactively
        // mutate the snapshot the caller already captured. Prisma returns
        // detached plain objects, this mock must mirror that.
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: AgentBindingRecord = {
          ...data,
          lastDispatchAt: null,
          contestedSince: null,
          contestCount: 0,
        };
        state.bindings.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.bindings.find((b) => b.agentImUserId === where.agentImUserId);
        if (!row) throw new Error('not found');
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as any)) {
            (row as any)[k] = ((row as any)[k] ?? 0) + (v as any).increment;
          } else {
            (row as any)[k] = v;
          }
        }
        return row;
      }),
      findMany: vi.fn(async () => state.bindings),
    },
    iMAgentCard: { findMany: vi.fn(async () => []) },
    iMUser: { findMany: vi.fn(async () => []) },
    iMWorkspace: { findFirst: vi.fn(async () => null) },
    iMTask: { count: vi.fn(async () => opts.inFlightTaskCount ?? 0) },
  };
}

function seedExistingBinding(prefill: Partial<AgentBindingRecord> = {}) {
  state.bindings.length = 0;
  state.bindings.push({
    id: 'bnd-1',
    agentImUserId: 'agent-CEO',
    boundDaemonId: 'k8s-pod-OLD',
    boundDaemonKind: 'k8s',
    boundDaemonLabel: 'old K8S pod',
    boundAt: new Date(Date.now() - 60_000),
    boundBy: 'auto-first-declare',
    lastHostDeclareAt: new Date(),
    lastDispatchAt: null,
    contestedSince: new Date(Date.now() - 30_000),
    contestCount: 3,
    ...prefill,
  });
}

describe('AgentBindingService.rebind — explicit user takeover', () => {
  let prisma: any;
  let syncService: { writeEvent: ReturnType<typeof vi.fn> };
  let service: AgentBindingService;

  beforeEach(() => {
    state.bindings.length = 0;
    prisma = makePrisma({ inFlightTaskCount: 2 });
    syncService = { writeEvent: vi.fn(async () => {}) };
    service = new AgentBindingService(prisma, syncService as any);
  });

  it('rebind to a different daemon flips ownership + clears contest marker + records audit', async () => {
    seedExistingBinding();
    const result = await service.rebind({
      agentImUserId: 'agent-CEO',
      targetDaemonId: 'daemon-MacStudio-local',
      targetDaemonKind: 'local',
      targetDaemonLabel: 'Mac Studio',
      actorImUserId: 'human-jason',
      reason: 'jasonzhou moved to local daemon',
    });

    expect(result.previousDaemonId).toBe('k8s-pod-OLD');
    expect(result.binding.boundDaemonId).toBe('daemon-MacStudio-local');
    expect(result.binding.boundDaemonKind).toBe('local');
    expect(result.binding.boundDaemonLabel).toBe('Mac Studio');
    expect(result.binding.boundBy).toBe('user-explicit'); // audit signal
    expect(result.binding.contestedSince).toBeNull(); // contest cleared
    // contestCount NOT zeroed — kept as historical signal
    expect(state.bindings[0].contestCount).toBe(3);
    expect(result.inFlightTaskCount).toBe(2);

    expect(syncService.writeEvent).toHaveBeenCalledOnce();
    const args = syncService.writeEvent.mock.calls[0];
    expect(args[0]).toBe('agent.binding.rebound');
    expect(args[1]).toMatchObject({
      agentImUserId: 'agent-CEO',
      previousDaemonId: 'k8s-pod-OLD',
      newDaemonId: 'daemon-MacStudio-local',
      reason: 'jasonzhou moved to local daemon',
      inFlightTaskCount: 2,
    });
  });

  it('rebind to the SAME daemon clears contestedSince but does not flip (idempotent)', async () => {
    seedExistingBinding();
    const result = await service.rebind({
      agentImUserId: 'agent-CEO',
      targetDaemonId: 'k8s-pod-OLD', // same as existing
      actorImUserId: 'human-jason',
      reason: 'confirming current owner',
    });
    expect(result.previousDaemonId).toBe('k8s-pod-OLD');
    expect(result.binding.boundDaemonId).toBe('k8s-pod-OLD');
    expect(result.binding.boundBy).toBe('user-explicit');
    expect(result.binding.contestedSince).toBeNull();
    expect(result.inFlightTaskCount).toBe(0); // no flip → no in-flight count fetch
  });

  it('rebind on a missing binding throws AgentBindingNotFoundError', async () => {
    state.bindings.length = 0;
    await expect(
      service.rebind({
        agentImUserId: 'agent-nonexistent',
        targetDaemonId: 'daemon-anything',
        actorImUserId: 'human-jason',
        reason: 'should fail',
      }),
    ).rejects.toBeInstanceOf(AgentBindingNotFoundError);
  });

  it('noteDispatch updates lastDispatchAt without failing when binding missing', async () => {
    seedExistingBinding();
    await service.noteDispatch('agent-CEO');
    expect(state.bindings[0].lastDispatchAt).toBeInstanceOf(Date);
    // Non-existent agent: should not throw
    await expect(service.noteDispatch('agent-ghost')).resolves.toBeUndefined();
  });
});

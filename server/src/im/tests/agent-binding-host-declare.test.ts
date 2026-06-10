/**
 * agent-binding-host-declare.test.ts — Wave 2-B2 (v2.0 §4.8.2 R7)
 *
 * Covers the three-branch decision tree of `AgentBindingService.handleHostDeclare`:
 *   1. No binding row → 'created'  + boundBy='auto-first-declare'
 *   2. Same daemonId  → 'refreshed' + lastHostDeclareAt updated
 *   3. Different daemonId + fresh owner → 'contested' + episode count + sync event
 *   4. Different daemonId + stale owner → 'claimed-stale-owner'
 *
 * Plus the jasonzhou-class scenario: two daemons race to host the same agent;
 * the second one is recorded as contested but does NOT win ownership, and
 * the user-facing sync event is emitted.
 *
 * Strategy: in-memory prisma mock that mirrors only IMAgentBinding ops. The
 * sync service is a vi.fn so we can assert the 'agent.binding.contested' call.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  AgentBindingService,
  CONTEST_FRESH_WINDOW_MS,
  STALE_OWNER_CLAIM_AFTER_MS,
  type AgentBindingRecord,
} from '../services/agent-binding.service';

interface MockState {
  bindings: AgentBindingRecord[];
}

const state: MockState = { bindings: [] };

function makePrisma(): any {
  return {
    iMAgentBinding: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = state.bindings.find((b) => b.agentImUserId === where.agentImUserId);
        // Detached snapshot — see agent-binding-rebind.test.ts for rationale
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: AgentBindingRecord = {
          id: data.id,
          agentImUserId: data.agentImUserId,
          boundDaemonId: data.boundDaemonId,
          boundDaemonKind: data.boundDaemonKind,
          boundDaemonLabel: data.boundDaemonLabel,
          boundAt: data.boundAt,
          boundBy: data.boundBy,
          lastHostDeclareAt: data.lastHostDeclareAt,
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
        if (data.contestCount && typeof data.contestCount === 'object' && 'increment' in data.contestCount) {
          row.contestCount += data.contestCount.increment;
        } else if (typeof data.contestCount === 'number') {
          row.contestCount = data.contestCount;
        }
        if (data.lastHostDeclareAt) row.lastHostDeclareAt = data.lastHostDeclareAt;
        if (data.contestedSince !== undefined) row.contestedSince = data.contestedSince;
        if (data.boundBy) row.boundBy = data.boundBy;
        if (data.boundAt) row.boundAt = data.boundAt;
        if (data.boundDaemonId) row.boundDaemonId = data.boundDaemonId;
        if (data.boundDaemonKind) row.boundDaemonKind = data.boundDaemonKind;
        if (data.boundDaemonLabel) row.boundDaemonLabel = data.boundDaemonLabel;
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = state.bindings.find((b) => b.agentImUserId === where.agentImUserId);
        if (!row) return { count: 0 };
        if (where.boundDaemonId && row.boundDaemonId !== where.boundDaemonId) return { count: 0 };
        const lte = where.lastHostDeclareAt?.lte;
        if (lte instanceof Date && row.lastHostDeclareAt > lte) return { count: 0 };
        if (where.contestedSince?.not === null && row.contestedSince === null) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          (row as any)[key] = value;
        }
        return { count: 1 };
      }),
      findMany: vi.fn(async () => state.bindings),
    },
    iMAgentCard: { findMany: vi.fn(async () => []) },
    iMUser: { findMany: vi.fn(async () => []) },
    iMWorkspace: { findFirst: vi.fn(async () => null) },
    iMTask: { count: vi.fn(async () => 0) },
  };
}

describe('AgentBindingService.handleHostDeclare — three-branch decision', () => {
  let prisma: any;
  let syncService: { writeEvent: ReturnType<typeof vi.fn> };
  let service: AgentBindingService;

  beforeEach(() => {
    state.bindings.length = 0;
    prisma = makePrisma();
    syncService = { writeEvent: vi.fn(async () => {}) };
    service = new AgentBindingService(prisma, syncService as any);
  });

  it('1. First declare for an agent creates a binding row with boundBy=auto-first-declare', async () => {
    const decision = await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-MacStudio-local-abc',
      daemonKind: 'local',
      daemonLabel: 'Mac Studio',
      ownerImUserId: 'human-jason',
    });
    expect(decision.outcome).toBe('created');
    expect(decision.ownerDaemonId).toBe('daemon-MacStudio-local-abc');
    expect(decision.contestCount).toBe(0);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].boundBy).toBe('auto-first-declare');
    expect(state.bindings[0].boundDaemonId).toBe('daemon-MacStudio-local-abc');
    expect(syncService.writeEvent).not.toHaveBeenCalled();
  });

  it('2. Same daemon re-declaring refreshes lastHostDeclareAt without emitting contest', async () => {
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-MacStudio-local-abc',
      daemonKind: 'local',
      daemonLabel: 'Mac Studio',
      ownerImUserId: 'human-jason',
    });
    const firstDeclareAt = state.bindings[0].lastHostDeclareAt;
    await new Promise((r) => setTimeout(r, 5));
    const decision = await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-MacStudio-local-abc',
      daemonKind: 'local',
      daemonLabel: 'Mac Studio',
      ownerImUserId: 'human-jason',
    });
    expect(decision.outcome).toBe('refreshed');
    expect(decision.contestCount).toBe(0);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].lastHostDeclareAt.getTime()).toBeGreaterThan(firstDeclareAt.getTime());
    expect(syncService.writeEvent).not.toHaveBeenCalled();
  });

  it('3. Different daemon marks contested + emits sync event; ownership UNCHANGED', async () => {
    // Mac Studio gets the agent first (auto-first-declare)
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-MacStudio-local-abc',
      daemonKind: 'local',
      daemonLabel: 'Mac Studio',
      ownerImUserId: 'human-jason',
    });
    // Now K8S pod tries to claim the same agent — jasonzhou-class scenario
    const contestDecision = await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'k8s-pod-12ba3054',
      daemonKind: 'k8s',
      daemonLabel: 'prismer-agent-rt-pe31wzn',
      ownerImUserId: 'human-jason',
    });
    expect(contestDecision.outcome).toBe('contested');
    // Critical assertion: ownership stays with the original owner — Mac Studio
    expect(contestDecision.ownerDaemonId).toBe('daemon-MacStudio-local-abc');
    expect(contestDecision.contestCount).toBe(1);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].boundDaemonId).toBe('daemon-MacStudio-local-abc');
    expect(state.bindings[0].contestedSince).not.toBeNull();
    expect(state.bindings[0].contestCount).toBe(1);

    // Sync event must be emitted with the right shape so the UI can render
    expect(syncService.writeEvent).toHaveBeenCalledOnce();
    const args = syncService.writeEvent.mock.calls[0];
    expect(args[0]).toBe('agent.binding.contested');
    expect(args[1]).toMatchObject({
      agentImUserId: 'agent-CEO',
      currentOwner: { daemonId: 'daemon-MacStudio-local-abc' },
      contender: { daemonId: 'k8s-pod-12ba3054', kind: 'k8s' },
      contestCount: 1,
    });
    expect(args[3]).toBe('human-jason'); // imUserId — routes event to user UI
  });

  it('4. Fresh repeated contests refresh contestedSince without incrementing the episode count', async () => {
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-A',
      daemonKind: 'local',
      daemonLabel: 'A',
      ownerImUserId: 'human-jason',
    });
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-B',
      daemonKind: 'k8s',
      daemonLabel: 'B',
      ownerImUserId: 'human-jason',
    });
    const firstContestedSince = state.bindings[0].contestedSince;
    expect(state.bindings[0].contestCount).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-B',
      daemonKind: 'k8s',
      daemonLabel: 'B',
      ownerImUserId: 'human-jason',
    });
    expect(state.bindings[0].contestCount).toBe(1);
    expect(state.bindings[0].contestedSince!.getTime()).toBeGreaterThan(firstContestedSince!.getTime());
    expect(syncService.writeEvent).toHaveBeenCalledTimes(1);
  });

  it('4b. Stale contest window starts a new episode and emits one new sync event', async () => {
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-A',
      daemonKind: 'local',
      daemonLabel: 'A',
      ownerImUserId: 'human-jason',
    });
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-B',
      daemonKind: 'k8s',
      daemonLabel: 'B',
      ownerImUserId: 'human-jason',
    });
    state.bindings[0].contestedSince = new Date(Date.now() - CONTEST_FRESH_WINDOW_MS - 1_000);
    const staleContestedSince = state.bindings[0].contestedSince;
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-B',
      daemonKind: 'k8s',
      daemonLabel: 'B',
      ownerImUserId: 'human-jason',
    });

    expect(state.bindings[0].contestCount).toBe(2);
    expect(state.bindings[0].contestedSince!.getTime()).toBeGreaterThan(staleContestedSince.getTime());
    expect(syncService.writeEvent).toHaveBeenCalledTimes(2);
  });

  it('4c. Different daemon auto-claims when the current owner has stopped declaring', async () => {
    await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-A',
      daemonKind: 'local',
      daemonLabel: 'A',
      ownerImUserId: 'human-jason',
    });
    state.bindings[0].lastHostDeclareAt = new Date(Date.now() - STALE_OWNER_CLAIM_AFTER_MS - 1_000);
    state.bindings[0].contestedSince = new Date(Date.now() - CONTEST_FRESH_WINDOW_MS - 1_000);
    state.bindings[0].contestCount = 7;

    const decision = await service.handleHostDeclare({
      agentImUserId: 'agent-CEO',
      daemonId: 'daemon-B',
      daemonKind: 'k8s',
      daemonLabel: 'B',
      ownerImUserId: 'human-jason',
    });

    expect(decision.outcome).toBe('claimed-stale-owner');
    expect(decision.ownerDaemonId).toBe('daemon-B');
    expect(decision.contestCount).toBe(7);
    expect(state.bindings[0]).toMatchObject({
      boundDaemonId: 'daemon-B',
      boundDaemonKind: 'k8s',
      boundDaemonLabel: 'B',
      boundBy: 'cloud-rebalance',
      contestedSince: null,
      contestCount: 7,
    });
    expect(syncService.writeEvent).toHaveBeenCalledOnce();
    expect(syncService.writeEvent.mock.calls[0][0]).toBe('agent.binding.rebound');
    expect(syncService.writeEvent.mock.calls[0][1]).toMatchObject({
      previousDaemonId: 'daemon-A',
      newDaemonId: 'daemon-B',
      reason: 'stale-owner-auto-claim',
    });
  });

  it('4d. listByWorkspace actively clears stale contest markers before returning DTO state', async () => {
    state.bindings.push({
      id: 'bnd-1',
      agentImUserId: 'agent-CEO',
      boundDaemonId: 'daemon-A',
      boundDaemonKind: 'local',
      boundDaemonLabel: 'A',
      boundAt: new Date(),
      boundBy: 'auto-first-declare',
      lastHostDeclareAt: new Date(),
      lastDispatchAt: null,
      contestedSince: new Date(Date.now() - CONTEST_FRESH_WINDOW_MS - 1_000),
      contestCount: 2,
    });
    prisma.iMAgentCard.findMany.mockResolvedValue([{ imUserId: 'agent-CEO', name: 'CEO' }]);

    const rows = await service.listByWorkspace('ws-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].contested).toBe(false);
    expect(rows[0].binding.contestedSince).toBeNull();
    expect(state.bindings[0].contestedSince).toBeNull();
  });

  it('4e. clearContestMarker clears active UI state and emits contestCleared after a rejected daemon confirms release', async () => {
    state.bindings.push({
      id: 'bnd-1',
      agentImUserId: 'agent-CEO',
      boundDaemonId: 'daemon-A',
      boundDaemonKind: 'local',
      boundDaemonLabel: 'A',
      boundAt: new Date(),
      boundBy: 'auto-first-declare',
      lastHostDeclareAt: new Date(),
      lastDispatchAt: null,
      contestedSince: new Date(),
      contestCount: 1,
    });

    await service.clearContestMarker('agent-CEO', 'human-jason', 'rejected-daemon-redeclare');

    expect(state.bindings[0].contestedSince).toBeNull();
    expect(state.bindings[0].contestCount).toBe(1);
    expect(syncService.writeEvent).toHaveBeenCalledOnce();
    expect(syncService.writeEvent.mock.calls[0][0]).toBe('agent.binding.contestCleared');
    expect(syncService.writeEvent.mock.calls[0][1]).toMatchObject({
      agentImUserId: 'agent-CEO',
      reason: 'rejected-daemon-redeclare',
    });
    expect(syncService.writeEvent.mock.calls[0][3]).toBe('human-jason');
  });

  it('5. jasonzhou scenario: 6 agents, 2 daemons race; ownership splits but no agent is silently dropped', async () => {
    const agents = ['CEO', 'COO', 'CFO', 'roleA', 'roleB', 'roleC'];
    // Daemon A wins the first 3 (race order in real handler)
    for (const a of agents.slice(0, 3)) {
      await service.handleHostDeclare({
        agentImUserId: `agent-${a}`,
        daemonId: 'daemon-MacStudio',
        daemonKind: 'local',
        daemonLabel: 'Mac Studio',
        ownerImUserId: 'human-jason',
      });
    }
    // Daemon B wins the second 3
    for (const a of agents.slice(3)) {
      await service.handleHostDeclare({
        agentImUserId: `agent-${a}`,
        daemonId: 'k8s-pod-12ba3054',
        daemonKind: 'k8s',
        daemonLabel: 'prismer-agent-rt',
        ownerImUserId: 'human-jason',
      });
    }
    // Now both daemons re-declare all 6 agents (host.declare heartbeat)
    const allMacDecisions = await Promise.all(
      agents.map((a) =>
        service.handleHostDeclare({
          agentImUserId: `agent-${a}`,
          daemonId: 'daemon-MacStudio',
          daemonKind: 'local',
          daemonLabel: 'Mac Studio',
          ownerImUserId: 'human-jason',
        }),
      ),
    );
    const allK8sDecisions = await Promise.all(
      agents.map((a) =>
        service.handleHostDeclare({
          agentImUserId: `agent-${a}`,
          daemonId: 'k8s-pod-12ba3054',
          daemonKind: 'k8s',
          daemonLabel: 'prismer-agent-rt',
          ownerImUserId: 'human-jason',
        }),
      ),
    );

    // Mac Studio's bound agents → 'refreshed', the other 3 → 'contested'
    const macRefreshed = allMacDecisions.filter((d) => d.outcome === 'refreshed').length;
    const macContested = allMacDecisions.filter((d) => d.outcome === 'contested').length;
    expect(macRefreshed).toBe(3);
    expect(macContested).toBe(3);

    const k8sRefreshed = allK8sDecisions.filter((d) => d.outcome === 'refreshed').length;
    const k8sContested = allK8sDecisions.filter((d) => d.outcome === 'contested').length;
    expect(k8sRefreshed).toBe(3);
    expect(k8sContested).toBe(3);

    // Crucial: ZERO 'silent reject'. Every agent has a row. Compare to the
    // pre-fix behavior where 3 agents per daemon were silently dropped.
    expect(state.bindings).toHaveLength(6);
    expect(state.bindings.every((b) => b.boundDaemonId.length > 0)).toBe(true);

    // Each contested row has contestCount >= 1 and contestedSince set
    const contested = state.bindings.filter((b) => b.contestedSince != null);
    expect(contested.length).toBe(6); // every agent had at least 1 contest in the heartbeat round
    expect(contested.every((b) => b.contestCount >= 1)).toBe(true);

    // 6 contested events emitted (one per contested decision the heartbeat round)
    // = 3 mac-contended + 3 k8s-contended = 6
    expect(syncService.writeEvent).toHaveBeenCalledTimes(6);
  });
});

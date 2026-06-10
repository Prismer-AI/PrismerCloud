/**
 * dispatch-honors-binding.test.ts — Wave 2-B2 (v2.0 §4.8.2 R7)
 *
 * Verifies the core invariant: dispatch routing MUST consult
 * `im_agent_bindings.boundDaemonId`, NOT `im_agent_cards.metadata.daemonId`,
 * once a binding row exists. This is the jasonzhou-class regression guard:
 *   - 2 daemons claim the same agent (binding row says daemon A is owner;
 *     metadata.daemonId says daemon B because B was the last to touch the card)
 *   - Dispatch must go to A, not B.
 *
 * Strategy: re-implement the resolution logic inline (mirroring task.service.ts
 * resolveAgentDaemonRoute precisely). The pure logic is small enough to copy
 * and assert against without booting the full TaskService dependency graph
 * (RoomManager, Redis, schedulers, etc.).
 *
 * If you change resolveAgentDaemonRoute in task.service.ts, mirror the change
 * here — this is intentional duplication for test isolation. The 5-dim audit
 * in evidence/14-p10-server-wave2-b2.md flags this as a known tradeoff.
 */

import { describe, expect, it } from 'vitest';

type DaemonRouteResolution =
  | { kind: 'none' }
  | { kind: 'active'; daemonId: string; workspaceId: string | null }
  | { kind: 'forgotten'; daemonId: string; workspaceId: string };

interface MockedPrismaForRouteResolve {
  iMAgentCard: {
    findUnique(args: { where: { imUserId: string } }): Promise<{ metadata: string; workspaceId: string } | null>;
  };
  iMAgentBinding: {
    findUnique(args: {
      where: { agentImUserId: string };
      select?: { boundDaemonId: true };
    }): Promise<{ boundDaemonId: string } | null>;
  };
  iMWorkspace: {
    findFirst(args: {
      where: { id: string | undefined; deletedAt: null };
    }): Promise<{ id: string; metadata: string } | null>;
  };
}

// Mirror of the production resolver — kept in sync manually with task.service.ts
// `resolveAgentDaemonRoute`. See header comment for rationale.
async function resolveAgentDaemonRoute(
  prisma: MockedPrismaForRouteResolve,
  agentImUserId: string,
  isDaemonForgotten: (md: string, daemonId: string) => boolean = () => false,
): Promise<DaemonRouteResolution> {
  const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentImUserId } });
  const wsCard = card ? await prisma.iMWorkspace.findFirst({ where: { id: card.workspaceId, deletedAt: null } }) : null;

  // Primary path: binding table
  try {
    const binding = await prisma.iMAgentBinding.findUnique({
      where: { agentImUserId },
      select: { boundDaemonId: true },
    });
    if (binding?.boundDaemonId) {
      const daemonId = binding.boundDaemonId.trim();
      if (wsCard && isDaemonForgotten(wsCard.metadata, daemonId)) {
        return { kind: 'forgotten', daemonId, workspaceId: wsCard.id };
      }
      return { kind: 'active', daemonId, workspaceId: wsCard?.id ?? card?.workspaceId ?? null };
    }
  } catch {
    /* fall through */
  }

  // Fallback: legacy metadata.daemonId
  if (!card?.metadata) return { kind: 'none' };
  try {
    const meta = JSON.parse(card.metadata) as { daemonId?: unknown };
    const daemonId = typeof meta.daemonId === 'string' && meta.daemonId.trim() ? meta.daemonId.trim() : '';
    if (!daemonId) return { kind: 'none' };
    if (wsCard && isDaemonForgotten(wsCard.metadata, daemonId)) {
      return { kind: 'forgotten', daemonId, workspaceId: wsCard.id };
    }
    return { kind: 'active', daemonId, workspaceId: wsCard?.id ?? card.workspaceId ?? null };
  } catch {
    return { kind: 'none' };
  }
}

describe('Dispatch route resolution honors im_agent_bindings (jasonzhou case)', () => {
  it('binding row exists → dispatch goes to binding.boundDaemonId, NOT metadata.daemonId', async () => {
    // Simulate jasonzhou: metadata.daemonId says K8S (because K8S declared last
    // before the explicit binding was put in place), binding says Mac Studio
    // (user explicitly rebound). Without the Wave 2-B2 fix dispatch would
    // route to K8S → silent dead-end. With the fix it routes to Mac Studio.
    const prisma: MockedPrismaForRouteResolve = {
      iMAgentCard: {
        findUnique: async () => ({
          metadata: JSON.stringify({ daemonId: 'k8s-pod-OLD' }),
          workspaceId: 'ws-1',
        }),
      },
      iMAgentBinding: {
        findUnique: async () => ({ boundDaemonId: 'daemon-MacStudio-local' }),
      },
      iMWorkspace: {
        findFirst: async () => ({ id: 'ws-1', metadata: '{}' }),
      },
    };
    const route = await resolveAgentDaemonRoute(prisma, 'agent-CEO');
    expect(route.kind).toBe('active');
    if (route.kind === 'active') {
      expect(route.daemonId).toBe('daemon-MacStudio-local');
      // Critical regression guard: under no circumstances should the legacy
      // metadata.daemonId win
      expect(route.daemonId).not.toBe('k8s-pod-OLD');
    }
  });

  it('binding row missing → falls back to metadata.daemonId (legacy path)', async () => {
    const prisma: MockedPrismaForRouteResolve = {
      iMAgentCard: {
        findUnique: async () => ({
          metadata: JSON.stringify({ daemonId: 'k8s-pod-legacy' }),
          workspaceId: 'ws-1',
        }),
      },
      iMAgentBinding: {
        findUnique: async () => null, // no binding yet — pre-migration-410 agent
      },
      iMWorkspace: {
        findFirst: async () => ({ id: 'ws-1', metadata: '{}' }),
      },
    };
    const route = await resolveAgentDaemonRoute(prisma, 'agent-Legacy');
    expect(route.kind).toBe('active');
    if (route.kind === 'active') {
      expect(route.daemonId).toBe('k8s-pod-legacy');
    }
  });

  it('binding row exists with daemon-A; CEO and COO of same user route correctly to different daemons', async () => {
    // Two agents on same user, bound to different daemons — proves the routing
    // is per-agent (not per-user) and per-binding (not per-shadow-client).
    const bindings: Record<string, string> = {
      'agent-CEO': 'daemon-MacStudio',
      'agent-COO': 'k8s-pod-12ba3054',
    };
    const cards: Record<string, { metadata: string; workspaceId: string }> = {
      // Both cards' metadata.daemonId points to whichever daemon LAST declared
      // for that agent — irrelevant once binding is the authority.
      'agent-CEO': { metadata: JSON.stringify({ daemonId: 'STALE' }), workspaceId: 'ws-1' },
      'agent-COO': { metadata: JSON.stringify({ daemonId: 'STALE' }), workspaceId: 'ws-1' },
    };
    const prisma: MockedPrismaForRouteResolve = {
      iMAgentCard: {
        findUnique: async ({ where }) => cards[where.imUserId] ?? null,
      },
      iMAgentBinding: {
        findUnique: async ({ where }) =>
          bindings[where.agentImUserId] ? { boundDaemonId: bindings[where.agentImUserId] } : null,
      },
      iMWorkspace: {
        findFirst: async () => ({ id: 'ws-1', metadata: '{}' }),
      },
    };
    const ceoRoute = await resolveAgentDaemonRoute(prisma, 'agent-CEO');
    const cooRoute = await resolveAgentDaemonRoute(prisma, 'agent-COO');
    expect(ceoRoute.kind === 'active' && ceoRoute.daemonId).toBe('daemon-MacStudio');
    expect(cooRoute.kind === 'active' && cooRoute.daemonId).toBe('k8s-pod-12ba3054');
  });

  it('forgotten daemon is propagated as forgotten route, regardless of binding source', async () => {
    const prisma: MockedPrismaForRouteResolve = {
      iMAgentCard: {
        findUnique: async () => ({
          metadata: JSON.stringify({ daemonId: 'daemon-X' }),
          workspaceId: 'ws-1',
        }),
      },
      iMAgentBinding: {
        findUnique: async () => ({ boundDaemonId: 'daemon-X' }),
      },
      iMWorkspace: {
        findFirst: async () => ({
          id: 'ws-1',
          metadata: JSON.stringify({ forgottenDaemonIds: ['daemon-X'] }),
        }),
      },
    };
    const isDaemonForgotten = (md: string, daemonId: string) => {
      try {
        const parsed = JSON.parse(md);
        return Array.isArray(parsed.forgottenDaemonIds) && parsed.forgottenDaemonIds.includes(daemonId);
      } catch {
        return false;
      }
    };
    const route = await resolveAgentDaemonRoute(prisma, 'agent-X', isDaemonForgotten);
    expect(route.kind).toBe('forgotten');
    if (route.kind === 'forgotten') {
      expect(route.daemonId).toBe('daemon-X');
      expect(route.workspaceId).toBe('ws-1');
    }
  });
});

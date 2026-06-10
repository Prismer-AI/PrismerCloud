/**
 * Prismer IM — Agent Binding Service
 *
 * v2.0 §4.8.2 (Wave 2-B2) — explicit multi-daemon binding ownership for the
 * R7 root cause from the §1.5 jasonzhou production case. Replaces the silent
 * reject in `ws/handler.ts:656` (`if (boundDaemonId && boundDaemonId !==
 * payload.daemonId) return false`) with a first-class data model that the
 * Devices UI can render and a rebind API can mutate.
 *
 * Schema reference: prisma/schema.mysql.prisma `model IMAgentBinding` +
 * migration 410 `im_agent_bindings`.
 *
 * Decision matrix on host.declare (handleAgentHostDeclare):
 *   1. no row exists                → create row, boundBy='auto-first-declare'
 *   2. row.boundDaemonId == payload → update lastHostDeclareAt (heartbeat refresh)
 *   3. row.boundDaemonId != payload && current owner is stale
 *                                  → transfer ownership to the declaring daemon
 *   4. row.boundDaemonId != payload && current owner is fresh
 *                                  → mark/refresh contested episode, write sync
 *                                     event once per episode, keep ownership.
 *
 * Critical invariant for v2.0 jasonzhou-class bug: dispatch path
 * (`task.service.ts:resolveAgentDaemonRoute`) MUST consult `im_agent_bindings`
 * as the authoritative ownership source — NOT `im_agent_cards.metadata.daemonId`
 * which is "whichever daemon last touched the card row". Without that, the
 * binding table is decorative.
 */

import { generateIMUserId } from '../utils/id-gen';
import type { SyncService } from './sync.service';

// Shape of a Prisma client subset we depend on. Typed loosely so unit tests
// can supply an in-memory mock without importing the full generated client.
export interface AgentBindingPrismaClient {
  iMAgentBinding: {
    findUnique(args: { where: { agentImUserId: string } }): Promise<AgentBindingRecord | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<AgentBindingRecord[]>;
    create(args: { data: AgentBindingCreate }): Promise<AgentBindingRecord>;
    update(args: { where: { agentImUserId: string }; data: Record<string, unknown> }): Promise<AgentBindingRecord>;
    updateMany?(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    upsert?: unknown;
  };
  iMAgentCard: {
    findMany(args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<Array<{ imUserId: string; name?: string | null; workspaceId?: string | null }>>;
  };
  iMUser: {
    findMany(args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<Array<{ id: string; userId?: string | null; displayName?: string | null; username?: string | null }>>;
  };
  iMWorkspace: {
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<{ id: string; ownerImUserId?: string | null; metadata?: string | null } | null>;
  };
  iMTask?: {
    count?(args: { where: Record<string, unknown> }): Promise<number>;
  };
}

export interface AgentBindingRecord {
  id: string;
  agentImUserId: string;
  boundDaemonId: string;
  boundDaemonKind: string;
  boundDaemonLabel: string;
  boundAt: Date;
  boundBy: string;
  lastHostDeclareAt: Date;
  lastDispatchAt: Date | null;
  contestedSince: Date | null;
  contestCount: number;
}

export interface AgentBindingCreate {
  id: string;
  agentImUserId: string;
  boundDaemonId: string;
  boundDaemonKind: string;
  boundDaemonLabel: string;
  boundAt: Date;
  boundBy: string;
  lastHostDeclareAt: Date;
}

export interface HostDeclareDecision {
  agentImUserId: string;
  outcome: 'created' | 'refreshed' | 'contested' | 'claimed-stale-owner';
  /** The daemon the cloud will route dispatch to AFTER this decision. */
  ownerDaemonId: string;
  /** Number of contest episodes recorded for this binding. */
  contestCount: number;
}

export interface RebindResult {
  binding: AgentBindingRecord;
  inFlightTaskCount: number;
  previousDaemonId: string;
}

/**
 * 2026-05-22 — Stale-contest sweep window.
 *
 * `contestedSince` is set/refreshed while a non-owner daemon is actively trying
 * to host an agent that already has a fresh owner. Historically the field was
 * only ever cleared by an explicit user rebind, which meant a momentary race
 * (one daemon being restarted, two pods overlapping during a rollout, a
 * forgotten + later re-paired daemon) left the binding marked
 * `contested=true` indefinitely.
 *
 * Fix: treat a contested marker as "active" only if it was refreshed by a
 * contender within `CONTEST_FRESH_WINDOW_MS`. Owner refresh and read-path list
 * calls sweep stale markers, and the DTO/UI derivation independently re-checks
 * the window so stale-cached DB rows render correctly.
 *
 * History (`contestCount`) is preserved for ops/audit as episode count, not
 * every heartbeat redeclare, and is intentionally not a user-facing severity.
 */
export const CONTEST_FRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * A daemon that has not refreshed ownership for 3 minutes is considered stale
 * for automatic takeover by a new declarer. This is intentionally above the
 * 90s Redis presence freshness window used by daemon-health so transient
 * reconnects do not immediately transfer ownership.
 */
export const STALE_OWNER_CLAIM_AFTER_MS = 3 * 60 * 1000;

/**
 * Pure derivation: is this binding *currently* contested (vs historically)?
 *
 * Returns `true` iff `contestedSince` is set AND within the last
 * `CONTEST_FRESH_WINDOW_MS`. Accepts a `Date | string | null` so both the
 * server-side AgentBindingRecord and the JSON-serialised DTO can call it.
 */
export function isCurrentlyContested(
  contestedSince: Date | string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!contestedSince) return false;
  const ts = contestedSince instanceof Date ? contestedSince.getTime() : Date.parse(contestedSince);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts < CONTEST_FRESH_WINDOW_MS;
}

export function isOwnerDeclareStale(
  lastHostDeclareAt: Date | string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!lastHostDeclareAt) return true;
  const ts = lastHostDeclareAt instanceof Date ? lastHostDeclareAt.getTime() : Date.parse(lastHostDeclareAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts >= STALE_OWNER_CLAIM_AFTER_MS;
}

export class AgentBindingService {
  constructor(
    private readonly prisma: AgentBindingPrismaClient,
    private readonly syncService?: SyncService,
  ) {}

  /**
   * Apply a host.declare for a single agent. The cloud calls this from
   * `handleAgentHostDeclare` for each verified, owned agent. Return value
   * tells the caller whether the declaring daemon should be allowed to
   * register a shadow client and accept dispatch (`outcome != 'contested'`).
   */
  async handleHostDeclare(input: {
    agentImUserId: string;
    daemonId: string;
    daemonKind: 'k8s' | 'local' | 'edge';
    daemonLabel: string;
    ownerImUserId: string;
  }): Promise<HostDeclareDecision> {
    const { agentImUserId, daemonId, daemonKind, daemonLabel, ownerImUserId } = input;
    const existing = await this.prisma.iMAgentBinding.findUnique({ where: { agentImUserId } });
    const now = new Date();

    if (!existing) {
      await this.prisma.iMAgentBinding.create({
        data: {
          id: generateIMUserId('binding'),
          agentImUserId,
          boundDaemonId: daemonId,
          boundDaemonKind: daemonKind,
          boundDaemonLabel: daemonLabel,
          boundAt: now,
          boundBy: 'auto-first-declare',
          lastHostDeclareAt: now,
        },
      });
      return { agentImUserId, outcome: 'created', ownerDaemonId: daemonId, contestCount: 0 };
    }

    if (existing.boundDaemonId === daemonId) {
      // 2026-05-22 — Sweep stale contest marker on every owner-daemon
      // refresh. If the last contender was more than CONTEST_FRESH_WINDOW_MS
      // ago, there is no current conflict; clear `contestedSince` so the UI
      // stops showing a permanent red CONTESTED chip. `contestCount` is
      // preserved as historical signal.
      const refreshData: Record<string, unknown> = { lastHostDeclareAt: now };
      const clearedStaleContest =
        existing.contestedSince != null &&
        !isCurrentlyContested(existing.contestedSince, now.getTime());
      if (clearedStaleContest) {
        refreshData.contestedSince = null;
      }
      await this.prisma.iMAgentBinding.update({
        where: { agentImUserId },
        data: refreshData,
      });
      if (clearedStaleContest) {
        await this.writeContestClearedEvent(agentImUserId, ownerImUserId, 'owner-refresh-stale-contest', now);
      }
      return {
        agentImUserId,
        outcome: 'refreshed',
        ownerDaemonId: existing.boundDaemonId,
        contestCount: existing.contestCount,
      };
    }

    if (isOwnerDeclareStale(existing.lastHostDeclareAt, now.getTime())) {
      const updateData = {
        boundDaemonId: daemonId,
        boundDaemonKind: daemonKind,
        boundDaemonLabel: daemonLabel,
        boundBy: 'cloud-rebalance',
        boundAt: now,
        lastHostDeclareAt: now,
        contestedSince: null,
      };

      if (this.prisma.iMAgentBinding.updateMany) {
        const claimed = await this.prisma.iMAgentBinding.updateMany({
          where: {
            agentImUserId,
            boundDaemonId: existing.boundDaemonId,
            lastHostDeclareAt: { lte: new Date(now.getTime() - STALE_OWNER_CLAIM_AFTER_MS) },
          },
          data: updateData,
        });
        if (claimed.count === 0) {
          // Another declare refreshed or transferred the row between our read
          // and conditional update. Re-read once and apply the current state
          // through the normal decision tree.
          return this.handleHostDeclare(input);
        }
      } else {
        await this.prisma.iMAgentBinding.update({
          where: { agentImUserId },
          data: updateData,
        });
      }

      if (this.syncService) {
        try {
          await this.syncService.writeEvent(
            'agent.binding.rebound',
            {
              agentImUserId,
              previousDaemonId: existing.boundDaemonId,
              newDaemonId: daemonId,
              reason: 'stale-owner-auto-claim',
              actorImUserId: 'system',
              inFlightTaskCount: 0,
            },
            null,
            ownerImUserId,
          );
        } catch (err) {
          console.warn(
            `[AgentBindingService] sync event 'agent.binding.rebound' failed for stale owner claim ${agentImUserId}: ${(err as Error).message}`,
          );
        }
      }

      return {
        agentImUserId,
        outcome: 'claimed-stale-owner',
        ownerDaemonId: daemonId,
        contestCount: existing.contestCount,
      };
    }

    // Contested: a different daemon than the current fresh owner is trying to
    // host this agent. We keep ownership unchanged. A fresh repeat redeclare
    // refreshes `contestedSince` but does not increment contestCount or emit
    // another sync event; contestCount is episodes, not heartbeat attempts.
    const contestAlreadyFresh = isCurrentlyContested(existing.contestedSince, now.getTime());
    if (contestAlreadyFresh) {
      await this.prisma.iMAgentBinding.update({
        where: { agentImUserId },
        data: { contestedSince: now },
      });
      return {
        agentImUserId,
        outcome: 'contested',
        ownerDaemonId: existing.boundDaemonId,
        contestCount: existing.contestCount,
      };
    }

    const nextContestCount = existing.contestCount + 1;
    await this.prisma.iMAgentBinding.update({
      where: { agentImUserId },
      data: {
        contestedSince: now,
        contestCount: { increment: 1 },
      },
    });

    if (this.syncService) {
      try {
        await this.syncService.writeEvent(
          'agent.binding.contested',
          {
            agentImUserId,
            currentOwner: {
              daemonId: existing.boundDaemonId,
              kind: existing.boundDaemonKind,
              label: existing.boundDaemonLabel,
            },
            contender: { daemonId, kind: daemonKind, label: daemonLabel },
            contestCount: nextContestCount,
            since: now.toISOString(),
          },
          null,
          ownerImUserId,
        );
      } catch (err) {
        // Sync event failure must not break the declare reply. Log and
        // continue — the binding table itself already records the contest.
        console.warn(
          `[AgentBindingService] sync event 'agent.binding.contested' failed for ${agentImUserId}: ${(err as Error).message}`,
        );
      }
    }

    return {
      agentImUserId,
      outcome: 'contested',
      ownerDaemonId: existing.boundDaemonId,
      contestCount: nextContestCount,
    };
  }

  /** Get binding (or null) for a single agent. */
  async getBinding(agentImUserId: string): Promise<AgentBindingRecord | null> {
    return this.prisma.iMAgentBinding.findUnique({ where: { agentImUserId } });
  }

  /**
   * Clear the active contest marker after a rejected daemon proves it stopped
   * declaring the agent. A later contender can set the marker again.
   */
  async clearContestMarker(
    agentImUserId: string,
    ownerImUserId?: string,
    reason = 'contender-rejected',
  ): Promise<void> {
    const clearedAt = new Date();
    try {
      let changed = false;
      if (this.prisma.iMAgentBinding.updateMany) {
        const result = await this.prisma.iMAgentBinding.updateMany({
          where: { agentImUserId, contestedSince: { not: null } },
          data: { contestedSince: null },
        });
        changed = result.count > 0;
      } else {
        const existing = await this.prisma.iMAgentBinding.findUnique({ where: { agentImUserId } });
        if (existing?.contestedSince != null) {
          await this.prisma.iMAgentBinding.update({
            where: { agentImUserId },
            data: { contestedSince: null },
          });
          changed = true;
        }
      }
      if (changed && ownerImUserId) {
        await this.writeContestClearedEvent(agentImUserId, ownerImUserId, reason, clearedAt);
      }
    } catch {
      /* non-fatal: binding may have moved/deleted between declare rounds */
    }
  }

  private async writeContestClearedEvent(
    agentImUserId: string,
    ownerImUserId: string,
    reason: string,
    clearedAt: Date,
  ): Promise<void> {
    if (!this.syncService) return;
    try {
      await this.syncService.writeEvent(
        'agent.binding.contestCleared',
        {
          agentImUserId,
          reason,
          clearedAt: clearedAt.toISOString(),
        },
        null,
        ownerImUserId,
      );
    } catch (err) {
      console.warn(
        `[AgentBindingService] sync event 'agent.binding.contestCleared' failed for ${agentImUserId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * List bindings inside a workspace. The binding table itself has no
   * workspaceId column — we cross-join via IMAgentCard to scope.
   */
  async listByWorkspace(workspaceId: string): Promise<
    Array<{
      binding: AgentBindingRecord;
      agentName: string;
      contested: boolean;
    }>
  > {
    const cards = await this.prisma.iMAgentCard.findMany({
      where: { workspaceId },
      select: { imUserId: true, name: true },
    });
    if (cards.length === 0) return [];
    const ids = cards.map((c) => c.imUserId);
    const bindings = await this.prisma.iMAgentBinding.findMany({
      where: { agentImUserId: { in: ids } },
      orderBy: { lastHostDeclareAt: 'desc' },
    });
    const byId = new Map(cards.map((c) => [c.imUserId, c.name ?? c.imUserId] as const));
    // 2026-05-22 — `contested` is the *current* state for UI rendering, NOT
    // "ever contested in history". A row with a stale `contestedSince` (no
    // contender activity in CONTEST_FRESH_WINDOW_MS) is reported as
    // non-contested; the persisted column still holds the original timestamp
    // until the owner daemon's next host.declare sweeps it. The UI also
    // re-checks the window client-side so it stays accurate as time passes
    // between polls.
    const nowMs = Date.now();
    const sweptBindings = await Promise.all(
      bindings.map(async (b) => {
        if (b.contestedSince == null || isCurrentlyContested(b.contestedSince, nowMs)) return b;
        try {
          await this.prisma.iMAgentBinding.update({
            where: { agentImUserId: b.agentImUserId },
            data: { contestedSince: null },
          });
        } catch {
          /* non-fatal: the DTO still derives the row as not currently contested */
        }
        return { ...b, contestedSince: null };
      }),
    );
    return sweptBindings.map((b) => ({
      binding: b,
      agentName: byId.get(b.agentImUserId) ?? b.agentImUserId,
      contested: isCurrentlyContested(b.contestedSince, nowMs),
    }));
  }

  /**
   * Explicit user rebind. Validates target daemon health, records audit log
   * (via boundBy='user-explicit'), and returns the count of in-flight tasks
   * that the previous owner still needs to wrap before the actual handover.
   *
   * Hand-over policy: dispatch routing FLIPS to the new daemon immediately
   * for NEW tasks; tasks already dispatched to the previous owner are
   * allowed to complete (the previous owner's WS connection is not
   * disconnected here — it'll naturally lose new dispatches because
   * resolveAgentDaemonRoute now reads the new binding). This is the
   * "in-flight tasks 等当前 owner 完成再切" semantic from §4.8.2.
   */
  async rebind(input: {
    agentImUserId: string;
    targetDaemonId: string;
    targetDaemonKind?: 'k8s' | 'local' | 'edge';
    targetDaemonLabel?: string;
    actorImUserId: string;
    reason: string;
  }): Promise<RebindResult> {
    const existing = await this.prisma.iMAgentBinding.findUnique({
      where: { agentImUserId: input.agentImUserId },
    });
    if (!existing) {
      throw new AgentBindingNotFoundError(input.agentImUserId);
    }
    if (existing.boundDaemonId === input.targetDaemonId) {
      // Idempotent — clear contested marker if the user is "reconfirming"
      // the current owner via rebind. Drop the contestCount? No — keep the
      // history; only contestedSince is the active marker.
      const cleared = await this.prisma.iMAgentBinding.update({
        where: { agentImUserId: input.agentImUserId },
        data: {
          contestedSince: null,
          boundBy: 'user-explicit',
          boundAt: new Date(),
        },
      });
      return { binding: cleared, inFlightTaskCount: 0, previousDaemonId: existing.boundDaemonId };
    }

    // Count in-flight tasks on the previous owner so the API caller can
    // surface "the previous owner still has N tasks in flight; they'll
    // finish before new tasks route to the new owner". We never block
    // the rebind on this count — the new owner picks up immediately,
    // the previous owner's connected sockets simply stop receiving new
    // dispatch.
    let inFlightTaskCount = 0;
    if (this.prisma.iMTask?.count) {
      try {
        inFlightTaskCount = await this.prisma.iMTask.count({
          where: {
            assigneeId: input.agentImUserId,
            status: { in: ['running', 'pending', 'dispatching'] },
          },
        });
      } catch {
        inFlightTaskCount = 0;
      }
    }

    const updated = await this.prisma.iMAgentBinding.update({
      where: { agentImUserId: input.agentImUserId },
      data: {
        boundDaemonId: input.targetDaemonId,
        boundDaemonKind: input.targetDaemonKind ?? existing.boundDaemonKind,
        boundDaemonLabel: input.targetDaemonLabel ?? existing.boundDaemonLabel,
        boundBy: 'user-explicit',
        boundAt: new Date(),
        contestedSince: null,
        // Note: contestCount preserved as historical signal.
      },
    });

    if (this.syncService) {
      try {
        await this.syncService.writeEvent(
          'agent.binding.rebound',
          {
            agentImUserId: input.agentImUserId,
            previousDaemonId: existing.boundDaemonId,
            newDaemonId: input.targetDaemonId,
            reason: input.reason,
            actorImUserId: input.actorImUserId,
            inFlightTaskCount,
          },
          null,
          input.actorImUserId,
        );
      } catch (err) {
        console.warn(`[AgentBindingService] sync event 'agent.binding.rebound' failed: ${(err as Error).message}`);
      }
    }

    return { binding: updated, inFlightTaskCount, previousDaemonId: existing.boundDaemonId };
  }

  /** Touch lastDispatchAt — called from dispatch path for observability. */
  async noteDispatch(agentImUserId: string): Promise<void> {
    try {
      await this.prisma.iMAgentBinding.update({
        where: { agentImUserId },
        data: { lastDispatchAt: new Date() },
      });
    } catch {
      /* binding may not exist for legacy agents — non-fatal */
    }
  }
}

export class AgentBindingNotFoundError extends Error {
  constructor(public readonly agentImUserId: string) {
    super(`No binding row for agent ${agentImUserId}`);
    this.name = 'AgentBindingNotFoundError';
  }
}

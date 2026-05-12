/**
 * Prismer IM — Agent lifecycle service
 *
 * Manages agent registration, heartbeats, capability declarations,
 * and automatic timeout detection.
 */

import type Redis from 'ioredis';
import prisma from '../db';
import { config } from '../config';
import type { AgentCapability, AgentStatus, AgentType } from '../types/index';

export interface RegisterAgentInput {
  userId: string;
  /**
   * Workspace this agent card belongs to. Required when creating a new card
   * (Prisma `iMAgentCard.workspaceId` is NOT NULL since 1.9.2 Phase 2).
   * Optional on subsequent updates — caller should pass it through anyway
   * for symmetry; the upsert.create branch is what enforces it.
   */
  workspaceId: string;
  name: string;
  description: string;
  agentType: AgentType;
  capabilities?: AgentCapability[];
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface HeartbeatInput {
  status: AgentStatus;
  load?: number;
  activeConversations?: number;
  // Cloud 2.5 (1.9.5) extensions — see docs/superpowers/plans/2026-05-04-cloud2p5-asset-anthropic-heartbeat.md
  deviceId?: string;
  currentTaskId?: string;
  version?: string;
}

export class AgentService {
  constructor(private redis: Redis) {}

  /**
   * Register a new agent or update existing registration.
   */
  async register(input: RegisterAgentInput) {
    const card = await prisma.iMAgentCard.upsert({
      where: { imUserId: input.userId },
      update: {
        name: input.name,
        description: input.description,
        agentType: input.agentType,
        capabilities: input.capabilities ? JSON.stringify(input.capabilities) : '[]',
        endpoint: input.endpoint,
        metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
        status: 'online',
        lastHeartbeat: new Date(),
      },
      create: {
        imUserId: input.userId,
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description,
        agentType: input.agentType,
        capabilities: input.capabilities ? JSON.stringify(input.capabilities) : '[]',
        endpoint: input.endpoint,
        metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
        status: 'online',
        lastHeartbeat: new Date(),
      },
    });

    // Store in Redis for quick lookup (non-blocking)
    try {
      await this.redis.set(
        `im:agent:${input.userId}`,
        JSON.stringify({ id: card.id, status: 'online', lastHeartbeat: Date.now() }),
      );
    } catch (err) {
      // Redis optional in dev mode
      console.warn('[Agent] Redis unavailable, skipping cache:', (err as Error).message);
    }

    return card;
  }

  /**
   * Process agent heartbeat.
   */
  async heartbeat(userId: string, input: HeartbeatInput): Promise<void> {
    await prisma.iMAgentCard.update({
      where: { imUserId: userId },
      data: {
        status: input.status,
        load: input.load ?? 0,
        lastHeartbeat: new Date(),
      },
    });

    const payload = {
      status: input.status,
      load: input.load,
      activeConversations: input.activeConversations,
      deviceId: input.deviceId ?? null,
      currentTaskId: input.currentTaskId ?? null,
      version: input.version ?? null,
      lastHeartbeat: Date.now(),
    };

    try {
      // New: presence:agent:<id> with fixed 90s TTL (3x typical 30s heartbeat cadence)
      await this.redis.set(`presence:agent:${userId}`, JSON.stringify(payload), 'EX', 90);
      // Pub/sub for Task 8 SSE
      await this.redis.publish('presence:agent:changes', JSON.stringify({ userId, ...payload }));

      // Legacy key kept for backward compat (parity TTL)
      await this.redis.set(
        `im:agent:${userId}`,
        JSON.stringify({
          status: input.status,
          load: input.load,
          activeConversations: input.activeConversations,
          lastHeartbeat: Date.now(),
        }),
        'EX',
        90,
      );
    } catch (err) {
      console.warn('[Agent] Redis unavailable, skipping cache:', (err as Error).message);
    }

    // Mirror to IMUser.lastSeenAt for cross-cutting "last seen" reads
    try {
      await prisma.iMUser.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
    } catch {
      /* non-fatal — agent card update above is the primary source of truth */
    }
  }

  /**
   * Declare/update agent capabilities.
   */
  async declareCapabilities(userId: string, capabilities: AgentCapability[]): Promise<void> {
    await prisma.iMAgentCard.update({
      where: { imUserId: userId },
      data: {
        capabilities: JSON.stringify(capabilities),
      },
    });
  }

  /**
   * Get agent card by user ID.
   */
  async getByUserId(userId: string) {
    return prisma.iMAgentCard.findUnique({
      where: { imUserId: userId },
    });
  }

  /**
   * List all registered agents.
   */
  async listAll() {
    return prisma.iMAgentCard.findMany({
      include: { imUser: true },
    });
  }

  /**
   * List online agents.
   */
  async listOnline() {
    return prisma.iMAgentCard.findMany({
      where: { status: 'online' },
      include: { imUser: true },
    });
  }

  /**
   * Mark timed-out agents as offline.
   * Should be called periodically (e.g., every 30s).
   */
  async sweepTimedOut(): Promise<number> {
    const cutoff = new Date(Date.now() - config.agent.heartbeatTimeoutMs);

    const result = await prisma.iMAgentCard.updateMany({
      where: {
        status: 'online',
        lastHeartbeat: {
          lt: cutoff,
        },
      },
      data: {
        status: 'offline',
      },
    });

    return result.count;
  }

  /**
   * Unregister an agent.
   */
  async unregister(userId: string): Promise<void> {
    // Why deleteMany + soft delete:
    //   1. `delete()` throws P2025 when the card row is already gone (e.g.
    //      the agent never produced a card, or a prior unregister already
    //      ran) — which surfaced as a 500. `deleteMany` is no-op-safe.
    //   2. The agent's `IMAgentProfile` rows must be soft-deleted too, or
    //      daemon profile sync keeps re-pulling them and resurrecting the
    //      gateway / consuming credits.
    //   3. The IMUser row itself can't be hard-deleted — it's the FK target
    //      for im_messages.senderId, im_task_runs.assigneeId, etc. Flip
    //      `banned=true` so `/me/agents` (which filters on `banned: false`)
    //      stops listing it; conversation history stays intact.
    const now = new Date();
    await prisma.$transaction([
      prisma.iMAgentCard.deleteMany({ where: { imUserId: userId } }),
      prisma.iMAgentProfile.updateMany({
        where: { agentImUserId: userId, deletedAt: null },
        data: { deletedAt: now },
      }),
      prisma.iMUser.updateMany({
        where: { id: userId, role: 'agent' },
        data: { banned: true, bannedAt: now, banReason: 'unregistered' },
      }),
    ]);
    try {
      await this.redis.del(`im:agent:${userId}`);
    } catch {
      // Redis optional
    }
  }
}

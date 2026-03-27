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
        JSON.stringify({ id: card.id, status: 'online', lastHeartbeat: Date.now() })
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

    // Update Redis (non-blocking)
    try {
      await this.redis.set(
        `im:agent:${userId}`,
        JSON.stringify({
          status: input.status,
          load: input.load,
          activeConversations: input.activeConversations,
          lastHeartbeat: Date.now(),
        }),
        'EX',
        Math.ceil(config.agent.heartbeatTimeoutMs / 1000)
      );
    } catch (err) {
      // Redis optional in dev mode
      console.warn('[Agent] Redis unavailable, skipping cache:', (err as Error).message);
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
    await prisma.iMAgentCard.delete({
      where: { imUserId: userId },
    });
    try {
      await this.redis.del(`im:agent:${userId}`);
    } catch (err) {
      // Redis optional
    }
  }
}

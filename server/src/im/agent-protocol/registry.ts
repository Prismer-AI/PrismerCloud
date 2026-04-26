/**
 * Prismer IM — Agent Registry
 *
 * Central registry for agent discovery and management.
 * Provides query capabilities for finding agents by type, capability, etc.
 */

import type { AgentService } from '../services/agent.service';
import type { AgentInfo, AgentDiscoveryQuery } from './types';
import type { AgentCapability, AgentType, AgentStatus } from '../types/index';

export class AgentRegistry {
  constructor(private agentService: AgentService) {}

  /**
   * Discover agents matching the given criteria.
   */
  async discover(query: AgentDiscoveryQuery): Promise<AgentInfo[]> {
    const agents = query.onlineOnly ? await this.agentService.listOnline() : await this.agentService.listAll();

    let results: AgentInfo[] = agents.map((card: (typeof agents)[number]) => {
      // Parse capabilities from JSON string
      let capabilities: AgentCapability[] = [];
      try {
        capabilities =
          typeof card.capabilities === 'string' ? JSON.parse(card.capabilities) : (card.capabilities ?? []);
      } catch {
        capabilities = [];
      }

      return {
        agentId: card.id,
        userId: card.imUserId,
        name: card.name,
        description: card.description,
        agentType: card.agentType as AgentType,
        capabilities,
        status: card.status as AgentStatus,
        load: card.load ?? 0,
        endpoint: card.endpoint ?? undefined,
        did: card.did ?? (card as any).imUser?.primaryDid ?? undefined,
        didDocumentUrl:
          (card.did ?? (card as any).imUser?.primaryDid)
            ? (card.didDocumentUrl ?? `/.well-known/did/agents/${card.imUserId}/did.json`)
            : undefined,
      };
    });

    // Filter by agent type
    if (query.agentType) {
      results = results.filter((a) => a.agentType === query.agentType);
    }

    // Filter by capability (handles both string[] and AgentCapability[])
    if (query.capability) {
      results = results.filter((a) =>
        a.capabilities.some((c: string | AgentCapability) => (typeof c === 'string' ? c : c.name) === query.capability),
      );
    }

    return results;
  }

  /**
   * Find the best agent for a given capability.
   * Prefers online agents with lowest load.
   */
  async findBestForCapability(capabilityName: string): Promise<AgentInfo | null> {
    const agents = await this.discover({
      capability: capabilityName,
      onlineOnly: true,
    });

    if (agents.length === 0) return null;

    // Sort by load (ascending)
    agents.sort((a, b) => a.load - b.load);
    return agents[0];
  }

  /**
   * Get a specific agent's info by user ID.
   */
  async getAgentInfo(userId: string): Promise<AgentInfo | null> {
    const card = await this.agentService.getByUserId(userId);
    if (!card) return null;

    // Parse capabilities from JSON string
    let capabilities: AgentCapability[] = [];
    try {
      capabilities = typeof card.capabilities === 'string' ? JSON.parse(card.capabilities) : (card.capabilities ?? []);
    } catch {
      capabilities = [];
    }

    return {
      agentId: card.id,
      userId: card.imUserId,
      name: card.name,
      description: card.description,
      agentType: card.agentType as AgentType,
      capabilities,
      status: card.status as AgentStatus,
      load: card.load ?? 0,
      endpoint: card.endpoint ?? undefined,
      did: card.did ?? (card as any).imUser?.primaryDid ?? undefined,
      didDocumentUrl:
        (card.did ?? (card as any).imUser?.primaryDid)
          ? (card.didDocumentUrl ?? `/.well-known/did/agents/${card.imUserId}/did.json`)
          : undefined,
    };
  }
}

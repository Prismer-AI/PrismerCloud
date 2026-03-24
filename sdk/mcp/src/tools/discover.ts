import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerDiscover(server: McpServer) {
  server.tool(
    'discover_agents',
    'Discover AI agents registered on Prismer Cloud. Filter by capability or type to find agents that can help with specific tasks.',
    {
      capability: z.string().optional().describe('Filter by capability (e.g. "search", "code", "translate")'),
      agentType: z
        .enum(['assistant', 'specialist', 'orchestrator', 'tool', 'bot'])
        .optional()
        .describe('Filter by agent type'),
      onlineOnly: z.boolean().optional().describe('Only show online agents (default: false)'),
    },
    async ({ capability, agentType, onlineOnly }) => {
      try {
        const query: Record<string, string> = {};
        if (capability) query.capability = capability;
        if (agentType) query.agentType = agentType;
        if (onlineOnly) query.onlineOnly = 'true';

        const result = (await prismerFetch('/api/im/agents', { query })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Discovery failed'}` }] };
        }

        const agents = (result.data || []) as Record<string, unknown>[];
        if (agents.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No agents found matching your criteria.' }] };
        }

        let text = `## Available Agents (${agents.length})\n\n`;
        for (const agent of agents) {
          const id = agent.userId || agent.agentId;
          text += `**${agent.name}** (ID: \`${id}\`)\n`;
          if (agent.description) text += `  ${agent.description}\n`;
          if (Array.isArray(agent.capabilities) && agent.capabilities.length) {
            text += `  Capabilities: ${agent.capabilities.join(', ')}\n`;
          }
          if (agent.status) text += `  Status: ${agent.status}\n`;
          text += '\n';
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

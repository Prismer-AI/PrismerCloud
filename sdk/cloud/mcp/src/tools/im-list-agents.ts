import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface ParticipantUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  agentType?: string | null;
}

interface Participant {
  id: string;
  role: string;
  user: ParticipantUser;
}

export function registerImListAgents(server: McpServer) {
  server.tool(
    'prismer.conversation.listAgents',
    'List the agents that can be addressed in a given conversation. Use this BEFORE calling `prismer.agent.send` so you don\'t guess usernames. Returns agents only (humans are not callable). The current agent is included — DO NOT pass your own username to `prismer.agent.send`. This tool acts as the agent it\'s running for (env `PRISMER_AGENT_USERNAME`); the resulting message is attributed to that agent, not the human owner of the API key.',
    {
      conversation_id: z.string().min(1).describe('Conversation ID to list addressable agents for'),
    },
    async ({ conversation_id }) => {
      try {
        const result = (await prismerFetch(`/api/im/conversations/${conversation_id}`)) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | string | undefined;
          const message = typeof err === 'string' ? err : err?.message || 'Failed to list agents';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ok: false, error: 'list_failed', message }),
              },
            ],
          };
        }

        const data = result.data as Record<string, unknown> | undefined;
        const participants = (data?.participants as Participant[]) || [];

        const agents = participants
          .filter((p) => p.user?.role === 'agent')
          .map((p) => ({
            id: p.user.id,
            username: p.user.username,
            displayName: p.user.displayName ?? p.user.username,
            agentType: p.user.agentType ?? undefined,
          }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, agents }, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: 'request_failed', message: msg }),
            },
          ],
        };
      }
    },
  );
}

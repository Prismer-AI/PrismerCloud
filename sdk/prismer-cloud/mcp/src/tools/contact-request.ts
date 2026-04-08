import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerContactRequest(server: McpServer) {
  server.tool(
    'contact_request',
    'Send a friend request to a user. Use contact_search first to find the user ID.',
    {
      userId: z.string().describe('Target user ID to send friend request to'),
      reason: z.string().optional().describe('Optional message explaining why you want to connect'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/contacts/request', {
          method: 'POST',
          body: {
            userId: args.userId,
            reason: args.reason,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Friend request failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Friend Request Sent\n\n`;
        text += `**Request ID:** \`${data?.id || 'unknown'}\`\n`;
        text += `**To:** \`${args.userId}\`\n`;
        text += `**Status:** ${data?.status || 'pending'}\n`;
        if (args.reason) text += `**Reason:** ${args.reason}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

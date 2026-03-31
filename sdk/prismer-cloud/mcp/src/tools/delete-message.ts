import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerDeleteMessage(server: McpServer) {
  server.tool(
    'delete_message',
    'Delete an existing message in a conversation. Only the sender can delete their own messages.',
    {
      conversationId: z.string().describe('Conversation ID containing the message'),
      messageId: z.string().describe('ID of the message to delete'),
    },
    async ({ conversationId, messageId }) => {
      try {
        const result = (await prismerFetch(`/api/im/messages/${conversationId}/${messageId}`, {
          method: 'DELETE',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Delete failed'}` }] };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Message ${messageId} deleted successfully.`,
          }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

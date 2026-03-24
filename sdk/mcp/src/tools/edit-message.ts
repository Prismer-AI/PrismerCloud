import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEditMessage(server: McpServer) {
  server.tool(
    'edit_message',
    'Edit an existing message in a conversation. Useful for streaming agent output (send empty message, then edit with accumulated content).',
    {
      conversationId: z.string().describe('Conversation ID containing the message'),
      messageId: z.string().describe('ID of the message to edit'),
      content: z.string().describe('New message content (replaces existing)'),
      metadata: z.record(z.any()).optional().describe('Optional metadata to merge (e.g. { prismer: { type: "message_complete" } })'),
    },
    async ({ conversationId, messageId, content, metadata }) => {
      try {
        const body: Record<string, unknown> = { content };
        if (metadata) body.metadata = metadata;

        const result = (await prismerFetch(`/api/im/messages/${conversationId}/${messageId}`, {
          method: 'PATCH',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Edit failed'}` }] };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Message ${messageId} edited successfully.`,
          }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

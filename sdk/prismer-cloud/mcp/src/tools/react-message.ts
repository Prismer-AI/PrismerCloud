import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerReactMessage(server: McpServer) {
  server.tool(
    'react_message',
    'Add or remove an emoji reaction on a message (v1.8.2). Idempotent — adding an existing reaction or removing a non-existent one is a no-op. Returns the full reactions snapshot.',
    {
      conversationId: z.string().describe('Conversation ID containing the message'),
      messageId: z.string().describe('ID of the target message'),
      emoji: z.string().max(32).describe('Emoji to add or remove (e.g. "👍", "🎉"). Max 32 chars.'),
      remove: z.boolean().optional().describe('Set true to remove the reaction; omit/false to add.'),
    },
    async ({ conversationId, messageId, emoji, remove }) => {
      try {
        const body: Record<string, unknown> = { emoji };
        if (remove) body.remove = true;

        const result = (await prismerFetch(
          `/api/im/messages/${conversationId}/${messageId}/reactions`,
          { method: 'POST', body },
        )) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Reaction failed'}` }] };
        }

        const data = result.data as { reactions?: Record<string, string[]> } | undefined;
        const reactions = data?.reactions ?? {};
        const summary = Object.entries(reactions)
          .map(([e, users]) => `${e}×${users.length}`)
          .join(', ') || '(none)';
        return {
          content: [{
            type: 'text' as const,
            text: `${remove ? 'Removed' : 'Added'} ${emoji} on message ${messageId}. Current reactions: ${summary}`,
          }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

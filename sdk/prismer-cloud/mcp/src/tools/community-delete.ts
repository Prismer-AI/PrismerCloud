import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityDelete(server: McpServer) {
  server.tool(
    'community_delete',
    'Delete your own community post or comment (authenticated).',
    {
      target: z.enum(['post', 'comment']).describe('post or comment'),
      id: z.string().describe('Post ID or comment ID'),
    },
    async (args) => {
      try {
        const path =
          args.target === 'post'
            ? `/api/im/community/posts/${encodeURIComponent(args.id)}`
            : `/api/im/community/comments/${encodeURIComponent(args.id)}`;
        const result = (await prismerFetch(path, { method: 'DELETE' })) as Record<string, unknown>;
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${(result.error as string) || 'Delete failed'}` }] };
        }
        return { content: [{ type: 'text' as const, text: `## Deleted\n\n**${args.target}** \`${args.id}\`` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

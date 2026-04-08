import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityBookmark(server: McpServer) {
  server.tool(
    'community_bookmark',
    'Toggle bookmark on a community post. Bookmarked posts can be retrieved later for reference.',
    {
      postId: z.string().describe('Post ID to bookmark/unbookmark'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/community/bookmark', {
          method: 'POST',
          body: { postId: args.postId },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Bookmark failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        const action = data.bookmarked ? 'Bookmarked' : 'Bookmark removed';
        let text = `## ${action}\n\n`;
        text += `- **Post:** ${args.postId}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

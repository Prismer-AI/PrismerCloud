import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityAnswer(server: McpServer) {
  server.tool(
    'community_answer',
    'Mark a comment as the best answer on a Help Desk post. Only the post author (human or agent) can call this.',
    {
      commentId: z.string().describe('Comment ID to mark as best answer'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/community/comments/${args.commentId}/best-answer`, {
          method: 'POST',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Mark best answer failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Best Answer Marked\n\n`;
        text += `- **Comment:** ${data.commentId}\n`;
        text += `- **Post:** ${data.postId}\n`;
        text += `- **Post status:** ${data.postStatus}\n`;
        if (data.solvedAt) text += `- **Solved at:** ${data.solvedAt}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

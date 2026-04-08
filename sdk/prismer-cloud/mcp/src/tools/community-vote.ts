import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityVote(server: McpServer) {
  server.tool(
    'community_vote',
    'Upvote, downvote, or clear vote on a community post or comment.',
    {
      targetType: z.enum(['post', 'comment']).describe('What to vote on'),
      targetId: z.string().describe('ID of the post or comment'),
      value: z.preprocess(
        (val) => (typeof val === 'string' ? Number(val) : val),
        z.union([z.literal(1), z.literal(-1), z.literal(0)]),
      ).describe('1 = upvote, -1 = downvote, 0 = clear vote'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/community/vote', {
          method: 'POST',
          body: {
            targetType: args.targetType,
            targetId: args.targetId,
            value: args.value,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Vote failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        const label = args.value === 1 ? 'Upvoted' : args.value === -1 ? 'Downvoted' : 'Vote cleared';
        let text = `## ${label}\n\n`;
        text += `- **Target:** ${data.targetType} \`${data.targetId}\`\n`;
        text += `- **Upvotes:** ${data.upvotes} | **Downvotes:** ${data.downvotes}\n`;
        text += `- **Your vote:** ${data.userVote}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

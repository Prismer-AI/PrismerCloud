import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityComment(server: McpServer) {
  server.tool(
    'community_comment',
    'Add a comment or answer to a community post. Use commentType "answer" for Help Desk top-level answers, "reply" for normal replies.',
    {
      postId: z.string().describe('Post ID to comment on'),
      content: z.string().describe('Comment body (Markdown)'),
      parentId: z.string().optional().describe('Parent comment ID for nested replies (null = top-level)'),
      commentType: z.enum(['reply', 'answer']).optional().describe('Comment type: reply (default) or answer (Help Desk top-level answer)'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/community/posts/${args.postId}/comments`, {
          method: 'POST',
          body: {
            content: args.content,
            parentId: args.parentId || null,
            commentType: args.commentType || 'reply',
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Comment failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Comment Posted\n\n`;
        text += `- **ID:** ${data.id}\n`;
        text += `- **Post:** ${data.postId}\n`;
        text += `- **Type:** ${data.commentType}\n`;
        if (data.parentId) text += `- **Reply to:** ${data.parentId}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

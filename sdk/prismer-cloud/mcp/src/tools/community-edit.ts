import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityEdit(server: McpServer) {
  server.tool(
    'community_edit',
    'Edit your own community post or comment (authenticated).',
    {
      target: z.enum(['post', 'comment']).describe('post or comment'),
      id: z.string().describe('Post ID or comment ID'),
      title: z.string().optional().describe('New title (posts only)'),
      content: z.string().optional().describe('New Markdown body'),
    },
    async (args) => {
      try {
        if (args.target === 'post') {
          if (!args.title && !args.content) {
            return { content: [{ type: 'text' as const, text: 'Error: provide title and/or content for post edit' }] };
          }
          const result = (await prismerFetch(`/api/im/community/posts/${encodeURIComponent(args.id)}`, {
            method: 'PUT',
            body: { title: args.title, content: args.content },
          })) as Record<string, unknown>;
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: `Error: ${(result.error as string) || 'Edit failed'}` }] };
          }
          return { content: [{ type: 'text' as const, text: '## Post updated\n\n' + JSON.stringify(result.data, null, 2) }] };
        }
        if (!args.content) {
          return { content: [{ type: 'text' as const, text: 'Error: content required for comment edit' }] };
        }
        const result = (await prismerFetch(`/api/im/community/comments/${encodeURIComponent(args.id)}`, {
          method: 'PUT',
          body: { content: args.content },
        })) as Record<string, unknown>;
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${(result.error as string) || 'Edit failed'}` }] };
        }
        return { content: [{ type: 'text' as const, text: '## Comment updated\n\n' + JSON.stringify(result.data, null, 2) }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

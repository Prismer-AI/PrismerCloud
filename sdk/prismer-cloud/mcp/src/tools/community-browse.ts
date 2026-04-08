import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityBrowse(server: McpServer) {
  server.tool(
    'community_browse',
    'Browse community posts with board filtering, sorting, and cursor-based pagination.',
    {
      boardId: z.enum(['showcase', 'genelab', 'helpdesk', 'ideas', 'changelog', 'all']).optional().describe('Filter by board (default: all)'),
      sort: z.enum(['hot', 'new', 'top', 'featured', 'unsolved']).optional().describe('Sort order (default: hot)'),
      authorType: z.enum(['human', 'agent', 'all']).optional().describe('Filter by author type (default: all)'),
      limit: z.preprocess(
        (val) => (val === undefined || val === null ? undefined : Number(val)),
        z.number().min(1).max(50).optional(),
      ).describe('Results per page (default: 20, max: 50)'),
      cursor: z.string().optional().describe('Cursor for pagination (nextCursor from previous response)'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.boardId) query.boardId = args.boardId;
        if (args.sort) query.sort = args.sort;
        if (args.authorType) query.authorType = args.authorType;
        if (args.limit !== undefined) query.limit = String(args.limit);
        if (args.cursor) query.cursor = args.cursor;

        const result = (await prismerFetch('/api/im/community/posts', { query })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Browse failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        const posts = data.posts as Array<Record<string, unknown>> | undefined;

        let text = `## Community Posts\n\n`;
        if (data.boards) text += `**Board counts:** ${JSON.stringify(data.boards)}\n\n`;

        if (posts && posts.length > 0) {
          for (const p of posts) {
            const author = p.author as Record<string, unknown> | undefined;
            const authorName = author?.name || p.authorId || 'unknown';
            const authorType = author?.type || p.authorType || '';
            text += `### ${p.title}\n`;
            text += `- **ID:** ${p.id} | **Board:** ${p.boardId} | **Author:** ${authorName} (${authorType})\n`;
            text += `- **Upvotes:** ${p.upvotes ?? 0} | **Comments:** ${p.commentCount ?? 0}\n`;
            if (p.tags) text += `- **Tags:** ${JSON.stringify(p.tags)}\n`;
            text += `\n`;
          }
        } else {
          text += `No posts found.\n`;
        }

        if (data.nextCursor) text += `\n**Next cursor:** \`${data.nextCursor}\`\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

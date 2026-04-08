import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityPost(server: McpServer) {
  server.tool(
    'community_post',
    'Create a new community post. Boards: showcase (battle reports, wins), genelab (Gene experiments, benchmarks), helpdesk (questions, troubleshooting), ideas (feature requests, brainstorms), changelog (release notes).',
    {
      boardId: z.enum(['showcase', 'genelab', 'helpdesk', 'ideas', 'changelog']).describe('Target board'),
      title: z.string().describe('Post title'),
      content: z.string().describe('Post body (Markdown). Use [[gene:ID]] to reference Genes inline.'),
      postType: z.string().optional().describe('Post type hint: battleReport, experiment, question, tutorial, idea, etc.'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      linkedGeneIds: z.array(z.string()).optional().describe('Gene IDs to link to this post'),
      linkedAgentId: z.string().optional().describe('Agent ID to associate with this post'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/community/posts', {
          method: 'POST',
          body: {
            boardId: args.boardId,
            title: args.title,
            content: args.content,
            postType: args.postType,
            tags: args.tags,
            linkedGeneIds: args.linkedGeneIds,
            linkedAgentId: args.linkedAgentId,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Post creation failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Post Created\n\n`;
        text += `- **ID:** ${data.id}\n`;
        text += `- **Board:** ${data.boardId}\n`;
        text += `- **Title:** ${data.title}\n`;
        if (data.tags) text += `- **Tags:** ${JSON.stringify(data.tags)}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

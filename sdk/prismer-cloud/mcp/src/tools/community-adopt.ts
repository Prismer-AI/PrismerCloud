import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityAdopt(server: McpServer) {
  server.tool(
    'community_adopt',
    'Adopt (fork) a Gene discovered via the community into your agent\'s evolution network. Optionally track which post led to the adoption.',
    {
      geneId: z.string().describe('Gene ID to adopt/fork'),
      fromPostId: z.string().optional().describe('Community post ID where you discovered this Gene (for attribution)'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { gene_id: args.geneId };
        if (args.fromPostId) body.from_post_id = args.fromPostId;

        const result = (await prismerFetch('/api/im/evolution/adopt', {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Adopt failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Gene Adopted\n\n`;
        text += `- **Gene ID:** \`${args.geneId}\`\n`;
        if (data.forkedGeneId) text += `- **Forked Gene ID:** \`${data.forkedGeneId}\`\n`;
        if (args.fromPostId) text += `- **Source post:** ${args.fromPostId}\n`;
        if (data.message) text += `- ${data.message}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

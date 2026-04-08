import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunitySearch(server: McpServer) {
  server.tool(
    'community_search',
    'Search community posts and comments by keyword. Returns relevance-ranked results with highlighted snippets.',
    {
      q: z.string().describe('Search query'),
      boardId: z.string().optional().describe('Limit search to a specific board'),
      sort: z.enum(['relevance', 'hot', 'new']).optional().describe('Sort order (default: relevance)'),
      limit: z.preprocess(
        (val) => (val === undefined || val === null ? undefined : Number(val)),
        z.number().min(1).max(50).optional(),
      ).describe('Results per page (default: 20, max: 50)'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = { q: args.q };
        if (args.boardId) query.boardId = args.boardId;
        if (args.sort) query.sort = args.sort;
        if (args.limit !== undefined) query.limit = String(args.limit);

        const result = (await prismerFetch('/api/im/community/search', { query })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Search failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        const results = data.results as Array<Record<string, unknown>> | undefined;

        let text = `## Search Results for "${args.q}"\n\n`;

        if (results && results.length > 0) {
          for (const r of results) {
            const author = r.author as Record<string, unknown> | undefined;
            text += `### [${r.type}] ${r.title || '(comment)'}\n`;
            text += `- **ID:** ${r.id} | **Board:** ${r.boardId || '-'}`;
            if (author?.name) text += ` | **Author:** ${author.name}`;
            text += `\n`;
            if (r.snippet) text += `- ${String(r.snippet).replace(/<\/?em>/g, '*')}\n`;
            text += `- **Upvotes:** ${r.upvotes ?? 0} | **Relevance:** ${r.relevanceScore ?? '-'}\n\n`;
          }
        } else {
          text += `No results found.\n`;
        }

        const relatedGenes = data.relatedGenes as Array<Record<string, unknown>> | undefined;
        if (relatedGenes && relatedGenes.length > 0) {
          text += `### Related Genes\n`;
          for (const g of relatedGenes) {
            text += `- **${g.title}** (\`${g.id}\`) — success rate: ${g.successRate}\n`;
          }
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

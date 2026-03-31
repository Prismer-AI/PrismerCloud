import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRecall(server: McpServer) {
  server.tool(
    'recall',
    'Search across all knowledge layers — memory files, cached contexts, and evolution history. Use this to find previously stored knowledge.',
    {
      query: z.string().describe('Search query (e.g., "timeout", "api recovery", "deployment")'),
      scope: z.enum(['all', 'memory', 'cache', 'evolution']).optional().default('all')
        .describe('Search scope: all (default), memory (episodic files), cache (context cache), evolution (gene history)'),
      limit: z.number().optional().default(10)
        .describe('Max results to return (default: 10, max: 50)'),
    },
    async ({ query, scope, limit }) => {
      try {
        const params: Record<string, string> = { q: query };
        if (scope) params.scope = scope;
        if (limit) params.limit = String(limit);

        const result = (await prismerFetch('/api/im/recall', {
          query: params,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Recall search failed'}` }] };
        }

        const data = result.data as Array<Record<string, unknown>> | undefined;
        if (!data || data.length === 0) {
          return { content: [{ type: 'text' as const, text: `No results found for "${query}" (scope: ${scope}).` }] };
        }

        let text = `## Recall Results for "${query}"\n\n`;
        text += `**Scope:** ${scope} | **Results:** ${data.length}\n\n`;

        for (const item of data) {
          const source = item.source as string;
          const title = item.title as string;
          const snippet = item.snippet as string;
          const score = item.score as number;
          const path = item.path as string | undefined;

          text += `### [${source.toUpperCase()}] ${title}\n`;
          if (path && path !== title) text += `- **Path:** \`${path}\`\n`;
          text += `- **Score:** ${score.toFixed(2)}\n`;
          text += `- **Snippet:** ${snippet}\n\n`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

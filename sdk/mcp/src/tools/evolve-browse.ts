import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveBrowse(server: McpServer) {
  server.tool(
    'evolve_browse',
    'Browse public evolution genes. Search by category, keyword, or sort by popularity. Use this to find genes to import/fork.',
    {
      category: z.enum(['repair', 'optimize', 'innovate', 'diagnostic']).optional().describe('Filter by gene category'),
      search: z.string().optional().describe('Search keyword (matches title, signals, strategy)'),
      sort: z.enum(['newest', 'most_used', 'highest_success']).optional().describe('Sort order (default: newest)'),
      limit: z.number().optional().describe('Max results (default: 10, max: 50)'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.category) query.category = args.category;
        if (args.search) query.search = args.search;
        if (args.sort) query.sort = args.sort;
        if (args.limit) query.limit = String(args.limit);

        const result = (await prismerFetch('/api/im/evolution/public/genes', {
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Browse failed'}` }] };
        }

        const genes = (result.data || []) as Record<string, unknown>[];
        const meta = result.meta as Record<string, unknown> | undefined;

        if (genes.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No genes found matching the criteria.' }] };
        }

        let text = `## Public Genes (${genes.length}${meta?.total ? ` of ${meta.total}` : ''})\n\n`;
        for (const gene of genes) {
          const successRate = gene.successRate ?? gene.success_rate ?? '?';
          const executions = gene.totalExecutions ?? gene.total_executions ?? 0;
          text += `### ${gene.title || gene.id}\n`;
          text += `- **ID:** \`${gene.id}\`\n`;
          text += `- **Category:** ${gene.category}\n`;
          text += `- **Success:** ${typeof successRate === 'number' ? (successRate * 100).toFixed(0) + '%' : successRate} (${executions} runs)\n`;
          text += `- **Visibility:** ${gene.visibility}\n`;
          if (gene.signals_match) text += `- **Signals:** ${JSON.stringify(gene.signals_match)}\n`;
          text += '\n';
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

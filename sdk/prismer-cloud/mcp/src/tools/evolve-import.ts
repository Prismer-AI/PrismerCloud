import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveImport(server: McpServer) {
  server.tool(
    'evolve_import',
    'Import or fork a public gene into your own agent. Use evolve_browse to find gene IDs first. Fork creates a copy you can modify.',
    {
      gene_id: z.string().describe('ID of the public gene to import/fork'),
      fork: z.boolean().optional().describe('If true, creates a modifiable copy (fork) instead of a direct import (default: false)'),
      modifications: z.object({
        strategy: z.array(z.string()).optional(),
        preconditions: z.array(z.string()).optional(),
        constraints: z.object({
          max_retries: z.number().optional(),
          max_credits_per_run: z.number().optional(),
          max_execution_time: z.number().optional(),
        }).optional(),
      }).optional().describe('Modifications to apply when forking'),
    },
    async (args) => {
      try {
        const endpoint = args.fork
          ? '/api/im/evolution/genes/fork'
          : '/api/im/evolution/genes/import';

        const body: Record<string, unknown> = { gene_id: args.gene_id };
        if (args.fork && args.modifications) {
          body.modifications = args.modifications;
        }

        const result = (await prismerFetch(endpoint, {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Import failed'}` }] };
        }

        const gene = result.data as Record<string, unknown>;
        const action = args.fork ? 'Forked' : 'Imported';
        let text = `## Gene ${action}\n\n`;
        text += `**ID:** \`${gene.id}\`\n`;
        text += `**Category:** ${gene.category}\n`;
        if (gene.title) text += `**Title:** ${gene.title}\n`;
        if (gene.forked_from) text += `**Forked from:** \`${gene.forked_from}\`\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

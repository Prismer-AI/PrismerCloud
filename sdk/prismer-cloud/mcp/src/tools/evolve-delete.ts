import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveDelete(server: McpServer) {
  server.tool(
    'evolve_delete',
    'Delete a gene you own. Cannot be undone.',
    {
      gene_id: z.string().describe('ID of the gene to delete'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/evolution/genes/${encodeURIComponent(args.gene_id)}`, {
          method: 'DELETE',
        })) as Record<string, unknown>;

        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${result.error || 'Delete failed'}` }] };
        }

        return { content: [{ type: 'text' as const, text: `Gene \`${args.gene_id}\` deleted.` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

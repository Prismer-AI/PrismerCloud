import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolvePublish(server: McpServer) {
  server.tool(
    'evolve_publish',
    'Publish a private Gene to the evolution network. Publishes as canary (5% rollout) by default, or directly to published with skipCanary.',
    {
      gene_id: z.string().describe('ID of the gene to publish'),
      skip_canary: z.boolean().optional().describe('Skip canary phase and publish directly (default: false)'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/evolution/genes/${encodeURIComponent(args.gene_id)}/publish`, {
          method: 'POST',
          body: { skipCanary: args.skip_canary || false },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Publish failed'}` }] };
        }

        const gene = result.data as Record<string, unknown>;
        const text = `## Gene Published\n\n` +
          `**ID:** \`${gene.id}\`\n` +
          `**Visibility:** ${gene.visibility}\n` +
          `**Title:** ${gene.title || 'N/A'}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

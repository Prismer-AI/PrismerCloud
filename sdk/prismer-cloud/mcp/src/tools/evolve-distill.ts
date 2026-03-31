import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveDistill(server: McpServer) {
  server.tool(
    'evolve_distill',
    'Trigger gene distillation — synthesize a new Gene from successful execution patterns using LLM. Use dry_run=true to check readiness first.',
    {
      dry_run: z.boolean().optional().describe('If true, only check readiness without triggering LLM (default: false)'),
    },
    async (args) => {
      try {
        const query = args.dry_run ? '?dry_run=true' : '';
        const result = (await prismerFetch(`/api/im/evolution/distill${query}`, {
          method: 'POST',
          body: {},
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Distillation failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;

        if (data.ready === false) {
          return { content: [{ type: 'text' as const, text: `## Not Ready for Distillation\n\n${data.message}\n\nSuccessful capsules: ${data.success_capsules}/${data.min_required}` }] };
        }

        if (args.dry_run) {
          return { content: [{ type: 'text' as const, text: `## Ready for Distillation\n\n${data.message}\n\nSuccessful capsules: ${data.success_capsules}` }] };
        }

        let text = `## Gene Distilled\n\n`;
        if (data.gene) {
          const gene = data.gene as Record<string, unknown>;
          text += `**New Gene ID:** \`${gene.id}\`\n`;
          text += `**Category:** ${gene.category}\n`;
          if (gene.title) text += `**Title:** ${gene.title}\n`;
        }
        if (data.critique) text += `\n**Critique:** ${data.critique}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

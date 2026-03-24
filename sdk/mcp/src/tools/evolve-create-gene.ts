import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveCreateGene(server: McpServer) {
  server.tool(
    'evolve_create_gene',
    'Create a new evolution Gene (reusable strategy pattern). Genes encode what to do when specific signals are detected.',
    {
      category: z.enum(['repair', 'optimize', 'innovate', 'diagnostic']).describe('Gene category'),
      signals_match: z.array(z.string()).describe('Signals this gene responds to (e.g. ["error:timeout", "error:429"])'),
      strategy: z.array(z.string()).describe('Strategy steps — actionable instructions the agent should follow'),
      title: z.string().optional().describe('Human-readable gene title (auto-generated if omitted)'),
      preconditions: z.array(z.string()).optional().describe('Conditions that must hold before applying this gene'),
      constraints: z.object({
        max_retries: z.number().optional(),
        max_credits_per_run: z.number().optional(),
        max_execution_time: z.number().optional(),
      }).optional().describe('Execution constraints (circuit breaker limits)'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/evolution/genes', {
          method: 'POST',
          body: {
            category: args.category,
            signals_match: args.signals_match,
            strategy: args.strategy,
            title: args.title,
            preconditions: args.preconditions,
            constraints: args.constraints,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Gene creation failed'}` }] };
        }

        const gene = result.data as Record<string, unknown>;
        let text = `## Gene Created\n\n`;
        text += `**ID:** \`${gene.id}\`\n`;
        text += `**Category:** ${gene.category}\n`;
        if (gene.title) text += `**Title:** ${gene.title}\n`;
        text += `**Signals:** ${JSON.stringify(gene.signals_match)}\n`;
        text += `**Status:** ${gene.visibility || 'private'}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

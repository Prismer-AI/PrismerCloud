import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveRecord(server: McpServer) {
  server.tool(
    'evolve_record',
    'Record the outcome of a Gene execution. Updates the agent\'s memory graph and personality. Triggers distillation check.',
    {
      gene_id: z.string().describe('ID of the Gene that was executed'),
      signals: z.preprocess(
        (val) => {
          if (typeof val === 'string') {
            try { return JSON.parse(val); } catch { return [val]; }
          }
          return val;
        },
        z.union([
          z.array(z.string()),
          z.array(z.object({
            type: z.string(),
            provider: z.string().optional(),
            stage: z.string().optional(),
            severity: z.string().optional(),
          })),
        ]),
      ).describe('Signals: string[] or SignalTag[] ({type, provider?, stage?, severity?})'),
      outcome: z.enum(['success', 'failed']).describe('Execution outcome'),
      score: z.number().min(0).max(1).optional().describe('Quality score (0-1)'),
      summary: z.string().describe('Brief summary of what happened'),
      cost_credits: z.number().optional().describe('Credits consumed'),
      transition_reason: z.string().optional().describe('How gene was selected: gene_applied | fallback_relaxed | fallback_neighbor | baseline'),
      context_snapshot: z.record(z.unknown()).optional().describe('Execution context (memoryCount, tasksPending, sessionDuration, etc.)'),
      scope: z.string().optional().describe('Evolution scope to partition gene pools (e.g. "project-x", "team-backend")'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.scope) query.scope = args.scope;
        const result = (await prismerFetch('/api/im/evolution/record', {
          method: 'POST',
          body: {
            gene_id: args.gene_id,
            signals: args.signals,
            outcome: args.outcome,
            score: args.score,
            summary: args.summary,
            cost_credits: args.cost_credits,
            transition_reason: args.transition_reason,
            context_snapshot: args.context_snapshot,
          },
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Record failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Outcome Recorded\n\n`;
        text += `- Edge updated: ${data.edge_updated}\n`;
        text += `- Personality adjusted: ${data.personality_adjusted}\n`;
        text += `- Distillation ready: ${data.distill_ready}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

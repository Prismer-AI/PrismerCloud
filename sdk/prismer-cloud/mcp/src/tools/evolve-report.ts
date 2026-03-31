import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveReport(server: McpServer) {
  server.tool(
    'evolve_report',
    'Submit raw execution context for async LLM-based evolution analysis. Returns a trace_id for status checking.',
    {
      rawContext: z.string().describe('Raw context/error/log from the execution'),
      outcome: z.enum(['success', 'failed']).describe('Overall outcome'),
      taskContext: z.string().optional().describe('Task description or context'),
      scope: z.string().optional().describe('Evolution scope to partition gene pools (e.g. "project-x", "team-backend")'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          raw_context: args.rawContext,
          outcome: args.outcome,
        };
        if (args.taskContext) body.task_context = args.taskContext;

        const query: Record<string, string> = {};
        if (args.scope) query.scope = args.scope;

        const result = (await prismerFetch('/api/im/evolution/report', {
          method: 'POST',
          body,
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Report submission failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Report Submitted\n\n`;
        text += `**Trace ID:** \`${data.trace_id}\`\n`;
        text += `**Status:** ${data.status || 'queued'}\n`;
        if (data.message) text += `**Message:** ${data.message}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCompleteTask(server: McpServer) {
  server.tool(
    'complete_task',
    'Mark a task as completed with an optional result summary and cost.',
    {
      task_id: z.string().describe('The task ID to complete'),
      result: z.string().optional().describe('Result summary or output of the task'),
      cost: z.number().optional().describe('Credit cost incurred for task execution'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.result) body.result = args.result;
        if (args.cost !== undefined) body.cost = args.cost;

        const res = (await prismerFetch(`/api/im/tasks/${args.task_id}/complete`, {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!res.ok) {
          const err = res.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task completion failed'}` }] };
        }

        let text = `## Task Completed\n\n`;
        text += `- **ID:** \`${args.task_id}\`\n`;
        text += `- **Status:** completed\n`;
        if (args.result) text += `- **Result:** ${args.result}\n`;
        if (args.cost !== undefined) text += `- **Cost:** ${args.cost} credits\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

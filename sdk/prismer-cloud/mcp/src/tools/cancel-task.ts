import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCancelTask(server: McpServer) {
  server.tool(
    'cancel_task',
    'Cancel a task (soft delete). Only the task creator can cancel. Cannot cancel completed or failed tasks.',
    {
      task_id: z.string().describe('The task ID to cancel'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/tasks/${args.task_id}`, {
          method: 'DELETE',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task cancellation failed'}` }] };
        }

        let text = `## Task Cancelled\n\n`;
        text += `- **ID:** \`${args.task_id}\`\n`;
        text += `- **Status:** cancelled\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

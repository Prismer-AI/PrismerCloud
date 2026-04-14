import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRejectTask(server: McpServer) {
  server.tool(
    'reject_task',
    'Reject a task that is in review status. Only the task creator can reject.',
    {
      task_id: z.string().describe('The task ID to reject'),
      reason: z.string().describe('Reason for rejecting the task'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/tasks/${args.task_id}/reject`, {
          method: 'POST',
          body: { reason: args.reason },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task rejection failed'}` }] };
        }

        let text = `## Task Rejected\n\n`;
        text += `- **ID:** \`${args.task_id}\`\n`;
        text += `- **Status:** rejected\n`;
        text += `- **Reason:** ${args.reason}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

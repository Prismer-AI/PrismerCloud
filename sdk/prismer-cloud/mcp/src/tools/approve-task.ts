import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerApproveTask(server: McpServer) {
  server.tool(
    'approve_task',
    'Approve a completed task, confirming its result is satisfactory.',
    {
      task_id: z.string().describe('The task ID to approve'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/tasks/${args.task_id}/approve`, {
          method: 'POST',
          body: {},
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task approval failed'}` }] };
        }

        let text = `## Task Approved\n\n`;
        text += `- **ID:** \`${args.task_id}\`\n`;
        text += `- **Status:** approved\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

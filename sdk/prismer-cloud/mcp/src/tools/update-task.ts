import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerUpdateTask(server: McpServer) {
  server.tool(
    'update_task',
    'Update a task\'s title, description, status, progress, or status message.',
    {
      task_id: z.string().describe('The task ID to update'),
      title: z.string().optional().describe('New task title'),
      description: z.string().optional().describe('New task description'),
      status: z
        .enum(['pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'])
        .optional()
        .describe('New task status'),
      progress: z.number().min(0).max(1).optional().describe('Task progress (0 to 1)'),
      status_message: z.string().optional().describe('Status message for progress updates'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.title) body.title = args.title;
        if (args.description) body.description = args.description;
        if (args.status) body.status = args.status;
        if (args.progress !== undefined) body.progress = args.progress;
        if (args.status_message) body.statusMessage = args.status_message;

        if (Object.keys(body).length === 0) {
          return { content: [{ type: 'text' as const, text: 'Error: No fields to update. Provide at least one of: title, description, status, progress, status_message.' }] };
        }

        const result = (await prismerFetch(`/api/im/tasks/${args.task_id}`, {
          method: 'PATCH',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task update failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Task Updated\n\n`;
        text += `- **ID:** \`${args.task_id}\`\n`;
        if (args.title) text += `- **Title:** ${args.title}\n`;
        if (args.description) text += `- **Description:** ${args.description}\n`;
        if (args.status) text += `- **Status:** ${args.status}\n`;
        if (args.progress !== undefined) text += `- **Progress:** ${Math.round(args.progress * 100)}%\n`;
        if (args.status_message) text += `- **Status Message:** ${args.status_message}\n`;
        if (data?.updatedAt) text += `- **Updated:** ${data.updatedAt}\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

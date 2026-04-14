import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerGetTask(server: McpServer) {
  server.tool(
    'get_task',
    'Get details of a specific task by ID, including its execution logs.',
    {
      task_id: z.string().describe('The task ID to retrieve'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/tasks/${args.task_id}`, {
          method: 'GET',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task not found'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        if (!data) {
          return { content: [{ type: 'text' as const, text: 'Error: No task data returned' }] };
        }

        let text = `## Task: ${data.title || 'Untitled'}\n\n`;
        text += `- **ID:** \`${data.id}\`\n`;
        text += `- **Status:** ${data.status || 'unknown'}\n`;
        if (data.description) text += `- **Description:** ${data.description}\n`;
        if (data.capability) text += `- **Capability:** ${data.capability}\n`;
        if (data.assigneeId) text += `- **Assignee:** \`${data.assigneeId}\`\n`;
        if (data.creatorId) text += `- **Creator:** \`${data.creatorId}\`\n`;
        if (data.progress !== undefined && data.progress !== null) text += `- **Progress:** ${Math.round(Number(data.progress) * 100)}%\n`;
        if (data.statusMessage) text += `- **Status Message:** ${data.statusMessage}\n`;
        if (data.budget) text += `- **Budget:** ${data.budget} credits\n`;
        if (data.cost) text += `- **Cost:** ${data.cost} credits\n`;
        if (data.result) text += `- **Result:** ${data.result}\n`;
        if (data.scheduleType) text += `- **Schedule:** ${data.scheduleType}\n`;
        if (data.createdAt) text += `- **Created:** ${data.createdAt}\n`;
        if (data.updatedAt) text += `- **Updated:** ${data.updatedAt}\n`;

        // Render logs if present
        const logs = data.logs as Record<string, unknown>[] | undefined;
        if (logs && logs.length > 0) {
          text += `\n### Execution Logs (${logs.length})\n\n`;
          for (const log of logs) {
            text += `- **[${log.level || 'info'}]** ${log.message || ''}`;
            if (log.createdAt) text += ` _(${log.createdAt})_`;
            text += '\n';
          }
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

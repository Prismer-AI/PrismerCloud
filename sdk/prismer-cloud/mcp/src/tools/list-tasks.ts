import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerListTasks(server: McpServer) {
  server.tool(
    'list_tasks',
    'List tasks from the cloud task store. Filter by status, assignee, creator, conversation, or capability.',
    {
      status: z
        .enum(['pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'])
        .optional()
        .describe('Filter by task status'),
      assignee_id: z.string().optional().describe('Filter by assigned agent ID'),
      creator_id: z.string().optional().describe('Filter by task creator ID'),
      conversation_id: z.string().optional().describe('Filter by conversation ID'),
      capability: z.string().optional().describe('Filter by required capability'),
      limit: z.number().optional().describe('Maximum number of tasks to return (default 20)'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.status) query.status = args.status;
        if (args.assignee_id) query.assigneeId = args.assignee_id;
        if (args.creator_id) query.creatorId = args.creator_id;
        if (args.conversation_id) query.conversationId = args.conversation_id;
        if (args.capability) query.capability = args.capability;
        if (args.limit) query.limit = String(args.limit);

        const result = (await prismerFetch('/api/im/tasks', {
          method: 'GET',
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Failed to list tasks'}` }] };
        }

        const tasks = (result.data as Record<string, unknown>[]) || [];

        if (tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: '## Tasks\n\nNo tasks found matching the given filters.' }] };
        }

        let text = `## Tasks (${tasks.length})\n\n`;
        for (const task of tasks) {
          text += `### ${task.title || 'Untitled'}\n`;
          text += `- **ID:** \`${task.id}\`\n`;
          text += `- **Status:** ${task.status || 'unknown'}\n`;
          if (task.description) text += `- **Description:** ${task.description}\n`;
          if (task.capability) text += `- **Capability:** ${task.capability}\n`;
          if (task.assigneeId) text += `- **Assignee:** \`${task.assigneeId}\`\n`;
          if (task.creatorId) text += `- **Creator:** \`${task.creatorId}\`\n`;
          if (task.progress !== undefined && task.progress !== null) text += `- **Progress:** ${Math.round(Number(task.progress) * 100)}%\n`;
          if (task.budget) text += `- **Budget:** ${task.budget} credits\n`;
          text += '\n';
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

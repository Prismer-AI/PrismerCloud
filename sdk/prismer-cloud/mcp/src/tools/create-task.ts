import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCreateTask(server: McpServer) {
  server.tool(
    'create_task',
    'Create a task in the cloud task store. Tasks can be claimed and executed by agents.',
    {
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      capability: z.string().optional().describe('Required capability (for agent matching)'),
      assignee_id: z.string().optional().describe('Directly assign to a specific agent'),
      schedule_type: z
        .enum(['once', 'interval', 'cron'])
        .optional()
        .describe('Schedule type for recurring tasks'),
      schedule_at: z.string().optional().describe('ISO 8601 date for one-shot delayed task'),
      schedule_cron: z.string().optional().describe('Cron expression for recurring tasks'),
      interval_ms: z.number().optional().describe('Interval in milliseconds for interval tasks'),
      budget: z.number().optional().describe('Credit budget for task execution'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { title: args.title };
        if (args.description) body.description = args.description;
        if (args.capability) body.capability = args.capability;
        if (args.assignee_id) body.assigneeId = args.assignee_id;
        if (args.schedule_type) body.scheduleType = args.schedule_type;
        if (args.schedule_at) body.scheduleAt = args.schedule_at;
        if (args.schedule_cron) body.scheduleCron = args.schedule_cron;
        if (args.interval_ms) body.intervalMs = args.interval_ms;
        if (args.budget) body.budget = args.budget;

        const result = (await prismerFetch('/api/im/tasks', {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Task creation failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Task Created\n\n`;
        text += `- **ID:** \`${data?.id || 'unknown'}\`\n`;
        text += `- **Title:** ${args.title}\n`;
        if (args.description) text += `- **Description:** ${args.description}\n`;
        if (args.capability) text += `- **Capability:** ${args.capability}\n`;
        if (data?.status) text += `- **Status:** ${data.status}\n`;
        if (args.assignee_id) text += `- **Assignee:** \`${args.assignee_id}\`\n`;
        if (args.schedule_type) text += `- **Schedule:** ${args.schedule_type}\n`;
        if (args.budget) text += `- **Budget:** ${args.budget} credits\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

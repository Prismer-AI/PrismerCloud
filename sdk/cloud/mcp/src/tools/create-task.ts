import { z } from 'zod';
import { formatMcpToolError, prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCreateTask(server: McpServer) {
  server.tool(
    'prismer.task.create',
    'Create a Prismer Workspace task. Use kind=work_item for Kanban cards that need a concrete deliverable, and kind=goal for durable standing objectives that should guide future agent behavior. Include description, capability, priority/due metadata when known.',
    {
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      capability: z.string().optional().describe('Required capability (for agent matching)'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Task priority for Workspace Kanban'),
      due_date: z.string().optional().describe('Optional ISO 8601 due date shown on Workspace task cards'),
      assignee_id: z.string().optional().describe('Directly assign to a specific agent'),
      assignee_name: z
        .string()
        .optional()
        .describe('Assign to an agent by @username/slug or display name when the exact agent id is not known'),
      workspace_id: z
        .string()
        .optional()
        .describe('Workspace ID. If omitted, uses PRISMER_WORKSPACE_ID from the daemon runtime.'),
      kind: z
        .enum(['work_item', 'goal'])
        .optional()
        .describe(
          'Board projection kind. work_item = a normal kanban card. goal = a long-running standing objective. Default work_item — appears on the workspace Task Board.',
        ),
      conversation_id: z
        .string()
        .optional()
        .describe('Pin the task to a specific conversation/session so the chat surface can link back to it.'),
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
        // description is the single source of truth for "what the agent (and
        // human) should do" — server-side dispatch reads it directly. We no
        // longer mirror into `body.input.prompt`; cf. v19x-helpers.ts.
        if (args.description) body.description = args.description;
        if (args.capability) body.capability = args.capability;
        const taskKind = args.kind ?? 'work_item';
        const workspaceId = args.workspace_id || process.env.PRISMER_WORKSPACE_ID || '';
        if (!workspaceId) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'Error: workspace_id was not provided and PRISMER_WORKSPACE_ID is not configured in the daemon MCP environment. Refusing to create an unscoped Kanban task.',
              },
            ],
          };
        }
        const assigneeId =
          args.assignee_id ||
          (args.assignee_name ? await resolveAssigneeId(args.assignee_name, workspaceId) : '') ||
          (!args.assignee_name && taskKind === 'work_item'
            ? await inferAssigneeId(`${args.title}\n${args.description ?? ''}`, workspaceId)
            : '');
        if (args.assignee_name && !assigneeId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: assignee_name "${args.assignee_name}" did not resolve to an agent. Use a visible agent username/display name or pass assignee_id explicitly.`,
              },
            ],
          };
        }
        if (taskKind === 'work_item' && !assigneeId) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'Error: work_item tasks must be assigned to a concrete agent. Pass assignee_id/assignee_name, or mention exactly one visible agent username/display name in the title or description.',
              },
            ],
          };
        }
        if (assigneeId) body.assigneeId = assigneeId;
        body.workspaceId = workspaceId;
        if (args.conversation_id) body.conversationId = args.conversation_id;
        if (args.schedule_type) body.scheduleType = args.schedule_type;
        if (args.schedule_at) body.scheduleAt = args.schedule_at;
        if (args.schedule_cron) body.scheduleCron = args.schedule_cron;
        if (args.interval_ms) body.intervalMs = args.interval_ms;
        if (args.budget) body.budget = args.budget;
        // Default to work_item so agent-created tasks land on the Workspace
        // Kanban (cloud's isBoardProjectionTask filter accepts work_item|goal).
        // Without this, agent tasks default to no `kind` and stay invisible.
        body.metadata = {
          kind: taskKind,
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.due_date ? { dueDate: args.due_date } : {}),
          ...(args.conversation_id ? { context: { linkedConversationId: args.conversation_id } } : {}),
          ...(taskKind === 'goal'
            ? {
                intent: 'standing_objective',
                goal: {
                  status: 'active',
                  priority: args.priority === 'urgent' ? 'high' : (args.priority ?? 'medium'),
                  linkedConversationIds: args.conversation_id ? [args.conversation_id] : [],
                  linkedTaskIds: [],
                  lastActivityAt: new Date().toISOString(),
                },
              }
            : {}),
        };

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
        if (args.priority) text += `- **Priority:** ${args.priority}\n`;
        if (args.due_date) text += `- **Due:** ${args.due_date}\n`;
        if (data?.status) text += `- **Status:** ${data.status}\n`;
        text += `- **Workspace:** \`${workspaceId}\`\n`;
        if (args.conversation_id) text += `- **Conversation:** \`${args.conversation_id}\`\n`;
        if (assigneeId) text += `- **Assignee:** \`${assigneeId}\`\n`;
        if (args.schedule_type) text += `- **Schedule:** ${args.schedule_type}\n`;
        if (args.budget) text += `- **Budget:** ${args.budget} credits\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = formatMcpToolError(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

async function listWorkspaceAgents(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const result = (await prismerFetch('/api/im/agents', {
    method: 'GET',
    query: { workspaceId },
  })) as Record<string, unknown>;
  return Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : [];
}

async function inferAssigneeId(text: string, workspaceId: string): Promise<string> {
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText) return '';

  const agents = await listWorkspaceAgents(workspaceId);
  const matches = agents.filter((agent) => {
    const labels = [agent.username, agent.name, agent.displayName]
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter(Boolean);
    return labels.some((label) => normalizedText.includes(label) || normalizedText.includes(`@${label}`));
  });
  const uniqueIds = [...new Set(matches.map((agent) => agent.userId).filter((value): value is string => typeof value === 'string'))];
  return uniqueIds.length === 1 ? uniqueIds[0]! : '';
}

async function resolveAssigneeId(name: string, workspaceId: string): Promise<string> {
  const needle = name.trim().toLowerCase();
  const normalizedNeedle = needle.replace(/^@/, '');
  if (!needle) return '';

  const agents = await listWorkspaceAgents(workspaceId);
  const exact = agents.find((agent) => {
    const values = [agent.userId, agent.agentId, agent.username, agent.name, agent.displayName].map((value) =>
      typeof value === 'string' ? value.trim().toLowerCase() : '',
    );
    return values.includes(needle) || values.includes(normalizedNeedle);
  });
  if (exact) {
    const userId = exact.userId;
    return typeof userId === 'string' ? userId : '';
  }

  const fuzzy = agents.find((agent) => {
    const labels = [agent.username, agent.name, agent.displayName]
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter(Boolean);
    return labels.some((label) => label.includes(normalizedNeedle) || normalizedNeedle.includes(label));
  });
  const userId = fuzzy?.userId;
  return typeof userId === 'string' ? userId : '';
}

import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRequestHumanApproval(server: McpServer) {
  server.tool(
    'prismer.approval.request_human_approval',
    'Request a structured human decision for a destructive, irreversible, or policy-sensitive action. The current turn should stop after this request; the platform redispatches after a decision.',
    {
      workspace_id: z.string().optional().describe('Workspace ID. Optional when task_id or conversation_id can derive it.'),
      conversation_id: z.string().optional().describe('Conversation where the approval card should appear.'),
      task_id: z.string().optional().describe('Task or run ID associated with the approval.'),
      category: z.string().default('general').describe('Approval category, such as delete, deploy, spend, access, or general.'),
      title: z.string().describe('Short human-readable decision title.'),
      context: z.string().optional().describe('Relevant context and consequences for the reviewer.'),
      options: z
        .array(
          z.object({
            value: z.string(),
            label: z.string(),
            hint: z.string().optional(),
          }),
        )
        .optional()
        .describe('Decision options. Defaults to approve/reject.'),
      expires_in_seconds: z.number().int().positive().optional().describe('Optional expiry window in seconds.'),
      metadata: z.record(z.unknown()).optional().describe('Optional opaque metadata persisted with the approval.'),
    },
    async (args) => {
      try {
        const workspaceId = args.workspace_id || process.env.PRISMER_WORKSPACE_ID || undefined;
        const result = (await prismerFetch('/api/im/approvals', {
          method: 'POST',
          toolName: 'prismer.approval.request_human_approval',
          body: {
            workspaceId,
            conversationId: args.conversation_id,
            taskId: args.task_id,
            category: args.category,
            title: args.title,
            context: args.context,
            options: args.options,
            expiresInSeconds: args.expires_in_seconds,
            metadata: args.metadata,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Approval request failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Approval Requested\n\n`;
        text += `- **Approval ID:** \`${data?.id || 'unknown'}\`\n`;
        text += `- **Title:** ${args.title}\n`;
        text += `- **Status:** pending\n`;
        text += `\nStop this turn and wait for the platform to redispatch after the human decision.`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

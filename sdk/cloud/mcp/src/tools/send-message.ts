import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSendMessage(server: McpServer) {
  server.tool(
    'prismer.message.send',
    'Send a direct message to another agent or user on Prismer IM. Use prismer.agent.discover first to find agent IDs. Cross-workspace targets require an active external contact edge (cloud im contacts --external): without one the send returns deferred with an approvalId — the message waits for contact approval, so report it as awaiting approval, never as sent.',
    {
      userId: z.string().describe('Target user/agent ID (from prismer.agent.discover results)'),
      content: z.string().describe('Message content to send'),
      type: z
        .enum([
          'text',
          'markdown',
          'code',
          'image',
          'file',
          'voice',
          'location',
          'artifact',
          'tool_call',
          'tool_result',
          'system_event',
          'system',
          'thinking',
        ])
        .optional()
        .describe(
          'Message type: text (default), markdown, code, image, file, voice, location, artifact, tool_call, tool_result, system_event, system, or thinking'
        ),
      metadata: z.record(z.any()).optional().describe('Optional metadata to attach to the message'),
    },
    async ({ userId, content, type, metadata }) => {
      try {
        const body: Record<string, unknown> = { content };
        if (type) body.type = type;
        if (metadata) body.metadata = metadata;

        const result = (await prismerFetch(`/api/im/direct/${userId}/messages`, {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Send failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        // h-contact-system-refactor §9-SDK — 202 ACTION_DEFERRED：等待联系人审批，
        // 不得报 sent（消息 hold 在审批侧，批准后重新发送）。
        if (data?.deferred === true) {
          const approvalId = (data.approvalId as string | null | undefined) ?? 'n/a';
          return {
            content: [{
              type: 'text' as const,
              text: `Message deferred — awaiting contact approval (approvalId: ${approvalId}). Resend after approval.`,
            }],
          };
        }
        const message = data?.message as Record<string, unknown> | undefined;
        return {
          content: [{
            type: 'text' as const,
            text: `Message sent to ${userId}.\nMessage ID: ${message?.id || 'unknown'}\nConversation: ${message?.conversationId || 'unknown'}`,
          }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

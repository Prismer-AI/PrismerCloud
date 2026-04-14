import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSendMessage(server: McpServer) {
  server.tool(
    'send_message',
    'Send a direct message to another agent or user on Prismer IM. Use discover_agents first to find agent IDs.',
    {
      userId: z.string().describe('Target user/agent ID (from discover_agents results)'),
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

import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityNotifications(server: McpServer) {
  server.tool(
    'community_notifications',
    'List community notifications (replies, votes, best answer) and optionally mark as read.',
    {
      unreadOnly: z.boolean().optional().describe('Only unread notifications'),
      limit: z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().optional()).describe('Max items (default 20)'),
      markRead: z
        .enum(['none', 'all', 'one'])
        .optional()
        .describe('After listing: none (default), all, or one (requires notificationId)'),
      notificationId: z.string().optional().describe('When markRead=one, the notification id to mark read'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.unreadOnly) query.unread = 'true';
        if (args.limit != null) query.limit = String(args.limit);

        const list = (await prismerFetch('/api/im/community/notifications', { query })) as Record<string, unknown>;
        if (!list.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${(list.error as string) || 'List failed'}` }] };
        }

        let text = '## Community notifications\n\n';
        const payload = list.data as { items?: Array<Record<string, unknown>>; total?: number } | undefined;
        const data = payload?.items ?? [];
        if (data.length > 0) {
          for (const n of data) {
            text += `- **${String(n.type || '')}** — ${String(n.postTitle || n.postId || '')} (${String(n.id || '')}) ${n.read ? '✓' : '○'}\n`;
          }
          if (payload?.total != null) text += `\n_Total (unfiltered): ${payload.total}_\n`;
        } else {
          text += '_No notifications._\n';
        }

        if (args.markRead === 'all') {
          const mr = (await prismerFetch('/api/im/community/notifications/read', {
            method: 'POST',
            body: {},
          })) as Record<string, unknown>;
          text += `\n**Marked read:** ${mr.ok ? JSON.stringify(mr.data) : String(mr.error)}\n`;
        } else if (args.markRead === 'one' && args.notificationId) {
          const mr = (await prismerFetch('/api/im/community/notifications/read', {
            method: 'POST',
            body: { notificationId: args.notificationId },
          })) as Record<string, unknown>;
          text += `\n**Marked one:** ${mr.ok ? 'ok' : String(mr.error)}\n`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

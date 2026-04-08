import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityProfileMcp(server: McpServer) {
  server.tool(
    'community_profile',
    'Get public community profile for a user/agent ID (posts stats, bio, heatmap metadata).',
    {
      userId: z.string().describe('IM user / agent ID'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch(`/api/im/community/profile/${encodeURIComponent(args.userId)}`)) as Record<
          string,
          unknown
        >;
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${(result.error as string) || 'Profile failed'}` }] };
        }
        let text = `## Community profile: \`${args.userId}\`\n\n`;
        text += '```json\n' + JSON.stringify(result.data, null, 2) + '\n```\n';
        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

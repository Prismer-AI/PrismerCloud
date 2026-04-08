import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityFollow(server: McpServer) {
  server.tool(
    'community_follow',
    'Follow or unfollow a user, agent, gene, or board (toggle — same endpoint; authenticated).',
    {
      followingId: z.string().describe('Target ID to follow/unfollow'),
      followingType: z.enum(['user', 'agent', 'gene', 'board']).describe('Target type'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/community/follow', {
          method: 'POST',
          body: { followingId: args.followingId, followingType: args.followingType },
        })) as Record<string, unknown>;
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${(result.error as string) || 'Follow failed'}` }] };
        }
        const data = result.data as { followed?: boolean } | undefined;
        const state = data?.followed ? 'Now following' : 'Unfollowed';
        return { content: [{ type: 'text' as const, text: `## ${state}\n\n**${args.followingType}** \`${args.followingId}\`` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

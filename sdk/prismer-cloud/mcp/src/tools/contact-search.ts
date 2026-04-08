import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerContactSearch(server: McpServer) {
  server.tool(
    'contact_search',
    'Search for users or agents by name, username, or description. Use to find people before sending a friend request.',
    {
      query: z.string().describe('Search query (name, username, or description)'),
      type: z.enum(['human', 'agent', 'all']).optional().describe('Filter by user type (default: "all")'),
      limit: z.number().optional().describe('Max results to return (default: 20)'),
    },
    async (args) => {
      try {
        const params: Record<string, string> = { q: args.query };
        if (args.type && args.type !== 'all') params.type = args.type;
        if (args.limit) params.limit = String(args.limit);

        const result = (await prismerFetch('/api/im/discover', { query: params })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Search failed'}` }] };
        }

        const users = (result.data || []) as Record<string, unknown>[];
        if (users.length === 0) {
          return { content: [{ type: 'text' as const, text: `No users found for "${args.query}".` }] };
        }

        let text = `## Search Results (${users.length})\n\n`;
        for (const u of users) {
          text += `**${u.displayName}** (@${u.username}) — ID: \`${u.userId}\`\n`;
          if (u.role) text += `  Role: ${u.role}`;
          if (u.isAgent) text += ` (agent)`;
          text += '\n';
          if (u.description) text += `  ${u.description}\n`;
          if (u.isContact) text += `  ✓ Already a contact\n`;
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

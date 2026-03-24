import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveAchievements(server: McpServer) {
  server.tool(
    'evolve_achievements',
    'Get your evolution achievements and badges.',
    {},
    async () => {
      try {
        const result = (await prismerFetch('/api/im/evolution/achievements')) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Failed to fetch achievements'}` }] };
        }

        const achievements = (result.data || []) as Record<string, unknown>[];

        if (achievements.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No achievements earned yet. Keep evolving!' }] };
        }

        let text = `## Your Achievements (${achievements.length})\n\n`;
        for (const a of achievements) {
          const badge = a.badge as string || a.type as string || 'unknown';
          const label = a.label as string || a.name as string || badge;
          const earned = a.earnedAt as string || a.created_at as string || '';
          text += `- **${label}** (\`${badge}\`)`;
          if (earned) text += ` — earned ${earned}`;
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

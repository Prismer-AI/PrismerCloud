import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';

export function registerSkillSearch(server: McpServer) {
  server.tool(
    'skill_search',
    'Search the skill catalog. Find skills by keyword, category, or compatibility. Returns skill names, descriptions, install counts, and signals.',
    {
      query: z.string().optional().describe('Search keyword'),
      category: z.string().optional().describe('Filter by category (repair, optimize, coding, devops, etc.)'),
      compatibility: z.string().optional().describe('Filter by platform (claude-code, opencode, openclaw)'),
      limit: z.number().optional().default(10).describe('Max results (default: 10)'),
    },
    async ({ query, category, compatibility, limit }) => {
      try {
        const params = new URLSearchParams();
        if (query) params.set('query', query);
        if (category) params.set('category', category);
        if (compatibility) params.set('compatibility', compatibility);
        params.set('limit', String(limit || 10));

        const result = (await prismerFetch(`/api/im/skills/search?${params}`)) as Record<string, unknown>;

        if (!result.ok && !result.data) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Search failed'}` }] };
        }

        const skills = (result.data || []) as Array<Record<string, unknown>>;

        if (skills.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No skills found matching your criteria.' }] };
        }

        const lines: string[] = [`Found ${skills.length} skills:\n`];
        for (const s of skills) {
          lines.push(`**${s.name}** (\`${s.slug}\`)`);
          lines.push(`  ${s.description}`);
          lines.push(`  Category: ${s.category} | Installs: ${s.installs || 0} | Stars: ${s.stars || 0}`);

          // Show signals if present
          try {
            const signals = JSON.parse((s.signals as string) || '[]') as Array<string | Record<string, unknown>>;
            if (signals.length > 0) {
              const sigNames = signals.map((sig) =>
                typeof sig === 'string' ? sig : (sig.type as string) || String(sig)
              );
              lines.push(`  Signals: ${sigNames.join(', ')}`);
            }
          } catch {
            /* no signals */
          }

          lines.push(`  Install: \`prismer skill install ${s.slug}\`\n`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

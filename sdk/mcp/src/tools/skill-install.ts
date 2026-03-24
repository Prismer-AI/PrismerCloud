import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';

export function registerSkillInstall(server: McpServer) {
  server.tool(
    'skill_install',
    'Install a skill to your agent. Creates an evolution Gene from the skill\'s strategy, returns SKILL.md content and multi-platform install guides.',
    {
      slug: z.string().describe('Skill slug or ID (e.g., "timeout-recovery")'),
    },
    async ({ slug }) => {
      try {
        const result = (await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/install`, {
          method: 'POST',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Skill not found or install failed.'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        if (!data) {
          return { content: [{ type: 'text' as const, text: 'Skill not found or install failed.' }] };
        }

        const skill = data.skill as Record<string, unknown> | undefined;
        const gene = data.gene as Record<string, unknown> | undefined;
        const installGuide = data.installGuide as Record<string, unknown> | undefined;

        const lines: string[] = [`## Installed: ${skill?.name || slug}`];

        if (gene) {
          lines.push(`\n**Gene created:** \`${gene.id}\` (${gene.category})`);
          try {
            const steps = JSON.parse((gene.strategySteps as string) || '[]') as string[];
            if (steps.length > 0) {
              lines.push('\n**Strategy:**');
              steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
            }
          } catch {
            /* ignore parse errors */
          }
        } else {
          lines.push('\nNo Gene created (skill has no signal mappings).');
        }

        if (installGuide) {
          lines.push('\n**Install Guide:**');
          for (const [platform, guide] of Object.entries(installGuide)) {
            const g = guide as Record<string, unknown>;
            lines.push(`  ${platform}: ${g.auto || g.manual || g.command || JSON.stringify(g)}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

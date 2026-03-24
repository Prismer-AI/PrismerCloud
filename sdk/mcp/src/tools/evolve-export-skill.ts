import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveExportSkill(server: McpServer) {
  server.tool(
    'evolve_export_skill',
    'Export an evolution gene as a shareable skill in the catalog.',
    {
      geneId: z.string().describe('ID of the gene to export as a skill'),
      slug: z.string().optional().describe('Custom slug for the skill (auto-generated from gene ID if omitted)'),
      displayName: z.string().optional().describe('Display name for the skill (uses gene title if omitted)'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};
        if (args.slug) body.slug = args.slug;
        if (args.displayName) body.displayName = args.displayName;

        const result = (await prismerFetch(`/api/im/evolution/genes/${encodeURIComponent(args.geneId)}/export-skill`, {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Export failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        const skill = data.skill as Record<string, unknown> | undefined;

        let text = `## Gene Exported as Skill\n\n`;
        if (skill) {
          text += `**Skill:** ${skill.name} (\`${skill.slug}\`)\n`;
          text += `**Category:** ${skill.category}\n`;
          text += `**Version:** ${skill.version || '1.0.0'}\n`;
          if (skill.id) text += `**ID:** \`${skill.id}\`\n`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

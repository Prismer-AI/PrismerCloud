import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';

export function registerSkillContent(server: McpServer) {
  server.tool(
    'skill_content',
    'Get full content of a skill (SKILL.md markdown, package URL, file list). Use this to inspect a skill before installing.',
    {
      slug: z.string().describe('Skill slug or ID'),
    },
    async ({ slug }) => {
      try {
        const result = (await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/content`)) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Skill not found.'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        if (!data) {
          return { content: [{ type: 'text' as const, text: 'Skill not found.' }] };
        }

        const lines: string[] = [];

        if (data.content) {
          lines.push(data.content as string);
        }

        const files = data.files as Array<Record<string, unknown>> | undefined;
        if (files && files.length > 0) {
          lines.push(`\n---\n**Files (${files.length}):**`);
          for (const f of files) {
            lines.push(`  ${f.path}  (${f.size} bytes)`);
          }
        }

        if (data.packageUrl) lines.push(`\n**Package:** ${data.packageUrl}`);
        if (data.checksum) lines.push(`**Checksum:** ${data.checksum}`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

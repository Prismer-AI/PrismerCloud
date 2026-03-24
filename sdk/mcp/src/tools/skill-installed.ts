import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';

export function registerSkillInstalled(server: McpServer) {
  server.tool(
    'skill_installed',
    'List all skills currently installed for your agent, including associated Genes and versions.',
    {},
    async () => {
      try {
        const result = (await prismerFetch('/api/im/skills/installed')) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Failed to list installed skills.'}` }] };
        }

        const skills = (result.data || []) as Array<Record<string, unknown>>;

        if (skills.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No skills installed.' }] };
        }

        const lines: string[] = [`${skills.length} installed skills:\n`];
        for (const s of skills) {
          const sk = s.skill as Record<string, unknown> | undefined;
          const as_ = s.agentSkill as Record<string, unknown> | undefined;
          const gene = s.gene as Record<string, unknown> | undefined;
          lines.push(`**${sk?.name || '(unnamed)'}** (\`${sk?.slug || '-'}\`)`);
          lines.push(`  Version: ${as_?.version || '-'} | Status: ${as_?.status || '-'}`);
          if (gene) lines.push(`  Gene: \`${gene.id}\` (${gene.category})`);
          lines.push('');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

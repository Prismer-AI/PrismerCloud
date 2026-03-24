import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerMemoryRead(server: McpServer) {
  server.tool(
    'memory_read',
    'Read an agent\'s session memory (MEMORY.md auto-load). Returns memory content, metadata, and compaction template.',
    {
      scope: z.string().optional().default('global').describe('Memory scope (default: \'global\')'),
    },
    async ({ scope }) => {
      try {
        const query: Record<string, string> = {};
        if (scope) query.scope = scope;

        const result = (await prismerFetch('/api/im/memory/load', {
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Memory read failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Agent Memory\n\n`;
        text += `**Scope:** ${scope}\n\n`;

        if (data?.content) {
          text += `### Content\n\n${data.content}\n\n`;
        }

        if (data?.metadata) {
          const meta = data.metadata as Record<string, unknown>;
          text += `### Metadata\n\n`;
          if (meta.path) text += `- Path: \`${meta.path}\`\n`;
          if (meta.version) text += `- Version: ${meta.version}\n`;
          if (meta.size) text += `- Size: ${meta.size} bytes\n`;
          if (meta.updatedAt) text += `- Updated: ${meta.updatedAt}\n`;
        }

        if (data?.compaction_template) {
          text += `\n### Compaction Template\n\n\`\`\`\n${data.compaction_template}\n\`\`\`\n`;
        }

        if (!data?.content && !data?.metadata) {
          text += `No memory found for scope "${scope}".\n`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

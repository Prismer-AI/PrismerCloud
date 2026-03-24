import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerMemoryWrite(server: McpServer) {
  server.tool(
    'memory_write',
    'Write to an agent\'s episodic memory file. Upserts by (scope, path) - creates if not exists, updates if exists.',
    {
      path: z.string().describe('Memory file path (e.g., \'MEMORY.md\', \'user_prefs.md\')'),
      content: z.string().describe('Content to write'),
      scope: z.string().optional().default('global').describe('Memory scope (default: \'global\')'),
    },
    async ({ path, content, scope }) => {
      try {
        const result = (await prismerFetch('/api/im/memory/files', {
          method: 'POST',
          body: { path, content, scope },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Memory write failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Memory Written\n\n`;
        text += `- Path: \`${path}\`\n`;
        text += `- Scope: ${scope}\n`;
        if (data?.version) text += `- Version: ${data.version}\n`;
        if (data?.size) text += `- Size: ${data.size} bytes\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

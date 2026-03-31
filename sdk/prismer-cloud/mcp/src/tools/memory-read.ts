import { z } from 'zod';
import { prismerFetch, getScope } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerMemoryRead(server: McpServer) {
  server.tool(
    'memory_read',
    `Read from persistent memory. Retrieves knowledge saved in previous sessions for this project.
Memory is automatically scoped to the current project.
Omit path to read the main MEMORY.md index.`,
    {
      path: z.string().optional().describe('File to read (e.g., "gotchas.md"). Omit for main MEMORY.md'),
    },
    async ({ path }) => {
      const scope = getScope();
      try {
        const query: Record<string, string> = { scope };
        if (path) query.path = path;

        const result = (await prismerFetch('/api/im/memory/load', { query })) as Record<string, unknown>;

        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${result.error || 'Read failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        if (data?.content) {
          let text = String(data.content);
          if (data.version) text += `\n\n---\n_v${data.version}_`;
          return { content: [{ type: 'text' as const, text }] };
        }

        return { content: [{ type: 'text' as const, text: `No memory found at "${path || 'MEMORY.md'}"` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

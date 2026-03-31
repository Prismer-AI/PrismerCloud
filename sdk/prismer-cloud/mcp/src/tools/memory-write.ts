import { z } from 'zod';
import { prismerFetch, getScope } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerMemoryWrite(server: McpServer) {
  server.tool(
    'memory_write',
    `Save knowledge to persistent memory that survives across sessions.

When to use:
- Project-specific patterns or gotchas worth remembering
- Configuration quirks discovered during this session
- Lessons learned that would help future sessions on THIS project

Do NOT use for:
- General programming patterns (use evolve_create_gene instead — those help ALL agents)
- Temporary debugging state (just keep it in conversation)

Memory is automatically scoped to the current project — other projects won't see it.
Next session, this memory will be shown at startup.`,
    {
      path: z.string().describe('File path. Use "MEMORY.md" for the main index, or descriptive names like "db-setup-notes.md", "gotchas.md"'),
      content: z.string().describe('Markdown content to write'),
    },
    async ({ path, content }) => {
      const scope = getScope();
      try {
        const result = (await prismerFetch('/api/im/memory/files', {
          method: 'POST',
          body: { path, content, scope },
        })) as Record<string, unknown>;

        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${result.error || 'Write failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `Memory written: \`${path}\``;
        if (data?.version) text += ` (v${data.version})`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

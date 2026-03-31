import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerContextSave(server: McpServer) {
  server.tool(
    'context_save',
    'Store content in the global context cache. Other agents requesting the same URL will get it instantly for free.',
    {
      url: z.string().url().describe('URL to associate with the content'),
      content: z.string().describe('Compressed or processed content to cache'),
      title: z.string().optional().describe('Title for the cached content'),
      visibility: z
        .enum(['public', 'private', 'unlisted'])
        .optional()
        .describe('Visibility: public (anyone), private (only you), unlisted (with link). Default: private'),
      tags: z.array(z.string()).optional()
        .describe('Tags for search (e.g., ["timeout", "api", "recovery"])'),
    },
    async ({ url, content, title, visibility, tags }) => {
      try {
        const body: Record<string, unknown> = { url, hqcc: content };
        if (title) body.title = title;
        if (visibility) body.visibility = visibility;
        if (tags && tags.length > 0) body.tags = tags;

        const result = (await prismerFetch('/api/context/save', {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: `Saved to cache: ${url}\nVisibility: ${visibility || 'private'}\nContent URI: ${result.content_uri || 'N/A'}`,
            }],
          };
        }

        const err = result.error as Record<string, string> | undefined;
        return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Save failed'}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

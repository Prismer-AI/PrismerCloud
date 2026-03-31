import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerParse(server: McpServer) {
  server.tool(
    'parse_document',
    'Parse any PDF or image into markdown via OCR. Fast mode for clear text, HiRes for scans/handwriting.',
    {
      url: z.string().url().describe('URL of the document (PDF, PNG, JPG, TIFF, BMP, GIF, WEBP)'),
      mode: z
        .enum(['fast', 'hires'])
        .optional()
        .describe('OCR mode: fast (default, clear text) or hires (scans, handwriting, complex layouts)'),
    },
    async ({ url, mode }) => {
      try {
        const body: Record<string, unknown> = { url };
        if (mode) body.mode = mode;

        const result = (await prismerFetch('/api/parse', {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.success) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Parse failed'}` }] };
        }

        // Async task (large docs with hires mode)
        if (result.async && result.taskId) {
          const doc = result.document as Record<string, unknown> | undefined;
          return {
            content: [{
              type: 'text' as const,
              text: `Async parse started.\nTask ID: ${result.taskId}\nEstimated pages: ${doc?.pageCount || 'unknown'}\nEstimated time: ${doc?.estimatedTime || 'unknown'}s\n\nCheck status: GET /api/parse/status/${result.taskId}\nGet result: GET /api/parse/result/${result.taskId}`,
            }],
          };
        }

        // Sync result
        const doc = result.document as Record<string, unknown> | undefined;
        if (doc) {
          let text = doc.markdown as string || doc.text as string || '';
          const usage = result.usage as Record<string, unknown> | undefined;
          const cost = result.cost as Record<string, unknown> | undefined;
          if (usage || cost) {
            text += `\n\n---\nPages: ${usage?.inputPages || 'N/A'} | Cost: ${cost?.total || 0} credits`;
          }
          return { content: [{ type: 'text' as const, text }] };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

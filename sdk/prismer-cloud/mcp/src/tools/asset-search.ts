import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatMcpToolError } from '../lib/client.js';
import { localDaemonFetch } from '../lib/local-daemon.js';

export function registerAssetSearch(server: McpServer) {
  server.tool(
    'prismer.asset.search',
    'Search workspace asset metadata, or search within one text-like asset when uri is provided.',
    {
      workspaceId: z.string().optional().describe('Workspace ID. Defaults to PRISMER_WORKSPACE_ID when omitted.'),
      query: z.string().min(1).describe('Filename/content search query.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum metadata matches.'),
      uri: z.string().optional().describe('When set, searches inside this text-like asset instead of metadata.'),
    },
    async (args) => {
      try {
        const result = await localDaemonFetch('/local/asset/search', {
          toolName: 'prismer.asset.search',
          timeoutMs: 30_000,
          body: withDefaultWorkspace(args),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${formatMcpToolError(error)}` }] };
      }
    },
  );
}

function withDefaultWorkspace<T extends { workspaceId?: string; uri?: string }>(args: T): T {
  if (args.workspaceId || args.uri || !process.env.PRISMER_WORKSPACE_ID) return args;
  return { ...args, workspaceId: process.env.PRISMER_WORKSPACE_ID };
}

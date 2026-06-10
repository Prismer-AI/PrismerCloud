import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatMcpToolError } from '../lib/client.js';
import { localDaemonFetch } from '../lib/local-daemon.js';

const RefSchema = {
  workspaceId: z.string().optional().describe('Workspace ID. Defaults to PRISMER_WORKSPACE_ID when omitted.'),
  assetId: z.string().optional().describe('Cloud asset ID.'),
  contentHash: z.string().optional().describe('Asset content hash.'),
  uri: z.string().optional().describe('Canonical prismer://workspace/<workspaceId>/asset/<hash> URI.'),
};

export function registerAssetDescribe(server: McpServer) {
  server.tool(
    'prismer.asset.describe',
    'Describe a workspace asset from the local daemon metadata index without reading file bytes.',
    RefSchema,
    async (args) => {
      try {
        const result = await localDaemonFetch('/local/asset/describe', {
          toolName: 'prismer.asset.describe',
          body: withDefaultWorkspace(args),
        });
        return { content: [{ type: 'text' as const, text: formatJson(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Failed: ${formatMcpToolError(error)}` }] };
      }
    },
  );
}

function withDefaultWorkspace<T extends { workspaceId?: string }>(args: T): T {
  if (args.workspaceId || !process.env.PRISMER_WORKSPACE_ID) return args;
  return { ...args, workspaceId: process.env.PRISMER_WORKSPACE_ID };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

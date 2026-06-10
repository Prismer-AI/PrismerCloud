import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatMcpToolError } from '../lib/client.js';
import { localDaemonFetch } from '../lib/local-daemon.js';

const MAX_TOOL_READ_BYTES = 256 * 1024;

export function registerAssetRead(server: McpServer) {
  server.tool(
    'prismer.asset.read',
    'Read a bounded byte range from a workspace asset through the local daemon cache. Never use this to load a whole large file.',
    {
      workspaceId: z.string().optional().describe('Workspace ID. Defaults to PRISMER_WORKSPACE_ID when omitted.'),
      assetId: z.string().optional().describe('Cloud asset ID.'),
      contentHash: z.string().optional().describe('Asset content hash.'),
      uri: z.string().optional().describe('Canonical prismer://workspace/<workspaceId>/asset/<hash> URI.'),
      offset: z.number().int().min(0).optional().describe('Starting byte offset. Defaults to 0.'),
      length: z.number().int().min(1).max(MAX_TOOL_READ_BYTES).optional().describe('Bytes to read. Max 256 KiB.'),
    },
    async (args) => {
      try {
        const result = await localDaemonFetch('/local/asset/read', {
          toolName: 'prismer.asset.read',
          timeoutMs: 30_000,
          body: withDefaultWorkspace(args),
        });
        return { content: [{ type: 'text' as const, text: renderReadResult(result) }] };
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

function renderReadResult(value: unknown): string {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const content = typeof record.content === 'string' ? record.content : '';
  const encoding = typeof record.encoding === 'string' ? record.encoding : 'unknown';
  const locator = record.locator ? JSON.stringify(record.locator) : '{}';
  const truncated = record.truncated === true ? 'true' : 'false';
  if (encoding === 'utf8') {
    return [
      `locator: ${locator}`,
      `encoding: ${encoding}`,
      `truncated: ${truncated}`,
      '',
      content,
    ].join('\n');
  }
  return JSON.stringify(value, null, 2);
}

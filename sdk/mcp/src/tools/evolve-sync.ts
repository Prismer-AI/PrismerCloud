import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveSync(server: McpServer) {
  server.tool(
    'evolve_sync',
    'Sync evolution data: push local outcomes and pull remote updates. For offline-first agents.',
    {
      outcomes: z.array(z.object({
        gene_id: z.string(),
        signals: z.array(z.string()),
        outcome: z.enum(['success', 'failed']),
        summary: z.string(),
      })).optional().describe('Local outcomes to push to the server'),
      pullSince: z.number().optional().describe('Unix timestamp (ms) to pull changes since'),
      scope: z.string().optional().describe('Evolution scope (e.g. "project-x", "team-backend")'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {};

        if (args.outcomes && args.outcomes.length > 0) {
          body.push = { outcomes: args.outcomes };
        }

        body.pull = {
          since: args.pullSince || 0,
          ...(args.scope ? { scope: args.scope } : {}),
        };

        const query: Record<string, string> = {};
        if (args.scope) query.scope = args.scope;

        const result = (await prismerFetch('/api/im/evolution/sync', {
          method: 'POST',
          body,
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Sync failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        const pushed = data.pushed as Record<string, unknown> | undefined;
        const pulled = data.pulled as Record<string, unknown> | undefined;

        let text = `## Sync Complete\n\n`;

        if (pushed) {
          text += `**Pushed:** ${pushed.accepted} accepted`;
          const rejected = pushed.rejected as string[] | undefined;
          if (rejected && rejected.length > 0) {
            text += `, ${rejected.length} rejected`;
          }
          text += '\n';
        }

        if (pulled) {
          const genes = (pulled.genes as unknown[]) || [];
          const edges = (pulled.edges as unknown[]) || [];
          const promotions = (pulled.promotions as unknown[]) || [];
          const quarantines = (pulled.quarantines as unknown[]) || [];
          text += `**Pulled:** ${genes.length} genes, ${edges.length} edges`;
          if (promotions.length > 0) text += `, ${promotions.length} promotions`;
          if (quarantines.length > 0) text += `, ${quarantines.length} quarantines`;
          text += '\n';
          if (pulled.cursor) text += `**Cursor:** ${pulled.cursor}\n`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

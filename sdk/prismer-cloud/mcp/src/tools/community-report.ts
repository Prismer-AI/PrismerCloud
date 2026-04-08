import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityReport(server: McpServer) {
  server.tool(
    'community_report',
    'Publish a battle report or milestone to the community Showcase board. Automatically enriches with evolution metrics. Use after significant progress: ERR improvement, new badge, complex error resolution, or token savings.',
    {
      agentId: z.string().describe('Agent ID whose achievements to report'),
      agentName: z.string().describe('Display name of the agent'),
      title: z.string().describe('Report title (e.g. "Agent X — 95% success streak")'),
      summary: z.string().describe('Markdown summary of the achievement, strategy used, and key moments'),
      reportType: z.enum(['battleReport', 'milestone', 'experiment']).default('battleReport').describe('Type of report'),
      linkedGeneIds: z.array(z.string()).optional().describe('Gene IDs that contributed to this achievement'),
      linkedCapsuleIds: z.array(z.string()).optional().describe('Capsule IDs documenting the journey'),
      metrics: z.object({
        tokenSaved: z.number().optional(),
        successStreak: z.number().optional(),
        errImprovement: z.number().optional(),
        moneySaved: z.number().optional(),
      }).optional().describe('Quantitative metrics to highlight'),
      tags: z.array(z.string()).optional().describe('Tags for discoverability'),
    },
    async (args) => {
      try {
        let content = args.summary;
        if (args.metrics) {
          content += '\n\n## Metrics\n';
          if (args.metrics.tokenSaved) content += `- Token saved: ${args.metrics.tokenSaved.toLocaleString()}\n`;
          if (args.metrics.successStreak) content += `- Success streak: ${args.metrics.successStreak}\n`;
          if (args.metrics.errImprovement) content += `- ERR improvement: ${args.metrics.errImprovement}%\n`;
          if (args.metrics.moneySaved) content += `- Money saved: $${args.metrics.moneySaved.toFixed(2)}\n`;
        }
        if (args.linkedGeneIds?.length) {
          content += '\n## Genes Used\n';
          for (const gid of args.linkedGeneIds) {
            content += `- [[gene:${gid}]]\n`;
          }
        }

        const result = (await prismerFetch('/api/im/community/posts', {
          method: 'POST',
          body: {
            boardId: 'showcase',
            title: args.title,
            content,
            postType: args.reportType,
            tags: args.tags ?? ['battle-report'],
            linkedGeneIds: args.linkedGeneIds,
            linkedAgentId: args.agentId,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Report failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Battle Report Published\n\n`;
        text += `- **Post ID:** ${data.id}\n`;
        text += `- **Title:** ${args.title}\n`;
        text += `- **Agent:** ${args.agentName}\n`;
        text += `- **Board:** showcase\n`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

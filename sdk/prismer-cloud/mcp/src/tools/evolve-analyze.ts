import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEvolveAnalyze(server: McpServer) {
  server.tool(
    'evolve_analyze',
    'Analyze task context signals and get evolution advice — which Gene (strategy) to apply. Uses the agent\'s memory graph for selection.',
    {
      task_status: z.string().optional().describe('Task status: "completed" or "failed"'),
      task_capability: z.string().optional().describe('Task capability (e.g. "search", "translate")'),
      error: z.string().optional().describe('Error message if task failed'),
      tags: z.array(z.string()).optional().describe('Context tags'),
      signals: z.preprocess(
        (val) => {
          if (typeof val === 'string') {
            try { return JSON.parse(val); } catch { return [val]; }
          }
          return val;
        },
        z.union([
          z.array(z.string()),
          z.array(z.object({
            type: z.string(),
            provider: z.string().optional(),
            stage: z.string().optional(),
            severity: z.string().optional(),
          })),
        ]),
      ).optional().describe('Signals: string[] (legacy) or SignalTag[] (v0.3.0). SignalTag = {type, provider?, stage?, severity?}'),
      provider: z.string().optional().describe('Default provider for extracted signals (e.g. "openai", "k8s")'),
      stage: z.string().optional().describe('Default pipeline stage (e.g. "fetch", "deploy", "rollout")'),
      severity: z.string().optional().describe('Default severity: "low" | "medium" | "high" | "critical"'),
      scope: z.string().optional().describe('Evolution scope to partition gene pools (e.g. "project-x", "team-backend")'),
    },
    async (args) => {
      try {
        const normalizedSignals = args.signals;
        const query: Record<string, string> = {};
        if (args.scope) query.scope = args.scope;
        const result = (await prismerFetch('/api/im/evolution/analyze', {
          method: 'POST',
          body: {
            task_status: args.task_status,
            task_capability: args.task_capability,
            error: args.error,
            tags: args.tags,
            signals: normalizedSignals,
            provider: args.provider,
            stage: args.stage,
            severity: args.severity,
          },
          query,
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Analysis failed'}` }] };
        }

        const data = result.data as Record<string, unknown>;
        let text = `## Evolution Advice\n\n`;
        text += `**Action:** ${data.action}\n`;
        text += `**Confidence:** ${data.confidence}\n`;
        if (data.gene_id) text += `**Gene ID:** \`${data.gene_id}\`\n`;
        if (data.strategy) text += `**Strategy:** ${JSON.stringify(data.strategy)}\n`;
        if (data.reason) text += `**Reason:** ${data.reason}\n`;
        if (data.signals) text += `**Signals:** ${JSON.stringify(data.signals)}\n`;

        const memories = data.relatedMemories as Array<{ path: string; snippet: string; relevance: number }> | undefined;
        if (memories && memories.length > 0) {
          text += `\n### Related Memories\n`;
          for (const m of memories) {
            text += `- **${m.path}** (relevance: ${Math.round(m.relevance * 100)}%): ${m.snippet.slice(0, 100)}...\n`;
          }
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * product204/09 §2.4 — skill-config inquiry. When a skill you are executing
 * declares REQUIRED configuration (see the "Skill configuration" section of
 * your context) and a key is missing from your environment, call this ONCE
 * with the skill slug + missing keys, then STOP the current turn. The
 * platform notifies the owner, they fill the values in the agent profile
 * settings, and you are redispatched with the values injected as env vars.
 * NEVER invent placeholder values instead of asking.
 */
export function registerRequestSkillConfig(server: McpServer) {
  server.tool(
    'prismer.config.request_skill_config',
    'Ask the owner to supply missing skill configuration values. Use when a skill declares required config keys that are absent from your environment. Stop the current turn after calling; the platform redispatches you once the owner saves the values.',
    {
      skill_slug: z.string().describe('Slug of the skill whose configuration is missing.'),
      keys: z.array(z.string()).min(1).describe('The missing config keys (env var names) declared by the skill.'),
      task_id: z.string().optional().describe('Current task or run ID (from PRISMER_TASK_ID / PRISMER_RUN_ID) so the platform can redispatch it.'),
      conversation_id: z.string().optional().describe('Conversation the inquiry notice should be associated with.'),
      workspace_id: z.string().optional().describe('Workspace ID. Optional when task_id or conversation_id can derive it.'),
    },
    async (args) => {
      try {
        const workspaceId = args.workspace_id || process.env.PRISMER_WORKSPACE_ID || undefined;
        const taskId = args.task_id || process.env.PRISMER_TASK_ID || process.env.PRISMER_RUN_ID || undefined;
        const conversationId = args.conversation_id || process.env.PRISMER_CONVERSATION_ID || undefined;
        const result = (await prismerFetch('/api/im/skill-config/requests', {
          method: 'POST',
          toolName: 'prismer.config.request_skill_config',
          body: {
            skillSlug: args.skill_slug,
            keys: args.keys,
            taskId,
            conversationId,
            workspaceId,
          },
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error;
          const msg = typeof err === 'object' && err ? (err as any).message : err;
          return { content: [{ type: 'text' as const, text: `Error: ${msg || 'Skill config request failed'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        let text = `## Skill Configuration Requested\n\n`;
        text += `- **Request ID:** \`${data?.id || 'unknown'}\`\n`;
        text += `- **Skill:** ${args.skill_slug}\n`;
        text += `- **Keys:** ${args.keys.join(', ')}\n`;
        text += `- **Status:** pending\n`;
        text += `\nStop this turn now. The platform notifies your owner; once they save the values you will be redispatched with them injected into your environment.`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    },
  );
}

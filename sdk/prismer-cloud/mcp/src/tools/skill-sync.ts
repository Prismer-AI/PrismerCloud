import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function registerSkillSync(server: McpServer) {
  server.tool(
    'skill_sync',
    'Sync cloud-installed skills to local filesystem. Downloads SKILL.md files for skills installed on the server but missing locally.',
    {
      platform: z.enum(['claude-code', 'opencode', 'openclaw', 'all']).optional().describe('Target platform (default: claude-code)'),
    },
    async (args) => {
      try {
        const result = (await prismerFetch('/api/im/skills/installed')) as Record<string, unknown>;
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${result.error || 'Failed to fetch installed skills'}` }] };
        }

        const entries = (result.data || []) as Array<{ skill: Record<string, unknown> }>;
        if (entries.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No skills installed.' }] };
        }

        const home = homedir();
        const platform = args.platform || 'claude-code';
        const platformDirs: Record<string, string> = {
          'claude-code': join(home, '.claude', 'skills'),
          'opencode': join(home, '.config', 'opencode', 'skills'),
          'openclaw': join(home, '.openclaw', 'skills'),
        };

        const targets = platform === 'all' ? Object.values(platformDirs) : [platformDirs[platform] || platformDirs['claude-code']];
        let synced = 0;
        let skipped = 0;

        for (const entry of entries) {
          const skill = entry.skill;
          const slug = String(skill.slug || skill.id || '').replace(/[^a-z0-9_-]/gi, '-');
          if (!slug) continue;

          // Fetch content
          let content = '';
          try {
            const contentRes = (await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/content`)) as Record<string, unknown>;
            const data = contentRes.data as Record<string, unknown> | undefined;
            content = String(data?.content || '');
          } catch { continue; }

          if (!content) { skipped++; continue; }

          for (const dir of targets) {
            const skillDir = join(dir, slug);
            const filePath = join(skillDir, 'SKILL.md');
            if (existsSync(filePath)) { skipped++; continue; }
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(filePath, content, 'utf-8');
            synced++;
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Skill sync complete: ${synced} written, ${skipped} skipped (already exist or no content). ${entries.length} installed skill(s).`,
          }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';
import { renderForClaudeCode, renderForOpenCode, renderForOpenClaw } from '../renderers.js';
import type { LocalFile } from '../renderers.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export function registerSkillSync(server: McpServer) {
  server.tool(
    'skill_sync',
    'Sync installed skills from Prismer Cloud to local filesystem',
    {
      platform: z.enum(['claude-code', 'opencode', 'openclaw', 'all']).optional()
        .describe('Target platform (default: claude-code)'),
      scope: z.preprocess(
        v => (v === '' || v === null ? undefined : v),
        z.string().optional().describe('Workspace scope. Default: auto-detected or "global"'),
      ),
    },
    async (args) => {
      const platform = args.platform || 'claude-code';
      const scope = args.scope || process.env.PRISMER_SCOPE || 'global';

      const renderers: Record<string, typeof renderForClaudeCode> = {
        'claude-code': renderForClaudeCode,
        'opencode': renderForOpenCode,
        'openclaw': renderForOpenClaw,
      };

      let localFiles: LocalFile[] = [];
      let usedLegacy = false;

      // Try Workspace API first
      try {
        const wsData = await prismerFetch('/api/im/workspace', {
          query: { scope, slots: 'strategies' },
        }) as { data?: { strategies?: unknown[]; scope: string } };

        if (wsData?.data?.strategies?.length) {
          if (platform === 'all') {
            for (const r of Object.values(renderers)) {
              localFiles.push(...r(wsData.data as any));
            }
          } else {
            const render = renderers[platform] || renderers['claude-code'];
            localFiles = render(wsData.data as any);
          }
        }
      } catch (e: any) {
        if (e.message?.includes('404') || e.message?.includes('Not Found')) {
          usedLegacy = true;
        } else {
          throw e;
        }
      }

      // Fallback: legacy installed → per-skill content
      if (usedLegacy || localFiles.length === 0) {
        usedLegacy = true;
        const installed = await prismerFetch('/api/im/skills/installed') as {
          data?: { skills?: Array<{ skill?: { slug: string }; slug?: string }> } | Array<{ skill?: { slug: string }; slug?: string }>;
        };
        const skills = Array.isArray(installed?.data) ? installed.data : ((installed?.data as any)?.skills || []);

        for (const entry of skills) {
          const slug = (entry as any).skill?.slug || (entry as any).slug;
          if (!slug) continue;
          const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '');
          try {
            const contentData = await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/content`) as { data?: { content?: string } };
            if (contentData?.data?.content) {
              localFiles.push({
                relativePath: `skills/${safeSlug}/SKILL.md`,
                content: contentData.data.content,
                meta: { sourceSlot: 'legacy', sourceId: slug, scope, checksum: '' },
              });
            }
          } catch { /* skip individual failures */ }
        }
      }

      // Write to platform targets
      const home = homedir();
      const targetDirs: string[] = [];

      if (platform === 'all' || platform === 'claude-code') {
        targetDirs.push(join(home, '.claude'));
      }
      if (platform === 'all' || platform === 'opencode') {
        targetDirs.push(join(home, '.config', 'opencode'));
      }
      if (platform === 'all' || platform === 'openclaw') {
        targetDirs.push(join(home, '.openclaw', 'workspace'));
      }

      let synced = 0;
      let skipped = 0;
      for (const file of localFiles) {
        for (const dir of targetDirs) {
          const filePath = join(dir, file.relativePath);
          if (existsSync(filePath) && !file.meta.checksum) { skipped++; continue; }
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, file.content, 'utf-8');
          synced++;
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Synced ${synced} skill file(s), skipped ${skipped}. Total installed: ${localFiles.length}.${usedLegacy ? ' (legacy fallback)' : ''}`,
        }],
      };
    },
  );
}

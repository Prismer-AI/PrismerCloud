import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface PlatformTarget {
  name: string;
  dir: string;
}

function detectPlatforms(slug: string): PlatformTarget[] {
  const home = os.homedir();
  const platforms: PlatformTarget[] = [];

  const candidates: PlatformTarget[] = [
    { name: 'Claude Code', dir: path.join(home, '.claude', 'skills', slug) },
    { name: 'OpenClaw', dir: path.join(home, '.openclaw', 'skills', slug) },
    { name: 'OpenCode', dir: path.join(home, '.config', 'opencode', 'skills', slug) },
  ];

  for (const c of candidates) {
    // Check if the parent platform directory exists (e.g. ~/.claude/)
    const platformRoot = path.dirname(path.dirname(c.dir));
    if (fs.existsSync(platformRoot)) {
      platforms.push(c);
    }
  }

  // Claude Code Plugin: check PRISMER_PLUGIN_DIR env var or auto-detect
  const pluginDir = process.env.PRISMER_PLUGIN_DIR;
  if (pluginDir) {
    platforms.push({ name: 'Claude Code Plugin', dir: path.join(pluginDir, 'skills', slug) });
  } else {
    const pluginCandidate = path.join(home, '.claude', 'plugins', 'prismer');
    if (fs.existsSync(path.join(pluginCandidate, '.claude-plugin', 'plugin.json'))) {
      platforms.push({ name: 'Claude Code Plugin', dir: path.join(pluginCandidate, 'skills', slug) });
    }
  }

  // Default to Claude Code if no platform detected
  if (platforms.length === 0) {
    platforms.push(candidates[0]);
  }

  return platforms;
}

/** Sanitize a slug to prevent directory traversal attacks. */
function safeSlug(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, '-');
}

function writeSkillLocally(slug: string, content: string): string[] {
  const safe = safeSlug(slug);
  if (!safe) return [`Skipped: invalid slug "${slug}"`];
  const platforms = detectPlatforms(safe);
  const results: string[] = [];

  for (const p of platforms) {
    try {
      fs.mkdirSync(p.dir, { recursive: true });
      const filePath = path.join(p.dir, 'SKILL.md');
      fs.writeFileSync(filePath, content, 'utf-8');
      results.push(`${p.name}: ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${p.name}: write failed — ${msg}`);
    }
  }

  return results;
}

export function registerSkillInstall(server: McpServer) {
  server.tool(
    'skill_install',
    'Install a skill to your agent. Creates an evolution Gene from the skill\'s strategy, returns SKILL.md content and multi-platform install guides.',
    {
      slug: z.string().describe('Skill slug or ID (e.g., "timeout-recovery")'),
    },
    async ({ slug }) => {
      try {
        const result = (await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/install`, {
          method: 'POST',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Skill not found or install failed.'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        if (!data) {
          return { content: [{ type: 'text' as const, text: 'Skill not found or install failed.' }] };
        }

        const skill = data.skill as Record<string, unknown> | undefined;
        const gene = data.gene as Record<string, unknown> | undefined;
        const installGuide = data.installGuide as Record<string, unknown> | undefined;

        const lines: string[] = [`## Installed: ${skill?.name || slug}`];

        if (gene) {
          lines.push(`\n**Gene created:** \`${gene.id}\` (${gene.category})`);
          try {
            const steps = JSON.parse((gene.strategySteps as string) || '[]') as string[];
            if (steps.length > 0) {
              lines.push('\n**Strategy:**');
              steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
            }
          } catch {
            /* ignore parse errors */
          }
        } else {
          lines.push('\nNo Gene created (skill has no signal mappings).');
        }

        if (installGuide) {
          lines.push('\n**Install Guide:**');
          for (const [platform, guide] of Object.entries(installGuide)) {
            const g = guide as Record<string, unknown>;
            lines.push(`  ${platform}: ${g.auto || g.manual || g.command || JSON.stringify(g)}`);
          }
        }

        // Write SKILL.md to local filesystem
        let skillContent = (skill?.content as string) || '';

        // If content is empty, fetch it from the content endpoint
        if (!skillContent) {
          try {
            const contentResult = (await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/content`, {
              method: 'GET',
            })) as Record<string, unknown>;
            if (contentResult.ok) {
              const contentData = contentResult.data as Record<string, unknown> | undefined;
              skillContent = (contentData?.content as string) || '';
            }
          } catch {
            /* ignore content fetch errors */
          }
        }

        if (skillContent) {
          const writeResults = writeSkillLocally(slug, skillContent);
          lines.push('\n**Local SKILL.md written:**');
          writeResults.forEach(r => lines.push(`  - ${r}`));
        } else {
          lines.push('\n**Local SKILL.md:** skipped (no content available)');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

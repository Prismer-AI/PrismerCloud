import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismerFetch } from '../lib/client.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Sanitize a slug to prevent directory traversal attacks. */
function safeSlug(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, '-');
}

function removeSkillLocally(slug: string): string[] {
  const safe = safeSlug(slug);
  if (!safe) return [`Skipped: invalid slug "${slug}"`];

  const home = os.homedir();
  const results: string[] = [];

  const candidates = [
    { name: 'Claude Code', dir: path.join(home, '.claude', 'skills', safe) },
    { name: 'OpenClaw', dir: path.join(home, '.openclaw', 'skills', safe) },
    { name: 'OpenCode', dir: path.join(home, '.config', 'opencode', 'skills', safe) },
  ];

  // Claude Code Plugin: check PRISMER_PLUGIN_DIR env var or auto-detect
  const pluginDir = process.env.PRISMER_PLUGIN_DIR;
  if (pluginDir) {
    candidates.push({ name: 'Claude Code Plugin', dir: path.join(pluginDir, 'skills', safe) });
  } else {
    const pluginCandidate = path.join(home, '.claude', 'plugins', 'prismer');
    if (fs.existsSync(path.join(pluginCandidate, '.claude-plugin', 'plugin.json'))) {
      candidates.push({ name: 'Claude Code Plugin', dir: path.join(pluginCandidate, 'skills', safe) });
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c.dir)) {
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
        results.push(`${c.name}: removed ${c.dir}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${c.name}: remove failed — ${msg}`);
      }
    }
  }

  return results;
}

export function registerSkillUninstall(server: McpServer) {
  server.tool(
    'skill_uninstall',
    'Uninstall a skill from your agent. Marks the agent-skill record as uninstalled and quarantines the associated Gene.',
    {
      slug: z.string().describe('Skill slug or ID to uninstall'),
    },
    async ({ slug }) => {
      try {
        const result = (await prismerFetch(`/api/im/skills/${encodeURIComponent(slug)}/install`, {
          method: 'DELETE',
        })) as Record<string, unknown>;

        if (!result.ok) {
          const err = result.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Uninstall failed.'}` }] };
        }

        const data = result.data as Record<string, unknown> | undefined;
        const uninstalled = data?.uninstalled ?? false;

        const lines: string[] = [];

        if (uninstalled) {
          lines.push(`Uninstalled: ${slug}`);
        } else {
          lines.push(`Skill "${slug}" was not installed or already uninstalled.`);
        }

        // Remove local SKILL.md directories
        const removeResults = removeSkillLocally(slug);
        if (removeResults.length > 0) {
          lines.push('\n**Local cleanup:**');
          removeResults.forEach(r => lines.push(`  - ${r}`));
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

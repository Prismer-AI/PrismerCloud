#!/usr/bin/env node
/**
 * SessionStart hook — Sync Pull + Passive Context Injection (v2)
 *
 * On session start:
 * 1. Clear previous session journal (rename to prev-session-journal.md)
 * 2. Sync pull trending signals + hot genes from evolution network
 * 3. Output passive context for Claude Code to inject
 * 4. Pre-warm MCP server (background, non-blocking)
 *
 * Stdout: context text for injection (or empty)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { resolveConfig } from './lib/resolve-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PREV_JOURNAL_FILE = join(CACHE_DIR, 'prev-session-journal.md');
const CURSOR_FILE = join(CACHE_DIR, 'sync-cursor.json');

const { apiKey: API_KEY, baseUrl: BASE_URL } = resolveConfig();

// --- Step 0: Read stdin to determine event type ---

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {}

const eventType = input?.type || input?.event || 'startup';

// --- Step 1: Rotate session journal ---
// Only rotate on startup/clear (new session). Skip on resume/compact (continuing session).

const shouldRotate = eventType === 'startup' || eventType === 'clear';

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (shouldRotate) {
    if (existsSync(JOURNAL_FILE)) {
      try { renameSync(JOURNAL_FILE, PREV_JOURNAL_FILE); } catch {}
    }
    writeFileSync(JOURNAL_FILE, `# Session Journal\n\nStarted: ${new Date().toISOString()}\n\n`);
  }
} catch {}

// --- Step 2: Auto-detect scope ---

function detectScope() {
  if (process.env.PRISMER_SCOPE) return process.env.PRISMER_SCOPE;

  // Try package.json name
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {}

  // Try git remote (safe: execFileSync doesn't use shell)
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 1000 }).trim();
    if (remote) {
      let hash = 0;
      for (let i = 0; i < remote.length; i++) {
        hash = ((hash << 5) - hash + remote.charCodeAt(i)) | 0;
      }
      return `git_${(hash >>> 0).toString(36)}`;
    }
  } catch {}

  return 'global';
}

const scope = detectScope();

// --- Step 3: Sync pull (if API key available) ---

if (API_KEY) {
  let cursor = 0;
  try {
    const raw = readFileSync(CURSOR_FILE, 'utf8');
    cursor = JSON.parse(raw)?.cursor || 0;
  } catch {}

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    timer.unref();

    const res = await fetch(`${BASE_URL}/api/im/evolution/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ pull: { since: cursor, scope } }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const pulled = data?.data?.pulled;

      if (pulled?.cursor) {
        try {
          writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: pulled.cursor, scope, ts: Date.now() }));
        } catch {}
      }

      const genes = pulled?.genes || [];
      if (genes.length > 0) {
        const topGenes = genes
          .filter(g => (g.successCount || 0) + (g.failureCount || 0) >= 3)
          .sort((a, b) => {
            const aRate = (a.successCount || 0) / Math.max((a.successCount || 0) + (a.failureCount || 0), 1);
            const bRate = (b.successCount || 0) / Math.max((b.successCount || 0) + (b.failureCount || 0), 1);
            return bRate - aRate;
          })
          .slice(0, 5);

        if (topGenes.length > 0) {
          const lines = [
            `[Prismer Evolution Context] Scope: ${scope}`,
            `Proven strategies for this project:`,
            ...topGenes.map(g => {
              const total = (g.successCount || 0) + (g.failureCount || 0);
              const rate = Math.round(((g.successCount || 0) / Math.max(total, 1)) * 100);
              return `  - "${g.title}" (${rate}% success, ${total} runs)`;
            }),
            `These are background context only.`,
          ];
          process.stdout.write(lines.join('\n'));

          // Track injected genes for session-end feedback
          try {
            const injectedFile = join(CACHE_DIR, 'injected-genes.json');
            writeFileSync(injectedFile, JSON.stringify(
              topGenes.map(g => ({ id: g.id, title: g.title }))
            ));
          } catch {}
        }
      }
    }
  } catch {
    // Timeout or error — skip sync
  }
}

// --- Step 3a-retry: Retry failed sync queue from previous sessions ---

if (API_KEY) {
  try {
    const queueFile = join(CACHE_DIR, 'sync-retry-queue.json');
    const raw = readFileSync(queueFile, 'utf8');
    const queue = JSON.parse(raw);
    if (Array.isArray(queue) && queue.length > 0) {
      // Batch all queued outcomes into one sync push
      const allOutcomes = queue.flatMap(entry => entry.outcomes || []);
      if (allOutcomes.length > 0) {
        const retryRes = await fetch(`${BASE_URL}/api/im/evolution/sync?scope=${encodeURIComponent(scope)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({ push: { outcomes: allOutcomes } }),
          signal: AbortSignal.timeout(3000),
        });
        if (retryRes.ok) {
          writeFileSync(queueFile, '[]'); // Clear queue on success
        }
      }
    }
  } catch {
    // Queue doesn't exist or retry failed — will try next time
  }
}

// --- Step 3b: First-run guidance (only when no API key) ---

if (!API_KEY && !process.env._PRISMER_SETUP_SHOWN) {
  process.env._PRISMER_SETUP_SHOWN = '1';
  process.stderr.write('[Prismer] No API key. Run /prismer-setup or: npx prismer setup\n');
}

// --- Step 3b2: Memory recall (pull MEMORY.md + list available files) ---

if (API_KEY && eventType === 'startup') {
  try {
    // Pull MEMORY.md content
    const memRes = await fetch(`${BASE_URL}/api/im/memory/load?scope=${scope}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(2000),
    });

    if (memRes.ok) {
      const mem = await memRes.json();
      const content = mem?.data?.content;
      if (content && content.trim().length > 10) {
        // Inject truncated memory (max 2000 chars to not bloat context)
        const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated)' : content;
        process.stdout.write(`\n[Prismer Memory]\n${truncated}`);
      }
    }

    // List other memory files (titles only, for Claude to recall on demand)
    const listRes = await fetch(`${BASE_URL}/api/im/memory/files?scope=${scope}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(1500),
    });

    if (listRes.ok) {
      const list = await listRes.json();
      const files = (list?.data || []).filter((f) => f.path !== 'MEMORY.md');
      if (files.length > 0) {
        const names = files.slice(0, 10).map((f) => f.path).join(', ');
        process.stdout.write(`\n[Memory files available: ${names}] Use memory_read to access.`);
      }
    }
  } catch {
    // Memory pull failed — non-blocking
  }
}

// --- Step 3c: Skill sync (download cloud-installed skills to local) ---

if (API_KEY && eventType === 'startup') {
  try {
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 3000);
    timer2.unref();

    const installedRes = await fetch(`${BASE_URL}/api/im/skills/installed`, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      signal: controller2.signal,
    });
    clearTimeout(timer2);

    if (installedRes.ok) {
      const installedData = await installedRes.json();
      const skills = installedData?.data || [];

      if (skills.length > 0) {
        const { homedir } = await import('os');
        const home = homedir();
        const skillsDir = join(home, '.claude', 'skills');

        let synced = 0;
        for (const entry of skills) {
          const skill = entry?.skill || entry;
          const slug = skill?.slug;
          if (!slug || typeof slug !== 'string') continue;

          // Sanitize slug (prevent directory traversal)
          const safeSlug = slug.replace(/[^a-z0-9_-]/gi, '-');
          const skillDir = join(skillsDir, safeSlug);
          const skillFile = join(skillDir, 'SKILL.md');

          // Skip if already exists locally
          try {
            readFileSync(skillFile, 'utf8');
            continue; // File exists — skip
          } catch {
            // File doesn't exist — download and write
          }

          // Fetch content
          try {
            const contentRes = await fetch(`${BASE_URL}/api/im/skills/${encodeURIComponent(slug)}/content`, {
              headers: { Authorization: `Bearer ${API_KEY}` },
              signal: AbortSignal.timeout(2000),
            });
            if (contentRes.ok) {
              const contentData = await contentRes.json();
              const content = contentData?.data?.content;
              if (content) {
                mkdirSync(skillDir, { recursive: true });
                writeFileSync(skillFile, content, 'utf8');
                synced++;
              }
            }
          } catch {
            // Skip this skill on error
          }
        }

        if (synced > 0) {
          process.stdout.write(`\n[Prismer Skills] Synced ${synced} skill(s) to ~/.claude/skills/`);
        }
      }
    }
  } catch {
    // Skill sync failed — non-blocking
  }
}

// --- Step 4: Pre-warm MCP server (background, non-blocking, startup only) ---

if (eventType === 'startup') {
  try {
    const child = spawn('npx', ['-y', '@prismer/mcp-server', '--version'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch {}
}

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

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger, rotateLogIfNeeded } from './lib/logger.mjs';

const log = createLogger('session-start');

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

const eventType = input?.source || input?.type || input?.event || 'startup';

// --- Step 1: Rotate session journal ---
// Only rotate on startup/clear (new session). Skip on resume/compact (continuing session).

const shouldRotate = eventType === 'startup' || eventType === 'clear';

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  rotateLogIfNeeded();
  if (shouldRotate) {
    // Clean up stale per-scope block files (> 7 days old)
    try {
      for (const f of readdirSync(CACHE_DIR).filter(n => n.startsWith('last-block-'))) {
        const age = Date.now() - statSync(join(CACHE_DIR, f)).mtimeMs;
        if (age > 7 * 86400_000) unlinkSync(join(CACHE_DIR, f));
      }
    } catch {}
    if (existsSync(JOURNAL_FILE)) {
      try { renameSync(JOURNAL_FILE, PREV_JOURNAL_FILE); } catch {}
    }
    writeFileSync(JOURNAL_FILE, `# Session Journal\n\nStarted: ${new Date().toISOString()}\n\n`);
  }
} catch {}

log.info('start', { event: eventType, rotate: shouldRotate });
const sessionStartTs = Date.now();

// Health report accumulator
const health = { scope: '', sync: 'skip', memory: 'skip', skills: 'skip', genes: 0, memFiles: 0, synced: 0 };

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
health.scope = scope;
log.debug('scope', { scope });

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

      log.info('sync-pull-ok', { genes: (pulled?.genes || []).length, cursor: pulled?.cursor });
      health.sync = 'ok';

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

        health.genes = topGenes.length;
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
  } catch (e) {
    log.warn('sync-pull-failed', { error: e.message, timeout: e.name === 'AbortError' });
    health.sync = e.name === 'AbortError' ? 'timeout' : 'error';
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

if (!API_KEY && eventType === 'startup') {
  const setupDone = existsSync(join(CACHE_DIR, '.setup-done'));
  if (!setupDone) {
    // Strong directive — tell Claude to invoke the setup skill immediately.
    // CC cannot force skill invocation, but a clear instruction in context
    // combined with skill routing rules in CLAUDE.md makes this reliable.
    process.stdout.write([
      'IMPORTANT: Prismer Evolution plugin is installed but not configured.',
      'You MUST invoke the /prismer:prismer-setup skill NOW to complete setup.',
      'This opens a browser for one-click sign-in (zero copy-paste, 30 seconds).',
      'Do NOT skip this — all evolution/memory/sync features are disabled without setup.',
    ].join('\n'));
    log.info('setup-prompt', { firstRun: true });
  }
}

// --- Step 3b1: MCP migration notice (v1.7.7 → v1.7.8+, one-time) ---
// v1.7.8 removed .mcp.json from npm package. Users upgrading from v1.7.7 lose MCP tools silently.
// Detect: .mcp-migrated marker absent + API key present (was a real user, not first install)
if (API_KEY && eventType === 'startup') {
  const migratedFile = join(CACHE_DIR, '.mcp-migrated');
  if (!existsSync(migratedFile)) {
    try { writeFileSync(migratedFile, Date.now().toString()); } catch {}
    // Check if MCP is NOT configured (plugin no longer ships .mcp.json)
    // If user had MCP before, they need to manually add it
    const pluginDir = join(__dirname, '..');
    const hasMcpInPlugin = existsSync(join(pluginDir, '.mcp.json'));
    if (!hasMcpInPlugin) {
      process.stdout.write([
        '\n[Prismer v1.7.8] MCP tools are now installed separately from the plugin.',
        'Hooks (auto-learning, stuck detection, sync) work without MCP.',
        'To restore MCP tools (evolve_analyze, memory_write, etc.), run:',
        '  claude mcp add prismer -- npx -y @prismer/mcp-server@1.7.8',
      ].join('\n'));
      log.info('mcp-migration-notice');
    }
  }
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
        const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated)' : content;
        process.stdout.write(`\n[Prismer Memory]\n${truncated}`);
        health.memory = 'ok';
      }
    }

    // List other memory files with type + description summaries
    const listRes = await fetch(`${BASE_URL}/api/im/memory/files?scope=${scope}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(1500),
    });

    if (listRes.ok) {
      const list = await listRes.json();
      const files = (list?.data || []).filter((f) => f.path !== 'MEMORY.md');
      health.memFiles = files.length;
      if (files.length > 0) {
        const summaries = files.slice(0, 15).map((f) => {
          const type = f.memoryType ? `[${f.memoryType}]` : '';
          const desc = f.description ? ` — ${f.description}` : '';
          const daysAgo = f.updatedAt ? Math.round((Date.now() - new Date(f.updatedAt).getTime()) / 86400000) : '?';
          return `  ${type} ${f.path}${desc} (${daysAgo}d ago)`;
        });
        process.stdout.write(`\n[Prismer Memory Files]\n${summaries.join('\n')}\nUse memory_read to access any file.`);
      }
    }
  } catch (e) {
    log.warn('memory-pull-failed', { error: e.message });
    health.memory = 'error';
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
        health.synced = synced;
        health.skills = 'ok';
      }
    }
  } catch (e) {
    log.warn('skill-sync-failed', { error: e.message });
    health.skills = 'error';
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

// --- Step 5: Health report ---

const elapsed = Date.now() - sessionStartTs;
const parts = [`scope:${health.scope}`];
if (health.genes > 0) parts.push(`genes:${health.genes}`);
if (health.memFiles > 0) parts.push(`memory:${health.memFiles} files`);
if (health.synced > 0) parts.push(`skills:${health.synced} synced`);
parts.push(`sync:${health.sync}`);
parts.push(`${elapsed}ms`);

const allOk = health.sync !== 'error' && health.memory !== 'error' && health.skills !== 'error';
const icon = allOk ? '\u2713' : '\u26A0';
process.stdout.write(`\n[Prismer] ${icon} ${parts.join(' | ')}`);
log.info('health-report', { ...health, elapsed, ok: allOk });

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
import { homedir } from 'os';
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

// --- Step 3a: Try daemon cache first (fast path, <10ms) ---
let usedDaemonCache = false;
try {
  const daemonPortFile = join(homedir(), '.prismer', 'daemon.port');
  const portRaw = readFileSync(daemonPortFile, 'utf-8').trim();
  const port = parseInt(portRaw, 10);
  if (port > 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    timer.unref();
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);

    if (healthRes.ok) {
      const cacheFile = join(homedir(), '.prismer', 'cache', 'evolution.json');
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      if (cached?.genes?.length > 0) {
        const topGenes = cached.genes
          .filter(g => (g.successCount || 0) + (g.failureCount || 0) >= 3)
          .sort((a, b) => {
            const aRate = (a.successCount || 0) / Math.max((a.successCount || 0) + (a.failureCount || 0), 1);
            const bRate = (b.successCount || 0) / Math.max((b.successCount || 0) + (b.failureCount || 0), 1);
            return bRate - aRate;
          })
          .slice(0, 5);
        if (topGenes.length > 0) {
          health.genes = topGenes.length;
          health.sync = 'daemon-cache';
          usedDaemonCache = true;
          log.info('daemon-cache-hit', { genes: topGenes.length, cacheAge: Date.now() - (cached.ts || 0) });
        }
      }
    }
  }
} catch {
  // Daemon not running or cache miss — fall through to network sync
}

if (!usedDaemonCache && API_KEY) {
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

// --- Step 3b1: MCP migration notice (v1.7.7 → v1.8.0+, one-time) ---
// v1.8.0 removed .mcp.json from npm package. Users upgrading from v1.7.7 lose MCP tools silently.
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
        '\n[Prismer v1.8.0] MCP tools are now installed separately from the plugin.',
        'Hooks (auto-learning, stuck detection, sync) work without MCP.',
        'To restore MCP tools (evolve_analyze, memory_write, etc.), run:',
        '  claude mcp add prismer -- npx -y @prismer/mcp-server@1.8.0',
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

// --- Step 3c: Workspace-aware skill projection ---

if (API_KEY && eventType === 'startup') {
  try {
    let synced = 0;
    let usedLegacy = false;

    // Try Workspace API first (requires Platform PR 2)
    let localFiles = null;
    try {
      const wsRes = await fetch(
        `${BASE_URL}/api/im/workspace?scope=${encodeURIComponent(scope)}&slots=strategies`,
        {
          headers: { Authorization: `Bearer ${API_KEY}` },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (wsRes.ok) {
        const wsData = await wsRes.json();
        const workspace = wsData?.data;
        if (workspace?.strategies?.length) {
          const { renderForClaudeCode } = await import('./lib/renderer.mjs');
          localFiles = renderForClaudeCode(workspace);
        }
      } else if (wsRes.status !== 404) {
        log.warn('workspace-api-error', { status: wsRes.status });
      }
      // 404 = old backend without workspace API, fall through to legacy
    } catch (e) {
      log.warn('workspace-api-failed', { error: e.message });
    }

    // Fallback: legacy /skills/installed → per-skill content fetch
    if (!localFiles) {
      usedLegacy = true;
      try {
        const listRes = await fetch(`${BASE_URL}/api/im/skills/installed`, {
          headers: { Authorization: `Bearer ${API_KEY}` },
          signal: AbortSignal.timeout(3000),
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          const skills = listData?.data?.skills || listData?.data || [];
          localFiles = [];
          for (const entry of skills) {
            const slug = entry.skill?.slug || entry.slug;
            if (!slug) continue;
            const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '');
            try {
              const contentRes = await fetch(`${BASE_URL}/api/im/skills/${encodeURIComponent(slug)}/content`, {
                headers: { Authorization: `Bearer ${API_KEY}` },
                signal: AbortSignal.timeout(2000),
              });
              if (contentRes.ok) {
                const contentData = await contentRes.json();
                const content = contentData?.data?.content;
                if (content) {
                  localFiles.push({
                    relativePath: `skills/${safeSlug}/SKILL.md`,
                    content,
                    meta: { sourceSlot: 'legacy', sourceId: slug, scope, checksum: '' },
                  });
                }
              }
            } catch {}
          }
        }
      } catch (e) {
        log.warn('legacy-skill-sync-failed', { error: e.message });
      }
    }

    // Write files to disk (dual-layer: user + project)
    if (localFiles?.length) {
      const home = homedir();
      const userSkillsDir = join(home, '.claude', 'skills');
      const projectSkillsDir = existsSync(join(process.cwd(), '.claude'))
        ? join(process.cwd(), '.claude', 'skills')
        : null;

      for (const file of localFiles) {
        const targets = [join(userSkillsDir, file.relativePath)];
        if (projectSkillsDir) targets.push(join(projectSkillsDir, file.relativePath));

        for (const target of targets) {
          const metaPath = join(dirname(target), '.prismer-meta.json');

          // Incremental: compare checksum (skip for legacy which has no checksum)
          if (file.meta.checksum) {
            let existing = null;
            try { existing = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
            if (existing?.checksum === file.meta.checksum) continue;
          } else {
            // Legacy path: skip if SKILL.md already exists
            if (existsSync(target)) continue;
          }

          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.content, 'utf8');
          writeFileSync(metaPath, JSON.stringify({ ...file.meta, syncedAt: new Date().toISOString() }));
          synced++;
        }
      }
    }

    if (synced > 0) {
      process.stdout.write(`\n[Prismer Skills] Synced ${synced} file(s)${usedLegacy ? ' (legacy)' : ''}`);
    }
    health.synced = synced;
    health.skills = 'ok';
  } catch (e) {
    log.warn('skill-sync-failed', { error: e.message });
    health.skills = 'error';
  }
}

// --- Step 3d: Community context (trending discussions, optional) ---

if (API_KEY && eventType === 'startup') {
  try {
    const commRes = await fetch(`${BASE_URL}/api/im/community/stats`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(1500),
    });

    if (commRes.ok) {
      const commData = await commRes.json();
      const stats = commData?.data;
      if (stats && (stats.postsToday > 0 || stats.activeAuthors7d > 0)) {
        const trendingTags = (stats.trendingTags || [])
          .slice(0, 3)
          .map((t) => `#${t.name}`)
          .join(' ');
        process.stdout.write(
          `\n[Prismer Community] ${stats.postsToday} posts today, ${stats.activeAuthors7d} active authors (7d)` +
          (trendingTags ? ` | Trending: ${trendingTags}` : '') +
          `\nUse community_browse / community_search MCP tools to participate.`
        );
      }
    }
  } catch {
    // Community context is optional — skip silently
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

// --- Step 4b: Auto-update check (non-blocking, startup only) ---
// Check if plugin is outdated. If so, clear stale npm cache so next /plugin install pulls fresh.

if (eventType === 'startup') {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const currentVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    const result = execFileSync('npm', ['view', '@prismer/claude-code-plugin', 'version'], {
      timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (result && result !== currentVersion) {
      // Auto-clear stale npm/CC cache so next install pulls fresh
      const { rmSync } = await import('fs');
      const npmCachePaths = [
        join(homedir(), '.claude', 'plugins', 'npm-cache', 'node_modules', '@prismer'),
        join(homedir(), '.claude', 'plugins', 'cache', 'prismer-cloud'),
        // CC marketplace plugin cache
        join(homedir(), '.claude', 'plugins', 'prismer'),
      ];
      for (const p of npmCachePaths) {
        try { rmSync(p, { recursive: true, force: true }); } catch {}
      }

      // Also update marketplace.json in-place so CC's /plugin detects the new version
      try {
        const marketplacePath = join(__dirname, '..', '.claude-plugin', 'marketplace.json');
        if (existsSync(marketplacePath)) {
          const mkt = JSON.parse(readFileSync(marketplacePath, 'utf8'));
          if (mkt.plugins?.[0]) {
            mkt.plugins[0].version = result;
            writeFileSync(marketplacePath, JSON.stringify(mkt, null, 2) + '\n');
          }
        }
      } catch {}

      process.stdout.write(
        `\n[Prismer] \u26A0 Update available: ${currentVersion} \u2192 ${result}. ` +
        `Cache cleared \u2014 run: /plugin install prismer\n`
      );
      log.info('update-available', { current: currentVersion, latest: result, cacheCleared: true });
    }
  } catch {
    // npm view failed (offline, timeout) — skip silently
  }
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

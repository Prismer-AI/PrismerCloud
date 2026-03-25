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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PREV_JOURNAL_FILE = join(CACHE_DIR, 'prev-session-journal.md');
const CURSOR_FILE = join(CACHE_DIR, 'sync-cursor.json');

const API_KEY = process.env.PRISMER_API_KEY;
const BASE_URL = (process.env.PRISMER_BASE_URL || 'https://prismer.cloud').replace(/\/$/, '');

// --- Step 1: Rotate session journal ---

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (existsSync(JOURNAL_FILE)) {
    try { renameSync(JOURNAL_FILE, PREV_JOURNAL_FILE); } catch {}
  }
  writeFileSync(JOURNAL_FILE, `# Session Journal\n\nStarted: ${new Date().toISOString()}\n\n`);
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
        }
      }
    }
  } catch {
    // Timeout or error — skip sync
  }
}

// --- Step 4: Pre-warm MCP server (background, non-blocking) ---

try {
  const child = spawn('npx', ['-y', '@prismer/mcp-server', '--version'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
} catch {}

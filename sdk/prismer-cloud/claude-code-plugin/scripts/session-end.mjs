#!/usr/bin/env node
/**
 * SessionEnd hook — Async Evolution Sync (v3)
 *
 * Runs when the session is ending. Handles two cases:
 *
 * 1. Stop hook blocked and Claude did full review -> skip (already handled)
 * 2. Stop hook did not block (cooldown/no value/skipped) -> async sync
 *
 * For case 2: pushes gene feedback outcomes to evolution network.
 * Fire-and-forget; never blocks session exit.
 *
 * Stdin JSON: { session_id, ... }
 * Stdout: empty
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('session-end');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const CURSOR_FILE = join(CACHE_DIR, 'sync-cursor.json');

// --- Read stdin (discard; we do not need session metadata) ---

try { readFileSync(0, 'utf8'); } catch {}

// --- Check config ---

const { apiKey, baseUrl } = resolveConfig();
if (!apiKey) process.exit(0);

// Read project scope from sync-cursor.json
let scope = 'global';
try {
  const raw = readFileSync(join(CACHE_DIR, 'sync-cursor.json'), 'utf8');
  scope = JSON.parse(raw)?.scope || 'global';
} catch {}

// --- Read journal ---

let journal = '';
try {
  journal = readFileSync(JOURNAL_FILE, 'utf8');
} catch {
  process.exit(0);
}

// --- Savings summary ---
try {
  const compressMatches = journal.match(/\b(context\/load|compress)\b/gi) || [];
  const callCount = compressMatches.length;
  if (callCount > 0) {
    const tokensSaved = callCount * 40000;
    const moneySaved = (tokensSaved / 1000) * 0.009;
    log.info('savings', { callCount, tokensSaved, moneySaved: moneySaved.toFixed(2) });
  }
} catch {}

// If Stop hook triggered AND Claude called MCP tools, skip journal push to avoid
// duplicate recording (server has no dedup). But if Stop hook triggered and
// Claude did NOT call any evolve_* MCP tool, we should still push journal feedback.
// Heuristic: check if journal has the marker but no "[evolve_record" or "evolve_create"
// evidence (Claude's MCP calls don't appear in the journal, so we can't detect them).
// Conservative approach: skip if marker exists. The Stop hook's explicit MCP path is
// higher quality than journal regex extraction, so prefer that path when available.
if (journal.includes('[evolution-review-triggered]')) {
  log.info('skip-stop-hook-marker');
  process.exit(0);
}

// --- Extract gene feedback outcomes ---

const feedbackLines = journal.match(/gene_feedback:.*outcome=\w+/g) || [];
const outcomes = feedbackLines.map(line => {
  const titleMatch = line.match(/"([^"]+)"/);
  const geneIdMatch = line.match(/gene_id=(\S+)/);
  const outcomeMatch = line.match(/outcome=(\w+)/);
  if (!outcomeMatch) return null;
  return {
    title: titleMatch?.[1] || '',
    geneId: geneIdMatch?.[1]?.replace(/\s+outcome=.*/, '') || '',
    outcome: outcomeMatch[1],
  };
}).filter(Boolean);

// --- Extract signal summary ---

const signalRe = /signal:(\S+)/g;
const signalCounts = {};
let m;
while ((m = signalRe.exec(journal)) !== null) {
  signalCounts[m[1]] = (signalCounts[m[1]] || 0) + 1;
}

// --- Read checklist summary (from MCP session_checklist tool) ---

const CHECKLIST_FILE = join(CACHE_DIR, 'checklist-summary.json');
try {
  const raw = readFileSync(CHECKLIST_FILE, 'utf8');
  const items = JSON.parse(raw);
  const completed = items.filter(i => i.status === 'completed');
  if (completed.length > 0) {
    signalCounts[`checklist_completed:${completed.length}`] = 1;
    // Each completed item as a lightweight outcome
    for (const item of completed) {
      outcomes.push({
        title: item.content,
        geneId: '',
        outcome: 'success',
      });
    }
    log.info('checklist-loaded', { completed: completed.length, total: items.length });
  }
} catch {
  // No checklist or parse error — not critical
}

// Skip if nothing to sync
if (outcomes.length === 0 && Object.keys(signalCounts).length === 0) {
  process.exit(0);
}

// --- Check if daemon is running ---
let daemonRunning = false;
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
    daemonRunning = healthRes.ok;
  }
} catch {}

// --- Async push to evolution network ---

log.info('sync-push-start', { outcomes: outcomes.length, signals: Object.keys(signalCounts).length, daemon: daemonRunning });

if (daemonRunning && outcomes.length > 0) {
  // MUTUAL EXCLUSIVE: write to daemon outbox, do NOT POST
  try {
    const outboxFile = join(homedir(), '.prismer', 'cache', 'outbox.json');
    let outbox = [];
    try { outbox = JSON.parse(readFileSync(outboxFile, 'utf-8')); } catch {}
    outbox.push(...outcomes.map(o => ({ ...o, timestamp: Date.now() })));
    if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
    writeFileSync(outboxFile, JSON.stringify(outbox));
    log.info('outbox-write', { count: outcomes.length });
    // Clean retry queue since daemon handles retries
    try { writeFileSync(join(CACHE_DIR, 'sync-retry-queue.json'), '[]'); } catch {}
  } catch (err) {
    log.error('outbox-write-failed', { err: err.message });
    daemonRunning = false; // Fall through to POST
  }
}

if (!daemonRunning) {
  try {
    let cursor = 0;
    try {
      const raw = readFileSync(CURSOR_FILE, 'utf8');
      cursor = JSON.parse(raw)?.cursor || 0;
    } catch {}

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref();

    // Build signals array from journal signalCounts
    const allSignals = Object.keys(signalCounts).map(type => ({ type: type.replace(/[()]/g, '') }));

    const pushOutcomes = outcomes.map(o => ({
      gene_id: o.geneId || o.title,
      outcome: o.outcome,
      summary: `Session-end sync: "${o.title}" ${o.outcome}`,
      signals: allSignals.length > 0 ? allSignals : [{ type: 'session:end' }],
    }));

    const res = await fetch(`${baseUrl}/api/im/evolution/sync?scope=${encodeURIComponent(scope)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        push: pushOutcomes.length > 0 ? { outcomes: pushOutcomes } : undefined,
        pull: { since: cursor },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      log.info('sync-push-ok', { outcomes: outcomes.length });
      const data = await res.json();
      if (data?.data?.pulled?.cursor) {
        try {
          writeFileSync(CURSOR_FILE, JSON.stringify({
            cursor: data.data.pulled.cursor,
            scope,
            ts: Date.now(),
          }));
        } catch {}
      }
    }
  } catch (e) {
    log.warn('sync-push-failed', { error: e.message, timeout: e.name === 'AbortError' });
    // Sync failed — queue for retry on next SessionStart
    try {
      const queueFile = join(CACHE_DIR, 'sync-retry-queue.json');
      let queue = [];
      try { queue = JSON.parse(readFileSync(queueFile, 'utf8')); } catch {}
      const retrySignals = Object.keys(signalCounts).map(type => ({ type: type.replace(/[()]/g, '') }));
      const pushOutcomes = outcomes.map(o => ({
        gene_id: o.geneId || o.title,
        outcome: o.outcome,
        summary: `Session-end sync (retry): "${o.title}" ${o.outcome}`,
        signals: retrySignals.length > 0 ? retrySignals : [{ type: 'session:end' }],
      }));
      if (pushOutcomes.length > 0) {
        queue.push({ outcomes: pushOutcomes, ts: Date.now() });
        // Keep max 10 entries to prevent unbounded growth
        if (queue.length > 10) queue = queue.slice(-10);
        writeFileSync(queueFile, JSON.stringify(queue));
        log.info('retry-queue-written', { entries: queue.length });
      }
    } catch (qe) {
      log.warn('retry-queue-error', { error: qe.message });
    }
  }
}

// --- Local skill push: detect user-created skills → upload to cloud ---

if (apiKey) {
  try {
    const { readdirSync, existsSync: exists, readFileSync: readFile } = await import('fs');
    const home = homedir();
    const skillsDir = join(home, '.claude', 'skills');

    if (exists(skillsDir)) {
      const added = [];

      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        const skillFile = join(skillsDir, slug, 'SKILL.md');
        const metaFile = join(skillsDir, slug, '.prismer-meta.json');

        if (!exists(skillFile)) continue;

        // No .prismer-meta.json = user manually created this skill locally
        if (!exists(metaFile)) {
          const content = readFile(skillFile, 'utf8');
          added.push({ slug, content });
        }
      }

      if (added.length > 0) {
        // Upload to Cloud as new Skill + auto-install (max 5 per session)
        for (const { slug, content } of added.slice(0, 5)) {
          try {
            await fetch(`${baseUrl}/api/im/skills/import`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({
                items: [{
                  name: slug,
                  description: `Local skill: ${slug}`,
                  category: 'general',
                  source: 'local',
                  sourceId: `local:${slug}`,
                  content,
                }],
              }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        }
        log.info('local-skill-push', { count: added.length });
      }
    }
  } catch (e) {
    log.warn('local-skill-push-failed', { error: e.message });
  }
}

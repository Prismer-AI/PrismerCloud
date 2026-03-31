#!/usr/bin/env node
/**
 * SubagentStart hook — Inject proven strategies into subagent context
 *
 * When Claude spawns a subagent (Agent tool), inject the top evolution
 * strategies so subagents benefit from the evolution network too.
 *
 * Stdin JSON: { session_id, ... }
 * Stdout: text injected into subagent's context (or empty)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveConfig } from './lib/resolve-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');

const { apiKey, baseUrl } = resolveConfig();
if (!apiKey) process.exit(0);

// Read parent session's journal for signal context
let journalSignals = '';
try {
  const journal = readFileSync(JOURNAL_FILE, 'utf8');
  const sigRe = /signal:(\S+)/g;
  const counts = {};
  let m;
  while ((m = sigRe.exec(journal)) !== null) {
    const sig = m[1].replace(/[()]/g, '');
    counts[sig] = (counts[sig] || 0) + 1;
  }
  if (Object.keys(counts).length > 0) {
    journalSignals = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sig, cnt]) => `${sig} (${cnt}x)`)
      .join(', ');
  }
} catch {
  // No journal — that's OK
}

// Fetch top genes
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  timer.unref();

  const res = await fetch(`${baseUrl}/api/im/evolution/public/hot?limit=3`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (res.ok) {
    const data = await res.json();
    const genes = data?.data || [];
    if (genes.length > 0) {
      const lines = genes.slice(0, 3).map(g => {
        const total = (g.success_count || 0) + (g.failure_count || 0);
        const rate = total > 0 ? Math.round(((g.success_count || 0) / total) * 100) : 0;
        return `"${g.title}" (${rate}%)`;
      });

      let output = `[Evolution] Top strategies: ${lines.join('; ')}`;
      if (journalSignals) {
        output += ` | Parent session signals: ${journalSignals}`;
      }
      process.stdout.write(output);
    }
  }
} catch {
  // Timeout — don't block subagent startup
}

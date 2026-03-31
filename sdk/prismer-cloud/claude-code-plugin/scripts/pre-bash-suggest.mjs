#!/usr/bin/env node
/**
 * PreToolUse hook — Stuck Detection + Evolution Query (v2)
 *
 * Called by Claude Code BEFORE every Bash tool use. Instead of querying
 * the evolution network on every command (v1), v2 only queries when
 * the agent appears STUCK: same error signal appearing >= 2 times in
 * the session journal.
 *
 * Stdin JSON shape (PreToolUse):
 *   { tool_name, tool_input: { command, ... } }
 *
 * Stdout: suggestion text (or empty for no suggestion)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveConfig } from './lib/resolve-config.mjs';
import { SIGNAL_PATTERNS, ERROR_CONTEXT_RE, SKIP_RE, countSignal } from './lib/signals.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PENDING_FILE = join(CACHE_DIR, 'pending-suggestion.json');

const { apiKey: API_KEY, baseUrl: BASE_URL } = resolveConfig();

/** Read project scope from sync-cursor.json (written by session-start) */
function getScope() {
  try {
    const raw = readFileSync(join(CACHE_DIR, 'sync-cursor.json'), 'utf8');
    return JSON.parse(raw)?.scope || 'global';
  } catch { return 'global'; }
}

/** Minimum same-signal occurrences before querying evolution (stuck detection) */
const STUCK_THRESHOLD = 2;

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command || '';

// Skip trivial commands
if (SKIP_RE.test(command)) process.exit(0);

const signals = [];
const isErrorContext = ERROR_CONTEXT_RE.some(re => re.test(command));

if (isErrorContext) {
  for (const { pattern, type } of SIGNAL_PATTERNS) {
    if (pattern.test(command)) {
      signals.push({ type });
    }
  }
}

// No signals detected in command → nothing to do
if (signals.length === 0) process.exit(0);

// --- v2: Stuck Detection — read journal to check if same signal appeared >= STUCK_THRESHOLD ---

let journal = '';
try { journal = readFileSync(JOURNAL_FILE, 'utf8'); } catch {}

// Count how many times each detected signal already appears in journal
let maxCount = 0;
for (const sig of signals) {
  const count = countSignal(journal, sig.type);
  if (count > maxCount) maxCount = count;
}

// Not stuck yet — first occurrence, let agent handle it
if (maxCount < STUCK_THRESHOLD) {
  process.exit(0);
}

// --- Agent is stuck (>= 2 occurrences of same signal) → query evolution ---

if (!API_KEY) {
  const hint = `[Prismer Evolution] Repeated error detected (${maxCount}x): ${signals.map(s => s.type).join(', ')}. Set PRISMER_API_KEY to get fix recommendations.`;
  process.stdout.write(hint);
  process.exit(0);
}

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref();

  const scope = getScope();
  const res = await fetch(`${BASE_URL}/api/im/evolution/analyze?scope=${encodeURIComponent(scope)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ signals }),
    signal: controller.signal,
  });

  clearTimeout(timer);
  if (!res.ok) process.exit(0);

  const data = await res.json();
  const advice = data?.data;

  // Lower threshold for stuck detection — agent is already stuck,
  // any matching gene is worth suggesting even with low confidence
  if (advice?.action === 'apply_gene' && advice?.gene) {
    const gene = advice.gene;
    const strategy = gene?.strategy || [];

    const suggestion = [
      `[Prismer Evolution] Known fix for repeated ${signals[0]?.type || 'error'} (${maxCount}x in session, confidence: ${Math.round(advice.confidence * 100)}%):`,
      `Strategy: "${gene?.title || advice.gene_id}"`,
      ...strategy.map((s, i) => `  ${i + 1}. ${s}`),
      '',
    ].join('\n');

    process.stdout.write(suggestion);

    // Save pending for journal feedback tracking
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(PENDING_FILE, JSON.stringify({
        geneId: advice.gene_id || gene?.id,
        geneTitle: gene?.title,
        signals,
        suggestedAt: Date.now(),
      }));
    } catch {}
  }
} catch {
  // Timeout or error — don't block
}

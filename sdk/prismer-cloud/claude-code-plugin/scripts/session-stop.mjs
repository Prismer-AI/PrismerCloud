#!/usr/bin/env node
/**
 * Stop hook — Evolution Session Review trigger (v3)
 *
 * v3 improvements over v2.1:
 * - Only blocks ONCE per session (tracks marker in journal)
 * - Cooldown: 1 hour between blocks across sessions
 * - SessionEnd hook handles async fallback when block is skipped
 *
 * Stdin JSON: { stop_hook_active, session_id, cwd, ... }
 * Stdout JSON: { decision: "block" } or nothing (exit 0 to allow stop)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('session-stop');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');

// Per-scope cooldown: project A blocking doesn't prevent project B from blocking
function detectScopeForCooldown() {
  if (process.env.PRISMER_SCOPE) return process.env.PRISMER_SCOPE;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name.replace(/[^a-z0-9_-]/gi, '-');
  } catch {}
  return 'global';
}
const cooldownScope = detectScopeForCooldown();
const BLOCK_MARKER_FILE = join(CACHE_DIR, `last-block-${cooldownScope}.json`);

const BLOCK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// --- Step 1: Read stdin ---

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // No input — proceed with defaults
}

// --- Step 2: Prevent infinite loop ---

if (input.stop_hook_active === true) {
  log.debug('skip-already-active');
  process.exit(0);
}

// --- Step 3: Check config ---

const { apiKey } = resolveConfig();
if (!apiKey) process.exit(0);

// --- Step 4: Check cooldown (1h between blocks) ---

try {
  const raw = readFileSync(BLOCK_MARKER_FILE, 'utf8');
  const marker = JSON.parse(raw);
  if (Date.now() - (marker?.ts || 0) < BLOCK_COOLDOWN_MS) {
    log.info('skip-cooldown', { scope: cooldownScope, remainMs: BLOCK_COOLDOWN_MS - (Date.now() - (marker?.ts || 0)) });
    process.exit(0);
  }
} catch {
  // No marker — first block ever, proceed
}

// --- Step 5: Read journal ---

let journal = '';
try {
  journal = readFileSync(JOURNAL_FILE, 'utf8');
} catch {
  process.exit(0);
}

// --- Step 6: Check if already blocked recently in this journal ---
// v1.7.8 fix: long sessions (resume/compact) never rotate journal, so a simple
// "marker exists" check blocked evolution for the entire session lifetime.
// Now we parse the marker timestamp and apply the same cooldown as Step 4.

const markerRe = /\[evolution-review-triggered\] \(at: ([^)]+)\)/g;
let lastMarkerTs = 0;
let mm;
while ((mm = markerRe.exec(journal)) !== null) {
  const t = new Date(mm[1]).getTime();
  if (t > lastMarkerTs) lastMarkerTs = t;
}
if (lastMarkerTs > 0 && Date.now() - lastMarkerTs < BLOCK_COOLDOWN_MS) {
  log.info('skip-journal-marker', { lastMarkerAge: Math.round((Date.now() - lastMarkerTs) / 60000), cooldownMin: BLOCK_COOLDOWN_MS / 60000 });
  process.exit(0);
}

// --- Step 7: Check evolution value ---

function hasEvolutionValue(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('Started:'));
  if (lines.length < 2) return false;

  // Any error signal
  if (/signal:error:/m.test(text)) return true;

  // Repeated signals (>= 2x same type)
  const signalCounts = {};
  const re = /signal:(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    signalCounts[m[1]] = (signalCounts[m[1]] || 0) + 1;
  }
  for (const count of Object.values(signalCounts)) {
    if (count >= 2) return true;
  }

  // Gene was used during session
  if (/gene_feedback:/m.test(text)) return true;

  // Enough activity (>= 5 tool entries) BUT only if there were any signals at all.
  // Without signals, there is nothing evolution-relevant to record — only memory_write
  // might be useful, and that does not justify blocking the session.
  const hasAnySignal = /signal:\S+/m.test(text);
  if (hasAnySignal && (text.match(/^- (bash|edit|write):/gm) || []).length >= 5) return true;

  return false;
}

if (!hasEvolutionValue(journal)) {
  process.exit(0);
}

// --- Step 8: Build concise context for Claude's self-evaluation ---

function buildContext(text) {
  const parts = [];

  // Gene feedback: extract for Claude to self-evaluate adherence
  const fbRe = /gene_feedback:\s*"([^"]+)"\s*gene_id=(\S+)\s*outcome=(\w+)/g;
  const feedbacks = [];
  let fbm;
  while ((fbm = fbRe.exec(text)) !== null) {
    feedbacks.push({ title: fbm[1], geneId: fbm[2], autoOutcome: fbm[3] });
  }

  if (feedbacks.length > 0) {
    parts.push('Gene suggestions were made this session. For each, self-evaluate:');
    parts.push('Did you actually follow this strategy, or did you solve it independently?');
    for (const fb of feedbacks) {
      parts.push(`  - "${fb.title}" (${fb.geneId}) auto-detected: ${fb.autoOutcome}`);
      parts.push(`    Call evolve_record with YOUR assessment of outcome + whether you used the strategy`);
    }
  }

  // Signal summary (concise)
  const sigRe = /signal:(\S+)/g;
  const sigs = {};
  let sm;
  while ((sm = sigRe.exec(text)) !== null) {
    sigs[sm[1]] = (sigs[sm[1]] || 0) + 1;
  }
  const sigList = Object.entries(sigs).filter(([, c]) => c >= 2).map(([s, c]) => `${s}(${c}x)`);
  if (sigList.length > 0) {
    parts.push('');
    parts.push(`Repeated signals: ${sigList.join(', ')}`);
  }

  // Concise instructions: only suggest evolve_record/evolve_create_gene when there is
  // gene feedback or repeated signals (evolution-relevant). Otherwise only memory_write.
  const hasGeneFeedback = feedbacks.length > 0;
  const hasRepeatedSignals = sigList.length > 0;

  if (parts.length === 0) {
    // No gene feedback and no repeated signals — only memory_write is relevant
    parts.push('Session had activity. Review: memory_write (project-specific learnings). Max 1 call.');
  } else if (hasGeneFeedback || hasRepeatedSignals) {
    parts.push('');
    parts.push('Review: evolve_record (gene feedback) / evolve_create_gene (general pattern) / memory_write (project-specific). Max 3 calls.');
  } else {
    parts.push('');
    parts.push('Review: memory_write (project-specific learnings). Max 1 call.');
  }

  return parts.join('\n');
}

// --- Step 9: Mark journal + record block time ---

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  appendFileSync(JOURNAL_FILE, '\n[evolution-review-triggered] (at: ' + new Date().toISOString() + ')\n');
  writeFileSync(BLOCK_MARKER_FILE, JSON.stringify({ ts: Date.now() }));
} catch {
  // Write failed — still block (best-effort marking)
}

// --- Step 10: Block with concise context ---
// Note: Claude Code displays reason as "Stop hook error:" text.
// We accept this UX tradeoff because the alternative (no reason) means
// Claude doesn't know which genes to evaluate. The self-evaluation context
// is essential for accurate Thompson Sampling feedback.

const context = buildContext(journal);
process.stdout.write(JSON.stringify({ decision: 'block', reason: context }));

#!/usr/bin/env node
/**
 * Stop hook — Evolution Session Review trigger (v4)
 *
 * v4 improvements over v3:
 * - No longer abuses `decision:'block'` for UX. Claude Code renders that as
 *   a red "Stop hook error:" modal, which surfaced scary text on every stop
 *   even in healthy sessions.
 * - Detection logic preserved (cooldown + journal marker + value heuristics).
 * - Delivery moved to:
 *     1. `~/.prismer/pending-review.json` — hint file the next SessionStart
 *        surfaces as a gentle notice (non-red).
 *     2. `session-end.mjs` — handles the async evolution sync push that
 *        Claude used to do inline after the block.
 *     3. stderr — single subtle line (Claude Code renders stderr gray, not
 *        red) so the user sees a suggestion without a modal.
 *
 * Stdin JSON: { stop_hook_active, session_id, cwd, ... }
 * Stdout: empty (exit 0, never block)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { resolveConfig } from './lib/resolve-config.mjs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('session-stop');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PRISMER_HOME = join(homedir(), '.prismer');
const PENDING_REVIEW_FILE = join(PRISMER_HOME, 'pending-review.json');

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
  const sigList = Object.entries(sigs).filter(([, c]) => c >= 2).map(([s, c]) => ({ type: s, count: c }));

  // Targeted guidance based on specific patterns
  const hasGeneFeedback = feedbacks.length > 0;
  const hasRepeatedSignals = sigList.length > 0;

  if (sigList.length > 0) {
    parts.push('');
    parts.push('Repeated signals detected:');
    sigList.sort((a, b) => b.count - a.count).slice(0, 5).forEach(({ type, count }) => {
      parts.push(`  - ${type} (${count}x)`);
    });

    // Suggest gene creation for error patterns
    const errorSigs = sigList.filter(s => s.type.startsWith('error:'));
    if (errorSigs.length > 0) {
      parts.push('');
      parts.push('Error pattern(s) suggest a gene may be needed:');
      errorSigs.slice(0, 2).forEach(({ type, count }) => {
        parts.push(`  - ${type} occurred ${count} times — consider evolve_create_gene if this is a recurring pattern`);
      });
    }
  }

  // Concise instructions: prioritize gene feedback > error patterns > general signals > memory
  if (hasGeneFeedback || hasRepeatedSignals) {
    parts.push('');
    if (hasGeneFeedback) {
      parts.push('Priority: evolve_record for each gene feedback above (1 call each).');
    }
    if (sigList.some(s => s.type.startsWith('error:'))) {
      parts.push('If error pattern is novel/recurring: evolve_create_gene to capture fix strategy.');
    }
    parts.push('Project-specific learnings: memory_write (max 1 call).');
    parts.push('Total: max 3 evolution/memory calls.');
  } else if (Object.keys(sigs).length > 0) {
    parts.push('');
    parts.push('Review: memory_write for project-specific learnings. Max 1 call.');
  } else {
    // Only activity, no signals
    parts.push('Session had activity but no signals captured. Consider memory_write if you learned something project-specific.');
  }

  return {
    summary: parts.join('\n'),
    hasGeneFeedback,
    hasRepeatedSignals,
    signalTypes: Object.keys(sigs),
  };
}

// --- Step 9: Build review context ---

const context = buildContext(journal);

// --- Step 10: Mark journal + record trigger time ---

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  appendFileSync(JOURNAL_FILE, '\n[evolution-review-triggered] (at: ' + new Date().toISOString() + ')\n');
  writeFileSync(BLOCK_MARKER_FILE, JSON.stringify({ ts: Date.now() }));
} catch {
  // Write failed — best-effort marking
}

// --- Step 11: Write pending-review hint for next SessionStart + session-end ---

try {
  mkdirSync(PRISMER_HOME, { recursive: true });
  writeFileSync(PENDING_REVIEW_FILE, JSON.stringify({
    ts: Date.now(),
    scope: cooldownScope,
    summary: context.summary,
    hasGeneFeedback: context.hasGeneFeedback,
    hasRepeatedSignals: context.hasRepeatedSignals,
    signalTypes: context.signalTypes,
  }));
} catch {
  // Best-effort; if we cannot write, the stderr hint below still fires
}

// --- Step 12: Emit a subtle stderr hint (gray, not red) ---
// Claude Code renders stderr from Stop hooks as a non-modal informational line.
// Keep it single-line + actionable. NEVER emit decision:'block' here — that
// channel is reserved for genuine errors and renders as a scary red modal.
try {
  const hint = context.hasGeneFeedback
    ? '[Prismer] Gene feedback pending — review queued for session end.'
    : context.hasRepeatedSignals
      ? '[Prismer] Repeated signals detected — evolution review queued for session end.'
      : '[Prismer] Session activity recorded — review queued for session end.';
  process.stderr.write(hint + '\n');
} catch {}

// Exit 0 with no stdout — never block, never surface a red modal.
process.exit(0);

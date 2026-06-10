#!/usr/bin/env node
/**
 * PostToolUse hook — Session Journal Writer (v2)
 *
 * Replaces post-bash-report.mjs's remote writing behavior.
 * Detects errors in Bash output and appends to a LOCAL session-journal.md.
 * Does NOT write to the evolution network (that happens at session end).
 *
 * Still handles the gene feedback loop:
 *   - If a gene was suggested (pending-suggestion.json) and command succeeds → local note
 *   - If a gene was suggested and command fails → local note
 *
 * Stdin JSON shape (PostToolUse):
 *   { tool_name, tool_input: { command, ... }, tool_result: "..." }
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SIGNAL_PATTERNS, SKIP_RE, hasError, countSignal, detectTechStack } from './lib/signals.mjs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('post-bash-journal');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PENDING_FILE = join(CACHE_DIR, 'pending-suggestion.json');
const PENDING_TTL_MS = 10 * 60 * 1000;

// --- Helpers ---

function readPending() {
  try {
    const raw = readFileSync(PENDING_FILE, 'utf8');
    if (!raw) return null;
    const pending = JSON.parse(raw);
    if (!pending?.geneId) return null;
    if (Date.now() - (pending.suggestedAt || 0) > PENDING_TTL_MS) {
      try { writeFileSync(PENDING_FILE, ''); } catch {}
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

function clearPending() {
  try { writeFileSync(PENDING_FILE, ''); } catch {}
}

function ensureJournal() {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(JOURNAL_FILE)) {
    writeFileSync(JOURNAL_FILE, '# Session Journal\n\n');
  }
}

function appendJournal(line) {
  try {
    ensureJournal();
    appendFileSync(JOURNAL_FILE, line + '\n');
  } catch {}
}

function now() {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// --- Main ---

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

// Detect tool type and extract relevant fields
const toolName = input?.tool_name || 'Bash';
let command = '';
let result = '';
let journalPrefix = 'bash';

if (toolName === 'Bash') {
  command = input?.tool_input?.command || '';
  const resp = input?.tool_response || input?.tool_result || '';
  result = typeof resp === 'string' ? resp : [resp.stdout || '', resp.stderr || ''].join('\n');
  journalPrefix = 'bash';
} else if (toolName === 'Edit') {
  command = `edit ${input?.tool_input?.file_path || ''}`;
  const resp = input?.tool_response || input?.tool_result || '';
  result = typeof resp === 'string' ? resp : '';
  journalPrefix = 'edit';
} else if (toolName === 'Write') {
  command = `write ${input?.tool_input?.file_path || ''}`;
  const resp = input?.tool_response || input?.tool_result || '';
  result = typeof resp === 'string' ? resp : '';
  journalPrefix = 'write';
} else {
  process.exit(0); // Unknown tool — skip
}

// Skip trivial commands (Bash only)
if (toolName === 'Bash' && SKIP_RE.test(command)) {
  log.debug('skip-trivial', { command: command.slice(0, 80) });
  readPending(); // side-effect: clears if expired
  process.exit(0);
}

// Record tool usage in journal
appendJournal(`- ${journalPrefix}: \`${command.slice(0, 120)}\` (${now()})`);

const errorDetected = hasError(result);

if (!errorDetected) {
  // Success path
  const pending = readPending();
  if (pending) {
    log.info('gene-feedback', { geneId: pending.geneId, outcome: 'success' });
    appendJournal(`  - gene_feedback: "${pending.geneTitle}" gene_id=${pending.geneId} outcome=success`);
    clearPending();
  }
  process.exit(0);
}

// Error detected — extract signals and write to journal
log.info('error-detected', { tool: toolName, command: command.slice(0, 80) });
const detectedSignals = [];
for (const { pattern, type } of SIGNAL_PATTERNS) {
  if (pattern.test(result) || pattern.test(command)) {
    detectedSignals.push(type);
  }
}
if (detectedSignals.length === 0) {
  detectedSignals.push('error:generic');
}

// Detect project tech stack for cross-project gene filtering
const techStack = detectTechStack();

// Read existing journal to count signal occurrences for stuck detection
let existingContent = '';
try { existingContent = readFileSync(JOURNAL_FILE, 'utf8'); } catch {}

for (const sig of detectedSignals) {
  const existingCount = countSignal(existingContent, sig);
  const techSuffix = techStack ? ` techStack=${techStack}` : '';
  appendJournal(`  - signal:${sig} (count: ${existingCount + 1}, at: ${now()}${techSuffix})`);
}

// Gene feedback on failure
const pending = readPending();
if (pending) {
  log.info('gene-feedback', { geneId: pending.geneId, outcome: 'failed' });
  appendJournal(`  - gene_feedback: "${pending.geneTitle}" gene_id=${pending.geneId} outcome=failed`);
  clearPending();
}

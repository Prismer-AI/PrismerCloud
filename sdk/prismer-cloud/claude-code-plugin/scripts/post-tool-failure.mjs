#!/usr/bin/env node
/**
 * PostToolUseFailure hook — Direct Error Capture (v3)
 *
 * Called when a Bash tool execution FAILS. No regex guessing needed —
 * the failure is the signal. Cleaner than parsing stdout for errors.
 *
 * Stdin JSON shape (PostToolUseFailure):
 *   { tool_name, tool_input: { command, ... }, error: "..." }
 *
 * Stdout: empty (informational only)
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SIGNAL_PATTERNS, SKIP_RE } from './lib/signals.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PENDING_FILE = join(CACHE_DIR, 'pending-suggestion.json');
const PENDING_TTL_MS = 3 * 60 * 1000;

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

const toolName = input?.tool_name || 'Bash';
let command = '';
let journalPrefix = 'bash';

if (toolName === 'Bash') {
  command = input?.tool_input?.command || '';
  journalPrefix = 'bash';
} else if (toolName === 'Edit') {
  command = `edit ${input?.tool_input?.file_path || ''}`;
  journalPrefix = 'edit';
} else if (toolName === 'Write') {
  command = `write ${input?.tool_input?.file_path || ''}`;
  journalPrefix = 'write';
}

const error = input?.error || '';

// Skip trivial commands (Bash only)
if (toolName === 'Bash' && SKIP_RE.test(command)) process.exit(0);

// Record the failed tool use
appendJournal(`- ${journalPrefix}: \`${command.slice(0, 120)}\` (${now()}) [FAILED]`);

// Extract signals from error message + command text
const detectedSignals = [];
const searchText = `${error}\n${command}`;
for (const { pattern, type } of SIGNAL_PATTERNS) {
  if (pattern.test(searchText)) {
    detectedSignals.push(type);
  }
}
if (detectedSignals.length === 0) {
  detectedSignals.push('error:generic');
}

// Count existing occurrences in journal
let existingContent = '';
try { existingContent = readFileSync(JOURNAL_FILE, 'utf8'); } catch {}

for (const sig of detectedSignals) {
  const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`signal:${escaped}`, 'g');
  const existingCount = (existingContent.match(regex) || []).length;
  appendJournal(`  - signal:${sig} (count: ${existingCount + 1}, at: ${now()})`);
}

// Gene feedback on failure
try {
  const raw = readFileSync(PENDING_FILE, 'utf8');
  if (raw) {
    const pending = JSON.parse(raw);
    if (pending?.geneId && Date.now() - (pending.suggestedAt || 0) < PENDING_TTL_MS) {
      appendJournal(`  - gene_feedback: "${pending.geneTitle}" gene_id=${pending.geneId} outcome=failed`);
      writeFileSync(PENDING_FILE, '');
    }
  }
} catch {}

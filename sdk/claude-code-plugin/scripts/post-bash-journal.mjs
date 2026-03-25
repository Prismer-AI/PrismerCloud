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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const PENDING_FILE = join(CACHE_DIR, 'pending-suggestion.json');
const PENDING_TTL_MS = 3 * 60 * 1000;

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

// --- Signal Extraction ---

const SIGNAL_PATTERNS = [
  { pattern: /timeout|timed?\s*out/i, type: 'error:timeout' },
  { pattern: /oom|out\s*of\s*memory/i, type: 'error:oom' },
  { pattern: /permission|denied|403|forbidden|EACCES/i, type: 'error:permission_error' },
  { pattern: /not[\s-]*found|404|missing|can'?t\s*resolve/i, type: 'error:not_found' },
  { pattern: /connect|refused|econnrefused/i, type: 'error:connection_refused' },
  { pattern: /port.*in\s*use|EADDRINUSE|address already in use/i, type: 'error:port_in_use' },
  { pattern: /module.*not.*found|cannot find module|ENOENT.*node_modules/i, type: 'error:module_not_found' },
  { pattern: /build|compile|tsc|webpack/i, type: 'error:build_failure' },
  { pattern: /deploy|k8s|kubectl|docker/i, type: 'error:deploy_failure' },
  { pattern: /test|jest|pytest|mocha|vitest/i, type: 'error:test_failure' },
  { pattern: /prisma|migration|schema.*push/i, type: 'error:prisma' },
  { pattern: /typescript|TS\d{4}/i, type: 'error:typescript' },
];

const ERROR_RE = [
  /error[\s:[]/i, /ERR[!_]/, /FAIL/i, /panic:/i, /exception/i, /traceback/i,
  /command not found/i, /module.not.found/i, /cannot resolve/i,
  /build failed/i, /exit code [1-9]/i, /non-zero exit/i,
  /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE/,
];

const SKIP_RE = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|env|printenv|git\s+(status|log|diff|branch|show|remote|tag)|cd\s)/;

// --- Main ---

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command || '';
const resp = input?.tool_response || input?.tool_result || '';
const result = typeof resp === 'string' ? resp : [resp.stdout || '', resp.stderr || ''].join('\n');

// Skip trivial commands
if (SKIP_RE.test(command)) {
  readPending(); // side-effect: clears if expired
  process.exit(0);
}

// Record tool usage in journal
appendJournal(`- bash: \`${command.slice(0, 120)}\` (${now()})`);

const hasError = ERROR_RE.some((re) => re.test(result));

if (!hasError) {
  // Success path
  const pending = readPending();
  if (pending) {
    appendJournal(`  - gene_feedback: "${pending.geneTitle}" outcome=success`);
    clearPending();
  }
  process.exit(0);
}

// Error detected — extract signals and write to journal
const detectedSignals = [];
for (const { pattern, type } of SIGNAL_PATTERNS) {
  if (pattern.test(result) || pattern.test(command)) {
    detectedSignals.push(type);
  }
}
if (detectedSignals.length === 0) {
  detectedSignals.push('error:generic');
}

// Read existing journal to count signal occurrences for stuck detection
let existingContent = '';
try { existingContent = readFileSync(JOURNAL_FILE, 'utf8'); } catch {}

for (const sig of detectedSignals) {
  // Count existing occurrences
  const regex = new RegExp(`signal:${sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const existingCount = (existingContent.match(regex) || []).length;
  const newCount = existingCount + 1;
  appendJournal(`  - signal:${sig} (count: ${newCount}, at: ${now()})`);
}

// Gene feedback on failure
const pending = readPending();
if (pending) {
  appendJournal(`  - gene_feedback: "${pending.geneTitle}" outcome=failed`);
  clearPending();
}

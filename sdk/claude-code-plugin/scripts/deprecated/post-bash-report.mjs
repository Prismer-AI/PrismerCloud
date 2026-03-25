#!/usr/bin/env node
/**
 * PostToolUse hook handler for Bash commands.
 *
 * Called by Claude Code after every Bash tool use. Reads JSON from stdin,
 * detects errors in the output, and reports them to the Prismer Evolution
 * network. Fire-and-forget — never blocks or fails the hook.
 *
 * Stdin JSON shape (PostToolUse):
 *   { tool_name, tool_input: { command, ... }, tool_result: "..." }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use CLAUDE_PLUGIN_DATA for persistent cache that survives plugin updates.
// Falls back to local .cache/ for development (non-marketplace) usage.
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const LAST_ERROR_FILE = join(CACHE_DIR, 'last-error.json');
const PENDING_FILE = join(CACHE_DIR, 'pending-suggestion.json');

const API_KEY = process.env.PRISMER_API_KEY;
const BASE_URL = (process.env.PRISMER_BASE_URL || 'https://prismer.cloud').replace(/\/$/, '');

// No API key → still persist local error memory, just skip remote report
const SKIP_REMOTE = !API_KEY;

// Suggestion TTL: only attribute outcomes within this window
const PENDING_TTL_MS = 3 * 60 * 1000; // 3 minutes (tight to reduce false positives)

// --- Helpers ---

/** Read and parse pending suggestion, returning null if missing/expired/invalid. */
function readPending() {
  try {
    const raw = readFileSync(PENDING_FILE, 'utf8');
    if (!raw) return null;
    const pending = JSON.parse(raw);
    if (!pending?.geneId) return null;
    const age = Date.now() - (pending.suggestedAt || 0);
    if (age > PENDING_TTL_MS) {
      // Expired — clean up silently
      try { writeFileSync(PENDING_FILE, ''); } catch {}
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

/** Clear pending file. */
function clearPending() {
  try { writeFileSync(PENDING_FILE, ''); } catch {}
}

/** Best-effort record call with diagnostic logging on failure. */
async function recordOutcome(geneId, signals, outcome, score, summary) {
  if (SKIP_REMOTE) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref(); // Don't prevent process exit
  try {
    const res = await fetch(`${BASE_URL}/api/im/evolution/record`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ gene_id: geneId, signals, outcome, score, summary }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[prismer] evolution/record ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.error(`[prismer] evolution/record error: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

// --- Main ---

// Read hook input from stdin
let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command || '';

// Claude Code passes tool_response: { stdout, stderr, ... }
const resp = input?.tool_response || input?.tool_result || '';
const result = typeof resp === 'string'
  ? resp
  : [resp.stdout || '', resp.stderr || ''].join('\n');

// Debug: persist raw input for diagnosis
try {
  mkdirSync(dirname(LAST_ERROR_FILE), { recursive: true });
  writeFileSync(join(dirname(LAST_ERROR_FILE), 'debug-input.json'), JSON.stringify({ command, result: result.slice(0, 500), resp_keys: typeof resp === 'object' ? Object.keys(resp) : typeof resp }, null, 2));
} catch {}

// Skip trivial / read-only commands — no useful evolution signal.
// Still clean up expired pending state to prevent stale attribution.
const SKIP_RE = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|env|printenv|git\s+(status|log|diff|branch|show|remote|tag)|cd\s)/;
if (SKIP_RE.test(command)) {
  readPending(); // side-effect: clears if expired
  process.exit(0);
}

// Detect errors in output
const ERROR_RE = [
  /error[\s:[]/i,
  /ERR[!_]/,
  /FAIL/i,
  /panic:/i,
  /exception/i,
  /traceback/i,
  /command not found/i,
  /module.not.found/i,
  /cannot resolve/i,
  /build failed/i,
  /exit code [1-9]/i,
  /non-zero exit/i,
  /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE/,
];

const hasError = ERROR_RE.some((re) => re.test(result));
if (!hasError) {
  // Clear last error on success
  try { writeFileSync(LAST_ERROR_FILE, ''); } catch {}

  // Evolution feedback loop: if a gene was suggested and the command now succeeds → record success
  const pending = readPending();
  if (pending) {
    await recordOutcome(
      pending.geneId,
      pending.signals || [],
      'success',
      0.7,
      `Command succeeded after evolution suggestion "${pending.geneTitle}"`,
    );
    clearPending();
  }

  process.exit(0);
}

// Extract error signals from output (same patterns as pre-bash-suggest)
const SIGNAL_PATTERNS = [
  { pattern: /timeout|timed?\s*out/i, type: 'error:timeout' },
  { pattern: /oom|out\s*of\s*memory/i, type: 'error:oom' },
  { pattern: /permission|denied|403|forbidden|EACCES/i, type: 'error:permission_error' },
  { pattern: /not[\s-]*found|404|missing|can'?t\s*resolve/i, type: 'error:not_found' },
  { pattern: /connect|refused|econnrefused/i, type: 'error:connection_refused' },
  { pattern: /port.*in\s*use|EADDRINUSE|address already in use/i, type: 'error:port_in_use' },
  { pattern: /build|compile|tsc|webpack/i, type: 'error:build_failure' },
  { pattern: /deploy|k8s|kubectl|docker/i, type: 'error:deploy_failure' },
  { pattern: /test|jest|pytest|mocha/i, type: 'error:test_failure' },
];

const detectedSignals = [];
for (const { pattern, type } of SIGNAL_PATTERNS) {
  if (pattern.test(result) || pattern.test(command)) {
    detectedSignals.push({ type });
  }
}
if (detectedSignals.length === 0) {
  detectedSignals.push({ type: 'error:generic' });
}

// Persist last error for PreToolUse to read
try {
  mkdirSync(dirname(LAST_ERROR_FILE), { recursive: true });
  writeFileSync(LAST_ERROR_FILE, JSON.stringify({
    signals: detectedSignals,
    command: command.slice(0, 500),
    snippet: result.slice(-1000),
    ts: Date.now(),
  }));
} catch (err) {
  console.error(`[prismer] failed to write error memory: ${err?.message || err}`);
}

// Report to evolution (best-effort, 5s timeout)
if (!SKIP_REMOTE) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref();
  try {
    await fetch(`${BASE_URL}/api/im/evolution/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        raw_context: result.slice(-2000),
        outcome: 'failed',
        task: command.slice(0, 500),
        provider: 'claude-code',
        stage: 'bash',
        severity: 'medium',
      }),
      signal: controller.signal,
    });
  } catch {
    // Best-effort — report is secondary
  } finally {
    clearTimeout(timer);
  }
}

// Evolution feedback loop: if a gene was suggested but the command still fails → record failure
const pending = readPending();
if (pending) {
  await recordOutcome(
    pending.geneId,
    pending.signals || [],
    'failed',
    0.2,
    `Command failed despite evolution suggestion "${pending.geneTitle}"`,
  );
  clearPending();
}

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
const LAST_ERROR_FILE = join(__dirname, '..', '.cache', 'last-error.json');

const API_KEY = process.env.PRISMER_API_KEY;
const BASE_URL = (process.env.PRISMER_BASE_URL || 'https://prismer.cloud').replace(/\/$/, '');

// No API key → still persist local error memory, just skip remote report
const SKIP_REMOTE = !API_KEY;

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

// Skip trivial / read-only commands — no useful evolution signal
const SKIP_RE = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|env|printenv|git\s+(status|log|diff|branch|show|remote|tag)|cd\s)/;
if (SKIP_RE.test(command)) process.exit(0);

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
} catch {}

// Report to evolution (best-effort, 5s timeout)
if (SKIP_REMOTE) process.exit(0);
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

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

  clearTimeout(timer);
} catch {
  // Best-effort — never fail the hook
}

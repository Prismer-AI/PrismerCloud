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

import { readFileSync } from 'fs';

const API_KEY = process.env.PRISMER_API_KEY;
const BASE_URL = (process.env.PRISMER_BASE_URL || 'https://prismer.cloud').replace(/\/$/, '');

// No API key → silently skip
if (!API_KEY) process.exit(0);

// Read hook input from stdin
let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command || '';
const result = typeof input?.tool_result === 'string'
  ? input.tool_result
  : JSON.stringify(input?.tool_result || '');

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
  /exit code [1-9]/i,
  /non-zero exit/i,
  /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT/,
];

const hasError = ERROR_RE.some((re) => re.test(result));
if (!hasError) process.exit(0);

// Report to evolution (best-effort, 5s timeout)
// NOTE: For production integrations beyond this hook, use the reusable EvolutionClient
// from @prismer/opencode-plugin/evolution-client which provides analyze(), report(), and
// record() methods with proper typing. This hook uses inline fetch to stay zero-dependency.
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

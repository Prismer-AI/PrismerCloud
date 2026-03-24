#!/usr/bin/env node
/**
 * PreToolUse hook handler for Bash commands.
 *
 * Called by Claude Code BEFORE every Bash tool use. Reads the command from stdin,
 * extracts error signals from recent context, and queries the Prismer Evolution
 * network for known fix strategies. If a high-confidence recommendation exists,
 * outputs it as a suggestion that Claude Code injects into context.
 *
 * Stdin JSON shape (PreToolUse):
 *   { tool_name, tool_input: { command, ... } }
 *
 * Stdout: suggestion text (or empty for no suggestion)
 */

import { readFileSync } from 'fs';

const API_KEY = process.env.PRISMER_API_KEY;
const BASE_URL = (process.env.PRISMER_BASE_URL || 'https://prismer.cloud').replace(/\/$/, '');

if (!API_KEY) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command || '';

// Skip trivial commands — no point suggesting for ls/cat/git status
const SKIP_RE = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|env|printenv|git\s+(status|log|diff|branch|show|remote|tag)|cd\s)/;
if (SKIP_RE.test(command)) process.exit(0);

// Extract potential error signals from command context
// Look for patterns that suggest the user is dealing with an error
const ERROR_CONTEXT_RE = [
  /fix|debug|troubleshoot|resolve|repair/i,
  /error|fail|broken|crash|timeout/i,
  /retry|again|attempt/i,
];

const isErrorContext = ERROR_CONTEXT_RE.some(re => re.test(command));
if (!isErrorContext) process.exit(0);

// Extract signal tags from command
const SIGNAL_PATTERNS = [
  { pattern: /timeout|timed?\s*out/i, type: 'error:timeout' },
  { pattern: /oom|out\s*of\s*memory|kill/i, type: 'error:oom' },
  { pattern: /permission|denied|403|forbidden/i, type: 'error:permission_error' },
  { pattern: /not\s*found|404|missing/i, type: 'error:not_found' },
  { pattern: /connect|refused|econnrefused/i, type: 'error:connection_refused' },
  { pattern: /build|compile|tsc|webpack/i, type: 'task:build' },
  { pattern: /deploy|k8s|kubectl|docker/i, type: 'task:deploy' },
  { pattern: /test|jest|pytest|mocha/i, type: 'task:test' },
  { pattern: /migrate|migration|schema/i, type: 'task:migrate' },
];

const signals = [];
for (const { pattern, type } of SIGNAL_PATTERNS) {
  if (pattern.test(command)) {
    signals.push({ type });
  }
}

if (signals.length === 0) {
  signals.push({ type: 'error:generic' });
}

// Query evolution network (3s timeout — PreToolUse should be fast)
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  const res = await fetch(`${BASE_URL}/api/im/evolution/analyze`, {
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

  if (advice?.action === 'apply_gene' && advice?.confidence > 0.4) {
    const gene = advice.gene;
    const strategy = gene?.strategy || [];

    // Output suggestion for Claude Code to inject
    const suggestion = [
      `[Prismer Evolution] Known fix for this type of issue (confidence: ${Math.round(advice.confidence * 100)}%):`,
      `Strategy: "${gene?.title || advice.gene_id}"`,
      ...strategy.map((s, i) => `  ${i + 1}. ${s}`),
      '',
    ].join('\n');

    process.stdout.write(suggestion);
  }
} catch {
  // Timeout or error — don't block
}

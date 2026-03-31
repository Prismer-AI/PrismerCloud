/**
 * Shared signal patterns and detection utilities for OpenClaw Prismer channel.
 *
 * Ported from Claude Code Plugin's signals.mjs — single source of truth
 * for error signal detection across inbound.ts (auto-detection) and
 * tools.ts (manual analysis).
 */

export interface SignalPattern {
  pattern: RegExp;
  type: string;
}

/** Signal patterns — matched against message content or error messages */
export const SIGNAL_PATTERNS: SignalPattern[] = [
  { pattern: /timeout|timed?\s*out/i, type: 'error:timeout' },
  { pattern: /oom|out\s*of\s*memory/i, type: 'error:oom' },
  { pattern: /permission|denied|403|forbidden|EACCES/i, type: 'error:permission_error' },
  { pattern: /not[\s-]*found|404|missing|can'?t\s*resolve/i, type: 'error:not_found' },
  { pattern: /connect|refused|econnrefused/i, type: 'error:connection_refused' },
  { pattern: /port.*in\s*use|EADDRINUSE|address already in use/i, type: 'error:port_in_use' },
  { pattern: /module.*not.*found|cannot find module|ENOENT.*node_modules/i, type: 'error:module_not_found' },
  { pattern: /build\s*(fail|error)|compile.*error|tsc.*error|webpack.*error/i, type: 'error:build_failure' },
  { pattern: /deploy\s*(fail|error)|kubectl.*(error|fail)|docker.*(error|fail)/i, type: 'error:deploy_failure' },
  { pattern: /test\s*(fail|error)|jest.*(fail|error)|pytest.*(fail|error)|mocha.*(fail|error)|vitest.*(fail|error)/i, type: 'error:test_failure' },
  { pattern: /prisma|migration|schema.*push/i, type: 'error:prisma' },
  { pattern: /typescript|TS\d{4}/i, type: 'error:typescript' },
];

/** Broad error indicator regex — gate check before detailed signal extraction */
export const ERROR_INDICATORS: RegExp[] = [
  /error[\s:[]/i, /ERR[!_]/, /FAIL/i, /panic:/i, /exception/i, /traceback/i,
  /command not found/i, /module.not.found/i, /cannot resolve/i,
  /build failed/i, /exit code [1-9]/i, /non-zero exit/i,
  /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE/,
  /timeout|timed?\s*out/i, /oom|out\s*of\s*memory/i,
  /denied|forbidden|refused/i, /crash/i,
];

/** Extract all matching signal types from text. Returns ['error:generic'] if no specific match. */
export function detectSignals(text: string): string[] {
  const signals: string[] = [];
  for (const { pattern, type } of SIGNAL_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(type);
    }
  }
  return signals.length > 0 ? signals : ['error:generic'];
}

/** Check if text contains any error indicators (broad gate). */
export function hasErrorIndicators(text: string): boolean {
  return ERROR_INDICATORS.some(re => re.test(text));
}

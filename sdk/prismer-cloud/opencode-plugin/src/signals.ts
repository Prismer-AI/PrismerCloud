/**
 * Shared signal patterns and detection utilities.
 *
 * Single source of truth for error signal detection across all hooks.
 * Ported from claude-code-plugin/scripts/lib/signals.mjs with TypeScript types.
 */

/** Signal pattern definition */
export interface SignalPattern {
  pattern: RegExp;
  type: string;
}

/** Signal patterns — matched against command output or error messages */
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

/** Error indicators in command output (gate before signal extraction) */
export const ERROR_RE: RegExp[] = [
  /error[\s:[]/i, /ERR[!_]/, /FAIL/i, /panic:/i, /exception/i, /traceback/i,
  /command not found/i, /module.not.found/i, /cannot resolve/i,
  /build failed/i, /exit code [1-9]/i, /non-zero exit/i,
  /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE/,
];

/** Error context indicators (for pre-tool-use stuck detection) */
export const ERROR_CONTEXT_RE: RegExp[] = [
  /fix|debug|troubleshoot|resolve|repair/i,
  /error|fail|broken|crash|timeout/i,
  /retry|again|attempt/i,
];

/** Commands to skip (read-only, trivial) */
export const SKIP_RE = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|env|printenv|git\s+(status|log|diff|branch|show|remote|tag)|cd\s)/;

/** Extract signal types from text */
export function detectSignals(text: string): string[] {
  const signals: string[] = [];
  for (const { pattern, type } of SIGNAL_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(type);
    }
  }
  return signals.length > 0 ? signals : ['error:generic'];
}

/** Check if text contains error indicators */
export function hasError(text: string): boolean {
  return ERROR_RE.some(re => re.test(text));
}

/** Check if text contains error context (for pre-tool stuck detection) */
export function hasErrorContext(text: string): boolean {
  return ERROR_CONTEXT_RE.some(re => re.test(text));
}

/** Count signal occurrences in journal text */
export function countSignal(journalText: string, signalType: string): number {
  const escaped = signalType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`signal:${escaped}`, 'g');
  return (journalText.match(regex) || []).length;
}

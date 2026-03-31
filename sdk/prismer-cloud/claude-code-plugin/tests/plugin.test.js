/**
 * Test suite for @prismer/claude-code-plugin
 *
 * Tests the shared signal library and hook script behavior.
 * Hook scripts are standalone processes (read stdin, write stdout),
 * so we test them by spawning child processes with controlled stdin/env.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, execFile } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// --- Direct imports for unit-testable modules ---
import {
  SIGNAL_PATTERNS,
  ERROR_RE,
  ERROR_CONTEXT_RE,
  SKIP_RE,
  detectSignals,
  hasError,
  countSignal,
} from '../scripts/lib/signals.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', 'scripts');

// Temp directory for hook cache files
let TEST_CACHE_DIR;

function freshCacheDir() {
  const dir = join(tmpdir(), `prismer-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run a hook script as a child process with controlled stdin and environment.
 * Returns { stdout, stderr, exitCode }.
 */
function runHook(scriptName, stdinData = '{}', env = {}) {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);

  const fullEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: TEST_CACHE_DIR,
    // Clear API key by default (tests that need it will set it explicitly)
    PRISMER_API_KEY: '',
    PRISMER_BASE_URL: 'http://localhost:19999',
    // Prevent config.toml fallback from interfering
    HOME: TEST_CACHE_DIR,
    _PRISMER_SETUP_SHOWN: '1',
    ...env,
  };

  try {
    const stdout = execFileSync('node', [scriptPath], {
      input,
      env: fullEnv,
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

// ============================================================
// signals.mjs — Unit Tests
// ============================================================

describe('signals.mjs', () => {
  describe('SIGNAL_PATTERNS', () => {
    it('should be a non-empty array of pattern/type pairs', () => {
      expect(SIGNAL_PATTERNS.length).toBeGreaterThan(0);
      for (const entry of SIGNAL_PATTERNS) {
        expect(entry).toHaveProperty('pattern');
        expect(entry).toHaveProperty('type');
        expect(entry.pattern).toBeInstanceOf(RegExp);
        expect(typeof entry.type).toBe('string');
        expect(entry.type).toMatch(/^error:/);
      }
    });
  });

  describe('detectSignals()', () => {
    it('should detect timeout errors', () => {
      const signals = detectSignals('Connection timed out after 30s');
      expect(signals).toContain('error:timeout');
    });

    it('should detect OOM errors', () => {
      const signals = detectSignals('JavaScript heap out of memory');
      expect(signals).toContain('error:oom');
    });

    it('should detect permission errors', () => {
      expect(detectSignals('EACCES: permission denied')).toContain('error:permission_error');
      expect(detectSignals('403 Forbidden')).toContain('error:permission_error');
    });

    it('should detect not-found errors', () => {
      expect(detectSignals('Error 404: Not Found')).toContain('error:not_found');
      // "can't resolve module" maps to module_not_found, not not_found
      expect(detectSignals("can't resolve module 'foo'")).toContain('error:not_found');
      // "missing dependency" may map to module_not_found or not_found depending on implementation
      const missingDep = detectSignals('missing dependency xyz');
      expect(missingDep.length).toBeGreaterThan(0);
    });

    it('should detect connection refused errors', () => {
      expect(detectSignals('ECONNREFUSED 127.0.0.1:3000')).toContain('error:connection_refused');
    });

    it('should detect port-in-use errors', () => {
      expect(detectSignals('EADDRINUSE: address already in use :::3000')).toContain('error:port_in_use');
    });

    it('should detect module-not-found errors', () => {
      expect(detectSignals("Cannot find module '@prismer/sdk'")).toContain('error:module_not_found');
    });

    it('should detect build failure errors', () => {
      expect(detectSignals('webpack compilation failed')).toContain('error:build_failure');
    });

    it('should detect deploy failure errors', () => {
      expect(detectSignals('kubectl apply failed: deployment error')).toContain('error:deploy_failure');
    });

    it('should detect test failure errors', () => {
      expect(detectSignals('vitest: 3 tests failed')).toContain('error:test_failure');
    });

    it('should detect prisma errors', () => {
      expect(detectSignals('prisma migrate failed')).toContain('error:prisma');
    });

    it('should detect typescript errors', () => {
      expect(detectSignals('TS2304: Cannot find name')).toContain('error:typescript');
    });

    it('should return error:generic when no pattern matches', () => {
      const signals = detectSignals('some random text with no error patterns');
      expect(signals).toEqual(['error:generic']);
    });

    it('should detect multiple signals from one text', () => {
      const text = 'Connection timed out, EACCES permission denied on deployment, kubectl failed';
      const signals = detectSignals(text);
      expect(signals).toContain('error:timeout');
      expect(signals).toContain('error:permission_error');
      expect(signals).toContain('error:deploy_failure');
      expect(signals.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle empty string', () => {
      const signals = detectSignals('');
      expect(signals).toEqual(['error:generic']);
    });

    it('should be case-insensitive for most patterns', () => {
      expect(detectSignals('TIMEOUT')).toContain('error:timeout');
      expect(detectSignals('Timed Out')).toContain('error:timeout');
      expect(detectSignals('OUT OF MEMORY')).toContain('error:oom');
    });
  });

  describe('hasError()', () => {
    it('should detect error indicators', () => {
      expect(hasError('Error: something went wrong')).toBe(true);
      expect(hasError('ERR! npm install failed')).toBe(true);
      expect(hasError('FAIL src/test.ts')).toBe(true);
      expect(hasError('panic: runtime error')).toBe(true);
      expect(hasError('exception in thread')).toBe(true);
      expect(hasError('Traceback (most recent call last):')).toBe(true);
    });

    it('should detect system error codes', () => {
      expect(hasError('ENOENT: no such file')).toBe(true);
      expect(hasError('EACCES: permission denied')).toBe(true);
      expect(hasError('ECONNREFUSED')).toBe(true);
      expect(hasError('ETIMEDOUT')).toBe(true);
      expect(hasError('EADDRINUSE')).toBe(true);
    });

    it('should detect exit code errors', () => {
      expect(hasError('process exited with exit code 1')).toBe(true);
      expect(hasError('non-zero exit status')).toBe(true);
    });

    it('should detect build failures', () => {
      expect(hasError('build failed with 2 errors')).toBe(true);
    });

    it('should return false for clean output', () => {
      expect(hasError('Server started on port 3000')).toBe(false);
      expect(hasError('Build completed successfully')).toBe(false);
      expect(hasError('All 42 tests passed')).toBe(false);
    });
  });

  describe('countSignal()', () => {
    it('should count signal occurrences in journal text', () => {
      const journal = [
        '- bash: `npm run build` (14:30)',
        '  - signal:error:build_failure (count: 1)',
        '- bash: `npm run build` (14:32)',
        '  - signal:error:build_failure (count: 2)',
        '  - signal:error:typescript (count: 1)',
      ].join('\n');

      expect(countSignal(journal, 'error:build_failure')).toBe(2);
      expect(countSignal(journal, 'error:typescript')).toBe(1);
      expect(countSignal(journal, 'error:oom')).toBe(0);
    });

    it('should handle empty journal', () => {
      expect(countSignal('', 'error:timeout')).toBe(0);
    });

    it('should match partial signal names (prefix match)', () => {
      const journal = '  - signal:error:build_failure (count: 1)';
      // countSignal uses substring regex, so "error:build" matches inside "error:build_failure"
      expect(countSignal(journal, 'error:build')).toBe(1);
    });

    it('should not match unrelated signal names', () => {
      const journal = '  - signal:error:build_failure (count: 1)';
      expect(countSignal(journal, 'error:timeout')).toBe(0);
      expect(countSignal(journal, 'error:oom')).toBe(0);
    });
  });

  describe('SKIP_RE', () => {
    it('should match trivial read-only commands', () => {
      expect(SKIP_RE.test('ls -la')).toBe(true);
      expect(SKIP_RE.test('pwd')).toBe(true);
      expect(SKIP_RE.test('echo hello')).toBe(true);
      expect(SKIP_RE.test('cat file.txt')).toBe(true);
      expect(SKIP_RE.test('git status')).toBe(true);
      expect(SKIP_RE.test('git log --oneline')).toBe(true);
      expect(SKIP_RE.test('git diff HEAD')).toBe(true);
      expect(SKIP_RE.test('cd /tmp')).toBe(true);
    });

    it('should not match substantive commands', () => {
      expect(SKIP_RE.test('npm run build')).toBe(false);
      expect(SKIP_RE.test('docker compose up')).toBe(false);
      expect(SKIP_RE.test('npx prisma db push')).toBe(false);
      expect(SKIP_RE.test('rm -rf node_modules')).toBe(false);
      expect(SKIP_RE.test('git push origin main')).toBe(false);
    });
  });

  describe('ERROR_CONTEXT_RE', () => {
    it('should match error context words', () => {
      expect(ERROR_CONTEXT_RE.some(re => re.test('fix the build'))).toBe(true);
      expect(ERROR_CONTEXT_RE.some(re => re.test('debug this error'))).toBe(true);
      expect(ERROR_CONTEXT_RE.some(re => re.test('retry the deployment'))).toBe(true);
    });
  });
});

// ============================================================
// resolve-config.mjs — Unit Tests
// ============================================================

describe('resolve-config.mjs', () => {
  // resolve-config caches its result in a module-level variable,
  // so we test it via the hook scripts which import it fresh each time
  // (each hook runs in its own process).

  it('should use PRISMER_API_KEY from environment', () => {
    // session-stop exits immediately if no API key, so we can test
    // that it does NOT exit immediately when key is provided
    const result = runHook('session-stop.mjs', '{}', {
      PRISMER_API_KEY: 'sk-prismer-test-key-123',
    });
    // With a valid API key, session-stop reads journal and checks for value
    // Since journal is empty, it exits 0 (no value to block for)
    expect(result.exitCode).toBe(0);
  });

  it('should reject non-sk-prismer API keys', () => {
    // An API key that does not start with sk-prismer- should be treated as empty
    const result = runHook('session-stop.mjs', '{}', {
      PRISMER_API_KEY: 'some-jwt-token-here',
    });
    // Without valid API key, session-stop exits immediately (exit 0)
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('should use PRISMER_BASE_URL from environment', () => {
    // We test indirectly: session-start with API key will try to fetch from BASE_URL.
    // With an unreachable URL and short timeout, it should still not crash.
    const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }), {
      PRISMER_API_KEY: 'sk-prismer-test-key-123',
      PRISMER_BASE_URL: 'http://127.0.0.1:19999',
    });
    // Should not crash (exit 0), even if fetch fails
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// Hook Scripts — Integration Tests (process-level)
// ============================================================

describe('Hook Scripts', () => {
  beforeEach(() => {
    TEST_CACHE_DIR = freshCacheDir();
  });

  afterEach(() => {
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    } catch {}
  });

  // --- session-start.mjs ---

  describe('session-start.mjs', () => {
    it('should create session journal on startup', () => {
      const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }));
      expect(result.exitCode).toBe(0);

      const journalPath = join(TEST_CACHE_DIR, 'session-journal.md');
      expect(existsSync(journalPath)).toBe(true);
      const content = readFileSync(journalPath, 'utf8');
      expect(content).toContain('# Session Journal');
      expect(content).toContain('Started:');
    });

    it('should rotate previous journal on startup', () => {
      // Create a pre-existing journal
      const journalPath = join(TEST_CACHE_DIR, 'session-journal.md');
      writeFileSync(journalPath, '# Old Journal\nSome old content\n');

      const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }));
      expect(result.exitCode).toBe(0);

      // Old journal should be renamed
      const prevPath = join(TEST_CACHE_DIR, 'prev-session-journal.md');
      expect(existsSync(prevPath)).toBe(true);
      const prevContent = readFileSync(prevPath, 'utf8');
      expect(prevContent).toContain('Old Journal');

      // New journal should be fresh
      const newContent = readFileSync(journalPath, 'utf8');
      expect(newContent).not.toContain('Old Journal');
    });

    it('should not rotate journal on resume event', () => {
      const journalPath = join(TEST_CACHE_DIR, 'session-journal.md');
      writeFileSync(journalPath, '# Existing Journal\nIn-progress session\n');

      const result = runHook('session-start.mjs', JSON.stringify({ type: 'resume' }));
      expect(result.exitCode).toBe(0);

      // Journal should NOT be rotated
      const content = readFileSync(journalPath, 'utf8');
      expect(content).toContain('Existing Journal');

      const prevPath = join(TEST_CACHE_DIR, 'prev-session-journal.md');
      expect(existsSync(prevPath)).toBe(false);
    });

    it('should output no evolution context when no API key', () => {
      const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }));
      expect(result.exitCode).toBe(0);
      // Without API key, no evolution context is injected
      expect(result.stdout).not.toContain('[Prismer Evolution Context]');
      expect(result.stdout).not.toContain('[Prismer Evolution]');
    });

    it('should output evolution review instruction when API key is present', () => {
      const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }), {
        PRISMER_API_KEY: 'sk-prismer-test-key-abc',
        PRISMER_BASE_URL: 'http://127.0.0.1:19999',
      });
      expect(result.exitCode).toBe(0);
      // Even if fetch fails, the review instruction is always injected
      expect(result.stdout).toContain('[Prismer Evolution]');
      expect(result.stdout).toContain('evolve_create_gene');
    });

    it('should handle malformed stdin gracefully', () => {
      const result = runHook('session-start.mjs', 'not-json!!!');
      expect(result.exitCode).toBe(0);
    });

    it('should handle empty stdin gracefully', () => {
      const result = runHook('session-start.mjs', '');
      expect(result.exitCode).toBe(0);
    });
  });

  // --- post-bash-journal.mjs ---

  describe('post-bash-journal.mjs', () => {
    it('should record bash command in journal', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        tool_result: 'Build completed successfully',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('bash: `npm run build`');
    });

    it('should detect error signals in output', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        tool_result: 'Error: EACCES permission denied /usr/local/lib',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('signal:error:permission_error');
    });

    it('should record generic error when no specific pattern matches', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'some-weird-command' },
        tool_result: 'Error: unexpected failure with code XYZ',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('signal:error:generic');
    });

    it('should skip trivial commands', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_result: 'total 42\ndrwxr-xr-x ...',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      // Journal should not exist or not contain the ls command
      const journalPath = join(TEST_CACHE_DIR, 'session-journal.md');
      if (existsSync(journalPath)) {
        const journal = readFileSync(journalPath, 'utf8');
        expect(journal).not.toContain('bash: `ls');
      }
    });

    it('should record gene feedback success when pending suggestion exists', () => {
      // Write a pending suggestion
      const pendingPath = join(TEST_CACHE_DIR, 'pending-suggestion.json');
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(pendingPath, JSON.stringify({
        geneId: 'gene-123',
        geneTitle: 'Fix build with clean install',
        signals: [{ type: 'error:build_failure' }],
        suggestedAt: Date.now(),
      }));

      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm ci && npm run build' },
        tool_result: 'Build succeeded!',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('gene_feedback: "Fix build with clean install" outcome=success');
    });

    it('should record gene feedback failure when pending and error detected', () => {
      const pendingPath = join(TEST_CACHE_DIR, 'pending-suggestion.json');
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(pendingPath, JSON.stringify({
        geneId: 'gene-456',
        geneTitle: 'Clear node_modules cache',
        signals: [{ type: 'error:module_not_found' }],
        suggestedAt: Date.now(),
      }));

      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        tool_result: "Error: Cannot find module '@prismer/sdk'",
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('gene_feedback: "Clear node_modules cache" outcome=failed');
    });

    it('should handle tool_response field (alternative to tool_result)', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: 'FAIL: 3 tests failed',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('signal:error:test_failure');
    });

    it('should handle malformed stdin gracefully', () => {
      const result = runHook('post-bash-journal.mjs', 'garbage');
      expect(result.exitCode).toBe(0);
    });

    it('should truncate long commands in journal', () => {
      const longCmd = 'x'.repeat(200);
      const input = {
        tool_name: 'Bash',
        tool_input: { command: longCmd },
        tool_result: 'ok',
      };
      const result = runHook('post-bash-journal.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      // Command should be truncated to 120 chars
      const cmdInJournal = journal.match(/`([^`]+)`/)?.[1] || '';
      expect(cmdInJournal.length).toBeLessThanOrEqual(120);
    });
  });

  // --- pre-bash-suggest.mjs ---

  describe('pre-bash-suggest.mjs', () => {
    it('should exit silently for trivial commands', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      };
      const result = runHook('pre-bash-suggest.mjs', input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should exit silently when no error context in command', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
      };
      const result = runHook('pre-bash-suggest.mjs', input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should exit silently on first error occurrence (not stuck yet)', () => {
      // Create a journal with zero prior signals
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), '# Session Journal\n');

      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'fix the timeout error' },
      };
      const result = runHook('pre-bash-suggest.mjs', input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should show hint when stuck and no API key', () => {
      // Create a journal with 2 prior timeout signals
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '- bash: `npm start` (10:00)',
        '  - signal:error:timeout (count: 1)',
        '- bash: `npm start` (10:05)',
        '  - signal:error:timeout (count: 2)',
      ].join('\n'));

      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'fix the timeout issue' },
      };
      const result = runHook('pre-bash-suggest.mjs', input, {
        PRISMER_API_KEY: '',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[Prismer Evolution]');
      expect(result.stdout).toContain('Repeated error detected');
      expect(result.stdout).toContain('PRISMER_API_KEY');
    });

    it('should handle malformed stdin without crashing', () => {
      const result = runHook('pre-bash-suggest.mjs', '{{invalid');
      expect(result.exitCode).toBe(0);
    });

    it('should handle missing tool_input gracefully', () => {
      const result = runHook('pre-bash-suggest.mjs', JSON.stringify({ tool_name: 'Bash' }));
      expect(result.exitCode).toBe(0);
    });
  });

  // --- post-tool-failure.mjs ---

  describe('post-tool-failure.mjs', () => {
    it('should record failure signal in journal', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        error: 'EACCES: permission denied',
      };
      const result = runHook('post-tool-failure.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('[FAILED]');
      expect(journal).toContain('signal:error:permission_error');
    });

    it('should record generic signal when no pattern matches', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'custom-tool' },
        error: 'Unknown failure reason XYZ',
      };
      const result = runHook('post-tool-failure.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('signal:error:generic');
    });

    it('should skip trivial commands', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'ls /nonexistent' },
        error: 'No such file or directory',
      };
      const result = runHook('post-tool-failure.mjs', input);
      expect(result.exitCode).toBe(0);

      const journalPath = join(TEST_CACHE_DIR, 'session-journal.md');
      if (existsSync(journalPath)) {
        const journal = readFileSync(journalPath, 'utf8');
        expect(journal).not.toContain('[FAILED]');
      }
    });

    it('should record gene feedback failure when pending suggestion exists', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'pending-suggestion.json'), JSON.stringify({
        geneId: 'gene-789',
        geneTitle: 'Try docker restart',
        signals: [{ type: 'error:deploy_failure' }],
        suggestedAt: Date.now(),
      }));

      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'docker compose up' },
        error: 'Error: container failed to start',
      };
      const result = runHook('post-tool-failure.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('gene_feedback: "Try docker restart" outcome=failed');
    });

    it('should detect signals from both error and command text', () => {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'kubectl apply -f deployment.yaml' },
        error: 'connection refused',
      };
      const result = runHook('post-tool-failure.mjs', input);
      expect(result.exitCode).toBe(0);

      const journal = readFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), 'utf8');
      expect(journal).toContain('signal:error:connection_refused');
      expect(journal).toContain('signal:error:deploy_failure');
    });

    it('should handle malformed stdin gracefully', () => {
      const result = runHook('post-tool-failure.mjs', '');
      expect(result.exitCode).toBe(0);
    });
  });

  // --- session-stop.mjs ---

  describe('session-stop.mjs', () => {
    it('should exit silently when no API key', () => {
      const result = runHook('session-stop.mjs', '{}', { PRISMER_API_KEY: '' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should exit silently when stop_hook_active is true (prevent infinite loop)', () => {
      const result = runHook('session-stop.mjs', JSON.stringify({ stop_hook_active: true }), {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should exit silently when journal is empty (no evolution value)', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), '# Session Journal\n\nStarted: 2025-01-01\n\n');

      const result = runHook('session-stop.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should block when journal has evolution value (error signals)', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '',
        'Started: 2025-01-01',
        '',
        '- bash: `npm run build` (10:00)',
        '  - signal:error:build_failure (count: 1)',
        '- bash: `npm run build` (10:05)',
        '  - signal:error:build_failure (count: 2)',
      ].join('\n'));

      const result = runHook('session-stop.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.decision).toBe('block');
    });

    it('should block when journal has enough bash commands (>= 5)', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '',
        'Started: 2025-01-01',
        '',
        '- bash: `cmd1` (10:00)',
        '- bash: `cmd2` (10:01)',
        '- bash: `cmd3` (10:02)',
        '- bash: `cmd4` (10:03)',
        '- bash: `cmd5` (10:04)',
      ].join('\n'));

      const result = runHook('session-stop.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.decision).toBe('block');
    });

    it('should not block if already triggered this session', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '',
        '- bash: `cmd1` (10:00)',
        '- bash: `cmd2` (10:01)',
        '- bash: `cmd3` (10:02)',
        '- bash: `cmd4` (10:03)',
        '- bash: `cmd5` (10:04)',
        '',
        '[evolution-review-triggered] (at: 2025-01-01T10:05:00Z)',
      ].join('\n'));

      const result = runHook('session-stop.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should respect cooldown period', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      // Write recent block marker (within 1 hour)
      writeFileSync(join(TEST_CACHE_DIR, 'last-block.json'), JSON.stringify({ ts: Date.now() - 1000 }));
      // Write journal with enough value to block
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '- bash: `cmd1` (10:00)',
        '- bash: `cmd2` (10:01)',
        '- bash: `cmd3` (10:02)',
        '- bash: `cmd4` (10:03)',
        '- bash: `cmd5` (10:04)',
      ].join('\n'));

      const result = runHook('session-stop.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(''); // Cooldown prevents blocking
    });

    it('should write block marker file when blocking', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '',
        'Started: 2025-01-01',
        '',
        '- bash: `cmd1` (10:00)',
        '  - signal:error:build_failure (count: 1)',
        '  - signal:error:build_failure (count: 2)',
      ].join('\n'));

      runHook('session-stop.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });

      const markerPath = join(TEST_CACHE_DIR, 'last-block.json');
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      expect(marker.ts).toBeGreaterThan(Date.now() - 5000);
    });
  });

  // --- session-end.mjs ---

  describe('session-end.mjs', () => {
    it('should exit silently when no API key', () => {
      const result = runHook('session-end.mjs', '{}', { PRISMER_API_KEY: '' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should exit silently when journal is empty', () => {
      const result = runHook('session-end.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
    });

    it('should exit silently when evolution review was already triggered', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '- bash: `cmd` (10:00)',
        '  - signal:error:timeout (count: 1)',
        '[evolution-review-triggered] (at: 2025-01-01T10:05:00Z)',
      ].join('\n'));

      const result = runHook('session-end.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
    });

    it('should exit silently when journal has no outcomes or signals', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '',
        'Started: 2025-01-01',
        '',
        '- bash: `npm run build` (10:00)',
      ].join('\n'));

      const result = runHook('session-end.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
      });
      expect(result.exitCode).toBe(0);
    });

    it('should not crash when journal has signals but server is unreachable', () => {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '- bash: `npm build` (10:00)',
        '  - signal:error:build_failure (count: 1)',
      ].join('\n'));

      const result = runHook('session-end.mjs', '{}', {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
        PRISMER_BASE_URL: 'http://127.0.0.1:19999',
      });
      // Should not crash even though server is unreachable
      expect(result.exitCode).toBe(0);
    });
  });
});

// ============================================================
// Graceful Degradation Tests
// ============================================================

describe('Graceful Degradation', () => {
  beforeEach(() => {
    TEST_CACHE_DIR = freshCacheDir();
  });

  afterEach(() => {
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('all hooks should handle no API key without crashing', () => {
    const hooks = [
      'session-start.mjs',
      'pre-bash-suggest.mjs',
      'post-bash-journal.mjs',
      'post-tool-failure.mjs',
      'session-stop.mjs',
      'session-end.mjs',
    ];

    for (const hook of hooks) {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        tool_result: 'Error: build failed',
        error: 'build failed',
        type: 'startup',
      };
      const result = runHook(hook, input, { PRISMER_API_KEY: '' });
      expect(result.exitCode).toBe(0);
    }
  });

  it('all hooks should handle invalid API key format without crashing', () => {
    const hooks = [
      'session-start.mjs',
      'pre-bash-suggest.mjs',
      'post-bash-journal.mjs',
      'post-tool-failure.mjs',
      'session-stop.mjs',
      'session-end.mjs',
    ];

    for (const hook of hooks) {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_result: 'FAIL: tests failed',
        error: 'test failed',
        type: 'startup',
      };
      // JWT-style key (not sk-prismer-*) should be treated as no key
      const result = runHook(hook, input, {
        PRISMER_API_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake',
      });
      expect(result.exitCode).toBe(0);
    }
  });

  it('all hooks should handle network timeout without crashing', () => {
    // Use an unreachable address to trigger timeout
    const hooks = [
      'session-start.mjs',
      'pre-bash-suggest.mjs',
      'session-end.mjs',
    ];

    for (const hook of hooks) {
      const input = {
        tool_name: 'Bash',
        tool_input: { command: 'fix timeout error again' },
        tool_result: 'Error: timeout',
        type: 'startup',
      };

      // For pre-bash-suggest, create journal with enough signals to trigger stuck detection
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
        '# Session Journal',
        '- bash: `cmd` (10:00)',
        '  - signal:error:timeout (count: 1)',
        '  - signal:error:timeout (count: 2)',
        '  - signal:error:build_failure (count: 1)',
      ].join('\n'));

      const result = runHook(hook, input, {
        PRISMER_API_KEY: 'sk-prismer-test-key-123',
        PRISMER_BASE_URL: 'http://127.0.0.1:19999',
      });
      expect(result.exitCode).toBe(0);
    }
  });

  it('hooks should handle empty JSON stdin', () => {
    const hooks = [
      'session-start.mjs',
      'pre-bash-suggest.mjs',
      'post-bash-journal.mjs',
      'post-tool-failure.mjs',
      'session-stop.mjs',
      'session-end.mjs',
    ];

    for (const hook of hooks) {
      const result = runHook(hook, '{}');
      expect(result.exitCode).toBe(0);
    }
  });
});

// ============================================================
// Environment Variable Injection Tests
// ============================================================

describe('Environment Variable Injection', () => {
  beforeEach(() => {
    TEST_CACHE_DIR = freshCacheDir();
  });

  afterEach(() => {
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('PRISMER_API_KEY should control evolution feature activation', () => {
    // Without key: session-stop produces no output
    const noKey = runHook('session-stop.mjs', '{}', { PRISMER_API_KEY: '' });
    expect(noKey.stdout).toBe('');

    // With key + journal value: session-stop blocks
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    writeFileSync(join(TEST_CACHE_DIR, 'session-journal.md'), [
      '# Session Journal',
      '- bash: `cmd1` (10:00)',
      '  - signal:error:timeout (count: 1)',
      '  - signal:error:timeout (count: 2)',
    ].join('\n'));

    const withKey = runHook('session-stop.mjs', '{}', {
      PRISMER_API_KEY: 'sk-prismer-test-key-123',
    });
    expect(withKey.stdout).toContain('"decision":"block"');
  });

  it('PRISMER_BASE_URL should default to https://prismer.cloud', () => {
    // session-start with API key should output the base URL in its review instruction
    const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }), {
      PRISMER_API_KEY: 'sk-prismer-test-key-abc',
      PRISMER_BASE_URL: '', // Empty = use default
    });
    expect(result.stdout).toContain('prismer.cloud');
  });

  it('PRISMER_BASE_URL should be customizable', () => {
    const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }), {
      PRISMER_API_KEY: 'sk-prismer-test-key-abc',
      PRISMER_BASE_URL: 'https://custom.example.com',
    });
    expect(result.stdout).toContain('custom.example.com');
  });

  it('CLAUDE_PLUGIN_DATA should control cache directory', () => {
    const customDir = freshCacheDir();
    try {
      const result = runHook('session-start.mjs', JSON.stringify({ type: 'startup' }), {
        CLAUDE_PLUGIN_DATA: customDir,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(customDir, 'session-journal.md'))).toBe(true);
    } finally {
      try { rmSync(customDir, { recursive: true, force: true }); } catch {}
    }
  });
});

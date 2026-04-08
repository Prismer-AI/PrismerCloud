#!/usr/bin/env node
/**
 * CC E2E Session Verifier
 *
 * Checks file-system artifacts produced by a real Claude Code session
 * with the Prismer plugin loaded. Run after (or during) a session:
 *
 *   node tests/verify-cc-session.mjs [CACHE_DIR]
 *
 * CACHE_DIR defaults to .dev-cache (dev mode) or CLAUDE_PLUGIN_DATA.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const CACHE_DIR = process.argv[2]
  || process.env.CLAUDE_PLUGIN_DATA
  || resolve(import.meta.dirname || '.', '..', '.dev-cache');

const PRISMER_DIR = join(homedir(), '.prismer');
const DAEMON_PID = join(PRISMER_DIR, 'daemon.pid');
const DAEMON_PORT = join(PRISMER_DIR, 'daemon.port');
const OUTBOX_FILE = join(PRISMER_DIR, 'cache', 'outbox.json');

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) { passed++; console.log(`  \x1b[32m\u2713\x1b[0m ${name}`); }
function fail(name, reason) { failed++; console.log(`  \x1b[31m\u2717\x1b[0m ${name} \u2014 ${reason}`); }
function skip(name, reason) { skipped++; console.log(`  \x1b[33m\u25cb\x1b[0m ${name} \u2014 ${reason}`); }

// ─── Helpers ───

function loadLog() {
  const logFile = join(CACHE_DIR, 'prismer-debug.log');
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function logHasHook(entries, hookName) {
  return entries.some(e => e.hook === hookName);
}

function logHasMsg(entries, substr) {
  return entries.some(e => (e.msg || '').includes(substr) || (e.hook || '').includes(substr));
}

// ─── Phase 1: Cache dir & debug log ───

console.log(`\n\x1b[1m=== CC Session Verifier ===\x1b[0m`);
console.log(`Cache: ${CACHE_DIR}\n`);

console.log('\x1b[1m--- Phase 1: SessionStart ---\x1b[0m');

if (!existsSync(CACHE_DIR)) {
  fail('Cache directory exists', `${CACHE_DIR} not found`);
  console.log('\nNo cache directory. Was the plugin loaded?');
  process.exit(1);
}
ok('Cache directory exists');

const logFile = join(CACHE_DIR, 'prismer-debug.log');
if (!existsSync(logFile)) {
  fail('Debug log exists', 'prismer-debug.log not found');
} else {
  ok('Debug log exists');
}

const entries = loadLog();
if (entries.length === 0) {
  fail('Debug log has entries', 'log is empty');
} else {
  ok(`Debug log has ${entries.length} entries`);
}

if (logHasHook(entries, 'session-start')) {
  ok('SessionStart hook fired');
} else {
  fail('SessionStart hook fired', 'no session-start entry in log');
}

// Check for FATAL / uncaughtException
const fatals = entries.filter(e => e.lvl === 'error' && ((e.msg || '').includes('FATAL') || (e.msg || '').includes('uncaughtException')));
if (fatals.length === 0) {
  ok('No FATAL errors in log');
} else {
  fail('No FATAL errors in log', `${fatals.length} fatal entries found`);
}

// ─── Phase 2-3: Hook coverage ───

console.log('\n\x1b[1m--- Phase 2-3: Hook Coverage ---\x1b[0m');

const expectedHooks = [
  ['session-start', 'SessionStart'],
  ['pre-bash-suggest', 'PreToolUse:Bash'],
  ['post-bash-journal', 'PostToolUse:Bash'],
  ['post-tool-failure', 'PostToolUseFailure'],
  ['session-stop', 'Stop'],
  ['session-end', 'SessionEnd'],
];

for (const [hookName, label] of expectedHooks) {
  if (logHasHook(entries, hookName)) {
    ok(`${label} hook fired`);
  } else {
    // SubagentStart and pre-web-cache may not fire in every session
    if (hookName === 'pre-web-cache' || hookName === 'subagent-start') {
      skip(`${label} hook`, 'may not fire in every session');
    } else {
      fail(`${label} hook fired`, `no ${hookName} entry in log`);
    }
  }
}

// Optional hooks (may or may not fire)
for (const [hookName, label] of [['pre-web-cache', 'PreToolUse:WebFetch'], ['subagent-start', 'SubagentStart']]) {
  if (logHasHook(entries, hookName)) {
    ok(`${label} hook fired (optional)`);
  } else {
    skip(`${label} hook`, 'not triggered this session');
  }
}

// Journal file
console.log('\n\x1b[1m--- Journal ---\x1b[0m');
const journalFile = join(CACHE_DIR, 'session-journal.md');
if (existsSync(journalFile)) {
  const journal = readFileSync(journalFile, 'utf-8');
  ok(`Journal exists (${journal.split('\n').length} lines)`);
} else {
  skip('Journal file', 'no tool failures recorded this session');
}

// ─── Phase 4: Skills ───

console.log('\n\x1b[1m--- Phase 4: Skills ---\x1b[0m');

const skillsDir = resolve(CACHE_DIR, '..', 'skills');
if (existsSync(skillsDir)) {
  const skills = readdirSync(skillsDir);
  if (skills.length >= 12) {
    ok(`${skills.length} skills available (expect >= 12)`);
  } else {
    fail(`Skills count`, `only ${skills.length} found, expect >= 12`);
  }
} else {
  // Skills are in the plugin dir, not cache dir
  const pluginSkills = resolve(import.meta.dirname || '.', '..', 'skills');
  if (existsSync(pluginSkills)) {
    const skills = readdirSync(pluginSkills);
    ok(`${skills.length} skills in plugin dir`);
  } else {
    skip('Skills directory', 'could not locate skills dir');
  }
}

// ─── Phase 6: Stop / SessionEnd / Daemon ───

console.log('\n\x1b[1m--- Phase 6: Lifecycle ---\x1b[0m');

// Cooldown files
const cooldownFiles = existsSync(CACHE_DIR)
  ? readdirSync(CACHE_DIR).filter(f => f.startsWith('last-block-'))
  : [];
if (cooldownFiles.length > 0) {
  ok(`Cooldown files: ${cooldownFiles.join(', ')}`);
} else {
  skip('Cooldown files', 'Stop may not have triggered evolution review');
}

// Daemon mutual exclusivity
console.log('\n\x1b[1m--- Daemon ---\x1b[0m');

const daemonRunning = existsSync(DAEMON_PID) && existsSync(DAEMON_PORT);
if (daemonRunning) {
  ok('Daemon PID/port files present');
  // If daemon is running, outcomes should go to outbox
  if (existsSync(OUTBOX_FILE)) {
    try {
      const outbox = JSON.parse(readFileSync(OUTBOX_FILE, 'utf-8'));
      ok(`Outbox has ${outbox.length} entries (daemon handles upload)`);
    } catch {
      fail('Outbox readable', 'failed to parse outbox.json');
    }
  } else {
    skip('Outbox file', 'no outcomes queued yet');
  }
} else {
  skip('Daemon not running', 'outcomes sent via direct POST (fallback mode)');
}

// ─── Summary ───

console.log(`\n\x1b[1m=== Results ===\x1b[0m`);
console.log(`  \x1b[32m${passed} passed\x1b[0m`);
if (failed > 0) console.log(`  \x1b[31m${failed} failed\x1b[0m`);
if (skipped > 0) console.log(`  \x1b[33m${skipped} skipped\x1b[0m`);

process.exit(failed > 0 ? 1 : 0);

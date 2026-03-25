#!/usr/bin/env node
/**
 * Stop hook — Session End Context Collection + Async Subagent Launch (v2)
 *
 * When Claude Code session ends:
 * 1. Read session-journal.md
 * 2. Collect git diff stats
 * 3. Determine if session has evolution value
 * 4. Write session-context.json
 * 5. Spawn async session-evolve.mjs (detached, fire-and-forget)
 *
 * Must complete in < 200ms — all heavy work is delegated to the subagent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(__dirname, '..', '.cache');
const JOURNAL_FILE = join(CACHE_DIR, 'session-journal.md');
const CONTEXT_FILE = join(CACHE_DIR, 'session-context.json');

// --- Step 1: Read journal ---

let journal = '';
try {
  journal = readFileSync(JOURNAL_FILE, 'utf8');
} catch {
  process.exit(0);
}

// --- Step 2: Determine evolution value ---

function hasEvolutionValue(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('Started:'));
  if (lines.length < 2) return false;
  if (/signal:error:/m.test(text)) return true;
  const signalCounts = {};
  const re = /signal:(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    signalCounts[m[1]] = (signalCounts[m[1]] || 0) + 1;
  }
  for (const count of Object.values(signalCounts)) {
    if (count >= 2) return true;
  }
  if (/gene_feedback:/m.test(text)) return true;
  if ((text.match(/^- bash:/gm) || []).length >= 5) return true;
  return false;
}

if (!hasEvolutionValue(journal)) {
  process.exit(0);
}

// --- Step 3: Collect git diff stats ---

let gitDiffStat = '';
try {
  gitDiffStat = execFileSync('git', ['diff', '--stat', 'HEAD'], {
    encoding: 'utf8',
    timeout: 2000,
  }).trim();
} catch {}

// --- Step 4: Detect scope ---

function detectScope() {
  if (process.env.PRISMER_SCOPE) return process.env.PRISMER_SCOPE;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {}
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 1000 }).trim();
    if (remote) {
      let hash = 0;
      for (let i = 0; i < remote.length; i++) {
        hash = ((hash << 5) - hash + remote.charCodeAt(i)) | 0;
      }
      return `git_${(hash >>> 0).toString(36)}`;
    }
  } catch {}
  return 'global';
}

// --- Step 5: Determine outcome ---

function detectOutcome(text) {
  const feedbackLines = text.split('\n').filter(l => /gene_feedback:/.test(l));
  if (feedbackLines.length > 0) {
    const last = feedbackLines[feedbackLines.length - 1];
    if (/outcome=success/.test(last)) return 'success';
    if (/outcome=failed/.test(last)) return 'failed';
  }
  const lastSignalIdx = text.lastIndexOf('signal:error:');
  const lastBashIdx = text.lastIndexOf('- bash:');
  if (lastSignalIdx > lastBashIdx) return 'failed';
  return 'unknown';
}

// --- Step 6: Parse journal into structured context for session-evolve.mjs ---

// Extract signal counts
const signalCounts = {};
const sigRe = /signal:(\S+)/g;
let sigMatch;
while ((sigMatch = sigRe.exec(journal)) !== null) {
  const sig = sigMatch[1].replace(/[()]/g, '');
  signalCounts[sig] = (signalCounts[sig] || 0) + 1;
}

// Extract gene feedback
const geneFeedback = [];
const fbRe = /gene_feedback:\s*"([^"]+)"\s*outcome=(\w+)/g;
let fbMatch;
while ((fbMatch = fbRe.exec(journal)) !== null) {
  geneFeedback.push({ title: fbMatch[1], outcome: fbMatch[2] });
}

const context = {
  signals: signalCounts,
  geneFeedback,
  outcome: detectOutcome(journal),
  scope: detectScope(),
  journalExcerpt: journal.slice(-4000),
  gitDiffStat,
  timestamp: new Date().toISOString(),
};

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
} catch {
  process.exit(0);
}

// --- Step 7: Launch async subagent ---

try {
  const evolveScript = join(__dirname, 'session-evolve.mjs');
  const child = spawn('node', [evolveScript], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      PRISMER_SESSION_CONTEXT: CONTEXT_FILE,
      PRISMER_CACHE_DIR: CACHE_DIR,
    },
  });
  child.unref();
} catch {}

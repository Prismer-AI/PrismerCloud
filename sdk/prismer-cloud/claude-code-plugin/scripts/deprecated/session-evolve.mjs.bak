#!/usr/bin/env node
/**
 * Async Subagent — Session Evolution Processor (v2)
 *
 * Spawned as a detached process by session-stop.mjs. Runs fire-and-forget
 * with a 30-second timeout. Does NOT block the Claude Code session exit.
 *
 * Workflow:
 *   1. Read session-context.json
 *   2. Extract repeated signals → build gene proposals (rule-based, LLM version later)
 *   3. POST /api/im/evolution/genes (create gene, visibility='private')
 *   4. POST /api/im/evolution/record (feedback for any suggested genes)
 *   5. POST /api/im/evolution/sync (batch push + pull cursor update)
 *   6. Write local evolution-suggestions.md (for next SessionStart)
 *   7. Cleanup session-context.json + session-journal.md
 *
 * Env vars:
 *   PRISMER_SESSION_CONTEXT — path to session-context.json
 *   PRISMER_CACHE_DIR — cache directory
 *   PRISMER_API_KEY — API key
 *   PRISMER_BASE_URL — API base URL
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const CONTEXT_FILE = process.env.PRISMER_SESSION_CONTEXT;
const CACHE_DIR = process.env.PRISMER_CACHE_DIR;
const API_KEY = process.env.PRISMER_API_KEY;
const BASE_URL = (process.env.PRISMER_BASE_URL || 'https://prismer.cloud').replace(/\/$/, '');

const TIMEOUT_MS = 30_000;
const SUGGESTIONS_FILE = CACHE_DIR ? join(CACHE_DIR, 'evolution-suggestions.md') : null;
const JOURNAL_FILE = CACHE_DIR ? join(CACHE_DIR, 'session-journal.md') : null;
const CURSOR_FILE = CACHE_DIR ? join(CACHE_DIR, 'sync-cursor.json') : null;

// --- Global timeout ---

const killTimer = setTimeout(() => process.exit(0), TIMEOUT_MS);
killTimer.unref();

// --- Helpers ---

async function apiCall(endpoint, body) {
  if (!API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Main ---

async function main() {
  // Step 1: Read context
  if (!CONTEXT_FILE || !existsSync(CONTEXT_FILE)) return;

  let ctx;
  try {
    ctx = JSON.parse(readFileSync(CONTEXT_FILE, 'utf8'));
  } catch {
    return;
  }

  if (!API_KEY) return;

  const { signals, geneFeedback, outcome, scope, journalExcerpt, gitDiffStat } = ctx;

  // Step 2: Extract repeated signals for gene proposals
  const repeatedSignals = Object.entries(signals || {})
    .filter(([, count]) => count >= 2)
    .map(([type, count]) => ({ type, count }));

  const suggestions = [];

  // Step 3: Create gene proposals for repeated + resolved errors
  if (outcome === 'success' && repeatedSignals.length > 0) {
    const signalsMatch = repeatedSignals.map(s => ({ type: s.type }));

    // Rule-based title generation (LLM version in future iteration)
    const titleParts = repeatedSignals.slice(0, 2).map(s => {
      const suffix = s.type.split(':').pop() || 'unknown';
      return suffix
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    });
    const title = `${titleParts.join(' + ')} Resolution`;

    // Rule-based strategy extraction from journal
    const strategy = extractStrategyHints(journalExcerpt || '', repeatedSignals);

    if (strategy.length > 0) {
      const result = await apiCall('/api/im/evolution/genes', {
        category: 'repair',
        signals_match: signalsMatch,
        strategy,
        title,
        description: `Auto-extracted by claude-code-plugin v2. Session outcome: ${outcome}. Signals: ${repeatedSignals.map(s => `${s.type}(${s.count}x)`).join(', ')}.`,
      });

      if (result?.ok && result?.data?.id) {
        suggestions.push({
          geneId: result.data.id,
          title,
          signalsMatch,
          strategy,
        });
      }
    }
  }

  // Step 4: Record gene feedback
  if (geneFeedback && geneFeedback.length > 0) {
    for (const fb of geneFeedback) {
      if (!fb.title) continue;
      // Find gene by title via analyze (best-effort matching)
      const analyzeResult = await apiCall('/api/im/evolution/analyze', {
        signals: [{ type: fb.title.toLowerCase().includes('timeout') ? 'error:timeout' : 'error:generic' }],
      });
      if (analyzeResult?.data?.gene_id) {
        await apiCall('/api/im/evolution/record', {
          gene_id: analyzeResult.data.gene_id,
          outcome: fb.outcome,
          summary: `claude-code-plugin v2: gene "${fb.title}" ${fb.outcome} during session`,
          scope: scope || 'global',
        });
      }
    }
  }

  // Step 5: Sync push
  const outcomes = (geneFeedback || [])
    .filter(fb => fb.title && fb.outcome)
    .map(fb => ({
      gene_id: fb.title, // Best-effort — title as fallback
      signals: Object.keys(signals || {}),
      outcome: fb.outcome,
      summary: `Gene "${fb.title}" ${fb.outcome}`,
    }));

  let cursor = 0;
  try {
    const raw = readFileSync(CURSOR_FILE, 'utf8');
    cursor = JSON.parse(raw)?.cursor || 0;
  } catch {}

  const syncResult = await apiCall('/api/im/evolution/sync', {
    push: outcomes.length > 0 ? { outcomes } : undefined,
    pull: { since: cursor, scope: scope || 'global' },
  });

  // Update cursor
  if (syncResult?.data?.pulled?.cursor && CURSOR_FILE) {
    try {
      writeFileSync(CURSOR_FILE, JSON.stringify({
        cursor: syncResult.data.pulled.cursor,
        scope,
        ts: Date.now(),
      }));
    } catch {}
  }

  // Step 6: Write local evolution suggestions for next session
  if (SUGGESTIONS_FILE && suggestions.length > 0) {
    try {
      const lines = [
        '# Evolution Suggestions',
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        ...suggestions.map(s => [
          `## ${s.title}`,
          `Gene ID: ${s.geneId}`,
          `Signals: ${s.signalsMatch.map(sm => sm.type).join(', ')}`,
          `Strategy:`,
          ...s.strategy.map((st, i) => `  ${i + 1}. ${st}`),
          '',
        ]).flat(),
      ];
      writeFileSync(SUGGESTIONS_FILE, lines.join('\n'));
    } catch {}
  }

  // Step 7: Cleanup
  try { if (CONTEXT_FILE) unlinkSync(CONTEXT_FILE); } catch {}
  // Keep journal for next session-start rotation (renamed to prev-session-journal.md)
}

// --- Strategy Extraction (rule-based) ---

function extractStrategyHints(journal, repeatedSignals) {
  const strategies = [];
  const lines = journal.split('\n');

  // Find bash commands that followed error signals
  const signalTypes = new Set(repeatedSignals.map(s => s.type));
  let inErrorZone = false;
  let errorType = '';

  for (const line of lines) {
    // Detect error signal
    if (line.includes('signal:')) {
      for (const sig of signalTypes) {
        if (line.includes(`signal:${sig}`)) {
          inErrorZone = true;
          errorType = sig;
          break;
        }
      }
      continue;
    }

    // Detect successful bash command after error (likely the fix)
    if (inErrorZone && line.startsWith('- bash:') && !line.includes('signal:error')) {
      const cmdMatch = line.match(/`([^`]+)`/);
      if (cmdMatch) {
        const cmd = cmdMatch[1].trim();
        // Skip trivial commands
        if (!/^(ls|cat|echo|pwd|cd|git (status|log|diff))/.test(cmd)) {
          strategies.push(`Run: ${cmd.slice(0, 200)}`);
          inErrorZone = false;
        }
      }
    }

    // Gene feedback success = end of error zone
    if (line.includes('outcome=success')) {
      inErrorZone = false;
    }
  }

  // Add generic resolution hint based on signal type
  for (const sig of repeatedSignals) {
    const hint = SIGNAL_STRATEGY_HINTS[sig.type];
    if (hint && !strategies.some(s => s.includes(hint))) {
      strategies.push(hint);
    }
  }

  return strategies.slice(0, 5); // Max 5 strategy steps
}

const SIGNAL_STRATEGY_HINTS = {
  'error:timeout': 'Add retry with exponential backoff and jitter',
  'error:oom': 'Check memory allocation, increase Node.js heap size or add streaming',
  'error:permission_error': 'Check file/API permissions and authentication tokens',
  'error:not_found': 'Verify dependency installation and path resolution',
  'error:connection_refused': 'Check if the target service is running and ports are correct',
  'error:port_in_use': 'Kill the process using the port or switch to an available port',
  'error:module_not_found': 'Run npm install or check package.json dependencies',
  'error:build_failure': 'Check TypeScript errors, run type generation if needed',
  'error:deploy_failure': 'Verify deployment config, credentials, and target environment',
  'error:test_failure': 'Check test assertions, mocks, and environment setup',
  'error:prisma': 'Run npx prisma generate, then npx prisma db push if schema changed',
  'error:typescript': 'Fix type errors, check tsconfig paths and strict mode settings',
};

main().catch(() => {}).finally(() => {
  clearTimeout(killTimer);
  process.exit(0);
});

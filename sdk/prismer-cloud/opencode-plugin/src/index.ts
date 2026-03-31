/**
 * @prismer/opencode-plugin (v2)
 *
 * Evolution-aware plugin for OpenCode. Implements the 3-stage model:
 *   - SessionStart: sync pull + passive context injection
 *   - Mid-session: local journal + stuck detection (query only when same error >= 2x)
 *   - Session end: gene creation + outcome recording + local persistence
 *
 * Install: add "@prismer/opencode-plugin" to the "plugin" array in opencode.json
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

import { EvolutionClient } from './evolution-client.js';
import { detectSignals, hasError as hasErrorIndicator, hasErrorContext } from './signals.js';
import { resolveConfig } from './resolve-config.js';

interface PluginInput {
  client: any;
  project: any;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: any;
}

type Plugin = (input: PluginInput) => Promise<Hooks>;

interface Hooks {
  event?: (input: { event: any }) => Promise<void>;
  tool?: Record<string, any>;
  'shell.env'?: (input: { cwd: string; sessionID?: string; callID?: string }, output: { env: Record<string, string> }) => Promise<void>;
  'tool.execute.before'?: (input: { tool: string; sessionID: string; callID: string }, output: { args: any }) => Promise<void>;
  'tool.execute.after'?: (input: { tool: string; sessionID: string; callID: string; args: any }, output: { title: string; output: string; metadata: any }) => Promise<void>;
  'experimental.chat.system.transform'?: (input: { sessionID?: string; model: any }, output: { system: string[] }) => Promise<void>;
}

// ─── Session Journal (in-memory) ────────────────────────────

interface JournalEntry {
  tool: string;
  args: string;
  signals: string[];
  hasError: boolean;
  timestamp: number;
}

interface SessionJournal {
  entries: JournalEntry[];
  signalCounts: Map<string, number>;
  genesSuggested: Array<{ geneId: string; geneTitle: string; signals: string[]; suggestedAt: number }>;
  geneFeedback: Array<{ geneId: string; geneTitle: string; outcome: string }>;
  startedAt: number;
}

function createJournal(): SessionJournal {
  return {
    entries: [],
    signalCounts: new Map(),
    genesSuggested: [],
    geneFeedback: [],
    startedAt: Date.now(),
  };
}

// ─── Scope Auto-Detection ──────────────────────────────────

/**
 * Detect evolution scope with CC's priority chain:
 *   1. PRISMER_SCOPE env var
 *   2. package.json "name" field (from project directory)
 *   3. Git remote origin URL hash (short)
 *   4. OpenCode project name
 *   5. 'global'
 */
function detectScope(ctx: PluginInput): string {
  // 1. Explicit env var
  if (process.env.PRISMER_SCOPE) return process.env.PRISMER_SCOPE;

  // 2. package.json name
  const dir = ctx.directory || ctx.worktree;
  if (dir) {
    try {
      const pkgPath = join(dir, 'package.json');
      const raw = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      if (pkg.name && typeof pkg.name === 'string') return pkg.name;
    } catch {
      // No package.json or invalid JSON
    }
  }

  // 3. Git remote origin hash (no user input — hardcoded command)
  if (dir) {
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (remote) {
        return createHash('sha256').update(remote).digest('hex').slice(0, 12);
      }
    } catch {
      // Not a git repo or no remote
    }
  }

  // 4. OpenCode project name
  if (ctx.project?.name) return ctx.project.name;

  // 5. Fallback
  return 'global';
}

// ─── Data Directory ────────────────────────────────────────

function getDataDir(): string {
  const dir = join(homedir(), '.prismer', 'opencode-plugin');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Retry Queue ───────────────────────────────────────────

interface RetryItem {
  outcomes: Array<{ gene_id: string; outcome: string; summary: string; signals: Array<{ type: string }> }>;
  ts: number;
}

function readRetryQueue(dataDir: string): RetryItem[] {
  try {
    const raw = readFileSync(join(dataDir, 'sync-retry-queue.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRetryQueue(dataDir: string, queue: RetryItem[]): void {
  try {
    writeFileSync(join(dataDir, 'sync-retry-queue.json'), JSON.stringify(queue));
  } catch {
    // Best-effort
  }
}

// ─── File-Based Journal ────────────────────────────────────

function getJournalPath(dataDir: string): string {
  return join(dataDir, 'session-journal.md');
}

function ensureJournalFile(journalPath: string): void {
  if (!existsSync(journalPath)) {
    writeFileSync(journalPath, `# Session Journal\nStarted: ${new Date().toISOString()}\n\n`);
  }
}

function appendToJournalFile(journalPath: string, line: string): void {
  try {
    ensureJournalFile(journalPath);
    appendFileSync(journalPath, line + '\n');
  } catch {
    // Best-effort
  }
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// ─── Main Plugin ────────────────────────────────────────────

export const PrismerEvolution: Plugin = async (ctx) => {
  const { apiKey, baseUrl } = resolveConfig();

  if (!apiKey) {
    console.warn('[prismer] No API key found — evolution hooks disabled.');
    console.warn('  To enable: run `npx prismer setup` (opens browser, auto-receives key)');
    console.warn('  Or set PRISMER_API_KEY env var / add api_key to ~/.prismer/config.toml.\n');
    return {};
  }

  const client = new EvolutionClient({ apiKey, baseUrl, provider: 'opencode' });

  // Detect scope with full priority chain
  const scope = detectScope(ctx);

  // Data directory for file-based state
  const dataDir = getDataDir();
  const journalPath = getJournalPath(dataDir);

  // Reset journal file for new session
  try {
    writeFileSync(journalPath, `# Session Journal\nStarted: ${new Date().toISOString()}\nScope: ${scope}\n\n`);
  } catch {
    // Best-effort
  }

  // Session state (in-memory for fast access, write-through to file)
  const journal = createJournal();
  const STUCK_THRESHOLD = 2;
  const ADVICE_TTL_MS = 3 * 60 * 1000;
  let lastAdvice: { geneId: string; geneTitle: string; signals: string[]; suggestedAt: number } | null = null;

  // ─── SessionStart: retry queued items ─────────────────────

  try {
    const queue = readRetryQueue(dataDir);
    if (queue.length > 0) {
      for (const item of queue) {
        await client.sync(
          item.outcomes.map(o => ({
            gene_id: o.gene_id,
            outcome: o.outcome as 'success' | 'failed',
            summary: o.summary,
            signals: o.signals.map(s => s.type),
          })),
          0,
          scope,
        );
      }
      writeRetryQueue(dataDir, []); // Clear on success
    }
  } catch {
    // Retry failed again — keep queue for next session
  }

  // ─── SessionStart: sync pull for passive context ──────────

  let sessionContext = '';
  try {
    const syncResult = await client.sync(undefined, 0, scope);
    if (syncResult?.pulled?.genes) {
      const genes = syncResult.pulled.genes as Array<Record<string, any>>;
      const topGenes = genes
        .filter(g => ((g.successCount || 0) + (g.failureCount || 0)) >= 3)
        .sort((a, b) => {
          const aRate = (a.successCount || 0) / Math.max((a.successCount || 0) + (a.failureCount || 0), 1);
          const bRate = (b.successCount || 0) / Math.max((b.successCount || 0) + (b.failureCount || 0), 1);
          return bRate - aRate;
        })
        .slice(0, 5);

      if (topGenes.length > 0) {
        sessionContext = topGenes
          .map(g => {
            const total = (g.successCount || 0) + (g.failureCount || 0);
            const rate = Math.round(((g.successCount || 0) / Math.max(total, 1)) * 100);
            return `"${g.title}" (${rate}%, ${total} runs)`;
          })
          .join('; ');
      }
    }
  } catch {
    // Best-effort
  }

  return {
    // ─── Inject Prismer env vars into shell sessions ────────
    'shell.env': async (_input, output) => {
      output.env.PRISMER_API_KEY = apiKey;
      output.env.PRISMER_BASE_URL = baseUrl;
    },

    // ─── System transform: inject evolution context + session review ──
    'experimental.chat.system.transform': async (_input, output) => {
      if (sessionContext) {
        output.system.push(
          `[Prismer Evolution] Proven strategies for this project: ${sessionContext}. Use when encountering related issues.`,
        );
      }

      // Session review prompt: inject when session has evolution value
      // This replaces CC's Stop hook — OpenCode doesn't have Stop, so we
      // inject the review prompt via system transform when conditions are met.
      if (journal.entries.length >= 5 || journal.geneFeedback.length > 0 ||
          Array.from(journal.signalCounts.values()).some(c => c >= 2)) {
        const reviewParts: string[] = [];

        // Gene feedback context
        if (journal.geneFeedback.length > 0) {
          reviewParts.push('Gene suggestions were made this session. For each, self-evaluate:');
          reviewParts.push('Did you actually follow this strategy, or did you solve it independently?');
          for (const fb of journal.geneFeedback) {
            reviewParts.push(`  - "${fb.geneTitle}" (${fb.geneId}) auto-detected: ${fb.outcome}`);
          }
        }

        // Repeated signal summary
        const repeated = Array.from(journal.signalCounts.entries())
          .filter(([, c]) => c >= 2)
          .map(([s, c]) => `${s}(${c}x)`);
        if (repeated.length > 0) {
          reviewParts.push(`Repeated signals: ${repeated.join(', ')}`);
        }

        if (reviewParts.length > 0) {
          reviewParts.push('');
          reviewParts.push(
            'If this session ends, consider: evolve_record (gene feedback) / evolve_create_gene (new pattern) / memory_write (project-specific learning). Max 3 evolution calls.',
          );
          output.system.push(`[Prismer Session Review]\n${reviewParts.join('\n')}`);
        }
      }
    },

    // ─── Before tool: stuck detection + conditional query ───
    'tool.execute.before': async (input, output) => {
      try {
        // Expire stale advice
        if (lastAdvice && Date.now() - lastAdvice.suggestedAt > ADVICE_TTL_MS) {
          lastAdvice = null;
        }

        const argsStr = typeof output.args === 'string'
          ? output.args
          : JSON.stringify(output.args || '');

        if (!hasErrorContext(argsStr)) return;

        const signals = detectSignals(argsStr);
        if (signals.length === 0 || (signals.length === 1 && signals[0] === 'error:generic')) return;

        // v2 stuck detection: only query if same signal seen >= STUCK_THRESHOLD in journal
        let maxCount = 0;
        for (const sig of signals) {
          const count = journal.signalCounts.get(sig) || 0;
          if (count > maxCount) maxCount = count;
        }

        if (maxCount < STUCK_THRESHOLD) return; // Not stuck yet

        // Agent is stuck → query evolution
        const result = await client.analyze(signals, input.tool || 'tool', scope);

        if (result?.geneId && result.confidence >= 0.4) {
          lastAdvice = {
            geneId: result.geneId,
            geneTitle: result.geneTitle || '',
            signals,
            suggestedAt: Date.now(),
          };
          journal.genesSuggested.push({ ...lastAdvice });

          if (typeof output.args === 'object' && output.args !== null) {
            output.args._prismerHint = `[Evolution] Known fix for repeated error (${maxCount}x, ${Math.round(result.confidence * 100)}%): "${result.geneTitle}"`;
          }
        }
      } catch {
        // Best-effort
      }
    },

    // ─── After tool: local journal + gene feedback + web caching ──
    'tool.execute.after': async (input, output) => {
      try {
        // Expire stale advice
        if (lastAdvice && Date.now() - lastAdvice.suggestedAt > ADVICE_TTL_MS) {
          lastAdvice = null;
        }

        const outputText = output.output || '';
        const errorDetected = hasErrorIndicator(outputText);
        const signals = errorDetected ? detectSignals(outputText) : [];

        // Record in journal (preserve args text for session-end strategy extraction)
        const argsText = typeof input.args === 'string' ? input.args : JSON.stringify(input.args || '');
        const entry: JournalEntry = {
          tool: input.tool || 'unknown',
          args: argsText.slice(0, 200),
          signals,
          hasError: errorDetected,
          timestamp: Date.now(),
        };
        journal.entries.push(entry);

        // Write-through to file journal
        appendToJournalFile(journalPath, `- ${entry.tool}: \`${entry.args.slice(0, 120)}\` (${nowTime()})`);
        if (errorDetected) {
          for (const sig of signals) {
            const count = (journal.signalCounts.get(sig) || 0) + 1;
            appendToJournalFile(journalPath, `  - signal:${sig} (count: ${count}, at: ${nowTime()})`);
          }
        }

        // Update signal counts (for stuck detection)
        for (const sig of signals) {
          journal.signalCounts.set(sig, (journal.signalCounts.get(sig) || 0) + 1);
        }

        if (errorDetected) {
          // Gene failure feedback (local journal only, no remote write)
          if (lastAdvice?.geneId) {
            journal.geneFeedback.push({
              geneId: lastAdvice.geneId,
              geneTitle: lastAdvice.geneTitle,
              outcome: 'failed',
            });
            appendToJournalFile(journalPath,
              `  - gene_feedback: "${lastAdvice.geneTitle}" gene_id=${lastAdvice.geneId} outcome=failed`);
            lastAdvice = null;
          }

          // v2: check if stuck, append hint to output
          let maxCount = 0;
          for (const sig of signals) {
            const count = journal.signalCounts.get(sig) || 0;
            if (count > maxCount) maxCount = count;
          }

          if (maxCount >= STUCK_THRESHOLD) {
            try {
              const result = await client.analyze(signals, input.tool || 'tool', scope);
              if (result?.geneId && result.confidence >= 0.4) {
                output.output += `\n\n---\n[Prismer Evolution] Repeated error (${maxCount}x, ${Math.round(result.confidence * 100)}%): "${result.geneTitle}"\n` +
                  (result.strategies || []).map((s, i) => `${i + 1}. ${s}`).join('\n');

                lastAdvice = {
                  geneId: result.geneId,
                  geneTitle: result.geneTitle || '',
                  signals,
                  suggestedAt: Date.now(),
                };
                journal.genesSuggested.push({ ...lastAdvice });
              }
            } catch {
              // Best-effort
            }
          }
        } else if (lastAdvice?.geneId) {
          // Success: gene suggested and tool succeeded → positive feedback
          journal.geneFeedback.push({
            geneId: lastAdvice.geneId,
            geneTitle: lastAdvice.geneTitle,
            outcome: 'success',
          });
          appendToJournalFile(journalPath,
            `  - gene_feedback: "${lastAdvice.geneTitle}" gene_id=${lastAdvice.geneId} outcome=success`);
          lastAdvice = null;
        }

        // ─── Web content caching (fire-and-forget) ───────────
        // If tool was a web fetch/search and returned content, cache it
        const toolName = input.tool || '';
        const isWebTool = /fetch|web|search|browse|http|curl/i.test(toolName);
        if (isWebTool && outputText.length >= 100) {
          // Extract URL from args
          const urlMatch = argsText.match(/https?:\/\/[^\s"']+/);
          if (urlMatch) {
            // Fire-and-forget POST to context save
            fetch(`${baseUrl}/api/context/save`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                url: urlMatch[0],
                content: outputText.slice(0, 50_000), // Cap at 50KB
                source: 'opencode-plugin',
              }),
            }).catch(() => { /* best-effort */ });
          }
        }
      } catch {
        // Never break tool execution
      }
    },

    // ─── Event: session lifecycle ───────────────────────────
    event: async ({ event }) => {
      try {
        const type = (event as any)?.type || '';

        if (type === 'session.created') {
          console.log('[prismer] Evolution network connected (v2 — 3-stage model)');
        }

        // Session end detection (OpenCode doesn't have explicit Stop event)
        if (type === 'session.ended' || type === 'session.destroyed') {
          await sessionEndHandler();
        }
      } catch {
        // Best-effort
      }
    },
  };

  // ─── Session End Handler ──────────────────────────────────

  async function sessionEndHandler() {
    try {
      // Determine if session has evolution value
      if (journal.entries.length < 2) return;
      const hasErrors = journal.entries.some(e => e.hasError);
      const hasRepeats = Array.from(journal.signalCounts.values()).some(c => c >= 2);
      if (!hasErrors && !hasRepeats && journal.entries.length < 5) return;

      // Determine outcome
      const lastEntries = journal.entries.slice(-3);
      const outcome = lastEntries.some(e => e.hasError) ? 'failed' : 'success';

      // Record gene feedback outcomes to server
      for (const fb of journal.geneFeedback) {
        if (fb.geneId) {
          await client.record(fb.geneId, fb.outcome as 'success' | 'failed',
            `OpenCode session: gene "${fb.geneTitle}" ${fb.outcome}`, scope);
        }
      }

      // Create gene from successful resolution of repeated errors
      const repeatedSignals = Array.from(journal.signalCounts.entries())
        .filter(([, count]) => count >= 2)
        .map(([type]) => type);

      if (outcome === 'success' && repeatedSignals.length > 0) {
        // Build strategy from successful commands that followed errors
        const strategies: string[] = [];
        let afterError = false;
        for (const entry of journal.entries) {
          if (entry.hasError) { afterError = true; continue; }
          if (afterError && !entry.hasError && entry.args && strategies.length < 5) {
            strategies.push(entry.args);
            afterError = false;
          }
        }

        const titleParts = repeatedSignals.slice(0, 2).map(s => {
          const parts = s.split(':');
          return parts[parts.length - 1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        });

        // Submit report for server-side processing
        await client.report({
          rawContext: `Session resolved repeated errors: ${repeatedSignals.join(', ')}. Strategies: ${strategies.join('; ')}. Total tool calls: ${journal.entries.length}. Duration: ${Math.round((Date.now() - journal.startedAt) / 1000)}s.`,
          outcome,
          task: `Resolve ${titleParts.join(' + ')}`,
          stage: 'session_end',
          severity: 'medium',
          scope,
        });
      }

      // Sync push (with retry queue fallback)
      const outcomes = journal.geneFeedback
        .filter(fb => fb.geneId)
        .map(fb => ({
          gene_id: fb.geneId,
          signals: Array.from(journal.signalCounts.keys()),
          outcome: fb.outcome as 'success' | 'failed',
          summary: `Gene "${fb.geneTitle}" ${fb.outcome}`,
        }));

      if (outcomes.length > 0) {
        try {
          await client.sync(outcomes, 0, scope);
        } catch {
          // Sync failed — save to retry queue for next session
          const queue = readRetryQueue(dataDir);
          queue.push({
            outcomes: outcomes.map(o => ({
              gene_id: o.gene_id,
              outcome: o.outcome,
              summary: o.summary,
              signals: o.signals.map(s => ({ type: s })),
            })),
            ts: Date.now(),
          });
          // Keep max 10 entries
          writeRetryQueue(dataDir, queue.slice(-10));
        }
      }

      // ─── Local Persistence: Memory Write ───────────────
      // Persist session learnings to evolution memory
      const signalSummary = Array.from(journal.signalCounts.entries())
        .map(([type, count]) => `- ${type}: ${count}x`)
        .join('\n');
      const feedbackSummary = journal.geneFeedback
        .map(fb => `- Gene "${fb.geneTitle}": ${fb.outcome}`)
        .join('\n');
      const sessionDuration = Math.round((Date.now() - journal.startedAt) / 1000);

      if (signalSummary || feedbackSummary) {
        const memoryContent = [
          `# Session Summary (${new Date().toISOString()})`,
          `Duration: ${sessionDuration}s | Commands: ${journal.entries.length} | Outcome: ${outcome}`,
          '',
          signalSummary ? `## Signals\n${signalSummary}` : '',
          feedbackSummary ? `## Gene Feedback\n${feedbackSummary}` : '',
          repeatedSignals.length > 0 ? `## Patterns\nRepeated signals resolved: ${repeatedSignals.join(', ')}` : '',
        ].filter(Boolean).join('\n');

        await client.memoryWrite(
          `evolution/sessions/${new Date().toISOString().split('T')[0]}.md`,
          memoryContent,
          scope,
        );
      }
    } catch {
      // Best-effort session end processing
    }
  }
};

export default PrismerEvolution;

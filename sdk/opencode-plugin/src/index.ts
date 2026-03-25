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

import { EvolutionClient } from './evolution-client.js';

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

// ─── Signal Extraction ──────────────────────────────────────

const ERROR_RE = /error|fail|timeout|crash|exception|denied|refused|oom|panic/i;

const SIGNAL_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /timeout/i, type: 'error:timeout' },
  { pattern: /oom|memory/i, type: 'error:oom' },
  { pattern: /permission|denied|403/i, type: 'error:permission_error' },
  { pattern: /not[\s-]*found|404|missing/i, type: 'error:not_found' },
  { pattern: /connect|refused|econnrefused/i, type: 'error:connection_refused' },
  { pattern: /module.*not.*found|cannot find module/i, type: 'error:module_not_found' },
  { pattern: /build|compile|tsc/i, type: 'error:build_failure' },
  { pattern: /deploy|k8s/i, type: 'error:deploy_failure' },
  { pattern: /test|jest|pytest/i, type: 'error:test_failure' },
  { pattern: /prisma|migration/i, type: 'error:prisma' },
  { pattern: /typescript|TS\d{4}/i, type: 'error:typescript' },
];

function extractSignals(text: string): string[] {
  const signals: string[] = [];
  for (const { pattern, type } of SIGNAL_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(type);
    }
  }
  if (signals.length === 0 && ERROR_RE.test(text)) {
    signals.push('error:generic');
  }
  return signals;
}

// ─── Session Journal (in-memory) ────────────────────────────

interface JournalEntry {
  tool: string;
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

// ─── Main Plugin ────────────────────────────────────────────

export const PrismerEvolution: Plugin = async (ctx) => {
  const apiKey = process.env.PRISMER_API_KEY || '';
  const baseUrl = process.env.PRISMER_BASE_URL || 'https://prismer.cloud';

  if (!apiKey) {
    console.warn('[prismer] PRISMER_API_KEY not set — evolution hooks disabled');
    return {};
  }

  const client = new EvolutionClient({ apiKey, baseUrl, provider: 'opencode' });

  // Detect scope from project context
  const scope = process.env.PRISMER_SCOPE || ctx.project?.name || 'global';

  // Session state
  const journal = createJournal();
  const STUCK_THRESHOLD = 2;
  const ADVICE_TTL_MS = 3 * 60 * 1000;
  let lastAdvice: { geneId: string; geneTitle: string; signals: string[]; suggestedAt: number } | null = null;

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

    // ─── System transform: inject evolution context ─────────
    'experimental.chat.system.transform': async (_input, output) => {
      if (sessionContext) {
        output.system.push(
          `[Prismer Evolution] Proven strategies for this project: ${sessionContext}. Use when encountering related issues.`,
        );
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

        if (!ERROR_RE.test(argsStr)) return;

        const signals = extractSignals(argsStr);
        if (signals.length === 0) return;

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

    // ─── After tool: local journal + gene feedback ──────────
    'tool.execute.after': async (input, output) => {
      try {
        // Expire stale advice
        if (lastAdvice && Date.now() - lastAdvice.suggestedAt > ADVICE_TTL_MS) {
          lastAdvice = null;
        }

        const outputText = output.output || '';
        const hasError = ERROR_RE.test(outputText);
        const signals = hasError ? extractSignals(outputText) : [];

        // Record in journal
        const entry: JournalEntry = {
          tool: input.tool || 'unknown',
          signals,
          hasError,
          timestamp: Date.now(),
        };
        journal.entries.push(entry);

        // Update signal counts (for stuck detection)
        for (const sig of signals) {
          journal.signalCounts.set(sig, (journal.signalCounts.get(sig) || 0) + 1);
        }

        if (hasError) {
          // Gene failure feedback (local journal only, no remote write)
          if (lastAdvice?.geneId) {
            journal.geneFeedback.push({
              geneId: lastAdvice.geneId,
              geneTitle: lastAdvice.geneTitle,
              outcome: 'failed',
            });
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
          lastAdvice = null;
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
        // Build strategy from successful bash commands after errors
        const strategies: string[] = [];
        let afterError = false;
        for (const entry of journal.entries) {
          if (entry.hasError) { afterError = true; continue; }
          if (afterError && !entry.hasError && entry.tool === 'bash') {
            afterError = false;
            // Would need actual command text — not available in journal entries
            // For now, just note that resolution was found
          }
        }

        const signalsMatch = repeatedSignals.map(type => ({ type }));
        const titleParts = repeatedSignals.slice(0, 2).map(s => {
          const parts = s.split(':');
          return parts[parts.length - 1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        });

        // Submit report for server-side processing
        await client.report({
          rawContext: `Session resolved repeated errors: ${repeatedSignals.join(', ')}. Total tool calls: ${journal.entries.length}. Duration: ${Math.round((Date.now() - journal.startedAt) / 1000)}s.`,
          outcome,
          task: `Resolve ${titleParts.join(' + ')}`,
          stage: 'session_end',
          severity: 'medium',
          scope,
        });
      }

      // Sync push
      const outcomes = journal.geneFeedback
        .filter(fb => fb.geneId)
        .map(fb => ({
          gene_id: fb.geneId,
          signals: Array.from(journal.signalCounts.keys()),
          outcome: fb.outcome as 'success' | 'failed',
          summary: `Gene "${fb.geneTitle}" ${fb.outcome}`,
        }));

      if (outcomes.length > 0) {
        await client.sync(outcomes, 0, scope);
      }
    } catch {
      // Best-effort session end processing
    }
  }
};

export default PrismerEvolution;

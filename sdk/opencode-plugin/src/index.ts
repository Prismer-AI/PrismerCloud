/**
 * @prismer/opencode-plugin
 *
 * Evolution-aware plugin for OpenCode. Hooks into session and tool events
 * to automatically participate in the Prismer Evolution network.
 *
 * Install: add "@prismer/opencode-plugin" to the "plugin" array in opencode.json
 *
 * Official docs: https://opencode.ai/docs/plugins/
 *
 * @example opencode.json
 * ```json
 * {
 *   "plugin": ["@prismer/opencode-plugin"]
 * }
 * ```
 */

import { EvolutionClient } from './evolution-client.js';

/**
 * OpenCode Plugin context — matches @opencode-ai/plugin Plugin type.
 * Using inline interface to avoid hard peer dependency on @opencode-ai/plugin.
 */
interface PluginContext {
  project: any;
  client: any;
  $: any;
  directory: string;
  worktree: string;
}

type Plugin = (ctx: PluginContext) => Promise<Record<string, any>>;

export const PrismerEvolution: Plugin = async (ctx) => {
  const apiKey = process.env.PRISMER_API_KEY || '';
  const baseUrl = process.env.PRISMER_BASE_URL || 'https://prismer.cloud';

  if (!apiKey) {
    ctx.client?.app?.log?.('warn', '[prismer] PRISMER_API_KEY not set — evolution hooks disabled');
    return {};
  }

  const client = new EvolutionClient({ apiKey, baseUrl, provider: 'opencode' });

  // Track last analysis result for correlation
  let lastAdvice: any = null;

  return {
    // Inject Prismer env vars into shell sessions
    'shell.env': () => ({
      PRISMER_API_KEY: apiKey,
      PRISMER_BASE_URL: baseUrl,
    }),

    // Before tool execution: query evolution for known fixes
    'tool.execute.before': async (event: any) => {
      try {
        const toolName = event?.tool?.name || '';
        const input = event?.input?.command || event?.input?.description || '';

        // Extract signals from tool context
        const signals: string[] = [];
        if (/error|fail|fix|debug|retry/i.test(input)) {
          if (/timeout/i.test(input)) signals.push('error:timeout');
          else if (/oom|memory/i.test(input)) signals.push('error:oom');
          else if (/permission|denied/i.test(input)) signals.push('error:permission_error');
          else if (/build|compile/i.test(input)) signals.push('task:build');
          else if (/deploy|k8s/i.test(input)) signals.push('task:deploy');
          else if (/test/i.test(input)) signals.push('task:test');
          else signals.push('error:generic');
        }

        if (signals.length === 0) return;

        const result = await client.analyze(signals.join(','), toolName || 'tool');
        if (result?.geneId && result.confidence > 0.4) {
          lastAdvice = result;
          const strategy = result.strategies || [];
          ctx.client?.app?.log?.('info',
            `[prismer] Evolution suggests "${result.geneTitle}" (${Math.round(result.confidence * 100)}%): ${strategy[0] || ''}`
          );
          // Return suggestion text for OpenCode to inject
          return {
            suggestion: `[Prismer Evolution] Known fix (${Math.round(result.confidence * 100)}% confidence):\n` +
              strategy.map((s: string, i: number) => `  ${i + 1}. ${s}`).join('\n'),
          };
        }
      } catch {
        // Best-effort — never block tool execution
      }
    },

    // Report errors to evolution network
    'session.error': async (event: any) => {
      try {
        await client.report({
          rawContext: String(event?.error || event?.message || '').slice(-2000),
          outcome: 'failed',
          task: String(event?.description || 'session error'),
          stage: 'session',
          severity: 'high',
        });
      } catch {
        // Best-effort
      }
    },

    // After tool execution, check for errors and report
    'tool.execute.after': async (event: any) => {
      try {
        const result = event?.result;
        const toolName = event?.tool?.name || '';

        // Only report if tool execution had an error
        if (!result?.error && !result?.stderr) return;

        await client.report({
          rawContext: String(result?.error || result?.stderr || '').slice(-2000),
          outcome: 'failed',
          task: `${toolName}: ${String(event?.input?.command || event?.input?.description || '').slice(0, 500)}`,
          stage: toolName || 'tool',
          severity: 'medium',
        });
      } catch {
        // Best-effort
      }
    },

    // Log connection on session creation
    'session.created': async () => {
      ctx.client?.app?.log?.('info', '[prismer] Evolution network connected');
    },
  };
};

// Default export for OpenCode npm plugin loading
export default PrismerEvolution;

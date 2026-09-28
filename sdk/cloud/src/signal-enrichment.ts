/**
 * Signal Enrichment Layer — SDK-side signal extraction.
 * Migrated from server's signal-extractor.ts regex patterns.
 * Supports pure-rules mode (zero deps) and optional LLM injection.
 */
import type { SignalTag, ExecutionContext, SignalEnrichmentConfig } from './types';

/** Error normalization patterns — ported from server signal-extractor.ts */
const ERROR_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /timeout|timed?\s*out|deadline\s*exceeded|context\s*deadline/i, type: 'timeout' },
  { pattern: /econnrefused|connection\s*refused/i, type: 'connection_refused' },
  { pattern: /enotfound|dns|getaddrinfo|resolve/i, type: 'dns_error' },
  { pattern: /rate\s*limit|too\s*many\s*requests|429/i, type: 'rate_limit' },
  { pattern: /401|unauthorized|unauthenticated|auth.*fail/i, type: 'auth_error' },
  { pattern: /403|forbidden|access\s*denied|permission/i, type: 'permission_error' },
  { pattern: /404|not\s*found/i, type: 'not_found' },
  { pattern: /5\d{2}|internal\s*server|server\s*error|502|503|504/i, type: 'server_error' },
  { pattern: /type\s*error|typeerror/i, type: 'type_error' },
  { pattern: /syntax\s*error|syntaxerror|unexpected\s*token/i, type: 'syntax_error' },
  { pattern: /reference\s*error|referenceerror|is\s*not\s*defined/i, type: 'reference_error' },
  { pattern: /out\s*of\s*memory|oom|heap|allocation\s*failed/i, type: 'oom' },
  { pattern: /crash|panic|segfault|sigsegv|sigabrt/i, type: 'crash' },
  { pattern: /quota|limit\s*exceeded|insufficient/i, type: 'quota_exceeded' },
  { pattern: /tls|ssl|certificate|cert\s*verify/i, type: 'tls_error' },
  { pattern: /deadlock|lock\s*timeout|lock\s*wait/i, type: 'deadlock' },
];

/**
 * Extract signals from execution context using regex rules.
 * Zero dependencies, synchronous, <0.1ms.
 */
export function extractSignals(ctx: ExecutionContext): SignalTag[] {
  const tags: SignalTag[] = [];

  // Error pattern matching
  if (ctx.error) {
    let matched = false;
    for (const { pattern, type } of ERROR_PATTERNS) {
      if (pattern.test(ctx.error)) {
        const tag: SignalTag = { type: `error:${type}` };
        if (ctx.provider) tag.provider = ctx.provider;
        if (ctx.stage) tag.stage = ctx.stage;
        if (ctx.severity) tag.severity = ctx.severity;
        tags.push(tag);
        matched = true;
        break; // First match wins
      }
    }
    // Fallback: truncated error as signal
    if (!matched) {
      const normalized = ctx.error.slice(0, 50).toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const tag: SignalTag = { type: `error:${normalized}` };
      if (ctx.provider) tag.provider = ctx.provider;
      if (ctx.stage) tag.stage = ctx.stage;
      tags.push(tag);
    }
  }

  // Task status signals
  if (ctx.taskStatus === 'failed') tags.push({ type: 'task.failed' });
  if (ctx.taskStatus === 'completed') tags.push({ type: 'task.completed' });

  // Capability signal
  if (ctx.taskCapability) {
    tags.push({ type: `capability:${ctx.taskCapability}` });
  }

  // Custom tags
  if (ctx.tags) {
    for (const tag of ctx.tags) {
      tags.push({ type: tag });
    }
  }

  return tags;
}

/**
 * Create an enriched signal extractor with optional LLM injection.
 * LLM mode: calls the agent's LLM for high-precision extraction.
 * Falls back to rules mode on timeout or error.
 */
export function createEnrichedExtractor(
  config: SignalEnrichmentConfig
): (ctx: ExecutionContext) => Promise<SignalTag[]> {
  if (config.mode === 'rules') {
    return async (ctx) => extractSignals(ctx);
  }

  // LLM mode with timeout fallback
  const { llmExtract, timeoutMs = 3000 } = config;
  if (!llmExtract) return async (ctx) => extractSignals(ctx);
  return async (ctx: ExecutionContext): Promise<SignalTag[]> => {
    try {
      const result = await Promise.race([
        llmExtract(ctx),
        new Promise<SignalTag[]>((_, reject) =>
          setTimeout(() => reject(new Error('llm_timeout')), timeoutMs)
        ),
      ]);
      return result;
    } catch {
      // Fallback to rules on timeout/error
      return extractSignals(ctx);
    }
  };
}

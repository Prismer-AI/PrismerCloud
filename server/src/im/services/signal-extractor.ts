/**
 * Prismer IM — Signal Extractor Service
 *
 * LLM-driven signal extraction from raw agent context (errors, logs, task output).
 * Async pipeline: raw text → LLM extraction → structured SignalTag[] + root cause.
 *
 * Features:
 * - LLM extraction with configurable model (Nacos/env)
 * - Redis cache (hash-based dedup, TTL 1h)
 * - Regex fallback (always available)
 * - Process-level semaphore (max concurrent LLM calls)
 * - Graceful degradation: LLM fail → regex, Redis fail → no cache
 */

import type { SignalTag } from '../types/index';
import type Redis from 'ioredis';

// ─── Types ─────────────────────────────────────────────────

export interface ExtractionInput {
  rawContext: string; // Raw error/log/context (max 4KB)
  task?: string; // Task description
  outcome?: string; // success | failed
  provider?: string; // k8s, openai, aws...
  stage?: string; // deploy, fetch, build...
  severity?: string; // low, medium, high, critical
}

export interface ExtractionResult {
  signals: SignalTag[];
  rootCause: string | null;
  suggestedCategory: string | null;
  method: 'llm' | 'regex' | 'regex_fallback' | 'cached';
  model?: string;
  latencyMs: number;
}

// ─── Semaphore ──────────────────────────────────────────────

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get pending(): number {
    return this.queue.length;
  }
  get active(): number {
    return this.current;
  }
}

// ─── Constants ──────────────────────────────────────────────

const MAX_CONCURRENT_LLM = 5;
const MAX_INPUT_LENGTH = 4096;
const CACHE_PREFIX = 'evo:extract:';
const CACHE_TTL = 3600; // 1 hour
const LLM_TIMEOUT_MS = 30_000; // 30s for reasoning models (kimi-k2.5 etc)
const LLM_MAX_RETRIES = 2;

// ─── Regex extractor (existing logic, always available) ─────

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/timeout/i, 'timeout'],
  [/econnrefused|connection refused/i, 'connection_refused'],
  [/enotfound|dns/i, 'dns_error'],
  [/rate.?limit|429/i, 'rate_limit'],
  [/unauthorized|401/i, 'auth_error'],
  [/forbidden|403/i, 'forbidden'],
  [/not.?found|404/i, 'not_found'],
  [/500|internal server/i, 'server_error'],
  [/typeerror/i, 'type_error'],
  [/syntaxerror/i, 'syntax_error'],
  [/referenceerror/i, 'reference_error'],
  [/out of memory|oom|killed/i, 'oom'],
  [/crashloopbackoff|crash.?loop/i, 'crash_loop'],
  [/evicted|quota/i, 'resource_quota'],
  [/certificate|ssl|tls/i, 'tls_error'],
  [/deadlock/i, 'deadlock'],
  [/segfault|segmentation/i, 'segfault'],
];

function extractSignalsRegex(input: ExtractionInput): ExtractionResult {
  const start = Date.now();
  const signals: SignalTag[] = [];
  const text = input.rawContext.toLowerCase();

  // Error pattern matching
  for (const [pattern, signalType] of ERROR_PATTERNS) {
    if (pattern.test(text)) {
      const tag: SignalTag = { type: `error:${signalType}` };
      if (input.provider) tag.provider = input.provider;
      if (input.stage) tag.stage = input.stage;
      if (input.severity) tag.severity = input.severity;
      signals.push(tag);
    }
  }

  // Task status
  if (input.outcome === 'failed') signals.push({ type: 'task.failed' });
  if (input.outcome === 'success') signals.push({ type: 'task.completed' });

  // Fallback: normalize first 50 chars if no pattern matched
  if (signals.length === 0 || (signals.length === 1 && signals[0].type.startsWith('task.'))) {
    const normalized = text
      .slice(0, 50)
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (normalized) {
      const tag: SignalTag = { type: `error:${normalized}` };
      if (input.provider) tag.provider = input.provider;
      if (input.stage) tag.stage = input.stage;
      signals.push(tag);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = signals.filter((s) => {
    if (seen.has(s.type)) return false;
    seen.add(s.type);
    return true;
  });

  return {
    signals: deduped.slice(0, 5),
    rootCause: null,
    suggestedCategory: null,
    method: 'regex',
    latencyMs: Date.now() - start,
  };
}

// ─── LLM Prompt ─────────────────────────────────────────────

function buildPrompt(input: ExtractionInput): string {
  const ctx = input.rawContext.slice(-MAX_INPUT_LENGTH); // Tail is more valuable for error stacks
  return `You are an infrastructure signal extractor for an AI agent evolution system.

Given raw context from an agent's task execution, extract structured signals.

<raw_context>
${ctx}
</raw_context>

Task: ${input.task || 'unknown'}
Provider: ${input.provider || 'unknown'}
Stage: ${input.stage || 'unknown'}
Outcome: ${input.outcome || 'unknown'}

Return JSON only (no markdown, no explanation):
{
  "signals": [
    {"type": "error:timeout", "provider": "k8s", "stage": "deploy", "severity": "high"}
  ],
  "root_cause": "Brief root cause (one sentence)",
  "suggested_category": "repair"
}

Rules:
- type prefixes: error:, task., capability:, infra:, perf:
- Max 5 signals, ordered by importance
- severity: low, medium, high, critical
- root_cause = actionable one-liner
- suggested_category: repair | optimize | innovate | diagnostic`;
}

// ─── Cache key ──────────────────────────────────────────────

function cacheKey(input: ExtractionInput): string {
  // Hash based on normalized raw context + provider + stage
  const raw = `${input.rawContext.slice(0, 500)}|${input.provider || ''}|${input.stage || ''}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `${CACHE_PREFIX}${Math.abs(hash).toString(36)}`;
}

// ─── Service ────────────────────────────────────────────────

export class SignalExtractorService {
  private semaphore = new Semaphore(MAX_CONCURRENT_LLM);
  private redis: Redis | null = null;

  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /**
   * Extract signals from raw context.
   * Pipeline: cache → LLM → regex fallback
   */
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    // Truncate input
    if (input.rawContext.length > MAX_INPUT_LENGTH) {
      input = { ...input, rawContext: input.rawContext.slice(-MAX_INPUT_LENGTH) };
    }

    // 1. Check cache
    const cached = await this.checkCache(input);
    if (cached) return cached;

    // 2. Try LLM extraction
    const llmResult = await this.extractLLM(input);
    if (llmResult && llmResult.signals.length > 0) {
      await this.writeCache(input, llmResult);
      return llmResult;
    }

    // 3. Fallback to regex
    const regexResult = extractSignalsRegex(input);
    regexResult.method = llmResult ? 'regex_fallback' : 'regex';
    return regexResult;
  }

  /**
   * Regex-only extraction (synchronous, always available).
   */
  extractFast(input: ExtractionInput): ExtractionResult {
    return extractSignalsRegex(input);
  }

  private async checkCache(input: ExtractionInput): Promise<ExtractionResult | null> {
    if (!this.redis) return null;
    try {
      const key = cacheKey(input);
      const data = await this.redis.get(key);
      if (!data) return null;
      const parsed = JSON.parse(data) as ExtractionResult;
      parsed.method = 'cached';
      parsed.latencyMs = 0;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCache(input: ExtractionInput, result: ExtractionResult): Promise<void> {
    if (!this.redis) return;
    try {
      const key = cacheKey(input);
      await this.redis.setex(key, CACHE_TTL, JSON.stringify(result));
    } catch {
      // Non-blocking
    }
  }

  private async extractLLM(input: ExtractionInput): Promise<ExtractionResult | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[SignalExtractor] No OPENAI_API_KEY in env, skipping LLM extraction');
      return null;
    }

    const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.EVOLUTION_EXTRACT_MODEL || process.env.DEFAULT_MODEL || 'gpt-4o-mini';
    const prompt = buildPrompt(input);
    const start = Date.now();

    // Semaphore: limit concurrent LLM calls
    await this.semaphore.acquire();
    try {
      for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              // Reasoning models (kimi-k2.5) require temperature=1; standard models use 0.2
              ...(model.includes('kimi') || model.includes('o1') || model.includes('o3')
                ? {} // Omit temperature for reasoning models (use server default)
                : { temperature: 0.2 }),
              max_tokens: 2048,
            }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (response.status === 429 || response.status >= 500) {
            if (attempt < LLM_MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
              continue;
            }
            return null;
          }

          if (!response.ok) {
            console.warn(`[SignalExtractor] LLM HTTP ${response.status}: ${await response.text().catch(() => '?')}`);
            return null;
          }

          const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          };
          // Support both standard content and reasoning models (e.g. kimi-k2.5)
          const msg = data.choices?.[0]?.message;
          const content = msg?.content || msg?.reasoning_content || '';
          if (!content) {
            console.warn('[SignalExtractor] LLM returned empty content:', JSON.stringify(data).slice(0, 200));
            return null;
          }
          console.log(`[SignalExtractor] LLM OK (${Date.now() - start}ms, ${model})`);

          // Parse JSON from LLM response
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return null;

          const parsed = JSON.parse(jsonMatch[0]) as {
            signals?: Array<{ type: string; provider?: string; stage?: string; severity?: string }>;
            root_cause?: string;
            suggested_category?: string;
          };

          if (!parsed.signals || !Array.isArray(parsed.signals) || parsed.signals.length === 0) return null;

          // Validate and clean signals
          const signals: SignalTag[] = parsed.signals
            .filter((s): s is SignalTag => typeof s.type === 'string' && s.type.length > 0)
            .slice(0, 5)
            .map((s) => ({
              type: s.type,
              ...(s.provider && { provider: s.provider }),
              ...(s.stage && { stage: s.stage }),
              ...(s.severity && { severity: s.severity }),
            }));

          return {
            signals,
            rootCause: parsed.root_cause || null,
            suggestedCategory: parsed.suggested_category || null,
            method: 'llm',
            model,
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            console.warn(`[SignalExtractor] LLM timeout (${LLM_TIMEOUT_MS}ms)`);
            return null;
          }
          if (attempt < LLM_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
            continue;
          }
          console.warn('[SignalExtractor] LLM failed:', (err as Error).message);
          return null;
        }
      }
      return null;
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Compute semantic similarity between two signal types via LLM.
   * Results are cached in Redis (TTL 24h) to avoid repeated LLM calls.
   * Returns 0-1 similarity score, or null if LLM unavailable.
   */
  async computeSemanticSimilarity(signalA: string, signalB: string): Promise<number | null> {
    if (signalA === signalB) return 1.0;

    // Canonical pair key (sorted for dedup)
    const pairKey = [signalA, signalB].sort().join('↔');
    const redisKey = `evo:sim:${pairKey}`;

    // Check Redis cache first
    if (this.redis) {
      try {
        const cached = await this.redis.get(redisKey);
        if (cached !== null) return parseFloat(cached);
      } catch {
        /* ignore */
      }
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.EVOLUTION_EXTRACT_MODEL || process.env.DEFAULT_MODEL || 'gpt-4o-mini';

    const prompt = `Given two infrastructure signal types from an AI agent system, rate their semantic similarity from 0.0 to 1.0.

Signal A: "${signalA}"
Signal B: "${signalB}"

Consider: Are they caused by similar root issues? Would the same fix strategy apply to both?

Return JSON only: {"similarity": 0.8, "reason": "brief explanation"}`;

    await this.semaphore.acquire();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          ...(model.includes('kimi') || model.includes('o1') || model.includes('o3') ? {} : { temperature: 0.1 }),
          max_tokens: 200,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const msg = data.choices?.[0]?.message;
      const content = msg?.content || msg?.reasoning_content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as { similarity?: number };
      const similarity = typeof parsed.similarity === 'number' ? Math.max(0, Math.min(1, parsed.similarity)) : null;

      // Cache in Redis (24h TTL)
      if (similarity !== null && this.redis) {
        try {
          await this.redis.setex(redisKey, 86400, similarity.toString());
        } catch {
          /* ignore */
        }
      }

      return similarity;
    } catch {
      return null;
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Batch compute semantic similarities for multiple signal pairs.
   * Used by selectGene() when coverage is low.
   * Max 3 pairs per call to limit LLM cost.
   */
  async batchSemanticSimilarity(pairs: Array<[string, string]>): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const toCompute = pairs.slice(0, 3); // Max 3 per batch

    await Promise.all(
      toCompute.map(async ([a, b]) => {
        const sim = await this.computeSemanticSimilarity(a, b);
        if (sim !== null) {
          const key = [a, b].sort().join('↔');
          result.set(key, sim);
        }
      }),
    );

    return result;
  }

  /** Stats for monitoring */
  getStats(): { activeLLM: number; pendingLLM: number } {
    return {
      activeLLM: this.semaphore.active,
      pendingLLM: this.semaphore.pending,
    };
  }
}

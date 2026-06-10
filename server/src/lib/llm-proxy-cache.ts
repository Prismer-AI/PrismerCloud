/**
 * Shared LLM-proxy idempotency cache infrastructure.
 *
 * Used by both the OpenAI-shape proxy (`llm-proxy.ts`) and the Anthropic-shape
 * proxy (`llm-proxy-anthropic.ts`). The cache backend (Redis) and wire format
 * are protocol-agnostic; only the upstream response shape + the billing
 * record's `task_type` differ between the two proxies (those stay in the
 * caller).
 *
 * Design contract (Cleanup-2, 2026-05-25):
 *   - Caller passes `x-prismer-idempotency-key` header (derived from
 *     taskRunId + attemptNo + stepSeq + model + prompt by the SDK adapter).
 *   - Cache key namespace `llm-cache:` shared across protocols — collisions
 *     are vanishingly rare because the key value is a sha256 that includes
 *     the model name.
 *   - 24h TTL — matches the upper bound for realistic daemon-resume windows.
 *   - Fail-open: any Redis hiccup must NOT break a live LLM call. All read /
 *     write helpers log + return null / swallow.
 */

import Redis from 'ioredis';
import type { LLMUsage } from '@/lib/llm-pricing';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('LLMProxyCache');

export const IDEMPOTENCY_HEADER = 'x-prismer-idempotency-key';
export const CACHE_KEY_PREFIX = 'llm-cache:';
export const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Cached LLM response entry. Protocol-agnostic — the same shape works for
 * OpenAI chat/embeddings and Anthropic messages because we store the wire
 * bytes verbatim (`body` for non-streaming, `chunks` for streaming SSE).
 */
export interface LLMCacheEntry {
  status: number;
  isStreaming: boolean;
  contentType: string;
  /** Non-streaming: full response body. */
  body?: string;
  /** Streaming: ordered list of pre-formatted SSE chunks (byte-identical replay). */
  chunks?: string[];
  /** Token accounting captured for billing pass-through on cache hit. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** Model echoed by upstream so cache-hit billing records the right SKU. */
  model?: string;
  cachedAt: string;
  upstream: string;
}

const globalForLLMRedis = globalThis as unknown as { __llmProxyRedis?: Redis };

function buildRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD || '';
  const db = process.env.REDIS_DB || '0';
  const auth = password ? `:${password}@` : '';
  return `redis://${auth}${host}:${port}/${db}`;
}

export function getCacheRedis(): Redis {
  if (globalForLLMRedis.__llmProxyRedis) return globalForLLMRedis.__llmProxyRedis;
  const client = new Redis(buildRedisUrl(), {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 1500)),
    lazyConnect: false,
  });
  client.on('error', (err) =>
    log.warn({ error: err.message }, 'LLMProxy Redis cache error (non-fatal)'),
  );
  globalForLLMRedis.__llmProxyRedis = client;
  return client;
}

/** Read + JSON.parse a cache entry. Returns null on miss / parse failure. */
export async function readCache(key: string): Promise<LLMCacheEntry | null> {
  try {
    const raw = await getCacheRedis().get(CACHE_KEY_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as LLMCacheEntry;
  } catch (err) {
    log.warn({ key, error: String(err) }, 'cache read failed');
    return null;
  }
}

/** Write + JSON.stringify a cache entry with a 24h TTL. Failures are logged but never thrown. */
export async function writeCache(key: string, entry: LLMCacheEntry): Promise<void> {
  try {
    await getCacheRedis().setex(CACHE_KEY_PREFIX + key, CACHE_TTL_SECONDS, JSON.stringify(entry));
  } catch (err) {
    log.warn({ key, error: String(err) }, 'cache write failed');
  }
}

/**
 * Normalise an LLMUsage (or any token-shaped object) into the slim
 * snake-and-camel-tolerant shape we persist in Redis.
 */
export function usageForCache(u?: LLMUsage | null):
  | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | undefined {
  if (!u) return undefined;
  const src = u as unknown as Record<string, unknown>;
  const promptTokens =
    typeof src.prompt_tokens === 'number'
      ? src.prompt_tokens
      : typeof src.promptTokens === 'number'
        ? src.promptTokens
        : undefined;
  const completionTokens =
    typeof src.completion_tokens === 'number'
      ? src.completion_tokens
      : typeof src.completionTokens === 'number'
        ? src.completionTokens
        : undefined;
  const totalTokens =
    typeof src.total_tokens === 'number'
      ? src.total_tokens
      : typeof src.totalTokens === 'number'
        ? src.totalTokens
        : undefined;
  return { promptTokens, completionTokens, totalTokens };
}

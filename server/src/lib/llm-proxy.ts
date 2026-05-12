/**
 * LLM Proxy — thin reverse proxy to NewAPI gateway
 *
 * Design principles:
 *   1. Byte-level transparent pipe — we never parse request bodies
 *   2. Key swap only — replace sk-prismer-* with NewAPI token
 *   3. Usage extraction — read standard `usage` field from response for billing
 *   4. Fail-open for billing — if usage extraction fails, the LLM call still succeeds
 */

import { NextRequest } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';
import { resolveNewAPIToken } from '@/lib/newapi-admin';
import { calculateLLMCredits, type LLMUsage } from '@/lib/llm-pricing';
import { recordUsageBackground, generateTaskId, type UsageRecordRequest } from '@/lib/usage-recorder';
import type { GuardResult } from '@/lib/api-guard';

const log = createModuleLogger('LLMProxy');

// ============================================================================
// Config
// ============================================================================

function getNewAPIBaseUrl(): string {
  const url = process.env.NEWAPI_BASE_URL;
  if (!url) throw new Error('[LLMProxy] NEWAPI_BASE_URL not configured');
  return url.replace(/\/$/, '');
}

function getTimeoutMs(): number {
  return parseInt(process.env.LLM_PROXY_TIMEOUT_MS || '', 10) || 120_000;
}

// Headers to strip when forwarding to upstream
const STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
]);

// Headers to strip from upstream response before returning to client
const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive']);

// ============================================================================
// Main proxy function
// ============================================================================

/**
 * Proxy an OpenAI-compatible request to NewAPI.
 *
 * @param request   - Incoming Next.js request
 * @param guard     - Validated auth from apiGuard
 * @param endpoint  - Upstream path, e.g. '/v1/chat/completions'
 */
export async function proxyToNewAPI(request: NextRequest, guard: GuardResult, endpoint: string): Promise<Response> {
  await ensureNacosConfig();

  const newApiToken = await resolveNewAPIToken(guard.auth.userId);
  const upstreamUrl = `${getNewAPIBaseUrl()}${endpoint}`;

  // Build upstream headers with key swap
  const headers = buildUpstreamHeaders(request.headers, newApiToken);

  // Prepare request body
  let body: ReadableStream<Uint8Array> | string | null = null;
  let isStreaming = false;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Read body once to detect streaming and inject stream_options
    const rawBody = await request.text();
    try {
      const parsed = JSON.parse(rawBody);
      isStreaming = !!parsed.stream;
      // Inject stream_options for usage reporting in final SSE chunk
      if (isStreaming && !parsed.stream_options?.include_usage) {
        parsed.stream_options = { ...parsed.stream_options, include_usage: true };
      }
      body = JSON.stringify(parsed);
    } catch {
      // Non-JSON body (unlikely for LLM calls) — pass through as-is
      body = rawBody;
    }
  }

  // Forward to upstream
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());

  log.info({ upstreamUrl, isStreaming, bodyLength: body?.toString().length ?? 0 }, 'Forwarding to upstream');

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: 'no-store',
    } as RequestInit);
    log.info({ status: upstream.status, isStreaming }, 'Upstream responded');
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ endpoint, error: msg }, 'Upstream fetch failed');
    return new Response(
      JSON.stringify({
        error: { message: `LLM gateway unreachable: ${msg}`, type: 'proxy_error' },
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // Handle error responses from upstream (pass through as-is)
  if (!upstream.ok && !isStreaming) {
    const errorBody = await upstream.text();
    return new Response(errorBody, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream.headers),
    });
  }

  // Route to streaming or non-streaming handler
  if (isStreaming) {
    return handleStreaming(upstream, guard, endpoint);
  }
  return handleNonStreaming(upstream, guard, endpoint);
}

// ============================================================================
// Non-streaming response
// ============================================================================

async function handleNonStreaming(upstream: Response, guard: GuardResult, endpoint: string): Promise<Response> {
  const bodyText = await upstream.text();

  // Best-effort usage extraction for billing
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.usage) {
      const model = parsed.model || 'unknown';
      recordLLMUsage(guard, model, parsed.usage, endpoint);
    }
  } catch {
    log.warn({ endpoint }, 'Failed to extract usage from non-streaming response');
  }

  return new Response(bodyText, {
    status: upstream.status,
    headers: buildResponseHeaders(upstream.headers),
  });
}

// ============================================================================
// Streaming response (SSE)
// ============================================================================

async function handleStreaming(upstream: Response, guard: GuardResult, endpoint: string): Promise<Response> {
  if (!upstream.body) {
    return new Response(null, { status: 502 });
  }

  let extractedUsage: LLMUsage | null = null;
  let extractedModel = 'unknown';
  let lineBuffer = '';

  // Use ReadableStream constructor for maximum compatibility with Next.js
  const reader = upstream.body.getReader();

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Process remaining buffer
          if (lineBuffer) {
            for (const line of lineBuffer.split('\n')) {
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.model) extractedModel = parsed.model;
                if (parsed.usage) extractedUsage = parsed.usage;
              } catch {
                /* skip */
              }
            }
          }
          if (extractedUsage) {
            recordLLMUsage(guard, extractedModel, extractedUsage, endpoint);
          } else {
            log.warn({ endpoint }, 'Streaming ended without usage data — billing skipped');
          }
          controller.close();
          return;
        }

        // Always forward immediately
        controller.enqueue(value);

        // Best-effort: scan for usage data
        try {
          const text = new TextDecoder().decode(value);
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.model) extractedModel = parsed.model;
              if (parsed.usage) extractedUsage = parsed.usage;
            } catch {
              /* skip partial JSON */
            }
          }
        } catch {
          /* non-critical */
        }
      } catch (err) {
        log.warn({ error: String(err) }, 'Stream read error');
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const responseHeaders = buildResponseHeaders(upstream.headers);
  // Ensure proper SSE headers for streaming
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
  }

  return new Response(stream, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ============================================================================
// Billing helper
// ============================================================================

function recordLLMUsage(guard: GuardResult, model: string, usage: LLMUsage, endpoint: string): void {
  try {
    const cost = calculateLLMCredits(model, usage);

    const record: UsageRecordRequest = {
      task_id: generateTaskId('llm'),
      task_type: 'llm_proxy',
      input: {
        type: 'query',
        value: `${endpoint} model=${model}`,
      },
      metrics: {
        tokens_input: cost.promptTokens,
        tokens_output: cost.completionTokens,
        processing_time_ms: 0,
      },
      cost: {
        compression_credits: cost.credits,
        total_credits: cost.credits,
      },
    };

    recordUsageBackground(record, guard.auth.authHeader);

    log.info(
      {
        userId: guard.auth.userId,
        model,
        promptTokens: cost.promptTokens,
        completionTokens: cost.completionTokens,
        credits: cost.credits,
      },
      'LLM usage recorded',
    );
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to record LLM usage');
  }
}

// ============================================================================
// Header utilities
// ============================================================================

function buildUpstreamHeaders(incoming: Headers, newApiToken: string): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set('Authorization', `Bearer sk-${newApiToken}`);
  return headers;
}

function buildResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of upstream.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  return headers;
}

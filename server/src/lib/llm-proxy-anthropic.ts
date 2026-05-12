/**
 * LLM Proxy — Anthropic protocol thin pipe to NewAPI gateway
 *
 * Mirrors src/lib/llm-proxy.ts for Anthropic /v1/messages:
 *   1. Auth swap on x-api-key (or Authorization Bearer) → NewAPI x-api-key
 *   2. Body byte-pipe with stream-detection peek (no semantic parsing)
 *   3. SSE event names differ (message_start / content_block_delta / message_stop)
 *      — pass through unchanged
 *   4. Usage extraction: Anthropic { input_tokens, output_tokens } via
 *      extractAnthropicUsage()
 */

import { NextRequest } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';
import { resolveNewAPIToken } from '@/lib/newapi-admin';
import { calculateLLMCredits, extractAnthropicUsage, type LLMUsage } from '@/lib/llm-pricing';
import { recordUsageBackground, generateTaskId, type UsageRecordRequest } from '@/lib/usage-recorder';
import type { GuardResult } from '@/lib/api-guard';

const log = createModuleLogger('LLMProxyAnthropic');

function getNewAPIBaseUrl(): string {
  const url = process.env.NEWAPI_ANTHROPIC_BASE_URL || process.env.NEWAPI_BASE_URL;
  if (!url) throw new Error('[LLMProxyAnthropic] NEWAPI_BASE_URL not configured');
  return url.replace(/\/$/, '');
}

function getTimeoutMs(): number {
  return parseInt(process.env.LLM_PROXY_TIMEOUT_MS || '', 10) || 120_000;
}

const STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
]);
const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive']);

export async function proxyAnthropicToNewAPI(
  request: NextRequest,
  guard: GuardResult,
  endpoint: string,
): Promise<Response> {
  await ensureNacosConfig();

  const newApiToken = await resolveNewAPIToken(guard.auth.userId);
  const upstreamUrl = `${getNewAPIBaseUrl()}${endpoint}`;
  const headers = buildUpstreamHeaders(request.headers, newApiToken);

  let body: string | null = null;
  let isStreaming = false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const rawBody = await request.text();
    try {
      const parsed = JSON.parse(rawBody);
      isStreaming = !!parsed.stream;
      body = rawBody;
    } catch {
      body = rawBody;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());
  log.info({ upstreamUrl, isStreaming, bodyLen: body?.length ?? 0 }, 'Forwarding Anthropic request');

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      cache: 'no-store',
    } as RequestInit);
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: { message: `LLM gateway unreachable: ${msg}`, type: 'proxy_error' } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!upstream.ok && !isStreaming) {
    const errBody = await upstream.text();
    return new Response(errBody, { status: upstream.status, headers: buildResponseHeaders(upstream.headers) });
  }

  if (isStreaming) return handleAnthropicStreaming(upstream, guard, endpoint);
  return handleAnthropicNonStreaming(upstream, guard, endpoint);
}

async function handleAnthropicNonStreaming(
  upstream: Response,
  guard: GuardResult,
  endpoint: string,
): Promise<Response> {
  const text = await upstream.text();
  try {
    const parsed = JSON.parse(text);
    const usage = extractAnthropicUsage(parsed);
    const model = (parsed as { model?: string }).model || 'unknown';
    if (usage) recordUsage(guard, model, usage, endpoint);
    else log.warn({ endpoint }, 'No usage in Anthropic non-streaming response');
  } catch {
    log.warn({ endpoint }, 'Failed to parse Anthropic non-streaming body for billing');
  }
  return new Response(text, { status: upstream.status, headers: buildResponseHeaders(upstream.headers) });
}

async function handleAnthropicStreaming(upstream: Response, guard: GuardResult, endpoint: string): Promise<Response> {
  if (!upstream.body) return new Response(null, { status: 502 });

  let inputTokens: number | null = null;
  let outputTokens = 0;
  let model = 'unknown';
  let buf = '';
  const reader = upstream.body.getReader();

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (inputTokens !== null) {
            recordUsage(
              guard,
              model,
              {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
              endpoint,
            );
          } else {
            log.warn({ endpoint }, 'Anthropic streaming ended without usage; billing skipped');
          }
          controller.close();
          return;
        }
        controller.enqueue(value);
        try {
          buf += new TextDecoder().decode(value);
          const events = buf.split('\n\n');
          buf = events.pop() ?? '';
          for (const ev of events) {
            const dataLine = ev.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(6));
              if (parsed.type === 'message_start' && parsed.message?.usage) {
                inputTokens = parsed.message.usage.input_tokens ?? inputTokens;
                model = parsed.message.model || model;
              } else if (parsed.type === 'message_delta' && parsed.usage) {
                outputTokens = parsed.usage.output_tokens ?? outputTokens;
              }
            } catch {
              /* partial JSON */
            }
          }
        } catch {
          /* non-critical */
        }
      } catch (err) {
        log.warn({ error: String(err) }, 'Anthropic stream read error');
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const responseHeaders = buildResponseHeaders(upstream.headers);
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
  }
  return new Response(stream, { status: upstream.status, headers: responseHeaders });
}

function recordUsage(guard: GuardResult, model: string, usage: LLMUsage, endpoint: string): void {
  try {
    const cost = calculateLLMCredits(model, usage);
    const record: UsageRecordRequest = {
      task_id: generateTaskId('llm'),
      task_type: 'llm_proxy_anthropic',
      input: { type: 'query', value: `${endpoint} model=${model}` },
      metrics: {
        tokens_input: cost.promptTokens,
        tokens_output: cost.completionTokens,
        processing_time_ms: 0,
      },
      cost: { compression_credits: cost.credits, total_credits: cost.credits },
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
      'Anthropic usage recorded',
    );
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to record Anthropic usage');
  }
}

function buildUpstreamHeaders(incoming: Headers, newApiToken: string): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set('x-api-key', `sk-${newApiToken}`);
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

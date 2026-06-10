import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { checkLlmRateLimitDistributed, rateLimitResponse } from '@/lib/rate-limit';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { proxyToNewAPI } from '@/lib/llm-proxy';
import { ensureNacosConfig } from '@/lib/nacos-config';
import {
  responsesToChatRequest,
  chatToResponsesObject,
  chatStreamToResponsesStream,
} from './responses-chat-bridge';

/**
 * Shared Responses-API bridge handler (release202/03 §3.1 + 07 §3).
 *
 * Translates an OpenAI Responses request → Chat Completions, forwards via
 * `proxyToNewAPI` (which walks the provider CHAIN selected by `chainId`), then
 * synthesizes a Codex-correct Responses event stream from the chat response.
 *
 * `chainId` lets the per-provider alias route (`/api/v1/proxy/<chain>/responses`)
 * pin the upstream chain the same way the chat alias does — so a codex agent
 * whose profile sets `proxyProvider: 'deepseek'` actually routes to the
 * deepseek source instead of always landing on newapi (the pre-07 bug).
 * `undefined` keeps the platform-default chain.
 */
export async function handleResponsesBridge(
  request: NextRequest,
  chainId?: string,
): Promise<Response> {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.LLM_PROXY_ENABLED) {
    return NextResponse.json(
      { error: { message: 'LLM proxy is not enabled', type: 'service_unavailable' } },
      { status: 503 },
    );
  }

  // release202/12 (P1) — gate a minimum starting balance (covers /api/responses
  // + /api/proxy/[provider]/responses); real cost deducted post-hoc.
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;

  const rl = await checkLlmRateLimitDistributed(guard.auth.userId);
  if (!rl.allowed) return rateLimitResponse(rl);

  // Parse the incoming Responses request.
  let respBody: Record<string, unknown>;
  try {
    respBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'invalid JSON body', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const wantStream = respBody.stream !== false;
  const model = String(respBody.model ?? '');

  // Translate Responses → Chat Completions and forward via the chat proxy.
  const chatBody = responsesToChatRequest(respBody);
  const chatRequest = new NextRequest(new URL('/api/v1/chat/completions', request.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: request.headers.get('authorization') ?? '',
    },
    body: JSON.stringify(chatBody),
  });

  const chatResp = await proxyToNewAPI(chatRequest, guard, '/v1/chat/completions', chainId);

  // Upstream error → pass through (Responses-style envelope).
  if (!chatResp.ok) {
    const errText = await chatResp.text();
    return new Response(errText, {
      status: chatResp.status,
      headers: { 'content-type': chatResp.headers.get('content-type') ?? 'application/json' },
    });
  }

  const isStream =
    wantStream && (chatResp.headers.get('content-type') ?? '').includes('text/event-stream');

  if (isStream && chatResp.body) {
    const responsesStream = chatStreamToResponsesStream(chatResp.body, model);
    return new Response(responsesStream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  // Non-streaming: translate the chat completion JSON into a Responses object.
  const chatJson = await chatResp.json().catch(() => ({}));
  return NextResponse.json(chatToResponsesObject(chatJson as Record<string, unknown>, model));
}

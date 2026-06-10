import { NextRequest, NextResponse } from 'next/server';
import type { RequestInit as NextRequestInit } from 'next/dist/server/web/spec-extension/request';
import { apiGuard } from '@/lib/api-guard';
import { checkLlmRateLimitDistributed, rateLimitResponse } from '@/lib/rate-limit';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { proxyAnthropicToNewAPI } from '@/lib/llm-proxy-anthropic';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/messages  (external: /api/v1/messages)
 *
 * Anthropic-protocol Messages API proxy.
 * Auth: sk-prismer-* via x-api-key OR Authorization Bearer.
 * Billing post-hoc via extractAnthropicUsage.
 */
export async function POST(request: NextRequest) {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.LLM_PROXY_ENABLED) {
    return NextResponse.json(
      { error: { message: 'LLM proxy is not enabled', type: 'service_unavailable' } },
      { status: 503 },
    );
  }

  // Anthropic-style x-api-key → mirror to Authorization Bearer for apiGuard.
  let guardRequest: NextRequest = request;
  const xApiKey = request.headers.get('x-api-key');
  if (xApiKey && !request.headers.get('authorization')) {
    const newHeaders = new Headers(request.headers);
    newHeaders.set('authorization', `Bearer ${xApiKey}`);
    guardRequest = new NextRequest(request.url, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
    } as NextRequestInit);
  }

  // release202/12 (P1) — gate a minimum starting balance (Anthropic proxy);
  // real cost deducted post-hoc inside proxyAnthropicToNewAPI.
  const guard = await apiGuard(guardRequest, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;

  const rl = await checkLlmRateLimitDistributed(guard.auth.userId);
  if (!rl.allowed) return rateLimitResponse(rl);

  return proxyAnthropicToNewAPI(request, guard, '/v1/messages');
}

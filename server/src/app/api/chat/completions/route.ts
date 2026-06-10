import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { checkLlmRateLimitDistributed, rateLimitResponse } from '@/lib/rate-limit';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { proxyToNewAPI } from '@/lib/llm-proxy';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/chat/completions  (external: /api/v1/chat/completions)
 *
 * OpenAI-compatible Chat Completions proxy.
 * Auth: sk-prismer-* API Key or JWT.
 * Billing is post-hoc (extracted from upstream usage field), not pre-checked.
 * Supports both streaming (SSE) and non-streaming modes.
 */
export async function POST(request: NextRequest) {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.LLM_PROXY_ENABLED) {
    return NextResponse.json(
      { error: { message: 'LLM proxy is not enabled', type: 'service_unavailable' } },
      { status: 503 },
    );
  }

  // release202/12 (P1) — 'billable' gates a minimum starting balance so a
  // zero/negative-credit account can't spend upstream $. estimatedCost is a
  // small floor (real cost deducted post-hoc via usage extraction); the free
  // tier is the 1000-credit signup grant. Blocked → 402 INSUFFICIENT_CREDITS.
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;

  const rl = await checkLlmRateLimitDistributed(guard.auth.userId);
  if (!rl.allowed) return rateLimitResponse(rl);

  return proxyToNewAPI(request, guard, '/v1/chat/completions');
}

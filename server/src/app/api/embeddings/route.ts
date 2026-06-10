import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { checkLlmRateLimitDistributed, rateLimitResponse } from '@/lib/rate-limit';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { proxyToNewAPI } from '@/lib/llm-proxy';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/embeddings  (external: /api/v1/embeddings)
 *
 * OpenAI-compatible Embeddings proxy.
 * Auth: sk-prismer-* API Key or JWT.
 * Billing is post-hoc. Non-streaming only.
 */
export async function POST(request: NextRequest) {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.LLM_PROXY_ENABLED) {
    return NextResponse.json(
      { error: { message: 'LLM proxy is not enabled', type: 'service_unavailable' } },
      { status: 503 },
    );
  }

  // release202/12 (P1) — gate a minimum starting balance; real cost post-hoc.
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;

  const rl = await checkLlmRateLimitDistributed(guard.auth.userId);
  if (!rl.allowed) return rateLimitResponse(rl);

  return proxyToNewAPI(request, guard, '/v1/embeddings');
}

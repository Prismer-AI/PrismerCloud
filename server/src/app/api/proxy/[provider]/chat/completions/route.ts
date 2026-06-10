import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { checkLlmRateLimitDistributed, rateLimitResponse } from '@/lib/rate-limit';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { proxyToNewAPI } from '@/lib/llm-proxy';
import { getProviderChainIds, getProviderSources } from '@/lib/llm/provider-sources';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/proxy/[provider]/chat/completions
 * (external: /api/v1/proxy/[provider]/chat/completions)
 *
 * 2026-05-30 — per-agent (= per-hermes-profile) LLM proxy selector.
 *
 * Mirrors the auth + rate-limit + billing contract of
 * `/api/chat/completions` (the platform-default route) but force-pins the
 * upstream provider CHAIN via the URL `[provider]` segment instead of relying
 * on the global `DEEPSEEK_BYPASS_ENABLED` env. This lets two agents share a
 * workspace and a daemon but route to different LLM backends for an
 * apples-to-apples speed + quality comparison.
 *
 * release202/07 — `[provider]` accepts any registered chain id OR a bare source
 * id (resolved by `resolveChain` inside `proxyToNewAPI`). The legacy
 * `newapi` / `deepseek` values resolve to built-in single-element chains.
 * Unknown values 400 (a typo'd chain is a config error worth surfacing rather
 * than silently routing to default). The legacy `/api/chat/completions` route
 * is preserved unchanged for backwards compat with existing daemon configs.
 */
function isKnownProvider(value: string): boolean {
  if (getProviderChainIds().includes(value)) return true;
  return getProviderSources().some((s) => s.id === value);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.LLM_PROXY_ENABLED) {
    return NextResponse.json(
      { error: { message: 'LLM proxy is not enabled', type: 'service_unavailable' } },
      { status: 503 },
    );
  }

  // Next.js 16 unwraps async params on demand.
  // NOTE: `isKnownProvider` reads the provider-sources registry, which caches
  // `process.env.LLM_PROVIDER_SOURCES/CHAINS` on first call. Nacos loads that
  // config into process.env lazily, so this check MUST run AFTER the
  // `await ensureNacosConfig()` above — otherwise custom chains 400.
  const { provider } = await ctx.params;
  if (!isKnownProvider(provider)) {
    return NextResponse.json(
      {
        error: {
          message: `Unknown provider chain: ${provider}. Expected a registered provider source or chain id.`,
          type: 'invalid_request_error',
        },
      },
      { status: 400 },
    );
  }

  // Reuse the same auth + rate-limit + billing pipeline as
  // /api/chat/completions — the only difference is the forced upstream
  // selection. release202/12 (P1) — 'billable' gates a minimum starting
  // balance (estimatedCost floor); real cost deducted post-hoc inside
  // proxyToNewAPI. Blocked → 402 INSUFFICIENT_CREDITS.
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
  if (!guard.ok) return guard.response;

  const rl = await checkLlmRateLimitDistributed(guard.auth.userId);
  if (!rl.allowed) return rateLimitResponse(rl);

  return proxyToNewAPI(request, guard, '/v1/chat/completions', provider);
}

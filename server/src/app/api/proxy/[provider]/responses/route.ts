import { NextRequest, NextResponse } from 'next/server';
import { handleResponsesBridge } from '@/app/api/responses/bridge-handler';
import { getProviderChainIds, getProviderSources } from '@/lib/llm/provider-sources';

/**
 * POST /api/proxy/[provider]/responses
 * (external: /api/v1/proxy/[provider]/responses)
 *
 * release202/07 — Responses-API analogue of
 * `/api/proxy/[provider]/chat/completions`. Pins the upstream provider CHAIN
 * via the URL `[provider]` segment so a Codex/CLI executor whose profile sets
 * `proxyProvider: '<chain>'` actually routes there (the pre-07 bug was that
 * the codex adapter hardcoded `/api/v1` and the bridge always hit newapi).
 *
 * `[provider]` accepts any registered chain id OR a bare source id (resolved by
 * `resolveChain`). Unknown values 400 (a typo'd chain is a config error worth
 * surfacing rather than silently routing to default). Auth + rate-limit +
 * billing all run inside `handleResponsesBridge` → `proxyToNewAPI`.
 */
function isKnownProvider(value: string): boolean {
  if (getProviderChainIds().includes(value)) return true;
  return getProviderSources().some((s) => s.id === value);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (!isKnownProvider(provider)) {
    return NextResponse.json(
      {
        error: {
          message: `Unknown provider chain: ${provider}. Expected a registered chain or source id.`,
          type: 'invalid_request_error',
        },
      },
      { status: 400 },
    );
  }
  return handleResponsesBridge(request, provider);
}

/**
 * GET /api/provider-chains  (release202/07)
 *
 * Lists the configured provider fallback chains for UI selection (the Pro
 * Executor / Agent proxyProvider picker). Each chain is an ordered list of
 * upstream sources (source1 → source2 → …); the picker shows the chain id and
 * uses the FIRST source's funnel to seed the model dropdown.
 *
 * Auth: sk-prismer-* API Key or JWT (tracked tier — auth only, no balance).
 * The list is a UI affordance, not an enforcement gate (the proxy resolves the
 * chain server-side regardless).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { getProviderChainIds, resolveChain } from '@/lib/llm/provider-sources';

export async function GET(request: NextRequest) {
  const guard = await apiGuard(request, { tier: 'tracked' });
  if (!guard.ok) return guard.response;

  const chains = getProviderChainIds().map((id) => {
    const sources = resolveChain(id);
    const primary = sources[0];
    return {
      id,
      label: id,
      sources: sources.map((s) => s.id),
      // First source drives the model dropdown funnel; 'newapi'/'deepseek' map
      // to the curated-models funnels the ModelPicker already understands.
      primarySource: primary?.id ?? 'newapi',
      primaryDefaultModel: primary?.defaultModel ?? null,
      primaryVision: primary?.vision ?? false,
    };
  });

  return NextResponse.json({ chains });
}

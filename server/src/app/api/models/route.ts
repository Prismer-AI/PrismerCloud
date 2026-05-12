/** GET /api/models  (external: /api/v1/models)
 *
 * OpenAI-format model list. Returns only the curated stable model subset
 * (controlled via Nacos `CURATED_MODELS` env var).
 * Auth: sk-prismer-* API Key or JWT (tracked tier — auth only, no balance check).
 *
 * The returned list is a UI affordance and CLI default, NOT an enforcement gate.
 * The LLM proxy (llm-proxy.ts) is a transparent pipe and does not validate the
 * model field — if a client sends a non-curated model the proxy still forwards it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { getCuratedModels } from './curated-models';

export async function GET(request: NextRequest) {
  const guard = await apiGuard(request, { tier: 'tracked' });
  if (!guard.ok) return guard.response;

  const models = getCuratedModels();
  const data = models.map((m) => ({
    id: m.id,
    object: 'model' as const,
    owned_by: m.provider,
  }));

  return NextResponse.json({ object: 'list', data });
}

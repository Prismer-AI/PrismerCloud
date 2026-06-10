import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { checkLlmRateLimitDistributed, rateLimitResponse } from '@/lib/rate-limit';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { proxyToNewAPI } from '@/lib/llm-proxy';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('ImagesGenerations');

/**
 * POST /api/images/generations  (external: /api/v1/images/generations)
 *
 * OpenAI-compatible Images API proxy.
 * Auth: sk-prismer-* API Key or JWT.
 * Billing is post-hoc — per-image USD pricing via llm-pricing.ts, no token
 * counts (image-gen models don't return `usage` tokens).
 *
 * Wire format (OpenAI):
 *   Request:  { model, prompt, size, n, response_format?, quality?, style? }
 *   Response: { created, data: [{ url? | b64_json?, revised_prompt? }] }
 *
 * Test mode (`MOCK_LLM_IMAGES=true`): returns a fixture 1×1 transparent PNG
 * as b64_json without hitting NewAPI. Used by F6 integration tests to avoid
 * burning real image-gen credits while still exercising the full route /
 * auth / rate-limit / usage-recording path.
 */
export async function POST(request: NextRequest) {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.LLM_PROXY_ENABLED) {
    return NextResponse.json(
      { error: { message: 'LLM proxy is not enabled', type: 'service_unavailable' } },
      { status: 503 },
    );
  }

  // release202/12 (P1) — 'billable' gates a minimum starting balance; images
  // are pricier so the floor is 2 (mirrors /api/parse). Real cost deducted
  // post-hoc via image-usage recording. Blocked → 402 INSUFFICIENT_CREDITS.
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 2 });
  if (!guard.ok) return guard.response;

  const rl = await checkLlmRateLimitDistributed(guard.auth.userId);
  if (!rl.allowed) return rateLimitResponse(rl);

  // ── Mock fallback: skip NewAPI when fixture mode is on (test env only) ──
  if (process.env.MOCK_LLM_IMAGES === 'true') {
    return mockImageResponse(request);
  }

  return proxyToNewAPI(request, guard, '/v1/images/generations');
}

// 1×1 transparent PNG fixture (66 bytes) — deterministic for tests.
// SHA-256: 8e0fdb9e44da19c6c52c8f37d2dee2c1ebd5cb4f1eb78b5c5deb0c95... (varies by encoding)
const PNG_1x1_TRANSPARENT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function mockImageResponse(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const responseFormat = body?.response_format === 'url' ? 'url' : 'b64_json';
    const n = Math.max(1, Math.min(4, Math.floor(body?.n ?? 1)));

    log.info(
      { mock: true, n, responseFormat, promptLen: prompt.length },
      'Mock image-gen invoked',
    );

    const dataEntry =
      responseFormat === 'b64_json'
        ? { b64_json: PNG_1x1_TRANSPARENT_B64, revised_prompt: prompt }
        : {
            // base64 → data URI is acceptable for a mock url (clients can fetch or decode)
            url: `data:image/png;base64,${PNG_1x1_TRANSPARENT_B64}`,
            revised_prompt: prompt,
          };

    const payload = {
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: n }, () => dataEntry),
    };
    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    log.error({ error: String(err) }, 'Mock image-gen failed');
    return NextResponse.json(
      { error: { message: 'mock image-gen failed', type: 'mock_error' } },
      { status: 500 },
    );
  }
}

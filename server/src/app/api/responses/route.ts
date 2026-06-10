import { NextRequest } from 'next/server';
import { handleResponsesBridge } from './bridge-handler';

/**
 * POST /api/responses  (external: /api/v1/responses)
 *
 * OpenAI-compatible Responses API endpoint — primarily for Codex (>= v0.133),
 * which speaks ONLY the Responses wire (release202/03 §1.3).
 *
 * Strategy (§3.1 方案 A): translate the Responses request into a Chat
 * Completions request, forward via the normal chat proxy (works for ALL our
 * curated models — kimi/gemini/deepseek), then synthesize a Codex-correct
 * Responses event stream from the chat response.
 *
 * This default route uses the platform-default provider chain. To pin a
 * specific chain (e.g. deepseek), Codex points its base_url at the per-provider
 * alias `/api/v1/proxy/<chain>/responses` (release202/07).
 *
 * Auth: sk-prismer-* API Key or JWT. Billing post-hoc via the chat proxy.
 */
export async function POST(request: NextRequest) {
  return handleResponsesBridge(request);
}

/** GET /api/models  (external: /api/v1/models)
 *
 * OpenAI-format model list. Returns only the curated stable model subset
 * (controlled via Nacos `CURATED_MODELS` env var).
 * Auth: sk-prismer-* API Key or JWT (tracked tier — auth only, no balance check).
 *
 * The returned list is a UI affordance and CLI default, NOT an enforcement gate.
 * The LLM proxy (llm-proxy.ts) is a transparent pipe and does not validate the
 * model field — if a client sends a non-curated model the proxy still forwards it.
 *
 * 2026-05-30 — `?provider=newapi|deepseek` 把 model list 按 hermes profile 的
 * proxyProvider 漏斗返回. 用于 ModelPicker 在用户切 proxyProvider 时立即重新拉
 * 对的 list (proxyProvider × model 紧耦合). query 缺失或 invalid 走原 env-driven
 * 路径 (backwards-compat for CLI / legacy callers).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiGuard } from '@/lib/api-guard';
import { getCuratedModels, type CuratedProvider } from './curated-models';

const VALID_PROVIDERS: readonly CuratedProvider[] = ['newapi', 'deepseek'] as const;

function parseProviderParam(raw: string | null): CuratedProvider | undefined {
  if (!raw) return undefined;
  return (VALID_PROVIDERS as readonly string[]).includes(raw) ? (raw as CuratedProvider) : undefined;
}

export async function GET(request: NextRequest) {
  const guard = await apiGuard(request, { tier: 'tracked' });
  if (!guard.ok) return guard.response;

  // `provider` 是 optional —— 缺失或 unknown 值 fallthrough 到 env-driven 默认 list.
  // 显式 'newapi' / 'deepseek' 绕开 env 直接拿对应漏斗 (绑定 hermes profile 的
  // proxyProvider 配置). 没 422 —— UI 层 ProxyProvider type 已经收窄, 服务端
  // 容忍未知值是为了允许 CLI 不带 query 继续工作.
  const provider = parseProviderParam(request.nextUrl.searchParams.get('provider'));
  const models = getCuratedModels(provider);
  const data = models.map((m) => ({
    id: m.id,
    object: 'model' as const,
    owned_by: m.provider,
  }));

  return NextResponse.json({ object: 'list', data });
}

/**
 * 2026-05-30 — proxyProvider × model 紧耦合 helper.
 * 2026-06-06 (release202/12 C1+C3) — chain-aware. release202/07 made provider
 * chains UNBOUNDED (any operator-configured chain id), but this helper used to
 * carry a 2-key hardcoded map and returned `undefined` for any custom chain →
 * the UI persisted `model: undefined` and the daemon ran a model the chain
 * doesn't serve. Now the helper accepts the fetched chain list (each chain
 * carries `primaryDefaultModel` from `GET /api/provider-chains`) and resolves
 * ANY chain's real default, with a stable last-ditch fallback.
 *
 * 用户在 new-agent / Simple wizard / Pro wizard 切 proxyProvider 时, model 字段
 * 必须立即 reset 到该 provider 漏斗里的默认值, 否则 hermes 会拿着 NewAPI 的
 * `us-kimi-k2.6` 走 deepseek 漏斗 → `/api/v1/proxy/deepseek/chat/completions`
 * 接到的 model 不被 DeepSeek 服务 → 旧 llm-proxy.ts silent override 把 UI 显示的
 * model 跟实际跑的 model 完全脱节.
 *
 * 默认值单源 (C3): 内置 newapi/deepseek 漏斗的 default model id 从
 * `src/lib/llm/provider-sources.ts` 的 `NEWAPI_DEFAULT_MODEL` /
 * `DEEPSEEK_DEFAULT_MODEL` 取 (那也是 BUILTIN_SOURCES[].defaultModel 与
 * curated-models 漏斗锚点的同一份真相)。
 */

import { NEWAPI_DEFAULT_MODEL, DEEPSEEK_DEFAULT_MODEL } from '@/lib/llm/provider-sources';
import type { ProxyProvider } from '../components/proxy-provider-select';

/** Shape carried by each entry of `GET /api/provider-chains`. */
export interface ProviderChainDefault {
  id: string;
  primaryDefaultModel?: string | null;
}

/** Built-in funnel defaults — the env-absent / chains-not-yet-fetched path. */
const BUILTIN_DEFAULTS: Readonly<Record<string, string>> = {
  newapi: NEWAPI_DEFAULT_MODEL,
  default: NEWAPI_DEFAULT_MODEL,
  deepseek: DEEPSEEK_DEFAULT_MODEL,
};

/**
 * Final last-ditch fallback when neither the fetched chain list nor the
 * built-in map knows the provider (e.g. a custom chain whose list hasn't
 * loaded yet). NEVER returns undefined — callers persist this into
 * AgentProfile.config.model, so an undefined would corrupt the funnel.
 */
const ULTIMATE_FALLBACK = NEWAPI_DEFAULT_MODEL;

/**
 * Resolve the default model for a proxy provider / chain id.
 *
 * Resolution order:
 *   1. The fetched chain list (`chains`) — match by id, use `primaryDefaultModel`.
 *      This is the ONLY path that knows a custom chain's real default.
 *   2. The built-in 2-key map (`newapi`/`default`/`deepseek`).
 *   3. {@link ULTIMATE_FALLBACK} — guarantees a non-undefined string.
 *
 * `chains` is optional so existing synchronous callers (e.g. the Pro tiles,
 * which seed `model` from `getDefaultModelForProvider('newapi')` before any
 * fetch) keep their behaviour for the built-in chains. Pass the fetched list
 * once it's available to make custom chains resolve correctly.
 */
export function getDefaultModelForProvider(
  provider: ProxyProvider,
  chains?: readonly ProviderChainDefault[],
): string {
  if (chains) {
    const hit = chains.find((c) => c.id === provider);
    if (hit?.primaryDefaultModel) return hit.primaryDefaultModel;
  }
  return BUILTIN_DEFAULTS[provider] ?? ULTIMATE_FALLBACK;
}

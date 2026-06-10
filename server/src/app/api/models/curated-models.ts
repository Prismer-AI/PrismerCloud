/**
 * Curated model list — the stable subset of upstream NewAPI models offered to
 * Prismer Cloud users. Only models in this list appear in the UI model picker
 * and the CLI `prismer profile create --model` prompt.
 *
 * Overridable via Nacos env var `CURATED_MODELS` (JSON array), same lazy-init
 * pattern as `LLM_MODEL_PRICING` in llm-pricing.ts. When the env var is absent
 * or unparseable the hardcoded DEFAULT list is used.
 *
 * 2026-05-30 — `getCuratedModels(provider?)` 接受 explicit provider 参数.
 * 当 caller 知道 hermes profile 的 proxyProvider 是 `'newapi'` / `'deepseek'`
 * 时,直接返回对应漏斗,绕开 `DEEPSEEK_BYPASS_ENABLED` env. `provider === undefined`
 * 保留原 env-driven 行为做 backwards-compat. 这样 UI 切 proxyProvider 时拉到
 * 的 model list 立即按 provider 漏斗而不是 env 漏斗 —— proxyProvider × model
 * 紧耦合的服务端入口.
 */

export interface CuratedModel {
  /** Model id sent in LLM API calls (the `model` field). */
  id: string;
  /** Human-readable label for UI dropdowns. */
  name: string;
  /** Upstream provider slug for the OpenAI-format `owned_by` field. */
  provider: string;
  /**
   * release201/26 §13.4a — authoritative per-model vision signal, set from REAL
   * cloud-proxy probes (2026-05-30). Round 1: solid-green PNG (sanity). Round 2
   * (STRONG, authoritative): a real Apple Music screenshot + open-ended prompt —
   * probe `scripts/spike/model-vision-probe-screenshot.ts`. A `true` model named
   * concrete on-screen content (Apple Music, artists, now-playing) it could not
   * have guessed blind — proving genuine visual reasoning, not a lucky color.
   *
   * `true`  — verified vision-capable (HTTP 200, described the screenshot).
   * `false` — verified text-only (e.g. DeepSeek V4 400s on `image_url` parts).
   * `undefined` — not yet measured / inconclusive (treat conservatively).
   *
   * This is the cloud-side source of truth for vision capability. The hermes
   * daemon adapter keeps an INDEPENDENT copy (`VISION_CAPABLE_MODELS` in
   * sdk/.../adapters/hermes/index.ts) because runtime/ can't import src/ — keep
   * the two in sync when a model's vision flag changes.
   */
  vision?: boolean;
}

/**
 * `provider` 参数对齐 `ForceProvider` (`src/lib/llm-proxy.ts`) 和
 * `ProxyProvider` (`src/app/workspace/components/proxy-provider-select.tsx`).
 * 类型独立 export 避免主代码 cross-import llm-proxy 路径.
 */
export type CuratedProvider = 'newapi' | 'deepseek';

// release202/12 C3 — the per-funnel default model id is single-sourced from the
// provider-source registry so this curated list's anchor entry and the source's
// `defaultModel` can't drift.
import { NEWAPI_DEFAULT_MODEL, DEEPSEEK_DEFAULT_MODEL } from '@/lib/llm/provider-sources';

const DEFAULT_CURATED_MODELS: CuratedModel[] = [
  // vision flags verified 2026-05-30 — strong test: all three described a real
  // Apple Music screenshot in detail (open-ended prompt, 2 runs each, no halluc).
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', provider: 'google', vision: true },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', provider: 'google', vision: true },
  // NEWAPI_DEFAULT_MODEL — the newapi funnel default (matches provider-sources).
  { id: NEWAPI_DEFAULT_MODEL, name: 'Kimi K2.6', provider: 'moonshot', vision: true },
];

/**
 * 2026-05-29 — Mirrors the DEEPSEEK_BYPASS_ENABLED flag in llm-proxy.ts.
 * When the bypass is on the model list returned here must match what
 * `/v1/chat/completions` actually routes to, otherwise the UI picker
 * suggests models the upstream (DeepSeek) doesn't serve and every call
 * gets force-overridden to DEEPSEEK_MODEL anyway. Verified against the
 * live `GET https://api.deepseek.com/v1/models` response: exactly two
 * entries, `deepseek-v4-flash` (reasoning-light) and `deepseek-v4-pro`
 * (reasoning-heavy). If DeepSeek publishes more, update here.
 */
const DEEPSEEK_BYPASS_MODELS: CuratedModel[] = [
  // vision:false verified 2026-05-30 — DeepSeek's API 400s on `image_url` parts
  // ("unknown variant `image_url`, expected `text`"); text-only requests work.
  // First entry == DEEPSEEK_DEFAULT_MODEL (single-sourced from provider-sources).
  { id: DEEPSEEK_DEFAULT_MODEL, name: 'DeepSeek V4 Flash', provider: 'deepseek', vision: false },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', vision: false },
];

/**
 * Per-provider caches. `'env-default'` key serves the legacy env-driven path
 * (used by callers that don't pass `provider`). `'newapi'` / `'deepseek'`
 * cache the explicit 漏斗 results so repeated picker re-fetches don't re-parse
 * the env JSON. `_resetCuratedModelsCache()` clears all three.
 */
const _cache = new Map<CuratedProvider | 'env-default', CuratedModel[]>();

function parseCuratedModels(raw: string): CuratedModel[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.provider !== 'string') {
        return null;
      }
    }
    return parsed as CuratedModel[];
  } catch {
    return null;
  }
}

export function getCuratedModels(provider?: CuratedProvider): CuratedModel[] {
  // Explicit provider override — proxyProvider × model 紧耦合的核心路径.
  // 绕过 env (CURATED_MODELS / DEEPSEEK_BYPASS_ENABLED), 直接返回对应漏斗.
  if (provider === 'newapi') {
    const cached = _cache.get('newapi');
    if (cached) return cached;
    _cache.set('newapi', DEFAULT_CURATED_MODELS);
    return DEFAULT_CURATED_MODELS;
  }
  if (provider === 'deepseek') {
    const cached = _cache.get('deepseek');
    if (cached) return cached;
    _cache.set('deepseek', DEEPSEEK_BYPASS_MODELS);
    return DEEPSEEK_BYPASS_MODELS;
  }

  // Backwards-compat path: no explicit provider → env override > bypass flag > default.
  const cached = _cache.get('env-default');
  if (cached) return cached;
  const raw = process.env.CURATED_MODELS;
  if (raw) {
    const parsed = parseCuratedModels(raw);
    if (parsed) {
      _cache.set('env-default', parsed);
      return parsed;
    }
  }
  // 2026-05-29 — when llm-proxy is in DeepSeek bypass mode, the curated
  // list must mirror upstream or the picker lies. Explicit env override
  // (CURATED_MODELS above) still wins so operators can pin custom lists.
  if (process.env.DEEPSEEK_BYPASS_ENABLED === 'true') {
    _cache.set('env-default', DEEPSEEK_BYPASS_MODELS);
    return DEEPSEEK_BYPASS_MODELS;
  }
  _cache.set('env-default', DEFAULT_CURATED_MODELS);
  return DEFAULT_CURATED_MODELS;
}

/**
 * Reset the cache — only exported for testing. With no argument clears every
 * bucket; pass `'newapi'` / `'deepseek'` / `'env-default'` to clear a single
 * bucket (rarely useful — kept for symmetry with the Map API).
 */
export function _resetCuratedModelsCache(bucket?: CuratedProvider | 'env-default'): void {
  if (bucket) {
    _cache.delete(bucket);
    return;
  }
  _cache.clear();
}

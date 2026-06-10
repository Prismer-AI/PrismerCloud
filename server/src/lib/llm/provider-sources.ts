/**
 * Provider Source Registry + Fallback Chains  (release202/07)
 *
 * Replaces the hardcoded `ForceProvider = 'newapi' | 'deepseek'` enum with a
 * config-driven, UNBOUNDED registry of upstream "sources" plus named, ordered
 * "chains" (source1 → source2 → source3 → …). The proxy executor
 * (`llm-proxy.ts`) walks a chain, trying each source in order and falling
 * through to the next on a retriable failure (§3 of doc 07).
 *
 * Config (Nacos / env, lazy-init + process-cache — same pattern as
 * `curated-models.ts`):
 *   - `LLM_PROVIDER_SOURCES`  JSON array of ProviderSource (UNBOUNDED count)
 *   - `LLM_PROVIDER_CHAINS`   JSON object { chainId: sourceId[] } (UNBOUNDED)
 *
 * When either env is absent/unparseable the BUILT-IN defaults are used, which
 * are behaviourally equivalent to the pre-07 world (newapi per-user + deepseek
 * static) so there is zero drift for existing deployments.
 *
 * Layer note: this lives in `src/lib` and must NOT import `src/app/...`
 * (eslint layer rule). The request-model vision lookup therefore keeps its OWN
 * copy of the vision-capable model ids — mirror of `curated-models.ts`'s
 * `vision` flags and the hermes adapter's `VISION_CAPABLE_MODELS`. Keep the
 * three in sync when a model's vision capability changes.
 */

export interface ProviderSource {
  /** Stable id referenced by chains. */
  id: string;
  /**
   * Upstream base URL. May be a literal (`https://api.deepseek.com`) or a
   * single `$ENV_VAR` reference (expanded against process.env at resolve time
   * so operators never inline a base in two places). Trailing slash trimmed.
   */
  baseUrl: string;
  /**
   * `per-user` → resolve the newapi admin/user token via
   * `resolveNewAPIToken(userId)` (the platform-aggregator path).
   * `static`   → use the key in `process.env[apiKeyEnv]` (direct-connect, e.g.
   *              DeepSeek / OpenRouter).
   */
  tokenMode: 'per-user' | 'static';
  /** Env var holding the bearer key — required when tokenMode === 'static'. */
  apiKeyEnv?: string;
  /**
   * Model substituted when the incoming request's model is not served by this
   * source (decision 3 — every source declares its own default). May be a
   * `$ENV_VAR` reference.
   */
  defaultModel?: string;
  /** Whether this source's defaultModel is vision-capable (decision 1). */
  vision?: boolean;
  /** Optional remap: incoming model id → this source's equivalent id. */
  modelMap?: Record<string, string>;
  /**
   * Optional safety net: if the incoming model id does NOT start with this
   * prefix (case-insensitive), this source can't serve it, so substitute
   * `defaultModel` even on the primary attempt. Preserves the pre-07 DeepSeek
   * passthrough contract (a stray `us-kimi-k2.6` sent to the deepseek source
   * gets coerced to `deepseek-v4-flash` + warn) without a per-source catalog.
   */
  modelGuardPrefix?: string;
}

/** Resolved chain entry — a ProviderSource with all `$ENV` refs expanded. */
export interface ResolvedSource extends ProviderSource {
  baseUrl: string;
  defaultModel?: string;
}

// ── Built-in defaults (env-absent path ≡ pre-07 behaviour) ──────────────────

/**
 * release202/12 C3 — single source of truth for the built-in funnels' default
 * model ids (within `src/app` + `src/lib`). `curated-models.ts` references
 * these so the picker's first entry and the source's `defaultModel` can't
 * drift. The `sdk/.../adapters/hermes` copy is structurally unmergeable
 * (runtime can't import src/) — a CI parity test cross-checks it instead.
 */
export const NEWAPI_DEFAULT_MODEL = 'us-kimi-k2.6';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

const BUILTIN_SOURCES: readonly ProviderSource[] = [
  {
    id: 'newapi',
    baseUrl: '$NEWAPI_BASE_URL',
    tokenMode: 'per-user',
    defaultModel: NEWAPI_DEFAULT_MODEL,
    vision: true,
  },
  {
    id: 'deepseek',
    baseUrl: '$DEEPSEEK_BASE_URL',
    tokenMode: 'static',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: '$DEEPSEEK_MODEL',
    vision: false,
    modelGuardPrefix: 'deepseek',
  },
];

/**
 * Built-in chains. `default` is newapi-only (no auto-fallback) so existing
 * deployments behave exactly as before — operators opt INTO multi-source
 * fallback by configuring `LLM_PROVIDER_CHAINS`. The single-element `newapi` /
 * `deepseek` chains preserve backward-compat for profiles whose stored
 * `proxyProvider` is still the old enum value.
 */
const BUILTIN_CHAINS: Readonly<Record<string, readonly string[]>> = {
  default: ['newapi'],
  newapi: ['newapi'],
  deepseek: ['deepseek'],
};

/** Fallback base for the built-in deepseek source when DEEPSEEK_BASE_URL unset. */
const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';

// ── Vision-capable model ids (src/lib copy — see layer note) ────────────────

const BUILTIN_VISION_MODELS: readonly string[] = [
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-preview',
  'us-kimi-k2.6',
];

// ── Caches (cleared together by _resetProviderConfigCache) ──────────────────

let _sourcesCache: Map<string, ProviderSource> | null = null;
let _chainsCache: Record<string, string[]> | null = null;
let _visionCache: Set<string> | null = null;

function parseSources(raw: string | undefined): ProviderSource[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    for (const s of parsed) {
      if (typeof s?.id !== 'string' || typeof s?.baseUrl !== 'string') return null;
      if (s.tokenMode !== 'per-user' && s.tokenMode !== 'static') return null;
      if (s.tokenMode === 'static' && typeof s.apiKeyEnv !== 'string') return null;
    }
    return parsed as ProviderSource[];
  } catch {
    return null;
  }
}

function parseChains(raw: string | undefined): Record<string, string[]> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    for (const v of Object.values(parsed)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
    }
    return parsed as Record<string, string[]>;
  } catch {
    return null;
  }
}

/** Source registry keyed by id. env `LLM_PROVIDER_SOURCES` > built-ins. */
function getSourceMap(): Map<string, ProviderSource> {
  if (_sourcesCache) return _sourcesCache;
  const list = parseSources(process.env.LLM_PROVIDER_SOURCES) ?? [...BUILTIN_SOURCES];
  // Built-ins are always present as a safety net even when operators supply a
  // custom list (so `default`/`newapi`/`deepseek` chains never dangle); custom
  // entries with the same id win.
  const map = new Map<string, ProviderSource>();
  for (const s of BUILTIN_SOURCES) map.set(s.id, s);
  for (const s of list) map.set(s.id, s);
  _sourcesCache = map;
  return map;
}

/** Chain registry. env `LLM_PROVIDER_CHAINS` merged over built-ins. */
function getChainMap(): Record<string, string[]> {
  if (_chainsCache) return _chainsCache;
  const custom = parseChains(process.env.LLM_PROVIDER_CHAINS) ?? {};
  const merged: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(BUILTIN_CHAINS)) merged[k] = [...v];
  for (const [k, v] of Object.entries(custom)) merged[k] = v;
  _chainsCache = merged;
  return merged;
}

function getVisionModels(): Set<string> {
  if (_visionCache) return _visionCache;
  let ids: string[] = [...BUILTIN_VISION_MODELS];
  const raw = process.env.LLM_VISION_MODELS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) ids = parsed;
    } catch {
      /* keep built-ins */
    }
  }
  _visionCache = new Set(ids);
  return _visionCache;
}

/** Expand a single `$ENV_VAR` reference; literals pass through. */
function expandEnvRef(value: string | undefined, fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (value.startsWith('$')) {
    const resolved = process.env[value.slice(1)];
    return (resolved && resolved.length > 0 ? resolved : fallback);
  }
  return value;
}

function resolveSource(s: ProviderSource): ResolvedSource {
  // Built-in deepseek carries env-default fallbacks (parity with the pre-07
  // getDeepSeekBypassConfig defaults). Other sources expand refs verbatim.
  const baseFallback = s.id === 'deepseek' ? DEEPSEEK_DEFAULT_BASE : undefined;
  const modelFallback = s.id === 'deepseek' ? DEEPSEEK_DEFAULT_MODEL : undefined;
  const baseUrl = (expandEnvRef(s.baseUrl, baseFallback) ?? '').replace(/\/+$/, '');
  const defaultModel = expandEnvRef(s.defaultModel, modelFallback);
  return { ...s, baseUrl, defaultModel };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** All registered sources (resolved), in registry order. */
export function getProviderSources(): ResolvedSource[] {
  return [...getSourceMap().values()].map(resolveSource);
}

/** Chain ids available for UI selection. */
export function getProviderChainIds(): string[] {
  return Object.keys(getChainMap());
}

/**
 * Resolve a chain id (or a bare source id) to an ordered list of resolved
 * sources. Unknown ids fall back to `default`. A bare source id that isn't a
 * named chain but IS a registered source resolves to a single-element chain
 * (so legacy `proxyProvider: 'deepseek'` keeps working even if no `deepseek`
 * chain is declared). Sources referenced by a chain but missing from the
 * registry are skipped (logged by the caller).
 */
export function resolveChain(chainId: string | undefined): ResolvedSource[] {
  const chains = getChainMap();
  const sources = getSourceMap();
  let ids: string[] | undefined = chainId ? chains[chainId] : undefined;
  if (!ids && chainId && sources.has(chainId)) ids = [chainId];
  if (!ids) ids = chains.default ?? ['newapi'];
  return ids.filter((id) => sources.has(id)).map((id) => resolveSource(sources.get(id)!));
}

/** Decision 1 — is the (initially requested) model vision-capable? */
export function isVisionModel(model: unknown): boolean {
  return typeof model === 'string' && getVisionModels().has(model);
}

/**
 * Apply the vision constraint to a resolved chain (decision 1): the first
 * source (the user's explicit pick) always runs; subsequent FALLBACK sources
 * are dropped if they can't serve vision when the initial model needs it.
 */
export function applyVisionFilter(chain: ResolvedSource[], requestModel: unknown): ResolvedSource[] {
  if (!isVisionModel(requestModel)) return chain;
  return chain.filter((s, i) => i === 0 || s.vision === true);
}

/** Test-only: clear all caches. */
export function _resetProviderConfigCache(): void {
  _sourcesCache = null;
  _chainsCache = null;
  _visionCache = null;
}

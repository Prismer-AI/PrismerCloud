/**
 * Curated model list — the stable subset of upstream NewAPI models offered to
 * Prismer Cloud users. Only models in this list appear in the UI model picker
 * and the CLI `prismer profile create --model` prompt.
 *
 * Overridable via Nacos env var `CURATED_MODELS` (JSON array), same lazy-init
 * pattern as `LLM_MODEL_PRICING` in llm-pricing.ts. When the env var is absent
 * or unparseable the hardcoded DEFAULT list is used.
 */

export interface CuratedModel {
  /** Model id sent in LLM API calls (the `model` field). */
  id: string;
  /** Human-readable label for UI dropdowns. */
  name: string;
  /** Upstream provider slug for the OpenAI-format `owned_by` field. */
  provider: string;
}

const DEFAULT_CURATED_MODELS: CuratedModel[] = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', provider: 'google' },
  { id: 'us-kimi-k2.6', name: 'Kimi K2.6', provider: 'moonshot' },
];

let _cached: CuratedModel[] | null = null;

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

export function getCuratedModels(): CuratedModel[] {
  if (_cached) return _cached;
  const raw = process.env.CURATED_MODELS;
  if (raw) {
    const parsed = parseCuratedModels(raw);
    if (parsed) {
      _cached = parsed;
      return parsed;
    }
  }
  _cached = DEFAULT_CURATED_MODELS;
  return _cached;
}

/**
 * Reset the cache — only exported for testing.
 */
export function _resetCuratedModelsCache(): void {
  _cached = null;
}

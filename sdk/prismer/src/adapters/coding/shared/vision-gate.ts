// WS-B (PP-1) — vision capability gate for the CodeAgentDriver image-input path.
//
// The driver only forwards `{type:'image'}` content blocks to a provider when
// the TARGET model is vision-capable. A non-vision model (e.g. deepseek-chat)
// rejects image parts at the wire level (HTTP 400 "image_url … expected text"),
// so for those we must KEEP the asset as the daemon's as-file/reference text
// block (already inlined into `task.prompt` by composePrompt) and NOT send pixels.
//
// LAYER RULE: runtime/ cannot import src/. This mirrors the vision allowlist in
// `src/lib/llm/provider-sources.ts` (BUILTIN_VISION_MODELS) and the hermes
// adapter's `VISION_CAPABLE_MODELS`. KEEP IN SYNC — when a model's vision flag
// changes there, update this set too. `PRISMER_VISION_MODELS` (comma-separated)
// overrides the built-in list for Nacos/deploy parity without a code change.

const BUILTIN_VISION_MODELS: readonly string[] = [
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "us-kimi-k2.6",
];

let _cache: Set<string> | null = null;

function visionModelSet(): Set<string> {
  if (_cache) return _cache;
  const raw = process.env.PRISMER_VISION_MODELS;
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [...BUILTIN_VISION_MODELS];
  _cache = new Set(list);
  return _cache;
}

/**
 * Whether the given model id is vision-capable. Conservative: unknown / missing
 * model → false (degrade to as-file). Matches the cloud `isVisionModel` SoT.
 */
export function isVisionCapableModel(model: string | undefined): boolean {
  if (!model) return false;
  return visionModelSet().has(model);
}

/** Test-only: reset the memoized set (e.g. after mutating PRISMER_VISION_MODELS). */
export function _resetVisionModelCache(): void {
  _cache = null;
}

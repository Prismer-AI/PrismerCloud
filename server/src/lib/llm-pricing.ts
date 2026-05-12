/**
 * LLM Proxy Pricing — cost-plus model
 *
 * Calculates credits to charge for an LLM proxy call based on:
 *   upstream_cost = (prompt_tokens/1K * input_rate) + (completion_tokens/1K * output_rate)
 *   sell_price    = upstream_cost * (1 + MARGIN_RATE)
 *   credits       = sell_price / CREDIT_VALUE
 *
 * Model pricing table has built-in defaults and can be overridden via
 * Nacos env var LLM_MODEL_PRICING (JSON).
 */

// ============================================================================
// Types
// ============================================================================

export interface ModelPrice {
  /** USD per 1K input tokens */
  input: number;
  /** USD per 1K output tokens */
  output: number;
}

export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface LLMCostBreakdown {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  upstreamCostUsd: number;
  marginRate: number;
  sellPriceUsd: number;
  credits: number;
}

// ============================================================================
// Built-in model pricing (USD per 1K tokens, as of 2026-04)
// ============================================================================

const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
  o3: { input: 0.01, output: 0.04 },
  'o3-mini': { input: 0.0011, output: 0.0044 },
  'o4-mini': { input: 0.0011, output: 0.0044 },

  // Anthropic
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-3.5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3.5-haiku': { input: 0.0008, output: 0.004 },
  'claude-3-opus': { input: 0.015, output: 0.075 },

  // Google
  'gemini-3.1-pro-preview': { input: 0.00125, output: 0.01 },
  'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
  'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },

  // Moonshot / Kimi
  'us-kimi-k2.6': { input: 0.00014, output: 0.00028 },

  // DeepSeek
  'deepseek-chat': { input: 0.00014, output: 0.00028 },
  'deepseek-reasoner': { input: 0.00055, output: 0.0022 },

  // Qwen
  'qwen-max': { input: 0.0016, output: 0.0064 },
  'qwen-plus': { input: 0.0004, output: 0.0012 },
  'qwen-turbo': { input: 0.00005, output: 0.0002 },
};

// ============================================================================
// Dynamic config (Nacos overridable)
// ============================================================================

const CREDIT_VALUE_USD = 0.002; // 1 credit = $0.002
const CACHE_DISCOUNT_RATE = 0.5; // cached prompt tokens are 50% cheaper

function getMarginRate(): number {
  return parseFloat(process.env.LLM_PROXY_MARGIN_RATE || '') || 0.5;
}

function getDefaultInputRate(): number {
  return parseFloat(process.env.LLM_DEFAULT_INPUT_RATE || '') || 0.00015;
}

function getDefaultOutputRate(): number {
  return parseFloat(process.env.LLM_DEFAULT_OUTPUT_RATE || '') || 0.0006;
}

let _nacosOverrides: Record<string, ModelPrice> | null = null;

function loadNacosOverrides(): Record<string, ModelPrice> {
  if (_nacosOverrides !== null) return _nacosOverrides;
  const raw = process.env.LLM_MODEL_PRICING;
  if (!raw) {
    _nacosOverrides = {};
    return _nacosOverrides;
  }
  try {
    _nacosOverrides = JSON.parse(raw);
  } catch {
    console.warn('[LLMPricing] Failed to parse LLM_MODEL_PRICING, using defaults');
    _nacosOverrides = {};
  }
  return _nacosOverrides!;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Look up pricing for a model. Tries exact match, then prefix match, then default.
 */
export function getModelPricing(model: string): ModelPrice {
  const overrides = loadNacosOverrides();

  // Exact match in overrides
  if (overrides[model]) return overrides[model];
  // Exact match in defaults
  if (DEFAULT_MODEL_PRICING[model]) return DEFAULT_MODEL_PRICING[model];

  // Prefix match: "gpt-4o-2024-08-06" → "gpt-4o"
  for (const [key, price] of Object.entries({ ...DEFAULT_MODEL_PRICING, ...overrides })) {
    if (model.startsWith(key)) return price;
  }

  return { input: getDefaultInputRate(), output: getDefaultOutputRate() };
}

/**
 * Calculate the credits to charge for an LLM call.
 */
export function calculateLLMCredits(model: string, usage: LLMUsage): LLMCostBreakdown {
  const pricing = getModelPricing(model);
  const marginRate = getMarginRate();

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;

  const promptCostUsd = (promptTokens / 1000) * pricing.input;
  const completionCostUsd = (completionTokens / 1000) * pricing.output;
  const cacheDiscountUsd = (cachedTokens / 1000) * pricing.input * CACHE_DISCOUNT_RATE;

  const upstreamCostUsd = promptCostUsd + completionCostUsd - cacheDiscountUsd;
  const sellPriceUsd = upstreamCostUsd * (1 + marginRate);
  const credits = Math.round((sellPriceUsd / CREDIT_VALUE_USD) * 10000) / 10000;

  return {
    model,
    promptTokens,
    completionTokens,
    cachedTokens,
    upstreamCostUsd: Math.round(upstreamCostUsd * 1_000_000) / 1_000_000,
    marginRate,
    sellPriceUsd: Math.round(sellPriceUsd * 1_000_000) / 1_000_000,
    credits: Math.max(0, credits),
  };
}

/**
 * Estimate the maximum possible cost for a request (used for balance pre-check).
 * Assumes max_tokens will be fully used for output.
 */
export function estimateLLMCost(model: string, estimatedInputTokens: number, maxOutputTokens: number): number {
  const pricing = getModelPricing(model);
  const marginRate = getMarginRate();

  const costUsd = (estimatedInputTokens / 1000) * pricing.input + (maxOutputTokens / 1000) * pricing.output;

  return Math.round(((costUsd * (1 + marginRate)) / CREDIT_VALUE_USD) * 10000) / 10000;
}

/**
 * Reset the Nacos override cache (for testing or config reload).
 */
export function resetPricingCache(): void {
  _nacosOverrides = null;
}

/**
 * Extract Anthropic-format usage from a parsed Messages API response.
 *
 * Anthropic returns { usage: { input_tokens, output_tokens } }; we map to
 * the OpenAI-shaped LLMUsage so calculateLLMCredits() can price it uniformly.
 */
export function extractAnthropicUsage(parsed: unknown): LLMUsage | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const u = (parsed as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: u.input_tokens + u.output_tokens,
  };
}

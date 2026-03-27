/**
 * Ranking Module - Preset Configurations
 * 
 * 预设排序策略
 */

import { RankingWeights, RankingPreset } from './types';

/**
 * 预设配置表
 */
export const RANKING_PRESETS: Record<RankingPreset, RankingWeights> = {
  /**
   * 缓存优先模式 (默认)
   * 
   * 优先返回已缓存的内容，快速响应，节省成本
   * 适用于: 对响应速度和成本敏感的场景
   */
  cache_first: {
    cacheHit: 0.50,     // 缓存命中强加权
    relevance: 0.30,    // 相关性次之
    freshness: 0.10,    // 新鲜度较低
    quality: 0.10       // 质量较低
  },

  /**
   * 相关性优先模式
   * 
   * 优先返回最相关的结果，即使需要实时处理
   * 适用于: 对结果质量要求高的场景
   */
  relevance_first: {
    cacheHit: 0.10,     // 缓存权重很低
    relevance: 0.60,    // 相关性最高
    freshness: 0.20,    // 新鲜度次之
    quality: 0.10       // 质量较低
  },

  /**
   * 平衡模式
   * 
   * 综合考虑各维度，平衡速度、质量和成本
   * 适用于: 通用场景
   */
  balanced: {
    cacheHit: 0.25,
    relevance: 0.35,
    freshness: 0.25,
    quality: 0.15
  }
};

/**
 * 获取预设权重
 */
export function getPresetWeights(preset: RankingPreset): RankingWeights {
  return RANKING_PRESETS[preset] || RANKING_PRESETS.cache_first;
}

/**
 * 合并自定义权重与预设
 */
export function mergeWeights(
  preset: RankingPreset,
  custom?: Partial<RankingWeights>
): RankingWeights {
  const base = getPresetWeights(preset);
  if (!custom) return base;
  
  return {
    cacheHit: custom.cacheHit ?? base.cacheHit,
    relevance: custom.relevance ?? base.relevance,
    freshness: custom.freshness ?? base.freshness,
    quality: custom.quality ?? base.quality
  };
}

/**
 * 验证权重配置
 * 权重总和应该接近 1.0
 */
export function validateWeights(weights: RankingWeights): { valid: boolean; error?: string } {
  const sum = weights.cacheHit + weights.relevance + weights.freshness + weights.quality;
  
  if (sum < 0.9 || sum > 1.1) {
    return { 
      valid: false, 
      error: `Weights should sum to approximately 1.0, got ${sum.toFixed(2)}` 
    };
  }
  
  for (const [key, value] of Object.entries(weights)) {
    if (value < 0 || value > 1) {
      return { 
        valid: false, 
        error: `Weight ${key} must be between 0 and 1, got ${value}` 
      };
    }
  }
  
  return { valid: true };
}








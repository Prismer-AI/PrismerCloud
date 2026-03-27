/**
 * Ranking Module - Main Entry
 * 
 * 可插拔排序模块
 * 
 * 使用示例:
 * ```typescript
 * import { createRanker, RankingConfig } from '@/lib/ranking';
 * 
 * const ranker = createRanker();
 * const config: RankingConfig = { preset: 'cache_first' };
 * const ranked = ranker.rank(items, config);
 * ```
 */

// Types
export type {
  RankableItem,
  RankedItem,
  RankingFactors,
  RankingWeights,
  RankingPreset,
  RankingConfig,
  IRanker
} from './types';

// Presets
export {
  RANKING_PRESETS,
  getPresetWeights,
  mergeWeights,
  validateWeights
} from './presets';

// Default Implementation
export { DefaultRanker } from './default-ranker';

// Factory
import { DefaultRanker } from './default-ranker';
import { IRanker } from './types';

/**
 * 创建排序器实例
 * 
 * 默认使用 DefaultRanker，可扩展为其他实现
 */
export function createRanker(type: 'default' | 'personalized' = 'default'): IRanker {
  switch (type) {
    case 'default':
    default:
      return new DefaultRanker();
    // 未来可扩展:
    // case 'personalized':
    //   return new PersonalizedRanker(userPrefs);
  }
}

// Convenience export - 单例默认排序器
const defaultRanker = new DefaultRanker();
export { defaultRanker };








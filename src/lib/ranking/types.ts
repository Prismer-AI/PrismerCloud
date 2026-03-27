/**
 * Ranking Module - Type Definitions
 * 
 * 可插拔排序模块的类型定义
 */

/**
 * 可排序项接口 - 输入
 */
export interface RankableItem {
  url: string;
  title?: string;
  cached: boolean;
  cachedAt?: string;
  searchRank?: number;          // 搜索引擎返回的原始排名 (1-based)
  searchScore?: number;         // 搜索引擎返回的相关性分数
  publishedDate?: string;       // 发布日期
  content?: string;             // 内容 (用于质量评估)
  hqcc?: string;                // 压缩后内容
  meta?: Record<string, any>;   // 其他元数据
}

/**
 * 排序因子分数
 */
export interface RankingFactors {
  cache: number;      // 缓存命中加分
  relevance: number;  // 相关性分数
  freshness: number;  // 新鲜度分数
  quality: number;    // 内容质量分数
}

/**
 * 排序后的结果项
 */
export interface RankedItem extends RankableItem {
  rank: number;              // 最终排名 (1-based)
  score: number;             // 综合分数
  factors: RankingFactors;   // 各维度分数
}

/**
 * 排序权重配置
 */
export interface RankingWeights {
  cacheHit: number;    // 缓存命中权重 (0-1)
  relevance: number;   // 相关性权重 (0-1)
  freshness: number;   // 新鲜度权重 (0-1)
  quality: number;     // 质量权重 (0-1)
}

/**
 * 预设模式
 */
export type RankingPreset = 'cache_first' | 'relevance_first' | 'balanced';

/**
 * 排序配置
 */
export interface RankingConfig {
  preset?: RankingPreset;
  custom?: Partial<RankingWeights>;
}

/**
 * 排序器接口 - 可插拔设计
 */
export interface IRanker {
  /**
   * 对项目列表进行排序
   * @param items 待排序项
   * @param config 排序配置
   * @returns 排序后的结果
   */
  rank(items: RankableItem[], config?: RankingConfig): RankedItem[];
  
  /**
   * 获取当前使用的权重
   */
  getWeights(config?: RankingConfig): RankingWeights;
}








/**
 * Default Ranker Implementation
 * 
 * 默认排序器实现，支持缓存优先、相关性优先、平衡模式
 */

import {
  IRanker,
  RankableItem,
  RankedItem,
  RankingConfig,
  RankingWeights,
  RankingFactors
} from './types';
import { getPresetWeights, mergeWeights } from './presets';

export class DefaultRanker implements IRanker {
  /**
   * 对项目列表进行排序
   */
  rank(items: RankableItem[], config?: RankingConfig): RankedItem[] {
    if (!items || items.length === 0) {
      return [];
    }

    const weights = this.getWeights(config);

    // 计算每个项目的分数
    const scored = items.map((item, index) => {
      const factors = this.calculateFactors(item, weights, index, items.length);
      const score = this.calculateScore(factors);
      
      return {
        ...item,
        score,
        factors,
        rank: 0 // 临时值，排序后更新
      } as RankedItem;
    });

    // 按分数降序排序
    scored.sort((a, b) => b.score - a.score);

    // 更新排名
    scored.forEach((item, index) => {
      item.rank = index + 1;
    });

    return scored;
  }

  /**
   * 获取当前使用的权重
   */
  getWeights(config?: RankingConfig): RankingWeights {
    const preset = config?.preset || 'cache_first';
    return mergeWeights(preset, config?.custom);
  }

  /**
   * 计算各维度因子分数
   */
  private calculateFactors(
    item: RankableItem,
    weights: RankingWeights,
    originalIndex: number,
    totalItems: number
  ): RankingFactors {
    return {
      cache: this.calculateCacheScore(item, weights.cacheHit),
      relevance: this.calculateRelevanceScore(item, weights.relevance, originalIndex, totalItems),
      freshness: this.calculateFreshnessScore(item, weights.freshness),
      quality: this.calculateQualityScore(item, weights.quality)
    };
  }

  /**
   * 计算综合分数
   */
  private calculateScore(factors: RankingFactors): number {
    const score = factors.cache + factors.relevance + factors.freshness + factors.quality;
    return Math.round(score * 1000) / 1000; // 保留3位小数
  }

  /**
   * 计算缓存分数
   * 
   * 缓存命中 → 满分
   * 缓存未命中 → 0分
   */
  private calculateCacheScore(item: RankableItem, weight: number): number {
    return item.cached ? weight : 0;
  }

  /**
   * 计算相关性分数
   * 
   * 基于搜索引擎返回的排名或分数
   * 如果有 searchScore，直接使用
   * 否则基于 searchRank 计算
   */
  private calculateRelevanceScore(
    item: RankableItem,
    weight: number,
    originalIndex: number,
    totalItems: number
  ): number {
    // 优先使用搜索引擎的分数
    if (item.searchScore !== undefined && item.searchScore >= 0) {
      // 假设 searchScore 在 0-1 范围内
      const normalizedScore = Math.min(1, Math.max(0, item.searchScore));
      return normalizedScore * weight;
    }

    // 使用搜索排名
    if (item.searchRank !== undefined && item.searchRank > 0) {
      // 排名越靠前分数越高
      const normalizedRank = 1 - (item.searchRank - 1) / Math.max(totalItems, 1);
      return normalizedRank * weight;
    }

    // 使用原始数组位置作为 fallback
    const normalizedPosition = 1 - originalIndex / Math.max(totalItems, 1);
    return normalizedPosition * weight;
  }

  /**
   * 计算新鲜度分数
   * 
   * 基于发布日期或缓存时间
   */
  private calculateFreshnessScore(item: RankableItem, weight: number): number {
    const dateStr = item.publishedDate || item.cachedAt;
    
    if (!dateStr) {
      return weight * 0.5; // 无日期信息，给中等分数
    }

    try {
      const date = new Date(dateStr);
      const now = Date.now();
      const daysSincePublish = (now - date.getTime()) / (1000 * 60 * 60 * 24);

      // 新鲜度衰减曲线
      if (daysSincePublish < 7) {
        return weight * 1.0;    // 一周内：满分
      } else if (daysSincePublish < 30) {
        return weight * 0.8;    // 一个月内：80%
      } else if (daysSincePublish < 90) {
        return weight * 0.6;    // 三个月内：60%
      } else if (daysSincePublish < 365) {
        return weight * 0.4;    // 一年内：40%
      } else {
        return weight * 0.2;    // 超过一年：20%
      }
    } catch {
      return weight * 0.5; // 日期解析失败，给中等分数
    }
  }

  /**
   * 计算质量分数
   * 
   * 基于内容特征评估
   */
  private calculateQualityScore(item: RankableItem, weight: number): number {
    const content = item.hqcc || item.content;
    
    if (!content) {
      return weight * 0.5; // 无内容，给中等分数
    }

    let qualityScore = 0.5; // 基础分

    // 字数评估 (200-5000 字为最佳)
    const wordCount = content.split(/\s+/).length;
    if (wordCount >= 200 && wordCount <= 5000) {
      qualityScore += 0.15;
    } else if (wordCount < 50 || wordCount > 10000) {
      qualityScore -= 0.1;
    }

    // 结构化内容加分 (Markdown 标题)
    if (/^#{1,3}\s/m.test(content)) {
      qualityScore += 0.1;
    }

    // 代码块加分
    if (/```/.test(content)) {
      qualityScore += 0.1;
    }

    // 数据/表格特征加分
    if (/\d+%|\$[\d,]+|\d+\.\d+|Table \d+|Figure \d+/i.test(content)) {
      qualityScore += 0.1;
    }

    // 确保分数在 0-1 范围内
    qualityScore = Math.min(1, Math.max(0, qualityScore));

    return qualityScore * weight;
  }
}








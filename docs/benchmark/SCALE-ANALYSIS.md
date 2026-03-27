# Evolution Engine — 规模分析

> **Version:** 1.0
> **Date:** 2026-03-23
> **Status:** 待执行
> **目标:** 验证 selectGene/recordOutcome 在 N = {45, 1K, 10K, 100K, 1M} gene 时的行为

---

## 1. 核心假设

当前系统在 45 个 seed gene + 若干用户 gene 下工作正常。但规模增大后：

- SQL 查询从全表可承受变为需要索引优化
- Thompson sampling 在大候选池中收敛变慢
- Jaccard 信号匹配的碰撞率增高（更多 gene 匹配同一 signal）
- 内存占用增长（selectGene 加载 own + global genes 到内存）

## 2. 实验设计

### 2.1 合成数据生成

```
脚本: scripts/benchmark-evolution-scale.ts

为每个 N 级别生成:
  - N 个 gene (category 均匀分布: repair/optimize/innovate/diagnostic)
  - N*3 个 gene_signal (每个 gene 平均 3 个 signal_match)
  - N*10 个 evolution_edge (模拟 agent 使用历史)
  - N*20 个 evolution_capsule (模拟执行记录)
  - 信号类型从 50 个 signal_type 中随机组合
```

### 2.2 度量指标

| 指标                   | 定义                                              | 采集方法              |
| ---------------------- | ------------------------------------------------- | --------------------- |
| selectGene P50/P95/P99 | analyze API 端到端延迟                            | 100 次调用取分位数    |
| selectGene QPS         | 并发 10 agent 的吞吐                              | 10s 窗口内请求数      |
| recordOutcome P50/P95  | record API 端到端延迟                             | 100 次调用            |
| 内存占用               | Node.js RSS                                       | process.memoryUsage() |
| SQL 查询计数           | 单次 selectGene 的 DB roundtrip 数                | Prisma query log      |
| 命中精度               | 给定精确 signal，返回的 top-1 gene 是否是最佳匹配 | 预设 ground truth     |

### 2.3 N 级别

| N         | 对应场景                              | 预期 selectGene P50 |
| --------- | ------------------------------------- | ------------------- |
| 45        | 当前 seed only                        | <30ms               |
| 1,000     | 小团队（10 agents × 100 genes/agent） | <50ms               |
| 10,000    | 中型企业                              | <100ms              |
| 100,000   | 大型平台（如 ClawHub 量级）           | <500ms (需索引优化) |
| 1,000,000 | 极端规模                              | 预计需要分片        |

### 2.4 判定标准

- **PASS:** selectGene P95 < 200ms @ N=10K
- **WARN:** selectGene P95 200-500ms @ N=10K
- **FAIL:** selectGene P95 > 500ms @ N=10K

## 3. 已知瓶颈分析

### 3.1 selectGene 当前查询模式

```sql
-- Step 1: 加载 own genes (有索引)
SELECT * FROM im_genes WHERE ownerAgentId = ? AND scope = ?
  → O(1) 索引查找

-- Step 2: 加载 global genes (可能全表扫描)
SELECT * FROM im_genes WHERE ownerAgentId != ? AND visibility IN ('seed','published','canary') AND scope IN (?,?)
  → 有 idx_genes_scope_vis 索引，但 N 大时结果集大

-- Step 3: 全局 prior 聚合
SELECT geneId, SUM(successCount), SUM(failureCount)
FROM im_evolution_edges
GROUP BY geneId
WHERE ...
  → N*10 行聚合

-- Step 4: 内存中 scoring (O(N) Thompson sampling)
```

### 3.2 潜在优化路径

| N 级别 | 优化                                                      | 效果                     |
| ------ | --------------------------------------------------------- | ------------------------ |
| 10K    | global gene 查询加 LIMIT 200 + ORDER BY successCount DESC | 减少内存加载             |
| 100K   | 信号倒排索引（im_gene_signals 先匹配再 JOIN gene）        | 从 O(N) → O(match_count) |
| 1M     | scope 分片 + 物化视图（signal→top_genes 预计算）          | 常数时间查找             |

## 4. 执行时间线

```
Day 5: 编写合成数据生成脚本
Day 6: N=1K, 10K 测试（本地 SQLite）
Day 7: N=10K, 100K 测试（测试环境 MySQL）
Day 8: 分析结果，识别瓶颈
Day 9: 优化方案实施（如果需要）
Day 10: N=100K 重测 + 报告
```

## 5. 输出

- `docs/benchmark/results-scale.json` — 原始数据
- `docs/benchmark/SCALE-ANALYSIS.md` — 本文更新结论
- 如需优化：PR with 索引/查询改动

_Last updated: 2026-03-23_

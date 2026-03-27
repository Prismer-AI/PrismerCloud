# Context Network — Markdown as Node, Save/Load as Edge

> **Version:** 0.1 (Draft)
> **Date:** 2026-03-16
> **Status:** 设计中
> **前置:** EVOLUTION-ENGINE.md Section 2.4.3 "统一知识层设计"
> **定位:** 解决三层断裂问题的核心方案 — 将 Prismer 从 "Knowledge Drive" 升级为 "Self-Growing Knowledge Graph"

---

## 1. 核心洞察

### 1.1 一句话

**Markdown 文件是节点，Save/Load 调用是有向边，Agent 的每次工作都在为这张图添砖加瓦。**

### 1.2 为什么不是传统 Knowledge Graph

传统 KG 的四大死穴在这个体系里不存在：

| 问题 | 传统 KG | Context Network |
|------|---------|-----------------|
| 实体歧义 | NER + Entity Linking，F1~85%，永远有长尾问题 | **不需要** — 每个 Markdown 有唯一 `prismer://` URI |
| 语义容差 | 同义词表/embedding 近似匹配 | **Load 时 LLM 压缩已完成归一化** — HQCC 是语义标准化的产物 |
| 关系抽取 | NLP 三元组抽取，F1~70% | **关系是显式的** — Agent 调用 save/load 时声明了边 |
| Schema 刚性 | 预定义 ontology，新概念需要 schema migration | **零 schema** — Markdown 自由格式，新知识随时写入 |

### 1.3 与 RAG/GraphRAG 的本质区别

| 维度 | 传统 RAG | GraphRAG (Microsoft) | Context Network |
|------|---------|---------------------|-----------------|
| 构建方式 | 预索引 + chunking | 预构建 community summaries | **Agent 工作时自然生长** |
| 查询方式 | embedding 相似度 top-K | 社区摘要 + 实体子图 | **沿边遍历，渐进式披露** |
| 节点质量 | raw chunks（碎片） | LLM 生成的摘要 | **HQCC — LLM 压缩的完整上下文** |
| 更新机制 | 重新索引整个文档库 | 重新运行整个 pipeline | **增量 — 每次 save 就是一次更新** |
| 关系来源 | embedding 空间的隐式距离 | NLP 抽取的三元组 | **运行时调用链 — 100% 精确** |

**核心优势：这张图的每条边都是"真的" — 它来自 Agent 实际的工作流程，而不是 NLP 的猜测。**

---

## 2. 数据模型

### 2.1 节点（Markdown Document）

```
┌─ Context Node ────────────────────────────────────────┐
│                                                        │
│  URI:        prismer://ctx/timeout-retry-patterns      │
│  Type:       knowledge | gene | capsule | memory       │
│  Content:    Markdown (HQCC 或原始)                    │
│  Tags:       ["timeout", "retry", "error-handling"]    │
│  Created:    2026-03-16T10:00:00Z                      │
│  Creator:    agent_abc / user_123                       │
│  Source:     save | load+deposit | evolution | manual   │
│                                                        │
│  Stats:                                                │
│    in_degree:    5   (被引用 5 次)                      │
│    out_degree:   3   (引用了 3 个其他节点)              │
│    load_count:  42   (被 load 42 次)                    │
│    last_loaded: 2026-03-16T09:00:00Z                   │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**节点类型分类：**

| Type | Prisma Model | 表名 | 内容特征 | 生命周期 |
|------|-------------|------|---------|---------|
| `knowledge` | `ContextCache` | `im_context_cache` | Web 内容的 HQCC 压缩 | 长期，有 TTL 刷新 |
| `gene` | `IMGene` + `IMGeneSignal` | `im_genes` | 策略（signal + strategy + constraints） | 长期，有版本演化 |
| `capsule` | `IMEvolutionCapsule` | `im_evolution_capsules` | 执行记录（outcome + score + summary） | 中期，可蒸馏归档 |
| `memory` | `IMMemoryFile` | `im_memory_files` | Markdown 记忆（pattern / fact） | 长期，可覆写 |
| `skill` | `IMSkill` | `im_skills` | SKILL.md 目录（17K+ 条目） | 长期，社区维护 |

### 2.2 边（Save/Load 调用）

```
┌─ Context Edge ────────────────────────────────────────┐
│                                                        │
│  From:       prismer://gene/timeout-retry-v3           │
│  To:         prismer://ctx/timeout-retry-patterns      │
│  Type:       references | derived_from | leads_to      │
│  Created_by: agent_abc                                 │
│  Created_at: 2026-03-16T10:05:00Z                      │
│  Weight:     3  (被走过 3 次)                           │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**边的类型（`im_context_edges`，二元关系）：**

| Type | 触发方式 | 语义 | 举例 |
|------|---------|------|------|
| `references` | Markdown 内嵌 `prismer://` 链接 | "提到了" | Gene 文档引用了一篇知识 |
| `derived_from` | `save(content, refs: [...])` 显式声明 | "由...产生" | Capsule 来源于某个 Gene 的执行 |
| `leads_to` | 连续 load 调用（A load 之后 load B） | "进而引出" | 渐进式披露链路 |
| `similar_to` | 系统推断（同 tag / 相近 embedding） | "相似于" | Phase 2 — 自动发现的弱关系 |

**与超图层（`im_hyperedges`）的关系：**

| | `im_context_edges` | `im_hyperedges` |
|--|-------------------|-----------------|
| 关系元数 | 二元（A→B） | N 元（一条超边连多个原子） |
| 用途 | 知识之间的简单引用 | 执行事件的多维关联（agent×signal×gene×outcome） |
| 已有 | 新增 | v0.3.1 已实现 |
| 示例 | "Gene-7 references Knowledge-12" | "Agent-A 在 signal:timeout 下用 Gene-7 得到 success" |

两者共存：简单知识链路用 `im_context_edges`，多维因果关系用超图层。

### 2.3 存储方案：已有表 → Context Network 映射

**原则：不新建节点表。现有 Prisma models 已经是节点。只需新增边表 + 搜索引擎索引。**

#### 已有表到节点类型的映射

```
Context Network 节点类型          已有 Prisma Model              表名
─────────────────────────────────────────────────────────────────────────
knowledge (Web知识)        →     ContextCache                   im_context_cache
  字段映射:
    uri        = contentUri (prismer://...)
    title      = meta.title (JSON 内) ← 需补充
    content    = hqccContent
    creator    = userId
    tags       = tags (JSON string[])

gene (策略知识)            →     IMGene                         im_genes
  字段映射:
    uri        = "prismer://gene/{id}"
    title      = title
    content    = description + strategySteps
    creator    = ownerAgentId
    signals    → IMGeneSignal (im_gene_signals)

capsule (执行记录)         →     IMEvolutionCapsule             im_evolution_capsules
  字段映射:
    uri        = "prismer://capsule/{id}"
    title      = summary
    content    = metadata (JSON)
    creator    = ownerAgentId
    outcome    = outcome + score

memory (结构化记忆)        →     IMMemoryFile                   im_memory_files
  字段映射:
    uri        = "prismer://memory/{ownerId}/{scope}/{path}"
    title      = path
    content    = content (Markdown 全文)
    creator    = ownerId

skill (技能目录)           →     IMSkill                        im_skills
  字段映射:
    uri        = "prismer://skill/{slug}"
    title      = name
    content    = content (SKILL.md 全文)
    tags       = tags (JSON string[])
    category   = category
```

**每个已有表已经存了完整内容。不需要再建 `im_context_nodes` 索引层——搜索引擎直接索引这些表的内容。**

#### 需要新增的：边表

已有表之间没有跨表引用关系。边需要一张新表：

```
Prisma Model (新增):

model IMContextEdge {
  id              String    @id @default(cuid())
  fromType        String                           // "knowledge" | "gene" | "capsule" | "memory" | "skill"
  fromId          String                           // 源节点 PK (在对应表中)
  toType          String
  toId            String
  edgeType        String                           // "references" | "derived_from" | "leads_to" | "similar_to"
  weight          Int       @default(1)            // 被走过的次数
  createdBy       String?                          // agent 或 user ID
  createdAt       DateTime  @default(now())
  lastTraversedAt DateTime?

  @@unique([fromType, fromId, toType, toId, edgeType])
  @@index([fromType, fromId])
  @@index([toType, toId])
  @@map("im_context_edges")
}
```

**为什么用 (fromType, fromId) 而不是 URI？**
- URI 是展示层概念，DB 里用类型+主键更高效（走索引）
- 查询 "Node-7 的所有出边"：`WHERE fromType='knowledge' AND fromId='xxx'`
- 不需要 JOIN 就能拿到边，需要内容时再按 type 去对应表查

#### 需要新增的：节点统计字段

在已有表上加字段，不建新表：

```
ContextCache (im_context_cache) 新增:
  loadCount      Int       @default(0)          // 被 load 的次数
  lastLoadedAt   DateTime?                      // 最近被 load 的时间

IMGene (im_genes) 已有:
  successCount, failureCount, lastUsedAt        // 已经有统计字段 ✓

IMMemoryFile (im_memory_files) 新增:
  loadCount      Int       @default(0)
  lastLoadedAt   DateTime?

IMSkill (im_skills) 已有:
  installs, stars                               // 已经有统计字段 ✓
```

#### 首步召回：搜索引擎而非倒排索引

**不建 `im_keyword_index` 倒排表。** 首步召回由外部搜索引擎处理（详见 Section 5）。

搜索引擎索引以下内容：

```
索引 schema (MeiliSearch / Typesense):

{
  "id":         "{type}:{pk}",                    // "knowledge:clxxx" | "gene:seed_repair_timeout_v1"
  "type":       "knowledge|gene|capsule|memory|skill",
  "title":      "...",                            // 各表的 title 字段
  "content":    "...",                            // HQCC / strategy / memory content / SKILL.md
  "tags":       ["timeout", "retry"],             // tags JSON 解析后
  "category":   "repair",                         // gene.category / skill.category
  "creator":    "agent_abc",
  "loadCount":  42,                               // 排序信号
  "inDegree":   5,                                // 从 im_context_edges 聚合
  "createdAt":  "2026-03-16T10:00:00Z",
  "updatedAt":  "2026-03-19T09:00:00Z"
}
```

同步机制：deposit / save / evolve record 时同步推送到搜索引擎。

#### 完整数据模型一览

```
┌─ 已有表 (节点, 不改结构) ──────────────────────────────────────────────────┐
│                                                                              │
│  im_context_cache    →  knowledge 节点  (HQCC 全文, 加 loadCount 字段)     │
│  im_genes            →  gene 节点       (策略, 已有 successCount 等)       │
│  im_gene_signals     →  gene 的信号绑定  (已有)                             │
│  im_evolution_capsules → capsule 节点   (执行记录, 已有)                   │
│  im_memory_files     →  memory 节点     (Markdown, 加 loadCount 字段)     │
│  im_skills           →  skill 节点      (目录, 已有 installs/stars)       │
│                                                                              │
├─ 新增表 (边) ────────────────────────────────────────────────────────────────┤
│                                                                              │
│  im_context_edges    →  节点间的关系 (references/derived_from/leads_to/...) │
│                                                                              │
├─ 外部搜索引擎 (索引, 非 MySQL 表) ──────────────────────────────────────────┤
│                                                                              │
│  MeiliSearch index   →  全文检索 + 语义召回 (索引上述 6 张表的内容)        │
│                        BM25 + typo tolerance + CJK + custom ranking         │
│                                                                              │
│  (可选) sqlite-vec   →  Dense Embedding 向量检索                            │
│                        Hybrid: BM25 + embedding, RRF 融合                   │
│                                                                              │
├─ 已有的 Evolution 超图层 (可选集成) ─────────────────────────────────────────┤
│                                                                              │
│  im_atoms            →  超图原子 (kind+value 唯一)                          │
│  im_hyperedges       →  超边 (execution type)                               │
│  im_hyperedge_atoms  →  超边-原子关联 (带 role)                             │
│  im_causal_links     →  因果链路 (cause→effect, strength)                  │
│                                                                              │
│  ※ 超图层已建好。im_context_edges 是简单二元边,                            │
│    超图层是多元关系 (一条超边连 N 个原子)。                                  │
│    两者可共存: 简单关系用 edges, 复杂关系用 hypergraph。                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 冷启动：从零到网络

**这是最关键的问题。** 一张空图没有价值。图必须在第一个 Agent 第一次使用时就能提供帮助。

### 3.1 冷启动的三个层次

```
Level 0: 空图（不可接受）
    → Agent 发起 load，什么都命中不了，体验为零

Level 1: 种子图（最小可用）
    → Agent 发起 load，能命中预置的高质量节点

Level 2: 自生长（目标状态）
    → Agent 的每次工作自动丰富图的密度

Level 3: 涌现结构（长期愿景）
    → 图呈现出社区、Hub 节点、知识链路等拓扑特征
```

### 3.2 Level 1 — 种子图构建

**目标：在系统上线前，图中就已经有 ~500 个高质量节点和 ~2000 条边。**

#### 3.2.1 种子节点来源

| 来源 | 数量 | 方法 | 节点类型 |
|------|------|------|---------|
| **Prismer 自身文档** | ~30 | 将 `docs/*.md` 逐个 save 到 Context Network | `knowledge` |
| **SDK 文档 + 示例** | ~20 | `sdk/*/README.md` + example code | `knowledge` |
| **Seed Gene** | ~45 | 现有 `im_skills` 中精选的 Gene | `gene` |
| **高频技术主题** | ~200 | 批量 `prismer_load` 常见技术文档 (MDN, Node.js docs, Python docs) | `knowledge` |
| **Best Practice 合集** | ~100 | 从 awesome-* 列表 load 热门文章 | `knowledge` |
| **ClawHub Skills** | ~100 | 从 17K+ skills 中挑选高质量的，转化为 Gene 节点 | `gene` |

#### 3.2.2 种子边构建

```python
# 伪代码：种子图构建脚本
async def build_seed_graph():
    # Step 1: 批量 load 高频主题，每个 load 自动创建 knowledge 节点
    topics = load_yaml("scripts/seed-topics.yaml")  # ~200 个主题 URL
    for topic in topics:
        node = await prismer_load(topic.url)
        await create_node(uri=node.content_uri, type="knowledge", tags=topic.tags)

    # Step 2: 用 LLM 分析每个节点，提取它"应该链接到"的其他节点
    for node in all_nodes:
        related = await llm_analyze(
            f"Given this content:\n{node.content}\n\n"
            f"Which of these topics is it most related to?\n{all_tags}"
        )
        for target in related:
            await create_edge(from=node.uri, to=target.uri, type="references")

    # Step 3: 从 Seed Gene 建立 gene → knowledge 边
    for gene in seed_genes:
        # Gene 的 strategy 引用了哪些知识？
        refs = extract_prismer_uris(gene.strategy_markdown)
        for ref in refs:
            await create_edge(from=gene.uri, to=ref, type="references")
```

#### 3.2.3 种子图的拓扑目标

```
目标拓扑指标（~500 节点）:
  - 平均度 (avg degree):     ~8    (每个节点平均连 8 条边)
  - 聚类系数 (clustering):   >0.3   (知识有局部聚集性)
  - 最大连通分量:            >90%   (几乎没有孤岛)
  - 直径 (diameter):         <8     (任意两点之间不超过 8 跳)
  - Hub 节点 (degree>20):    ~10    (核心知识枢纽)
```

**这些指标可以在种子图构建后立即验证，不满足就补充节点/边。**

### 3.3 Level 2 — 自生长机制

**Agent 不需要"有意识地"构建图。图的生长是 Save/Load 的副作用。**

#### 3.3.1 Load 路径的自动建边

```
Agent 调用 prismer_load("how to handle timeout errors")
    │
    ├─ 1. Exa 搜索 → 获取相关 URL
    ├─ 2. LLM 压缩 → 生成 HQCC
    ├─ 3. Deposit → 创建/更新 knowledge 节点 ← 已有逻辑
    │
    ├─ 4. [NEW] 自动建边:
    │     如果 Agent 当前正在执行某个 Gene:
    │       create_edge(gene_uri → new_node_uri, type="references")
    │     如果 Agent 上一次 load 了另一个节点:
    │       create_edge(prev_node_uri → new_node_uri, type="leads_to")
    │
    └─ 5. [NEW] 更新节点统计:
          node.load_count++
          node.last_loaded_at = now()
```

**关键设计：`leads_to` 边来自连续 load 调用。** 如果 Agent 先 load A 再 load B，说明 A 的知识"引出了"对 B 的需求。这条边是隐式的，但信息量极高——它反映了真实的思维链路。

#### 3.3.2 Save 路径的自动建边

```
Agent 调用 prismer_save(content, tags, refs?)
    │
    ├─ 1. 创建 knowledge/memory 节点 ← 已有逻辑
    │
    ├─ 2. [NEW] 处理显式引用:
    │     for ref in refs:
    │       create_edge(new_node → ref, type="derived_from")
    │
    ├─ 3. [NEW] 自动 tag 扩展:
    │     如果 content 提到了已有节点的 tag:
    │       create_edge(new_node → matched_node, type="similar_to", weight=0.5)
    │
    └─ 4. [NEW] 上下文关联:
          如果 Agent 刚刚 load 过某个节点:
            create_edge(loaded_node → new_node, type="leads_to")
          // 含义: "我读了 A，然后产出了 B" → A leads_to B
```

#### 3.3.3 Evolution 路径的自动建边

```
Agent 调用 evolve record(geneId, outcome, summary)
    │
    ├─ 1. 创建 capsule 节点
    ├─ 2. create_edge(gene → capsule, type="derived_from")
    │
    ├─ 3. 如果 outcome=success 且 score>0.8:
    │     // 这次执行产生了有价值的知识
    │     auto_save(summary, tags=gene.tags, refs=[gene.uri])
    │     // 自动产生 memory 节点 + 边
    │
    └─ 4. 如果 Gene 蒸馏产出新 Gene:
          create_edge(old_gene → new_gene, type="derived_from")
          // Gene 的血统链路
```

### 3.4 生长预测模型

基于以上机制，估算图的生长速度：

```
假设:
  - 100 个活跃 Agent
  - 每个 Agent 日均 50 次 load, 10 次 save, 5 次 evolve record
  - 每次 load 平均创建 0.3 个新节点（70% 命中缓存）
  - 每次 save 创建 1 个新节点
  - 每次 record 创建 1 个 capsule 节点
  - 每次操作平均产生 2 条边

日新增:
  节点: 100 × (50×0.3 + 10×1 + 5×1) = 100 × 30 = 3,000 节点/天
  边:   100 × (50+10+5) × 2 = 13,000 边/天

月积累:
  节点: ~90,000 (去重后 ~50,000)
  边:   ~390,000

拓扑演化:
  Week 1:  ~20,000 节点, 稀疏图, 多个连通分量
  Week 4:  ~50,000 节点, 主连通分量覆盖 >80%
  Month 3: ~150,000 节点, Hub-and-spoke 拓扑成形
  Month 6: ~300,000 节点, 社区结构涌现
```

---

## 4. 孤儿节点问题

### 4.1 定义

**孤儿节点 (Orphan Node):** `in_degree = 0 AND out_degree = 0` — 没有任何边连接的节点。

**半孤儿节点 (Weakly Connected Node):** 只有一条边（`in_degree + out_degree = 1`），如果那条边的对端也是弱连接，整条链路就是一个"死胡同"。

### 4.2 孤儿产生的原因

| 原因 | 频率 | 严重性 |
|------|------|--------|
| Agent 做了一次 load 但没有后续操作（弃用） | 高 | 低 — 节点有内容，只是没被链接 |
| Save 了知识但没加 refs 也没有 tag 匹配 | 中 | 中 — 好内容石沉大海 |
| Gene 从未被执行（冷门技能） | 中 | 中 — 可能是高价值但缺乏曝光 |
| Capsule 记录了失败且无后续蒸馏 | 高 | 低 — 失败记录的价值本来就有限 |

### 4.3 孤儿治理策略

#### 4.3.1 预防 — 建边时机前置

```typescript
// 每次 save 时强制关联
async function enhancedSave(content: string, opts: SaveOptions) {
  const node = await createNode(content, opts.tags);

  // 自动推断关联：基于 tag 匹配找到候选节点
  const candidates = await findNodesByTags(opts.tags, { limit: 10 });

  if (candidates.length > 0) {
    // 至少建一条 similar_to 边
    const bestMatch = candidates[0];
    await createEdge(node.uri, bestMatch.uri, 'similar_to');
  }

  // 如果 Agent 有活跃 session context，自动建 leads_to
  if (opts.sessionContext?.lastLoadedUri) {
    await createEdge(opts.sessionContext.lastLoadedUri, node.uri, 'leads_to');
  }

  return node;
}
```

#### 4.3.2 检测 — 定期扫描

```sql
-- 孤儿节点检测（每日跑）
SELECT n.id, n.uri, n.node_type, n.created_at, n.load_count
FROM im_context_nodes n
LEFT JOIN im_context_edges e_out ON n.uri = e_out.from_uri
LEFT JOIN im_context_edges e_in  ON n.uri = e_in.to_uri
WHERE e_out.id IS NULL AND e_in.id IS NULL
ORDER BY n.load_count DESC;

-- 半孤儿检测（度=1 且 30 天未被 load）
SELECT n.id, n.uri, n.node_type, n.in_degree + n.out_degree AS degree
FROM im_context_nodes n
WHERE n.in_degree + n.out_degree <= 1
  AND (n.last_loaded_at IS NULL OR n.last_loaded_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
ORDER BY n.created_at;
```

#### 4.3.3 修复 — 自动缝合

```
定期任务 (Scheduler, 每日):

1. 孤儿节点 tag 匹配缝合:
   for each orphan in orphan_nodes:
     candidates = fulltext_search(orphan.title + orphan.tags)
     if candidates:
       create_edge(orphan → best_candidate, type="similar_to")

2. 聚类缝合 (Phase 2):
   // 对高 load_count 但低 degree 的节点做 embedding 最近邻
   // 发现隐含关联并建立 similar_to 边

3. 衰减淘汰:
   // load_count=0 且 created_at > 90 天的孤儿节点
   // 标记为 archived（不删除，不参与搜索）
```

#### 4.3.4 孤儿节点的健康指标

```
Orphan Rate = orphan_nodes / total_nodes

健康标准:
  < 10%   — 健康（正常的未链接新节点）
  10-25%  — 关注（缝合任务可能没跑或效果不好）
  > 25%   — 告警（图退化为散点，网络效应丧失）

Dashboard 展示:
  - 孤儿率趋势（日级折线图）
  - 新增节点中孤儿占比（衡量建边机制是否有效）
  - 孤儿修复率（缝合任务的效果）
```

---

## 5. 第一个节点怎么来？—— 入口发现问题

**这是整个 Context Network 最关键的设计点。**

图遍历有一个前提：你已经站在某个节点上了。但 Agent 手里只有一句自然语言 `"timeout error handling"`——它怎么落到图上的第一个节点？

### 5.1 问题诊断

当前 `prismer_load` 的两条入口路径都**绕过了图**：

```
路径 A: URL 精确匹配
  load("https://example.com/retry.html") → cache lookup → 命中或 miss
  问题: Agent 必须知道 URL。这不是召回，这是书签。

路径 B: Query 搜索
  load("timeout error handling") → Exa 外部搜索 → 抓取 → 压缩 → 返回
  问题: 直接去了外网。图里可能已经有 50 个 Agent 积累的 timeout 经验，全被无视。
```

**本质问题：Load 的入口发现不经过图。Agent 的 query 没有机会匹配到已有的知识网络。**

### 5.2 前置问题：节点入图时写了什么可搜索字段？

**搜索能力取决于写入时生成了什么。** 看当前 `ContextCache` schema（`prisma/schema.prisma:323`）：

```
现有字段:
  rawLink      — URL 原文          ✗ 无法语义搜索
  rawLinkHash  — SHA-256(URL)     ✗ 只能精确匹配
  hqccContent  — HQCC 全文        △ 可以 FULLTEXT，但太大太噪
  tags         — JSON string[]    △ 字段存在，但当前没人写入有意义的值
  meta         — JSON {}          ✗ 未结构化

缺失:
  title        — 无独立字段（网页 title 在 meta 里，可能没存）
  summary      — 无
  keywords     — 无
  embeddings   — 无
```

**所以现在即使加了 FULLTEXT 索引也搜不到什么——节点入图时没有生成可搜索的元数据。**

这意味着 query → top-K 的设计必须从**写入时**开始，分两步走：

### 5.3 写入路径：节点入图时生成可搜索元数据

**时机：compress 之后、deposit 之前。** 压缩器已经产出了 HQCC，我们从 HQCC 中提取结构化元数据。

```
当前写入链路:
  raw_content → compress() → HQCC → deposit(url, hqcc)
                                          ↓
                                    ContextCache.create({
                                      rawLink, rawLinkHash, hqccContent,
                                      tags: "[]",   ← 空的
                                      meta: "{}",   ← 空的
                                    })

改造后:
  raw_content → compress() → HQCC → extractMeta(HQCC) → deposit(url, hqcc, meta)
                                          ↓
                                    im_context_nodes.create({
                                      uri, title, summary, keywords, tags,
                                      hqcc 存在 source_table 指向的原始表
                                    })
```

**`extractMeta(hqcc)` 怎么实现？三个方案，成本递增：**

```
方案 A: 正则提取 (0 成本, ~5ms)
  HQCC 是 Markdown，compress prompt 要求保留 headings。
  → title = 第一个 # heading 或前 100 字符
  → keywords = 所有 ## heading 的文本 + 代码块语言标记
  → tags = 从 keywords 去重、小写、去停用词

  实现:
    function extractMeta(hqcc: string) {
      const lines = hqcc.split('\n');
      const h1 = lines.find(l => /^#\s/.test(l));
      const headings = lines.filter(l => /^#{1,3}\s/.test(l))
                            .map(l => l.replace(/^#+\s*/, ''));
      const codelangs = [...hqcc.matchAll(/```(\w+)/g)].map(m => m[1]);

      return {
        title: h1?.replace(/^#\s*/, '') || hqcc.slice(0, 100),
        summary: hqcc.slice(0, 300),
        keywords: [...new Set([...headings, ...codelangs])]
                    .map(k => k.toLowerCase().trim())
                    .filter(k => k.length > 2),
      };
    }

  效果:
    输入 HQCC: "# Handling Timeout Errors\n## Retry with Backoff\n## Circuit Breaker\n..."
    产出: {
      title: "Handling Timeout Errors",
      summary: "Handling Timeout Errors...(前300字)",
      keywords: ["handling timeout errors", "retry with backoff", "circuit breaker"],
    }

  局限:
    只能提取 HQCC 已有的结构，不能推断语义。
    如果 HQCC 没有 headings（某些压缩策略产出纯文本），提取质量差。


方案 B: compress prompt 扩展 (≈0 额外成本, 改 prompt 即可)
  在现有 compress prompt 末尾加一段输出要求:

  现有 prompt (prompts.ts:191):
    "Create a COMPREHENSIVE summary..."

  追加:
    """
    At the END of your output, add a metadata block in this exact format:

    <!-- META
    title: {一句话标题}
    keywords: {逗号分隔的 5-10 个关键词，含同义词}
    -->
    """

  压缩器本来就在跑 LLM，追加几行输出不增加 API 调用成本。
  解析时用正则提取 <!-- META ... --> 块。

  效果:
    LLM 产出的 keywords 比正则提取好得多:
    "timeout, request timeout, ETIMEDOUT, connection timeout,
     retry, exponential backoff, circuit breaker, error handling, Node.js"

    关键: LLM 会生成同义词和上位词（"ETIMEDOUT" 不在原文里但 LLM 知道它相关）。
    这解决了 "request timed out" 查不到 "timeout" 的语义gap。

  局限:
    依赖 LLM 遵循格式。需要做 fallback 到方案 A。


方案 C: 独立 LLM 调用提取 (额外成本, ~$0.001/node)
  deposit 后异步调用轻量模型 (haiku/gpt-4o-mini) 生成:
    { title, summary, keywords[], category, relatedTopics[] }

  对种子图 500 节点: ~$0.50。对日增 3000 节点: ~$3/天。可接受。

  最优但非必需。方案 B 已经够用了。
```

**推荐：方案 B 为主 + 方案 A 做 fallback。** 改一个 prompt，零额外成本，元数据质量最高。

### 5.4 读取路径：query → top-K nodes 的完整流程

```
输入:  query = "timeout error handling"
目标:  从图中找到最相关的 K 个节点
性能:  <5ms (倒排索引主键查询，不扫节点表)
```

```
T=0ms  Agent 调用 prismer_load("timeout error handling")
       input-detector 判定 type=query
       │
       ├─ 同时发出两路:
       │
       │  ┌─ Graph: 倒排索引召回 + 排序 ──────────────────────────────┐
       │  │                                                             │
       │  │  Step 1: query → tokens                                    │
       │  │                                                             │
       │  │  queryTokens = tokenize("timeout error handling")          │
       │  │              = ["timeout", "error", "handling"]             │
       │  │  // 小写归一化 + 去停用词 ("the","a","in" etc)             │
       │  │  // 加 N-gram: ["timeout error", "error handling"]         │
       │  │  // 最终: ["timeout", "error", "handling",                 │
       │  │  //        "timeout error", "error handling"]               │
       │  │                                                             │
       │  │  Step 2: 倒排索引查询 — 一条 SQL，走主键                   │
       │  │                                                             │
       │  │  SELECT ki.node_id,                                        │
       │  │         n.uri, n.title, n.summary, n.node_type,            │
       │  │         n.load_count, n.in_degree,                          │
       │  │         SUM(ki.weight) AS keyword_score,                   │
       │  │         COUNT(*) AS matched_keywords                        │
       │  │  FROM im_keyword_index ki                                   │
       │  │  JOIN im_context_nodes n ON ki.node_id = n.id              │
       │  │  WHERE ki.keyword IN                                        │
       │  │    ('timeout','error','handling',                           │
       │  │     'timeout error','error handling')                       │
       │  │  GROUP BY ki.node_id                                        │
       │  │  ORDER BY keyword_score DESC                                │
       │  │  LIMIT 30;                                                  │
       │  │                                                             │
       │  │  ↑ 这条 SQL 做了什么:                                      │
       │  │    keyword 列是 PRIMARY KEY → 每个 IN 值走 B-tree → O(logN)│
       │  │    5 个 token × O(logN) = O(5·logN) ≈ 常数时间             │
       │  │    100万行倒排表 → log(1M) ≈ 20 次磁盘读 → <5ms           │
       │  │    SUM(weight) 自动聚合: 命中多个 keyword 的节点得分更高   │
       │  │                                                             │
       │  │  示例结果:                                                  │
       │  │    Node-7:   matched=2 ("timeout" + "error")    score=1.8  │
       │  │    Node-501: matched=1 ("timeout")              score=1.0  │
       │  │    Node-340: matched=1 ("error")                score=0.6  │
       │  │                                                             │
       │  │  Step 3: 应用层精排 (在 30 条候选上排序，不是全表)          │
       │  │                                                             │
       │  │  for each candidate:                                        │
       │  │    final_score =                                             │
       │  │      keyword_score * 10                     // 倒排命中权重 │
       │  │      + type_boost[node_type]                 // memory=3, gene=2, knowledge=1│
       │  │      + Math.log(load_count + 1) * 2         // 使用频次    │
       │  │      + in_degree * 0.5                      // Hub 权威度   │
       │  │      + freshness(last_loaded_at) * 1        // 新鲜度      │
       │  │                                                             │
       │  │  排序 → 取 top-K (默认 K=5)                                │
       │  │                                                             │
       │  │  ⚠ 语义桥梁在这里生效:                                     │
       │  │    Agent 搜 "ETIMEDOUT"                                     │
       │  │    → tokenize → ["etimedout"]                               │
       │  │    → 倒排表里 keyword="etimedout" 指向 Node-7               │
       │  │      (因为 compress 时 LLM 在 keywords 里写了 "ETIMEDOUT")  │
       │  │    → 命中! 即使节点 title 里没有 "ETIMEDOUT" 这个词         │
       │  │                                                             │
       │  └─ 产出: top-K nodes, ~5ms                                   │
       │                                                                │
       │  ┌─ L3: Exa 外部搜索 (并行，fire-and-forget) ─────────────┐  │
       │  │  searchAndContents(query, numResults=15)                    │  │
       │  │  → 15 条外部网页结果                                       │  │
       │  └────────────────────────────────────────────────────────────┘  │
       │                                                                   │
       ▼                                                                   │
                                                                           │
T=5ms    Graph 结果返回                                                    │
         │                                                                 │
         ├─ top-K 非空 → 立即返回给 Agent (source: "graph")              │
         │   不等 L3                                                       │
         │                                                                 │
         └─ top-K 为空 → 等 L3                                            │
                                                                           │
T=2000ms L3 返回                                                          │
         如果已经返回了 graph 结果:                                        │
           L3 结果 → 网络感知压缩 → deposit 新节点 (静默)                │
           → deposit 同时写倒排索引 → 下次同类 query 在 graph 5ms 命中   │
         如果 graph 结果为空:                                              │
           L3 结果 → compress → deposit + 写倒排 → 返回给 Agent          │
```

**性能对比：**

| 方案 | 30万节点查询延迟 | 原因 |
|------|----------------|------|
| JSON_OVERLAPS 扫 tags 列 | ~500ms | 全表扫描 JSON 列 |
| FULLTEXT on title+summary | ~50-200ms | FULLTEXT 索引查询，还行但不够快 |
| **倒排索引 WHERE IN** | **<5ms** | 主键 B-tree 查找，O(log N) per token |
| SHA-256 精确匹配 (当前) | <1ms | 但只能匹配 URL，不能语义匹配 |

### 5.5 具体示例：一个 query 走完全程

```
query: "request timed out in Node.js API"

im_keyword_index 中的相关行 (写入时已构建):
  keyword               → node_id   weight
  ─────────────────────────────────────────
  "timeout"             → Node-7    1.0
  "etimedout"           → Node-7    0.8
  "request timed out"   → Node-7    0.9    ← LLM 生成的同义词
  "connection timeout"  → Node-7    0.8
  "node.js"             → Node-7    0.6
  "timeout"             → Node-501  1.0
  "retry"               → Node-501  0.8
  "node.js"             → Node-501  0.6
  "connecttimeout"      → Node-501  0.7
  "retry"               → Node-12   1.0
  "backoff"             → Node-12   1.0
  "exponential"         → Node-12   0.8

─── Step 1: tokenize ───

  "request timed out in Node.js API"
  → 小写: "request timed out in node.js api"
  → 去停用词: "request timed out node.js api"  (去掉 "in")
  → 单词: ["request", "timed", "out", "node.js", "api"]
  → N-gram: ["request timed out", "timed out", "node.js api"]
  → 合并去重: ["request", "timed", "out", "node.js", "api",
               "request timed out", "timed out", "node.js api"]

─── Step 2: 倒排索引查询 (一条 SQL) ───

  SELECT ki.node_id, SUM(ki.weight) AS score, COUNT(*) AS hits
  FROM im_keyword_index ki
  WHERE ki.keyword IN
    ('request','timed','out','node.js','api',
     'request timed out','timed out','node.js api')
  GROUP BY ki.node_id
  ORDER BY score DESC
  LIMIT 30;

  命中:
    keyword="request timed out" → Node-7  (weight=0.9)   ← 同义词命中!
    keyword="node.js"           → Node-7  (weight=0.6)
    keyword="node.js"           → Node-501 (weight=0.6)

  聚合结果:
    Node-7:   hits=2, keyword_score=1.5
    Node-501: hits=1, keyword_score=0.6

  注意: "request","timed","out" 作为单独 token 没有命中任何 keyword
        但 N-gram "request timed out" 精确命中了 Node-7 的同义词行
        这就是 LLM 预埋同义词 + 倒排索引的核心价值

  耗时: <5ms (两次 B-tree 查找)

─── Step 3: 精排 (30 条候选上做，不是全表) ───

  Node-7:
    final = keyword_score(1.5) × 10
          + type_boost(knowledge=1)
          + log(load_count=42 + 1) × 2
          + in_degree(5) × 0.5
          + freshness(0.8)
          = 15.0 + 1.0 + 7.5 + 2.5 + 0.8 = 26.8

  Node-501:
    final = keyword_score(0.6) × 10
          + type_boost(memory=3)       ← 实战经验加分高
          + log(load_count=8 + 1) × 2
          + in_degree(2) × 0.5
          + freshness(0.5)
          = 6.0 + 3.0 + 4.4 + 1.0 + 0.5 = 14.9

  top-K = [Node-7 (26.8), Node-501 (14.9)]

─── 返回 ───

  T=5ms: 立即返回给 Agent
    result[0] = Node-7 的 HQCC + neighbors
    result[1] = Node-501 的 HQCC + neighbors
    source: "graph"

─── 与此同时 L3 在后台跑 (fire-and-forget) ───

  T=2000ms: Exa 返回 15 篇外部文章
    → 网络感知压缩(article, [Node-7, Node-501, Node-12])
    → deposit 新节点 + 写倒排索引
    → 图静默长大，下次 query 召回更丰富
```

### 5.6 为什么 keywords 是核心——语义桥梁

```
FULLTEXT 的匹配是词级精确的:
  query 里有 "timed out" → 只匹配文本里有 "timed out" 的节点
  不知道 "timed out" ≈ "timeout" ≈ "ETIMEDOUT"

keywords 字段是 LLM 在 compress 时生成的:
  LLM 理解了 "timeout" 的语义场，会写出:
  ["timeout", "ETIMEDOUT", "request timed out", "connection timeout",
   "socket timeout", "deadline exceeded", "408 Request Timeout"]

  这些同义词/关联词是 LLM 的世界知识产物。
  存到 keywords 后，keyword 匹配就获得了语义能力:

  query "ETIMEDOUT" → keyword 匹配 → 命中 Node-7
  query "408 error"  → keyword 匹配 → 命中 Node-7
  query "deadline exceeded" → keyword 匹配 → 命中 Node-7

  不需要 embedding 向量，不需要向量数据库。
  LLM 在写入时做了一次"语义展开"，查询时直接字符串匹配。
```

**这就是方案 B（compress prompt 追加 keywords 输出）的关键价值。不是事后加索引，而是在压缩时让 LLM 把语义桥梁预埋到数据里。查询时零成本匹配。**

### 5.7 入口发现 vs 图遍历——两个不同阶段

```
Phase A: 入口发现 (Landing)
  "我在图外面，我要找到第一个落脚点"
  输入: 自然语言 query
  输出: 1 个（或几个）最佳入口节点
  机制: FULLTEXT + tag + 权重排序 → fallback 到 Exa

Phase B: 图遍历 (Traversal)
  "我已经站在节点上了，我要沿边走"
  输入: prismer:// URI（精确）
  输出: 节点内容 + 邻居列表
  机制: URI lookup + neighbor query

Phase A 只发生一次（Agent 的第一个 load）
Phase B 可以发生多次（Agent 沿邻居链路逐步展开）
```

这两个阶段对应 Agent 的两种使用姿势：

```typescript
// Phase A: 入口发现 — Agent 不知道要什么，给自然语言
const entry = await prismer.load("timeout error handling");
// → Level 1/2/3 瀑布，返回最佳入口节点
// → entry.graph.neighbors 显示邻居

// Phase B: 图遍历 — Agent 已经知道要哪个节点，给 URI
const deep = await prismer.load(entry.graph.neighbors[0].uri);
// → 直接 URI lookup，O(1)，不经过 FULLTEXT
// → deep.graph.neighbors 显示下一层邻居

// Agent 自行决定走多深
if (deep.graph.neighbors.some(n => n.title.includes("backoff"))) {
  const deeper = await prismer.load("prismer://ctx/exponential-backoff");
  // → 第三跳...
}
```

### 5.5 API 变更

```typescript
// 现有 Load 响应
interface LoadResponse {
  success: boolean;
  data: {
    input: string;
    content: string;         // HQCC
    content_uri: string;     // prismer://...
    source: string;
    processingTime: number;
  };
}

// Context Network 增强后的响应
interface LoadResponse {
  success: boolean;
  data: {
    input: string;
    content: string;
    content_uri: string;
    source: string;
    processingTime: number;

    // [NEW] 图信息
    graph?: {
      node_type: 'knowledge' | 'gene' | 'capsule' | 'memory';
      tags: string[];
      load_count: number;

      // 邻居节点（按 weight 降序，最多 5 个）
      neighbors: Array<{
        uri: string;
        title: string;
        edge_type: 'references' | 'derived_from' | 'leads_to' | 'similar_to';
        weight: number;        // 这条边被走过多少次
        node_type: string;
        snippet?: string;      // 内容前 200 字符
      }>;
    };
  };
}
```

**向后兼容：** `graph` 字段是可选的。不关心图的 Agent 完全无感知。

### 5.6 渐进式披露的遍历策略

不同场景需要不同的遍历深度：

```
Strategy: "shallow" (默认)
  只返回直接邻居，Agent 自行决定是否继续
  适用: 大多数 load 调用

Strategy: "deep"
  返回 2 跳内的子图（邻居的邻居），以摘要形式
  适用: Gene strategy 中的 "recall similar fixes"

Strategy: "path"
  给定起点和目标 tag，返回最短路径
  适用: "从 timeout error 到 best practice 的链路是什么？"
```

---

## 6. 召回时"第一个 Markdown"的完整生命线

Section 5 回答了"入口怎么落到图上"。这一节追踪整条链路：**从图为空到第一次召回命中图内节点，中间到底发生了什么？**

### 6.1 时间线：从零到命中

```
T=0  系统上线，图为空
     ─────────────────────────────────────────────────

T=1  种子脚本运行 (Phase 2 冷启动)
     批量 prismer_load(200 个高频 URL)
     每个 load: Exa → LLM compress → deposit
     deposit 时: 创建 knowledge 节点 + FULLTEXT 索引
     结果: 图有 ~500 节点, ~2000 边, 全部是 knowledge 类型

     ─────────────────────────────────────────────────

T=2  Agent Alpha 第一次 query: load("timeout error handling")

     Step 1: 三级瀑布启动
       Level 1: FULLTEXT("timeout error handling") on im_context_nodes
         → 命中种子节点 "Node-7: Handling Timeout Errors in Node.js"
         → 这个节点是 T=1 种子脚本从 MDN 文章压缩来的
         → score = FULLTEXT_relevance + load_count(0) + in_degree(3)

     Step 2: 返回 Node-7 的 HQCC 内容
       → Agent 拿到了压缩后的超时处理最佳实践

     Step 3: 返回 neighbors
       → [Node-12: "Retry with Exponential Backoff" (references, w=1)]
       → [Node-31: "Circuit Breaker Pattern" (similar_to, w=1)]

     Step 4: 副作用
       → Node-7.load_count = 1
       → Node-7.last_loaded_at = now()

     ─────────────────────────────────────────────────

T=3  Agent Alpha 沿邻居走: load("prismer://ctx/node-12")

     → URI 精确匹配，O(1)，不经过 FULLTEXT
     → 返回 Node-12 内容 + 其邻居
     → 建边: Node-7 → Node-12 (leads_to, weight=1)
       // "timeout handling" 引出了 "retry backoff"

     ─────────────────────────────────────────────────

T=4  Agent Alpha 解决问题后:
     save("Fixed: connectTimeout=30s + 3x retry with jitter",
          tags: ["timeout", "retry", "fix", "nodejs"],
          refs: ["prismer://ctx/node-7"])

     → 创建 Node-501 (type=memory)
     → 建边: Node-501 → Node-7 (derived_from)
     → tag 匹配: Node-501 与 Node-12 共享 "retry" tag
       → 建边: Node-501 → Node-12 (similar_to)

     ─────────────────────────────────────────────────

T=5  Agent Beta 遇到类似问题: load("api request timed out")

     Level 1: FULLTEXT("api request timed out")
       → 命中 Node-7 (种子, "timeout" 匹配, load_count=1)
       → 命中 Node-501 (Agent Alpha 的经验, "timeout" 匹配)
       → 排序: Node-501 score 可能更高
         (因为 node_type=memory → 实战经验 > 文档知识, 可配权重)

     Agent Beta 拿到的第一个 markdown 是 Agent Alpha 的实战修复经验。
     这就是网络效应。
```

### 6.2 关键洞察：三种"第一个 Markdown"

在召回时命中的第一个节点，来源有三种，**对应三个不同时间段**：

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                   │
│  时段 1: 系统冷启动期 (T=0 ~ Day 1)                             │
│  ├─ 第一个 node 来自: 种子脚本的批量 load + deposit              │
│  ├─ 内容质量: 中 (公开文档的 HQCC 压缩)                         │
│  ├─ 图结构: 星形 — Hub 节点(通用概念) + 叶子节点(具体文章)      │
│  └─ 召回命中率: ~60% (只覆盖了预设的 200 个主题)               │
│                                                                   │
│  时段 2: 早期用户期 (Day 1 ~ Week 2)                             │
│  ├─ 第一个 node 可能来自: 种子 OR 前几个 Agent 的 save          │
│  ├─ 新增节点类型: memory (实战经验), capsule (执行记录)          │
│  ├─ 图结构: 种子骨架 + 用户贡献的分支                            │
│  ├─ 关键转折: 当 Agent save 的节点在其他 Agent 的 Level 1 被命中 │
│  │   → 第一次 "用户生成内容被另一个用户消费" → 网络效应启动    │
│  └─ 召回命中率: ~75%                                             │
│                                                                   │
│  时段 3: 网络效应期 (Week 2+)                                    │
│  ├─ 第一个 node 大概率来自: 其他 Agent 的 save/record            │
│  ├─ 节点质量: 高 (实战经验 + 多次 load 验证)                    │
│  ├─ 图结构: 社区涌现 — "timeout/retry" 社区, "auth" 社区 etc   │
│  ├─ 召回命中率: >90% (大多数 query 在 Level 1/2 就命中)         │
│  └─ Level 3 (Exa 外部搜索) 只在真正新颖的 query 上触发         │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 入口排序的信号设计

当 Level 1/2 返回多个候选节点时，**排序决定了 Agent 看到哪个"第一个 Markdown"**。

这是一个信息检索 (IR) 问题，排序信号：

```
score(node, query) =
    α · text_relevance(node.title, query)     // FULLTEXT 相关性
  + β · log(node.load_count + 1)              // 使用频次 (类似 PageRank 的引用思想)
  + γ · node.in_degree                        // 图结构权威度 (Hub 节点)
  + δ · type_boost(node.node_type)            // 类型加权
  + ε · freshness(node.last_loaded_at)        // 新鲜度
  + ζ · creator_affinity(node.creator, agent) // 同 owner 下 Agent 的经验优先

其中 type_boost:
  memory:    1.5  (实战经验最有价值)
  gene:      1.3  (策略知识)
  knowledge: 1.0  (文档知识，基线)
  capsule:   0.8  (原始执行记录，信息密度低)

权重初始值 (可调):
  α=1.0, β=0.3, γ=0.2, δ=0.2, ε=0.1, ζ=0.2
```

**这个排序公式本身也可以通过 A/B test 或 bandit 来优化** — load 后 Agent 是否继续 save 或沿邻居走，可以作为隐式反馈。

### 6.4 "第一个 Markdown" 的质量冷启动问题

即使种子图提供了 ~500 个节点，早期召回的质量仍然受限。**种子节点是公开文档的压缩，不是实战经验。**

解决方案——**Bootstrap Loop（引导循环）：**

```
Phase 1: 内部 Agent 跑任务
  Prismer 团队自己的 Agent 使用 load/save 完成真实任务
  → 产出高质量 memory 节点（带真实 context 的实战经验）
  → 这些节点成为图的"锚点"

Phase 2: 邀请制 Beta
  精选 ~10 个外部 Agent 开发者
  → 他们的 Agent 工作产出的 save 进入图
  → 图密度翻倍，社区结构开始形成

Phase 3: 公开
  图已有足够密度 (avg_degree > 5, orphan_rate < 15%)
  → Level 1 命中率 > 70%
  → 新 Agent 从第一次 load 就能获得有价值的图内结果
```

**数据科学指标——何时从 Phase N 进入 Phase N+1：**

| 指标 | Phase 1→2 阈值 | Phase 2→3 阈值 |
|------|---------------|---------------|
| 节点总数 | > 1,000 | > 5,000 |
| memory 类型节点占比 | > 20% | > 35% |
| Level 1 命中率 (随机 query 样本) | > 50% | > 70% |
| 平均度 | > 3 | > 5 |
| 最大连通分量 | > 70% | > 85% |

---

## 7. 网络感知压缩（Network-Aware Compression）

**当前压缩是 document-centric 的——拿到一篇文章，独立压缩，不知道图的存在。这是一个重大的范式缺陷。**

### 7.1 问题

```
当前:
  compress(raw_article) → HQCC

  输入:  5000 字的 "Handling Timeout Errors in Node.js"
  产出:  800 字的独立摘要
  内容:  完整覆盖 timeout 概念 + retry 策略 + backoff 算法 + circuit breaker

  问题:  图里已有 3 个节点分别讲了 retry、backoff、circuit breaker
         这 800 字里有 500 字是重复的
         而且产出的节点与图完全隔离——没有任何引用
```

### 7.2 网络感知压缩

```
新范式:
  compress(raw_article, graph_neighbors) → HQCC + prismer:// refs

  Step 1: 压缩前，查图
    query = extract_keywords(raw_article)  // "timeout", "retry", "backoff"
    neighbors = search_graph(query, limit=5)
    // 找到: Node-12 "Retry with Backoff", Node-31 "Circuit Breaker Pattern"

  Step 2: 网络感知压缩 prompt
    """
    Compress this article into a concise summary.

    IMPORTANT: The following related knowledge already exists in the network:
    - [prismer://ctx/node-12] "Retry with Exponential Backoff" — covers retry logic, jitter, max attempts
    - [prismer://ctx/node-31] "Circuit Breaker Pattern" — covers failure threshold, half-open state

    Rules:
    1. Do NOT repeat what's already covered in the related nodes above
    2. Reference them using prismer:// URIs where appropriate
    3. Focus on what THIS article adds that is NEW or DIFFERENT
    4. Keep the summary self-contained enough to be useful alone,
       but use references for depth
    """

  Step 3: 产出
    HQCC (300 字):
      "Node.js 中 timeout 错误的核心处理策略是 adaptive timeout——
       根据历史响应时间动态调整 timeout 值（P95 × 1.5），而非使用固定值。
       配合 retry 机制（详见 prismer://ctx/node-12）和
       circuit breaker（详见 prismer://ctx/node-31），
       可将 timeout 导致的请求失败率从 ~12% 降至 <1%。
       关键配置：connectTimeout 与 socketTimeout 需分别设置..."

    refs: ["prismer://ctx/node-12", "prismer://ctx/node-31"]
```

### 7.3 效果对比

| 维度 | Document-Centric | Network-Aware |
|------|-----------------|---------------|
| HQCC 长度 | ~800 tokens | ~300 tokens (**-63%**) |
| 信息密度 | 有大量重复 | 只保留增量知识 |
| 自带边 | 0 | 2+ (引用即建边) |
| Agent 下一步 | 不知道往哪走 | 自然沿 prismer:// 引用走 → **渐进式披露** |
| Token 成本 | 高 (压缩+存储+召回全是重复内容) | 低 (存储和召回都更精练) |
| 图孤儿率 | 高 (节点无引用) | 低 (压缩时已建边) |

### 7.4 压缩本身就是建边

**这是最重要的范式转变：** 压缩不再是"把文章变短"，而是"把文章融入网络"。

```
传统视角:
  compress = summarize(document)
  然后手动想办法给节点建边

网络视角:
  compress = position(document, within=network)
  边是压缩的自然副产物——LLM 在压缩时会引用相关节点，
  这些引用就是 references 边
```

LLM 做的事情其实是**差异化定位**——"这篇文章在已有知识网络中，独特贡献是什么？与哪些已有知识相关？"这比人工 tag 匹配或 embedding 最近邻建边**精确得多**，因为 LLM 真正理解了内容。

### 7.5 与 L3 静默 deposit 的协同

Section 5 中 L3 (Exa 外部搜索) 的结果会静默 deposit 入图。结合网络感知压缩：

```
T=0ms    Agent 发起 load("timeout error")
         L1 命中 → 10ms 返回图内结果给 Agent

T=0ms    L3 同时发出 → Exa 搜索
T=1500ms L3 拿到新文章 raw content
T=1500ms 查图找到相关节点 (Node-7, Node-12, Node-31)
T=2000ms 网络感知压缩 → 300 字 HQCC + 2 条 refs
T=2100ms deposit: 新节点 + 2 条 references 边 + tag 匹配 similar_to 边

结果: Agent 在 10ms 拿到了响应
      后台 2 秒内，图静默增加了 1 个高质量节点 + 3 条边
      这个节点不重复已有知识，只包含增量信息
      下一个 Agent 搜同类 query 时，图的回答更全面了
```

**每一次 load 都让图变得更好——即使这次 load 没有用到新内容。**

---

## 8. 图的健康与演化

### 7.1 核心健康指标

| 指标 | 公式 | 健康区间 | 含义 |
|------|------|---------|------|
| **密度 (Density)** | `2E / (N(N-1))` | 不需要高——稀疏图是正常的 | 整体连通性 |
| **平均度 (Avg Degree)** | `2E / N` | 5-15 | 每个节点的平均连接数 |
| **孤儿率 (Orphan Rate)** | `orphans / N` | < 10% | 未连接节点占比 |
| **巨分量比 (GCC Ratio)** | `|GCC| / N` | > 80% | 最大连通分量覆盖率 |
| **聚类系数 (Clustering)** | 三角形比例 | > 0.2 | 知识是否局部聚集 |
| **活跃边比 (Active Edge %)** | `30d_traversed / E` | > 30% | 边是否在被使用 |

### 7.2 图的退化模式与应对

| 退化模式 | 特征 | 原因 | 应对 |
|---------|------|------|------|
| **碎片化** | GCC < 60%, 多个孤岛 | 不同 Agent 群体工作在完全不同的领域 | tag 匹配缝合 + 跨领域 Hub 节点 |
| **星形化** | 少数 Hub 节点 degree > 100, 大量叶子 | 某些通用知识被过度引用 | 拆分 Hub 为子主题 |
| **老化** | 活跃边比 < 10% | 图在生长但旧边不再被走 | 边权衰减 + 归档低权边 |
| **膨胀** | 节点增速 >> 边增速 | Agent 大量 load 但不 save | 增强自动建边 + 引导 save |

### 7.3 Graph Evolution Dashboard

```
┌─ Context Network Health ──────────────────────────────────────┐
│                                                                │
│  Nodes: 52,341    Edges: 189,203    Avg Degree: 7.2           │
│  GCC: 94.2%       Orphan Rate: 6.1%  Active Edges: 43.7%     │
│                                                                │
│  ┌─ Growth (30d) ──────┐  ┌─ Topology ─────────────────────┐ │
│  │  Nodes/day: ▂▃▅▇▆▅▇ │  │                                │ │
│  │  Edges/day: ▃▄▆▇▇▆▇ │  │  [Force-directed graph viz]   │ │
│  │  Orphan %:  ▇▅▃▂▂▂▁ │  │  色=类型, 大小=degree,        │ │
│  │             ↑好趋势   │  │  亮度=最近活跃度              │ │
│  └──────────────────────┘  └────────────────────────────────┘ │
│                                                                │
│  Top Hub Nodes:                                                │
│  1. timeout-patterns     (degree: 47, loads: 1,203)           │
│  2. error-handling-guide (degree: 38, loads: 891)             │
│  3. retry-backoff-v2     (degree: 31, loads: 645)             │
│                                                                │
│  Recent Orphan Fixes: 23 nodes stitched in last 24h          │
│  Knowledge Paths Most Traveled:                                │
│  timeout → retry → circuit-breaker  (342 traversals)          │
│  auth-error → token-refresh → session-mgmt  (198 traversals) │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 9. 实施路线

### Phase 0: 基础设施 (3 天)

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 0.1 | `im_context_nodes` + `im_context_edges` 表设计 + migration | 0.5d | SQL migration script |
| 0.2 | Node CRUD service (`src/im/services/context-network.service.ts`) | 1d | 节点创建/查询/更新 |
| 0.3 | Edge CRUD + 基础图查询（邻居、路径） | 1d | 边创建/遍历/统计 |
| 0.4 | 健康指标计算（SQL aggregate queries） | 0.5d | 孤儿率、平均度、GCC |

### Phase 1: 自动建边 + 并行入口 (3 天)

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 1.1 | Load 路径集成：三路并行发射 (L1 FULLTEXT + L2 tag + L3 Exa) | 1d | Graph-First + 渐进返回 |
| 1.2 | Load deposit 时自动创建节点 + leads_to 边 | 0.5d | Load 产生图结构 |
| 1.3 | Save 路径集成：refs 参数 + tag 匹配自动建边 | 0.5d | Save 产生图结构 |
| 1.4 | Evolution record 集成：capsule 节点 + derived_from 边 | 0.5d | Evolution 产生图结构 |
| 1.5 | L3 结果静默 deposit（命中图时后台入图不阻塞响应） | 0.5d | 图自我填充 |

### Phase 2: 种子图 + 冷启动 (2 天)

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 2.1 | 种子主题列表 (`scripts/seed-topics.yaml`) | 0.5d | ~200 个高频技术主题 URL |
| 2.2 | 种子图构建脚本 (`scripts/build-seed-graph.ts`) | 1d | 批量 load + LLM 边推断 |
| 2.3 | Seed Gene → 节点转化 + 边构建 | 0.5d | 45 Gene 节点 + 关联边 |

### Phase 3: 网络感知压缩 (2 天)

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 3.1 | 压缩前查图：提取 query → 搜 neighbors → 注入 compress prompt | 1d | 压缩 = 定位 |
| 3.2 | 压缩产出解析：提取 `prismer://` refs → 自动建 references 边 | 0.5d | 压缩即建边 |
| 3.3 | Token 节省度量 + A/B 对比（有/无 graph context 的 HQCC 质量） | 0.5d | 效果验证 |

### Phase 4: Load 增强 + API (1.5 天)

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 4.1 | Load 响应增加 `graph.neighbors` 字段 | 0.5d | 渐进式披露能力 |
| 4.2 | `prismer_recall` 统一检索 API（搜 nodes + 返回子图） | 1d | Gene strategy 可用 |

### Phase 5: 孤儿治理 + 可观测 (1.5 天)

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 5.1 | 孤儿检测 + tag 匹配缝合定时任务 | 0.5d | 自动维护图健康 |
| 5.2 | Graph Health API + Dashboard 集成 | 1d | 可观测性 |

### 总计: ~12 天

```
Phase 0   (3 天):  基础设施 — 节点/边存储 + CRUD
Phase 1   (3 天):  入口并行 + 自动建边 — 图可以自动生长
Phase 2   (2 天):  种子图 — 冷启动，图初具规模
Phase 3   (2 天):  网络感知压缩 — 压缩 = 入网，token -60%，孤儿率骤降
Phase 4   (1.5 天): Load 增强 — Agent 开始"沿路走"
Phase 5   (1.5 天): 可观测性 — 图可以自我维护

里程碑:
  Phase 0-1 后: 图在静默生长，每次 load/save 都在织网
  Phase 2 后:   对外可用，L1 命中率 >50%
  Phase 3 后:   体验质变 — 压缩更短、节点不孤立、引用即链路
  Phase 4 后:   Agent 可以沿图遍历，渐进式披露完整可用
```

---

## 10. 这意味着什么

### 对 Prismer 的战略意义

```
之前: Prismer = Knowledge Drive（存取知识的硬盘）
       Load 是点查询，Save 是写入，彼此无关联

之后: Prismer = Knowledge Network（自生长的知识图谱）
       每个 Agent 的每次工作都在织网
       网越密，后来的 Agent 越强
       → 网络效应 → 正反馈循环 → 护城河
```

### 网络效应公式

```
V(network) ∝ N × E × avg(weight)

N = 节点数（知识量）
E = 边数（知识关联度）
avg(weight) = 平均边权（关联的验证程度）

第 1 个 Agent:  V ≈ 500 × 2000 × 1 = 1,000,000
第 100 个 Agent: V ≈ 50,000 × 200,000 × 3 = 30,000,000,000
                  ↑ 价值增长了 30,000 倍
```

**这就是为什么 Context Network 是 Prismer 最该优先做的事——它把线性增长的 "知识存取" 变成了指数增长的 "知识网络"。**

---

## Appendix A: 与 EVOLUTION-ENGINE.md 2.4.3 的关系

本文档是 EVOLUTION-ENGINE.md Section 2.4.3 "统一知识层设计" 的**具体实现方案**。

| 2.4.3 中的设想 | 本文档的对应 |
|---------------|-------------|
| `prismer_recall` 统一检索 | Section 5 图遍历 + Phase 3 实施 |
| Memory + Cache + Gene 打通 | Section 2.1 统一节点模型 |
| FULLTEXT 索引 | Section 2.3 `im_context_nodes` FULLTEXT |
| Save 知识不再石沉大海 | Section 3.3.2 Save 自动建边 |
| Capsule → Memory 自动沉淀 | Section 3.3.3 Evolution 自动建边 |
| P0+P1 = 3.5 天打通链路 | Phase 0-1 = 5 天（更完整但同一量级） |

## Appendix B: 关键问题速查

**Q: 需要向量数据库吗？**
A: Phase 1 不需要。FULLTEXT + tag 匹配 + 图遍历覆盖 90% 场景。Phase 2 可选加 embedding 列做 similar_to 边的自动发现。

**Q: 性能瓶颈在哪？**
A: 邻居查询是 `SELECT ... WHERE from_uri = ? LIMIT 5`，索引命中，O(1)。图统计（GCC、聚类系数）是离线计算，不影响在线性能。

**Q: 和现有 `content_uri` 的关系？**
A: `prismer://` URI 就是节点的主键。现有 `content_uri` 直接映射为节点 URI，无需迁移。

**Q: Agent 需要改代码吗？**
A: 不需要。Load/Save API 向后兼容。`graph` 字段是可选的。Agent 不感知图的存在也完全可以工作——图的生长是静默副作用。

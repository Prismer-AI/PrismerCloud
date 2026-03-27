# EvoMap.ai 竞品分析

> Date: 2026-03-10 | Author: Claude Code Analysis

---

## 1. 产品概述

**EvoMap** 自称 "The Infrastructure for AI Self-Evolution"，核心是 **Genome Evolution Protocol (GEP)** — 一个 Agent-to-Agent 协议，让 AI Agent 发布经过验证的解决方案（Gene/Capsule），其他 Agent 可以继承这些方案。

**一句话总结：** Agent 遇到问题 → 生成修复策略(Gene) → 验证并打包(Capsule) → 发布到网络 → 其他 Agent 自动继承。

---

## 2. 核心概念映射

| EvoMap 概念                         | 生物学隐喻              | 等价于 Prismer               |
| ----------------------------------- | ----------------------- | ---------------------------- |
| **Gene**                            | DNA — 可复制的策略模板  | Evolution Gene (完全对应)    |
| **Capsule**                         | mRNA — 验证过的执行记录 | Evolution Capsule (完全对应) |
| **EvolutionEvent**                  | 蛋白质表达 — 实际执行   | Evolution Feed Event         |
| **GDI** (Global Desirability Index) | 适应度 — 多维质量评分   | 类似但我们没有统一指标       |
| **Node**                            | 生物个体                | Agent/IM User                |
| **Signal**                          | 环境刺激                | Error signal / Task trigger  |
| **Central Dogma**                   | Gene→RNA→Protein        | Signal→Gene→Outcome          |

**关键差异：** EvoMap 把 GDI 做成了统一排名指标（Quality 35% + Usage 30% + Social 20% + Freshness 15%），我们目前用散列的 metrics（success rate、execution count、stars 分开展示）。

---

## 3. 功能模块分析

### 3.1 Marketplace（对应我们的 Skills + Genes Tab）

**做得好的：**

- 类型过滤（Capsule / Gene / All）+ 策略分类（Repair / Optimize / Innovate）
- Semantic Search 搜索 — 不只是关键字，有语义匹配
- GDI 统一排名让用户一眼看出质量
- "Explore" 模式推荐低曝光高质量资产（解决长尾发现问题）
- Trust badge（Trusted / Under Review）建立信任

**做得不好的：**

- 卡片信息密度高但缺乏视觉层次 — 初看很乱
- 缺少安装/使用的一键操作 — 用户看到好东西但不知道怎么用
- 没有 "试用" 或 demo 功能

**对我们的启发：**

- ✅ 我们的 Skills 和 Genes 分开是对的 — 原始能力 vs 进化策略，概念更清晰
- ⚠️ 需要统一质量指标 — 类似 GDI 的综合评分
- ⚠️ 需要 "Explore" 模式推荐长尾内容

### 3.2 Biology Dashboard（对应我们的 Overview Tab）

**做得好的：**

- **Phylogenetic Tree** — 进化族谱可视化，节点可点击展开
- **Sankey Diagram** — Gene→Capsule→Event 流程可视化
- **Fitness Landscape** — 热力图展示不同策略组合的适应度
- **Shannon Diversity Index** — 生态多样性科学指标
- **Ecosystem Microscope** — 可拖拽探索的全景视图
- 多种专业生态指标：Species Richness, Evenness, Gini Coefficient

**做得不好的：**

- 过于学术化 — 普通用户看不懂 Shannon H'、Gini Coefficient
- 可视化很酷但 "so what?" — 看了不知道该做什么
- 没有引导行动的 CTA

**对我们的启发：**

- ✅ 我们的 "Signal→Gene→Outcome" 动画比 Sankey 更直观
- ✅ 我们的四步流程解释比学术指标更友好
- ⚠️ 可以借鉴 Phylogenetic Tree，但要简化（我们已经规划了 Gene Lineage Tree）
- ❌ 不要抄 Shannon Diversity 等学术指标 — 目标用户是开发者不是生态学家

### 3.3 Bounties（对应我们的 TODO/Future 悬赏系统）

**做得好的：**

- 清晰的状态流转：Open → Matched → Accepted → Expired
- Credit 激励机制闭环 — 悬赏 → Agent 竞争 → 最佳答案获奖
- **Swarm mode** — 复杂任务自动拆分为子任务
- Boost 机制 — 花更多 credit 提高可见性
- 2小时自动释放未领取任务

**做得不好的：**

- 空状态体验差 — 页面经常没有活跃悬赏
- 缺少任务模板 — 用户不知道怎么写好的悬赏

**对我们的启发：**

- ✅ 我们 Phase 4 的悬赏设计方向对了
- ⚠️ 悬赏和 Evolution 的连接要更紧密 — 解决悬赏 = 产生 Gene
- ⚠️ Boost 机制值得借鉴（花 credit 提高可见性）

### 3.4 Arena（我们没有对应功能）

**做什么的：** Agent vs Agent / Gene vs Gene 的竞技评测

- Elo 评分系统
- 多维度打分（AI Score, GDI Score, Execution Score, Community Score）
- Season 制度（赛季排名）

**对我们的启发：**

- 🔮 长期可以考虑，但不是 Phase 1-3 优先级
- 本质是 benchmark — 验证哪个 Gene 更好的机制
- 我们的 Timeline 已经记录了成功/失败，可以衍生出竞技对比

### 3.5 Knowledge Graph（我们没有对应功能）

**做什么的：** 语义搜索 + 实体关系图谱

- Neo4j 后端，网络可视化
- 自然语言查询：「How does auth middleware work?」
- 实体管理：手动添加知识实体和关系

**对我们的启发：**

- 🔮 不是当前优先级，但和我们的 Context API（知识处理）天然契合
- 未来可以把 Prismer 的 Context Cache 数据导入 KG

### 3.6 Reading Engine（类似我们的 Parse API + 悬赏）

**做什么的：** 输入 URL/文本 → 自动提取问题 → 批量创建悬赏

- 去重 + 缓存
- 批量 "Bounty All" 操作

**对我们的启发：**

- ✅ 这个和 Prismer 的 Context Load + Parse 能力高度匹配
- ⚠️ 可以考虑 "Load URL → Extract Questions → Create Bounties" 流水线

### 3.7 Leaderboard（对应我们的 Agents Tab）

**做得好的：**

- 三维排行：Nodes（Agent排名）+ Assets（Gene/Capsule排名）+ Contributors（贡献排名）
- GDI 统一评分

**做得不好的：**

- 当前页面比较空洞 — 功能有但内容不丰富
- Profile 页面比较弱

**对我们的启发：**

- ✅ 我们的 Agent Leaderboard 设计已经覆盖了核心需求
- ⚠️ 可以加 Asset（Gene）排行榜 — Top Genes by success rate

### 3.8 Sandbox（我们没有对应功能）

**做什么的：** 隔离的进化实验环境

- Soft isolation（标签隔离）+ Hard isolation（完全隔离）
- 适合做 A/B 测试：哪套 Gene 策略更优

**对我们的启发：**

- 🔮 和我们的 Park 概念有交集 — Park 的 Incubator 场景类似 Sandbox
- 长期可以考虑

---

## 4. 经济模型对比

| 维度         | EvoMap                             | Prismer                            |
| ------------ | ---------------------------------- | ---------------------------------- |
| **货币**     | Credits（平台内部）                | Credits（pc_credits / im_credits） |
| **初始赠送** | 注册 +100                          | 注册 +10,000                       |
| **消耗场景** | 发布资产、悬赏、KG查询             | 消息发送 (0.001/msg)               |
| **赚取方式** | 完成悬赏、资产被复用               | 暂无                               |
| **平台抽成** | 悬赏 15%，市场 30%                 | 暂无                               |
| **订阅**     | Free/Premium(2K cr)/Ultra(10K cr)  | 暂无                               |
| **GDI关联**  | 高GDI = 每次被 fetch 赚更多 credit | 无                                 |

**关键洞察：** EvoMap 的经济模型更成熟 — credit 不只是花的，还能通过贡献赚回来，形成闭环。我们的 credit 目前只是消耗品。

---

## 5. 技术栈对比

| 维度         | EvoMap                              | Prismer          |
| ------------ | ----------------------------------- | ---------------- |
| **前端**     | Next.js 14+                         | Next.js 16       |
| **样式**     | TailwindCSS                         | TailwindCSS 4    |
| **图数据库** | Neo4j (KG)                          | 无               |
| **协议**     | GEP (JSON-RPC 2.0)                  | REST + WebSocket |
| **认证**     | GEP 无需 API Key                    | API Key + JWT    |
| **国际化**   | i18next（EN/CN/TW/JP）              | 无               |
| **主题**     | 6种主题变体                         | 深色主题         |
| **AI辅助**   | `/llms.txt`, `/ai-nav`, `/skill.md` | MCP Server       |

---

## 6. UI/UX 设计对比

### EvoMap 做对的事

1. **Protocol-first**：不需要 API Key，降低接入门槛
2. **多视角**：Biology Dashboard 提供宏观视角，Marketplace 提供微观视角
3. **游戏化**：Elo 评分、赛季制度、声望等级
4. **开放给 AI**：`/llms.txt` 和 `/ai-nav` 让 AI Agent 可以自主导航

### EvoMap 做错的事

1. **过度复杂**：页面太多（~20个），概念太多，新用户迷路
2. **学术化**：Shannon H'、Gini Coefficient — 开发者不关心这些
3. **空洞感**：很多页面有功能但缺乏内容（Arena 没有活跃赛季、KG 空白）
4. **视觉混乱**：6种主题 + 密集信息 = 认知超载
5. **没有 "故事"**：用户看完不知道"谁在用？效果怎样？"

---

## 7. 对 EVOLUTION-REDESIGN.md 的审视建议

基于以上分析，对我们现有设计的建议：

### 7.1 已经做对的（保持）

- ✅ **5-Tab 结构**比 EvoMap 的 20+ 页面更聚焦
- ✅ **Signal→Gene→Outcome 动画**比 Sankey Diagram 更直观
- ✅ **Skills 和 Genes 分离**概念更清晰
- ✅ **四步流程卡片**比学术指标更友好
- ✅ **Timeline 时间线**是 EvoMap 缺失的维度
- ✅ **战报卡片 + Badge**比 EvoMap 的社交策略更好（它没有分享机制）

### 7.2 需要新增/改进的

| #   | 建议                        | 原因                                                                            | 优先级  |
| --- | --------------------------- | ------------------------------------------------------------------------------- | ------- |
| 1   | **统一质量指标 (类似 GDI)** | EvoMap 的 GDI 让用户一眼判断质量，我们的 success rate + installs + stars 太分散 | Phase 2 |
| 2   | **"Explore" 长尾发现模式**  | 5,455 个 Skill 中大部分不会被看到，需要 "高质量低曝光" 推荐                     | Phase 2 |
| 3   | **Gene/Skill Trust Badge**  | "Verified" / "Community" / "Experimental" 标签建立信任层级                      | Phase 1 |
| 4   | **Trending 动态排行**       | Overview Tab 缺少实时动态感，加 "Trending This Week" 区块                       | Phase 1 |
| 5   | **Gene 对比视图**           | Arena 的核心价值是对比 — 简化版：两个 Gene 并排比较                             | Phase 3 |
| 6   | **阅读引擎集成**            | Load URL → Extract Signals → Suggest Genes 的闭环                               | Phase 4 |
| 7   | **Credit 闭环**             | Gene 被采用时创建者赚 credit，形成正向激励                                      | Phase 3 |
| 8   | **Asset 生命周期**          | Gene 不应永远存在 — 长期不用的自动衰减可见性（Natural Selection）               | Phase 3 |

### 7.3 明确不做的

| 功能                         | 原因                                                   |
| ---------------------------- | ------------------------------------------------------ |
| 独立 KG 页面                 | 我们的 Context API 是更好的知识处理方案，不需要另建 KG |
| Shannon Diversity 等学术指标 | 目标用户是开发者，不是生态学家                         |
| 6种主题变体                  | 增加维护负担，深色主题足够                             |
| 独立 Arena 页面              | 功能太重，Gene Comparison 足以满足需求                 |
| GEP 协议                     | 我们有自己的 IM + REST 协议，不需要再造协议            |
| Sandbox 独立页面             | Park 的 Incubator 场景已覆盖实验需求                   |

---

## 8. 总结

**EvoMap 的核心优势：** 概念体系完整（生物学隐喻贯穿始终）、经济闭环成熟、协议标准化
**EvoMap 的核心弱点：** 过度复杂、页面空洞、学术化严重、缺乏故事和时间维度

**Prismer 的差异化机会：**

1. **更简洁的信息架构** — 5 Tab vs 20 pages
2. **时间维度** — Timeline 是我们独有的（EvoMap 没有时间线）
3. **社交传播** — 战报卡片 + Badge 是我们独有的
4. **Park 联动** — Agent 在场景中活动 → 产生 Gene → Evolution 展示，闭环比 EvoMap 更紧
5. **SDK 生态** — MCP Server + OpenClaw Plugin 已有的集成优势

**核心策略：不要追 EvoMap 的广度，打 EvoMap 的盲区：时间感、故事性、社交传播、可操作性。**

---

_This analysis is based on evomap.ai content accessed on 2026-03-10._

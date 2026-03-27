# Evolution Map — PRD v2.0

> **Version:** 3.1
> **Date:** 2026-03-19
> **Status:** 设计收敛
> **前置:** EVOLUTION-MAP-30-QUESTIONS.md（35 个设计问题）+ 产品评审反馈
> **核心身份:** Graph 就是 Map 的身份——永远是图，冷启动也是图

---

## 1. 为什么需要 Map Tab

Library 是货架——按品类排列的 Gene 卡片。Feed 是时间线——按时间排列的事件流。My Evolution 是个人仪表盘。

**Map 是唯一能回答这个问题的页面：** "这个策略知识网络长什么样？哪里密集（成熟领域）、哪里稀疏（未探索）、哪里正在生长（活跃进化）？"

这是图才能做的事。卡片做不了，列表做不了，数字做不了。

**价值主张：看到策略知识网络的形状和生长方向。**

---

## 2. 一种模式，优雅降级

不做三种模式切换。Map 永远是一张图。区别只在于图的密度和叠加的引导层。

### 2.1 冷启动（capsules < 10）

图是稀疏的——45 个 seed gene 分散在画布上，虚线连接，没有粒子。但**图的骨架存在**。

在图之上叠加一个半透明的引导卡片（不替代图，叠加在图上方）：

```
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│  [Graph 在背景：稀疏的 seed gene 网络，虚线，呼吸脉动]       │
│                                                               │
│      ┌───────────────────────────────────────────────┐       │
│      │                                               │       │
│      │  Agents learn from success and failure.       │       │
│      │  Install a gene. Run your agent.              │       │
│      │  Watch this network light up.                 │       │
│      │                                               │       │
│      │  ⬡ Timeout Recovery    ○ Rate Limit Backoff   │       │
│      │    [Install]             [Install]             │       │
│      │                                               │       │
│      │  ◇ Code Refactor       ⬡ Auth Refresh         │       │
│      │    [Install]             [Install]             │       │
│      │                                               │       │
│      │             [Get Started →]                    │       │
│      │                                               │       │
│      └───────────────────────────────────────────────┘       │
│                                                               │
│  [stats: 0 executions · 45 seed genes · 0 agents]            │
└──────────────────────────────────────────────────────────────┘
```

引导卡片可以被关闭（dismiss）。关闭后用户看到完整的稀疏图。

### 2.2 成长期（10-99 capsules）

引导卡片消失。图开始有差异——执行过的 edge 变实线、有粒子流动、Gene 节点按使用量变大。

顶部出现一条故事横幅（可折叠）：

```
┌──────────────────────────────────────────────────────────────┐
│ ⚡ 2m ago: market-analyst → Timeout Recovery → ✅ 79%  [×]   │
│──────────────────────────────────────────────────────────────│
│                                                               │
│  [Graph：部分 edge 变实线，部分有粒子，节点大小有差异]       │
│                                                               │
│       ●────═══════▶ ⬡ Timeout Recovery (大)                 │
│   error:timeout       ✅ 79% · 18 runs                       │
│       ●────────────▶ ⬡ Auth Refresh (中)                    │
│   error:auth          ✅ 80% · 5 runs                        │
│                                                               │
│       ●── ─ ─ ─ ─ ▷ ○ Rate Limit Backoff (小)              │
│   error:429           (虚线=未验证)                           │
│                                                               │
│  [stats: 47 executions · 12 active genes · 3 agents]         │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 成熟期（100+ capsules）

图充分展开——多个 domain 聚类可见，热门路径粗且亮，探索前沿虚线仍在边缘。

```
┌──────────────────────────────────────────────────────────────┐
│ ⚡ just now: code-reviewer → Auth Refresh → ❌  [×]          │
│──────────────────────────────────────────────────────────────│
│                                                               │
│     error cluster              network cluster               │
│     ⬡ ⬡ ○ ⬡                  ⬡ ○ ⬡ ○                      │
│       ⬡ ◇ ○                    ⬡ ⬡ ○                        │
│            \                   /                              │
│             ●── shared signal ●                               │
│            /                   \                              │
│     ⬡ ⬡ ○ ⬡ ○               ⬡ ◇ ○ ⬡                      │
│     task cluster               data cluster                  │
│                                                               │
│  [stats: 1,234 executions · 45 genes · 12 agents · 82%]     │
└──────────────────────────────────────────────────────────────┘
```

**关键：三个阶段是同一张图的三种密度，不是三种不同的 UI。** 用户的心智模型始终是"我在看一张图"。

---

## 3. 用户旅程

### 3.1 第一次访问（Day 0，访客）

1. 打开 /evolution → 默认在 Map tab
2. 看到一张稀疏但有结构的图（seed gene 网络）+ 半透明引导卡片
3. 引导卡片上有 4 个精选 Gene + Install 按钮 + "Get Started"
4. 点击 Gene 卡片 → 跳转到 Library 详情页
5. 点击 Get Started → 跳转注册
6. 图在背景有轻微呼吸脉动——这不是一张静态图片，是活的

**Map 的角色：** 第一印象——"这个系统有一张知识网络在等着被激活"

### 3.2 第一次使用（Day 1，开发者）

1. 已注册，装了一个 Gene，跑了 agent
2. 回到 Map → 引导卡片消失
3. 看到自己触发的那条 edge 从虚线变成了实线 + 粒子在流
4. 顶部故事横幅："your-agent → Timeout Recovery → ✅"
5. 点击那个 Gene 节点 → 右侧弹出详情面板（策略步骤、成功率）

**Map 的角色：** 正反馈——"我的行为让网络变亮了一点"

### 3.3 持续使用（Day 7+）

1. 多个 edge 变实线，节点大小有明显差异
2. 能看到"哪些路径是热门的（粗线）、哪些还没人试过（虚线）"
3. SSE 推送实时事件——别人的 agent 也在贡献，涟漪在闪
4. hover 一个 Gene → 高亮所有关联 signal，dim 其余

**Map 的角色：** 态势感知——"我能看到网络在生长"

### 3.4 长期使用（Day 30+，100+ capsules）

1. 图有了明显的 domain 聚类（error 系的 Gene 聚在一起，task 系的在另一边）
2. 可以缩放——zoom out 看全局聚类，zoom in 看单个 Gene 的详情
3. 探索前沿（虚线边缘）指示"还有什么领域没有 Gene 覆盖"

**Map 的角色：** 战略地图——"我能看到知识网络的形状和盲区"

---

## 3.5 索引系统与 Skill-Gene 整合

### 3.5.1 索引作为导航基础设施

维度导航必须有索引支撑。没有索引，用户只能靠视觉扫描——在 3 个 cluster 时可以，30 个 cluster 时不行。

```
索引入口（D1 顶部搜索栏）:

  输入 "timeout"
    → 匹配 Gene:  Timeout Recovery, Retry Handler, ...
    → 匹配 Signal: error:timeout, error:ETIMEDOUT, ...
    → 匹配 Skill:  "API Retry Skill", "Connection Pool Manager", ...（通过 Skill→Signal 关联）
    → 结果: 高亮包含这些实体的 cluster → Enter 跳入 D2

  输入 "openai"
    → 匹配 Signal: error:timeout (provider:openai), error:rateLimit (provider:openai)
    → 匹配 Gene:  连接到这些 Signal 的 Gene
    → 匹配 Skill:  经常触发 openai 相关 Signal 的 Skill
    → 结果: 跳到对应 cluster

  索引覆盖:
    Gene:   id, title, category, signals_match[].type
    Signal: key, type, provider, stage
    Skill:  name, description, category, tags + 关联的 Signal 域
```

搜索结果不是列表——是**图上的高亮**。匹配的实体发光，不匹配的 dim。这保持了 Map 的身份（始终是图），同时提供了精确导航。

### 3.5.2 Skill 与 Gene 的关系

**它们在不同的语义空间操作：**

|                  | Skill                     | Gene                                      |
| ---------------- | ------------------------- | ----------------------------------------- |
| **语义空间**     | 能力空间（what I can do） | 问题空间（what to do when X）             |
| **数据量**       | 12,489                    | 2,253                                     |
| **分类质量**     | 差（99.6% 是 general）    | 好（repair/optimize/innovate/diagnostic） |
| **有执行反馈？** | ❌                        | ✅（α, β, success rate）                  |
| **进化？**       | ❌（静态声明）            | ✅（Thompson Sampling + Pooled Prior）    |

**连接桥梁：Skill → Signal 关联。**

当 Agent 使用 Skill X 执行任务时遇到的问题（Signal）构成了一条隐式关联。如果 Skill "Image Generation via OpenRouter" 的用户在执行时频繁触发 `error:rateLimit(provider:openai)`，这条 Skill→Signal 关联被统计建立。

```
建立方式（不需要新表，利用已有数据）:

  im_evolution_capsules 表已有:
    - ownerAgentId（谁在跑）
    - signalKey（遇到了什么）
    - geneId（用了什么策略）
    - metadata（可存 skill context）

  扩展: capsule.metadata 加入 { triggeredBySkill: "skill_id" }（SDK 自动填充）

  查询:
    SELECT skill_id, signal_type, COUNT(*) as frequency
    FROM capsules
    WHERE metadata->>'triggeredBySkill' IS NOT NULL
    GROUP BY skill_id, signal_type
    ORDER BY frequency DESC
    → Skill X 经常遇到 error:timeout（n=47）
```

### 3.5.3 整合后 Map 的变化

**D1 全景——cluster 语义升级：**

不再只是 Gene category 分组。Cluster 变为 **Signal 域**——每个 cluster 是一组相似的问题（error:timeout、error:rateLimit、task:refactor...），里面同时包含：

- **Gene**（解决这类问题的策略）——有进化数据，是核心
- **Skill**（经常遇到这类问题的能力）——是上下文，帮助理解"谁在用"

```
D1 cluster 展示变化:

  旧: [repair] 1070 genes
  新: [error:timeout] 23 genes · 147 skills affected · 89% avg success

  旧: 按 Gene category 分组
  新: 按 Signal type 分组（error:timeout, error:rateLimit, task:refactor...）
```

**D2 领域——Skill 作为上下文层：**

```
D2 (Domain: error:timeout)

  ── Strategies (Genes) ──          ── Affected Skills ──
  ⬡ Timeout Recovery  94%          📦 Image Generation    触发 47×
  ⬡ Retry Handler     67%          📦 Web Scraper         触发 23×
  ○ Connection Pool    82%          📦 API Integration     触发 15×

  Gene 是主角（可点击→D3）
  Skill 是配角（显示为标签或侧栏列表，点击→Library 详情）
```

**反向优化 Skill：**

当一个 Skill 持续触发某个 Signal 且对应的 Gene 成功率高时：
→ 在 Skill 详情页标注 "Works best with: Timeout Recovery Gene"

当一个 Skill 持续触发某个 Signal 且对应的 Gene 成功率低时：
→ 在 Skill 详情页标注 "⚠ Frequently triggers error:timeout — consider adding retry logic"

**Skill 自然聚类：**

不靠人工打标签（12439 个 general 证明人工分类失败了）。靠 Signal 关联自动聚类——经常触发 `error:timeout + error:rateLimit` 的 Skill 自然聚在 "network reliability" 域，经常触发 `task:refactor` 的 Skill 聚在 "code quality" 域。

这比任何人工分类都准确，因为它基于实际执行数据而不是作者的自我描述。

---

## 4. 维度层级（Dimensional Levels）

> **设计原则：** 缩放不是连续的滑块，而是**离散的观察维度**。每个维度回答不同粒度的问题。用户始终"在某一层"操作——搜索、跳转、查看、切换——而不是在无极缩放中迷路。
>
> **类比：** 人类基因组浏览器（UCSC Genome Browser）不是一个可以无限缩放的图——它有明确的层级：染色体 → 基因组区段 → 单个基因 → 碱基序列。每层有自己的搜索、标注、导航。我们的进化图谱同理。

### 4.1 三个维度

| 维度                        | 类比                | 看到什么                                                           | 回答什么问题                               | 操作能力                                             |
| --------------------------- | ------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| **D1: 全景（Landscape）**   | 染色体核型图        | 所有 Signal 域 cluster 的分布 + 热力密度                           | "进化覆盖了哪些问题域？哪里成熟哪里荒芜？" | 搜索 → 高亮；点击 cluster → 进入 D2                  |
| **D2: 领域（Domain）**      | 基因组区段          | 单个 Signal 域内的 Gene + Signal + Edge + 关联 Skill               | "这个问题域有哪些策略？哪些 Skill 在用？"  | 点击 Gene → 进入 D3；hover → tooltip；← → 切换相邻域 |
| **D3: 策略（Gene Detail）** | 单个基因 + 调控元件 | 单个 Gene + 所有连接的 Signal + 每条 Edge 的 β 分布 + 最近执行历史 | "这个 Gene 好不好用？在什么情景下有效？"   | 查看策略步骤；Install/Fork/Share；查看 capsule 历史  |

### 4.2 维度间的导航

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│  D1 (Landscape)                                          │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐               │
│  │error │  │task  │  │network│  │data  │               │
│  │ ••••••│  │ ••   │  │ •••• │  │ •    │               │
│  │ •••• │  │ •    │  │ ••   │  │      │               │
│  └──┬───┘  └──────┘  └──┬───┘  └──────┘               │
│     │                    │                               │
│     ▼ click              ▼ click                         │
│  ┌──────────────────────────────────────────┐           │
│  │ D2 (Domain: error)                        │           │
│  │                                           │           │
│  │   ●───══▶ ⬡ Timeout Recovery  94%        │           │
│  │ timeout    ════▶ ⬡ Retry Handler  67%     │           │
│  │   ●───══▶ ⬡ Auth Refresh  80%            │           │
│  │ auth       ──▷ ○ Token Cache  (探索)      │           │
│  │                                           │           │
│  │  [← task]  error  [network →]             │  ← 横向切换│
│  └──────────────────┬───────────────────────┘           │
│                     │ click Gene                         │
│                     ▼                                    │
│  ┌──────────────────────────────────────────┐           │
│  │ D3 (Gene: Timeout Recovery)               │           │
│  │                                           │           │
│  │  ⬡ Timeout Recovery            repair     │           │
│  │  ████████████░░ 94.2%  (148/157)          │           │
│  │  12 agents · PQI 82                       │           │
│  │                                           │           │
│  │  Strategy:                                │           │
│  │  1. Increase timeout to 30s               │           │
│  │  2. Retry with exponential backoff        │           │
│  │  3. Fall back to cached response          │           │
│  │                                           │           │
│  │  ── Connected Signals ──                  │           │
│  │  ● error:timeout (openai)  rw=0.92  18×   │           │
│  │  ● error:timeout (mysql)   rw=0.71   5×   │           │
│  │  ● error:ETIMEDOUT         rw=0.45   2×   │           │
│  │                                           │           │
│  │  ── Recent Capsules ──                    │           │
│  │  ✅ 2m ago market-analyst 76%→79%         │           │
│  │  ❌ 8m ago code-reviewer  81%→79%         │           │
│  │                                           │           │
│  │  [Install]  [Fork]  [Share]               │           │
│  └──────────────────────────────────────────┘           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 4.3 维度内的自由度

每个维度内**不是固定画面**——有有限的缩放和平移自由度，但不会越过维度边界。

```
D1 (Landscape):
  缩放范围: 0.5x - 1.5x（看到更多/更少 cluster 细节，但不会进入 D2）
  平移: 自由
  内容: cluster 块，块内节点以密度热力图或点云呈现
  搜索: 输入 Gene 名或 Signal → 高亮包含它的 cluster → 点击进入

D2 (Domain):
  缩放范围: 0.7x - 2.0x（看到更多 edge 细节，但不会进入 D3）
  平移: 自由（限定在当前 cluster 区域 + padding）
  内容: Gene 节点（形状+名称+成功率弧）、Signal 节点（点+标签）、Edge（线+粒子）
  导航: ← → 箭头切换相邻 cluster（带 slide 过渡动画）

D3 (Gene Detail):
  缩放: 无（固定大小，内容靠滚动）
  呈现: 不再是 Canvas——是一个 HTML 面板（右侧或全屏）
  内容: 完整的 Gene 信息 + 连接 Signal 列表 + 最近 Capsule 历史
  返回: 点击 ← 或 Esc → 回到 D2
```

### 4.4 维度切换动画

维度切换必须**平滑且目标不丢失**——用户在 D1 点击 error cluster，飞入 D2 时应该看到 error cluster 展开而不是跳变。

```
D1 → D2 (点击 cluster):
  1. 被点击的 cluster 放大（300ms ease-out），其他 cluster fade out（200ms）
  2. cluster 内的节点从密集态展开到力导向布局（400ms spring）
  3. 最终停在 D2 的标准视图——cluster 内的 Gene+Signal 完整展示
  总时长: ~500ms（并行动画）

D2 → D1 (点击 ← 或 pinch out 超过阈值):
  1. 当前 cluster 的节点收缩回密集态（300ms ease-in）
  2. 其他 cluster fade in（200ms）
  3. 最终停在 D1 的全景
  总时长: ~400ms

D2 → D3 (点击 Gene):
  1. 被点击的 Gene 节点放大到 Focus 态（250ms）
  2. 右侧/底部面板 slide-in（250ms）
  3. Gene 的连接 Signal 和 Edge 高亮，其余 dim
  总时长: ~300ms

D3 → D2 (Esc 或 ← 或 swipe back):
  1. 面板 slide-out（200ms）
  2. 节点恢复标准大小（200ms）
  3. dim 恢复
  总时长: ~250ms

D2 横向切换 (← → 切换 cluster):
  1. 当前 cluster slide-out 向切换方向（300ms）
  2. 新 cluster slide-in 从对面（300ms）
  3. 力导向布局快速稳定（100ms，因为已经预计算）
  总时长: ~350ms（slide 是并行的）
```

### 4.5 维度切换的触发方式

| 操作                       | 效果                                    | 回退    |
| -------------------------- | --------------------------------------- | ------- |
| **D1: 点击 cluster**       | → D2 (该 cluster)                       | —       |
| **D1: 搜索 Gene/Signal**   | → D2 (包含结果的 cluster)，结果节点高亮 | —       |
| **D2: 点击 Gene**          | → D3 (该 Gene 详情)                     | Esc / ← |
| **D2: ← → 箭头**           | → D2 (相邻 cluster)                     | —       |
| **D2: pinch out 超过阈值** | → D1                                    | —       |
| **D3: Esc / ← / swipe**    | → D2                                    | —       |
| **任何维度: 故事横幅点击** | → D2/D3 (事件所在的 Gene)               | —       |
| **任何维度: 键盘 Cmd+0**   | → D1 (回到全景)                         | —       |

### 4.6 为什么是 3 级不是 2 级也不是 4 级

**不是 2 级：** 2 级（Overview + Focus）缺少"领域"这一层——用户无法回答"error 领域有哪些策略可以用"这个中观问题。要么看全图（太密集），要么看单个 Gene（太孤立）。

**不是 4 级：** 旧设计的 L4（银河全貌）和 L1（地球+月亮）之间跨度太大，中间的 L2/L3 边界模糊。3 级的每一级有**明确的观察单元**（cluster / gene+signal / gene detail），不会有"我在哪一级"的困惑。

**3 级 = 3 个不同的问题：**

- D1: "网络长什么形状？" → 答案是 cluster 分布
- D2: "这个领域有什么？" → 答案是 gene-signal 图
- D3: "这个策略好不好用？" → 答案是数据 + 历史

---

## 5. 视觉设计

### 5.1 节点（按维度）

| 元素            | D1 (Landscape)                                   | D2 (Domain)                                       | D3 (Detail)                |
| --------------- | ------------------------------------------------ | ------------------------------------------------- | -------------------------- |
| **Gene**        | 点（3-6px，形状不可见）                          | 形状(⬡/○/◇) + 名称 pill + 大小 by totalExecutions | HTML 卡片（完整信息）      |
| **Signal**      | 不可见（合并进 cluster 密度）                    | 小点(3-8px) + 类别色，hover 显示标签              | 列表行（key + rw% + 频率） |
| **Edge**        | 不可见（cluster 间用粗连线表示跨域连接）         | 贝塞尔曲线 + 颜色 + 粗细 + 粒子                   | 列表行（β 分布 + 历史）    |
| **Cluster**     | 圆角矩形区块 + 标签 + 密度色（深=活跃，浅=稀疏） | 当前 cluster 展开，标签在顶部                     | —                          |
| **冷启动 Gene** | 半透明点                                         | 虚线轮廓 + 描边脉动(opacity 0.2↔0.35)             | "awaiting first run" 标签  |

Gene 形状：

- Repair = 六边形（⬡），橙色 `#f97316`
- Optimize = 圆（○），青色 `#06b6d4`
- Innovate = 菱形（◇），紫色 `#8b5cf6`

大小公式：`radius = 16 + min(totalExecutions / 3, 16)` → 范围 [16, 32]px

### 5.2 边

| 属性   | 编码                                     |
| ------ | ---------------------------------------- |
| 线宽   | `1 + log2(totalObs + 1) * 1.2` px        |
| 颜色   | routingWeight: 红(0) → 黄(0.5) → 绿(1.0) |
| 透明度 | `0.15 + min(totalObs / 30, 0.6)`         |
| 线型   | 实线(totalObs ≥ 10) / 虚线(< 10)         |
| 粒子   | 有执行记录的 edge 才有粒子流             |

### 5.3 引导叠加层

冷启动时叠加在 Graph 上方的半透明卡片：

- 背景：`bg-zinc-900/80 backdrop-blur-xl`（暗色），`bg-white/80 backdrop-blur-xl`（亮色）
- 位于画布正中
- 右上角有 × 按钮可关闭
- 关闭后存入 localStorage，下次不再显示

### 5.4 故事横幅

```
高度: 40px
背景: 深色半透明
内容: ⚡ {time} ago: {agent} → {gene} → {outcome emoji} {delta}%
右侧: [×] 折叠按钮
动画: 新故事到达时滑入(300ms ease-out)
```

---

## 6. 布局算法

### 6.1 力导向（保留，去掉 Louvain）

当前的力导向模拟完全保留——400 次迭代、charge repulsion、spring attraction。

聚类力：按 `gene.category` 分组（repair/optimize/innovate），同组 Gene 有弱吸引力。不用 Louvain——category 分组在 <200 节点时效果等价且零计算成本。

### 6.2 Signal 定位

Signal 节点被 edge 的 spring 力自然拉到关联 Gene 附近。不需要轨道模型——力导向天然实现了"Signal 围绕 Gene"的效果。

---

## 7. 交互

### 7.1 按维度的交互

**D1 (Landscape):**

| 操作              | 效果                                                 |
| ----------------- | ---------------------------------------------------- |
| **拖拽**          | 平移全景                                             |
| **滚轮**          | D1 内微缩放（0.5x-1.5x），不跨维度                   |
| **Hover cluster** | cluster 轮廓发光 + tooltip（gene 数量, 活跃度）      |
| **Click cluster** | **→ D2**（展开动画）                                 |
| **搜索框输入**    | 匹配 Gene/Signal → 高亮目标 cluster → Enter **→ D2** |
| **Cmd+0**         | 回到默认视角（全部 cluster 居中）                    |

**D2 (Domain):**

| 操作                       | 效果                                             |
| -------------------------- | ------------------------------------------------ |
| **拖拽**                   | 平移（限定在 cluster 区域 + padding）            |
| **滚轮**                   | D2 内微缩放（0.7x-2.0x），不跨维度               |
| **Hover Gene**             | 高亮关联 Signal 和 Edge，dim 其余                |
| **Hover Edge**             | tooltip（routing weight %, totalObs, last used） |
| **Click Gene**             | **→ D3**（详情面板展开）                         |
| **← → 箭头 / swipe**       | 切换到相邻 cluster（slide 动画）                 |
| **Pinch out 超阈值 / Esc** | **→ D1**                                         |

**D3 (Gene Detail):**

| 操作                      | 效果                                          |
| ------------------------- | --------------------------------------------- |
| **滚动**                  | 面板内滚动（策略、Signal 列表、Capsule 历史） |
| **Click Signal 行**       | **→ D2** 并高亮该 Signal 的所有连接           |
| **Click Install**         | 跳转 Library / 触发安装流程                   |
| **Esc / ← / swipe right** | **→ D2**                                      |

### 7.2 D3 详情面板

D3 **不是 Canvas 渲染**——是 HTML 面板（桌面: 右侧 320px，平板: 底部 sheet，手机: 全屏 modal）。

内容结构：

```
┌─────────────────────────────────┐
│ ← Back to [cluster name]        │  ← 返回 D2
│                                  │
│ ⬡ Timeout Recovery      repair  │  ← 形状 + 名称 + category
│ ████████████░░ 94.2%             │  ← 成功率条
│ "Based on 157 runs, we're 95%   │  ← Beta 可信区间自然语言
│  confident the true success      │
│  rate is between 90.1% and 97.2%"│
│                                  │
│ 12 agents · PQI 82 · 157 runs   │
│                                  │
│ ── Strategy ──                   │
│ 1. Increase timeout to 30s       │
│ 2. Retry with exponential backoff│
│ 3. Fall back to cached response  │
│                                  │
│ ── Signals (3) ──                │
│ ● error:timeout (openai) rw=92%  │  ← click → D2 高亮
│ ● error:timeout (mysql)  rw=71%  │
│ ● error:ETIMEDOUT        rw=45%  │
│                                  │
│ ── Recent (5) ──                 │
│ ✅ 2m ago  market-analyst  +3%   │
│ ❌ 8m ago  code-reviewer   -2%   │
│ ✅ 1h ago  data-pipeline   +1%   │
│                                  │
│ [Install]  [Fork]  [Share 📤]   │
└─────────────────────────────────┘
```

### 7.3 SSE 实时事件

```
evolution:capsule 事件到达:
1. Signal 节点涟漪（成功=绿，失败=红）
2. Edge 上高亮粒子飞行
3. Gene 节点闪烁
4. 顶部故事横幅更新
```

### 7.4 移动端

| 手势     | 操作                       |
| -------- | -------------------------- |
| 单指拖拽 | 平移                       |
| 捏合     | 缩放                       |
| 点击     | 选中（替代 hover + click） |
| 双击     | Focus                      |

---

## 8. 竞品参照

| 竞品                          | 借鉴点                                     | 不借鉴                   |
| ----------------------------- | ------------------------------------------ | ------------------------ |
| **Netflix Vizceral**          | 粒子沿连线流动编码流量；三层渐进披露       | WebGL 渲染（我们不需要） |
| **OneZoom 生命之树**          | 语义缩放——放大时细节按需加载               | 分形几何（太学术）       |
| **GitHub Contribution Graph** | 颜色深浅编码活跃度；一眼看出稀疏和密集区域 | 固定网格布局             |
| **Figma Community**           | 卡片 → 详情的流畅过渡                      | —                        |

**核心借鉴：** Vizceral 的粒子流 + GitHub 的密度直觉 + OneZoom 的按需细节。

---

## 9. 技术实现

### 9.1 组件结构

```
src/components/evolution/
├── evolution-map.tsx              ← 容器：fetch 数据 + 决定叠加层
│
├── map-canvas.tsx                 ← Canvas 渲染（Graph 始终存在）
│   └── canvas/
│       ├── layout/                ← 力导向 + category 分组
│       ├── renderer/              ← Gene/Signal/Edge/Particle/Ghost
│       └── interaction/           ← hit test / hover / zoom / pan
│
├── overlays/
│   ├── cold-start-overlay.tsx     ← 冷启动引导卡片（叠加在 Canvas 上）
│   └── story-banner.tsx           ← 顶部故事横幅（可折叠）
│
├── detail-panel/
│   └── map-detail-panel.tsx       ← 右侧弹出详情
│
└── types/
    └── evolution-map.types.ts     ← 类型定义
```

### 9.2 渲染管线

```
每帧：
1. Clear canvas
2. 背景点网格
3. Edges（贝塞尔曲线 + 颜色 + 透明度 + 虚线）
4. Particles（沿 edge 流动）
5. Signal 节点（圆点 + hover 标签）
6. Gene 节点（形状 + 名称 + 成功率弧）
7. Ghost 节点（视口边缘，12% 透明度）
8. Ripples（SSE 事件触发）
9. Stats bar（底部屏幕空间）
```

叠加层（cold-start overlay、story banner）是 HTML DOM，不在 Canvas 中——CSS `position: absolute` 覆盖在 Canvas 上方。

### 9.3 数据获取策略

```typescript
// 总是获取 stats（轻量，决定叠加层）
const stats = await fetch('/api/im/evolution/public/stats');

// 总是获取 map data（Graph 始终渲染）
const mapData = await fetch('/api/im/evolution/map');

// 有数据时获取 stories（故事横幅用）
if (stats.totalExecutions > 0) {
  const stories = await fetch('/api/im/evolution/stories?limit=3');
}

// 冷启动时获取精选 Gene（引导卡片用）
if (stats.totalExecutions < 10) {
  const hotGenes = await fetch('/api/im/evolution/public/hot?limit=6');
}
```

---

## 10. 实现分期

### Phase 1: D1 全景 + 冷启动叠加层（2 天）

- [ ] D1 渲染器：cluster 区块（圆角矩形 + 密度色 + 标签）
- [ ] Cluster 检测：按 gene.category 分组（不用 Louvain）
- [ ] Cluster 布局：环形排列 + cluster 内力导向
- [ ] 冷启动叠加层（半透明引导卡片 + 精选 Gene + CTA）
- [ ] 故事横幅组件（可折叠，SSE 实时更新）
- [ ] 数据获取重写（stats → 决定叠加层，map → 渲染图）

**产出：** D1 全景可用，冷启动有引导，有数据时 cluster 密度差异可见

### Phase 2: D2 领域视图 + 维度切换（2 天）

- [ ] D2 渲染器：Gene 形状 + Signal 点 + Edge 线 + 粒子
- [ ] D1→D2 切换动画（cluster 展开，其余 fade out，500ms）
- [ ] D2→D1 切换动画（收缩回全景，400ms）
- [ ] D2 内横向切换（← → 切换相邻 cluster，slide 350ms）
- [ ] D2 内 hover 高亮（关联路径亮，其余 dim）

**产出：** 两层导航完整——全景看分布，点击 cluster 看领域内的 gene-signal 图

### Phase 3: D3 详情面板 + 交互完善（1.5 天）

- [ ] D3 HTML 面板（Gene 详情 + Signal 列表 + Capsule 历史）
- [ ] Beta 可信区间自然语言生成
- [ ] D2→D3 切换动画（Gene 放大 + 面板 slide-in）
- [ ] 响应式断点（桌面 320px / 平板 bottom sheet / 手机 modal）
- [ ] 键盘导航（Tab + Enter + Esc + Arrow keys）

### Phase 4: 搜索 + SSE + 可达性（1 天）

- [ ] D1 搜索框（输入 Gene/Signal → 高亮 cluster → Enter 进入 D2）
- [ ] SSE 实时事件（涟漪 + 粒子 + 闪烁 + 横幅更新）
- [ ] Screen reader fallback table
- [ ] prefers-reduced-motion 支持

---

## 11. 不做什么

| 不做                               | 原因                                    |
| ---------------------------------- | --------------------------------------- |
| 无极连续缩放                       | 缩放是离散维度跳转，维度内有有限自由度  |
| 三种模式切换（cold/story/graph）   | 一种模式（Graph），叠加层降级           |
| 宇宙隐喻命名（L1 地球/L2 太阳系…） | 改为功能命名（D1 全景/D2 领域/D3 详情） |
| Louvain 社区检测                   | category 分组在 <200 节点时等价且零成本 |
| 节点内嵌故事                       | 故事在横幅中，D3 面板中有完整历史       |
| D1 层级显示单个节点细节            | D1 只看 cluster 形状，细节在 D2/D3      |
| Canvas 渲染 D3                     | D3 是 HTML 面板，Canvas 只负责 D1/D2    |

---

## 12. 视觉设计系统（HCI 评审补充）

> 以下内容补充 §5 中缺失的视觉语言、交互状态、可达性、动效定义。

### 12.1 色彩系统

**问题：§5.2 的红→绿色谱对 8% 红绿色盲男性完全不可见。**

修正：用**亮度 + 色相**双通道编码，确保色盲用户也能区分。

```
routingWeight 色谱（色盲安全）:
  0.0    0.3    0.5    0.7    1.0
  ■──────■──────■──────■──────■
  暗红    暗橙    中黄    亮青    亮绿

  Dark theme:
  hsl(0, 70%, 40%)  →  hsl(45, 80%, 50%)  →  hsl(140, 70%, 55%)
  同时亮度从 40% → 55%，色盲用户靠亮度差区分

  Light theme:
  hsl(0, 60%, 45%)  →  hsl(45, 70%, 45%)  →  hsl(140, 60%, 40%)
```

**对比度保证：** 所有文字 ≥ 4.5:1 对比度（WCAG AA）。节点名称 pill 用不透明背景而非半透明。

```
Dark theme:
  文字主色:    #f4f4f5 on #18181b  → 对比度 15.3:1 ✓
  文字次色:    #a1a1aa on #18181b  → 对比度 6.1:1 ✓
  名称 pill:   #e4e4e7 on rgba(0,0,0,0.75)  → 对比度 ~12:1 ✓

Light theme:
  文字主色:    #18181b on #fafafa  → 对比度 16.8:1 ✓
  文字次色:    #71717a on #fafafa  → 对比度 4.6:1 ✓（刚好 AA）
```

### 12.2 节点视觉层级

**问题：Gene 和 Signal 节点视觉权重相似（都是填充+描边），层级不清。**

```
视觉层级（从高到低）:

1. 聚焦 Gene（Focus 模式中的主角）
   - 完整形状 + 粗描边(3px) + 外发光(blur 12px) + 白色填充
   - 大小: 最大 radius 32px
   - 文字: bold 12px

2. 普通 Gene（Overview 模式中的标准态）
   - 完整形状 + 中等描边(2px) + 半透明填充
   - 大小: radius 16-32px (by totalExecutions)
   - 文字: bold 9px

3. 冷启动 Gene（0 runs）
   - 虚线描边(1px dashed) + 无填充（仅轮廓）
   - 呼吸脉动: 仅描边透明度 0.2↔0.35（不改变大小——大小脉动是噪音）
   - 文字: regular 9px, 50% opacity

4. Signal 节点
   - 实心小圆（无描边，纯填充）
   - 大小: 3-8px（远小于 Gene，确保层级）
   - hover 时才显示标签

5. Ghost 节点
   - 20% opacity（不是 12%——12% 在环境光下不可见）
   - 仅轮廓，无文字
```

### 12.3 动效语言

**问题：§5.4 只定义了故事横幅的 300ms ease-out。整个系统的动效语言未定义。**

```
动效令牌（Motion Tokens）:

  快速交互（hover、tooltip）:
    duration: 150ms
    easing:   ease-out

  中等过渡（面板开关、叠加层出现/消失）:
    duration: 250ms
    easing:   cubic-bezier(0.4, 0, 0.2, 1)  // Material "standard"

  空间导航（Focus 飞行、回到 Overview）:
    duration: 400ms
    easing:   cubic-bezier(0.34, 1.56, 0.64, 1)  // 轻微过冲(overshoot)，增加空间感

  实时事件（涟漪、粒子、闪烁）:
    涟漪扩散: 600ms ease-out, radius 0→40px
    粒子飞行: 1200ms linear
    Gene 闪烁: 300ms，仅一次

  呼吸脉动（冷启动节点）:
    周期: 4s
    属性: 仅描边 opacity（0.2→0.35→0.2）
    不动: 大小、位置、填充
    原则: "微动=活着" 不是 "乱动=注意我"
```

**关键原则：同一时刻不超过 2 种独立动画。** 如果涟漪正在播放，不再触发新的闪烁。优先级：实时事件 > 交互反馈 > 环境动画。

### 12.4 交互状态机

**问题：§7 列出了操作→效果的映射，但没有定义状态冲突。**

```
States = { D1, D1+overlay, D2, D2+hover, D3 }

维度状态转换：

  D1 (Landscape):
    click cluster    → D2（展开动画 500ms）
    搜索提交         → D2（跳到结果 cluster，结果节点高亮）
    hover cluster    → D1（cluster 轮廓发光，tooltip 显示 stats）
    SSE event        → 故事横幅更新 + 对应 cluster 闪烁
    Cmd+0            → D1（已在 D1，no-op）

  D1+overlay (冷启动):
    dismiss (×)      → D1（overlay fade out 250ms，localStorage 记住）
    click Install    → 跳转 Library（overlay 不消失）
    任何 D1 操作     → 先 dismiss overlay，再执行操作

  D2 (Domain):
    click Gene       → D3（Gene 放大 + 面板 slide-in 300ms）
    hover Gene       → D2+hover（高亮关联路径，dim 其余，150ms）
    hover Edge       → D2+hover（tooltip 显示 rw% + totalObs）
    ← → 箭头/swipe  → D2（切换到相邻 cluster，slide 350ms）
    pinch out 超阈值 → D1（收缩回全景 400ms）
    Esc / Cmd+0      → D1
    SSE event        → 涟漪 + 粒子 + Gene 闪烁 + 故事横幅

  D2+hover:
    mouse leave      → D2（300ms fade back）
    click hovered    → D3
    hover 其他节点   → D2+hover（切换目标，150ms crossfade）

  D3 (Gene Detail):
    Esc / ← / swipe  → D2（面板 slide-out 250ms，Gene 恢复标准态）
    click Signal 行  → D2（高亮该 Signal 的所有连接，Gene 面板关闭）
    click Capsule 行 → 展开 capsule 详情（D3 内部操作，不切维度）
    SSE event        → 故事横幅更新（面板内容不变，除非事件涉及当前 Gene）
```

### 12.5 布局稳定性

**问题：力导向 400 次迭代在每次 30s 刷新时重新运行。Math.random() 在初始化中导致每次布局不同。用户每 30s 看到图跳一次。**

```
修正：

  1. 使用确定性种子 PRNG（mulberry32(hashCode(geneIds.join(',')))）
     → 相同的 gene 集合产生相同的初始位置

  2. 增量布局：新数据到达时，不重新计算全图
     → 只对新增节点运行 50 次迭代，固定已有节点位置
     → 已有节点位置存入 layoutCache（内存 Map）

  3. 位置变化动画：如果节点位置确实需要移动（大量新数据），
     用 400ms ease-out 过渡到新位置，不是跳变
```

### 12.6 响应式断点

**问题：§7.2 详情面板固定 320px，移动端不适用。**

```
断点定义：

  ≥ 1024px (桌面):
    Canvas = 100% - 320px（面板打开时）
    面板 = 右侧 320px slide-in
    故事横幅 = 顶部全宽

  768-1023px (平板):
    Canvas = 100%
    面板 = 底部 sheet（50vh），swipe down 关闭
    故事横幅 = 顶部全宽，文字截断

  < 768px (手机):
    Canvas = 100vh - 故事横幅高度
    面板 = 全屏 modal（带 back 按钮）
    故事横幅 = 40px 单行，tap 展开
    引导叠加层 = 全屏 modal（不是浮动卡片）
```

### 12.7 可达性（Accessibility）

**问题：PRD 完全没提可达性。Canvas 对屏幕阅读器不可见。**

```
基础措施（WCAG AA）：

  1. Canvas 旁加一个隐藏的 <table>
     （screen reader fallback：Gene 列表 + 成功率 + 使用量）
     用 aria-live="polite" 播报 SSE 事件

  2. 键盘导航：
     Tab → 遍历 Gene 节点（按 totalExecutions 降序）
     Enter → 打开详情面板
     Escape → 关闭面板 / 回到 Overview
     Arrow keys → 在 Focus 模式中遍历邻居节点

  3. 色彩：
     所有颜色编码都有形状/线型/亮度冗余通道
     高对比模式下增加描边粗细到 3px

  4. 动画：
     prefers-reduced-motion → 关闭粒子、涟漪、脉动
     保留：hover 高亮（非动画，只是透明度变化）
```

### 12.8 加载与错误状态

**问题：用户在 100-500ms 数据加载期间看到什么？API 失败呢？**

```
加载态（< 2s）:
  Canvas 区域显示骨架屏——
  3 个不同大小的圆形占位（脉动动画，灰色）
  + 2 条连线占位
  持续时间 < 2s 时不显示 spinner（避免闪烁）

加载态（> 2s）:
  骨架屏 + 底部文字 "Loading evolution map…"

错误态:
  Canvas 区域中央显示：
  [icon: AlertTriangle]
  "Couldn't load the evolution map"
  [Retry] 按钮

  不显示空白画布——空白画布 = "这个功能坏了"

空数据态（0 genes，极端情况）:
  不应发生（至少有 45 seed genes）
  如果发生：显示错误态 + "No genes found"
```

### 12.9 信息密度控制

**问题：45 Gene + 60 Signal + 73 Edge + 所有标签 = 一屏太满。需要明确什么时候显示什么。**

```
信息显示规则矩阵：

                          D1 (Landscape)   D2 (Domain)      D3 (Detail)
Gene 形状                      ✗ (点)           ✓                HTML
Gene 名称                      ✗                ✓ (前8字符)       ✓ (全名)
Gene 成功率弧                  ✗                ✓                HTML 进度条
Gene 使用量                    ✗                仅 hover          ✓
Signal 点                      ✗ (合并)          ✓                列表
Signal 标签                    ✗                仅 hover          ✓
Edge 线                        仅跨域粗线        ✓                列表
Edge 粒子                      ✗                ✓ (1-3/edge)     ✗
Edge 数字                      ✗                仅 hover          ✓
Cluster 区块                   ✓ (密度色)        标签在顶部        ✗
Cluster 密度色                 ✓                ✗                ✗
Stats bar                      ✓                ✓                ✗
故事横幅                       ✓                ✓                ✗
```

**D2 内 30 节点规则：** 当 cluster 内 Gene > 30 时，只显示 top 15（by totalExecutions），其余折叠为 "+N more" 可展开按钮。

---

## 13. 性能预算

```
帧率目标: 60fps（16.6ms/帧）

预算分配:
  布局计算:     0ms（预计算完成，运行时不重算）
  Edge 绘制:    < 2ms（73 条 bezier）
  Node 绘制:    < 3ms（105 个节点 × 形状+文字）
  Particle:     < 1ms（上限 80 个粒子）
  Hit test:     < 0.5ms（遍历 105 节点 + 73 edge）
  DOM overlay:  < 1ms（HTML 层面板/横幅）
  Buffer:       ~9ms

  总计 < 7ms → 安全 margin 9ms

不做的优化（当前不需要）:
  - WebGL（< 500 元素不需要）
  - Virtual viewport（< 200 节点不需要）
  - Web Worker 布局（400 次迭代 < 50ms，主线程可承受）
```

---

_Last updated: 2026-03-19 | v3.1 — 索引系统 + Skill-Gene 整合 + Signal 域聚类_

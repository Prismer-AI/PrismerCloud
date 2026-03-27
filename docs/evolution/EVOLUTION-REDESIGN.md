# Evolution Page Redesign — Design Document

> Prismer Cloud `/evolution` — Evolution Visualization & Skill Catalog
>
> Date: 2026-03-16 | Status: ✅ Phase 1-3 Complete (v1.7.2) — Phase 3.5+ deferred
>
> Competitive analysis: `docs/EVOMAP-ANALYSIS.md`

---

## 1. Current Problems

### 1.1 Screenshot Analysis (Current Page)

看当前截图，问题一目了然:

1. **没有叙事**: 页面打开就是一堆卡片，用户不知道"进化"是什么、为什么重要
2. **没有时间感**: 看不到进化是什么时候发生的，发展趋势如何
3. **5,455个Skill无处展示**: 导入了数据但页面上完全看不到
4. **数据是死的**: KPI数字没有上下文（"45 ACTIVE GENES" — so what?）
5. **Gene卡片信息过载**: 每张卡片塞了signals、strategy steps、badge，但最重要的"这个Gene成功率多少"反而看不清
6. **没有Agent归属**: 看不到哪个Agent贡献了什么
7. **没有行动指引**: 用户看完页面不知道该做什么

### 1.2 竞品对比 — EvoMap.ai (详见 `docs/EVOMAP-ANALYSIS.md`)

**EvoMap 做对的:**

- GDI 统一质量指标（Quality 35% + Usage 30% + Social 20% + Freshness 15%）— 一眼判断质量
- Phylogenetic Tree 进化族谱可视化 — 展示 Gene 血统
- Trust Badge（Trusted / Under Review）— 建立信任层级
- "Explore" 模式推荐低曝光高质量资产 — 解决长尾发现
- Bounty 悬赏系统闭环 — Credit 激励完整

**EvoMap 做错的:**

- 页面过多(~20)概念过载 — 新用户迷路
- 学术化严重（Shannon H'、Gini Coefficient）— 开发者不关心
- 缺乏时间维度 — 看不到进化过程
- 空洞感 — Arena没活跃赛季，KG空白
- 没有社交传播机制 — 生态无法外溢

**我们的差异化打法（打盲区不追广度）:**

- 时间感: Timeline 是 EvoMap 完全缺失的
- 故事性: Signal→Gene→Outcome 动画叙事 > Sankey 学术图
- 社交传播: 战报卡片 + Badge 是独有传播武器
- 可操作性: 每个页面都有明确的 CTA
- Park 联动 (v1.7.3): Agent活动→Gene产出→Evolution展示，闭环更紧

---

## 2. Information Architecture

### 2.1 五个子标签

```
[Overview]  [Skills]  [Genes]  [Timeline]  [Agents]
    │          │         │         │           │
    │          │         │         │           └─ 谁在贡献？排行榜
    │          │         │         └─ 什么时候发生了什么？
    │          │         └─ 进化出了什么策略？
    │          └─ 有哪些原始能力可用？(5,455 skills)
    └─ 全局概览 + "进化是什么"教育
```

### 2.2 用户动线

**小白路径:** Overview (理解概念) → Skills (浏览能力) → "我要引入Agent"
**开发者路径:** Skills (搜索具体能力) → Genes (看最佳实践) → Install
**贡献者路径:** Timeline (看最新动态) → Agents (看自己排名) → Publish Gene
**决策者路径:** Overview (看全局数据) → Agents (评估谁最活跃) → "值得投入"

---

## 3. Tab 1: OVERVIEW

### 3.1 Hero Section — "What is Evolution?"

**不要用文字解释。用动画。**

Canvas可视化（占屏幕60%高度）:

```
Signal ──→ Gene ──→ Outcome
  ⚡         🧬        ✓/✗
  │          │          │
  ●──────────●──────────●     ← 节点连线动画
  │          │          │
  ●──────────●──────────●     ← 粒子沿线条流动
  │          │          │
  ●──────────●──────────●     ← 节点脉冲表示活跃度
```

**三列节点:**

- 左列: Signal节点 (橙色) — 错误信号、任务请求
- 中列: Gene节点 (青色) — 匹配的策略
- 右列: Outcome节点 (绿色=成功, 红色=失败)
- 连线: 粒子从左到右流动，表示进化过程
- 交互: hover节点显示具体signal/gene/outcome名称

**下方一行文字:** "Agents encounter signals, match genes, execute strategies, and learn from outcomes. This is evolution."

### 3.2 KPI Cards (4个)

```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ 🧬 47    │ │ ⚡ 228   │ │ 📈 64.9% │ │ 🤖 445   │
│ Genes    │ │ Capsules │ │ Success  │ │ Agents   │
│ +3 this  │ │ +28 this │ │ ↑2.1%    │ │ +12 this │
│ week     │ │ week     │ │ vs last  │ │ week     │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```

关键改进: **每个数字下面要有对比/趋势**，不能光一个数字。

### 3.3 "How Evolution Works" — 四步流程

水平排列的4张卡片，用箭头连接:

```
[1. Signal Detected] ──→ [2. Gene Matched] ──→ [3. Strategy Executed] ──→ [4. Knowledge Captured]
     ⚡ 橙色                🧬 青色                ▶ 翠绿色                 🧠 紫色
"Agent遇到错误        "系统匹配最佳         "执行修复策略          "记录结果，更新
 或新任务"             进化策略"             并监控结果"           Gene权重"
```

每张卡片用TiltCard，hover时有3D效果。卡片之间的箭头用CSS animation缓慢流动。

### 3.4 Trending This Week (NEW — inspired by EvoMap)

实时动态感，让 Overview 不是静态页面：

```
┌─ 🔥 Trending This Week ──────────────────────────┐
│                                                    │
│  #1 ↑ kubernetes-helm         +128 installs        │
│  #2 ↑ timeout-recovery        +45 executions       │
│  #3 ● rate-limit-handler      +23 adoptions        │
│  #4 ↓ docker-compose          +12 installs         │
│  #5 NEW auth-token-refresh    first published      │
│                                                    │
│  [View Full Leaderboard →]                         │
└────────────────────────────────────────────────────┘
```

数据来源: Skills trending API + Gene execution feed，混合排名。

### 3.5 Hot Genes Preview

展示3个最热门的Gene:

- 简化版卡片: 标题 + 成功率环形图 + 使用量
- CTA: "Browse All Genes →" 跳转到Genes tab

### 3.5 Recent Milestones

3个最近的重要事件（最高分capsule、新published gene、最多复制的gene）:

- 带时间戳
- 带Agent归属
- CTA: "View Full Timeline →"

---

## 4. Tab 2: SKILLS (5,455 Skill Catalog)

### 4.1 Stats Bar

```
5,455 skills from 30 categories | Source: awesome-openclaw-skills | Last synced: 2026-03-10
```

### 4.2 Filter Bar

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔍 Search skills...          [Category ▾]  [Sort: Popular ▾]   │
└─────────────────────────────────────────────────────────────────┘

[All] [Coding(1218)] [Web(933)] [DevOps(408)] [Search(352)] [Browser(331)] [More ▾]
```

- Category pills 横向可滚动，每个显示数量badge
- Sort选项: Popular (installs desc), Newest, Stars, Name
- 搜索实时过滤（debounce 300ms）

### 4.2.1 Explore Mode (NEW — 借鉴 EvoMap)

在 Filter Bar 右侧加 toggle:

```
[🔍 Search]  [Category ▾]  [Sort ▾]        [Explore 💡]
```

**Explore 模式:** 推荐"高质量但低曝光"的 Skill — 按 (stars / max(installs, 1)) 降序，过滤 installs < 中位数。解决 5,455 个 Skill 中长尾内容被埋没的问题。

### 4.2.2 Trust Badge (NEW — 借鉴 EvoMap)

每个 Skill 来源显示信任标签:

| Badge       | 含义                                   | 颜色 |
| ----------- | -------------------------------------- | ---- |
| `Verified`  | 官方验证、来自 awesome-openclaw 的精选 | 绿色 |
| `Community` | 社区提交，未经审核                     | 灰色 |
| `Has Gene`  | 已有对应的进化策略                     | 青色 |

### 4.3 Skill Card Grid

3列响应式网格 (desktop 3, tablet 2, mobile 1):

```
┌────────────────────────────────┐
│ [OpenClaw]        ⭐ 12  ↓ 45 │  ← source badge + stars + installs
│                                │
│ kubernetes-helm                │  ← skill name (bold)
│ Package manager for Kubernetes │  ← description (2 lines, truncated)
│ that helps you manage K8s...   │
│                                │
│ [devops-and-cloud]  by: tree   │  ← category pill + author
│                                │
│ [View Source ↗] [→ Gene]       │  ← actions (source link + convert)
└────────────────────────────────┘
```

**"→ Gene" button:** 如果这个skill已经有对应的geneId，显示"View Gene"跳转到Genes tab。如果没有，显示"Convert to Gene"（未来功能，先置灰）。

### 4.4 Pagination

```
Showing 1-60 of 5,455 skills    [← Prev] [1] [2] [3] ... [91] [Next →]
```

每页60个（20x3列），不用infinite scroll（影响性能）。

### 4.5 Skill Detail (Expand/Modal)

点击卡片展开或弹出modal:

```
┌──────────────────────────────────────────┐
│ kubernetes-helm                           │
│ ─────────────────────────────────────────│
│ Package manager for Kubernetes that      │
│ helps you manage Kubernetes applications │
│ using Helm charts.                       │
│                                          │
│ Category: devops-and-cloud               │
│ Author: tree                             │
│ Source: awesome-openclaw-skills           │
│ Installs: 45 | Stars: 12                │
│                                          │
│ [View on GitHub ↗]                       │
│ [Install: npx clawhub install k8s-helm] │
│                                          │
│ Related Skills:                          │
│ • kubernetes-deploy (38 installs)        │
│ • helm-chart-generator (22 installs)     │
└──────────────────────────────────────────┘
```

---

## 5. Tab 3: GENES (Gene Library)

### 5.1 与Skills的区别

**Skills = 原始能力描述** (from OpenClaw, external)
**Genes = 进化策略** (from our Evolution system, internal)

一个Skill描述"我能做什么"，一个Gene描述"遇到X信号时用Y策略应对"。

### 5.1.1 Prismer Quality Index — PQI (NEW — 简化版 GDI)

EvoMap 用 GDI（4维度加权）统一排序。我们需要类似的综合指标，但更简洁:

```
PQI = success_rate * 0.4 + normalized_executions * 0.3 + adoption_rate * 0.2 + freshness * 0.1

其中:
  success_rate:         成功率 (0-1)
  normalized_executions: 执行量 / 最大执行量 (0-1)
  adoption_rate:        使用此Gene的Agent数 / 总Agent数 (0-1)
  freshness:            1 - (days_since_update / 90), clamped to [0, 1]
```

**Phase 1 在前端计算**（数据已有），Phase 2 迁移到后端 API。

PQI 显示在 Gene Card 上:

```
PQI: ████████░░ 82  ← 0-100 分，进度条 + 数字
```

### 5.2 Filter Bar

```
[All] [🔧 Repair(21)] [⚡ Optimize(15)] [💡 Innovate(11)]

🔍 Search genes...                          [Sort: Most Used ▾]
```

### 5.3 Gene Card

```
┌────────────────────────────────────────┐
│ 🔧 REPAIR    PQI: 82   [Seed]         │  ← category + PQI score + origin badge
│                                        │
│ Timeout Recovery                       │  ← title (bold, large)
│ Handles timeout errors with            │  ← description
│ exponential backoff and fallback       │
│                                        │
│ ████████████░░░░ 83.3%                 │  ← success rate bar (green)
│ 156 executions · 12 agents             │  ← usage stats
│                                        │
│ Signals:                               │
│ [error:timeout] [error:ETIMEDOUT]      │  ← signal pills
│                                        │
│ ▼ Strategy (4 steps)                   │  ← collapsible
│   1. Increase timeout to 30s           │
│   2. Retry with backoff: base=1s...    │
│   3. Try alternate endpoint            │
│   4. Return cached response            │
│                                        │
│ Published by: agent-alpha              │  ← attribution
│ Replicated by: 3 agents               │  ← adoption metric
│                                        │
│ [Install Gene]                         │  ← CTA (auth required)
└────────────────────────────────────────┘
```

**关键改进:**

1. **成功率可视化** — 进度条而不是数字
2. **执行量+Agent量** — 证明这个Gene被实际使用
3. **Attribution** — 谁发布的，多少人复制了
4. **Strategy可折叠** — 默认收起，点击展开

### 5.4 Gene Detail Panel

点击卡片展开完整信息:

- 完整策略步骤
- 最近10次执行结果（mini timeline: ✓✓✓✗✓✓✓✓✓✓）
- 使用此Gene的Agent列表
- Gene ID + 复制按钮
- "Fork Gene"（基于此Gene创建自己的变体）

---

## 6. Tab 4: TIMELINE

### 6.1 设计理念

时间线是理解"进化过程"的关键。不是一堆卡片，是一条**有时间感的河流**。

### 6.2 Layout

垂直时间线，左侧时间轴，右侧事件:

```
── March 10, 2026 ──────────────────────────

  10:42  ⚡ agent-beta executed Timeout Recovery
         ├ Outcome: ✓ Success (score: 0.92)
         └ Signal: error:timeout on api.example.com

  10:38  🧬 agent-alpha distilled Connection Pooling
         ├ Based on 15 successful capsules
         └ New gene created: gene_optimize_conn_pool

  10:15  📤 agent-gamma published Rate Limit Handler
         ├ Made available in Gene Market
         └ 2 agents imported within 1 hour

── March 9, 2026 ───────────────────────────

  23:50  🏆 MILESTONE: Timeout Recovery reached 100 executions
         └ First gene to hit triple digits

  22:30  ⚡ agent-delta executed Auth Token Refresh
         ├ Outcome: ✗ Failure (score: 0.2)
         └ Signal: error:401 — token expired
```

### 6.3 Event Types & Icons

| Type              | Icon | Color  | Description                        |
| ----------------- | ---- | ------ | ---------------------------------- |
| Capsule (success) | ⚡   | green  | Gene executed successfully         |
| Capsule (failure) | ⚡   | red    | Gene executed but failed           |
| Distillation      | 🧬   | cyan   | New gene distilled from experience |
| Publication       | 📤   | violet | Gene published to market           |
| Import            | 📥   | blue   | Agent imported a gene              |
| Milestone         | 🏆   | gold   | Significant achievement            |

### 6.4 Filters

```
[All] [Capsules] [Distillations] [Publications] [Milestones]
[All Categories] [Repair] [Optimize] [Innovate]
[All Outcomes] [Success] [Failure]
```

### 6.5 Milestone Detection (自动)

系统自动检测并高亮里程碑:

- Gene首次达到10/50/100/500次执行
- Agent首次发布Gene
- Gene被3/5/10个Agent复制
- 连续10次执行全部成功
- 新类别的首个Gene出现

### 6.6 Future: 人类投票 + 悬赏

设计预留（暂不实现但留接口）:

- 里程碑旁边的"投票"按钮（点赞/重要性标记）
- "悬赏"按钮（为未解决的signal设置credit奖励）
- 投票数影响Gene在Market中的排序

---

## 7. Tab 5: AGENTS

### 7.1 设计理念

回答一个问题: **"谁在推动进化？"**

### 7.2 Agent Leaderboard

```
┌──────────────────────────────────────────────────────────┐
│ #1 🥇 agent-alpha                                        │
│    Orchestrator | Online                                  │
│    ├ Capsules: 89  Published: 5  Success Rate: 78.5%     │
│    ├ Active Genes: 47  Imported: 3                       │
│    └ Category Focus: ███░░ Repair 62% | ██░░ Optimize 28%│
├──────────────────────────────────────────────────────────┤
│ #2 🥈 agent-beta                                         │
│    Specialist | Online                                    │
│    ├ Capsules: 67  Published: 3  Success Rate: 82.1%     │
│    ├ Active Genes: 45  Imported: 2                       │
│    └ Category Focus: ██░░░ Repair 40% | ███░ Optimize 50%│
├──────────────────────────────────────────────────────────┤
│ #3 🥉 agent-gamma                                        │
│    Bot | Idle                                             │
│    ├ Capsules: 45  Published: 2  Success Rate: 73.3%     │
│    ...                                                    │
└──────────────────────────────────────────────────────────┘
```

### 7.3 Ranking Algorithm

```
contribution_score = (
  capsule_count * 1.0 +
  published_gene_count * 10.0 +
  imported_by_others_count * 5.0 +
  success_rate * 50.0
)
```

### 7.4 Agent Detail (点击展开)

- 完整活动历史（最近20条）
- Gene库（这个Agent拥有的所有Gene）
- 进化雷达图（5维: repair能力, optimize能力, innovate能力, 活跃度, 影响力）
- "向TA发消息" / "查看在Park中的位置" 链接 (Park v1.7.3)

---

## 8. Visual Design System

### 8.1 Color Palette

```
Category Colors (consistent across all tabs):
  Repair:   #f97316 (orange-500) — 修复、恢复、容错
  Optimize: #06b6d4 (cyan-500)   — 优化、加速、改进
  Innovate: #8b5cf6 (violet-500) — 创新、新策略、实验

Status Colors:
  Success:  #22c55e (green-500)
  Failure:  #ef4444 (red-500)
  Pending:  #eab308 (yellow-500)

UI Colors (dark theme):
  Background: #0a0a0a
  Card:       #ffffff08 (glass)
  Border:     #ffffff10
  Text:       #f4f4f5 (primary), #a1a1aa (secondary), #71717a (muted)
```

### 8.2 Component Patterns

- **Cards**: Glass effect + TiltCard hover + category glow
- **Badges**: Rounded pill with category color background at 20% opacity
- **Progress bars**: Rounded, filled with category color, background #ffffff10
- **Tab indicator**: Gradient underline, smooth slide animation
- **Loading**: Skeleton shimmer animation (not spinner)

### 8.3 Animation Budget

- Tab switch: 200ms fade+slide
- Card hover: 150ms scale+glow (TiltCard handles this)
- Canvas: 60fps for Overview visualization
- Number counters: 1.5s ease-out count-up on mount
- Timeline events: 300ms slide-in on scroll into view

---

## 9. Data Requirements

### 9.1 Existing APIs (no changes needed)

| Tab      | API                                                               | Data                         |
| -------- | ----------------------------------------------------------------- | ---------------------------- |
| Overview | `GET /evolution/public/stats`                                     | KPI numbers                  |
| Overview | `GET /evolution/public/hot?limit=3`                               | Hot genes                    |
| Overview | `GET /evolution/public/feed?limit=5`                              | Recent events                |
| Skills   | `GET /skills/search?query=X&category=X&sort=X&page=N&limit=60`    | Skill list                   |
| Skills   | `GET /skills/stats`                                               | Total count, categories      |
| Skills   | `GET /skills/categories`                                          | Category list with counts    |
| Skills   | `GET /skills/trending?limit=20`                                   | Trending skills              |
| Skills   | `GET /skills/:id/related?limit=5`                                 | Related skills               |
| Genes    | `GET /evolution/public/genes?sort=X&category=X&search=X&limit=18` | Gene list                    |
| Genes    | `GET /evolution/public/genes/:id`                                 | Gene detail                  |
| Timeline | `GET /evolution/public/feed?limit=50`                             | Event stream                 |
| Agents   | `GET /evolution/public/feed?limit=200`                            | Derive agent stats from feed |

### 9.2 New APIs Needed

**Phase 1 (可以从现有数据派生):**

- None — 所有数据可以从现有API组合得到

**Phase 2 (如果需要更精确的数据):**

- `GET /evolution/public/agents` — Agent贡献排行榜（server-side aggregation）
- `GET /evolution/public/milestones` — 自动检测的里程碑事件
- `GET /evolution/public/stats/trend` — KPI趋势数据（本周 vs 上周）

---

## 10. Virality & Shareability (可传播性)

生态不能只在站内自嗨，必须能自发"长"到外部去。

### 10.1 Social Proof 战报卡片 (Shareable Milestones)

**触发时机:** 系统在 Timeline 中检测到 Milestone 时，自动生成可分享的战报。

**Milestone 类型 → 战报模板:**

| Milestone               | 战报标题                                           | 核心数据                    |
| ----------------------- | -------------------------------------------------- | --------------------------- |
| Gene 执行 100/1K/10K 次 | "🧬 Timeout Recovery just hit 10,000 executions"   | 成功率 + 趋势曲线 + agent数 |
| Agent 排名 #1           | "🏆 agent-alpha is the #1 Repair Expert"           | capsule数 + 发布数 + 成功率 |
| Gene 被 N 个 Agent 复制 | "📤 Rate Limit Handler adopted by 50 agents"       | 复制网络图谱缩略            |
| 连续成功 streak         | "🔥 Auth Token Refresh: 100 consecutive successes" | streak数 + 时间跨度         |
| 新 Gene 类别首创        | "💡 First Innovation gene published in Prismer"    | Gene描述 + 创建者           |

**战报卡片设计 (1200x630px OG Image):**

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  [Prismer Evolution]                             │
│                                                  │
│  🧬 Timeout Recovery                             │
│  just hit 10,000 executions                      │
│                                                  │
│  ████████████████░░ 94.2% success rate           │
│                                                  │
│  📈 Trend: ▁▂▃▄▅▆▇█  (sparkline)               │
│                                                  │
│  Used by 47 agents · Published by agent-alpha    │
│                                                  │
│  prismer.cloud/evolution                         │
└──────────────────────────────────────────────────┘
```

**技术实现:**

- `GET /api/og/evolution/milestone/:id` — Next.js OG Image Route (使用 `ImageResponse` from `next/og`)
- 动态渲染 SVG/Canvas → PNG
- 返回正确的 OpenGraph meta tags
- 每个 Milestone 有唯一 URL: `prismer.cloud/evolution?milestone=xxx`

**分享流程:**

```
Milestone detected → 战报卡片自动生成 → Timeline 中显示 [Share] 按钮
  → 点击 Share → 弹出面板:
    - Preview 战报图片
    - [Copy Link] [Share to X] [Share to LinkedIn]
    - X 预填文案: "🧬 My agent just hit 10K evolution executions on @PrismerCloud..."
```

### 10.2 Embeddable Widgets (生态外嵌组件)

让开发者把进化数据嵌入自己的 GitHub README、博客、官网。

**Widget 类型:**

**A. Status Badge (静态SVG):**

```
![Gene: Timeout Recovery](https://prismer.cloud/api/badge/gene/timeout-recovery)
```

渲染为:

```
┌─────────────────────────────────────────────┐
│ 🧬 Timeout Recovery │ ✓ 94.2% │ 10.2K runs │
└─────────────────────────────────────────────┘
```

**B. Skill Badge:**

```
![Skill: kubernetes-helm](https://prismer.cloud/api/badge/skill/awesome-op-kubernetes-helm)
```

渲染为:

```
┌───────────────────────────────────────┐
│ ⚡ kubernetes-helm │ ⭐ 12 │ ↓ 45    │
└───────────────────────────────────────┘
```

**C. Agent Badge:**

```
![Agent: agent-alpha](https://prismer.cloud/api/badge/agent/agent-alpha)
```

渲染为:

```
┌──────────────────────────────────────────────┐
│ 🤖 agent-alpha │ #1 Repair │ 94.2% success  │
└──────────────────────────────────────────────┘
```

**D. Live Widget (iframe, 更丰富):**

```html
<iframe src="https://prismer.cloud/embed/gene/timeout-recovery" width="400" height="200" frameborder="0"></iframe>
```

显示: 实时成功率 + sparkline趋势 + 最近执行状态 + "Powered by Prismer" 链接

**技术实现:**

- Badge: `GET /api/badge/:type/:slug` → SVG response (类似 shields.io)
- Widget: `/embed/:type/:slug` → 轻量HTML页面 (iframe friendly)
- 缓存: Badge SVG 缓存 5 分钟，Widget 数据缓存 1 分钟

### 10.3 Gene Lineage — 进化树/族谱可视化

**核心概念:** 每个 Gene 都有"血统"。当 Agent fork 一个 Gene，新 Gene 记录 `parentGeneId`。随着 fork 链条延伸，形成一棵进化树。

**数据模型扩展:**

```
Gene {
  ...existing fields...
  parentGeneId: string | null   // Fork 来源 (null = 原创)
  forkCount: number             // 被 fork 了多少次
  generation: number            // 代数 (original=0, first fork=1, ...)
}
```

**进化树可视化 (Gene Detail 页面内):**

```
                    [Timeout Recovery v1]  ← Original (agent-alpha)
                     /        |         \
          [v1.1-fast]  [v1.2-retry]  [v1.3-fallback]  ← Gen 1
            /    \          |
     [v1.1.1] [v1.1.2]  [v1.2.1]  ← Gen 2
```

- 树状布局 (D3 tree / 手动 Canvas)
- 每个节点: Gene名 + 成功率圆环 + Agent名
- 节点大小 = f(execution_count)
- 颜色 = 成功率 (绿→黄→红)
- 点击节点跳转到该 Gene 详情
- 根节点高亮标注 "Origin"

**成就感设计:**

- 根节点的创建者看到: "Your gene is the root of 47 variants across 23 agents"
- 进化树展开时显示统计: "This lineage has solved 12,340 problems with 91.3% success"
- 最深的 fork 链条: "5 generations of evolution from your original strategy"

**Lineage Stats (显示在 Gene Card 上):**

```
┌─ Lineage ──────────────────────┐
│ 🌳 Origin of 47 variants       │
│ 📊 12,340 total executions     │
│ 🧬 5 generations deep          │
│ [View Evolution Tree →]        │
└────────────────────────────────┘
```

### 10.4 Implementation Priority

| Feature                         | Phase   | Effort                      | Impact                          |
| ------------------------------- | ------- | --------------------------- | ------------------------------- |
| Shareable Milestone Cards       | Phase 2 | 1 day (OG route + share UI) | High — viral on X/LinkedIn      |
| Static SVG Badges               | Phase 2 | 0.5 day (SVG template)      | High — GitHub README visibility |
| Live Embed Widget               | Phase 3 | 1 day (iframe page)         | Medium — enterprise adoption    |
| Gene Lineage data model         | Phase 2 | 0.5 day (add parentGeneId)  | Foundation for tree             |
| Gene Lineage tree visualization | Phase 3 | 2 days (Canvas/D3 tree)     | High — "creator pride" driver   |

### 10.5 New APIs Required

```
# Milestone sharing
GET  /api/og/evolution/milestone/:id           → OG Image (PNG, 1200x630)
GET  /api/im/evolution/public/milestones       → Milestone list with share URLs

# Badges
GET  /api/badge/gene/:slug                     → SVG badge
GET  /api/badge/skill/:slug                    → SVG badge
GET  /api/badge/agent/:name                    → SVG badge

# Embeds
GET  /embed/gene/:slug                         → Lightweight HTML widget page
GET  /embed/skill/:slug                        → Lightweight HTML widget page

# Gene Lineage
GET  /api/im/evolution/public/genes/:id/lineage → { ancestors: Gene[], descendants: Gene[], stats }
POST /api/im/evolution/genes/fork              → Fork a gene (creates child with parentGeneId)
```

---

## 11. Implementation Plan

### Phase 1: 信息架构重构 (2 days)

- 5-tab导航框架
- Overview: KPI + 四步流程（静态）+ Hot Genes
- Skills: 搜索/过滤/分页 + Skill卡片
- Genes: 保留现有卡片，添加成功率bar和attribution
- Timeline: 基础事件列表
- Agents: 从feed数据派生的简单排行

### Phase 2: 可视化 + 传播基础 (2-3 days)

- Overview: Canvas动画网络（signal→gene→outcome流动）
- KPI: 动画计数器 + 趋势对比
- Timeline: 日期分组 + 里程碑自动检测 + 高亮
- Genes: 执行历史mini-chart + Lineage数据模型 (parentGeneId)
- Shareable Milestone Cards: OG Image route + Share按钮
- Static SVG Badges: gene/skill/agent badge endpoints

### Phase 3: 交互 + 外嵌 (2-3 days)

- Skill detail modal + related skills
- Gene detail panel + execution history + lineage stats
- Agent detail + 雷达图
- Tab间跳转（从Skill→对应Gene，从Gene→对应Agent）
- Live Embed Widget (iframe pages)
- Gene Fork 功能 + 进化树可视化 (Canvas)

### Phase 3.5: 生态闭环 (NEW — EvoMap 分析启发)

**Natural Selection — Gene 衰减机制:**

- Gene 90天没有执行 → 自动降低可见性（PQI freshness 归零）
- Gene 执行成功率 < 30% 且执行量 > 20 → 标记 "Low Performance" 警告
- 不是删除，是降权 — 搜索排序下降，卡片变暗

**Credit 正向激励:**

- Gene 被其他 Agent 采用(import) → 创建者获得 credit 奖励
- Skill 被 install → 作者获得小额 credit（如果有绑定 Agent）
- 具体金额: Gene adoption = +5 cr/次, Skill install = +1 cr/次

### Phase 4: 社交增强

- 里程碑投票机制 (upvote/bounty)
- 悬赏系统 (credit-backed bounties for unsolved signals)
- 进化方向投票 (community-driven gene priorities)
- Skill→Gene自动转换建议
- "Creator Pride" profile pages (your genes, your lineage impact)

---

## 12. Open Questions

### 已回答（基于 EvoMap 分析）

| #   | 问题                          | 建议答案                                                                          |
| --- | ----------------------------- | --------------------------------------------------------------------------------- |
| 1   | Skill→Gene关系如何展示?       | 一个Skill可对应多个Gene。Skill Card 显示 "Has Gene" trust badge + "View Gene"跳转 |
| 5   | Mobile优先还是Desktop优先?    | Desktop优先。EvoMap也是Desktop-heavy，但我们的卡片要响应式(3→2→1列)               |
| 6   | Canvas动画用真实数据还是抽象? | Phase 1用抽象动画（性能好、无数据依赖），Phase 2接入真实feed                      |
| 7   | Badge缓存策略?                | SVG badge 缓存 5分钟（EvoMap类似策略），Embed Widget 缓存 1分钟                   |
| 8   | OG Image技术选型?             | Next.js `ImageResponse` (Edge) — 更轻量、部署简单，EvoMap也用Next.js              |

### 待讨论

2. **Timeline数据量**: feed只保留最近N条，需要分页还是infinite scroll?
3. **Agent排行数据**: 当前从feed派生有偏差，是否需要server-side aggregation API?
4. **Milestone自动检测**: 在前端做还是后端做？
5. **Gene Fork 命名规则**: `{original}-fork-{agent}` 还是用户自定义？
6. **Lineage树深度限制**: 允许无限fork链还是限制深度（如10代）？
7. **PQI 权重**: success_rate 40% + executions 30% + adoption 20% + freshness 10% 是否合理？
8. **Natural Selection 阈值**: 90天不执行降权 + 成功率<30%警告 是否合理？
9. **Credit 激励金额**: Gene adoption +5cr, Skill install +1cr 是否平衡？

---

---

## 13. 与 EvoMap 的核心差异总结

| 维度       | EvoMap             | Prismer Evolution               | 我们的优势   |
| ---------- | ------------------ | ------------------------------- | ------------ |
| 信息架构   | ~20页面，概念分散  | 5-Tab 聚焦                      | 更低认知负担 |
| 质量评分   | GDI (4维复杂)      | PQI (4维简化)                   | 更易理解     |
| 时间维度   | ❌ 没有            | ✅ Timeline Tab                 | 独有         |
| 社交传播   | ❌ 没有            | ✅ 战报卡片+Badge+Lineage       | 独有         |
| 生态可视化 | Shannon H', Sankey | Signal→Gene→Outcome 动画        | 更直观       |
| 教育性     | 学术概念密集       | 四步流程解释                    | 更友好       |
| 场景联动   | ❌ 没有            | ✅ Park↔Evolution 闭环 (v1.7.3) | 独有         |
| 经济闭环   | ✅ 成熟(赚+花)     | ⚠️ Phase 3.5 规划中             | 待建设       |

**一句话策略：不追 EvoMap 的广度，打它的盲区 — 时间感、故事性、社交传播、可操作性。**

---

_Phase 1-3 implemented in v1.7.2. Phase 3.5 (Gene 衰减 + Credit 激励) and Phase 4 (投票/悬赏) deferred. Park 联动 moved to v1.7.3._

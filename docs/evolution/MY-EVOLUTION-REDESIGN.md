# My Evolution 工作台 — 设计文档

**Version:** 1.0
**Date:** 2026-03-23
**Status:** 📋 设计审阅
**Scope:** `/evolution` 页面的 "My Evolution" tab 重设计 + Library tab 交互增强

---

## 1. 问题陈述

### 当前状态

```
/evolution 页面 (4 tabs)
├── Map         → 宇宙可视化（只读）
├── Library     → Skills + Genes 公共浏览（只读）
├── Leaderboard → Agent 排名（只读）
└── My Evolution → 个人仪表盘（只读展示）
    ├── KPI 卡片 (Genes/Executions/SuccessRate/Credits/Rank)
    ├── Achievements (6 badges)
    ├── Personality (3 bars)
    ├── My Gene Library (列表，无操作)
    └── Recent Executions (列表，无详情)
```

### 核心缺口

| 用户故事                         | 现状                     | 缺口                       |
| -------------------------------- | ------------------------ | -------------------------- |
| "我想创建一个新 Gene"            | 只能通过 API/CLI         | **无创建入口**             |
| "我想上传我的 Skill"             | 只能通过脚本导入         | **无上传表单**             |
| "我想发布 Gene 到公共市场"       | Dashboard 有一键按钮     | **无预览/确认流程**        |
| "我想 Fork 一个公共 Gene"        | API 有但无 UI            | **无 Fork UI**             |
| "我想看 capsule 执行详情"        | 只显示 gene_id + summary | **无详情弹窗**             |
| "我想触发蒸馏"                   | Dashboard 显示就绪指示   | **无 capsule 选择/预览**   |
| "Library 里看到好的 Gene 想导入" | 无操作按钮               | **Library 无 Import/Fork** |

**一句话：用户在 Evolution 页面能看到一切，但不能做任何事。**

---

## 2. 设计目标

1. **My Evolution 从被动仪表盘升级为主动工作台** — 所有 CRUD 操作集中在这里
2. **Library 增加 action 按钮** — Import/Fork/Install/Star 联动到 My Evolution
3. **遵循现有设计语言** — glass morphism + TiltCard + zinc/violet 色系 + dark mode 优先
4. **渐进式交互** — 简单操作行内完成，复杂操作用 Sheet/Drawer
5. **API 零新增** — 所有后端端点已存在，只做前端

---

## 3. 信息架构

### 3.1 My Evolution 新结构

```
My Evolution (重新设计)
│
├── 📊 Overview Strip          ← 压缩为一行 KPI 条
│   5 个指标横排：Genes | Executions | Success% | Credits | Rank
│
├── 🧬 My Genes                ← 核心区块，可展开
│   ├── Header: "My Genes (45)" + [+ New Gene] 按钮
│   ├── Filter Bar: category pills + visibility filter + search
│   ├── Gene List (每行)
│   │   ├── 图标 + Title + Category + Visibility badge
│   │   ├── Stats: runs | success% | forks
│   │   └── Actions: [Edit] [Publish] [Delete]
│   └── Empty State: "Create your first gene" CTA
│
├── 📦 My Skills               ← 新增区块
│   ├── Header: "My Skills (3)" + [+ Upload Skill] 按钮
│   ├── Skill List (每行)
│   │   ├── Name + Category + Status badge
│   │   ├── Stats: installs | stars
│   │   └── Actions: [Edit] [Link Gene] [Deprecate]
│   └── Empty State: "Share your first skill" CTA
│
├── ⚗️ Distillation Lab        ← 独立区块
│   ├── Readiness Card
│   │   ├── Progress ring: 7/10 successful capsules
│   │   ├── Success rate: 72% (need 70%)
│   │   └── Cooldown: 18h remaining
│   ├── [Run Dry Test] → 预览 LLM 输出
│   ├── [Distill Now] → 确认弹窗 → 创建 Gene
│   └── History: 过去 3 次蒸馏结果
│
├── 📜 Execution Log           ← 改进的 capsule 列表
│   ├── Filter: outcome (all|success|failed) + date range
│   ├── Capsule Row → click → Detail Drawer
│   └── Pagination
│
├── 🏆 Achievements            ← 压缩到可折叠区块
│   └── 6 badges grid (现有设计不变)
│
└── 🧠 Personality             ← 压缩到可折叠区块
    └── 3 bars (现有设计不变)
```

### 3.2 Library Tab 增强

```
Library Tab (增强)
│
├── Skill Card (现有 + 新增操作)
│   ├── [Install] → POST /api/skills/:id/install
│   ├── [★ Star]  → POST /api/skills/:id/star
│   └── [View]    → Skill Detail Drawer (Markdown 渲染)
│
└── Gene Card (现有 + 新增操作)
    ├── [Import]  → POST /api/evolution/genes/import → 跳转 My Genes
    ├── [Fork]    → Gene Fork Sheet (修改 signals/strategy) → 跳转 My Genes
    └── [View]    → Gene Detail Drawer (lineage + capsules + stats)
```

### 3.3 页面间联动

```
Library (公共浏览)                    My Evolution (个人管理)
┌─────────────────────┐              ┌─────────────────────┐
│ Gene Card           │              │ My Genes             │
│  [Import] ─────────────────────→   │  Gene 出现在列表     │
│  [Fork]   ────→ Fork Sheet ───→   │  Fork 出现在列表     │
│                     │              │  [+ New Gene] ──→ Create Sheet
│ Skill Card          │              │                      │
│  [Install] ─────────────────────→  │ My Skills            │
│  [Star] (in-place)  │              │  Skill 出现在列表    │
│                     │              │  [+ Upload] ──→ Upload Sheet
└─────────────────────┘              └─────────────────────┘
```

---

## 4. 组件设计

### 4.1 Gene Create Sheet

**触发：** My Genes → [+ New Gene] 按钮
**容器：** 右侧 Sheet (半屏滑出)，mobile 全屏

```
┌─ Gene Create ─────────────────────────────┐
│                                            │
│  Category ●                               │
│  ┌────────────────────────────────────┐   │
│  │ ○ Repair   ○ Optimize              │   │
│  │ ○ Innovate ○ Diagnostic            │   │
│  └────────────────────────────────────┘   │
│                                            │
│  Title                                    │
│  ┌────────────────────────────────────┐   │
│  │ HTTP Timeout Recovery              │   │
│  └────────────────────────────────────┘   │
│                                            │
│  Signals (what triggers this gene)        │
│  ┌────────────────────────────────────┐   │
│  │ + error:timeout                    │   │
│  │ + error:connection_refused         │   │
│  │ [+ Add Signal]                     │   │
│  └────────────────────────────────────┘   │
│  Suggestions: error:500, error:rate_limit │
│                                            │
│  Strategy Steps                           │
│  ┌────────────────────────────────────┐   │
│  │ 1. Increase timeout to 30s        │   │
│  │ 2. Add exponential backoff        │   │
│  │ 3. Retry up to 3 times           │   │
│  │ [+ Add Step]                       │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ▸ Preconditions (optional)               │
│  ▸ Constraints (optional)                 │
│                                            │
│  ┌────────────┐ ┌─────────────────────┐   │
│  │   Cancel   │ │   Create Gene  🧬   │   │
│  └────────────┘ └─────────────────────┘   │
└────────────────────────────────────────────┘
```

**Signal Suggestions：** 从 `/api/im/evolution/edges` 获取用户历史信号，作为自动补全候选。也可直接输入自定义信号。

**API 调用：** `POST /api/im/evolution/genes` → 创建成功后关闭 Sheet，刷新 My Genes 列表，显示 toast。

### 4.2 Gene Detail / Edit Drawer

**触发：** My Genes 列表中点击某个 Gene
**容器：** 右侧 Drawer

```
┌─ Gene Detail ──────────────────────────────┐
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │ HTTP Timeout Recovery    [Edit] [···] │ │
│  │ repair · private · 12 runs · 83%     │ │
│  └───────────────────────────────────────┘ │
│                                             │
│  ┌─ Tabs ────────────────────────────────┐ │
│  │ Overview │ Signals │ History │ Lineage │ │
│  └───────────────────────────────────────┘ │
│                                             │
│  Overview:                                  │
│  ├── Strategy Steps (1. 2. 3.)             │
│  ├── Preconditions                          │
│  ├── Constraints                            │
│  ├── Created: 2026-03-15                   │
│  └── Last used: 2 hours ago                │
│                                             │
│  Signals:                                   │
│  ├── error:timeout (42 matches, 83% success)│
│  └── error:connection_refused (8, 75%)     │
│                                             │
│  History (recent capsules):                 │
│  ├── ✓ 2h ago — Applied retry, worked     │
│  ├── ✗ 5h ago — Timeout persisted         │
│  └── ✓ 1d ago — Backoff solved it         │
│                                             │
│  Lineage:                                   │
│  └── Parent: seed_repair_timeout_v1        │
│      └── This gene (fork)                  │
│          └── 2 child forks                  │
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │ [Publish to Market]  [Fork]  [Delete]│  │
│  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 4.3 Gene Publish Flow

**触发：** Gene Detail → [Publish to Market] 或 My Genes 列表 → [Publish]
**容器：** AlertDialog (确认弹窗)

```
┌─ Publish Gene ────────────────────────────┐
│                                            │
│  🧬 Publish "HTTP Timeout Recovery"       │
│                                            │
│  This gene will be visible to all agents  │
│  on the Prismer network.                  │
│                                            │
│  Stats:                                    │
│  ├── 12 executions, 83% success rate      │
│  ├── Category: repair                     │
│  └── Signals: error:timeout, error:conn.. │
│                                            │
│  Visibility:                               │
│  ○ Canary (limited rollout first)         │
│  ● Published (visible to all)             │
│                                            │
│  ┌───────────┐ ┌───────────────────────┐  │
│  │  Cancel   │ │  Publish  🚀          │  │
│  └───────────┘ └───────────────────────┘  │
└────────────────────────────────────────────┘
```

**API 调用：** `POST /api/im/evolution/genes/:id/publish` (skipCanary 根据选择)

### 4.4 Skill Upload Sheet

**触发：** My Skills → [+ Upload Skill] 按钮
**容器：** 右侧 Sheet

```
┌─ Upload Skill ─────────────────────────────┐
│                                             │
│  Name *                                     │
│  ┌─────────────────────────────────────┐   │
│  │ My Custom Search Skill              │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Description *                              │
│  ┌─────────────────────────────────────┐   │
│  │ Searches multiple sources with      │   │
│  │ fallback and result merging.        │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Category *                                 │
│  ┌─────────────────────────────────────┐   │
│  │ ▾ Search & Research                 │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Tags (comma-separated)                     │
│  ┌─────────────────────────────────────┐   │
│  │ search, multi-source, fallback      │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Content (Markdown / SKILL.md)              │
│  ┌─────────────────────────────────────┐   │
│  │ ---                                 │   │
│  │ name: my-search-skill               │   │
│  │ description: ...                    │   │
│  │ ---                                 │   │
│  │                                     │   │
│  │ # Usage                             │   │
│  │ ...                                 │   │
│  │                        📋 Paste     │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ▸ Source URL (optional)                    │
│  ▸ Link to Gene (optional)                 │
│                                             │
│  ┌───────────┐ ┌───────────────────────┐   │
│  │  Cancel   │ │  Upload Skill  📦     │   │
│  └───────────┘ └───────────────────────┘   │
└─────────────────────────────────────────────┘
```

**API 调用：** `POST /api/im/skills` → 创建后刷新 My Skills 列表

### 4.5 Gene Fork Sheet

**触发：** Library Gene Card → [Fork] 或 Gene Detail → [Fork]
**容器：** 右侧 Sheet，预填充父 Gene 数据

```
┌─ Fork Gene ────────────────────────────────┐
│                                             │
│  Forking from: "Timeout Recovery" (seed)    │
│                                             │
│  Title *                                    │
│  ┌─────────────────────────────────────┐   │
│  │ My Timeout Recovery (modified)      │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Signals (inherited, editable)              │
│  ┌─────────────────────────────────────┐   │
│  │ ✓ error:timeout                     │   │
│  │ + error:gateway_timeout (added)     │   │
│  │ [+ Add Signal]                      │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Strategy Steps (inherited, editable)       │
│  ┌─────────────────────────────────────┐   │
│  │ 1. Increase timeout to 60s ← 30s   │   │
│  │ 2. Add exponential backoff          │   │
│  │ 3. Retry up to 5 times ← 3 times   │   │
│  │ 4. Log retry chain (added)          │   │
│  │ [+ Add Step]                        │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ┌───────────┐ ┌───────────────────────┐   │
│  │  Cancel   │ │  Create Fork  🍴      │   │
│  └───────────┘ └───────────────────────┘   │
└─────────────────────────────────────────────┘
```

**API 调用：** `POST /api/im/evolution/genes/fork` (gene_id + modifications)

### 4.6 Capsule Detail Drawer

**触发：** Execution Log 中点击某条记录
**容器：** 右侧 Drawer (窄)

```
┌─ Capsule Detail ──────────────────────────┐
│                                            │
│  ✓ Success · 0.85 · 2 hours ago           │
│                                            │
│  Gene                                      │
│  HTTP Timeout Recovery (repair)            │
│                                            │
│  Signals                                   │
│  ┌────────────────────────────────────┐   │
│  │ error:timeout                      │   │
│  │ provider: openai                   │   │
│  │ stage: api_call                    │   │
│  └────────────────────────────────────┘   │
│                                            │
│  Summary                                   │
│  "Applied timeout increase from 10s to     │
│   30s. Request succeeded on retry #2."     │
│                                            │
│  Metadata                                  │
│  ┌────────────────────────────────────┐   │
│  │ cost_credits: 0.002                │   │
│  │ duration_ms: 2340                  │   │
│  │ retries: 2                         │   │
│  └────────────────────────────────────┘   │
│                                            │
│  Execution Context                         │
│  ┌────────────────────────────────────┐   │
│  │ { raw context if available }       │   │
│  └────────────────────────────────────┘   │
│                                            │
└────────────────────────────────────────────┘
```

### 4.7 Distillation Lab

蒸馏是进化系统最核心的仪式感操作——从散落的执行经验中提炼出新的知识基因。
设计上需要传达**炼金/实验室**的过程感，而不是一个静态的表单。

#### 设计原则

1. **过程可观测** — 用户需要看到"蒸馏正在发生"的每一步，而不仅仅是输入→输出
2. **动效传达仪式感** — 从原料（capsules）到产物（gene）的转化需要视觉叙事
3. **状态清晰** — 就绪/进行中/完成三态明确区分

#### 三态设计

**State 1: 酝酿中（Not Ready）**

```
┌─ Distillation Lab ⚗️ ────────────────────────────────────────┐
│                                                                │
│  ┌─ 原料采集 ───────────────────────────────────────────────┐ │
│  │                                                           │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │           ○ ○ ○ ○ ○ ○ ○ · · ·                     │ │ │
│  │  │           7 / 10  successful capsules               │ │ │
│  │  │           ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░           │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  │                                                           │ │
│  │  ┌── 条件 ──────────────────────────────────────────┐   │ │
│  │  │  ✓ 成功 Capsules     7/10 (差 3 个)              │   │ │
│  │  │  ✓ 近期成功率        72% ≥ 70%                   │   │ │
│  │  │  ○ 冷却时间          18h 后可用                    │   │ │
│  │  └──────────────────────────────────────────────────┘   │ │
│  │                                                           │ │
│  │  最近的成功执行 (dot trail animation)                     │ │
│  │  ✓·───✓·───✓·───✓·───✓·───✓·───✓·───○ ○ ○              │ │
│  │  每个 ✓ 是一个 capsule，hover 显示 summary                │ │
│  │                                                           │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                │
│  [Distill] ← disabled, pulsing border indicates approaching   │
└────────────────────────────────────────────────────────────────┘
```

**动效：**

- 圆点进度条：已采集的 capsule 从左到右排列，每个圆点有 fade-in 动画
- 进度条使用 CSS gradient animation（紫色 → 透明 shimmer）
- "差 3 个" 文字有微弱呼吸动画（opacity 0.6 → 1.0）
- Distill 按钮 disabled 但有 pulsing border（暗示"快了"）

**State 2: 就绪 → 蒸馏中（Ready → Processing）**

```
┌─ Distillation Lab ⚗️ ────────────────────────────────────────┐
│                                                                │
│  ┌─ 就绪 ──────────────────────────────────────────────────┐ │
│  │  ● ● ● ● ● ● ● ● ● ●  10/10 capsules ✓               │ │
│  │  成功率 78% ✓  ·  冷却完毕 ✓  ·  全部条件满足             │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─ 原料清单 (可勾选) ────────────────────────────────────┐  │
│  │                                                          │  │
│  │  ☑ ✓ error:timeout      "Retry with backoff"   2h ago  │  │
│  │  ☑ ✓ error:timeout      "Increased to 30s"     5h ago  │  │
│  │  ☑ ✓ error:conn_refused "Pool reset worked"    1d ago  │  │
│  │  ☑ ✓ error:timeout      "Fallback URL used"    2d ago  │  │
│  │  ☑ ✓ error:rate_limit   "Backoff + queue"      3d ago  │  │
│  │  ...                                                     │  │
│  │  ☐ ✗ error:timeout      "Still failed"         3d ago  │  │
│  │       (excluded — failed)                                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────┐  ┌────────────────────────────────┐     │
│  │  ⚗️ Dry Run      │  │  🔥 Start Distillation         │     │
│  └──────────────────┘  └────────────────────────────────┘     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

点击 **[🔥 Start Distillation]** 后进入处理动画：

```
┌─ Distillation Lab ⚗️ ──── PROCESSING ────────────────────────┐
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                                                          │ │
│  │              ⚗️                                          │ │
│  │         ╱    ║    ╲         从 capsules 到 gene          │ │
│  │    ●───→║    ║    ║←───●    的炼金动画                   │ │
│  │    ●───→║ ◆◆ ║    ║←───●                                │ │
│  │    ●───→║    ║    ║←───●    capsule dots 从两侧          │ │
│  │         ╲    ║    ╱         汇聚到中央烧瓶               │ │
│  │              ║                                           │ │
│  │              ▼                                           │ │
│  │             🧬?          gene 轮廓在底部渐显             │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─ Pipeline 进度条 ───────────────────────────────────────┐  │
│  │                                                          │  │
│  │  ① 采集原料          ✓ 完成 (0.2s)                      │  │
│  │  ② 分析信号模式       ✓ 完成 (1.1s)                      │  │
│  │  ③ LLM 策略合成      ⟳ 进行中...                        │  │
│  │     "正在从 10 个成功案例中提取共性策略..."               │  │
│  │  ④ 质量评估          ○ 等待                              │  │
│  │  ⑤ Gene 生成         ○ 等待                              │  │
│  │                                                          │  │
│  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░  56%              │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ⏱ 预计剩余 8 秒                                              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**动效细节：**

| 元素          | 动效                                    | 时长                      | 实现                                         |
| ------------- | --------------------------------------- | ------------------------- | -------------------------------------------- |
| Capsule dots  | 从列表位置飞向中央烧瓶                  | 0.8s each, staggered 0.1s | `framer-motion` layoutId 或 CSS `@keyframes` |
| 烧瓶内液体    | 紫色液体从 0% 升至满                    | 随进度条同步              | SVG path + CSS animation                     |
| 气泡          | 烧瓶内随机气泡上升                      | 持续, 随机                | CSS `@keyframes` + `animation-delay: random` |
| Pipeline 步骤 | 依次从 `○ 等待` → `⟳ 进行中` → `✓ 完成` | 每步 1-3s                 | 状态驱动 + `transition`                      |
| 进度条        | 渐变色移动 (violet → cyan shimmer)      | 持续                      | `background-position` animation              |
| Gene 轮廓     | 底部 DNA 图标从 0 opacity 渐显          | 最后 2s                   | `opacity` + `scale` transition               |

**State 3: 完成 → 结果展示**

```
┌─ Distillation Lab ⚗️ ──── COMPLETE ──────────────────────────┐
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                                                          │ │
│  │                    🧬 ✨                                  │ │
│  │                                                          │ │
│  │              New Gene Synthesized!                       │ │
│  │                                                          │ │
│  │         "Adaptive Timeout Recovery"                      │ │
│  │              category: repair                            │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─ Synthesized Gene Preview ──────────────────────────────┐  │
│  │                                                          │  │
│  │  Title:     Adaptive Timeout Recovery                    │  │
│  │  Category:  repair                                       │  │
│  │  Signals:   error:timeout, error:conn_refused            │  │
│  │                                                          │  │
│  │  Strategy:                                               │  │
│  │    1. Check current timeout setting                      │  │
│  │    2. Increase by 2x (cap at 60s)                       │  │
│  │    3. Add jitter: random(0, timeout × 0.1)              │  │
│  │    4. Retry with exponential backoff (base 1s, max 3)    │  │
│  │    5. If persistent, try fallback URL                    │  │
│  │                                                          │  │
│  │  Quality:                                                │  │
│  │    Source capsules: 10                                    │  │
│  │    Signal coverage: 2 signal types                       │  │
│  │    Confidence: 0.78                                      │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─ LLM Critique ─────────────────────────────────────────┐   │
│  │  "This gene combines the best patterns from 10 execu-   │   │
│  │   tions. The fallback URL strategy (step 5) appeared    │   │
│  │   in 3/10 capsules and had 100% success when applied.   │   │
│  │   Consider adding a circuit breaker for step 4."         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─ What's Next ───────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │  │
│  │  │ View in      │  │ Publish to    │  │ Edit &       │ │  │
│  │  │ My Genes     │  │ Market  🚀    │  │ Fork  🍴    │ │  │
│  │  └──────────────┘  └───────────────┘  └──────────────┘ │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─ Distillation History ──────────────────────────────────┐  │
│  │  3 次蒸馏记录:                                            │  │
│  │  ✓ Adaptive Timeout Recovery    今天    → My Genes        │  │
│  │  ✓ Auth Token Refresh           2d ago  → Published       │  │
│  │  ✗ Connection Pool (failed)     5d ago  → quality < 0.5   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**完成动效：**

| 元素                    | 动效                                          | 实现                              |
| ----------------------- | --------------------------------------------- | --------------------------------- |
| 🧬 图标                 | 从烧瓶底部弹出 + scale(0→1.2→1.0) + 旋转 360° | `spring` animation                |
| ✨ 粒子                 | 8-12 个发光粒子从 DNA 图标四散                | CSS `@keyframes` + random offsets |
| "New Gene Synthesized!" | 逐字打字机效果                                | `steps()` animation 或 JS         |
| Gene Preview 卡片       | 从下方滑入 + fade-in                          | `translateY(20px)` → `0`          |
| LLM Critique            | 打字机效果（模拟 LLM 输出）                   | streaming text effect             |
| What's Next 按钮组      | staggered 滑入 (0.1s 间隔)                    | `animation-delay`                 |

#### Dry Run 模式

Dry Run 跳过 LLM 调用，直接返回就绪检查结果 + 预估合成内容。
不触发完整动画——只显示一个简化的预览面板：

```
┌─ Dry Run Result ──────────────────────────────────────────────┐
│                                                                │
│  ⚗️ Dry Run — Preview Only (no gene created)                  │
│                                                                │
│  Ready: ✓                                                      │
│  Eligible capsules: 10 (of which 8 successful)                │
│  Estimated gene:                                               │
│    Category: repair                                            │
│    Signal coverage: error:timeout (7x), error:conn_refused (3x)│
│    Strategy preview: ~5 steps (based on capsule patterns)      │
│                                                                │
│  ┌─────────────┐                                              │
│  │ Close       │                                              │
│  └─────────────┘                                              │
└────────────────────────────────────────────────────────────────┘
```

#### Pipeline 步骤的状态机

蒸馏的 5 个步骤各自有独立的状态和时长：

```typescript
type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface DistillationStep {
  id: string;
  label: string;
  status: StepStatus;
  description?: string; // "正在从 10 个案例中提取共性..."
  durationMs?: number; // 实际耗时
}

const STEPS: DistillationStep[] = [
  { id: 'collect', label: '采集原料', status: 'pending' },
  { id: 'analyze', label: '分析信号模式', status: 'pending' },
  { id: 'synthesize', label: 'LLM 策略合成', status: 'pending', description: '' },
  { id: 'evaluate', label: '质量评估', status: 'pending' },
  { id: 'generate', label: 'Gene 生成', status: 'pending' },
];
```

**步骤推进逻辑：**

由于 `POST /api/im/evolution/distill` 是同步返回的（服务端完成所有步骤后才返回），
前端用**模拟进度**来增强体感：

```typescript
// 发送请求的同时启动模拟进度
const distillPromise = fetch('/api/im/evolution/distill', { method: 'POST', headers });

// 模拟步骤推进（基于预估时间）
setTimeout(() => setStep('collect', 'done'), 300);
setTimeout(() => setStep('analyze', 'running'), 400);
setTimeout(() => setStep('analyze', 'done'), 1500);
setTimeout(() => setStep('synthesize', 'running'), 1600);
// synthesize 是最慢的步骤，等实际 API 返回
// 当 API 返回时，快速推进剩余步骤

const result = await distillPromise;
setTimeout(() => setStep('synthesize', 'done'), 200);
setTimeout(() => setStep('evaluate', 'running'), 300);
setTimeout(() => setStep('evaluate', 'done'), 800);
setTimeout(() => setStep('generate', 'running'), 900);
setTimeout(() => {
  setStep('generate', 'done');
  setPhase('complete');
  setDistillResult(result);
}, 1500);
```

**这不是假进度条** — API 确实在执行这些步骤，只是前端无法获取中间状态，
所以用预估时间模拟。如果 API 比预估快，剩余步骤会快速完成；如果慢，
synthesize 步骤会停留在 `running` 直到 API 返回。

#### CSS 动效清单

| 动效名         | 用途               | CSS / 实现                                                                                                               |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `shimmer`      | 进度条光泽移动     | `background: linear-gradient(90deg, violet, cyan, violet); background-size: 200%; animation: shimmer 2s linear infinite` |
| `pulse-border` | 即将就绪的按钮边框 | `box-shadow: 0 0 0 2px rgba(139,92,246,var(--pulse)); animation: pulse 2s ease-in-out infinite`                          |
| `breathe`      | "差 N 个" 文字呼吸 | `animation: breathe 3s ease-in-out infinite` → opacity 0.5-1.0                                                           |
| `bubble-rise`  | 烧瓶内气泡         | `@keyframes rise { from { transform: translateY(0) scale(1) } to { translateY(-40px) scale(0) opacity(0) } }`            |
| `dot-fly`      | Capsule 飞入烧瓶   | `motion.div` with `layoutId` 或 absolute position + bezier curve                                                         |
| `gene-emerge`  | Gene 图标弹出      | `scale(0) → scale(1.2) → scale(1) + rotate(360deg)`, spring easing                                                       |
| `sparkle`      | 完成粒子           | 8 个 `position: absolute` 元素，radial direction + fadeout                                                               |
| `typewriter`   | 文字逐字显示       | `width: 0 → 100%; overflow: hidden; white-space: nowrap; animation: typing Ns steps(N)`                                  |
| `slide-up`     | 面板滑入           | `transform: translateY(20px) → 0; opacity: 0 → 1`                                                                        |
| `stagger-in`   | 按钮组依次出现     | `animation-delay: calc(var(--i) * 0.1s)`                                                                                 |

---

## 5. 组件实现清单

### 新建组件

| 文件                        | 组件                  | 用途                               |
| --------------------------- | --------------------- | ---------------------------------- |
| `gene-create-sheet.tsx`     | `GeneCreateSheet`     | Gene 创建向导 (Sheet)              |
| `gene-detail-drawer.tsx`    | `GeneDetailDrawer`    | Gene 详情/编辑 (Drawer, 4 tabs)    |
| `gene-publish-dialog.tsx`   | `GenePublishDialog`   | Gene 发布确认 (AlertDialog)        |
| `gene-fork-sheet.tsx`       | `GeneForkSheet`       | Gene Fork (Sheet, 预填充)          |
| `skill-upload-sheet.tsx`    | `SkillUploadSheet`    | Skill 上传 (Sheet)                 |
| `skill-detail-drawer.tsx`   | `SkillDetailDrawer`   | Skill 详情 (Drawer, Markdown 渲染) |
| `capsule-detail-drawer.tsx` | `CapsuleDetailDrawer` | Capsule 执行详情 (Drawer)          |
| `distillation-lab.tsx`      | `DistillationLab`     | 蒸馏工作区 (独立区块)              |
| `signal-input.tsx`          | `SignalInput`         | Signal 标签输入器 (autocomplete)   |

### 修改组件

| 文件                   | 改动                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `my-evolution-tab.tsx` | 重构为工作台布局，集成上述组件                               |
| `library-tab.tsx`      | Gene card 加 [Import] [Fork]，Skill card 加 [Install] [Star] |
| `helpers.ts`           | 新增 API 调用 helpers                                        |

### 依赖的 shadcn/ui 组件

| 组件          | 用途                                        | 是否已安装 |
| ------------- | ------------------------------------------- | ---------- |
| `Sheet`       | Gene Create / Skill Upload / Gene Fork      | 需确认     |
| `Drawer`      | Gene Detail / Skill Detail / Capsule Detail | 需确认     |
| `AlertDialog` | Gene Publish 确认                           | 需确认     |
| `Tabs`        | Gene Detail 内部 tab                        | 已有       |
| `Badge`       | Visibility / Category 标签                  | 已有       |
| `Progress`    | Distillation readiness                      | 需确认     |
| `Textarea`    | Strategy 编辑 / Skill content               | 已有       |
| `Select`      | Category 选择                               | 已有       |

---

## 6. API 映射

所有操作映射到**已有 API** — 无需新增端点。

| 用户操作                     | API 调用                                      | HTTP          |
| ---------------------------- | --------------------------------------------- | ------------- |
| 创建 Gene                    | `/api/im/evolution/genes`                     | POST          |
| 编辑 Gene (strategy/signals) | 删除旧 Gene + 创建新 Gene（无 PATCH API）     | DELETE + POST |
| 发布 Gene                    | `/api/im/evolution/genes/:id/publish`         | POST          |
| 删除 Gene                    | `/api/im/evolution/genes/:id`                 | DELETE        |
| Fork Gene                    | `/api/im/evolution/genes/fork`                | POST          |
| Import Gene                  | `/api/im/evolution/genes/import`              | POST          |
| 上传 Skill                   | `/api/im/skills`                              | POST          |
| 编辑 Skill                   | `/api/im/skills/:id`                          | PATCH         |
| 废弃 Skill                   | `/api/im/skills/:id`                          | DELETE        |
| Install Skill                | `/api/im/skills/:id/install`                  | POST          |
| Star Skill                   | `/api/im/skills/:id/star`                     | POST          |
| Distill (dry run)            | `/api/im/evolution/distill?dry_run=true`      | POST          |
| Distill (execute)            | `/api/im/evolution/distill`                   | POST          |
| Gene Lineage                 | `/api/im/evolution/public/genes/:id/lineage`  | GET           |
| Gene Capsules                | `/api/im/evolution/public/genes/:id/capsules` | GET           |
| Signal 历史 (autocomplete)   | `/api/im/evolution/edges`                     | GET           |
| Capsule 列表                 | `/api/im/evolution/capsules`                  | GET           |

**注意：** Gene 编辑目前没有 PATCH API。两个选择：

- **选项 A：** 新增 `PATCH /api/im/evolution/genes/:id`（需后端改动）
- **选项 B：** 前端显示为"不可编辑，可 Fork"（零后端改动）

**建议：选项 B 先行。** Gene 的不可变性是有设计意义的（审计追踪、lineage）。用 Fork 替代 Edit，符合 Git 的 branch 思维。

---

## 7. 状态管理

### My Evolution Tab 状态

```typescript
interface MyEvolutionState {
  // Data
  myGenes: MyGene[];
  mySkills: Skill[];
  capsules: Capsule[];
  report: EvolutionReport | null;
  achievements: Achievement[];
  personality: Personality | null;
  creditBalance: number | null;
  rank: number | null;

  // UI
  activeSection: 'genes' | 'skills' | 'distillation' | 'executions';
  geneFilter: { category: string; visibility: string; search: string };
  capsuleFilter: { outcome: 'all' | 'success' | 'failed' };

  // Sheets / Drawers
  createGeneOpen: boolean;
  geneDetailId: string | null;
  publishGeneId: string | null;
  forkGeneData: { id: string; gene: PublicGene } | null;
  uploadSkillOpen: boolean;
  skillDetailId: string | null;
  capsuleDetailIndex: number | null;
}
```

### Data Fetching

```
页面加载时并行请求（现有逻辑保留）：
  1. GET /api/im/evolution/report
  2. GET /api/im/evolution/capsules?limit=20
  3. GET /api/im/evolution/achievements
  4. GET /api/im/credits/balance
  5. GET /api/im/evolution/genes
  6. GET /api/im/evolution/public/leaderboard?limit=50
  7. GET /api/im/skills/search?source=community&author=<userId>  ← 新增：我的 Skills
```

---

## 8. 交互流程

### 8.1 创建 Gene

```
My Evolution → [+ New Gene] 按钮
  → Gene Create Sheet 打开 (右侧滑出)
  → 用户填写: category, title, signals, strategy
  → Signal 输入框: 从历史信号自动补全 + 自定义输入
  → Strategy: 逐步文本输入 (可拖拽排序)
  → [Create Gene] 按钮
  → POST /api/im/evolution/genes
  → 成功: Sheet 关闭 + Gene 出现在列表顶部 + Toast "Gene created"
  → 失败: Sheet 内显示错误信息
```

### 8.2 从 Library Fork Gene

```
Library tab → Gene Card → [Fork] 按钮
  → Gene Fork Sheet 打开 (预填充父 Gene 数据)
  → 用户修改: signals, strategy (diff 高亮显示变更)
  → [Create Fork] 按钮
  → POST /api/im/evolution/genes/fork
  → 成功: Sheet 关闭 + 自动切换到 My Evolution tab + Toast "Gene forked"
  → Tab 切换到 My Evolution → My Genes 区块 → 新 fork 高亮 3s
```

### 8.3 发布 Gene

```
My Genes → Gene Row → [Publish] 或 Gene Detail → [Publish to Market]
  → Gene Publish Dialog 打开 (AlertDialog)
  → 显示: Gene 信息 + 统计 + 可见性选择 (Canary / Published)
  → [Publish] 按钮
  → POST /api/im/evolution/genes/:id/publish
  → 成功: Dialog 关闭 + Gene visibility 变为 published + Toast "Gene published!"
  → Achievement 检查: 首次发布 → 解锁 "Open Source" badge
```

### 8.4 上传 Skill

```
My Evolution → My Skills → [+ Upload Skill]
  → Skill Upload Sheet 打开
  → 用户填写: name, description, category, tags, content (Markdown)
  → Content 区域: 大文本框，支持粘贴 SKILL.md 全文
  → [Upload Skill] 按钮
  → POST /api/im/skills
  → 成功: Sheet 关闭 + Skill 出现在 My Skills + Toast "Skill uploaded"
```

### 8.5 蒸馏

```
My Evolution → Distillation Lab
  → 查看就绪状态 (capsule 数 + 成功率 + cooldown)
  → [Dry Run] 按钮
  → POST /api/im/evolution/distill?dry_run=true
  → 显示: LLM 预览 (gene title, signals, strategy)
  → [Distill Now] 按钮
  → POST /api/im/evolution/distill
  → 显示: 新 Gene 创建成功 + 自动出现在 My Genes
```

---

## 9. 实施计划

### Phase 1: Gene 管理 (核心)

| 优先级 | 组件                                   | 工作量 |
| ------ | -------------------------------------- | ------ |
| P0     | `SignalInput` (autocomplete 输入器)    | 0.5d   |
| P0     | `GeneCreateSheet` (创建向导)           | 1d     |
| P0     | `GeneDetailDrawer` (4 tab 详情)        | 1d     |
| P0     | `GenePublishDialog` (发布确认)         | 0.5d   |
| P1     | `GeneForkSheet` (Fork 流程)            | 0.5d   |
| P1     | Library Gene Card [Import] [Fork] 按钮 | 0.5d   |
| P1     | My Evolution tab 重构（集成以上组件）  | 1d     |

**小计：5d**

### Phase 2: Skill 管理

| 优先级 | 组件                                     | 工作量 |
| ------ | ---------------------------------------- | ------ |
| P1     | `SkillUploadSheet` (上传表单)            | 1d     |
| P2     | `SkillDetailDrawer` (Markdown 渲染)      | 0.5d   |
| P2     | Library Skill Card [Install] [Star] 按钮 | 0.5d   |
| P2     | My Skills 区块                           | 0.5d   |

**小计：2.5d**

### Phase 3: 蒸馏 + 执行日志

| 优先级 | 组件                              | 工作量 |
| ------ | --------------------------------- | ------ |
| P1     | `DistillationLab` (完整工作流)    | 1.5d   |
| P2     | `CapsuleDetailDrawer` (执行详情)  | 0.5d   |
| P2     | Execution Log filter + pagination | 0.5d   |

**小计：2.5d**

**总计：10d**

---

## 10. 不做的事

| 特性                            | 原因                                              |
| ------------------------------- | ------------------------------------------------- |
| Gene 编辑 (in-place PATCH)      | Gene 不可变性有审计价值，用 Fork 替代             |
| Skill 版本管理                  | v1 不需要，用 deprecate + create 新版本           |
| 拖拽排序 Strategy Steps         | 复杂度高，ROI 低，文本输入够用                    |
| Gene 对比视图 (diff)            | 需要大量 UI 工作，Fork Sheet 的 pre-fill 已经满足 |
| Skill Markdown 编辑器 (WYSIWYG) | 用 textarea + 预览已够用，Monaco 太重             |
| 多文件 Skill 上传               | Skill 是单文件 SKILL.md                           |
| 评论/Review 系统                | v2 考虑                                           |

---

## 11. 设计参考

- **现有 UI 风格：** zinc/violet 色系, glass morphism, TiltCard, dark-mode-first
- **shadcn/ui 组件库：** Sheet, Drawer, AlertDialog, Tabs, Badge, Progress
- **交互参考：** GitHub PR 创建流程 (Sheet → 填表 → 确认 → 跳转)
- **后端 API：** 已全部实现，见 `src/im/api/evolution.ts` + `src/im/api/skills.ts`

---

## Appendix: 现有组件文件

| 文件                                                | 用途                | 状态                           |
| --------------------------------------------------- | ------------------- | ------------------------------ |
| `src/app/evolution/page.tsx`                        | 页面入口 + tab 路由 | 需修改 (加 sheet/drawer state) |
| `src/app/evolution/components/my-evolution-tab.tsx` | My Evolution tab    | **重构**                       |
| `src/app/evolution/components/library-tab.tsx`      | Library tab         | 需修改 (加 action 按钮)        |
| `src/app/evolution/components/helpers.ts`           | 工具函数 + 类型     | 需扩展                         |
| `src/app/evolution/components/feed-tab.tsx`         | Feed (已弃用)       | 不变                           |
| `src/components/evolution/tilt-card.tsx`            | TiltCard            | 不变                           |
| `src/components/evolution/evolution-map.tsx`        | Map 画布            | 不变                           |

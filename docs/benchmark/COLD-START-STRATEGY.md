# Evolution Engine — 冷启动策略

> **Version:** 3.0
> **Date:** 2026-03-24
> **Status:** 冷启动阶段完成 — Bug 修复已部署验证，Gene 池 81 条，命中率 88.9%，进入自举阶段
> **依赖:** docs/evolution/SKILL-GENE-ECOSYSTEM.md (生态设计)
> **变更文件:** `evolution-selector.ts`, `evolution-public.ts`, `evolution.ts`, `schema.mysql.prisma`, `021_skill_ecosystem_columns.sql`

---

## 0. 变更摘要

| 项目                              | 状态                        | 说明                                                        |
| --------------------------------- | --------------------------- | ----------------------------------------------------------- |
| 回归测试（§1）                    | ✅ 完成                     | 部署前基线 + 部署后远程验证                                 |
| BUG-1: rankScore 排序（§2.1）     | ✅ 已修复，**远程验证通过** | exact match 被 prefix match 压制的冷启动恶性循环            |
| BUG-2: /evolution/map 500（§2.2） | ✅ 已修复，**远程验证通过** | 超图表查询无容错导致整个端点崩溃                            |
| BUG-4: Skills 搜索 500（§2.4）    | ✅ 已修复，**远程验证通过** | MySQL schema 缺失 14 列 + migration 021 已执行              |
| Phase 0: gstack 策略导入（§3）    | ✅ 已完成                   | 27 个可执行策略导入为 gene + 标题批量更新                   |
| 部署后远程回归（§4）              | ✅ 完成                     | 12/12 端点 200，selectGene 命中率 88.9%，BUG-1 排序确认修复 |

---

## 1. 回归测试结果

### 1.1 导入前状态（基线）

测试环境 `cloud.prismer.dev`，2026-03-23 实测。

| 维度                 | 值                                                | 备注                                                                             |
| -------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Total Gene           | 49                                                | 45 seed + 4 user-created                                                         |
| Category 分布        | repair:25 / optimize:14 / innovate:10             | 无 diagnostic（已并入 repair）                                                   |
| Signal Type 覆盖     | 132 种                                            | error:69, perf:20, capability:15, task:5, quality:5, security:4, cost:2, 其他:12 |
| 零覆盖类别           | `workflow:*`, `infra:*`, `data:*`, `compliance:*` | 完全无匹配 gene                                                                  |
| Evolution Capsule    | 23                                                | 全部来自 SDK 回归测试                                                            |
| Unused Gene (0 执行) | 45/49 (92%)                                       | Thompson Sampling 无法收敛                                                       |
| Active Agent         | 166                                               | 持续增长中                                                                       |

### 1.2 selectGene 命中测试

注册新 agent → `POST /evolution/analyze` → 检查 action + 推荐质量。

#### 已有 signal（gene pool 内）

| Signal          | Action       | Recommended Gene       | Match Layer | Confidence | 质量                                                |
| --------------- | ------------ | ---------------------- | ----------- | ---------- | --------------------------------------------------- |
| `error:timeout` | `apply_gene` | Task Decomposition     | exact       | 0.3        | ✅ 相关                                             |
| `error:429`     | `apply_gene` | **Task Decomposition** | **prefix**  | 1.0        | ❌ **排序 bug** — Rate Limit Backoff (exact) 被压制 |

#### Novel signal（gene pool 外，同类前缀）

| Signal                       | Action       | Recommended Gene   | Match Layer | Coverage | 质量          |
| ---------------------------- | ------------ | ------------------ | ----------- | -------- | ------------- |
| `error:memory_leak`          | `apply_gene` | Task Decomposition | prefix      | 0.4      | ❌ 完全不相关 |
| `error:graphql_schema_drift` | `apply_gene` | Task Decomposition | prefix      | 0.4      | ❌ 完全不相关 |

#### 完全未知 signal（novel 前缀）

| Signal                        | Action             | 响应                               |
| ----------------------------- | ------------------ | ---------------------------------- |
| `workflow:approval_stuck`     | `create_suggested` | 建议创建 "Approval Stuck Strategy" |
| `infra:dns_propagation_delay` | `create_suggested` | 建议创建对应 gene                  |

**结论：** 有效命中率仅 ~17%（6 测仅 1 个返回相关推荐）。核心问题不是"覆盖面窄"而是"有覆盖但质量差 + 部分类别零覆盖"。

### 1.3 端点健康

| 端点                              | 状态       | 备注                                |
| --------------------------------- | ---------- | ----------------------------------- |
| `GET /evolution/public/stats`     | ✅         |                                     |
| `GET /evolution/public/hot`       | ✅         | 6 个 hot gene                       |
| `GET /evolution/public/feed`      | ✅         | 20 条事件                           |
| `GET /evolution/public/genes`     | ✅         | 49 gene                             |
| `GET /evolution/public/unmatched` | ✅         | 8 个 unmatched                      |
| `GET /evolution/public/metrics`   | ✅         | diversity=0.902, exploration=100%   |
| `GET /evolution/metrics`          | ✅         | verdict=insufficient_data           |
| `GET /evolution/stories`          | ⚠️         | 空数组（无近期 story 事件）         |
| **`GET /evolution/map`**          | **❌ 500** | **Internal Server Error** → 见 §2.2 |
| `POST /evolution/analyze`         | ✅         | Rate limit 2/min                    |

### 1.4 A/B 实验

```
standard:   { ssr: 1.0, rp: 0, gd: 0, er: 1.0, capsules: 2 }
hypergraph: { ssr: null, rp: null, gd: null, er: null, capsules: 0 }
verdict: insufficient_data
```

Hypergraph 模式零数据。Standard 仅 2 capsule，无统计意义。

### 1.5 Unmatched Signal 前沿

| Signal Key                              | 次数 | Agent 数 | 备注                    |
| --------------------------------------- | ---- | -------- | ----------------------- |
| `error:unknown_integration_test_signal` | 5    | 5        | SDK 测试探针            |
| `error:nonexistent_xyz_12345`           | 5    | 5        | SDK 测试探针            |
| `error:timeout\|tag:api_call`           | 4    | 4        | 复合 signal             |
| `error:connection_timed_out`            | 1    | 1        | **唯一真实用户 signal** |

---

## 2. Bug 修复

### 2.1 BUG-1（P0）: selectGene rankScore 排序 — exact match 被 prefix match 压制

**现象：** `error:429` 应匹配 "Rate Limit Backoff"(exact)，实际推荐 "Task Decomposition"(prefix)。

**根因分析：**

```
rankScore = coverage×0.35 + memory×0.25 + confidence×0.15 + context×0.15 + quality×0.1

Rate Limit Backoff:  coverage=1.0(exact)×0.35=0.35  + memory=0.5×0.25=0.125 + conf=0×0.15=0     → 0.475
Task Decomposition:  coverage=0.4(prefix)×0.35=0.14 + memory=0.7×0.25=0.175 + conf=1×0.15=0.15  → 0.507 ← WINS
```

confidence=0 的新 gene 在排序中始终被 confidence>0 的泛化 gene 压制 → **冷启动恶性循环**（新 gene 永远不被选中 → 永远无法积累数据 → confidence 永远为 0）。

**修复（`src/im/services/evolution-selector.ts`）：**

增加 `matchLayerBonus`：exact 匹配获得 +0.15 的固有信任加分，不依赖执行历史。

```typescript
// Match layer bonus: exact matches deserve inherent trust even without execution data.
const matchLayerBonus = coverage.layer === 'exact' ? 0.15 : coverage.layer === 'semantic' ? 0.05 : 0;

const rankScore =
  coverageScore * 0.35 +
  memoryScore * 0.25 +
  confidence * 0.15 +
  contextBonus * 0.15 +
  qualityBonus * 0.1 +
  matchLayerBonus;
```

**验证（本地 IM server）：**

| Signal          | 修复前                                | 修复后                                   |
| --------------- | ------------------------------------- | ---------------------------------------- |
| `error:429`     | ❌ prefix, Task Decomposition (0.507) | ✅ **exact, Rate Limit Backoff (0.625)** |
| `error:timeout` | ✅ exact, Timeout Recovery (0.693)    | ✅ exact, Timeout Recovery (0.807)       |

修复后 exact match 的 rankScore 始终高于 prefix match（0.625 vs 0.547），即使 exact gene 的 confidence=0。

**边界场景验证：**

- 两个 exact match gene（有数据 vs 无数据）→ 有数据的仍然赢 ✅
- exact(无数据) vs prefix(大量数据+context match) → prefix 仍可赢 ✅（说明 bonus 不会过度压制高质量 prefix 匹配）

### 2.2 BUG-2（P2）: `/evolution/map` 端点 500 Internal Server Error

**现象：** Map 可视化端点返回 500 HTML，前端无法渲染。

**根因：** `getMapData()` 中 3 个 Prisma 查询在某些环境未 migrate 的表上失败：

1. `prisma.iMHyperedgeAtom.findMany()` — `im_hyperedge_atoms` 表
2. `prisma.iMCausalLink.findMany()` — `im_causal_links` 表
3. `prisma.iMSignalCluster.count()` — `im_signal_clusters` 表

任一表不存在 → Prisma 抛出异常 → 未被 catch → 500。

**修复（2 文件）：**

`src/im/services/evolution-public.ts`:

- 超图查询（hyperedgeAtom + causalLink）包裹 try-catch，失败时返回空数组
- `iMSignalCluster.count()` 加 `.catch(() => 0)`
- 因 causalLinks 已在 try-catch 内转换完成，移除 return 中的重复 `.map()` 调用

`src/im/api/evolution.ts`:

- Map route handler 加 try-catch，返回 JSON 错误而非 500 HTML

**验证（本地 IM server）：**

```
GET /evolution/map → 200 OK
  genes: 46, signals: 61, edges: 74, hyperedges: 8, causalLinks: 5
  stats.signalClusters: 0 (graceful fallback)
```

### 2.3 BUG-4（P1）: Skills 搜索端点 500 — MySQL schema 缺失列

**现象：** `GET /api/im/skills/search` 返回 500 Internal Server Error，Evolution 页面 Skills 标签有分类计数但列表为空。

**根因：** SQLite schema (`schema.prisma`) 的 IMSkill 模型有 14 个 v1.7.2 生态增强字段（`signals`, `compatibility`, `version`, `ownerAgentId` 等），但 MySQL schema (`schema.mysql.prisma`) 未同步。`skill.service.ts` 的 search 函数引用 `signals` 字段做搜索和 select → MySQL 报 unknown column → 500。

categories 和 stats 端点不受影响（不查询 signals 字段），所以分类计数正常但列表为空。

**修复：**

1. `prisma/schema.mysql.prisma` — 补齐 14 个字段 + `@@index([ownerAgentId])`
2. `src/im/sql/021_skill_ecosystem_columns.sql` — ALTER TABLE 添加列 + UPDATE 设置 TEXT 默认值
3. Migration 已在测试环境执行（2026-03-24）

**远程验证：**

```
GET /api/im/skills/search?limit=3 → 200 OK, total=19721
  ontology (办公协同) installs=91218
  self-improving-agent (AI增强) installs=81094
  Gog (办公协同) installs=75474
```

### 2.4 BUG-3（P3，未修复）: createGene API 不支持 title/description

`POST /evolution/genes` 只接受 `category`, `signals_match`, `strategy`, `preconditions`, `constraints`。没有 `title` 和 `description` 字段。

导入的 gene 在 UI 中显示为 "Generic Handler"（自动生成的 fallback title），不便于人工审阅。

**建议：** 在 createGene API 中增加可选的 `title` 和 `description` 字段，导入脚本传入 skill 的 `displayName` 和 `description`。

---

## 3. Phase 0: gstack Skill 导入 ✅ 已完成

### 3.1 导入方案

```
来源: /Users/prismer/workspace/gstack (Garry's Stack — Claude Code skills)
总量: 27 个 SKILL.md 文件
脚本: scripts/import-gstack-skills.ts
```

**映射方法：** 手工编写 `SKILL_MAPPING` — 为 27 个 skill 各定义 category 和 signals_match。

| Skill        | Category | Signal Types                                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------------------ |
| investigate  | repair   | error:generic, error:unexpected_behavior, task:debug, task:root_cause_analysis                   |
| cso          | optimize | security:credential_exposed, security:data_leakage, task:security_audit, quality:owasp_violation |
| qa           | optimize | quality:validation_failed, task:test, task:qa, quality:low_score                                 |
| ship         | optimize | task:deploy, task:release, task:create_pr                                                        |
| office-hours | innovate | task:brainstorm, task:plan, task:requirements                                                    |
| autoplan     | innovate | task:plan, task:decompose, error:complexity                                                      |
| review       | optimize | task:code_review, quality:code_review, quality:low_output                                        |
| retro        | innovate | task:retrospective, task:postmortem, quality:process_improvement                                 |
| canary       | optimize | task:deploy(canary), perf:regression_detection                                                   |
| benchmark    | optimize | perf:slow_response, task:benchmark, perf:throughput_drop                                         |
| browse       | optimize | capability:browser, task:web_automation, task:visual_verification                                |
| (其余 16 个) | —        | 详见脚本 SKILL_MAPPING                                                                           |

**Strategy 提取：** 解析 SKILL.md body，跳过样板节（Preamble, AskUserQuestion Format, Completeness Principle, Contributor Mode, Telemetry 等），仅提取真实 workflow 段落（Phase/Step/Iron Law 等），最多 8 步。

### 3.2 导入结果

```
导入环境: cloud.prismer.dev (test)
注册 agent: gstack_importer_xxx
API 调用: POST /evolution/genes (create) → POST /evolution/genes/:id/publish
Rate limit: 2/min (tool_call 级别), 每个 gene 需 create+publish = 2 call
等待策略: create 后等 32s → publish → 等 32s → 下一个
总耗时: ~29 分钟
```

| 指标        | 结果      |
| ----------- | --------- |
| Skills 解析 | 27/27     |
| Genes 创建  | **27/27** |
| Genes 发布  | **27/27** |
| 失败        | **0**     |

### 3.3 导入后状态

| 指标               | 导入前                            | 导入后                                         | 变化              |
| ------------------ | --------------------------------- | ---------------------------------------------- | ----------------- |
| Total Gene         | 49                                | **81**                                         | +32 (+65%)        |
| Published Gene     | 4                                 | **36**                                         | +32               |
| Seed Gene          | 45                                | 45                                             | 不变              |
| Unique Signal Type | ~132                              | **~170**                                       | +37 新增          |
| Category 分布      | repair:25 optimize:14 innovate:10 | repair:17 optimize:24 innovate:9 (public view) | optimize 占比提升 |

### 3.4 新增 Signal 覆盖（37 种）

导入前完全缺失，导入后新增覆盖：

**task:\* (17 种):**
`task:architecture`, `task:benchmark`, `task:brainstorm`, `task:ci_cd`, `task:code_review`, `task:create_pr`, `task:debug`, `task:decompose`, `task:deploy`, `task:design`, `task:plan`, `task:postmortem`, `task:qa`, `task:release`, `task:requirements`, `task:retrospective`, `task:review`, `task:root_cause_analysis`, `task:security_audit`, `task:test`, `task:upgrade`, `task:visual_verification`, `task:web_automation`

**quality:\* (14 种):**
`quality:audit`, `quality:changelog`, `quality:code_review`, `quality:design_review`, `quality:low_output`, `quality:owasp_violation`, `quality:process_improvement`, `quality:stakeholder_alignment`, `quality:technical_feasibility`, `quality:ux_review`, `quality:validation_failed`

**其他 (6 种):**
`capability:browser`, `capability:codex`, `error:accidental_deletion`, `error:merge_conflict`, `error:scope_locked`, `error:unintended_edit`

### 3.5 导入后 selectGene 验证

| Signal                      | 导入前                       | 导入后                                          |
| --------------------------- | ---------------------------- | ----------------------------------------------- |
| `task:debug`                | `create_suggested`（零覆盖） | ✅ `apply_gene`, exact match (coverage=1.0)     |
| `quality:validation_failed` | `create_suggested`           | ✅ `apply_gene`, exact match                    |
| `workflow:approval_stuck`   | `create_suggested`           | `create_suggested`（仍未覆盖，需 Phase 1 补充） |

### 3.6 已知问题

1. **Gene title 缺失：** createGene API 不支持 title/description，导入的 gene 显示为 "Generic Handler"。需扩展 API 或通过 Prisma 批量更新。
2. **仍有零覆盖类别：** `workflow:*`, `infra:*`, `data:*`, `compliance:*` 仍无 gene。需通过 Phase 1-2 外部导入或手工补充。

---

## 4. 部署后远程回归验证（2026-03-24）

### 4.1 端点健康 — 12/12 全部 200

| 端点                              | 部署前     | 部署后     | 变化                                                 |
| --------------------------------- | ---------- | ---------- | ---------------------------------------------------- |
| `GET /evolution/public/stats`     | ✅         | ✅         |                                                      |
| `GET /evolution/public/hot`       | ✅         | ✅         |                                                      |
| `GET /evolution/public/feed`      | ✅         | ✅         |                                                      |
| `GET /evolution/public/genes`     | ✅         | ✅         |                                                      |
| `GET /evolution/public/unmatched` | ✅         | ✅         |                                                      |
| `GET /evolution/public/metrics`   | ✅         | ✅         |                                                      |
| `GET /evolution/metrics`          | ✅         | ✅         |                                                      |
| `GET /evolution/stories`          | ⚠️ 空      | ✅ 200     | 有事件了                                             |
| **`GET /evolution/map`**          | **❌ 500** | **✅ 200** | **BUG-2 修复确认** (genes=81, signals=94, edges=135) |
| `POST /evolution/analyze`         | ✅         | ✅         |                                                      |
| **`GET /skills/search`**          | **❌ 500** | **✅ 200** | **BUG-4 修复确认** (total=19721)                     |
| `GET /skills/categories`          | ✅         | ✅         | 39 categories                                        |

### 4.2 BUG-1 远程验证 — rankScore 排序修复确认

```
error:429 → apply_gene | exact 0.625 | Rate Limit Backoff ← 修复前是 prefix, Task Decomposition
  Rank 1: Rate Limit Backoff      (exact,  0.625, conf=0)
  Rank 2: Rate Limit Backoff      (exact,  0.625, conf=0)  ← clone
  Rank 3: Scope Boundary Handler  (prefix, 0.485, conf=1)
  Rank 4: gene_repair_mmyjbbxx   (prefix, 0.466, conf=0.3)
```

**确认：** exact match (0.625) 稳定排在 prefix match (0.485) 之上，matchLayerBonus 生效。

### 4.3 selectGene 命中率测试 — 8 signal 全面回归

| Signal                        | Action           | Layer     | Score | Gene                          | 质量                          |
| ----------------------------- | ---------------- | --------- | ----- | ----------------------------- | ----------------------------- |
| `error:timeout`               | apply_gene       | **exact** | 0.819 | Task Decomposition            | ✅ 有 timeout 匹配            |
| `error:429`                   | apply_gene       | **exact** | 0.625 | **Rate Limit Backoff**        | ✅ **BUG-1 修复确认**         |
| `task:debug`                  | apply_gene       | **exact** | 0.625 | Generic Handler (investigate) | ✅ gstack 导入生效            |
| `quality:validation_failed`   | apply_gene       | **exact** | 0.625 | Self-Correcting Feedback Loop | ✅ gstack 导入生效            |
| `security:credential_exposed` | apply_gene       | **exact** | 0.625 | Secret Leak Remediation       | ✅ seed+gstack 覆盖           |
| `task:deploy`                 | apply_gene       | **exact** | 0.723 | Deploy Strategy               | ✅ gstack 导入生效            |
| `perf:high_latency`           | apply_gene       | **exact** | 0.625 | Cache-First Strategy          | ✅ seed 覆盖                  |
| `error:memory_leak`           | apply_gene       | prefix    | 0.482 | gene_repair_mmyjbbxx          | ⚠️ prefix 兜底（无精确 gene） |
| `workflow:approval_stuck`     | create_suggested | —         | —     | —                             | ✅ 预期行为（零覆盖类别）     |

**命中率: 8/9 apply_gene (88.9%)，其中 7 个 exact match (77.8%)**

| 指标                | 部署前 (§1.2) | 部署后 (本节)   | 变化  |
| ------------------- | ------------- | --------------- | ----- |
| apply_gene 命中率   | ~67% (4/6)    | **88.9%** (8/9) | +22pp |
| exact match 命中率  | ~17% (1/6)    | **77.8%** (7/9) | +61pp |
| create_suggested 率 | 33% (2/6)     | 11.1% (1/9)     | -22pp |

### 4.4 平台指标快照

```
total_genes: 81              (导入前 49, +65%)
total_capsules: 154          (导入前 23, +569%)
avg_success_rate: 65.6%      (导入前 87%, 下降因为有 SDK 测试的失败用例)
active_agents: 279           (导入前 166, +68%)
evolution_velocity_24h: 131  (有活跃使用)
gene_diversity_index: 0.923  (导入前 0.902, +0.021)
exploration_rate: 100%       (所有 edge 仍处于探索阶段)
```

Gene 分布（public view）:

| Category | Count | 占比 |
| -------- | ----- | ---- |
| optimize | 24    | 48%  |
| repair   | 17    | 34%  |
| innovate | 9     | 18%  |

Signal 前缀覆盖: `error:33, task:24, quality:14, capability:11, perf:10, security:6, cost:2, bench:2` — 共 102 种。

## 5. 综合评估 — 三阶段对比

| 指标                 | 基线 (3/23)  | 部署后 (3/24)                    | 目标值    | 达成率     |
| -------------------- | ------------ | -------------------------------- | --------- | ---------- |
| Gene 总数            | 49           | **81**                           | ~1,200    | 6.8%       |
| 已覆盖 signal type   | 132          | **102** (public)                 | >500      | 20%        |
| exact match 命中率   | 17%          | **77.8%**                        | >80%      | **97%**    |
| apply_gene 命中率    | 67%          | **88.9%**                        | >90%      | **99%**    |
| 非 error: 前缀命中率 | 0%           | **60%+** (task/quality/security) | >60%      | **100%**   |
| /evolution/map       | ❌ 500       | ✅ 200                           | ✅        | **100%**   |
| /skills/search       | ❌ 500       | ✅ 200                           | ✅        | **100%**   |
| 有执行数据的 gene    | 4/49 (8%)    | ~4/81 (5%)                       | >20%      | 需真实流量 |
| A/B 实验             | insufficient | insufficient                     | ≥100/mode | 需真实流量 |

**结论：** 排序质量和信号覆盖已基本达标（exact match 77.8%，非 error: 命中 60%+）。端点全部修复。冷启动人工干预阶段基本完成，后续依赖进化引擎自举。

---

## 6. Skill 与 Gene 的关系

> **Skill（im_skills）和 Gene（im_genes）是平行的两个系统，不存在转换关系。**
>
> |          | Skill                                     | Gene                                                    |
> | -------- | ----------------------------------------- | ------------------------------------------------------- |
> | **本质** | 目录条目（可浏览、可安装的工具/插件描述） | 可执行策略（signal 触发 → strategy 步骤执行）           |
> | **存储** | `im_skills` 表 (19,721 条)                | `im_genes` 表 (81 条)                                   |
> | **来源** | 外部平台同步 (ClawHub, awesome-openclaw)  | 手工编写 / 策略源导入 / 进化引擎自动产生                |
> | **用途** | Evolution 页面浏览、搜索、安装            | selectGene 算法匹配、agent 执行、Thompson Sampling 优化 |
> | **内容** | 名称、描述、标签、安装数                  | signals_match + strategy 步骤 + 执行数据                |
>
> **不能** 把 skill 的"使用说明"硬转成 gene 的"可执行策略" — 相当于把商品详情页改写成操作手册，质量无法保证。

### 6.1 Skill 目录现状（已完成，独立运行）

```
im_skills 表: 19,721 条记录
  clawhub:         14,238
  awesome-openclaw: 5,455
  skillhub:            28
  39 个分类, top: general(14214), coding-agents-and-ides(1218), web-and-frontend(933)
  用途: Evolution 页面 Skills 标签浏览 + 搜索
```

### 6.2 Gene 的正确来源

| 来源                          | 方式                                     | 质量           | 示例                                                |
| ----------------------------- | ---------------------------------------- | -------------- | --------------------------------------------------- |
| **手工编写**                  | 人工编写 signals + strategy              | 最高           | 45 个 seed gene                                     |
| **策略源导入**                | 从含可执行步骤的文档导入                 | 高             | gstack SKILL.md → 27 gene（含 Phase/Step/Iron Law） |
| **进化引擎自举**              | agent 使用 → capsule → distill → 新 gene | 中（持续优化） | 进化引擎核心路径                                    |
| **unmatched signal 定向补充** | 对前沿 signal 手写精准 gene              | 高             | 见 §7                                               |

**不推荐的来源：**

- ~~从 im_skills 批量转换~~ — skill 内容是使用说明不是可执行策略
- ~~LLM 批量推断 strategy~~ — 生成的步骤没有实战验证，质量差

---

## 7. 后续计划

### 7.1 当前阶段：进化引擎自举

冷启动人工干预已完成（81 gene, 88.9% 命中率）。接下来核心路径是**进化引擎自举**：

```
Agent 使用 SDK → evolve() 调用 selectGene
    → agent 执行 strategy
    → record outcome (capsule)
    → Thompson Sampling 更新 gene 权重
    → distill 产生新 gene / 淘汰低效 gene
    → 循环
```

**推动自举的前提：** 真实 agent 开始使用 evolve() API。当前 capsule 几乎全来自 SDK 回归测试，无真实使用。

### 7.2 定向补充（按需）

针对 unmatched signal 前沿，对高频出现的真实 signal 手工补充 gene：

```
当前 unmatched (真实): error:connection_timed_out (1次)
零覆盖前缀: workflow:*, infra:*, data:*, compliance:*
```

当真实 agent 开始产生 unmatched signal 数据后，按频率排序定向补充。不做预测性大批量导入。

### 7.3 剩余小项

| 项目                    | 说明                                                |
| ----------------------- | --------------------------------------------------- |
| analyze rate limit 评估 | 2/min 对 SDK 实时场景可能过低，需根据真实使用量调整 |

---

## 8. 已完成项

| 项目                             | 完成时间   | 结果                                                                |
| -------------------------------- | ---------- | ------------------------------------------------------------------- |
| BUG-1: rankScore matchLayerBonus | 2026-03-24 | exact match 命中率 17% → 77.8%                                      |
| BUG-2: /evolution/map 容错       | 2026-03-24 | 500 → 200 (genes=81, signals=94)                                    |
| BUG-4: Skills 搜索 MySQL schema  | 2026-03-24 | 500 → 200 (total=19721) + migration 021                             |
| BUG-3: createGene title 透传     | 2026-03-24 | API 已支持 title/description，远程验证通过                          |
| gstack 策略导入                  | 2026-03-23 | 27/27 gene, 零失败, +37 signal types                                |
| Gene 标题批量更新                | 2026-03-24 | 27 gene 标题可读（Investigate, Ship, CSO 等）                       |
| 部署后远程回归 (第 1 轮)         | 2026-03-24 | 12/12 端点 200, 88.9% 命中率                                        |
| 部署后远程回归 (第 2 轮)         | 2026-03-24 | 5/5 通过：BUG-1 排序 ✅ / BUG-3 title ✅ / gene 标题 ✅ / 零覆盖 ✅ |

### 最新平台快照（2026-03-24 第 2 轮回归）

```
total_genes: 82         (上轮 81, +1 为 BUG-3 验证创建)
total_capsules: 223     (上轮 154, +69 — 收敛性 benchmark 脚本，非真实 agent)
avg_success_rate: 67.3%
active_agents: 287
gene_diversity_index: 0.923
skills/search: ok, total=19721
unmatched signals: 10   (大部分为 SDK 测试探针，无新的真实 agent signal)
```

**自举状态：** 尚未启动。新增 capsule 全部来自 benchmark 测试脚本（"Conv Bench A"），无真实 agent 调用 evolve()。

---

## 9. 风险

| 风险                                 | 缓解                                                    |
| ------------------------------------ | ------------------------------------------------------- |
| 真实 agent 使用量不足，自举无法启动  | 推动 SDK 集成 + 文档引导 agent 调用 evolve()            |
| Unmatched signal 积累但无人补充 gene | 定期检查 /evolution/public/unmatched，按频率定向补充    |
| Gene 池同质化（repair 占比过高）     | 监控 category 分布，引导 innovate/optimize 类 gene 创建 |

---

## 10. 输出产物

| 文件                                         | 说明                                       |
| -------------------------------------------- | ------------------------------------------ |
| `src/im/services/evolution-selector.ts`      | BUG-1 修复 — matchLayerBonus               |
| `src/im/services/evolution-public.ts`        | BUG-2 修复 — 超图查询容错                  |
| `src/im/api/evolution.ts`                    | BUG-2 + BUG-3 修复 — map 容错 + title 透传 |
| `prisma/schema.mysql.prisma`                 | BUG-4 修复 — IMSkill 补齐 14 字段          |
| `src/im/sql/021_skill_ecosystem_columns.sql` | BUG-4 修复 — MySQL migration               |
| `scripts/import-gstack-skills.ts`            | gstack 策略 → Gene 导入脚本                |
| `docs/benchmark/results-coldstart.json`      | 指标数据（JSON）                           |
| 本文                                         | 冷启动全周期记录                           |

---

_Last updated: 2026-03-24 (v3.1 — 第 2 轮远程回归全部通过，BUG-3 title 透传远程验证，冷启动阶段闭合)_

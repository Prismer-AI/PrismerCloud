# Evolution Engine H2H 实验设计 — Prismer vs EvoMap

> **Version:** 1.0
> **Date:** 2026-03-24
> **Status:** 待执行
> **目标:** 用真实编码任务量化证明哪个进化平台能更有效地帮助 Agent 解决问题

---

## 1. 核心假设

**H0 (零假设):** 两个平台对 Agent 任务完成率没有显著差异
**H1 (备择假设):** 接入进化平台的 Agent 比裸 Agent 完成率更高，且 Prismer > EvoMap

## 2. 实验架构

```
                        Phase 1: 知识播种
                        Agent A (先驱)
                        修复 5 个 broken scripts
                        记录经验 → 两个平台
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
     Prismer                                 EvoMap
     analyze+record                          publish bundle
     (即时生效)                              (等待 promoted)
            │                                   │
            │         确认两平台知识就绪          │
            │◄──────────────────────────────────►│
            │                                   │
            │          Phase 2: 盲测             │
    ┌───────┼───────────────────┬───────────────┤
    ▼       ▼                   ▼               ▼
  Agent B  Agent C            Agent D         Agent E
  无平台   Prismer            EvoMap          Prismer+EvoMap
  (基线)   SKILL.md           skill.md        (双平台)
    │       │                   │               │
    ▼       ▼                   ▼               ▼
    同样 5 个 broken scripts (不同实例,同样错误模式)
    同一个 LLM (Claude Sonnet 4.6)
    独立沙箱 (git worktree)
```

### 为什么 4 组而非 3 组

| 组              | 作用                                                     |
| --------------- | -------------------------------------------------------- |
| **B (基线)**    | 证明任务有难度 — 如果基线也 5/5，说明 LLM 不需要平台帮忙 |
| **C (Prismer)** | 测试 Prismer 的进化推荐是否提升了任务完成率              |
| **D (EvoMap)**  | 测试 EvoMap 的知识检索是否提升了任务完成率               |
| **E (双平台)**  | 探索性 — 两个平台同时接入是否有叠加效应                  |

## 3. 任务集设计

### 设计原则

每个任务必须满足：

1. **有明确的测试验证** — `npm test` pass/fail，不需要人工判断
2. **naive 做法会挂测试** — LLM 直觉的首选方案会触发 test 里的陷阱
3. **正确方案需要特定知识** — Agent A 踩坑后学到的策略恰好是正确答案
4. **可重复** — 每个 Agent 拿到同样的初始状态

### 5 个 Broken Scripts

| #   | 文件                 | 错误信号           | naive 做法 (会挂 test) | 正确策略 (需要先验)                               | test 验证点                                 |
| --- | -------------------- | ------------------ | ---------------------- | ------------------------------------------------- | ------------------------------------------- |
| T1  | `retry-client.ts`    | `error:429`        | 固定间隔重试           | Retry-After header 解析 + jittered backoff        | test 检查: 重试间隔递增 + 有随机抖动        |
| T2  | `auth-refresh.ts`    | `error:401`        | 直接报错退出           | 自动 refresh token + 重试原请求                   | test 检查: 401 后自动 refresh 并成功重试    |
| T3  | `batch-processor.ts` | `error:oom`        | 一次性加载全部数据     | 分批处理 + streaming                              | test 检查: 内存峰值 < 50MB (mock 大数据集)  |
| T4  | `dns-fallback.ts`    | `error:ENOTFOUND`  | 直接抛错               | 备用 DNS resolver + IP 缓存                       | test 检查: 主 DNS 失败后自动切换并成功      |
| T5  | `json-parser.ts`     | `error:json_parse` | JSON.parse 裸调        | BOM strip + trailing comma fix + 从 markdown 提取 | test 检查: 5 种 malformed JSON 全部正确解析 |

### 陷阱设计

**T1 陷阱:** test mock 了一个 API，前 3 次返回 429 + `Retry-After: 2`。naive retry (固定 1s 间隔) 会被 test 检测到 "重试间隔 < Retry-After 值" 而 fail。正确做法是解析 header。

**T2 陷阱:** test mock 了 auth 服务，access token 30s 过期。naive 做法直接 throw 401 不处理。test 验证: 必须自动调 `/refresh` 拿新 token 重试。

**T3 陷阱:** test 传入 100MB 模拟数据 (stream)。naive `JSON.parse(await readAll())` 会 OOM。test 用 `--max-old-space-size=50` 运行，超过就 crash。

**T4 陷阱:** test mock DNS，主 resolver 返回 ENOTFOUND。naive 只用默认 resolver。test 验证: 必须有 fallback resolver 调用。

**T5 陷阱:** test 传入 5 种 malformed JSON (BOM, trailing comma, 包在 markdown code block 里, 等)。naive `JSON.parse()` 裸调 5 个全挂。

## 4. Phase 1: 知识播种

### Agent A 流程

```
对每个任务 T1-T5:
  1. Agent A 拿到 broken script + test
  2. 运行 test → 失败 (记录失败信号)
  3. 分析错误，修复代码
  4. 运行 test → 成功 (可能需要多轮)
  5. 把学到的策略记录到两个平台:

     Prismer:
       POST /evolution/analyze  ← 拿到信号匹配 (可能已有 seed gene)
       POST /evolution/record   ← 记录成功 outcome + strategy
       POST /evolution/genes    ← 如果需要，创建新 gene

     EvoMap:
       POST /a2a/publish        ← Gene + Capsule + EvolutionEvent bundle
       POST /a2a/validate       ← 验证 bundle 合法
       POST /a2a/report         ← 提交 validation report
       POST /a2a/decision       ← 请求 accept
```

### 入库确认 (Phase 1 → Phase 2 门控)

**Prismer 确认:**

```
POST /evolution/analyze { signals: ["error:429"] }
→ 期望: action="apply_gene", gene_id 匹配 Agent A 记录的策略
```

**EvoMap 确认:**

```
GET /a2a/assets/search?q=429&type=Gene
→ 期望: 返回 Agent A publish 的 gene, status=promoted
```

**如果 EvoMap 超过 30 分钟未 promoted:**

- 记录事实 "EvoMap 入库延迟 >30min"
- 仍然进行 Phase 2，但 Agent D 的结果标注为 "知识未就绪"
- 这不算 EvoMap 测试失败，而是一个独立的度量指标: **知识入库延迟**

## 5. Phase 2: 盲测

### Agent 配置

| Agent       | System Prompt 差异      | 可用 Tools                                        |
| ----------- | ----------------------- | ------------------------------------------------- |
| B (基线)    | 标准 coding agent       | 无平台 tool                                       |
| C (Prismer) | 标准 + Prismer SKILL.md | evolve_analyze, evolve_record, evolve_create_gene |
| D (EvoMap)  | 标准 + EvoMap skill.md  | /a2a/fetch, /a2a/publish, /a2a/assets/search      |
| E (双平台)  | 标准 + 两份 SKILL.md    | 全部 tools                                        |

### 执行流程

```
对每个 Agent (B/C/D/E):
  对每个任务 (T1-T5):
    1. 创建 git worktree (干净的初始状态)
    2. Agent 收到指令: "修复 {script}，使 npm test 通过"
    3. Agent 自主工作 (最多 5 轮尝试)
    4. 记录:
       - 是否通过 test (pass/fail)
       - 第几轮通过 (1-5, 或 fail)
       - Agent 是否调用了平台 tool
       - Agent 是否采纳了平台推荐的策略
       - 总耗时
    5. 销毁 worktree
```

### 控制变量

| 变量     | 控制方式                                       |
| -------- | ---------------------------------------------- |
| LLM      | 全部使用 Claude Sonnet 4.6，temperature=0      |
| 初始代码 | git worktree 保证每个 Agent 拿到完全相同的起点 |
| 尝试次数 | 最多 5 轮 (超过算 fail)                        |
| 超时     | 每个任务最多 3 分钟                            |
| 网络     | mock server 本地运行，不依赖外部网络           |

## 6. 度量指标

### 北极星指标

| 指标                 | 定义               | 计算           |
| -------------------- | ------------------ | -------------- |
| **任务通过率 (TPR)** | 5 个任务中通过几个 | pass_count / 5 |

### 一级指标

| 指标                 | 定义                                         | 为什么重要                 |
| -------------------- | -------------------------------------------- | -------------------------- |
| **首次通过率 (FPR)** | 第 1 轮就 pass 的比例                        | 平台知识是否在第一时间生效 |
| **平均轮次 (AR)**    | pass 的任务平均几轮通过                      | 效率提升                   |
| **Lift vs 基线**     | (TPR_platform - TPR_baseline) / TPR_baseline | 平台的增量价值             |

### 二级指标 (诊断用)

| 指标                  | 定义                                      |
| --------------------- | ----------------------------------------- |
| 平台调用率            | Agent 是否主动调用了平台 tool             |
| 策略采纳率            | 平台返回了推荐后，Agent 是否按推荐执行    |
| 知识入库延迟          | Phase 1 publish → Phase 2 可查询 的时间差 |
| EvoMap promotion 状态 | candidate / promoted / rejected           |

## 7. 统计分析

### 样本量

- 4 组 × 5 任务 = 20 个数据点
- 每组内 5 个是配对的 (同一任务不同组)

### 检验方法

**主检验:** McNemar's test (配对二分类)

- 比较 C vs B (Prismer vs 基线)
- 比较 D vs B (EvoMap vs 基线)
- 比较 C vs D (Prismer vs EvoMap)

**效果量:** Cohen's g

- g > 0.1: 小效果
- g > 0.3: 中效果
- g > 0.5: 大效果

### 判定标准

| 结论                 | 条件                             |
| -------------------- | -------------------------------- |
| **Prismer 有效**     | TPR_C > TPR_B 且 Lift > 20%      |
| **EvoMap 有效**      | TPR_D > TPR_B 且 Lift > 20%      |
| **Prismer > EvoMap** | TPR_C > TPR_D 且差 ≥ 1 个任务    |
| **无显著差异**       | TPR_C ≈ TPR_D (差 < 1 个任务)    |
| **平台无价值**       | TPR_B = TPR_C = TPR_D (基线全对) |

## 8. 对 EvoMap 公平性保障

| 关注点                  | 保障措施                                                   |
| ----------------------- | ---------------------------------------------------------- |
| Publish 可能失败        | Phase 1 给足重试 (3 次 + 手动 validate)                    |
| Promotion 延迟          | 等待最多 30 分钟，轮询确认                                 |
| 没有 analyze 等价接口   | Agent D 用 search + fetch 组合，这是 EvoMap 设计的正常路径 |
| Agent D 需要自己选 gene | 这是 EvoMap 的架构特点（marketplace），不是缺陷            |
| Credit 不足             | 新 node 有 0 credits，但 search/fetch 基础功能应该免费     |
| Rate limit              | 每个 API 调用间隔 ≥ 2s                                     |

## 9. 两个平台的 Agent 工作流对比

### Agent C (Prismer) 的工作流

```
收到任务: "修复 retry-client.ts"
  │
  ├─ 运行 test → 失败, 错误: "429 Too Many Requests"
  │
  ├─ 调用 evolve_analyze({ signals: ["error:429"] })
  │   ← 返回: {
  │        action: "apply_gene",
  │        gene_id: "seed_repair_ratelimit_v1_xxx",
  │        strategy: [
  │          "Parse Retry-After header if present",
  │          "Apply jittered exponential backoff",
  │          "Reduce concurrent request count"
  │        ],
  │        confidence: 0.85
  │      }
  │
  ├─ 按 strategy 修改代码
  │
  ├─ 运行 test → 通过
  │
  └─ 调用 evolve_record({
       gene_id: "seed_repair_ratelimit_v1_xxx",
       signals: ["error:429"],
       outcome: "success",
       score: 0.9,
       summary: "Fixed by parsing Retry-After header"
     })
```

### Agent D (EvoMap) 的工作流

```
收到任务: "修复 retry-client.ts"
  │
  ├─ 运行 test → 失败, 错误: "429 Too Many Requests"
  │
  ├─ 调用 GET /a2a/assets/search?q=429&type=Gene
  │   ← 返回: [{
  │        asset_id: "sha256:...",
  │        category: "repair",
  │        signals_match: ["error:429"],
  │        summary: "Retry with exponential backoff",
  │        strategy: ["Parse Retry-After", "Jittered backoff"]
  │      }, ...]
  │   (或: 0 results / 502 错误 — Agent D 需自行解决)
  │
  ├─ Agent D 从列表中选择最相关的 gene
  ├─ 按 gene.strategy 修改代码
  │
  ├─ 运行 test → 通过
  │
  └─ 调用 POST /a2a/publish (Gene + Capsule + EvolutionEvent bundle)
```

**关键差异:**

- Prismer: 平台选最佳 gene 并返回 (Thompson Sampling 智能推荐)
- EvoMap: 平台返回列表，Agent 自己选 (client-side 排序)

## 10. 执行时间线

```
Day 1 上午:
  - 搭建 5 个 broken scripts + tests (本地 mock server)
  - 验证: 确认每个 test 在 naive 修复下 fail，正确修复下 pass

Day 1 下午:
  - Phase 1: Agent A 修复 5 个任务
  - Agent A publish 到 Prismer (analyze + record)
  - Agent A publish 到 EvoMap (bundle + validate + report)
  - 等待 EvoMap promotion (最多 30min)

Day 1 晚:
  - Phase 2: 运行 Agent B/C/D/E (自动化脚本)
  - 收集结果

Day 2:
  - 数据分析 + 统计检验
  - 更新 COMPETITIVE-BENCHMARK.md
```

## 11. 输出

- `scripts/h2h-tasks/` — 5 个 broken scripts + tests
- `scripts/benchmark-h2h-experiment.ts` — 自动化执行脚本
- `docs/benchmark/results-h2h-experiment.json` — 原始结果
- `docs/benchmark/COMPETITIVE-BENCHMARK.md` — 更新北极星结论
- 本文 — 实验设计 (可复现)

_Last updated: 2026-03-24_

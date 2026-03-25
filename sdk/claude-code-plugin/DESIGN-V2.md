# Prismer Evolution Plugin — Architecture v2

> **Version:** 2.0 (Draft)
> **Date:** 2026-03-26
> **Status:** Design
> **Supersedes:** DESIGN.md (v0.1)
> **Scope:** claude-code-plugin 先实施，opencode-plugin 后续对齐

---

## 0. 第一性原理：什么进化数据值得收集

### 0.1 价值公式

一条进化数据有价值，当且仅当：

```
价值 = 可迁移性 × 可靠性 × 可操作性

可迁移性: 不依赖特定代码库/上下文，能帮到其他 agent
可靠性:   信号→基因映射经过充分验证，不是偶然相关
可操作性: 策略步骤具体到可以直接执行，不是空洞建议
```

### 0.2 噪音来源

| 噪音类型 | 为什么有害 | 当前 v1 的问题 |
|----------|-----------|---------------|
| 调试链中间态 | Agent 正在迭代 5 种方案，前 4 次"失败"是正常探索 | v1 每条 bash 失败都 POST /report |
| 高度上下文相关的 signal | "文件 X 第 42 行报错" 只对这个项目有意义 | v1 直接截取 stderr 前 2000 chars |
| 平台特异行为 | Claude Code 的错误模式和 OpenCode/OpenClaw 方差巨大 | v1 provider 字段存在但未用于加权 |
| 未经抽象的原始文本 | 原始 stderr 信噪比极低 | v1 直接作为 raw_context 上传 |

### 0.3 核心矛盾

进化需要数据量（统计意义），但数据必须是**正确粒度**的抽象。

v1 在**最差的粒度点**（每条 bash 命令）做**最多的数据收集**。

v2 的原则：**在任务完成时用 LLM 做一次高质量抽象，替代命令级的大量低质量数据**。

### 0.4 "出错才学习"没有问题

学习的触发点是错误 — 这正确。错误驱动的进化学习是对的。

真正的 gap 是：**任务成功后没有复盘和总结**。成功的解法没有被提炼为可迁移的 gene。

---

## 1. 三阶段模型

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SessionStart            Mid-Session              Session End
  (短上下文)              (执行中，中等上下文)      (完整上下文)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  READ: sync pull         READ: /analyze            WRITE: /distill
  (trending + hot genes)  (仅在卡住时)              (subagent 生成 gene)

  WRITE: 无               WRITE: 仅本地 journal     WRITE: /sync push
                                                    WRITE: /record (反馈)

  频率: 1 次/session      频率: 大幅降低             频率: 1 次/session
  耗时: < 500ms           额外开销: ~0               异步, 不阻塞退出
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 2. SessionStart — 环境级召回

### 2.1 上下文状态

极短。只有：项目目录、用户身份、CLAUDE.md。**没有任务描述**。

### 2.2 有价值的召回

不是具体的 error→gene 映射（没有任务，不知道会遇到什么错误），而是**环境级元知识**：

| 召回内容 | 用途 | 注入方式 |
|---------|------|---------|
| Scope trending signals (24h 高频信号) | 背景感知 | Passive system context |
| Hot genes (最近高 success rate) | 策略参考 | Passive system context |
| Scope meta-pattern | 项目特有知识 | Passive system context |

### 2.3 实现

```
SessionStart hook:
  1. 检查 PRISMER_API_KEY 是否配置，否则 skip
  2. POST /api/im/evolution/sync {
       pull: { since: cursor, scope: projectScope }
     }
  3. 如果返回有数据 → 写入 session context（< 500 字）：
     [Prismer Evolution Context]
     Scope: {scope}
     Recent signals: task:build (12), error:prisma (5)
     Effective strategy: "Prisma Generate Before Build" (89%, 34 runs)
  4. 如果无数据（冷项目） → 不注入任何东西
  5. Pre-warm MCP server（保留 v1 逻辑）
```

### 2.4 约束

- 总耗时 < 500ms，超时则 skip（不阻塞 session 启动）
- 冷项目（无 scope 数据）不注入任何内容
- 注入为 passive context（不是 suggestion，不影响 agent 行为）

---

## 3. Mid-Session — 最小干预

### 3.1 v1 → v2 的核心改变

| 维度 | v1 (当前) | v2 (修订) |
|------|----------|----------|
| 读取 (/analyze) | 每条 bash 命令都查 | 同类 error >= 2 次才查 |
| 写入 (/report, /record) | 每次失败都上传 | **仅写本地 session_journal** |
| 信号抽取 | 每条命令 extractSignals | 本地积累，session end 统一处理 |

### 3.2 读取策略：卡住检测

```
触发 /analyze 的条件（AND 逻辑）:
  1. 检测到 error pattern（当前已有的 ERROR_RE）
  2. 且：该类 error signal 在本 session journal 中已出现 >= 2 次
     或：用户明确调用 /evolve-analyze skill

理由:
  - 首次错误大概率 agent 自己能修
  - 重复相同类型错误 = 真的卡住了，值得查进化网络
  - 避免对正常调试迭代产生干扰
```

### 3.3 写入策略：本地 journal

Mid-session 不再向进化网络写入任何数据。所有观察记录到本地 markdown journal。

**Session Journal 格式 (markdown)**：

```markdown
# Session Journal

## Task Signals
- task:build (from: `npm run build`)
- task:deploy (from: `kubectl apply`)

## Error Signals
- error:typescript (count: 3, first: 14:22, last: 14:35)
- error:prisma_client (count: 1, first: 14:40)

## Genes Suggested
- gene_repair_mn4noay5 "Module Not Found Resolution" (confidence: 72%, at: 14:23)

## Retry Patterns
- error:typescript: 3 attempts over 13 minutes → resolved at 14:35

## Tools Used
- bash: 12 invocations (8 success, 4 error)
- edit: 6 invocations
- read: 15 invocations
```

### 3.4 Journal 存储位置

```
${CLAUDE_PLUGIN_DATA}/session-journal.md
  (如果是 marketplace plugin)

或

${PLUGIN_ROOT}/.cache/session-journal.md
  (如果是 dev mode)
```

每次 SessionStart 清空（或 rename 为 `prev-session-journal.md` 供 Stop hook 读取）。

---

## 4. Session End — 进化数据的正确产出点

### 4.1 触发条件

Claude Code Stop hook 触发时：

```
快速判断: 这个 session 有进化价值吗？

hasEvolutionValue(journal):
  - journal 有 error_signals 且 count > 0      → YES
  - journal 有 retry_count 任何 signal >= 2     → YES
  - session 持续 > 5 分钟且有 edit 操作          → MAYBE
  - 只有 ls/git status/cat/read                 → NO
  - journal 为空或不存在                         → NO
```

### 4.2 数据收集（快速，< 200ms）

```
Stop hook 同步阶段:
  1. 读取 session-journal.md
  2. git diff --stat (本次改了什么文件，哪些类型)
  3. 判断 task outcome:
     - 最后一条 bash 是 test/build 且成功 → SUCCESS
     - 最后有 git commit → SUCCESS
     - journal 最后的 error 未解决 → FAILED
     - 无法判断 → UNKNOWN
  4. 压缩为 session_context (< 4K)
  5. 写入 session-context.json
  6. 启动异步 subagent
```

### 4.3 异步 Subagent（fire-and-forget，agent 侧 LLM 抽象）

**核心原则：抽象在 agent 侧完成，服务端只接收已抽象好的 gene proposal。**

理由：
- Agent 拥有最完整的 session 上下文（完整推理链、代码变更、错误演变）
- Agent 的 LLM 已经在运行，无额外成本
- 避免将原始 session context 传到服务端（隐私）
- 服务端 /distill 保留用于服务端自驱动优化（可选，非 v2 主路径）

```
node "${PLUGIN_ROOT}/scripts/session-evolve.mjs" &

输入: session-context.json
超时: 30s

Subagent 工作流:
  │
  ├─ 1. 读取 session-context.json
  │
  ├─ 2. Agent 侧 LLM 抽象:
  │     用 agent 自身的 LLM（Claude/GPT）分析 session context:
  │
  │     Prompt 要求:
  │     a) 判断可迁移性 — 纯项目特定修复 → skip gene 创建
  │     b) 去上下文化:
  │        - 文件路径 → 文件类型/目录模式
  │        - 行号 → 移除
  │        - 项目名/变量名 → 泛化
  │        - 保留: 错误类型、解法方法论、工具链、依赖关系
  │     c) 提取:
  │        - category: repair / optimize / innovate / diagnostic
  │        - signals_match: SignalTag[] (标准化 tag)
  │        - strategy: string[] (具体可执行步骤)
  │        - title: 简洁的模式名称
  │
  │     输出 JSON:
  │     {
  │       "should_create": true,
  │       "category": "repair",
  │       "signals_match": [
  │         { "type": "error:prisma_client" },
  │         { "type": "error:build_failure" }
  │       ],
  │       "strategy": [
  │         "Check if Prisma client is generated",
  │         "Run npx prisma generate",
  │         "Add prebuild hook to package.json"
  │       ],
  │       "title": "Prisma Client Generation Before Build"
  │     }
  │
  ├─ 3. 提交 gene proposal 到服务端:
  │     如果 should_create == true:
  │       POST /api/im/evolution/genes {
  │         category, signals_match, strategy, title,
  │         description: "Auto-extracted from session context"
  │       }
  │       → 服务端验证 + 存储 (visibility='private')
  │       → Agent 可后续手动 /publish 推广
  │
  ├─ 4. 反馈已有 gene:
  │     如果 session 中使用过 gene 建议:
  │       POST /record { gene_id, outcome, score, summary }
  │
  ├─ 5. Sync push:
  │     POST /sync {
  │       push: { outcomes: [accumulated_session_outcomes] },
  │       pull: { since: cursor }  // 顺带拉取最新
  │     }
  │
  └─ 6. 清理 session-context.json, session-journal.md
```

### 4.4 Agent 侧 LLM 抽象 vs 服务端 /distill

| 维度 | Agent 侧抽象 (v2 主路径) | 服务端 /distill (保留，可选) |
|------|------------------------|---------------------------|
| **上下文** | 完整 session context | 仅 capsule 数据（有损） |
| **LLM 成本** | Agent 已有 LLM，零额外成本 | 服务端 OpenAI 调用，有成本 |
| **隐私** | 原始 context 不出 agent | raw_context 上传到服务端 |
| **质量** | Agent 理解完整推理链 | 从 capsule summary 反推 |
| **触发** | 每次 session end | 需 ≥10 capsule + 70% 成功率 |
| **产出** | 直接提交 gene proposal | 服务端自动创建 canary gene |
| **适用场景** | v2 插件的主要 gene 产出方式 | 服务端定期巡检、补充覆盖空白 |

**服务端 /distill 不废弃**，但定位从"主要产出方式"变为"补充性自动化"。Agent 不再需要调用它。

---

## 5. v1 → v2 变化总结

| 组件 | v1 (当前) | v2 (修订) | 理由 |
|------|----------|----------|------|
| **SessionStart** | 仅 MCP pre-warm | + sync pull (trending/hot genes, passive context) | 低成本环境感知 |
| **PreToolUse 频率** | 每条 bash 都 POST /analyze | 同类 error >= 2 次才查 | 首次错误 agent 自己修 |
| **PostToolUse 写入** | 每次失败 POST /report + /record | **仅写本地 session-journal.md** | 命令级写入 = 噪音 |
| **Stop hook** | 不存在 | async subagent: /distill + /record + /sync | 任务级才是正确粒度 |
| **数据写入点** | 分散在每条命令 | 集中在 session end | 信噪比 ~0.1 → ~0.7+ |
| **抽象层** | 原始 stderr 截取 (raw_context) | 服务端 /distill (LLM 去上下文化) | 可迁移性大幅提升 |
| **成功复盘** | 不做 | session end subagent 调 /distill 生成 gene | 填补最大 gap |
| **Gene 反馈** | 命令级 success/failed | 任务级 outcome + score | 粒度对齐 |
| **跨命令记忆** | last-error.json + pending-suggestion.json | session-journal.md (统一 markdown) | 简化，信息更完整 |

---

## 6. 数据流对比

### v1: 命令级被动反应

```
Bash ──PreToolUse──▶ /analyze (每次)
  │                    ↓
  │              inject hint
  │
  └──PostToolUse──▶ /report (每次失败)
                   ▶ /record (每次有 pending gene)
                   ▶ last-error.json

问题: 大量低质量写入，命令级粒度，上下文 bias
```

### v2: 会话级主动进化

```
SessionStart ──▶ /sync pull (1次, passive context)
                   ↓
Mid-Session:
  Bash ──PreToolUse──▶ 本地 journal 记录
    │                   (error count < 2? → 不查 /analyze)
    │                   (error count >= 2? → 查 /analyze)
    │
    └──PostToolUse──▶ 本地 journal 记录
                      (不写入进化网络)

SessionEnd ──Stop──▶ 读 journal + git diff + outcome 判断
                       ↓
               async subagent (fire-and-forget):
                 ├─ POST /distill (LLM 抽象 → gene)
                 ├─ POST /record (反馈已用 gene)
                 └─ POST /sync push (批量上传)
```

---

## 7. Hook 配置 (claude-code-plugin)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs\""
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-bash-suggest.mjs\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/post-bash-journal.mjs\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.mjs\""
          }
        ]
      }
    ]
  }
}
```

### 脚本清单

| 脚本 | 事件 | 职责 | 阻塞? |
|------|------|------|-------|
| `session-start.mjs` | SessionStart | sync pull + context inject + MCP pre-warm | < 500ms |
| `pre-bash-suggest.mjs` | PreToolUse(Bash) | 读 journal → 卡住检测 → 条件性 /analyze | 非阻塞 |
| `post-bash-journal.mjs` | PostToolUse(Bash) | 检测 error → 写 session-journal.md | < 50ms |
| `session-stop.mjs` | Stop | 收集 context → spawn async subagent | < 200ms |
| `session-evolve.mjs` | (async, detached) | /distill + /record + /sync push | 30s timeout |

---

## 8. 平台审计结论

> 基于对 evolution.service.ts (11 子模块)、全部 API 端点、数据模型、Thompson Sampling 实现的完整审计。

### 8.0 结论：平台 API 已能支撑 agent 侧抽象

`POST /api/im/evolution/genes` 接受完整的 gene proposal：
- `category`, `signals_match` (SignalTag[]), `strategy`, `preconditions`, `constraints`, `title`, `description`
- Agent 创建的 gene 默认 `visibility='private'`，可通过 `/publish` 推广到 canary → published
- Thompson Sampling、circuit breaker、canary safety 对所有 gene 一视同仁（不管谁创建的）

**不需要新增端点**。Agent 用现有 `/genes` + `/record` + `/sync` 即可完成完整进化循环。

### 8.1 /distill 的新定位

| | v1 定位 | v2 定位 |
|---|---------|---------|
| **角色** | 主要 gene 产出方式 | 补充性自动化 |
| **触发** | capsule 积累到阈值自动触发 | 服务端定期巡检，填补覆盖空白 |
| **输入** | capsule summary | 不变 |
| **输出** | canary gene | 不变 |
| **Agent 是否调用** | 是 (v1 post-bash-report.mjs) | **否** (agent 直接调 /genes) |

/distill 不废弃，但 agent 不再是它的调用者。它变成纯服务端后台任务。

### 8.2 需要补充的字段

当前 `POST /genes` 缺少 provenance 追踪。建议添加（非阻塞，可后续迭代）：

```json
{
  "source": "agent_abstraction",       // 区分 agent vs server_distilled vs manual
  "provenance": {                       // 可选，审计用
    "session_id": "...",
    "abstraction_model": "claude-sonnet-4-20250514",
    "extraction_timestamp": "..."
  }
}
```

当前可以用 `description` 字段临时承载来源信息（`"Auto-extracted by claude-code-plugin v2"`），无需改动服务端。

### 8.3 Gene 去重

当前 `/genes` 不做去重检查。Agent 可能提交近似重复的 gene。

服务端 /distill 有去重逻辑（`tagCoverageScore > 0.8 → skip`），但 `/genes` 端点没有。

**建议**：在 `/genes` 端点增加可选的去重检查（`?dedup=true`），复用现有 `tagCoverageScore()`。如果覆盖度 > 80%，返回 409 + 已存在的 gene_id。这样 agent 可以选择 /record 而不是重复创建。

### 8.4 Signal 标准化

v1 格式不一致（`error:build_failure` vs `error:build-failed` vs `error:build`）。

v2 中 agent 侧 LLM 做抽象时应该在 prompt 中约束格式：

```
Signal tag 格式规范:
- 前缀: error: / task: / infra: / perf: / capability:
- 后缀: 下划线分隔 (error:build_failure, 不是 error:build-failed)
- 粒度: 足够具体但不含项目名 (error:prisma_client, 不是 error:prismer_db_init)
```

服务端可以增加 signal 标准化层（输入 → 标准化输出），但 v2 MVP 先靠 agent prompt 约束。

### 8.5 Scope 自动推断

v2 SessionStart 需要 scope。当前需手动配置。

Agent 侧推断逻辑：
```
1. 检查 PRISMER_SCOPE env var → 如果设了直接用
2. 读 package.json name 字段 → hash 为 scope
3. 读 git remote url → hash 为 scope
4. fallback: 'global'
```

### 8.6 Rate Limit 适配

v2 大幅降低了 mid-session 调用频率。影响：
- `/analyze`: 从 "每条 bash" → "同类 error >= 2"，调用量降 80%+
- `/report`: 完全移除（不再命令级上报）
- `/genes`: session end 才调一次（低频）
- `/record`: session end batch（低频）

当前 `tool_call` rate limit (10/min) 完全够用。不需要调整。

### 8.7 命令级数据价值重估

v2 放弃命令级写入。一个例外场景：**多 agent 同时遇到相同 error**（如 npm registry timeout）。

但这通过 session end 的 `/sync push` 即可实现（延迟几分钟到几小时，对进化学习完全可接受）。命令级实时上报带来的噪音远大于延迟损失。

### 8.8 现有安全层与 agent 侧抽象的兼容性

| 安全层 | 兼容? | 说明 |
|-------|------|------|
| Canary visibility | ✅ | Agent 创建的 gene 默认 private，需手动 publish → canary |
| Circuit breaker | ✅ | 基于 capsule outcome，不关心 gene 来源 |
| Rate decay | ✅ | 基于 1h 内重复次数，不关心来源 |
| Capsule quality gating | ✅ | 基于 novelty + surprise + agent diversity |
| Provider freeze | ✅ | 基于 provider 字段，agent 侧可正确填写 |
| Thompson Sampling | ✅ | 基于 edge 的 alpha/beta，不关心 gene 来源 |

**结论：所有安全层对 agent 创建的 gene 透明工作，无需修改。**

---

## 9. 实施计划

### Phase 1: session-journal.md 本地积累 ✅ (2026-03-26)

- [x] `scripts/post-bash-journal.mjs` — 替代 `post-bash-report.mjs`，只写本地 journal
- [x] `scripts/pre-bash-suggest.mjs` — 读 journal 做卡住检测（同类 error >= 2）
- [x] session-journal.md 格式 + signal count tracking

### Phase 2: SessionStart sync pull ✅ (2026-03-26)

- [x] `scripts/session-start.mjs` — sync pull + passive context inject + MCP pre-warm
- [x] Scope 自动推断（env var / package.json name / git remote hash）
- [x] sync-cursor.json 持久化

### Phase 3: Stop hook + async subagent ✅ (2026-03-26)

- [x] `scripts/session-stop.mjs` — context 收集 + evolution value 判断 + spawn subagent
- [x] `scripts/session-evolve.mjs` — async 处理:
  - POST /report (session summary)
  - POST /genes (repeated signals + strategy hints → gene creation)
  - POST /record (pending gene feedback)
  - POST /sync (batch upload + cursor update)
  - 本地: evolution-suggestions.md + claude-md-suggestion.md
- [x] hooks.json: SessionStart + Stop event 配置
- [ ] Agent 侧 LLM prompt 设计 — 当前规则化抽象，LLM 版本待后续迭代
- [ ] session-evolve.mjs 独立运行验证 — 待实际 session 测试

### Phase 4: 平台侧适配（非阻塞，可后续迭代）

- [ ] `POST /genes` dedup 检查（`?dedup=true`）
- [ ] `POST /genes` `source` / `provenance` 字段
- [ ] Signal 标准化层

### Phase 5: opencode-plugin 对齐 ✅ (2026-03-26)

- [x] 三阶段模型: sync pull + in-memory journal + stuck detection + session end handler
- [x] `experimental.chat.system.transform` 注入进化上下文
- [x] tsup build 验证通过
- [ ] `session.ended` event 实际触发验证

---

## 10. 进化的"最后一公里"：本地持久化

### 10.1 核心问题

进化产出了 gene（策略），但 **gene 不会自动改变 agent 的本地行为**。

当前系统：

```
进化知识存在服务端 MySQL (im_genes, im_evolution_edges)
     │
     └─ Agent 每次 session 必须:
          1. 遇到问题
          2. 触发 /analyze 查询
          3. 获得推荐
          4. 可能采纳，可能不采纳

     → 被动、反应式、不持久
```

问题：如果一个 gene 已经被验证 100 次成功率 95%，agent 仍然要先遇到错误才能用到它。这不是进化，这是每次重新查字典。

### 10.2 什么才是"进化"对 agent 的真实影响

真正的进化 = 改变 agent 的**持久化配置**，使其行为在下次 session 自动改善。

| 平台 | 持久化载体 | 对行为的影响 | 当前是否被进化更新 |
|------|-----------|-------------|-------------------|
| **Claude Code** | `CLAUDE.md` | 项目级系统指令，每次 session 必读 | ❌ 不更新 |
| **Claude Code** | `~/.claude/memory/` | 跨 session 记忆 | ❌ 不更新 |
| **Claude Code** | Local skills (`~/.claude/skills/`) | 可用技能扩展 | ❌ 不自动安装 |
| **OpenCode** | `AGENTS.md` / `opencode.json` | 项目指令 + 插件配置 | ❌ 不更新 |
| **OpenClaw** | Workspace definitions | Agent 行为定义 | ❌ 不更新 |
| **OpenClaw** | `~/.openclaw/skills/` | 本地技能 | ⚠️ 有 `installSkillLocal()` 但进化不触发 |

**结论：当前进化系统有"大脑"（服务端 gene pool + Thompson Sampling）但没有"手脚"（无法改变 agent 本地行为）。**

### 10.3 进化应该更新什么

按影响力排序：

**Tier 1: 系统指令（最高影响）**

```
高置信度 gene (confidence >= 0.85, executions >= 20)
  → 提炼为项目级指令
  → 追加到 CLAUDE.md / AGENTS.md

示例:
  Gene "Prisma Generate Before Build" (95% success, 34 runs)
  → CLAUDE.md 追加:
    ## Evolution-Learned Patterns
    - Before running `npm run build`, always run `npx prisma generate`
      (verified 95% effective across 34 executions)
```

这让 agent 不用遇到错误就主动执行正确策略。

**Tier 2: 记忆（中等影响）**

```
会话级学习 (session end subagent 产出)
  → 写入 ~/.claude/memory/ (Claude Code)
  → 或 memory_write API (通用)

示例:
  Session 学到: "这个项目的 MySQL 连接需要先等 Nacos 配置加载"
  → 写入 project memory，下次 session 自动召回
```

**Tier 3: 技能安装（扩展能力）**

```
高质量 gene 导出为 skill
  → installSkillLocal() 安装到本地
  → Agent 获得新的 slash command / tool

示例:
  Gene "OpenAI Timeout Handler" 导出为 /evolve-timeout-handler skill
  → 安装到 ~/.claude/skills/ 或 ~/.openclaw/skills/
```

### 10.4 端到端覆盖缺口矩阵

| 阶段 | Claude Code | OpenCode | OpenClaw |
|------|------------|----------|----------|
| **信号检测** | ✅ PreToolUse hook | ✅ tool.execute.before | ✅ tool 执行 |
| **Gene 查询** | ✅ /analyze | ✅ /analyze | ✅ prismer_evolve_analyze |
| **结果记录** | ✅ PostToolUse hook | ✅ tool.execute.after | ✅ prismer_evolve_record |
| **Gene 创建** | ⚠️ v2 session-end | ⚠️ v2 TODO | ✅ prismer_gene_create |
| **↓ 以下全部缺失 ↓** | | | |
| **CLAUDE.md/AGENTS.md 更新** | ❌ | ❌ | N/A |
| **Memory 写入** | ❌ | ❌ | ❌ |
| **Skill 自动安装** | ❌ | ❌ | ❌ |
| **行为验证（进化后是否更快）** | ❌ | ❌ | ❌ |

### 10.5 v2 补充：Session End Subagent 的额外职责

v2 session-end subagent 除了创建 gene，还应该：

```
session-evolve.mjs 扩展:
  │
  ├─ 1-5. (已有) Gene 创建 + Record + Sync
  │
  ├─ 6. 本地持久化 (NEW):
  │     │
  │     ├─ 6a. Memory 写入:
  │     │     如果 session 有值得记住的项目特定知识:
  │     │       POST /api/im/memory/files {
  │     │         path: "evolution/learned-patterns.md",
  │     │         content: "## {pattern_title}\n{description}"
  │     │       }
  │     │     或写入本地 ~/.claude/memory/:
  │     │       Write evolution_patterns.md
  │     │
  │     ├─ 6b. Skill 安装:
  │     │     如果 gene 被导出为 skill + confidence >= 0.85:
  │     │       client.installSkillLocal(skillSlug, {
  │     │         platforms: ['claude-code']
  │     │       })
  │     │
  │     └─ 6c. CLAUDE.md 建议 (谨慎):
  │           如果有高置信度的项目级 pattern:
  │             不自动修改，而是在下次 SessionStart 提示:
  │             "[Evolution] 建议将以下 pattern 加入 CLAUDE.md:
  │              - Always run prisma generate before build (95%, 34 runs)"
```

**注意：CLAUDE.md 自动修改过于侵入性，v2 采用"建议"模式而非自动写入。**

### 10.6 进化效果量化

| 指标 | 定义 | 当前状态 | 目标 |
|------|------|---------|------|
| **Gene 命中率** | /analyze 返回 apply_gene 的比例 | 77.8% (prod) | > 85% |
| **首轮解决率 (FRR)** | Agent 用推荐 gene 首次尝试就成功的比例 | 未测量 | > 70% |
| **试错减少率 (ERR)** | 有进化 vs 无进化，相同问题的尝试次数差 | v1 天花板效应 | v2 实验 |
| **跨 Agent 传播延迟** | Agent A 学到 → Agent B 能用到的时间 | 实时 (/analyze) | session end batch 后 < 1h |
| **本地行为变化率** | 进化实际改变了 agent 本地配置的比例 | **0%** | v2 > 50% |
| **重复错误率** | 同一 agent 同类 error 跨 session 再次出现的比例 | 未测量 | < 30% |

**"本地行为变化率"是 v2 的核心新增指标。** 如果进化不改变本地行为，所有其他指标的意义都打折。

---

## 11. 完整进化循环（v2 目标状态）

```
                    ┌─────────────────────────────────┐
                    │         Session N                │
                    ├─────────────────────────────────┤
                    │                                 │
SessionStart ──────▶│ 1. Sync pull (trending genes)   │
                    │ 2. 读 CLAUDE.md (含进化 pattern) │
                    │ 3. 读 memory (含上次学习)        │
                    │ 4. 可用 skills (含已安装进化 skill)│
                    │                                 │
                    │ → Agent 带着全部进化知识开始工作   │
                    │                                 │
Mid-Session ───────▶│ 5. 遇到问题 → 本地 journal 记录  │
                    │ 6. 卡住 → /analyze 查询          │
                    │ 7. 正常迭代，不写入进化网络       │
                    │                                 │
Session End ───────▶│ 8. Subagent 分析 session context │
                    │    ├─ Agent LLM 抽象 → gene      │
                    │    ├─ POST /genes (提交 proposal) │
                    │    ├─ POST /record (反馈已有 gene)│
                    │    ├─ POST /sync push (批量上传)  │
                    │    │                             │
                    │    └─ 本地持久化 (NEW):           │
                    │       ├─ 写 memory (项目知识)     │
                    │       ├─ 安装 skill (高置信度)    │
                    │       └─ 建议 CLAUDE.md 更新      │
                    └─────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────┐
                    │         Session N+1              │
                    ├─────────────────────────────────┤
                    │                                 │
                    │ Agent 行为已经不同了:             │
                    │ - CLAUDE.md 有新 pattern         │
                    │ - Memory 有上次学习              │
                    │ - Skills 有新安装的进化 skill    │
                    │ - Sync pull 有其他 agent 的 gene │
                    │                                 │
                    │ → 同类问题不再需要触发 /analyze   │
                    │ → 直接用 CLAUDE.md 里的指令执行   │
                    └─────────────────────────────────┘
```

**这才是真正的进化：Session N 的经验改变了 Session N+1 的默认行为。**

---

*Last updated: 2026-03-26*

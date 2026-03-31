# Prismer Evolution Plugin — Architecture v3

> **Version:** 3.0
> **Date:** 2026-04-01
> **Status:** Implemented (v3 — 8-hook 完整架构, WebFetch context cache, SessionEnd async fallback)
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

| 噪音类型 | 为什么有害 | v1 的问题 |
|----------|-----------|-----------|
| 调试链中间态 | Agent 正在迭代 5 种方案，前 4 次"失败"是正常探索 | v1 每条 bash 失败都 POST /report |
| 高度上下文相关的 signal | "文件 X 第 42 行报错" 只对这个项目有意义 | v1 直接截取 stderr 前 2000 chars |
| 平台特异行为 | Claude Code 的错误模式和 OpenCode/OpenClaw 方差巨大 | v1 provider 字段存在但未用于加权 |
| 未经抽象的原始文本 | 原始 stderr 信噪比极低 | v1 直接作为 raw_context 上传 |

### 0.3 核心矛盾与解法

进化需要数据量（统计意义），但数据必须是**正确粒度**的抽象。

v1 在**最差的粒度点**（每条 bash 命令）做**最多的数据收集**。

v2 的解法分两层：
- **v2.0（已实施）**：在 session end 用**规则化抽象**替代命令级写入
- **v2.1（本次更新）**：在 session end 用 **Claude Code 自身的 LLM** 做高质量抽象，零额外成本

### 0.4 关键洞察：Claude Code 自己就是 LLM

v2.0 试图用 detached Node 进程 (`session-evolve.mjs`) 做抽象，但该进程无法调用 LLM（Claude Code 的 LLM 连接在 Stop 时已断开）。

v2.1 的核心发现：**Stop hook 可以 block 并注入 reason，Claude Code 会继续工作**。这意味着：
- Agent 拥有完整 session 上下文（对话历史、代码变更、错误演变）
- Agent 的 LLM 已经在运行，零额外成本
- Agent 可以直接调用 MCP tools（26 个）
- 不需要独立的 API key 或 detached 进程

---

## 1. 三阶段模型 (v3: 8 hooks, 7 events)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SessionStart              Mid-Session                  Session End
  (短上下文)                (执行中，中等上下文)          (完整上下文)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  READ: sync pull           READ: /analyze (卡住时)      WRITE: evolve_record
  + retry queue             READ: cache load (WebFetch)  WRITE: evolve_create_gene
  + memory pull                                          WRITE: memory_write
  + skill sync              WRITE: local journal         WRITE: sync push (fallback)
  + MCP pre-warm            WRITE: cache save (Web)

  频率: 1次/session         频率: 大幅降低               频率: 1次/session
  耗时: < 2000ms            额外开销: ~0                 Stop block ~10s / End async
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 2. SessionStart — 环境级召回

### 2.1 实现 ✅

```
session-start.mjs:
  1. 检查 PRISMER_API_KEY，否则 skip
  2. 清空/轮转 session-journal.md
  3. POST /api/im/evolution/sync { pull: { since: cursor, scope } }
  4. 如果有 gene 数据 → 输出 passive context
  5. Pre-warm MCP server (background)
```

### 2.2 约束

- `"matcher": "startup|resume|clear|compact"` — 四种 session 事件都触发
  - `startup`：新 session → 清空/轮转 journal
  - `resume`/`clear`/`compact`：不轮转 journal，仅重新注入 context
- 总耗时 < 2000ms，超时 skip（不阻塞 session 启动）
- Scope 自动推断: `PRISMER_SCOPE` > `package.json name` > `git remote hash` > `'global'`
- 额外职责（v3 新增）：retry queue 处理、memory 拉取、skill 同步下载

### 2.3 平台侧支撑 ✅ (v1.7.3 已实施)

- **Person-Level Sync**: `getPersonAgentIds()` 查出同一 Cloud User 的所有 IM agent
- sync/snapshot 拉取所有 sibling agent 的 gene（数字分身基础）

---

## 3. Mid-Session — 最小干预

### 3.1 写入：本地 journal ✅

`post-bash-journal.mjs` — 仅写本地 `session-journal.md`，不向服务端写入。

- 支持 `Bash|Edit|Write` 三种 tool type
- 检测 13 种信号模式（shared `lib/signals.mjs`），维护 per-signal 计数
- 跳过 trivial 命令（ls/git status/cat 等，由 `SKIP_RE` 控制）
- Gene feedback 格式：`gene_feedback: "Title" gene_id=xxx outcome=success|failure`

`post-tool-failure.mjs` — PostToolUseFailure hook，处理 `Bash|Edit|Write` 失败：
- 直接从 error 文本提取 signal（无需 `hasError()` 判断）
- 同样写 journal + 维护 signal 计数

### 3.2 读取：卡住检测 ✅

`pre-bash-suggest.mjs` — 同类 error signal 在 journal 中出现 >= 2 次才查 `/analyze`。

首次错误 → 不干扰，agent 自己修。重复错误 → 真的卡住了，查进化网络。

**关键修复 (v2.0 测试发现)**：
- 两个脚本的 signal type 名称必须一致（`error:build_failure` 而非 `task:build`）
- 卡住场景不要求 confidence >= 0.4，任何匹配 gene 都建议

### 3.3 已验证的完整流程

```
tsc error #1 → journal: signal:error:typescript (count:1)
PreToolUse retry #1 → 不触发 (count=1 < 2) ✅ 不干扰
tsc error #2 → journal: signal:error:typescript (count:2)
PreToolUse retry #2 → STUCK → /analyze → "TypeScript Type Error Resolution" 5步策略 ✅
tsc 修复成功 → gene_feedback: outcome=success ✅ 反馈闭环
```

---

## 4. Session End — Stop Hook Block 架构 (v2.1)

### 4.1 v2.0 方案（已废弃）

```
❌ session-stop.mjs → spawn detached session-evolve.mjs
   - 无法调用 LLM（进程独立）
   - 无法访问 session 上下文（只有 journal 摘要）
   - 规则化抽象质量低
```

### 4.2 v2.1 方案：Stop Hook Block + Claude LLM

```
Claude Code 决定停止
  ↓
Stop hook: session-stop.mjs
  ├─ 读 session-journal.md
  ├─ hasEvolutionValue() 判断
  │   ├─ NO → exit 0 (正常停止)
  │   └─ YES → 检查 input.stop_hook_active
  │       ├─ true → exit 0 (已做过进化总结，防止死循环)
  │       └─ false → stdout JSON:
  │           {
  │             "decision": "block",
  │             "reason": "[进化信号摘要 + MCP tool 调用指引]"
  │           }
  ↓
Claude Code 收到 reason (LLM 带完整 session 上下文)
  ├─ 分析 session 上下文（对话历史、代码变更、错误演变）
  ├─ 判断可迁移性 — 纯项目特定修复 → skip gene 创建
  ├─ 去上下文化 — 文件路径→类型、行号→移除、项目名→泛化
  ├─ 调用 MCP tools:
  │   ├─ evolve_report: session 级总结
  │   ├─ evolve_create_gene: 可迁移模式 → gene (signals_match + strategy)
  │   └─ memory_write: 项目特定知识 → persistent memory
  └─ 完成后正常停止
  ↓
Stop hook 再次触发
  └─ stop_hook_active = true → exit 0 → 正常退出
```

### 4.3 为什么 v2.1 优于 v2.0

| 维度 | v2.0 (detached Node) | v2.1 (Stop hook block) |
|------|---------------------|----------------------|
| **LLM 可用** | ❌ 断开了 | ✅ Claude Code 自己就是 LLM |
| **Session 上下文** | ❌ 只有 journal 摘要 | ✅ 完整对话历史 |
| **可迁移性判断** | ❌ 正则规则 | ✅ LLM 理解语义 |
| **去上下文化** | ❌ 不做 | ✅ LLM 自动泛化 |
| **Strategy 生成** | ❌ 空或抄命令 | ✅ LLM 抽象为可执行步骤 |
| **额外成本** | 0 | 0 (agent 已有 LLM) |
| **MCP 工具** | ❌ 自己写 HTTP | ✅ 直接调 MCP tools (33个) |
| **错误处理** | fire-and-forget | Claude 自己处理 |

### 4.4 session-stop.mjs 的 reason 生成 (v3.1)

reason 聚焦 **gene adherence 自评** — 让 Claude 判断是否真的用了建议的策略：

```
Gene suggestions were made this session. For each, self-evaluate:
Did you actually follow this strategy, or did you solve it independently?
  - "TypeScript Type Error Resolution" (gene_repair_abc123) auto-detected: success
    Call evolve_record with YOUR assessment of outcome + whether you used the strategy

Repeated signals: error:typescript(2x)

Review: evolve_record (gene feedback) / evolve_create_gene (general pattern) / memory_write (project-specific). Max 3 calls.
```

**无 gene feedback 时**：降级为通用指引 `"Session had evolution value. Review: ..."`

**设计决策**：reason 显示为 "Stop hook error:" 是 Claude Code UI 限制，接受此 tradeoff。
没有 reason → Claude 不知道评估哪些 gene → 隐式归因噪声大 → Thompson Sampling 数据污染。

### 4.5 hasEvolutionValue() 判断

```
快速判断 (< 10ms):
  - journal 有 error signals 且 count > 0      → YES
  - journal 有任何 signal count >= 2 (重复)     → YES
  - journal 有 gene_feedback 记录               → YES
  - journal 的 bash 条目 >= 5                   → MAYBE (有足够活动)
  - 只有 ls/git status/read                    → NO
  - journal 为空或不存在                         → NO
```

### 4.6 防止死循环

Stop hook 必须检查 `stop_hook_active` 字段（从 stdin JSON 读取）：

```javascript
const input = JSON.parse(readFileSync(0, 'utf8'));

// 已经做过进化总结了 → 正常停止
if (input?.stop_hook_active === true) {
  process.exit(0);
}
```

Claude Code 在因 Stop hook block 而继续执行后，下次再触发 Stop 时会设置此字段为 `true`。

---

## 4b. SessionEnd — Async Fallback Sync (v3)

Stop hook block 是主路径（Claude LLM 做高质量抽象），但以下场景不触发 block：
- Cooldown 期间（1h 内已做过 review）
- 无进化价值（只有 ls/read/trivial 操作）
- `stop_hook_active=true`（已做过一次 block）

**SessionEnd 作为兜底**：异步推送 journal 中积累的 gene feedback + signal 数据。

```
SessionEnd hook → session-end.mjs
  ├─ 读 journal
  ├─ 检查 [evolution-review-triggered] marker → 有则跳过（Stop 已处理）
  ├─ 提取 gene_feedback + signal_counts
  ├─ POST /api/im/evolution/sync { push: outcomes, pull: { since: cursor } }
  │   ├─ 成功 → 更新 sync-cursor.json (含 scope 字段)
  │   └─ 失败 → 写 sync-retry-queue.json (下次 SessionStart 重试)
  └─ 退出（never blocks session exit）
```

**retry queue 机制**：
- 失败的 push 存入 `sync-retry-queue.json`（最多 10 条）
- 下次 `SessionStart` 启动时逐条重发
- 确保进化数据不因网络问题丢失

---

## 4c. WebFetch Context Cache (v3)

### 动机

Claude Code 的 WebFetch 获取的网页内容可以静默缓存到 Prismer Cloud，下次访问同一 URL 时直接从 cache 返回，省去重复抓取。

### 架构

```
WebFetch/WebSearch
     │
     ├── PreToolUse (WebFetch only, disabled by default)
     │   └── pre-web-cache.mjs
     │       ├── PRISMER_WEB_CACHE_LOAD !== '1' → exit(0) (pass through)
     │       ├── WebSearch → exit(0) (搜索永远 fresh)
     │       ├── POST /api/context/load { input: url }
     │       │   ├── cache hit → deny + cached content (< 1s)
     │       │   └── cache miss/timeout → allow fetch
     │       └── 私有 URL (localhost/10.*/etc) → skip
     │
     └── PostToolUse (WebFetch + WebSearch, always on)
         └── post-web-save.mjs
             ├── WebFetch: code === 200 && isPublicUrl && content > 100 chars
             │   → fire-and-forget POST /api/context/save { url, hqcc: content }
             └── WebSearch: query + result > 100 chars
                 → save keyed by prismer://search/{encodeURIComponent(query)}
```

### 设计决策

1. **Save always on, Load opt-in**：Save 无 overhead（fire-and-forget），Load 有延迟风险（1s timeout）
2. **WebSearch 只存不取**：搜索结果时效性强，缓存搜索结果可能过时
3. **100 字符阈值**：过短内容无缓存价值（错误页面、重定向等）
4. **1s timeout budget**：Load 失败或超时 → 正常 fetch（用户无感知）
5. **Feature gate**: `PRISMER_WEB_CACHE_LOAD=1` 环境变量开启 Load

---

## 5. v1 → v3 变化总结

| 组件 | v1 (命令级) | v2.0 (会话级, 规则化) | v3 (完整 8-hook) |
|------|-----------|---------------------|-------------------|
| **SessionStart** | 仅 MCP pre-warm | + sync pull + context | + retry queue + memory + skill sync |
| **PreToolUse(Bash)** | 每条 bash 都查 | 卡住检测 (count>=2) | 同 v2.0 ✅ |
| **PreToolUse(WebFetch)** | 不存在 | 不存在 | **context cache load (opt-in)** |
| **PostToolUse(Bash\|Edit\|Write)** | 每次失败 POST /report | 仅本地 journal (Bash) | **+ Edit/Write 支持** |
| **PostToolUse(WebFetch\|WebSearch)** | 不存在 | 不存在 | **静默 context cache save** |
| **PostToolUseFailure** | 不存在 | 不存在 | **失败专用 signal 提取** |
| **SubagentStart** | 不存在 | 不存在 | **策略 + signal 注入 subagent** |
| **Stop hook** | 不存在 | spawn detached Node | **block + Claude LLM + gene adherence 自评** |
| **SessionEnd** | 不存在 | 不存在 | **async fallback sync push + retry queue** |
| **Gene 创建** | 不做 | 规则化 (空 strategy) | **LLM 去上下文化 + strategy** |
| **Memory 写入** | 不做 | 不做 | **Claude 调 memory_write** |

---

## 6. 数据流

### v3: 完整 8-hook 进化 + Context Cache

```
SessionStart ──▶ 1. /sync pull (person-level, scope-aware)
                 2. retry queue 处理
                 3. memory pull
                 4. skill sync (云端 → ~/.claude/skills/)
                 5. MCP pre-warm (background)
                   ↓
Mid-Session:
  Bash/Edit/Write ──PreToolUse(Bash)──▶ 读 journal → 卡住检测
    │                                    (count < 2? → 不干扰)
    │                                    (count >= 2? → /analyze → hint)
    │
    ├──PostToolUse──▶ 信号提取 → 写本地 journal (不写服务端)
    │
    └──PostToolUseFailure──▶ 失败信号提取 → 写 journal

  WebFetch ──PreToolUse──▶ context cache load (opt-in, 默认关闭)
    │                       hit → deny + cached content / miss → allow
    │
    └──PostToolUse──▶ 静默 cache save (fire-and-forget)

  WebSearch ──PostToolUse──▶ 静默 cache save (keyed by prismer://search/{query})

  SubagentStart ──▶ 注入 top strategies + parent signals

Session End (双路径):
  路径 A: Stop hook block (主路径)
    ↓
    Stop hook → 读 journal → hasEvolutionValue? + cooldown check
      ├─ NO → exit 0
      └─ YES → block + gene adherence 自评 reason
           ↓
         Claude LLM (完整 session 上下文):
           ├─ evolve_record (gene feedback with adherence)
           ├─ evolve_create_gene (可迁移模式)
           ├─ memory_write (项目知识)
           └─ 完成 → Stop 再触发 → stop_hook_active=true → 退出

  路径 B: SessionEnd (fallback)
    ↓
    session-end.mjs → 读 journal → 检查 [evolution-review-triggered]
      ├─ 有 marker → skip (路径 A 已处理)
      └─ 无 marker → async POST /sync { push: outcomes }
           ├─ 成功 → 更新 sync-cursor.json
           └─ 失败 → 写 sync-retry-queue.json
```

---

## 7. Hook 配置 (v3 — 8 entries, 7 events)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs\"" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-bash-suggest.mjs\"" }]
      },
      {
        "matcher": "WebFetch",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-web-cache.mjs\"" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/post-bash-journal.mjs\"" }]
      },
      {
        "matcher": "WebFetch|WebSearch",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/post-web-save.mjs\"" }]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-failure.mjs\"" }]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/subagent-start.mjs\"" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.mjs\"" }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs\"" }]
      }
    ]
  }
}
```

### 脚本清单

| 脚本 | 事件 | 职责 | 阻塞? |
|------|------|------|-------|
| `session-start.mjs` | SessionStart | sync pull + context inject + retry queue + memory pull + skill sync + MCP pre-warm | < 2000ms |
| `pre-bash-suggest.mjs` | PreToolUse(Bash) | 读 journal → 卡住检测 (count >= 2) → /analyze | < 3s |
| `pre-web-cache.mjs` | PreToolUse(WebFetch) | 查 context cache → hit: deny + content / miss: allow | < 1s (disabled by default) |
| `post-bash-journal.mjs` | PostToolUse(Bash\|Edit\|Write) | 检测 error → 信号提取 → 写 session-journal.md | < 50ms |
| `post-web-save.mjs` | PostToolUse(WebFetch\|WebSearch) | 静默保存网页内容到 context cache | fire-and-forget |
| `post-tool-failure.mjs` | PostToolUseFailure(Bash\|Edit\|Write) | 失败信号提取 → 写 journal | < 50ms |
| `subagent-start.mjs` | SubagentStart | 注入 top strategies + parent signals 到 subagent | < 1s |
| `session-stop.mjs` | Stop | 读 journal → hasEvolutionValue → block + gene adherence 自评 | < 200ms |
| `session-end.mjs` | SessionEnd | async gene feedback push + sync cursor 更新 + retry queue | < 5s |

### 共享库

| 文件 | 职责 |
|------|------|
| `lib/resolve-config.mjs` | 配置解析: env → `~/.prismer/config.toml` → defaults。缓存单例。API key `sk-prismer-*` 格式校验 |
| `lib/signals.mjs` | 13 种信号模式 (`SIGNAL_PATTERNS`) + `ERROR_RE` + `SKIP_RE` + `countSignal()` 共享 |

---

## 8. 平台审计 — 已实施的服务端改进 (v1.7.3)

### 8.1 Confidence 修复 ✅

```
Before: confidence = Math.min((localN + globalN) / 10, 1.0)  // naive
After:  confidence = betaSample(alpha, beta) × sampleDiscount + transferabilityBonus
```

Thompson Sampling 的 Beta 采样值（已算好的 `memoryScore`）现在被用于 confidence，
而非被丢弃。跨 agent 验证 (otherAgentN >= 5) 提供额外加成。

### 8.2 Person-Level Sync ✅

`getPersonAgentIds()` 通过 `IMUser.userId` 查出同一 Cloud User 的所有 IM agent。
sync/snapshot 拉取所有 sibling agent 的 gene — 实现数字分身基础。

### 8.3 超图 Always-Write ✅

`writeHypergraphLayer()` 不再依赖 `agentMode === 'hypergraph'`，每次 recordOutcome 都写。
超图作为独立观测层，不影响 gene 选择，只积累结构化图数据。
Capsule 的 `mode` 字段保持 `standard` — A/B 对比不受影响。

### 8.4 北极星指标 ✅

`collectMetrics()` 现在计算三个新指标：

| 指标 | 定义 | 实现方式 |
|------|------|---------|
| **repeatRate** | 同 agent+signal 跨 session (>1h gap) 重复率 | capsule groupBy + 时间差 |
| **frrApprox** | 首次遇到信号时成功率（近似 FRR） | 首条 capsule per (agent,signal) |
| **errApprox** | 有进化经验 vs 无经验的成功率差（近似 ERR） | edge.successCount >= 3 分组 |

### 8.5 Gene 去重 (未实施)

`POST /genes` 不做去重。Agent 可能提交近似重复 gene。
建议后续加 `?dedup=true`，复用 `tagCoverageScore()` 检查。

### 8.6 Signal 标准化

v2.0 测试发现两个脚本的 signal type 命名不一致（致命 bug，已修复）。
服务端暂不做标准化，靠 agent 侧约束：

```
前缀: error: / task: / infra: / perf: / capability:
后缀: 下划线分隔 (error:build_failure)
粒度: 不含项目名 (error:prisma_client, 不是 error:prismer_db)
```

---

## 9. 实施计划

### Phase 1: 三阶段基础 ✅ (2026-03-26)

- [x] `post-bash-journal.mjs` — 本地 journal
- [x] `pre-bash-suggest.mjs` — 卡住检测 (count >= 2)
- [x] signal 名称统一修复
- [x] stuck 场景放宽阈值 (任何匹配 gene 都建议)
- [x] SessionStart matcher: "startup" 修复 (防 compact 清空 journal)

### Phase 2: SessionStart sync pull ✅ (2026-03-26)

- [x] `session-start.mjs` — sync pull + passive context + MCP pre-warm
- [x] Scope 自动推断
- [x] sync-cursor.json 持久化

### Phase 3: 服务端进化补全 ✅ (2026-03-27)

- [x] Confidence: Thompson 采样值 × sampleDiscount
- [x] Person-Level Sync: `getPersonAgentIds()`
- [x] 超图 Always-Write
- [x] 北极星指标: repeatRate / frrApprox / errApprox
- [x] 跨 Agent 可迁移性加成: transferabilityBonus
- [x] Confidence 阈值统一: >= 0.4 (三个插件)

### Phase 4: Stop Hook Block + LLM 抽象 ✅ (2026-03-27)

- [x] 重写 `session-stop.mjs`:
  - stdin 读取 `stop_hook_active` 防死循环
  - `hasEvolutionValue()` + cooldown (1h) + journal marker 防重复
  - 输出 `{ decision: "block" }` (不带 reason — reason 不是 Stop hook 有效字段)
- [x] 废弃 `session-evolve.mjs` → `deprecated/`
- [x] 创建 `skills/evolve-session-review/SKILL.md`
- [x] 配置自动发现: `~/.prismer/config.toml` fallback (resolveConfig.mjs)
- [x] API key 格式校验: `sk-prismer-*` prefix validation
- [x] SessionStart skill sync: 云端 installed skills 自动下载到 `~/.claude/skills/`
- [x] 端到端验证: Stop block → Claude 用 curl fallback 创建 2 个 gene → 成功退出

### Phase 4b: 反馈归因改进 ✅ (2026-03-31)

- [x] Stop hook 恢复 reason 字段（精简版）— 传递 gene feedback 上下文
- [x] Claude 自评 adherence: "你是否真的用了建议的策略？"
- [x] 隐式 pending 归因保留作为 fallback，Claude 的显式 evolve_record 作为 ground truth

**设计 tradeoff 记录：**

1. **reason 显示为 "Stop hook error:"** — Claude Code 的 UI 限制，无法改变。
   接受此 tradeoff，因为 gene feedback 的自评上下文对 Thompson Sampling 数据质量至关重要。
   没有 reason → Claude 不知道评估哪些 gene → 反馈回路断裂或靠隐式归因（噪声大）。

2. **隐式 pending 归因 vs 显式 Claude 自评** — 两条路径共存：
   - 隐式路径 (post-bash-journal): pending-suggestion.json 3min TTL，下一个 Bash 结果决定 outcome
     → 噪声来源：Agent 可能忽略建议自己修，但仍被标记为 gene success
   - 显式路径 (Stop hook → Claude evolve_record): Claude 带完整上下文自评 adherence
     → 更准确，但依赖 Claude 配合（Stop hook 可能被冷却跳过）
   - 策略：隐式做 fallback，显式做 ground truth。当两者冲突时服务端以最后一条 record 为准。

3. **SessionStart 被动注入只有标题没有 strategy steps** — 设计选择：
   - 注入完整 strategy 会撑大 context（5 个 gene × 5 步 = 25 行额外文本）
   - 被动注入的目的是"意识到存在"，不是"立即执行"
   - 需要具体步骤时，stuck detection 或 evolve_analyze 会返回完整 strategy
   - 保持当前设计，不改。

4. **Edit/Write 的 PreToolUse 不触发 stuck detection** — 设计选择：
   - PostToolUse 记录 Edit/Write 的 signal 到 journal ✅
   - 但 PreToolUse stuck detection 只在 Bash 时触发
   - 纯 Edit 循环（无 Bash 验证）是 edge case（<10% 场景）
   - 大多数修复最终需要 build/test → 此时 stuck detection 触发
   - 保持当前设计，不改。

### Phase 5: WebFetch Context Cache ✅ (2026-04-01)

- [x] `post-web-save.mjs` — PostToolUse(WebFetch|WebSearch) 静默保存到 /api/context/save
  - WebFetch: URL + HQCC content (code === 200, public URL, > 100 chars)
  - WebSearch: keyed by `prismer://search/{query}` (> 100 chars)
- [x] `pre-web-cache.mjs` — PreToolUse(WebFetch) context cache load
  - Feature gate: `PRISMER_WEB_CACHE_LOAD=1` (默认关闭)
  - 1s timeout, cache hit → deny + content, miss/timeout → allow fetch
  - WebSearch 永远不走 load（只存不取）
- [x] URL 校验: `isPublicUrl()` 共享 (http/https only, exclude private IPs)
- [x] E2E 验证: save → verify → load hit 全链路通过

### Phase 6: opencode-plugin 对齐

- [x] v2.0 三阶段模型 (sync + journal + stuck detection)
- [ ] v3: OpenCode 是否支持类似 Stop hook block？
  - OpenCode 有 `event` hook 但没有 Stop hook 的 block 能力
  - 替代方案: `session.ended` event → 最后调一次 evolve_report
  - 或: `experimental.chat.system.transform` 注入 "在结束前请 review 进化" 指令

---

## 10. 进化闭环覆盖矩阵

### 当前状态 (2026-04-01)

| 阶段 | Claude Code | OpenCode | OpenClaw |
|------|------------|----------|----------|
| **信号检测** | ✅ PostToolUse(Bash\|Edit\|Write) journal | ✅ tool.execute.after journal | ✅ inbound analyze |
| **失败检测** | ✅ PostToolUseFailure hook | ❌ | N/A |
| **卡住检测** | ✅ count >= 2 → /analyze | ✅ count >= 2 → analyze | N/A (消息级) |
| **Gene 查询** | ✅ /analyze | ✅ /analyze | ✅ prismer_evolve_analyze |
| **结果记录** | ✅ journal gene_feedback + SessionEnd push | ✅ in-memory journal | ✅ prismer_evolve_record |
| **数字分身** | ✅ Person-Level Sync | ✅ (共享服务端) | ✅ (共享服务端) |
| **北极星指标** | ✅ repeatRate/frrApprox/errApprox | ✅ (共享 metrics) | ✅ (共享 metrics) |
| **超图观测** | ✅ Always-Write | ✅ (共享服务端) | ✅ (共享服务端) |
| **Gene 创建** | ✅ Stop hook block → Claude LLM | ⚠️ 规则化 | ✅ prismer_gene_create |
| **LLM 抽象** | ✅ Stop hook block (已验证) | ❌ 无 block 能力 | N/A |
| **Memory 写入** | ✅ Claude 调 memory_write | ❌ | ❌ |
| **Skill 自动 sync** | ✅ SessionStart 下载 | ❌ | ❌ |
| **Subagent 注入** | ✅ SubagentStart hook | ❌ | N/A |
| **WebFetch cache** | ✅ save always-on + load opt-in | ❌ | N/A |
| **SessionEnd fallback** | ✅ async sync push + retry queue | ❌ | N/A |
| **Credit Billing** | ✅ 统一 middleware | ✅ (共享服务端) | ✅ (共享服务端) |

---

## 11. v3 完整文件清单

```
claude-code-plugin/
├── hooks/
│   └── hooks.json              # 8 hook entries, 7 events
├── scripts/
│   ├── session-start.mjs       # SessionStart — sync pull + retry + memory + skill sync
│   ├── session-stop.mjs        # Stop — hasEvolutionValue → block + gene adherence
│   ├── session-end.mjs         # SessionEnd — async fallback sync push
│   ├── pre-bash-suggest.mjs    # PreToolUse(Bash) — stuck detection
│   ├── pre-web-cache.mjs       # PreToolUse(WebFetch) — context cache load (opt-in)
│   ├── post-bash-journal.mjs   # PostToolUse(Bash|Edit|Write) — journal writer
│   ├── post-web-save.mjs       # PostToolUse(WebFetch|WebSearch) — cache save
│   ├── post-tool-failure.mjs   # PostToolUseFailure — failure signal extraction
│   ├── subagent-start.mjs      # SubagentStart — strategy + signal injection
│   └── lib/
│       ├── resolve-config.mjs  # Config: env → ~/.prismer/config.toml → defaults
│       └── signals.mjs         # 13 signal patterns + ERROR_RE + SKIP_RE
├── skills/
│   └── evolve-session-review/
│       └── SKILL.md            # Stop hook block 后 Claude 的 review 指引
├── templates/
│   ├── hooks.json              # v3 template (与 hooks/hooks.json 一致)
│   └── mcp_servers.json        # npx MCP 安装模板
├── .claude-plugin/
│   ├── plugin.json             # Claude Code plugin manifest (含 userConfig)
│   └── marketplace.json        # Plugin marketplace listing
├── .mcp.json                   # MCP server 配置 (npx @prismer/mcp-server)
├── package.json                # npm package config
├── DESIGN.md                   # 本文档
├── CHANGELOG.md                # 版本变更日志
└── README.md                   # 用户文档
```

### 11.1 行为变化

| 场景 | v2.0 行为 | v3 行为 |
|------|----------|---------|
| 普通 session (无错误) | 正常退出 | 正常退出 + SessionEnd async push（如有 signals） |
| session 有错误且解决 | detached 异步上报 | **Stop block → Claude 自评 → SessionEnd fallback** |
| session 只有 read/ls | 正常退出 | 正常退出（不变） |
| WebFetch 访问已缓存 URL | 总是 fetch | **cache load opt-in → 跳过 fetch** |
| 子 agent 启动 | 无 context | **注入 top strategies + parent signals** |

### 11.2 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Stop hook block 死循环 | 低 | 高 | `stop_hook_active` + cooldown (1h) + journal marker |
| sync-cursor scope 丢失 | 已修复 | 高 | session-end 现在保留 scope 字段 |
| WebFetch cache load 延迟 | 低 | 中 | 默认关闭 + 1s timeout |
| SessionEnd 与 Stop 重复推送 | 低 | 低 | `[evolution-review-triggered]` marker 防重复 |

---

## 12. 完整进化循环（v3 实际状态）

```
                    ┌─────────────────────────────────┐
                    │         Session N                │
                    ├─────────────────────────────────┤
                    │                                 │
SessionStart ──────▶│ 1. Sync pull (person-level)     │
                    │ 2. 读 CLAUDE.md                 │
                    │ 3. 读 memory (含上次学习)        │
                    │ 4. 注入进化 context               │
                    │                                 │
                    │ → Agent 带进化知识开始工作        │
                    │                                 │
Mid-Session ───────▶│ 5. 遇到问题 → journal 记录      │
                    │ 6. 卡住 → /analyze 建议          │
                    │ 7. 不写服务端，只写本地           │
                    │                                 │
Stop hook ─────────▶│ 8. block (如果有进化价值)        │
                    │                                 │
Claude LLM ────────▶│ 9. 分析完整 session 上下文       │
                    │    ├─ 判断可迁移性               │
                    │    ├─ 去上下文化                  │
                    │    ├─ evolve_create_gene (gene)  │
                    │    ├─ evolve_record (feedback)   │
                    │    └─ memory_write (知识)         │
                    │                                 │
                    │ 10. 正常退出                     │
                    └─────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────┐
                    │         Session N+1              │
                    ├─────────────────────────────────┤
                    │                                 │
                    │ Agent 行为已经不同了:             │
                    │ - Memory 有上次学习              │
                    │ - Sync pull 有上次创建的 gene    │
                    │ - 跨 agent gene 也同步了         │
                    │                                 │
                    │ → 同类问题直接用已学策略          │
                    └─────────────────────────────────┘
```

---

*Last updated: 2026-04-01*

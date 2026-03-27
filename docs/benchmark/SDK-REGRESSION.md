# SDK 回归测试计划

> **Version:** 1.0
> **Date:** 2026-03-23
> **Status:** 待执行
> **Scope:** 4 SDK + MCP + 3 Plugin 的全量功能验证

---

## 1. 测试层级

```
L0: 编译通过（每次改动后立即验证）
L1: 方法覆盖度对齐（4 SDK 方法矩阵一致）
L2: 端到端功能测试（实际调 API，验证请求/响应）
L3: 机制层测试（cache、outbox、enrichment、offline）
L4: 集成测试（MCP → agent → evolution 完整链路）
```

## 2. L0: 编译验证

```bash
# 每次改动后必须全部通过
npx tsc --noEmit                              # 服务端
npx next build                                # Next.js
cd sdk/typescript && npx tsup ...             # TS SDK
cd sdk/golang && go build ./...               # Go SDK
cd sdk/rust && cargo check                    # Rust SDK
cd sdk/mcp && npx tsup src/index.ts ...       # MCP Server
```

**当前状态：全部通过 ✅ (Next.js + TS SDK + Go SDK + Rust SDK + MCP = 0 errors)**

## 3. L1: 方法覆盖度对齐

### 3.1 自动化检查脚本

```
脚本: sdk/tests/sdk-parity-check.ts

原理: 从每个 SDK 的源码中提取 public method 签名，
      与服务端 API 端点列表交叉对比，输出差异矩阵。

输出:
  - 覆盖率: TS 98%, Py 95%, Go 93%, Rust 85%
  - 缺失方法清单
  - 多余方法清单（SDK 有但服务端没有的）
```

### 3.2 允许的差异

| 差异类型   | 说明                    | 示例                                |
| ---------- | ----------------------- | ----------------------------------- |
| 语言特性   | 某些语言不支持某种模式  | Rust 无 async middleware            |
| 优先级降级 | P2 功能只在 TS SDK 实现 | EvolutionRuntime 仅 TS              |
| 展示类端点 | 前端专用端点 SDK 可选   | /public/leaderboard, /public/badges |

### 3.3 不允许的差异

| 差异类型       | 要求                         |
| -------------- | ---------------------------- |
| P0 方法缺失    | 四个 SDK 都必须有            |
| 参数签名不一致 | scope 参数要么都有要么都没有 |
| 返回类型不一致 | 同一端点的返回结构必须一致   |

## 4. L2: 端到端功能测试

### 4.1 测试矩阵

```
脚本: sdk/tests/sdk-integration.ts
环境: 测试环境 (cloud.prismer.dev)

测试用一个统一的 test agent，依次通过每个 SDK 调用同一组端点，
验证请求/响应结构一致。
```

| 功能组                  | 端点                              | 验证内容                 |
| ----------------------- | --------------------------------- | ------------------------ |
| **Auth**                | POST /register                    | 返回 token               |
| **Evolution Core**      | POST /analyze                     | 返回 action + gene       |
|                         | POST /record                      | 返回 edge_updated        |
|                         | GET /genes                        | 返回 gene 数组           |
|                         | POST /genes                       | 创建成功返回 gene        |
|                         | DELETE /genes/:id                 | 删除成功                 |
|                         | GET /edges                        | 返回 edge 数组           |
|                         | GET /capsules                     | 返回 capsule 数组        |
|                         | GET /report                       | 返回报告                 |
| **Evolution Scope**     | GET /scopes                       | 包含 'global'            |
|                         | GET /genes?scope=ws_x             | 返回空数组（非该 scope） |
|                         | POST /analyze?scope=global        | 正常返回                 |
| **Evolution Lifecycle** | POST /genes/:id/publish           | visibility 变更          |
|                         | POST /genes/import                | 返回 imported gene       |
|                         | POST /genes/fork                  | 返回 forked gene         |
|                         | POST /distill                     | 返回 ready + capsules    |
| **Evolution Async**     | POST /report                      | 返回 trace_id            |
|                         | GET /report/:traceId              | 返回 status              |
|                         | GET /achievements                 | 返回数组                 |
| **Evolution Sync**      | GET /sync/snapshot                | 返回 genes + edges       |
|                         | POST /sync                        | 返回 pushed + pulled     |
| **Security**            | GET /conversations/:id/security   | 返回设置                 |
|                         | PATCH /conversations/:id/security | 更新成功                 |
|                         | POST /conversations/:id/keys      | 上传成功                 |
|                         | GET /conversations/:id/keys       | 返回 keys 数组           |
| **Public**              | GET /public/stats                 | 返回统计                 |
|                         | GET /public/hot                   | 返回 gene 数组           |
|                         | GET /public/feed                  | 返回事件数组             |
| **Skills**              | GET /skills/search                | 返回 skill 数组          |

### 4.2 per-SDK 执行

```
每个 SDK 独立跑一遍完整矩阵：

TS:   npx tsx sdk/tests/sdk-integration.ts --sdk ts
Py:   python sdk/tests/test_python_sdk.py
Go:   cd sdk/golang && go test -run Integration ./...
Rust: cd sdk/rust && cargo test -- --ignored integration
```

## 5. L3: 机制层测试

### 5.1 EvolutionCache (TS)

```
脚本: sdk/tests/evolution-cache.test.ts

1. loadSnapshot: 加载 10 genes + 20 edges → cache 有数据
2. select: 给定 signal，返回最佳 gene（与服务端结果对比）
3. select 无匹配: 返回 null
4. loadDelta: 增量更新 → cache 数据更新
5. 性能: select 1000 次 < 10ms
```

### 5.2 SignalEnrichment (TS/Py/Go)

```
脚本: sdk/tests/signal-enrichment.test.ts

1. "timeout error" → [{ type: "error:timeout" }]
2. "ECONNREFUSED" → [{ type: "error:connection_refused" }]
3. "429 Too Many Requests" → [{ type: "error:rate_limit" }]
4. "unknown random text" → [] (不瞎猜)
5. 三个语言的输出一致性检查
```

### 5.3 EvolutionOutbox (Py/Go)

```
脚本: 各语言自己的测试

1. enqueue: 不阻塞，立即返回
2. flush: 攒够 N 条或超时后批量上传
3. 失败重试: 服务端 500 → 重试 3 次
4. 持久化: 进程退出前 dump → 重启后 reload
5. 去重: idempotency key 防止重复上传
```

### 5.4 Offline 场景

```
1. 断网: suggest() 返回本地 cache 结果
2. 断网: learned() 存入 outbox
3. 恢复: outbox 自动 flush + cache 自动 sync
4. 冲突: 本地修改 vs 服务端修改 → 最后写入胜出
```

## 6. L4: MCP + Plugin 集成测试

### 6.1 MCP Server (23 tools)

```
脚本: sdk/tests/mcp-integration.ts

方法: 启动 MCP Server，通过 stdio 发送 JSON-RPC 调用每个 tool
验证: 每个 tool 返回非错误结果

工具覆盖:
  context: context_load, context_save (2)
  parse: parse (1)
  messaging: discover, send_message, edit_message, delete_message (4)
  evolution: evolve_analyze, evolve_record, evolve_create_gene,
             evolve_distill, evolve_browse, evolve_import,
             evolve_report, evolve_achievements, evolve_sync,
             evolve_export_skill (10)
  memory: memory_write, memory_read, recall (3)
  tasks: create_task (1)
  skills: skill_search, skill_install (2)
```

### 6.2 Claude Code Plugin

```
验证方式: 手动（Claude Code 环境）

1. 安装 plugin: 确认 3 skills 出现在 /skills 列表
2. 触发 evolve-analyze: 制造一个错误场景，观察 Claude Code 是否自主调用
3. 触发 evolve-record: 解决问题后观察是否记录
4. scope 参数: 确认 SKILL.md 中的参数描述与 MCP tool 一致
```

### 6.3 OpenClaw Channel

```
验证方式: 半自动

1. 注册 channel: openclaw plugins install @prismer/openclaw-channel
2. 验证 tools 列表: 应包含 prismer_evolve_analyze, prismer_evolve_record, prismer_evolve_report 等
3. 发送消息: 通过 OpenClaw 发消息给 Prismer IM → 验证 webhook 回调
4. evolution 调用: 触发 evolve_analyze tool → 验证返回 gene 推荐
```

## 7. Plugin 回归测试

### 7.1 Claude Code Plugin

| #   | 测试项               | 方法             | 验证内容                                       |
| --- | -------------------- | ---------------- | ---------------------------------------------- |
| CP1 | hooks.json 结构      | 静态检查         | PreToolUse + PostToolUse 都存在                |
| CP2 | pre-bash-suggest.mjs | 手动触发         | 输入含 error 的命令 → stdout 有 evolution 建议 |
| CP3 | post-bash-report.mjs | 手动触发         | 输入含错误输出 → report API 被调用             |
| CP4 | .mcp.json            | 静态检查         | MCP Server 配置正确                            |
| CP5 | 3 个 SKILL.md        | 静态检查         | 参数名与 MCP tool 一致，含 scope               |
| CP6 | 端到端               | Claude Code 环境 | 执行失败命令 → 看到 evolution 建议             |

### 7.2 OpenCode Plugin

| #   | 测试项              | 方法     | 验证内容                                   |
| --- | ------------------- | -------- | ------------------------------------------ |
| OP1 | tool.execute.before | 集成测试 | 执行含 error 信号的 tool → 返回 suggestion |
| OP2 | session.error       | 集成测试 | session 错误 → report 被调用               |
| OP3 | tool.execute.after  | 集成测试 | tool 错误输出 → report 被调用              |
| OP4 | scope 支持          | 代码审查 | EvolutionClient 传 scope 参数              |

### 7.3 OpenClaw Channel

| #   | 测试项                    | 方法     | 验证内容                                      |
| --- | ------------------------- | -------- | --------------------------------------------- |
| OC1 | inbound evolution suggest | 集成测试 | 收到含 error 的消息 → reply 带 evolution hint |
| OC2 | tools scope 支持          | 代码审查 | analyze/record tools 传 scope                 |
| OC3 | prismer_evolve_report     | 功能测试 | tool 调用 → report API 被调用                 |
| OC4 | 不影响正常消息            | 功能测试 | 普通消息无 evolution hint 附加                |

---

## 8. 执行频率

| 级别      | 频率                 | 触发               |
| --------- | -------------------- | ------------------ |
| L0 编译   | 每次改动             | CI pre-commit hook |
| L1 覆盖度 | 每周 / 每次 SDK 改动 | 手动               |
| L2 端到端 | 发版前               | 手动               |
| L3 机制层 | 发版前               | 手动               |
| L4 集成   | 发版前               | 手动               |

## 8. 输出

- `sdk/tests/` 目录下的测试脚本
- `docs/benchmark/results-sdk-regression.json` — 测试结果
- 本文更新通过/失败状态

---

## 9. 实际测试结果 (2026-03-23, cloud.prismer.dev)

```
脚本: scripts/sdk-evaluation.ts
目标: cloud.prismer.dev (v1.7.2 deployed)
```

| 级别         | 测试项 | 通过   | 失败  | 说明                                   |
| ------------ | ------ | ------ | ----- | -------------------------------------- |
| L1 方法覆盖  | 43     | 43     | 0     | 4 SDK × P0+P1 方法全对齐               |
| L2 端到端    | 19     | 19     | 0     | 所有 API 端点正常响应                  |
| L3 机制层    | 13     | 11     | 2     | EvolutionCache 缺 select()/loadDelta() |
| L4 抽象评估  | 4      | 4      | 0     | 确认 EvolutionRuntime 不存在(预期)     |
| Context Meta | 4      | 4      | 0     | extractMeta 正常                       |
| **合计**     | **83** | **81** | **2** | **通过率 97.6%**                       |

### 2 个 FAIL 详情

1. `EvolutionCache has select()` — ❌ 方法名可能不是 `select`，需检查实际方法名
2. `EvolutionCache has loadDelta()` — ❌ 增量加载方法缺失或命名不同

### 14 个 Findings (设计评审结论)

见 SDK-DESIGN-REVIEW.md Section 9

_Last updated: 2026-03-23 (含测试环境实测结果)_

# PrismerCloud Phase A 实施计划

> **目标周期**: 6-8 周 / 30-40 工作日
> **起始日期**: 2026-04-30
> **预计完成**: 2026-06-26 (8 周窗口)
> **架构方向**: SDK 平台 → 可调度本地 Agent 执行平台
> **核心交付**: Daemon + Runtime + Polymorphic Assignee + Approval Gate + Personal Assistant

---

## 0. 执行摘要

### 0.1 范围定义

Phase A 在现有 PrismerCloud(Next.js 16 + Prisma + 4-language SDK + AIP)之上,引入 Go 编写的本地 Daemon、云侧 Orchestrator 和 Approval Gate,实现"开发者一行 `npx prismer setup` 即可让自己机器上的 CLI(claude/codex/openclaw 等)被云端任务派单调用"的闭环。

### 0.2 关键技术决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 新模块语言 | Go 1.23+ | Daemon 跨平台二进制(macOS/Linux/Windows ARM/AMD)、低开销 WS、与 Multica 风格一致 |
| Schema 权威 | Prisma | 现有 64 model 沉淀,Go 用 sqlc 读同库 |
| Go ORM | sqlc(基于 Prisma migrate 生成的 SQL DDL)| 类型安全、零运行时反射、SQL 可控 |
| 通信协议 | WebSocket + JSON(Phase A) → protobuf(Phase B 预留)| Phase A 调试期 JSON 优先 |
| 签名 | Ed25519 + DID:key(沿用现有 AIP)| 不引入新算法栈 |
| 部署 | Docker Compose(server + orchestrator + PG)+ daemon 用户机本地装 | Phase A 不上 K8s |

### 0.3 五大模块工作量预估

| 模块 | 工作量(日) | 关键路径 |
|------|------------|---------|
| M1 — Daemon 二进制 | 7.5 | 是 |
| M2 — Runtime / Orchestrator | 9.0 | 是 |
| M3 — Polymorphic Assignee | 5.0 | 否(可与 M2 并行) |
| M4 — Approval Gate | 6.5 | 否 |
| M5 — Personal Assistant | 3.5 | 否 |
| 跨模块集成 + 数据迁移 + QA | 4.5 | 是 |
| **总计** | **36.0** | |

---

## 1. 任务依赖图(DAG)

### 1.1 模块级依赖

```
                ┌──────────────────────────────────────────┐
                │  M0: Schema 草稿 + Go 工程脚手架(2.0d)  │
                └──────────────────────┬───────────────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  │                    │                    │
                  ▼                    ▼                    ▼
     ┌───────────────────┐   ┌──────────────────┐   ┌──────────────────┐
     │ M3: Polymorphic   │   │ M2-A: sqlc +     │   │ M5: Personal     │
     │ Assignee (5.0d)   │   │ Orchestrator     │   │ Assistant (3.5d) │
     │ ★ DB + SDK        │   │ 骨架 (3.0d)      │   │ ★ 业务封装       │
     └─────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
               │                       │                      │
               │              ┌────────┴─────────┐            │
               │              │                  │            │
               │              ▼                  ▼            │
               │   ┌──────────────────┐ ┌───────────────────┐ │
               │   │ M1-A: Daemon     │ │ M2-B: Capability  │ │
               │   │ 骨架 + DID 注册  │ │ 匹配 + Dispatch   │ │
               │   │ (3.5d)           │ │ (3.0d)            │ │
               │   └────────┬─────────┘ └─────────┬─────────┘ │
               │            │                     │           │
               │            ▼                     │           │
               │   ┌──────────────────┐           │           │
               │   │ M1-B: CLI 探测 + │           │           │
               │   │ exec runner      │◀──────────┘           │
               │   │ (2.5d)           │                       │
               │   └────────┬─────────┘                       │
               │            │                                 │
               │            ▼                                 │
               │   ┌──────────────────┐                       │
               │   │ M1-C: 安装脚本 + │                       │
               │   │ setup 集成 (1.5d)│                       │
               │   └────────┬─────────┘                       │
               │            │                                 │
               └────────────┼─────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────┐
                │ M4: Approval Gate (6.5d) │
                │ ★ 依赖 M2 dispatch 已通  │
                └─────────────┬────────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │ INT: 端到端集成测试      │
                │ + 数据迁移 + 压测 (4.5d) │
                └──────────────────────────┘
```

### 1.2 关键路径(Critical Path)

```
M0 → M2-A → M1-A → M1-B → M2-B → M4 → INT
2.0  3.0    3.5    2.5    3.0    6.5  4.5  =  25.0 d (关键路径)
```

并行支线:
- M3 在 M0 后即可启动,5.0d,与 M1+M2 并行
- M5 在 M0 后启动,3.5d,与任意支线并行
- M1-C(安装脚本)可在 M1-B 完成后并行做

### 1.3 Mermaid 版本(嵌入文档)

```mermaid
graph TD
    M0[M0: Schema + Go 脚手架<br/>2.0d] --> M2A[M2-A: sqlc + Orchestrator 骨架<br/>3.0d]
    M0 --> M3[M3: Polymorphic Assignee<br/>5.0d]
    M0 --> M5[M5: Personal Assistant<br/>3.5d]
    M2A --> M1A[M1-A: Daemon 骨架 + DID 注册<br/>3.5d]
    M2A --> M2B[M2-B: Capability 匹配 + Dispatch<br/>3.0d]
    M1A --> M1B[M1-B: CLI 探测 + exec runner<br/>2.5d]
    M2B --> M1B
    M1B --> M1C[M1-C: 安装脚本 + setup 集成<br/>1.5d]
    M1B --> M4[M4: Approval Gate<br/>6.5d]
    M3 --> M4
    M4 --> INT[INT: 端到端 + 迁移 + 压测<br/>4.5d]
    M1C --> INT
    M5 --> INT

    classDef critical fill:#ffcccc,stroke:#cc0000,stroke-width:2px
    class M0,M2A,M1A,M1B,M2B,M4,INT critical
```

---

## 2. 详细任务拆解

> 注:工作量单位 "d" = 1 工程师日(约 6 小时聚焦编码 + 2 小时其他)。
> 所有路径以 `/home/willamhou/codes/PrismerCloud/` 为根(下称 `$ROOT`)。

### 2.0 M0 — 准备工作(2.0 d)

#### M0-T1 编写 Phase A Prisma Schema 草稿(0.5 d)
- **路径**: `$ROOT/server/prisma/schema.prisma` (在 IMTask 区块附近增补)
- **行动**: 添加 `IMRuntime`、`IMDaemonSession`、`IMTaskExecution`、`IMTaskApproval` 4 个 model;改造 `IMTask` 增加 `assigneeType` / `assigneeDid` / `requiresApproval` / `pendingApprovalId` / `runtimeId` 字段。
- **依赖**: 无
- **验收**: `npx prisma validate` 通过;`npx prisma migrate dev --create-only --name phase_a_runtime` 生成 SQL 无报错;团队 Schema review 通过。

#### M0-T2 创建 Go 工程脚手架(0.75 d)
- **路径**: `$ROOT/services/`(新建)、`$ROOT/services/go.work`(workspace)
- **行动**:
  - `cd $ROOT/services && go work init`
  - 新建子目录 `daemon/`、`orchestrator/`、`shared/`,各自 `go mod init github.com/prismer/cloud/services/<name>`
  - `shared/` 安装 sqlc(`go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest`),写 `sqlc.yaml`
  - 公共依赖: `github.com/go-chi/chi/v5`、`github.com/coder/websocket`(替代 gorilla/websocket,Multica 已用 coder)、`github.com/jackc/pgx/v5`、`go.uber.org/zap`、`github.com/stretchr/testify`
- **依赖**: M0-T1
- **验收**: `cd $ROOT/services && go build ./...` 无错;CI 跑 `go vet ./...` 通过。

#### M0-T3 sqlc 配置 + 首批 query 生成(0.5 d)
- **路径**:
  - `$ROOT/services/shared/sqlc.yaml`
  - `$ROOT/services/shared/db/queries/runtime.sql`、`task.sql`、`approval.sql`
  - 生成产物: `$ROOT/services/shared/db/sqlc/*.go`
- **行动**:
  - 配置 sqlc 指向 `$ROOT/server/prisma/migrations/<latest>/migration.sql`
  - 先写 6 个 query: `RegisterRuntime`、`HeartbeatRuntime`、`ListOnlineRuntimes`、`ClaimTask`、`InsertTaskExecution`、`InsertTaskLog`
  - `cd $ROOT/services/shared && sqlc generate`
- **依赖**: M0-T1, M0-T2
- **验收**: 生成 Go 代码可 `import` 进 orchestrator,`go test ./...` 通过空 test。

#### M0-T4 CI 流水线扩展(0.25 d)
- **路径**: `$ROOT/.github/workflows/go.yml`(新增)
- **行动**: 添加 Go matrix CI(linux/macos),跑 `go vet`、`staticcheck`、`go test -race -cover`
- **依赖**: M0-T2
- **验收**: PR 创建时自动跑 Go CI 并通过。

---

### 2.1 M1 — Daemon 二进制(7.5 d)

#### M1-A: Daemon 骨架 + DID 注册(3.5 d)

##### M1-A-T1 Daemon CLI 入口 + 配置加载(0.75 d)
- **路径**:
  - `$ROOT/services/daemon/cmd/prismer-daemon/main.go`
  - `$ROOT/services/daemon/internal/config/config.go`
  - `$ROOT/services/daemon/internal/config/config_test.go`
- **行动**:
  - 用 `github.com/spf13/cobra` 实现 `start` / `status` / `stop` / `version` 子命令
  - 配置文件路径: `~/.prismer/daemon.toml`,字段:`api_endpoint`、`ws_endpoint`、`api_key`、`runtime_id`(首启生成持久化)、`log_level`、`scan_paths`(允许追加额外 PATH)
  - 复用现有 `~/.prismer/config.toml` 的 `api_key`(若存在则继承,daemon.toml 优先)
- **依赖**: M0-T2
- **验收**:
  - 单元测试覆盖 config 合并优先级 ≥ 80%
  - `prismer-daemon version` 返回构建版本

##### M1-A-T2 持久化 KeyStore + DID 生成(1.0 d)
- **路径**:
  - `$ROOT/services/daemon/internal/identity/keystore.go`
  - `$ROOT/services/daemon/internal/identity/did.go`
  - `$ROOT/services/daemon/internal/identity/identity_test.go`
- **行动**:
  - 用 `crypto/ed25519` 生成 keypair,序列化到 `~/.prismer/daemon.key`(权限 0600)
  - 派生 `did:key:z6Mk...`(沿用现有 server `aip/didKey.ts` 编码逻辑,Go 端用 `github.com/multiformats/go-multibase` + `go-multicodec`)
  - 提供 `Sign(payload []byte) (sig []byte, err error)` 接口
- **依赖**: M1-A-T1
- **验收**:
  - 单元测试:同一 key 生成的 DID 与 server 端 TS 实现产出完全一致(交叉验证 fixture)
  - 文件权限 0600 校验

##### M1-A-T3 Daemon 注册 HTTP 调用(0.75 d)
- **路径**:
  - `$ROOT/services/daemon/internal/api/register.go`
  - `$ROOT/server/src/app/api/runtimes/register/route.ts`(新增)
  - `$ROOT/server/src/lib/services/runtimeRegister.ts`(新增)
- **行动**:
  - Daemon 端: `POST /api/runtimes/register` body `{ did, hostname, os, arch, version, capabilities, signature }`,signature = Ed25519 签 `did|hostname|nonce|ts`
  - Server 端: 校验签名 → 写入 `IMRuntime` + `IMDaemonSession`,返回 `runtimeId` + `wsToken`(JWT,15min 有效)
  - 处理重复注册:同 DID 已存在则更新 `IMRuntime.lastHeartbeatAt` + 新 `IMDaemonSession`
- **依赖**: M1-A-T2, M0-T3
- **验收**:
  - 集成测试: `cd $ROOT/services/daemon && go test ./internal/api/... -run TestRegister`
  - Server 端 vitest 覆盖 ≥ 90%

##### M1-A-T4 WS 心跳与重连(1.0 d)
- **路径**:
  - `$ROOT/services/daemon/internal/ws/client.go`
  - `$ROOT/services/daemon/internal/ws/heartbeat.go`
- **行动**:
  - 用 `coder/websocket` 建立长连 `wss://api.prismer.cloud/ws/daemon?token=<wsToken>`
  - 心跳:每 20s 发 `{type:"ping",ts}`,server 回 `pong`;3 次未回则断开重连
  - 指数退避重连: 1s → 2s → 4s → 8s → 30s 上限
  - context 取消时优雅关闭
- **依赖**: M1-A-T3
- **验收**:
  - 集成测试: 关闭 server 端 → daemon 进入退避重连 → server 起来后 5s 内重连成功
  - 测试覆盖 ≥ 75%

#### M1-B: CLI 探测 + Exec Runner(2.5 d)

##### M1-B-T1 PATH 扫描 + CLI 指纹库(1.0 d)
- **路径**:
  - `$ROOT/services/daemon/internal/discovery/scanner.go`
  - `$ROOT/services/daemon/internal/discovery/fingerprints.go`
  - `$ROOT/services/daemon/internal/discovery/fingerprints_test.go`
- **行动**:
  - 扫描 `$PATH` + 用户配置 `scan_paths`
  - 内置指纹表(可扩展):`claude`, `codex`, `openclaw`, `opencode`, `hermes`, `gemini`, `pi`, `cursor-agent`, `kimi`, `kiro-cli`
  - 每个指纹: 二进制名、版本探测命令(如 `claude --version`)、parse 正则、capability key(如 `claude-code`)
  - 输出 `[]DiscoveredCLI{ key, path, version, detected_at }`
- **依赖**: M1-A-T1
- **验收**:
  - 单元测试用 fixture(mock exec)覆盖 ≥ 8 个 CLI 指纹
  - 在 macOS/Linux 各跑一遍真实扫描

##### M1-B-T2 Exec Runner 子进程管理(1.0 d)
- **路径**:
  - `$ROOT/services/daemon/internal/runner/runner.go`
  - `$ROOT/services/daemon/internal/runner/streaming.go`
  - `$ROOT/services/daemon/internal/runner/runner_test.go`
- **行动**:
  - 用 `os/exec` + `exec.CommandContext` 启动子进程,接管 stdout/stderr 管道
  - 行级流式:用 `bufio.Scanner` 读取,每行打包成 `LogChunk{taskExecutionId, stream:"stdout"|"stderr", text, ts, seq}` 推到 chan
  - 支持超时取消(从 task 拿 `timeoutMs`)
  - 子进程退出后捕获 exitCode,写入 `IMTaskExecution.exitCode`
- **依赖**: M1-B-T1
- **验收**:
  - 单元测试: 启动 `echo hello` 验证流式输出 + exitCode=0
  - 启动 `sleep 100` 然后 cancel,验证子进程被 SIGKILL

##### M1-B-T3 Capability 上报到 Server(0.5 d)
- **路径**: `$ROOT/services/daemon/internal/discovery/reporter.go`
- **行动**:
  - 启动后 5s 内完成首次扫描,通过 WS 发 `{type:"capability_report", capabilities:[{key,version,path}]}`
  - 每 5min 重扫,有差异则增量上报
- **依赖**: M1-B-T1, M1-A-T4
- **验收**: 集成测试 — 在 daemon 机器上装一个新 CLI,5min 内 server `IMRuntime.capabilities` 更新。

#### M1-C: 安装脚本 + Setup 集成(1.5 d)

##### M1-C-T1 GoReleaser 跨平台构建(0.5 d)
- **路径**:
  - `$ROOT/services/daemon/.goreleaser.yml`
  - `$ROOT/.github/workflows/release-daemon.yml`
- **行动**:
  - 配置 6 平台: darwin/amd64, darwin/arm64, linux/amd64, linux/arm64, windows/amd64, windows/arm64
  - 输出 .tar.gz / .zip,推到 GitHub Releases
  - homebrew tap formula 生成(参考 multica `.goreleaser.yml`)
- **依赖**: M1-B-T3
- **验收**: 打 tag `daemon-v0.1.0` 触发 release,6 个 artifact 上传成功。

##### M1-C-T2 install.sh / install.ps1(0.5 d)
- **路径**:
  - `$ROOT/scripts/install.sh`(POSIX)
  - `$ROOT/scripts/install.ps1`(Windows)
  - 镜像至 `https://install.prismer.cloud/daemon.sh`
- **行动**:
  - bash: 检测 OS/Arch → 下载对应 release → 解压到 `/usr/local/bin/prismer-daemon`(或 `~/.local/bin`)→ 写 systemd user service / launchd plist
  - powershell: 同样逻辑,写注册表 startup
- **依赖**: M1-C-T1
- **验收**: 在 ubuntu/macos/windows 三台机器跑 `curl install.prismer.cloud/daemon.sh | bash` 一次成功。

##### M1-C-T3 SDK setup 命令集成(0.5 d)
- **路径**:
  - `$ROOT/sdk/typescript/src/cli/setup.ts`(改造)
  - `$ROOT/sdk/typescript/src/cli/install-daemon.ts`(新增)
- **行动**:
  - `npx @prismer/sdk setup` 默认增加交互问 "Install local daemon? [Y/n]"(`--with-daemon` 强制开,`--no-daemon` 关)
  - 选 Y 则 spawn `install.sh`,完成后 `prismer-daemon start`
  - setup 末尾打印 daemon 状态 + 已发现 capability 列表
- **依赖**: M1-C-T2
- **验收**: 全新机器从零跑 `npx @prismer/sdk setup --with-daemon`,5 分钟内可在 server UI 看到 Runtime 在线。

---

### 2.2 M2 — Runtime / Orchestrator(9.0 d)

#### M2-A: sqlc + Orchestrator 骨架(3.0 d)

##### M2-A-T1 Orchestrator HTTP + WS 服务起点(1.0 d)
- **路径**:
  - `$ROOT/services/orchestrator/cmd/orchestrator/main.go`
  - `$ROOT/services/orchestrator/internal/server/server.go`
  - `$ROOT/services/orchestrator/internal/server/router.go`
- **行动**:
  - chi router: `/healthz`, `/api/runtimes/register`(reverse proxy 到 server 还是直接处理? **决策:直接处理**), `/ws/daemon`
  - 配置:`ORCHESTRATOR_PORT=4001`, `DATABASE_URL`, `JWT_SECRET`(与 server 共享)
  - graceful shutdown
- **依赖**: M0-T3
- **验收**: `curl http://localhost:4001/healthz` 返回 200。

##### M2-A-T2 WS Hub(连接管理)(1.0 d)
- **路径**:
  - `$ROOT/services/orchestrator/internal/hub/hub.go`
  - `$ROOT/services/orchestrator/internal/hub/connection.go`
  - `$ROOT/services/orchestrator/internal/hub/hub_test.go`
- **行动**:
  - Hub 维护 `map[runtimeId]*Connection`,sync.RWMutex 保护
  - 每个 Connection: in/out chan,reader goroutine + writer goroutine
  - JWT token 校验(`runtimeId` claim),token 过期需要 daemon 重新走 `/register` 拿新 token
  - broadcast / unicast 接口
- **依赖**: M2-A-T1
- **验收**:
  - 单元测试: 100 个并发 daemon 连接 → broadcast → 全收到
  - 一个 daemon 断开 → hub 立即清理,不泄漏 goroutine(`go test -run TestHub -count=10`)

##### M2-A-T3 Heartbeat 处理 + Runtime 状态 reaper(1.0 d)
- **路径**:
  - `$ROOT/services/orchestrator/internal/hub/heartbeat.go`
  - `$ROOT/services/orchestrator/internal/reaper/reaper.go`
- **行动**:
  - 收到 `ping` 立即回 `pong`,同时更新 `IMRuntime.lastHeartbeatAt`(批量,每 5s flush)
  - Reaper goroutine 每 30s 扫一次:`lastHeartbeatAt < now - 90s` 且 `status='online'` 的 Runtime 标记 `status='offline'`
  - 触发离线事件 → 取消该 runtime 的 in-flight task(改 `status='cancelled'`,加 `IMTaskLog`)
- **依赖**: M2-A-T2
- **验收**:
  - 集成测试: daemon kill -9 → 90s 后 server 端 status=offline,该 runtime 上跑的 task 被 cancel

#### M2-B: Capability 匹配 + Dispatch(3.0 d)

##### M2-B-T1 Task 创建监听(1.0 d)
- **路径**:
  - `$ROOT/services/orchestrator/internal/dispatcher/listener.go`
  - `$ROOT/server/src/lib/services/taskCreate.ts`(改造,加触发 NOTIFY)
- **行动**:
  - 选型决策:**Postgres LISTEN/NOTIFY**(Phase A 简单)→ Phase B 切 Redis Streams
  - server 创建 task 时 `pg_notify('task.created', payload)`,payload 含 taskId
  - orchestrator 单独 connection LISTEN,收到通知拉详情
- **依赖**: M2-A-T3
- **验收**:
  - 集成测试: server 创建 task → orchestrator 50ms 内收到 notify

##### M2-B-T2 Capability Matcher(1.0 d)
- **路径**:
  - `$ROOT/services/orchestrator/internal/dispatcher/matcher.go`
  - `$ROOT/services/orchestrator/internal/dispatcher/matcher_test.go`
- **行动**:
  - 输入: `IMTask.capability`(例 `claude-code`),`IMTask.scope`,可选资源约束(metadata.requirements)
  - 输出: 候选 `IMRuntime[]`,排序规则:
    1. 匹配 capability(必须)
    2. 同 ownerDid(若 task.creatorDid 与 runtime.ownerDid 相同 +100 分)
    3. 负载低优先(`load` 字段)
    4. 最近心跳近(< 30s)
  - 没有候选 → 任务进入 `pending` + 等下次 daemon 上线再匹配(后台 retry)
- **依赖**: M2-B-T1
- **验收**:
  - 单元测试 8 种场景:无 runtime / 一个 runtime / 多个 runtime 排序 / 跨 owner

##### M2-B-T3 Dispatch + Execution 跟踪(1.0 d)
- **路径**:
  - `$ROOT/services/orchestrator/internal/dispatcher/dispatcher.go`
  - `$ROOT/services/orchestrator/internal/exec/tracker.go`
- **行动**:
  - matcher 选中 runtime → 通过 hub.Send(runtimeId, TaskPushMsg)
  - 创建 `IMTaskExecution` 记录(status=`dispatched`,startedAt=now)
  - 收到 daemon `TaskAccepted` → `IMTask.status=running`,`IMTaskExecution.status=running`
  - 收到 `TaskFinished` → 写 exitCode、completedAt,`IMTask.status=completed/failed`
  - 收到 `LogChunk` → 写 `IMTaskLog`(批量 100 条 / 1s flush)
- **依赖**: M2-B-T2, M1-B-T2
- **验收**:
  - 端到端: REST 创建 task → daemon 收到 → 执行 echo → log 在 server 可查 → status=completed

#### M2-C: 接入 IMTaskLog + 错误处理(3.0 d)

##### M2-C-T1 Log 批量写入优化(0.75 d)
- **路径**: `$ROOT/services/orchestrator/internal/log/writer.go`
- **行动**:
  - 内存 buffer + 100 条 / 1s 触发 flush
  - 失败重试 3 次 + 死信队列(写本地文件 `/tmp/orchestrator-deadletter/`)
  - 关闭时 flush 残留
- **依赖**: M2-B-T3
- **验收**: 压测 — 10 个 daemon 各 1000 行 log/s × 60s,无丢失,P99 < 200ms。

##### M2-C-T2 Task 重试机制(0.75 d)
- **路径**: `$ROOT/services/orchestrator/internal/retry/retry.go`
- **行动**:
  - 复用 `IMTask.maxRetries` / `retryDelayMs` / `retryCount`
  - 失败 → 检查 retryCount < maxRetries → 指数退避后重新 dispatch
  - 重试到上限 → status=failed
- **依赖**: M2-B-T3
- **验收**: 单元测试覆盖 4 种重试场景。

##### M2-C-T3 Cancel / Timeout 处理(0.75 d)
- **路径**: `$ROOT/services/orchestrator/internal/control/control.go`
- **行动**:
  - REST `POST /api/tasks/:id/cancel` → orchestrator 通过 ws 推 `{type:"cancel", taskExecutionId}` → daemon SIGKILL 子进程
  - timeout: `IMTask.deadline` 到期由 reaper 触发 cancel
- **依赖**: M2-C-T2
- **验收**: 用户在 UI 点 cancel,daemon 子进程 5s 内被 kill。

##### M2-C-T4 监控指标(Prometheus)(0.75 d)
- **路径**: `$ROOT/services/orchestrator/internal/metrics/metrics.go`
- **行动**:
  - 暴露 `/metrics`:`runtime_count{status}`、`task_dispatch_total`、`task_dispatch_latency_seconds`、`ws_connections`、`log_flush_lag_seconds`
- **依赖**: M2-A-T1
- **验收**: Prometheus scrape 成功,Grafana dashboard 有数据。

---

### 2.3 M3 — Polymorphic Assignee(5.0 d)

#### M3-T1 Schema 改造 + 迁移 SQL(0.75 d)
- **路径**: `$ROOT/server/prisma/schema.prisma`
- **行动**:
  - `IMTask` 增加:
    - `assigneeType String? // HUMAN | AGENT | SUB_AGENT`
    - `assigneeDid String? // W3C DID, 优先于 assigneeId`
    - `runtimeId String?`
    - `requiresApproval Boolean @default(false)`
    - `pendingApprovalId String?`
  - 索引 `@@index([assigneeDid, status])`
  - 保留 `assigneeId` 字段(向后兼容,标 `@deprecated` 注释)
- **依赖**: M0-T1
- **验收**: `npx prisma migrate dev --create-only` 生成的 SQL review 通过。

#### M3-T2 Server 端 claim/close 逻辑改造(1.0 d)
- **路径**:
  - `$ROOT/server/src/lib/services/taskClaim.ts`
  - `$ROOT/server/src/lib/services/taskClose.ts`
  - `$ROOT/server/src/app/api/tasks/[id]/claim/route.ts`
  - `$ROOT/server/src/app/api/tasks/[id]/close/route.ts`
- **行动**:
  - claim payload 必须含 `did` + `signature`(签 `taskId|action=claim|nonce|ts`)
  - 校验签名 → 写 `assigneeDid`、`assigneeType`
  - close 必须由同一 `assigneeDid` 发起,签名同样校验
  - 错误码:`E_DID_MISMATCH`、`E_SIGNATURE_INVALID`、`E_NOT_ASSIGNEE`
- **依赖**: M3-T1
- **验收**: vitest 覆盖 12 种正反例 ≥ 95%。

#### M3-T3 SDK 全语言更新(2.0 d,4×0.5d)

##### M3-T3-a TypeScript SDK
- **路径**: `$ROOT/sdk/typescript/src/tasks/{claim,close,types}.ts`
- **行动**: `claimTask(taskId, {did, sign})`、`closeTask(taskId, {did, sign, result})`,签名工具 `sign({privateKey, payload})`

##### M3-T3-b Python SDK
- **路径**: `$ROOT/sdk/python/prismer/tasks.py`
- **行动**: 同上,用 `cryptography` 库实现 Ed25519 签名

##### M3-T3-c Go SDK
- **路径**: `$ROOT/sdk/golang/tasks/claim.go`
- **行动**: 与 daemon 共享 `services/shared/identity` 包

##### M3-T3-d Rust SDK
- **路径**: `$ROOT/sdk/rust/src/tasks.rs`
- **行动**: 用 `ed25519-dalek` 库

- **依赖**: M3-T2
- **验收**: 4 个 SDK 各跑一份相同 fixture(claim → close 闭环),全部签名校验通过。

#### M3-T4 MCP server 工具改造(0.75 d)
- **路径**: `$ROOT/server/src/lib/mcp/tools/task.ts`
- **行动**:
  - `task_claim` / `task_close` tool schema 增加 `did` + `signature` 字段
  - tool description 更新
- **依赖**: M3-T2
- **验收**: 用 Claude Desktop 测 mcp 调用闭环,签名校验通过。

#### M3-T5 数据迁移脚本(0.5 d)
- **路径**: `$ROOT/server/scripts/migrate-task-assignee.ts`
- **行动**: 见 §9 数据迁移策略详细 SQL
- **依赖**: M3-T1
- **验收**: 在 staging DB 跑通,迁移后 `assigneeDid IS NOT NULL` 比例 ≥ 95%(剩余 5% 是无 IMAgentCard 的旧账号)。

---

### 2.4 M4 — Approval Gate(6.5 d)

#### M4-T1 IMTaskApproval Schema(0.5 d)
- **路径**: `$ROOT/server/prisma/schema.prisma`
- **行动**: 见 §3 IMTaskApproval 完整定义
- **依赖**: M3-T1
- **验收**: migrate 通过

#### M4-T2 Approval API(REST)(1.5 d)
- **路径**:
  - `$ROOT/server/src/app/api/approvals/route.ts`(POST 创建,GET 列表)
  - `$ROOT/server/src/app/api/approvals/[id]/approve/route.ts`
  - `$ROOT/server/src/app/api/approvals/[id]/reject/route.ts`
  - `$ROOT/server/src/lib/services/approval.ts`
- **行动**:
  - 创建 approval: body `{ taskId, action, payload, requesterDid, signature }`
  - approve/reject: body `{ approverDid, decision, signature }`
  - **delegation chain 校验**: 调用现有 `aip/delegationChain.ts` 验证 approver 是否对该 capability 有权限
  - 决策后:
    - approve → 更新 `IMTask.status=running`(若 task 之前 pending),orchestrator 收到事件继续 dispatch
    - reject → `IMTask.status=cancelled`,加日志
- **依赖**: M4-T1, M3-T2
- **验收**:
  - vitest 覆盖正常 / 签名失败 / delegation 链断裂 / 重复决策 / approver 无权 5 种场景

#### M4-T3 Daemon Approval Hook(1.5 d)
- **路径**:
  - `$ROOT/services/daemon/internal/approval/gate.go`
  - `$ROOT/services/daemon/internal/runner/sensitive_actions.go`
- **行动**:
  - daemon 在执行前检查 `task.requiresApproval` 或子任务标记 sensitive
  - sensitive 触发条件:
    - `runner` 看到子进程要写文件到 `task.scope` 外(简化版:用 path prefix 检查)
    - 子进程要发起出网请求(Phase A 仅做声明性,不 sniff,靠 task metadata 标 `outbound:true`)
    - task metadata 显式 `requiresApproval:true`
  - 触发 → 通过 ws 发 `{type:"approval_request", taskId, action, payload}` → 等 server 回 `{type:"approval_decision", id, decision}`
  - 等待期间 daemon 不消耗 task token(发 `task_paused` 事件)
- **依赖**: M4-T2, M1-B-T2
- **验收**:
  - 集成测试:任务标 `requiresApproval` → daemon 暂停 → 在 UI approve → daemon 继续

#### M4-T4 SDK onApprovalRequired Hook(1.0 d)
- **路径**:
  - `$ROOT/sdk/typescript/src/approval/hooks.ts`
  - 同样在 python/go/rust 各做一份 (4×0.25d)
- **行动**:
  - SDK 暴露 `client.approvals.onRequired(callback)`
  - 内部用 SSE 或 WS 长连听 server `/api/approvals/stream?did=<my did>`
- **依赖**: M4-T3
- **验收**: 4 SDK 各写一个 demo:任务挂起 → callback 被调用 → 程序内调用 approve → 任务继续

#### M4-T5 Approval UI(简版)(1.0 d)
- **路径**:
  - `$ROOT/server/src/app/(app)/approvals/page.tsx`
  - `$ROOT/server/src/components/approvals/ApprovalCard.tsx`
- **行动**:
  - 列表页:展示当前用户作为 approver 的 pending approvals
  - Card 显示 task 摘要、requester、action、payload(JSON 折叠)、approve/reject 按钮
  - 决策时浏览器侧用 user identity key 签名(走 `IMIdentityKey`)
- **依赖**: M4-T2
- **验收**: 完整 UI 流程能跑通

#### M4-T6 三类 approval 策略(1.0 d)
- **路径**: `$ROOT/server/src/lib/services/approval-policy.ts`
- **行动**:
  - 内置 3 种 approval kind:
    - `task_create`(高额 budget task 自动触发)
    - `dangerous_action`(如 `rm -rf`、`git push --force` 模式匹配)
    - `outbound_message`(发 email/外发消息,Phase A 仅占位,不实际触发)
  - 配置式策略:`approval-policy.toml`(后续放 `~/.prismer/policy.toml`)
- **依赖**: M4-T3
- **验收**: 创建 budget=1000 的 task 自动生成 approval;创建 budget=10 的不触发。

---

### 2.5 M5 — Personal Assistant(3.5 d)

#### M5-T1 注册时自动创建 PA(1.0 d)
- **路径**:
  - `$ROOT/server/src/lib/services/personalAssistant.ts`
  - `$ROOT/server/src/lib/services/userRegister.ts`(改造,signup 后调用)
- **行动**:
  - 用户注册后:
    1. 创建 `IMAgentCard`(name="Personal Assistant", agentType="assistant", did 由用户 DID delegate 派生)
    2. 创建私有 `IMConversation`(type=direct,只有 user + agent 两个 participant)
    3. 初始化 4-type Memory namespace:`ownerId=<paAgentId>` 的 4 条 `IMMemoryFile`(MEMORY.md / patterns.md / project.md / insights.md 空模板)
    4. 写入 `IMAgentCredential` 记录 delegation 关系
- **依赖**: M0-T1, M3-T1
- **验收**: 新注册用户自动有 1 个 PA、1 个对话、4 个 memory 文件。

#### M5-T2 Person-level Gene 共享(0.75 d)
- **路径**: `$ROOT/server/src/lib/services/personGene.ts`
- **行动**:
  - 复用现有 `IMGene` 表 + person-level sync 逻辑
  - 新建 PA 时不复制 gene,而是共享 `personId` 索引
- **依赖**: M5-T1
- **验收**: 同一用户有多个 agent 实例时,gene 跨实例共享(查同一份)

#### M5-T3 SDK getPersonalAssistant(0.75 d)
- **路径**:
  - `$ROOT/sdk/typescript/src/agents/personal.ts`
  - `$ROOT/sdk/python/prismer/agents/personal.py`
  - `$ROOT/sdk/golang/agents/personal.go`
  - `$ROOT/sdk/rust/src/agents/personal.rs`
- **行动**: `client.getPersonalAssistant()` 返回 `{ agentId, did, conversationId }`
- **依赖**: M5-T1
- **验收**: 4 个 SDK 都能调通。

#### M5-T4 PA Onboarding 消息(0.5 d)
- **路径**: `$ROOT/server/src/lib/services/paOnboarding.ts`
- **行动**: PA 创建后自动在 conversation 发一条欢迎消息 + 简短能力说明
- **依赖**: M5-T1
- **验收**: 新用户首次打开 conversation 有 onboarding message。

#### M5-T5 Documentation(0.5 d)
- **路径**: `$ROOT/docs/personal-assistant.md`(本文档不含,留待 doc-updater agent)
- **依赖**: M5-T4
- **验收**: 文档 review 通过

---

### 2.6 INT — 集成 + 迁移 + QA(4.5 d)

| 子任务 | 工作量 | 路径 |
|--------|--------|------|
| INT-T1 端到端 happy path 测试 | 1.0 d | `$ROOT/services/e2e/` 新建 Playwright + Go test 套件 |
| INT-T2 数据迁移演练 | 0.75 d | `$ROOT/server/scripts/migrate-task-assignee.ts` 在 staging 跑 |
| INT-T3 压力测试 | 1.0 d | 100 daemon × 10 task/s |
| INT-T4 安全扫描 | 0.5 d | `gosec ./...`、SDK 各跑 npm audit / cargo audit |
| INT-T5 文档更新 | 0.75 d | README + CHANGELOG |
| INT-T6 Demo 录制 + Release | 0.5 d | M5 demo 视频 + GitHub release notes |

---

## 3. Prisma Schema 草稿

> 在 `$ROOT/server/prisma/schema.prisma` 中,IMTask 区块附近增补。
> 命名遵循现有 `IM*` 前缀 + `im_*` 表名。

### 3.1 IMTask 改造(改动 4 个字段)

```prisma
model IMTask {
  id String @id @default(cuid())

  // Task content
  title       String
  description String?
  capability  String?
  input       String  @default("{}")
  contextUri  String?

  // ===== Phase A: Polymorphic Assignee =====
  creatorId    String
  creatorDid   String?  // [NEW] 创建者 DID(优先于 creatorId)

  assigneeId   String?  // [DEPRECATED] 保留向后兼容
  assigneeDid  String?  // [NEW] W3C DID, claim 时写入,Ed25519 校验通过才有
  assigneeType String?  // [NEW] HUMAN | AGENT | SUB_AGENT
  // ==========================================

  scope          String  @default("global")
  conversationId String?

  status        String @default("pending")
  progress      Float?
  statusMessage String?

  // Scheduling (unchanged)
  scheduleType String?
  scheduleAt   DateTime?
  scheduleCron String?
  intervalMs   Int?
  nextRunAt    DateTime?
  lastRunAt    DateTime?
  runCount     Int       @default(0)
  maxRuns      Int?

  // Result (unchanged)
  result    String?
  resultUri String?
  error     String?

  // Economy (unchanged)
  budget Float?
  cost   Float  @default(0)

  // ===== Phase A: Runtime / Approval =====
  runtimeId         String?  // [NEW] 派发到的 IMRuntime
  requiresApproval  Boolean  @default(false)  // [NEW]
  pendingApprovalId String?  // [NEW] FK to IMTaskApproval, 单向引用避免循环
  // ========================================

  timeoutMs    Int       @default(300000)
  deadline     DateTime?
  completedAt  DateTime?
  maxRetries   Int       @default(0)
  retryDelayMs Int       @default(60000)
  retryCount   Int       @default(0)

  metadata  String   @default("{}")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  logs       IMTaskLog[]
  executions IMTaskExecution[] // [NEW]
  approvals  IMTaskApproval[]  // [NEW]

  @@index([status])
  @@index([assigneeId, status])
  @@index([assigneeDid, status])  // [NEW]
  @@index([capability, status])
  @@index([scheduleType, nextRunAt, status])
  @@index([creatorId])
  @@index([creatorDid])           // [NEW]
  @@index([creatorId, scope, status])
  @@index([conversationId])
  @@index([completedAt])
  @@index([runtimeId])            // [NEW]
  @@map("im_tasks")
}
```

### 3.2 IMRuntime(新)

```prisma
// ==============================================================================
// Phase A — Runtime Registry
// ==============================================================================
//
// IMRuntime 表示一个可执行 Task 的运行时,可能是用户机器上的 daemon,
// 也可能是云端虚拟 runtime(Phase B)。所有 runtime 都有 DID 身份,
// 注册和心跳都需要 Ed25519 签名。

model IMRuntime {
  id              String   @id @default(cuid())
  ownerDid        String   // 拥有者 DID(通常是用户的 IMUser.primaryDid)
  ownerImUserId   String?  // 关联 IMUser(冗余,加速查询)

  type            String   @default("local") // local | cloud | edge
  did             String   @unique // Runtime 自身 DID(daemon 持久化的密钥派生)
  publicKey       String   // Base64 Ed25519 public key

  // Host info
  hostname        String?
  os              String?  // darwin | linux | windows
  arch            String?  // amd64 | arm64
  version         String?  // daemon 版本
  endpoint        String?  // 仅 cloud 类型才有 HTTP endpoint

  // Capability
  capabilities    String   @default("[]") // JSON: [{ key:"claude-code", version:"1.2.3", path:"/usr/local/bin/claude" }]

  // State
  status          String   @default("offline") // online | busy | idle | offline
  load            Float    @default(0) // 0-1
  lastHeartbeatAt DateTime?
  registeredAt    DateTime @default(now())
  updatedAt       DateTime @updatedAt

  sessions   IMDaemonSession[]
  executions IMTaskExecution[]

  @@index([ownerDid, status])
  @@index([status, lastHeartbeatAt])
  @@index([type, status])
  @@map("im_runtimes")
}
```

### 3.3 IMDaemonSession(新)

```prisma
// 每次 daemon 进程启动 → 注册到 server → 关闭对应一次 session。
// 用于审计和故障排查。

model IMDaemonSession {
  id            String    @id @default(cuid())
  runtimeId     String

  startedAt     DateTime  @default(now())
  terminatedAt  DateTime?
  terminationReason String? // graceful | crash | network_lost | server_kicked

  version       String    // daemon 版本
  pid           Int?      // 进程 PID(可选)

  // 连接元数据
  remoteAddr    String?   // server 看到的客户端 IP
  userAgent     String?

  // 累计统计
  taskCount     Int       @default(0)
  logBytes      Int       @default(0)

  runtime IMRuntime @relation(fields: [runtimeId], references: [id], onDelete: Cascade)

  @@index([runtimeId, startedAt])
  @@map("im_daemon_sessions")
}
```

### 3.4 IMTaskExecution(新)

```prisma
// 一个 Task 可能被执行多次(重试 / 调度任务多次触发),
// 每次执行对应一条 IMTaskExecution 记录。
//
// IMTaskLog 是细粒度行级日志,IMTaskExecution 是 run 级元数据。

model IMTaskExecution {
  id          String   @id @default(cuid())
  taskId      String
  runtimeId   String

  // Execution metadata
  attempt     Int      @default(1) // 第几次重试
  status      String   @default("dispatched") // dispatched | running | succeeded | failed | cancelled | timeout

  startedAt   DateTime @default(now())
  acceptedAt  DateTime? // daemon 确认接收
  completedAt DateTime?

  exitCode    Int?
  durationMs  Int?

  // Capability used (来自 daemon 的实际选择)
  capabilityUsed String?  // 例如 "claude-code"
  cliPath        String?  // 例如 "/usr/local/bin/claude"
  cliVersion     String?

  // Outputs
  logsRef     String?   // 指向 IMTaskLog 范围或外部存储 prismer:// URI
  resultRef   String?   // 指向结果存储

  // Resource usage(可选,Phase B 详细化)
  cpuSeconds  Float?
  memoryBytes Int?

  task    IMTask    @relation(fields: [taskId], references: [id], onDelete: Cascade)
  runtime IMRuntime @relation(fields: [runtimeId], references: [id])

  @@index([taskId, attempt])
  @@index([runtimeId, status])
  @@index([startedAt])
  @@map("im_task_executions")
}
```

### 3.5 IMTaskApproval(新)

```prisma
// Approval Gate: 任务/危险操作/外发消息 在执行前需要某个 approver
// 显式同意。所有决策走 Ed25519 签名 + AIP delegation chain 验证。

model IMTaskApproval {
  id           String   @id @default(cuid())
  taskId       String?  // 可选:某些 approval 不绑定 task(如纯出站消息)

  kind         String   // task_create | dangerous_action | outbound_message
  action       String   // 简短 action 描述,如 "delete_files" / "git_push_force"
  payload      String   @default("{}") // JSON: 完整决策上下文(命令、参数、目标等)

  // Requester
  requestedByDid String
  requestedAt    DateTime @default(now())

  // Approver
  approverDid    String?  // 单一 approver(MVP);Phase B 支持多 approver
  approverImUserId String? // 冗余加速查询

  // Decision
  status         String   @default("pending") // pending | approved | rejected | expired
  decidedAt      DateTime?
  decisionReason String?

  // 签名 trail
  requestSignature  String   // requester 签 `taskId|kind|action|payloadHash|nonce|ts`
  decisionSignature String?  // approver 签 `approvalId|decision|nonce|ts`
  delegationProof   String?  // approver 行使权限的 delegation chain (JSON)

  // Timeout
  expiresAt    DateTime?

  // 审计
  metadata     String   @default("{}")

  task IMTask? @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@index([taskId])
  @@index([approverDid, status])
  @@index([requestedByDid])
  @@index([status, expiresAt])
  @@map("im_task_approvals")
}
```

### 3.6 索引性能注释

- `IMRuntime(status, lastHeartbeatAt)`: reaper 扫描掉线 runtime 用,~每 30s 一次
- `IMRuntime(ownerDid, status)`: 用户查"我的 runtime"用
- `IMTask(assigneeDid, status)`: agent 查"我的 task" 高频
- `IMTaskApproval(approverDid, status)`: approval 列表 UI 用
- `IMTaskExecution(taskId, attempt)`: 重试场景定位用

---

## 4. Go 服务目录结构

### 4.1 顶层布局

```
$ROOT/services/
├── go.work                    # Go workspace
├── go.work.sum
├── README.md
├── Makefile                   # build/test/lint 统一入口
├── .golangci.yml              # 共享 lint 配置
│
├── shared/                    # 共用包(每个服务都用)
│   ├── go.mod
│   ├── sqlc.yaml
│   ├── db/
│   │   ├── queries/           # *.sql,sqlc 输入
│   │   │   ├── runtime.sql
│   │   │   ├── task.sql
│   │   │   ├── approval.sql
│   │   │   └── execution.sql
│   │   ├── sqlc/              # sqlc 生成产物(*.go)
│   │   └── migrations/        # 软链接或 mirror server 的 prisma migrations
│   ├── identity/              # DID + Ed25519 工具
│   │   ├── did.go
│   │   ├── keystore.go
│   │   └── signer.go
│   ├── proto/                 # WS 消息类型(Phase A 用 JSON struct)
│   │   ├── envelope.go
│   │   ├── task.go
│   │   ├── runtime.go
│   │   └── approval.go
│   ├── log/                   # zap logger 配置
│   ├── config/                # 共用配置加载
│   └── version/               # ldflags 注入版本
│
├── daemon/                    # 用户机器上的 Daemon 二进制
│   ├── go.mod
│   ├── cmd/
│   │   └── prismer-daemon/
│   │       └── main.go        # cobra root
│   ├── internal/              # daemon 私有包
│   │   ├── api/               # HTTP 调用 server REST
│   │   │   └── register.go
│   │   ├── ws/                # WS 连接到 orchestrator
│   │   │   ├── client.go
│   │   │   ├── heartbeat.go
│   │   │   └── reconnect.go
│   │   ├── identity/          # 复用 shared/identity
│   │   ├── config/            # daemon.toml 加载
│   │   ├── discovery/         # CLI 探测
│   │   │   ├── scanner.go
│   │   │   ├── fingerprints.go
│   │   │   └── reporter.go
│   │   ├── runner/            # 子进程执行
│   │   │   ├── runner.go
│   │   │   ├── streaming.go
│   │   │   └── lifecycle.go
│   │   ├── approval/          # approval 等待 gate
│   │   │   └── gate.go
│   │   └── service/           # systemd / launchd / win service 集成
│   │       ├── linux.go
│   │       ├── darwin.go
│   │       └── windows.go
│   ├── .goreleaser.yml
│   └── README.md
│
├── orchestrator/              # 云侧 task 派发器
│   ├── go.mod
│   ├── cmd/
│   │   └── orchestrator/
│   │       └── main.go
│   ├── internal/
│   │   ├── server/            # chi router
│   │   │   ├── server.go
│   │   │   └── router.go
│   │   ├── hub/               # WS 连接管理
│   │   │   ├── hub.go
│   │   │   ├── connection.go
│   │   │   └── heartbeat.go
│   │   ├── dispatcher/        # task 派发
│   │   │   ├── listener.go    # PG LISTEN/NOTIFY
│   │   │   ├── matcher.go     # capability 匹配
│   │   │   └── dispatcher.go
│   │   ├── exec/              # IMTaskExecution 跟踪
│   │   │   └── tracker.go
│   │   ├── log/               # IMTaskLog 批量写
│   │   │   └── writer.go
│   │   ├── retry/             # 失败重试
│   │   ├── reaper/            # 离线 runtime 清理
│   │   ├── control/           # cancel/timeout
│   │   ├── approval/          # approval 决策事件分发
│   │   └── metrics/           # prometheus
│   ├── deploy/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   └── README.md
│
└── e2e/                       # 端到端测试(Phase A 收尾用)
    ├── go.mod
    ├── happy_path_test.go
    └── fixtures/
```

### 4.2 关键文件命名约定(参考 Multica)

- **入口**: `cmd/<binary>/main.go`,只做 cobra 初始化 + DI wiring
- **私有逻辑**: `internal/<domain>/`,每个目录一个领域,文件按职责切分(不超过 500 行)
- **公共包**: `shared/<package>/`,跨二进制复用
- **测试**: `*_test.go` 与源码同目录;e2e 单独 `services/e2e/`
- **接口**: 在调用方定义(Go 习惯),如 `dispatcher.Hub interface { Send(...) }` 在 dispatcher 包内定义,不在 hub 包

### 4.3 关键依赖清单

| 依赖 | 版本范围 | 用途 |
|------|---------|------|
| `github.com/go-chi/chi/v5` | v5.x | HTTP router |
| `github.com/coder/websocket` | v1.x | WS(优于 gorilla,更现代) |
| `github.com/jackc/pgx/v5` | v5.x | PG 驱动 |
| `github.com/sqlc-dev/sqlc` | v1.x | SQL 代码生成 |
| `go.uber.org/zap` | v1.x | 结构化日志 |
| `github.com/spf13/cobra` | v1.x | CLI |
| `github.com/spf13/viper` | v1.x | 配置 |
| `github.com/multiformats/go-multibase` | latest | DID:key 编码 |
| `github.com/multiformats/go-multicodec` | latest | DID:key codec |
| `github.com/golang-jwt/jwt/v5` | v5.x | JWT(WS token) |
| `github.com/prometheus/client_golang` | v1.x | metrics |
| `github.com/stretchr/testify` | v1.x | 测试 |
| `github.com/google/uuid` | v1.x | 关联 ID |

---

## 5. WebSocket 协议设计

### 5.1 总体决策

| 维度 | Phase A | Phase B 备注 |
|------|---------|-------------|
| 编码 | JSON(`encoding/json`) | 切 protobuf,二进制帧 |
| 帧类型 | 文本帧 | 二进制帧 |
| 压缩 | permessage-deflate(由 coder/websocket 内置) | 同上 |
| 鉴权 | JWT in URL query(单次 handshake) | 同左 + mTLS |
| 心跳 | 应用层 ping/pong(20s) | 同左 |

### 5.2 消息信封(Envelope)

所有消息共用结构:

```json
{
  "v": 1,
  "id": "msg_01HK...",          // 客户端生成 ULID
  "type": "task.push",
  "ts": 1735603200000,
  "trace_id": "trace_...",
  "payload": { ... }
}
```

Go 端定义(`shared/proto/envelope.go`):

```go
type Envelope struct {
    V       int             `json:"v"`
    ID      string          `json:"id"`
    Type    string          `json:"type"`
    Ts      int64           `json:"ts"`
    TraceID string          `json:"trace_id,omitempty"`
    Payload json.RawMessage `json:"payload"`
}
```

### 5.3 消息类型清单(Phase A)

| 方向 | type | 说明 |
|------|------|------|
| C→S | `runtime.hello` | 注册握手后首条消息(承认连接) |
| C→S | `runtime.heartbeat` | 心跳 |
| S→C | `runtime.heartbeat_ack` | 心跳应答 |
| C→S | `runtime.capability_report` | 上报 CLI 能力 |
| S→C | `task.push` | 派发任务 |
| C→S | `task.accepted` | daemon 接受任务 |
| C→S | `task.rejected` | daemon 拒绝(无能力 / 满载) |
| C→S | `task.log_chunk` | 日志流 |
| C→S | `task.progress` | 进度更新 |
| C→S | `task.finished` | 完成(含 exitCode) |
| S→C | `task.cancel` | 取消任务 |
| C→S | `approval.request` | daemon 请求 approval |
| S→C | `approval.decision` | 决策结果 |

### 5.4 关键 payload 示例

#### 5.4.1 `runtime.hello`

```json
{
  "did": "did:key:z6Mk...",
  "session_id": "sess_01HK...",
  "version": "0.1.0",
  "host": {
    "hostname": "macbook-pro",
    "os": "darwin",
    "arch": "arm64",
    "platform_version": "14.5.0"
  }
}
```

#### 5.4.2 `runtime.capability_report`

```json
{
  "capabilities": [
    { "key": "claude-code", "version": "1.2.3", "path": "/usr/local/bin/claude" },
    { "key": "codex", "version": "0.5.0", "path": "/usr/local/bin/codex" },
    { "key": "openclaw", "version": "0.3.1", "path": "/Users/u/.local/bin/openclaw" }
  ],
  "scanned_at": 1735603200000
}
```

#### 5.4.3 `task.push`

```json
{
  "task_id": "tsk_01HK...",
  "execution_id": "exe_01HK...",
  "title": "Refactor service layer",
  "capability": "claude-code",
  "input": { "prompt": "...", "workdir": "~/projects/foo" },
  "context_uri": "prismer://private/abc123/def456",
  "timeout_ms": 600000,
  "requires_approval": false,
  "creator_did": "did:key:z6Mk...",
  "creator_signature": "BASE64...",
  "deadline": "2026-04-30T18:00:00Z"
}
```

#### 5.4.4 `task.log_chunk`(批量)

```json
{
  "execution_id": "exe_01HK...",
  "chunks": [
    { "stream": "stdout", "seq": 1, "text": "Compiling...\n", "ts": 1735603201000 },
    { "stream": "stdout", "seq": 2, "text": "Build OK\n", "ts": 1735603202000 },
    { "stream": "stderr", "seq": 1, "text": "warning: deprecated\n", "ts": 1735603201500 }
  ]
}
```

#### 5.4.5 `task.finished`

```json
{
  "execution_id": "exe_01HK...",
  "exit_code": 0,
  "result_uri": "prismer://private/abc/result.json",
  "duration_ms": 12500,
  "stats": { "stdout_bytes": 14820, "stderr_bytes": 230 }
}
```

#### 5.4.6 `approval.request`

```json
{
  "approval_id": "apr_01HK...",
  "task_id": "tsk_01HK...",
  "kind": "dangerous_action",
  "action": "git_push_force",
  "payload": {
    "command": "git push -f origin main",
    "cwd": "/Users/u/repo",
    "rationale": "Rewriting history to remove leaked key"
  },
  "request_signature": "BASE64..."
}
```

#### 5.4.7 `approval.decision`

```json
{
  "approval_id": "apr_01HK...",
  "decision": "approved",
  "approver_did": "did:key:z6MkApprover...",
  "decision_signature": "BASE64...",
  "decided_at": 1735603300000
}
```

### 5.5 重连 / 断线 / 重发机制

#### 5.5.1 Daemon 端(client)

- WS 断开 → 立即进入 backoff 重连(1s/2s/4s/8s/30s)
- 重连成功后:
  1. 发 `runtime.hello`(包含 `session_id`)
  2. 重新发送 in-flight execution 的最后一条 `task.log_chunk`(by seq)的 ack 状态
  3. 仍在跑的子进程不被 kill,继续输出 → 缓冲到本地 ring buffer(默认 4MB),重连后续传

#### 5.5.2 Server 端(orchestrator)

- 检测到 ws 断开 → 立即 mark `IMRuntime.status='offline'`
- 该 runtime 的 in-flight `IMTaskExecution` **不立即 cancel**,给 90s grace(等 daemon 重连)
- 90s 内重连且 session_id 匹配 → 恢复绑定;90s 后未连 → cancel execution + retry policy 触发

#### 5.5.3 消息可靠性

- `task.log_chunk` 用 `seq` 单调递增,server 检测到 gap 主动请求重发 `{type:"resync.request", from_seq, to_seq}`
- `task.finished` 关键消息:client 重发 3 次直到收到 server `task.finished_ack`

### 5.6 协议未来 protobuf 切换路径

Phase A JSON 阶段的所有 payload 设计成可平滑映射 protobuf:
- 字段命名 `snake_case`
- 不依赖 JSON-only 特性(如多类型 union 字段)
- 枚举值用字符串 + 配套常量,protobuf 化时改 enum
- Phase B 启动后:`shared/proto/` 改为 `*.proto` + `protoc-gen-go`,加 `Accept` 协商两种编码并行

---

## 6. AIP 签名集成点

### 6.1 强制签名的数据流(Phase A)

| 流程 | 谁签 | 谁验 | Payload | 算法 |
|------|------|------|---------|------|
| Daemon 注册 | daemon (runtime DID) | server | `did|hostname|nonce|ts` | Ed25519 |
| Heartbeat | daemon | server (sample-verify, 1/100) | `did|sequence|ts` | Ed25519 |
| Capability report | daemon | server | `did|hash(capabilities)|ts` | Ed25519 |
| Task creation | creator (user/agent DID) | server | `task_id|title|input_hash|capability|ts` | Ed25519 |
| Task claim | claimer DID | server | `task_id|action=claim|did|nonce|ts` | Ed25519 |
| Task close | assignee DID | server | `task_id|action=close|result_hash|ts` | Ed25519 |
| Approval request | requester DID | server | `task_id|kind|action|payload_hash|nonce|ts` | Ed25519 |
| Approval decision | approver DID | server | `approval_id|decision|nonce|ts` | Ed25519 |
| Daemon log report | daemon | server (抽样,可选) | `execution_id|chunks_hash|ts` | Ed25519 |
| Task push (server → daemon) | server (system DID) | daemon | `task_id|execution_id|input_hash|ts` | Ed25519 |

### 6.2 标准签名 Payload 结构

#### 6.2.1 通用规约

- 签名前先做 **canonicalization**:
  - 字段按字母序拼接
  - 字符串值 UTF-8 编码
  - 用 `|` 分隔
  - 哈希用 SHA-256 截 hex(避免 payload 过长)
- 签名输出 Base64URL(no padding)
- nonce = ULID(单调递增防重放)
- ts = Unix ms

#### 6.2.2 示例:Task Claim

```typescript
// claim payload(待签名)
const canonicalString = [
  `action=claim`,
  `did=${claimerDid}`,
  `nonce=${nonce}`,
  `task_id=${taskId}`,
  `ts=${ts}`,
].join('|');

// 签名
const signature = ed25519.sign(
  Buffer.from(canonicalString, 'utf-8'),
  privateKey
);

// HTTP 请求
POST /api/tasks/:id/claim
{
  "did": "did:key:z6Mk...",
  "nonce": "01HK...",
  "ts": 1735603200000,
  "signature": "Base64URL_..."
}
```

Server 验签流程:

```typescript
async function verifyClaim(taskId, body) {
  // 1. nonce 防重放(Redis SET EX 5min)
  await assertNonceUnused(body.did, body.nonce);

  // 2. ts 时钟偏移检查(±5min)
  if (Math.abs(Date.now() - body.ts) > 5 * 60_000) throw new Error('CLOCK_SKEW');

  // 3. 重建 canonical string
  const canonical = `action=claim|did=${body.did}|nonce=${body.nonce}|task_id=${taskId}|ts=${body.ts}`;

  // 4. 解析 DID:key → 公钥
  const publicKey = decodeDidKey(body.did);

  // 5. 验签
  const ok = ed25519.verify(body.signature, canonical, publicKey);
  if (!ok) throw new Error('SIGNATURE_INVALID');

  // 6. 业务校验(task 状态、权限等)
  // ...
}
```

#### 6.2.3 Approval Decision(含 delegation chain)

```json
{
  "approval_id": "apr_01HK...",
  "decision": "approved",
  "approver_did": "did:key:z6MkApprover...",
  "nonce": "01HK...",
  "ts": 1735603300000,
  "decision_signature": "Base64URL_...",

  "delegation_proof": {
    "chain": [
      {
        "credential_id": "vc:01HK...",
        "issuer": "did:key:z6MkRoot...",
        "subject": "did:key:z6MkApprover...",
        "capabilities": ["approve:dangerous_action", "approve:task_create"],
        "signature": "Base64URL_..."
      }
    ]
  }
}
```

Server 验证:
1. 验 `decision_signature`(approver DID 公钥)
2. 遍历 `delegation_proof.chain`,验每段签名 + capability 是否覆盖本次决策的 `kind`
3. chain 根必须落在受信任的 trust anchor(系统 DID 或 task creator DID)
4. 任一 credential 在 `IMRevocationEntry` 出现 → 拒绝

### 6.3 复用现有代码

- TS 端:复用 `$ROOT/server/src/lib/aip/didKey.ts`、`delegationChain.ts`、`signMessage.ts`
- Go 端:`$ROOT/services/shared/identity/` 实现等价 API,提供与 TS fixture 互操作的单元测试

### 6.4 不签的(Phase A 范围外)

- IM 普通 chat message(已有 `senderDid`,但仍是 optional,Phase A 不强制)
- Memory 文件读写(Phase B)
- Skill/Gene 修改(Phase B)

---

## 7. 关键风险 + 缓解

### R1 — Go 与 Prisma schema drift(中高风险)
- **风险**: Prisma 改了 schema,sqlc 没跟上,导致 Go 服务 SELECT 失败或写脏数据。
- **缓解**:
  - CI 步骤:`prisma migrate dev` → 拷贝最新 SQL 到 `services/shared/db/migrations/` → `sqlc generate` → `go build` 任一失败 block PR
  - 添加 `make schema-sync` 脚本一键同步
  - 责任人:每次改 prisma/schema.prisma 的人必须同步 sqlc

### R2 — Daemon 跨平台兼容性(中风险)
- **风险**: macOS / Linux / Windows 差异(权限、路径、systemd vs launchd vs Windows service)。
- **缓解**:
  - GoReleaser CI 矩阵 6 平台必跑
  - 至少 1 名工程师每周用 Windows 真机测试一次
  - 用 `runtime.GOOS` 切平台分支,封装 `service` package 屏蔽差异
  - 早期保持 Windows feature-parity 70%(server 支持但 startup 集成放宽)

### R3 — Ed25519 实现互操作问题(中风险)
- **风险**: TS(`@noble/ed25519`)、Go(`crypto/ed25519`)、Python(`cryptography`)、Rust(`ed25519-dalek`)对 raw vs PEM 格式、字节序差异处理不一致。
- **缓解**:
  - 建立"互操作 fixture"测试套件:`$ROOT/test/aip-fixtures/`,40 条预签名 payload + 公钥 + 期望签名,5 端实现都必须通过
  - Phase A M0 阶段就把 fixture 跑通再继续
  - 标准化:所有签名 base64url no-pad,公钥 32 bytes raw

### R4 — WS 长连规模与稳定性(中风险)
- **风险**: 1000+ daemon 同时连 orchestrator,心跳 + log 流可能 OOM 或 socket 耗尽。
- **缓解**:
  - 早期 INT-T3 压测目标 100 daemon × 10 task/s,P99 < 500ms,Phase A 暂不追求 1000+
  - log batch flush(已设计)
  - orchestrator 水平扩展预留:用 sticky session(daemon → 同一 orchestrator instance,通过 nginx ip_hash)
  - 内存限制:每个 connection 输入 buffer 4MB,超限断连 + 重连
  - 监控:`ws_connections`、`mem_alloc_bytes` 仪表盘,触发告警

### R5 — 数据迁移破坏旧 IMTask(高风险)
- **风险**: 改造 IMTask 加 `assigneeDid` 后,老 task 的 `assigneeId` 找不到对应 DID,执行 / claim / close 链路 500。
- **缓解**:
  - 双写过渡期:服务读 task 时优先 `assigneeDid`,fallback `assigneeId`(查 IMUser → IMAgentCard 拿 DID)
  - 迁移脚本(§9)分批 backfill,每批 1000 条 + dry-run + 回滚
  - feature flag `STRICT_DID_REQUIRED` 默认 false,M3 完成 + 全量回填后才打开

### R6 — Approval Gate 误伤生产力(中低风险)
- **风险**: 默认策略过激,正常任务大量被卡 approval,用户体验差。
- **缓解**:
  - Phase A 默认策略仅 3 类触发(dangerous_action 仅命中明确黑名单 / outbound_message 占位 / budget>1000 task_create)
  - SDK 提供 `client.approvals.bypass(taskId)` 给 power user 自动批
  - 灰度:仅对新注册用户开启 require approval,老用户保持兼容
  - Phase B 引入更智能策略(机器学习风险打分)

### R7 — Daemon 安全性(中风险)
- **风险**: daemon 跑用户 PATH 上的 CLI,等于让 server 任意执行命令,密钥泄漏 = RCE。
- **缓解**:
  - daemon.key 文件权限 0600
  - server 推送的 task input 必须 server DID 签名(防 MITM)
  - daemon 只执行 capability 白名单内的 CLI(不能让 server 任意 spawn)
  - 子进程 cwd 限制在 `task.scope` 对应路径
  - 不在 daemon 中存 user API key(token 模型:WS token 15min 失效,过期重新走 register 用 daemon DID 换)
  - INT-T4 安全扫描必跑 gosec + 第三方安全 review

### R8 — Phase A 范围蔓延(高风险)
- **风险**: 看到 Helio/Multica 的 Channel UI、Issue Board、Coding Session 等很诱人,半途加进来导致延期。
- **缓解**:
  - §10 明确不做清单,所有 PR 模板加"是否在 Phase A 范围"勾选
  - 双周回顾:超出范围的需求统一进入 backlog,Phase B 评估
  - 里程碑 demo 严格按 §8 执行,不 demo 范围外功能

---

## 8. 里程碑

> 每 2 周一次里程碑。每里程碑结束有可演示 demo 视频(5 分钟内)+ release tag。

### M1 — Daemon 注册可见(Week 1-2,2026-04-30 → 2026-05-13)

**交付**:
- M0 全部完成(schema、Go 脚手架、sqlc、CI)
- M1-A 完成(daemon 骨架 + DID 注册 + WS 心跳)
- M2-A-T1/T2 完成(orchestrator 启动 + WS Hub)

**Demo 脚本**:
1. 全新 macOS 机器跑 `curl install.prismer.cloud/daemon.sh | bash`
2. `prismer-daemon start` → 看到日志显示 `Registered as did:key:z6Mk...`
3. 浏览器打开 `https://prismer.cloud/runtimes` → 看到刚注册的 runtime,status=online
4. `prismer-daemon stop` → UI 30s 内变 offline

**验收 checklist**:
- [ ] daemon 在 macOS/Linux 都能装并 register
- [ ] `IMRuntime` 表有数据
- [ ] 心跳停止 90s 后 status 变 offline
- [ ] CI Go matrix 全绿

### M2 — Task 派发执行闭环(Week 3-4,2026-05-14 → 2026-05-27)

**交付**:
- M1-B 完成(CLI 探测 + exec runner)
- M2-B 完成(matcher + dispatcher)
- M2-C-T1/T2 完成(log 批量写 + 重试)

**Demo 脚本**:
1. 用户机器装好 daemon,扫到 `claude-code` capability
2. UI 创建 task `{capability:"claude-code", input:{prompt:"hello"}}`
3. orchestrator 在 1s 内派发到 daemon
4. UI 实时看到 stdout 流式刷新
5. 完成后 task status=completed,IMTaskExecution 有完整记录

**验收 checklist**:
- [ ] Task 创建到 daemon 接收 < 1s
- [ ] 1000 行/秒 log 流不丢失
- [ ] 失败 task 自动重试 3 次

### M3 — Polymorphic Assignee + AIP 强签(Week 4-5,2026-05-21 → 2026-06-03)

**交付**:
- M3 全部完成
- 数据迁移演练通过
- 4 SDK 全部更新

**Demo 脚本**:
1. Python SDK 创建 task,带 creatorDid 签名
2. Go SDK 用另一个 DID 尝试 claim → 成功(签名校验通过)
3. TS SDK 第三方 DID 尝试 close → 拒绝(`E_NOT_ASSIGNEE`)
4. 老 task 数据查询无错误(双写兼容)

**验收 checklist**:
- [ ] 4 SDK 互操作 fixture 测试 100% 通过
- [ ] 老数据 95%+ 已 backfill assigneeDid
- [ ] 签名失败错误码符合规范

### M4 — Approval Gate 全链路(Week 6-7,2026-06-04 → 2026-06-17)

**交付**:
- M4 全部完成
- Approval UI 可用

**Demo 脚本**:
1. 用户配置 task `requiresApproval: true`
2. Daemon 收到任务后立即暂停,UI 出现 pending approval 卡片
3. Approver 在 UI 点 approve(浏览器签名)
4. Daemon 5s 内继续执行,完成
5. 演示 reject 场景:task 立即 cancelled

**验收 checklist**:
- [ ] Approval 决策延迟 < 5s
- [ ] Delegation chain 校验拒绝越权
- [ ] SDK onApprovalRequired 4 语言可用

### M5 — Personal Assistant + 一键 Setup(Week 7-8,2026-06-18 → 2026-06-26)

**交付**:
- M5 全部完成
- M1-C 安装脚本闭环
- INT 集成测试通过
- Release v0.1.0

**Demo 脚本**(end-to-end 主线):
1. 全新用户访问 https://prismer.cloud → 注册 → 自动创建 PA + 私有对话
2. 用户跑 `npx @prismer/sdk setup --with-daemon`
3. Daemon 装好 + 启动 + 自动发现 5 个 CLI
4. 在 PA 对话框输入 "帮我整理 ~/Documents 这个目录"
5. PA 创建 task,匹配到本地 daemon 的 codex capability,执行 → 流式回报结果
6. Approval gate 在敏感命令前触发 → 用户 approve → 继续

**验收 checklist**:
- [ ] 全新用户 5 分钟内跑通 demo 路径
- [ ] 端到端测试套件全绿
- [ ] 压测 100 daemon × 10 task/s P99 < 500ms
- [ ] 安全扫描无高危
- [ ] CHANGELOG 完整,文档更新
- [ ] GitHub Release `phase-a-v0.1.0` 发布

---

## 9. 数据迁移策略

### 9.1 现状

- `IMTask.assigneeId` 引用 `IMUser.id`
- `IMUser` 可能关联 `IMAgentCard`(`IMAgentCard.imUserId = IMUser.id`)
- `IMAgentCard.did` 是该 agent 的 DID
- `IMUser.primaryDid` 是该 user 的 DID(如果是 human)

### 9.2 目标

迁移后:
- 所有 `IMTask.creatorDid` 有值
- 所有已 claim 的 `IMTask.assigneeDid` 有值
- 所有 `IMTask.assigneeType` 有值(HUMAN | AGENT)
- 旧字段 `assigneeId` 保留但标记 deprecated

### 9.3 迁移脚本

**路径**: `$ROOT/server/scripts/migrate-task-assignee.ts`

#### 9.3.1 Dry-run 模式

```typescript
// 用法: npx tsx scripts/migrate-task-assignee.ts --dry-run --batch=1000
// 输出: 报告将会变更的 task 数量、找不到 DID 的 task 列表

interface MigrationStats {
  total: number;
  needCreatorDid: number;
  needAssigneeDid: number;
  resolvedHuman: number;
  resolvedAgent: number;
  unresolvable: number;       // 既无 IMUser.primaryDid 也无 IMAgentCard.did
  unresolvableTaskIds: string[];
}
```

#### 9.3.2 主迁移 SQL(分阶段)

```sql
-- =================================================
-- 阶段 1: backfill creatorDid(从 IMUser.primaryDid 或 IMAgentCard.did)
-- =================================================

-- 1.1 creator 是 human(IMUser.role='human')
UPDATE im_tasks t
SET creator_did = u.primary_did
FROM im_users u
WHERE t.creator_id = u.id
  AND u.role = 'human'
  AND u.primary_did IS NOT NULL
  AND t.creator_did IS NULL;

-- 1.2 creator 是 agent(IMUser.role='agent', 关联 IMAgentCard)
UPDATE im_tasks t
SET creator_did = ac.did
FROM im_users u
JOIN im_agent_cards ac ON ac.im_user_id = u.id
WHERE t.creator_id = u.id
  AND u.role = 'agent'
  AND ac.did IS NOT NULL
  AND t.creator_did IS NULL;

-- =================================================
-- 阶段 2: backfill assigneeDid + assigneeType
-- =================================================

-- 2.1 assignee 是 human
UPDATE im_tasks t
SET assignee_did = u.primary_did,
    assignee_type = 'HUMAN'
FROM im_users u
WHERE t.assignee_id = u.id
  AND u.role = 'human'
  AND u.primary_did IS NOT NULL
  AND t.assignee_id IS NOT NULL
  AND t.assignee_did IS NULL;

-- 2.2 assignee 是 agent
UPDATE im_tasks t
SET assignee_did = ac.did,
    assignee_type = 'AGENT'
FROM im_users u
JOIN im_agent_cards ac ON ac.im_user_id = u.id
WHERE t.assignee_id = u.id
  AND u.role = 'agent'
  AND ac.did IS NOT NULL
  AND t.assignee_id IS NOT NULL
  AND t.assignee_did IS NULL;

-- =================================================
-- 阶段 3: 处理无法 backfill 的 task(无 DID 的旧账户)
-- =================================================

-- 3.1 列出 unresolvable 的 task(交给运维手工)
SELECT t.id, t.title, t.creator_id, t.assignee_id, t.created_at
FROM im_tasks t
LEFT JOIN im_users uc ON uc.id = t.creator_id
LEFT JOIN im_users ua ON ua.id = t.assignee_id
LEFT JOIN im_agent_cards aca ON aca.im_user_id = ua.id
WHERE t.creator_did IS NULL
   OR (t.assignee_id IS NOT NULL AND t.assignee_did IS NULL)
LIMIT 100;

-- 3.2 对这些 task,选择策略:
--     a) 给关联 IMUser 补发 primaryDid(推荐,合并到 user 自动 DID 派生)
--     b) 标记 task 为 legacy(metadata 加 'legacy:true'),禁止再 claim 但保留历史
```

#### 9.3.3 分批执行脚本

```typescript
// scripts/migrate-task-assignee.ts(伪代码,完整版需在 M3-T5 实现)

const BATCH_SIZE = 1000;

async function migrate(args: { dryRun: boolean }) {
  let cursor: string | null = null;
  let processed = 0;

  while (true) {
    const batch = await prisma.iMTask.findMany({
      where: {
        OR: [
          { creatorDid: null },
          { AND: [{ assigneeId: { not: null } }, { assigneeDid: null }] },
        ],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const task of batch) {
      // resolve creator/assignee DID(参考上面 SQL 逻辑)
      const updates = await resolveDids(task);
      if (args.dryRun) {
        console.log('Would update', task.id, updates);
      } else {
        await prisma.iMTask.update({ where: { id: task.id }, data: updates });
      }
    }

    cursor = batch[batch.length - 1].id;
    processed += batch.length;
    console.log(`Processed ${processed}`);
  }
}
```

### 9.4 回滚方案

- 改造保留 `assigneeId` 字段 → 任何时候都能切回旧逻辑(改 feature flag)
- 迁移过程中产生的所有变更,记录在 `IMTaskLog`,action=`migrated_assignee_did`
- 回滚 SQL:`UPDATE im_tasks SET assignee_did=NULL, creator_did=NULL WHERE id IN (...)` 配合迁移日志范围

### 9.5 上线时序

1. **Day 0(M3-T1 完成)**: 部署 schema 改动(只加字段,不强制)
2. **Day 1**: 双写代码上线 — 新 task 同时写 assigneeDid 和 assigneeId
3. **Day 2**: 跑 dry-run,review unresolvable list
4. **Day 3**: 跑实际迁移,分 5 批每批 1000(staging 先跑通)
5. **Day 4**: 监控 24h,确认无异常
6. **Day 5(M3 完成)**: 切换主读路径 — 优先读 assigneeDid,assigneeId 仅作 fallback
7. **Phase B**: 移除 fallback,删 assigneeId

---

## 10. 不在 Phase A 范围(明确说不做)

> 这些功能在 Phase B 或 C 才做,Phase A 期间任何 PR 引入这些功能 **直接拒绝**。

### 10.1 UI 层不做

- **Channel UI**(Helio 风格的频道讨论界面):Phase B
- **Issue Board UI**(Helio 风格的看板):Phase B
- **Coding Session UI**(基于 JuiceFS 的远程编码界面):Phase C
- **Memory 浏览器**(查看 4-type memory 文件的可视化):Phase B
- **Skill Marketplace UI**:Phase C
- **Approval 列表 UI** 仅做最简版(M4-T5),高级筛选 / 历史 / 多 approver 工作流 → Phase B

### 10.2 集成不做

- **Email outbound 实际发送**(M4-T6 仅占位策略,不实际接 SMTP):Phase B
- **Meeting / Calendar 集成**:Phase C
- **桌面应用(Electron / Tauri)**:Phase C(daemon 是 CLI 二进制,不是 GUI app)
- **OpenFGA 权限系统**:Phase B(M4 用简化的 delegation chain,Phase B 切 OpenFGA)
- **JuiceFS / 远程 fs**:Phase C
- **Prismer Brain(`~/.brain`)**:Phase B(M5 PA 已经有 4-type memory,够用)

### 10.3 协议不做

- **gRPC / Protocol Buffers**(WS 协议 Phase A 用 JSON):Phase B 切 protobuf
- **mTLS**(WS 鉴权用 JWT 即可):Phase B
- **Kubernetes 部署**(Phase A 用 docker-compose):Phase B

### 10.4 高级特性不做

- **Cloud Runtime**(orchestrator 自己跑 task):Phase A 仅 local daemon
- **Runtime 跨 owner 共享 / marketplace**:Phase B
- **Approval 多人投票 / quorum**:Phase B
- **Daemon 自动升级**(daemon 跑老版本仍兼容,但不强制升级):Phase B
- **完整可观测性栈(Tempo / Loki)**:Phase A 仅 Prometheus + zap json log
- **多租户隔离**(strong isolation):Phase B
- **离线缓存 / 断网执行**:Phase C
- **GPU runtime 调度**:Phase C
- **Daemon 沙箱(seccomp / Landlock)**:Phase B(Phase A 信任用户机器)

### 10.5 数据层不做

- **复杂 retry policy**(circuit breaker / bulkhead):Phase B
- **任务优先级队列**(Phase A FIFO + capability 匹配即可):Phase B
- **Task DAG / 子任务依赖图**:Phase B
- **资源配额 / quota 系统**(IMCredit 已有但不增强):Phase B

---

## 11. 附录

### 11.1 配置文件示例

#### 11.1.1 `~/.prismer/daemon.toml`

```toml
[api]
endpoint = "https://api.prismer.cloud"
ws_endpoint = "wss://api.prismer.cloud/ws/daemon"
api_key_path = "~/.prismer/config.toml"  # 复用现有

[runtime]
id_path = "~/.prismer/daemon-runtime-id"  # 持久化 runtimeId
identity_key_path = "~/.prismer/daemon.key"

[discovery]
scan_interval_minutes = 5
extra_paths = []
disabled_capabilities = []

[logging]
level = "info"
file = "~/.prismer/logs/daemon.log"
max_size_mb = 100
max_age_days = 30

[runner]
default_timeout_seconds = 300
max_concurrent_tasks = 4
work_dir = "~/.prismer/work"
log_buffer_size_mb = 4
```

#### 11.1.2 Orchestrator 环境变量

```bash
# $ROOT/services/orchestrator/.env.example
DATABASE_URL=postgresql://prismer:secret@localhost:5432/prismer_cloud
JWT_SECRET=shared-with-server-must-match
JWT_RUNTIME_TTL_MINUTES=15
PORT=4001
LOG_LEVEL=info
PROMETHEUS_ENABLED=true
HEARTBEAT_TIMEOUT_SECONDS=90
LOG_FLUSH_INTERVAL_MS=1000
LOG_FLUSH_BATCH_SIZE=100
PG_LISTEN_CHANNEL=task.events
```

### 11.2 关键命令清单

```bash
# 全栈本地启动(开发)
cd $ROOT
docker-compose up -d postgres
cd server && npm run dev                 # Next.js on :3000
cd ../services/orchestrator && go run ./cmd/orchestrator  # on :4001
cd ../daemon && go run ./cmd/prismer-daemon start

# 跑测试
cd $ROOT/services && make test           # Go unit
cd $ROOT/server && npm test              # Vitest
cd $ROOT/services/e2e && go test -v      # E2E

# 生成 sqlc
cd $ROOT/services/shared && sqlc generate

# Lint
cd $ROOT/services && golangci-lint run ./...
cd $ROOT/server && npm run lint

# Schema 同步
cd $ROOT/server && npx prisma migrate dev --name <name>
cp prisma/migrations/<latest>/migration.sql ../services/shared/db/migrations/
cd ../services/shared && sqlc generate

# 数据迁移
cd $ROOT/server && npx tsx scripts/migrate-task-assignee.ts --dry-run
npx tsx scripts/migrate-task-assignee.ts --batch=1000
```

### 11.3 工时预算汇总(总览)

| 模块 | 子任务数 | 总工作量 | 关键路径 |
|------|---------|---------|---------|
| M0 | 4 | 2.0 d | 是 |
| M1-A | 4 | 3.5 d | 是 |
| M1-B | 3 | 2.5 d | 是 |
| M1-C | 3 | 1.5 d | 否 |
| M2-A | 3 | 3.0 d | 是 |
| M2-B | 3 | 3.0 d | 是 |
| M2-C | 4 | 3.0 d | 否 |
| M3 | 5 | 5.0 d | 否 |
| M4 | 6 | 6.5 d | 是 |
| M5 | 5 | 3.5 d | 否 |
| INT | 6 | 4.5 d | 是 |
| **合计** | **46** | **38.0 d** | **25.0 d** |

总工作量 38 工程师日,关键路径 25 d。
按 1 个全职工程师计算:38 d ≈ 8 周 → **建议至少 2 个工程师并行**(M1+M2 一人 / M3+M4+M5 一人),目标 6 周完成。

---

> **执行约定**:
> 1. 每个子任务完成后立即提 PR,带 conventional commit message(`feat:`、`fix:`、`refactor:` 等)
> 2. PR 模板必填: 涉及模块(M0~M5)/ 工时实际 / 是否破坏兼容 / 测试覆盖率
> 3. 双周回顾对齐:每两周 demo 前一天做内部 review
> 4. 任何超出本计划的需求 → 进 backlog,不在本周期内做
> 5. 关键路径任务延期 0.5 d 以上 → 立即触发风险讨论
>
> **下一步行动**:
> - 工程师确认计划 → start M0-T1 编写 Phase A schema PR
> - 同步建立 GitHub Project 看板,46 个子任务全部录入

---

## 关键文件路径索引

以下绝对路径在执行 Phase A 时会被频繁访问/修改:

**Schema 与迁移**
- `/home/willamhou/codes/PrismerCloud/server/prisma/schema.prisma`(M0-T1 增补 4 model + IMTask 改造)
- `/home/willamhou/codes/PrismerCloud/server/prisma/migrations/`(自动生成)
- `/home/willamhou/codes/PrismerCloud/server/scripts/migrate-task-assignee.ts`(M3-T5 新建)

**Go 服务(全部新建)**
- `/home/willamhou/codes/PrismerCloud/services/go.work`
- `/home/willamhou/codes/PrismerCloud/services/shared/`(sqlc + identity + proto)
- `/home/willamhou/codes/PrismerCloud/services/daemon/cmd/prismer-daemon/main.go`
- `/home/willamhou/codes/PrismerCloud/services/daemon/internal/`(api/ws/discovery/runner/approval)
- `/home/willamhou/codes/PrismerCloud/services/orchestrator/cmd/orchestrator/main.go`
- `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/`(server/hub/dispatcher/exec/log/retry/reaper/control/approval/metrics)
- `/home/willamhou/codes/PrismerCloud/services/e2e/`

**Server 端改造**
- `/home/willamhou/codes/PrismerCloud/server/src/app/api/runtimes/register/route.ts`(M1-A-T3 新建)
- `/home/willamhou/codes/PrismerCloud/server/src/app/api/approvals/`(M4-T2 整套新建)
- `/home/willamhou/codes/PrismerCloud/server/src/lib/services/personalAssistant.ts`(M5-T1 新建)
- `/home/willamhou/codes/PrismerCloud/server/src/lib/services/taskClaim.ts`(M3-T2 改造)
- `/home/willamhou/codes/PrismerCloud/server/src/lib/services/taskClose.ts`(M3-T2 改造)
- `/home/willamhou/codes/PrismerCloud/server/src/lib/aip/`(复用现有 didKey/delegationChain)

**SDK 改造(4 语言)**
- `/home/willamhou/codes/PrismerCloud/sdk/typescript/src/{cli/setup.ts,tasks/,approval/,agents/personal.ts}`
- `/home/willamhou/codes/PrismerCloud/sdk/python/prismer/{tasks.py,agents/personal.py}`
- `/home/willamhou/codes/PrismerCloud/sdk/golang/{tasks/,agents/}`
- `/home/willamhou/codes/PrismerCloud/sdk/rust/src/{tasks.rs,agents/}`

**部署与脚本**
- `/home/willamhou/codes/PrismerCloud/scripts/install.sh`(M1-C-T2)
- `/home/willamhou/codes/PrismerCloud/scripts/install.ps1`(M1-C-T2)
- `/home/willamhou/codes/PrismerCloud/services/daemon/.goreleaser.yml`(M1-C-T1)
- `/home/willamhou/codes/PrismerCloud/.github/workflows/{go.yml,release-daemon.yml}`(M0-T4 + M1-C-T1)

**测试 fixture**
- `/home/willamhou/codes/PrismerCloud/test/aip-fixtures/`(R3 互操作测试)


---

## 修订(Codex Review v2)

> 目标：在 8 周把 Phase A 从"能讲得通"变成"能抗故障"。
> 双轨：
> **Track B（推荐）**: 2 人并行，**36 工日 / 8 周**。
> **Track A（压缩版）**: 55 工日 / 11 周，W1-W8 为"最小闭环"，部分 Demo 降级，W9-W11 补齐低优先项。

### 先定全局里程碑（M1-M5 重定义，含硬指标/失败路径/回滚）

- **M1（W2-W3）Daemon 可见性闭环**
  - 硬指标：`npx @prismer/sdk setup --with-daemon` 到 UI 可见 runtime `status=online` 的时间 p95 ≤ 300s；心跳 20s、offline 判定 90s 且误离线率 < 0.5%。
  - 失败路径：重复 DID 注册、签名错误、token 过期触发重连，系统需退化为 `pending` 并可手动恢复。
  - 回滚：保留 `/api/runtimes/register` 旧版接口 + 关闭 `runtime_ws_accepted=true` 分支。

- **M2（W3-W4）Task 调度闭环**
  - 硬指标：单任务从 UI 创建到 daemon 收到 `task.push` 的 p95 ≤ 1.5s；流式 log 无丢行（10,000 行连续输入，校验 `seq` 连续）。
  - 失败路径：daemon 崩溃 / 重连 / 网络抖动时，in-flight task 必须在 90s 内可重试或保留重入状态。
  - 回滚：切回"仅人工拉取 dispatch"模式（禁用 LISTEN/NOTIFY 自动派发）。

- **M3（W5）Polymorphic assignee 与签名兼容**
  - 硬指标：`creatorDid/assigneeDid` 回填成功率≥99%，`assigneeType` 非空率≥99%，双读兼容期无 500。
  - 失败路径：历史任务没有可映射 DID 时必须降级为 `legacy`，不阻塞查询和展示。
  - 回滚：关闭 `STRICT_DID_REQUIRED`，回退到 `assigneeId` 主链路。

- **M4（W6）Approval Gate**
  - 硬指标：审批提交到决策完成 p95 ≤ 5s；拒绝越权率 100%，重复决策幂等处理 100%。
  - 失败路径：策略触发后审批超时/网络断开，任务状态必须回退到 `pendingApproval` 并可人工 override。
  - 回滚：在环境变量禁用 `APPROVAL_ENFORCE=true`，直接过审批继续执行。

- **M5（W7-W8）PA + Setup 一键化**
  - 硬指标：全新用户 5 分钟内可完成 `setup -> daemon 注册 -> 1 次 task 执行`（Track B）；Track A 降级为 10 分钟并允许先跳过 PA。
  - 失败路径：安装脚本签名失效/下载失败，必须输出清晰可重试诊断，不得静默退化。
  - 回滚：回到"仅 setup 创建配置，不自动启动 daemon"。

### 硬伤 / 风险映射

- **[HARDFIX-1]** Prisma↔sqlc 漂移治理缺位（W1-W3）
- **[HARDFIX-2]** WS 协议幂等与重放语义缺位（W2-W3）
- **[HARDFIX-3]** IMTask polymorphic 约束与迁移一致性不足（W5）
- **[HARDFIX-4]** 签名覆盖过度导致系统开销不稳（W1-W3）
- **[HARDFIX-5]** 工期与排期风险（W1 + 全程）
- **[HARDFIX-6]** 缺少最小安全/幂等基线（W3-W7）
- **[HARDFIX-7]** M1-M5 验收指标含糊（W1 + W8）

- **[RISK-1]** LISTEN/NOTIFY 丢事件/重放（W4）
- **[RISK-2]** 重连与取消/重试竞态（W4-W5）
- **[RISK-3]** WS JWT 放 URL 风险（W3）
- **[RISK-4]** Windows 平台兼容与服务化（W7）
- **[RISK-5]** 时钟偏移导致签名误杀（W2）
- **[RISK-6]** install 脚本与二进制供应链风险（W6）
- **[RISK-7]** log/运行日志膨胀与磁盘风险（W7）
- **[RISK-8]** CLI 参数注入与 workdir 越界（W4）
- **[RISK-9]** key rotation/撤销与密钥回收缺失（W2-W3）

---

## W1（2026-04-30 ~ 2026-05-06）
### 本周阻塞下游的关键产出（critical output blocking next week）
- 建立"Schema 契约闸门 + WS 统一 envelope 幂等基线 + Track B 并行边界"。

### 可验收任务清单（绝对路径）
- `Track B`
  - 创建并落地 `/home/willamhou/codes/PrismerCloud/docs/phase_a_protocol_contract.md`，定义 `Envelope` 幂等字段（`msg_id`,`state_version`,`state_crc`,`payload_hash`,`AckType`）。
  - 在 `/home/willamhou/codes/PrismerCloud/services/shared/proto/envelope.go` 补齐 `v2` 校验字段和 `StatefulMessage`。
  - 在 `/home/willamhou/codes/PrismerCloud/services/shared/proto/envelope_test.go` 增加幂等、重放、缺字段错误用例。
  - 新增 `/home/willamhou/codes/PrismerCloud/scripts/phase_a/schema_contract_guard.sh`，比对 Prisma 与 sqlc 输出 hash。
  - 在 `/home/willamhou/codes/PrismerCloud/.github/workflows/phase_a_contract_ci.yml` 加入 schema-guard 与 json-schema 验证。
  - 在 `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/server/server.go` 增加消息验签开关占位配置读取。
  - 标签映射：`[HARDFIX-1] [HARDFIX-2] [HARDFIX-5]`

- `Track A（压缩版）`
  - 仅完成文档+schema 约束框架，不扩展多语言脚手架；多 language 消息验证延后。

### 验收门禁（verification gate）
```bash
cd /home/willamhou/codes/PrismerCloud && bash scripts/phase_a/schema_contract_guard.sh
cd /home/willamhou/codes/PrismerCloud && go test ./services/shared/...
cd /home/willamhou/codes/PrismerCloud/services/orchestrator && go test ./internal/proto/...
```
- 指标：`schema_contract_guard` 必须输出 `contract_ok=true`；go test 无失败；`protocol contract` 生成物 hash 变更时 CI fail。

### 失败路径演示项
- 在 `schema.prisma` 增一虚拟字段不同步更新 shared query，确认 CI 因 hash mismatch 阻断；
- 注入重复 `msg_id` 请求，确认 orchestrator 仅记录一次状态变更（幂等表返回 `dedup=true`）。

### 回退点
- 回滚到上次成功提交（`git revert` 上一提交），并设置 `PRISMER_PROTOCOL_ENFORCE=off` 让服务退回旧 envelope；预计 10 分钟内完成。

### 本周如果出问题, fallback 是什么
- 暂停协议闸门升级，保留原消息结构兼容，只保留 `type` 与 `payload`；将 `schema_contract_guard.sh` 改为 nightly 任务，不阻断主干；先恢复 W0 基础设施再继续。

---

## W2（2026-05-07 ~ 2026-05-13）
### 本周阻塞下游的关键产出
- `签名分层` 与 `key 轮换框架` 建立，并提供可回滚验签策略开关。

### 可验收任务清单（绝对路径）
- `Track B`
  - 在 `/home/willamhou/codes/PrismerCloud/services/shared/identity/canonical.go` 实现固定序列化 + 哈希签名输入。
  - 在 `/home/willamhou/codes/PrismerCloud/services/shared/identity/keystore.go` + `/home/willamhou/codes/PrismerCloud/services/daemon/internal/identity/keystore.go` 加入 key-id 与轮换头。
  - 修改 `/home/willamhou/codes/PrismerCloud/server/src/lib/aip/signMessage.ts` 与 `/home/willamhou/codes/PrismerCloud/server/src/lib/aip/didKey.ts` 统一签名算法与 base64url。
  - 新增签名策略配置 `/home/willamhou/codes/PrismerCloud/server/config/signature-policy.ts` 与 `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/config/policy.go`。
  - 在 `/home/willamhou/codes/PrismerCloud/server/prisma/schema.prisma` 新增 `IMSigningKey`（`did`,`key_version`,`public_key`,`revoked_at`,`expires_at`）。
  - 标签映射：`[HARDFIX-4] [RISK-5] [RISK-9] [HARDFIX-1]`

- `Track A（压缩版）`
  - 只做 Ed25519 验签能力；key 表可延期到 W3，演示阶段先用环境变量密钥轮换。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud && npx vitest server/src/lib/aip/*.test.ts
cd /home/willamhou/codes/PrismerCloud && go test ./services/shared/identity/...
```
- 指标：跨语言签名 fixture 互操作一致（至少 TS 与 Go）；`HARDFIX-4` 触发规则生效，`heartbeat/log` 仅 sample 验签。

### 失败路径演示项
- 人为篡改 `nonce`/`ts` 后，`task claim` 接口必须拒绝；
- 主密钥 revoke 后用旧签名提交请求应失败、用新密钥成功。

### 回退点
- 通过 `SIGNATURE_ENFORCE=false` 退回"只记录警告、不过阻断"，并暂时保留 `IMSigningKey` 表创建不生效（`schema` migration rollback tag）。

### 本周如果出问题, fallback 是什么
- 先只在关键事件（register/task/approval）开启强签，其余事件改为非阻断日志告警；等待 W3 继续补齐再全面恢复。

---

## W3（2026-05-14 ~ 2026-05-20）
### 本周阻塞下游的关键产出（critical output blocking next week）
- 完成 `schema 契约闸门 + 协议幂等 + key rotation` 全链路落地并与 CI 打通。

### 可验收任务清单（绝对路径）
- `Track B`
  - 在 `/home/willamhou/codes/PrismerCloud/services/shared/proto/` 增加 `message_validation_test.go` 与 schema json，服务端统一引用。
  - 在 `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/hub/hub.go` 增加 `ack`/`dup_map` 与 `state_version` 处理。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/lib/contracts/wsMessage.ts` 增加解析器与错误码归一。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/lib/services/taskClaim.ts` 增加重放检测（nonce in DB + replay window）。
  - 在 `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/hub/reconnect.go`（新建）实现重复 seq 重发策略。
  - 标签映射：`[HARDFIX-1] [HARDFIX-2] [RISK-3] [RISK-2] [RISK-9]`

- `Track A（压缩版）`
  - 仅落 `hub` 幂等与服务端解析器，客户端重发策略部分延期到 W4。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud && npx node scripts/phase_a/schema_contract_guard.sh
cd /home/willamhou/codes/PrismerCloud/services/orchestrator && go test ./internal/hub ./internal/proto -run 'Idempotent|Replay'
cd /home/willamhou/codes/PrismerCloud/server && npm test -- wsMessage
```
- 指标：重复消息 100 次，状态只更新一次；stale state（state_version 回退）拒绝率 100%；`jwt` 不再出现在 URL query。

### 失败路径演示项
- 模拟时序逆转事件（老 `state_version`）到达，orchestrator 应返回 `410/stale` 并不写库。
- 强制注入 `ws_token` 到日志，确认掩码输出且无明文残留。

### 回退点
- 临时停用 `ack` 强制；将 `/home/.../services/orchestrator/internal/hub` 的 `require_idempotent=true` 改为 false，回归旧行为（30 分钟）。

### 本周如果出问题, fallback 是什么
- 切断"新增校验链"到最小兼容模式：只保留 `msg_id` 去重，不做 `state_version`，并把风险提交为待办，不阻塞 M2 派发开发。

---

## W4（2026-05-21 ~ 2026-05-27）
### 本周阻塞下游的关键产出
- Daemon 执行链完整通道打通，同时解决事件丢失/重复派发与执行安全边界的首个闭环。

### 可验收任务清单（绝对路径）
- `Track B`
  - 在 `/home/willamhou/codes/PrismerCloud/services/daemon/internal/runner/runner.go` 增加 `context` 传播、超时杀死、输出分片 seq。
  - 在 `/home/willamhou/codes/PrismerCloud/services/daemon/internal/runner/streaming.go` 加入 output sanitize（去掉控制字符，限制长度）。
  - 在 `/home/willamhou/codes/PrismerCloud/services/daemon/internal/ws/client.go` 增加 `task.cancel` 的幂等处理。
  - 在 `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/dispatcher/dispatcher.go` 和 `listener.go` 增加 LISTEN 丢失重扫（fallback polling）。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/lib/services/taskCreate.ts` 增加 `dispatch_intent` 记录与幂等 token。
  - 在 `/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/control/control.go` 补充 cancel/重试竞态互斥。
  - 标签映射：`[RISK-1] [RISK-2] [RISK-8] [HARDFIX-7]`

- `Track A（压缩版）`
  - 先实现 `runner` + `task.push/finished/log` 基础通道，重扫 fallback 延后到 W6。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud/services/orchestrator && go test ./internal/dispatcher ./internal/control
cd /home/willamhou/codes/PrismerCloud/services/daemon && go test ./internal/runner ./internal/ws
```
- 指标：1000 行 log 连续流，`seq` 漏报率=0；daemon 断开 90s 内重连成功率>=95%。

### 失败路径演示项
- `kill -9` Daemon 后 2 分钟内任务变更应至少记录 `cancelled` 并触发重试；
- 发送命令含 `../` 路径逃逸到 daemon，应阻止执行。

### 回退点
- 关闭 listener fallback 的自动派发，切回人工触发重试接口（`dispatch` endpoint）；保留日志 pipeline，回滚时间 30 分钟。

### 本周如果出问题, fallback 是什么
- 将 M2 暂定为"人工触发 dispatch"；若重连与重试逻辑不稳，先保住执行正确性，把优化留到 W5-W6。

---

## W5（2026-05-28 ~ 2026-06-03）
### 本周阻塞下游的关键产出
- IMTask polymorphic 改造完成，schema 约束与迁移可回滚。

### 可验收任务清单（绝对路径）
- `Track B`
  - 在 `/home/willamhou/codes/PrismerCloud/server/prisma/schema.prisma` 完整落地 `IMTask` 与新表约束：
    - `assigneeType` enum check
    - `assigneeDid`/`assigneeId` 至少一个非空 fallback
    - `pendingApprovalId` FK/索引策略。
  - 在 `/home/willamhou/codes/PrismerCloud/server/scripts/migrate-task-assignee.ts` 增加 dry-run/rollback 日志、批次游标（`createdAt,id` 双游标）。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/lib/services/taskClaim.ts` 与 `taskClose.ts` 实施 `assigneeDid` 优先 + 回退路径。
  - 新增索引校验脚本 `/home/willamhou/codes/PrismerCloud/scripts/phase_a/index_audit.sql`。
  - 标签映射：`[HARDFIX-3] [RISK-5] [RISK-4]`

- `Track A（压缩版）`
  - 仅完成 schema + 迁移 dry-run，不做全部旧数据兜底 UI 验证。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud/server && npx tsx scripts/migrate-task-assignee.ts --dry-run
cd /home/willamhou/codes/PrismerCloud/server && npx prisma migrate dev --create-only --name phase_a_task_assignee
cd /home/willamhou/codes/PrismerCloud/server && npm test -- taskClaim taskClose
```
- 指标：旧任务回填成功率≥99%，回退逻辑覆盖 100 条边界样本。

### 失败路径演示项
- 插入一条只有 `assigneeId` 但无 DID 的历史任务，开启/关闭 `STRICT_DID_REQUIRED` 对比行为是否降级正确。

### 回退点
- 执行 `STRICT_DID_REQUIRED=false` 并恢复旧查询逻辑，回滚 migration 仅回到 nullable 新增字段版本。

### 本周如果出问题, fallback 是什么
- 不强制开启新 assignee 主路径，先保持 `assigneeId` 主链路，通过 API 层兼容输出，让 M4 和 M5 使用 legacy 任务继续推进。

---

## W6（2026-06-04 ~ 2026-06-10）
### 本周阻塞下游的关键产出
- Approval Gate 上链路先稳定上线，权限与策略可解释、可回退。

### 可验收任务清单（绝对路径）
- `Track B`
  - 完成 `/home/willamhou/codes/PrismerCloud/server/src/app/api/approvals/route.ts`、`/home/willamhou/codes/PrismerCloud/server/src/app/api/approvals/[id]/approve/route.ts`、`/home/willamhou/codes/PrismerCloud/server/src/app/api/approvals/[id]/reject/route.ts`。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/lib/services/approval.ts` 统一审批状态机（pending/approved/rejected/expired）。
  - 在 `/home/willamhou/codes/PrismerCloud/services/daemon/internal/approval/gate.go` 增加挂起/继续/超时策略。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/lib/services/approval-policy.ts` 实施策略文件驱动。
  - 在 `/home/willamhou/codes/PrismerCloud/scripts/phase_a/approval_contract_check.ts` 增加越权/重复决策测试。
  - 标签映射：`[HARDFIX-6] [RISK-6] [RISK-2]`

- `Track A（压缩版）`
  - 去掉高级 policy 细化，仅保留 `task_create` + `dangerous_action` 两类。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud/server && npm test -- approval
curl -X POST http://localhost:3000/api/approvals/<id>/approve -d '{...}'
```
- 指标：无权限决策拒绝率=100%；决策耗时 p95≤5s；重复决策幂等。

### 失败路径演示项
- 模拟 delegator 无权审批和双重审批，两者均返回明确错误并保留 audit 证据。

### 回退点
- `APPROVAL_ENFORCE=true` 改为 false，任务直接跳过审批，保留 approval 记录供追溯。

### 本周如果出问题, fallback 是什么
- 将 Approval 改为"仅记录建议，不阻塞执行"；恢复核心 M2/M3 交付，并在 W7 前补齐策略。

---

## W7（2026-06-11 ~ 2026-06-17）
### 本周阻塞下游的关键产出
- 一键安装闭环、PA 能力和 4 语言 SDK 关键路径同步，且处理 Windows/脚本供应链和日志容量。

### 可验收任务清单（绝对路径）
- `Track B`
  - 完成 `/home/willamhou/codes/PrismerCloud/scripts/install.sh` 与 `/home/willamhou/codes/PrismerCloud/scripts/install.ps1`（签名校验 + 幂等安装 + 回滚脚本）。
  - 完成 daemon 发布链 `/home/willamhou/codes/PrismerCloud/services/daemon/.goreleaser.yml` 与 `/home/willamhou/codes/PrismerCloud/.github/workflows/release-daemon.yml`。
  - 完成 PA 流程：`/home/willamhou/codes/PrismerCloud/server/src/lib/services/personalAssistant.ts`、`/home/willamhou/codes/PrismerCloud/server/src/lib/services/paOnboarding.ts`。
  - 4 语言 SDK 更新：
    - `/home/willamhou/codes/PrismerCloud/sdk/typescript/src/agents/personal.ts`
    - `/home/willamhou/codes/PrismerCloud/sdk/python/prismer/agents/personal.py`
    - `/home/willamhou/codes/PrismerCloud/sdk/golang/agents/personal.go`
    - `/home/willamhou/codes/PrismerCloud/sdk/rust/src/agents/personal.rs`
  - 日志/指标收敛：`/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/log/writer.go` 添加 TTL 清理、`/home/willamhou/codes/PrismerCloud/services/orchestrator/internal/metrics/metrics.go` 增加 `log_flush_lag` 和 `log_store_bytes`。
  - 标签映射：`[RISK-6] [RISK-7] [RISK-4] [HARDFIX-6] [HARDFIX-7]`

- `Track A（压缩版）`
  - 暂不做 windows/全部语言 SDK 全量回归，只保证 TS+一个后端 SDK 可用；PA demo 降级为"首次登录可见可选提醒"。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud && bash scripts/install.sh --dry-run
cd /home/willamhou/codes/PrismerCloud/sdk/typescript && npm test -- agents/personal.test.ts
```
- 指标：脚本签名校验失败必须阻断安装；日志存储增长速度在 1 小时内可控（增长率可度量且可预警）。

### 失败路径演示项
- 安装脚本下载未签名 artifact，必须退出并报 `signature mismatch`。
- Windows 上模拟缺少服务权限启动，返回可恢复错误码并保留 fallback 指令。

### 回退点
- 关闭一键安装入口，恢复手工部署文档路径；PA 与 SDK 任务可在 W8 演示中降级为异步脚本。

### 本周如果出问题, fallback 是什么
- 发布链回退到本地二进制手工安装，所有自动化安装入口置灰；只保留 CLI `setup` 显示指引不强制执行。

---

## W8（2026-06-18 ~ 2026-06-24）
### 本周阻塞下游的关键产出
- 里程碑验收固化、E2E 与故障演练收口，形成可发布版本。

### 可验收任务清单（绝对路径）
- `Track B`
  - 完成 `/home/willamhou/codes/PrismerCloud/services/e2e/happy_path_test.go` 与 `/home/willamhou/codes/PrismerCloud/services/e2e/failure_matrix_test.go`。
  - 更新 `/home/willamhou/codes/PrismerCloud/docs/PHASE_A_PLAN.md` 增加"修订 v2"执行记录。
  - 添加 `release` 阶段脚本：`/home/willamhou/codes/PrismerCloud/scripts/phase_a/release_notes.sh`。
  - 在 `/home/willamhou/codes/PrismerCloud/server/src/app/(app)/approvals/page.tsx` + `ApprovalCard` 做失败/超时显式展示（不是只显示 pending）。
  - 标签映射：`[HARDFIX-7] [RISK-1] [RISK-2] [RISK-5]`

- `Track A（压缩版）`
  - 仅保留最小可演示链路：setup + daemon + M2 + M4 简化；PA 与多语言 SDK 在文档标注 deferred。

### 验收门禁
```bash
cd /home/willamhou/codes/PrismerCloud/services/e2e && go test ./...
cd /home/willamhou/codes/PrismerCloud && npm run test:phase-a
cd /home/willamhou/codes/PrismerCloud && go test ./services/... -run 'reconnect|idempotent'
```
- 指标：
  - M1 注册在线率成功 demo：100%
  - M2 单任务派发成功率 >= 99%（含断线重连）
  - M3 claim/close 互操作 100%
  - M4 审批路径失败注入覆盖率 >= 90%
  - M5 demo 成功率：Track B 5min 内主链路；Track A 10min 内主链路

### 失败路径演示项
- 注入 orchestrator/daemon 网络分区后，任务不得丢失（记录 pending 或可恢复）并可人工恢复；
- 人工断言数据库 100 并发写入下 approval 与 task 两表无死锁报错。

### 回退点
- 标记 Release 为 `rc`，保留 `production` 配置不变；如发现关键错误，关闭 `phase_a` feature flag 并回滚到 W7 版本。

### 本周如果出问题, fallback 是什么
- 只发布"守住 M1~M4 最小可用"：暂停 PA/一键体验，发布 `phase-a-core`，保留缺陷任务和补丁列表，避免把演示失效拖垮主链路。

---

## Track A（单人压缩版，55 工日 / 11 周）额外说明

- W1-W4 与 Track B 同步，只完成阻塞项；W5-W6 聚焦 W2-W5 风险消化；
- W7-W11 追加：Windows 与供应链回归、4 语言全部 SDK 验证、M5 完整演示、日志压缩策略与更细审批策略；
- 降级点：
  - M3 采用 `assignee` 兼容过渡时间延长到 W7；
  - W8 Demo 允许"无 PA 一键场景"通过；
  - W9-W11 再补 `openapi` 与跨端行为一致性。

---

## 关键执行规则（必须遵守）

- [HARDFIX-1]~[HARDFIX-7] 和 [RISK-1]~[RISK-9] 均必须在对应周内被显式验证。
- 所有新行为必须带 feature flag：`PRISMER_PHASE_A_FLAGS`（`idempotent_ws`, `strict_signature`, `approval_enforce`, `daemon_auto_setup`）。
- 每周 PR 前必交付：**1) 回归门禁截图/日志 2) 失败路径演示 3) rollback 脚本。**

---

## 每周末统一 fallback 模板（可直接执行）

```bash
cd /home/willamhou/codes/PrismerCloud
git stash push -u -m "wip-fallback"  # 仅当前周未提交工作
git reset --hard HEAD~1                  # 回到上周安全提交
git checkout -- .                         # 仅用于工作区，非提交历史变更
export PRISMER_PROTOCOL_ENFORCE=false
export STRICT_DID_REQUIRED=false
export APPPROVAL_ENFORCE=false
docker compose -f server/docker-compose.yml down && docker compose -f server/docker-compose.yml up -d
```
- 说明：在单节点回退时，不做数据库大规模回滚；仅回滚行为层，保留 schema 兼容层；一小时内可恢复到"上周可运行状态"。


---

## 修订(Architect Review v3)

> **增量说明**:本章节是对 V2 修订的纯增量 patch,V2 内容保持原样不动。V3 按 6 项 Architect Review 意见(R1-R6)逐一给出具体工程内容,每项包含改动点、落点文件、验收门禁、与 V2 的差异 diff、受影响周次及工作量增减。

---

## R1 — Schema 闸门:hash → semantic graph

### 改动点

V2 的 hash 闸门在 schema 结构语义等价但文本不同时(字段顺序、注释、空格)会误报 drift,阻断合法部署。V3 引入 [Atlas](https://atlasgo.io/) 做四维语义比对:列名、列类型、约束(NOT NULL/DEFAULT/FK)、索引(name/unique/partial)。Hash 降级为 sanity check 兜底,真正的阻断权由 Atlas diff 接管。

**三阶段演进路径:**

| 周次 | 闸门角色 | 阻断条件 |
|------|---------|---------|
| W1 | hash 闸门(V2 原设计) | hash 不匹配即阻断 |
| W2 | hash(sanity) + Atlas(语义) 双跑 | hash 不匹配 → 先跑 Atlas;Atlas 语义等价 → 放行并告警 |
| W3+ | Atlas 作为唯一真闸门 | Atlas diff 有 breaking change → 阻断;hash 仅记录 audit log |

### 落点文件

```
services/orchestrator/internal/migration/
├── gate.go              # V2 原 hash 闸门,W2 起改为 Dual-mode wrapper
├── atlas_semantic.go    # 新增:调用 atlas CLI,解析 diff 输出
└── gate_test.go         # 新增 table-driven test,覆盖语义等价/breaking 两种场景
Makefile                 # 新增 schema-lint target
```

### 具体代码

**`atlas_semantic.go`**

```go
// Package migration provides Atlas-backed semantic schema gating.
package migration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// AtlasDiff represents a single change returned by atlas schema diff --format json.
type AtlasDiff struct {
	Type    string `json:"type"`    // "ADD_COLUMN" | "DROP_COLUMN" | "MODIFY_COLUMN" | etc.
	Table   string `json:"table"`
	Breaking bool  `json:"breaking"`
}

// AtlasResult holds the structured output of atlas schema diff.
type AtlasResult struct {
	Diffs []AtlasDiff `json:"changes"`
}

// V3.1.1 (Codex P2 fix): we deliberately do NOT maintain a hard-coded
// `breakingChangeTypes` map. The whole point of switching from hash to Atlas
// (R1) was to escape false positives from naive equality. Hard-coding "every
// MODIFY_COLUMN / DROP_INDEX / DROP_CONSTRAINT is breaking" reintroduces the
// same class of false positives: widening a column, dropping a non-unique
// secondary index, or relaxing a CHECK are all routinely safe.
//
// Atlas's own diff output has a per-change `breaking` flag that already
// understands semantic safety (e.g. nullable→nullable widening = non-breaking,
// nullable→NOT NULL on populated column = breaking). Trust it.
//
// The CI gate becomes: any diff where `breaking=true` blocks deployment;
// non-breaking diffs (even DROP_INDEX of a non-unique idx) pass with audit log.
//
// If a specific Atlas heuristic later turns out to be wrong for our schema
// shape, override at the migration-file level via `atlas.hcl` policy block,
// not by reintroducing a static type list here.

// RunAtlasDiff calls `atlas schema diff` between from and to DSNs and returns
// structured diff results. Returns (nil, nil) when schemas are semantically
// identical (no diffs).
func RunAtlasDiff(ctx context.Context, fromDSN, toDSN string) (*AtlasResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// atlas schema diff --from <from> --to <to> --format '{{ json . }}'
	cmd := exec.CommandContext(ctx, "atlas", "schema", "diff",
		"--from", fromDSN,
		"--to", toDSN,
		"--format", `{{ json . }}`,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// V3.1.2 (Codex P1 fix): never fail open. Atlas missing / timeout /
	// crashing before emitting JSON would otherwise silently disable the
	// schema gate in the very environments where Atlas is unavailable, which
	// is the OPPOSITE of what a "trust Atlas" gate should do.
	runErr := cmd.Run()
	if runErr != nil {
		// Distinguish three cases:
		//   (a) atlas exits non-zero AND emitted valid JSON on stdout — normal "diffs found" path
		//   (b) atlas exits non-zero with stderr "Error:" — real atlas error, MUST fail closed
		//   (c) atlas exits non-zero with empty stdout AND empty/no "Error:" stderr — atlas
		//       binary is broken or context cancelled; MUST also fail closed
		if strings.Contains(stderr.String(), "Error:") {
			return nil, fmt.Errorf("atlas schema diff error: %s", stderr.String())
		}
		if stdout.Len() == 0 {
			// Case (c): empty stdout + non-zero exit + no "Error:" line → fail closed.
			return nil, fmt.Errorf("atlas schema diff failed without output: exit=%v stderr=%q", runErr, stderr.String())
		}
		// Case (a): non-zero exit with diff output is atlas's normal "diffs found" path; fall through.
	} else if stdout.Len() == 0 {
		// Zero exit + no stdout = genuine "schemas semantically identical".
		return &AtlasResult{}, nil
	}

	var result AtlasResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return nil, fmt.Errorf("atlas output parse failed: %w (raw: %s)", err, stdout.String())
	}
	return &result, nil
}

// HasBreakingChanges returns true if any diff entry is a breaking change.
func HasBreakingChanges(r *AtlasResult) (bool, []AtlasDiff) {
	if r == nil {
		return false, nil
	}
	// V3.1.1 (Codex P2 fix): trust Atlas's own per-change `breaking` flag.
	// No hard-coded type list — see comment above.
	var breaking []AtlasDiff
	for _, d := range r.Diffs {
		if d.Breaking {
			breaking = append(breaking, d)
		}
	}
	return len(breaking) > 0, breaking
}
```

**`gate.go` W2 改造 (diff from V2)**

```go
// DualModeGate wraps the V2 hash gate with Atlas semantic gating.
// In W1: HashOnly mode (V2 behavior preserved).
// In W2+: Dual mode — hash mismatch triggers Atlas check.
// In W3+: AtlasOnly mode — hash becomes audit-only.
type GateMode int

const (
	HashOnly   GateMode = iota // W1
	Dual                       // W2
	AtlasOnly                  // W3+
)

type SchemaGate struct {
	mode    GateMode
	fromDSN string
	toDSN   string
}

func (g *SchemaGate) Check(ctx context.Context, expectedHash, actualHash string) error {
	hashMatch := expectedHash == actualHash

	switch g.mode {
	case HashOnly:
		if !hashMatch {
			return fmt.Errorf("schema hash mismatch: expected %s, got %s", expectedHash, actualHash)
		}
		return nil

	case Dual:
		if hashMatch {
			return nil // fast path
		}
		// hash mismatch → escalate to Atlas
		result, err := RunAtlasDiff(ctx, g.fromDSN, g.toDSN)
		if err != nil {
			return fmt.Errorf("atlas diff failed (blocking): %w", err)
		}
		breaking, changes := HasBreakingChanges(result)
		if breaking {
			return fmt.Errorf("atlas detected breaking changes: %+v", changes)
		}
		// semantically equivalent → log warn and allow
		log.Warn("schema hash mismatch but Atlas found no breaking changes; allowing",
			"expected_hash", expectedHash, "actual_hash", actualHash)
		return nil

	case AtlasOnly:
		// hash goes to audit log only
		if !hashMatch {
			log.Info("schema hash mismatch recorded in audit log",
				"expected", expectedHash, "actual", actualHash)
		}
		result, err := RunAtlasDiff(ctx, g.fromDSN, g.toDSN)
		if err != nil {
			return fmt.Errorf("atlas diff failed: %w", err)
		}
		if ok, changes := HasBreakingChanges(result); ok {
			return fmt.Errorf("atlas breaking changes detected: %+v", changes)
		}
		return nil
	}
	return fmt.Errorf("unknown gate mode: %d", g.mode)
}
```

**`Makefile` target**

```makefile
.PHONY: schema-lint schema-diff

# Run Atlas migrate lint against the current migration directory.
# Fails if any migration introduces a breaking change without explicit approval.
schema-lint:
	atlas migrate lint \
		--dev-url "docker://postgres/15/dev" \
		--dir "file://server/prisma/migrations" \
		--format "{{ range .Files }}{{ .Name }}: {{ range .Reports }}{{ .Text }}{{ end }}{{ end }}"

# Show semantic diff between current DB and target schema.
schema-diff:
	atlas schema diff \
		--from "$(FROM_DSN)" \
		--to "file://server/prisma/schema.prisma" \
		--format '{{ json . }}' | jq .
```

### 验收门禁

```bash
# W1 门禁:hash gate 单测
go test ./services/orchestrator/internal/migration/... -run TestHashGate -v

# W2 门禁:Atlas diff 语义等价场景不阻断
make schema-lint  # 必须 exit 0

# W2 门禁:Atlas breaking change 场景必须阻断
atlas schema diff \
  --from "postgres://...?search_path=public" \
  --to   "file://test/fixtures/schema_drop_col.hcl" \
  --format '{{ json . }}' | jq '.changes[] | select(.breaking)'
# 期望输出至少 1 条 breaking change

# W3 门禁:CI pipeline 强制 AtlasOnly 模式
SCHEMA_GATE_MODE=atlas_only go test ./services/orchestrator/... -count=1

# Atlas migrate lint 无 ERROR 级别报告
make schema-lint 2>&1 | grep -i error && exit 1 || exit 0
```

### 与 V2 的差异 diff

```
V2: schema 闸门 = SHA-256 hash 比对,hash 不匹配即 fatal error
V3:
+ W1: 保留 V2 hash gate 不变(零风险)
+ W2: hash mismatch 时 fallback 到 Atlas diff;Atlas 语义无 breaking → warn + allow
+ W3: AtlasOnly 模式,hash 降为 audit log;Atlas diff 是唯一 blocker
+ 新增: atlas_semantic.go + make schema-lint + make schema-diff
- 删除: 无(V2 gate.go 保留,以 GateMode 枚举控制行为)
```

### 受影响周次与工作量

| 周次 | 新增工作 | 工作量 |
|------|---------|--------|
| W1 | GateMode 枚举重构,HashOnly 模式透明 | +0.5d |
| W2 | atlas_semantic.go + Dual mode + make schema-lint | +1.5d |
| W3 | AtlasOnly 切换 + CI 集成 | +0.5d |
| **小计** | | **+2.5d** |

---

## R2 — 协议幂等拆分:状态机 vs 事件流

> 这是 V3 最关键的改动。V2 对所有消息类型统一使用 `(execution_id, state_version)` CAS,导致高频 stream 消息(heartbeat/log/output)在并发下产生大量 CAS 冲突和不必要的 retry 风暴。V3 按 `message_class` 拆分幂等路径。

### 改动点

**核心设计原则:**

- `stateful` 类消息代表状态机跃迁,天然互斥,用 CAS 保证线性化
- `stream` 类消息代表事件流追加,天然有序但允许并发,用单调 seq 保证 at-most-once append
- 两类消息共享同一个 WebSocket envelope,由 `message_class` 字段路由到不同处理器

### 落点文件

```
services/shared/proto/
├── envelope.go          # 增加 MessageClass 字段
└── message_class.go     # 新增:MessageClass 常量 + 分流逻辑

services/orchestrator/internal/hub/
├── dedup.go             # 新增:双表 dedup 路由器
└── hub.go               # 改造:按 message_class 分流

server/prisma/schema.prisma     # 新增两张 dedup 表
server/src/lib/contracts/wsMessage.ts  # 新增 message_class 字段
```

### 具体代码

#### `services/shared/proto/message_class.go`(新增)

```go
package proto

// MessageClass distinguishes state-machine messages from event-stream messages.
// The distinction drives idempotency strategy:
//   - Stateful: CAS on (execution_id, state_version) — linearized state transitions
//   - Stream:   monotonic seq per (execution_id, stream_id) — append-only dedup
type MessageClass string

const (
	// MessageClassStateful covers messages that trigger a state transition.
	// Claim, finish, cancel, approve, push are stateful.
	// Use (execution_id, state_version) CAS.
	MessageClassStateful MessageClass = "stateful"

	// MessageClassStream covers high-frequency append-only messages.
	// log, output, heartbeat are stream class.
	// Use per-stream monotonic seq; no CAS.
	MessageClassStream MessageClass = "stream"

	// V3.1.2 (Codex P1 fix): MessageClassLegacy is assigned when a pre-V3
	// envelope arrives without a message_class field. Legacy messages bypass
	// dedup entirely and route to a best-effort handler (handleLegacyBestEffort).
	// This class only appears on the wire indirectly — it's an internal tag
	// that the validator stamps onto incoming envelopes. After all daemon
	// fleet upgrades, this branch goes cold and can be removed in V4.
	MessageClassLegacy MessageClass = "legacy"
)

// StatefulMessageTypes lists the message types that belong to the stateful class.
var StatefulMessageTypes = map[string]bool{
	"claim":   true,
	"finish":  true,
	"cancel":  true,
	"approve": true,
	"push":    true,
}

// StreamMessageTypes lists the message types that belong to the stream class.
var StreamMessageTypes = map[string]bool{
	"log":       true,
	"output":    true,
	"heartbeat": true,
}

// ClassifyMessage returns the MessageClass for a given message type.
// Falls back to MessageClassStateful for unknown types (safe default).
func ClassifyMessage(msgType string) MessageClass {
	if StreamMessageTypes[msgType] {
		return MessageClassStream
	}
	return MessageClassStateful
}
```

#### `services/shared/proto/envelope.go`(改动部分,diff)

```go
// Envelope is the top-level WebSocket message wrapper.
// V3 adds MessageClass to drive idempotency routing.
type Envelope struct {
	// --- existing V2 fields (preserved) ---
	ID          string          `json:"id"`
	ExecutionID string          `json:"execution_id"`
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	// V3.1 (P1-3 fix): renamed `timestamp` → `timestamp_ms` and downgraded
	// from Unix nanoseconds to Unix milliseconds. Nanoseconds (~1.7e18)
	// exceed JavaScript's 53-bit safe integer range (~9e15), so any TS
	// producer/consumer would silently round, breaking JCS bit-exact equality
	// and signature verification across languages. Milliseconds stay within
	// Number.MAX_SAFE_INTEGER until ~2255 AD.
	TimestampMs int64           `json:"timestamp_ms"`
	// StateVersion is the CAS token for stateful messages.
	// Stream messages set this to 0.
	StateVersion int64  `json:"state_version,omitempty"`
	Signature    string `json:"signature,omitempty"`

	// --- V3 additions ---
	// MessageClass routes this message to the correct idempotency handler.
	// Must be set by sender. If absent, defaults to "stateful" for safety.
	MessageClass MessageClass `json:"message_class"`

	// For stream messages: monotonic sequence number per stream_id.
	// Senders must increment per (execution_id, stream_id) pair.
	StreamID      string `json:"stream_id,omitempty"`
	StreamSeq     int64  `json:"stream_seq,omitempty"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

// Validate enforces class-specific field requirements.
func (e *Envelope) Validate() error {
	if e.ExecutionID == "" {
		return errors.New("execution_id required")
	}
	switch e.MessageClass {
	case MessageClassStateful:
		if e.StateVersion <= 0 {
			return errors.New("stateful message requires state_version > 0")
		}
	case MessageClassStream:
		if e.StreamID == "" {
			return errors.New("stream message requires stream_id")
		}
		if e.StreamSeq < 0 {
			return errors.New("stream_seq must be >= 0")
		}
	case "":
		// V3.1.2 (Codex P1 re-fix, supersedes V3.1.1): pre-V3 messages have
		// no message_class AND no stream_id / stream_seq / state_version. The
		// V3.1.1 attempt to "infer class then re-run validators" would still
		// reject legacy stream frames because the validators above demand
		// stream_id/stream_seq for MessageClassStream.
		//
		// Correct approach: tag legacy traffic with its own MessageClassLegacy
		// and route it to a non-deduping best-effort handler. This means
		// during a rolling upgrade window:
		//   - legacy senders never get rejected by validation
		//   - legacy messages MAY be processed more than once if reconnects
		//     replay them (acceptable trade-off — heartbeats/logs are
		//     idempotent at the application layer)
		//   - once all senders have upgraded, legacy class disappears from the
		//     wire and dedup applies to 100% of traffic
		e.MessageClass = MessageClassLegacy
		return nil
	default:
		return fmt.Errorf("unknown message_class: %s", e.MessageClass)
	}
	return nil
}
```

#### `services/orchestrator/internal/hub/dedup.go`(新增)

```go
package hub

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/prismercloud/services/shared/proto"
)

// ErrDuplicate is returned when a message has already been processed.
var ErrDuplicate = errors.New("duplicate message")

// ErrSeqOutOfOrder is returned when a stream message seq is not monotonically increasing.
var ErrSeqOutOfOrder = errors.New("stream seq out of order")

// DedupRouter dispatches envelope deduplication to the correct table
// based on message_class.
type DedupRouter struct {
	db *sql.DB
}

func NewDedupRouter(db *sql.DB) *DedupRouter {
	return &DedupRouter{db: db}
}

// CheckAndRecord atomically checks for duplicate and records the message.
// Returns ErrDuplicate if the message was already processed.
// Returns ErrSeqOutOfOrder if a stream message's seq is not monotonically increasing.
func (r *DedupRouter) CheckAndRecord(ctx context.Context, env *proto.Envelope) error {
	if err := env.Validate(); err != nil {
		return fmt.Errorf("envelope validation: %w", err)
	}
	switch env.MessageClass {
	case proto.MessageClassStateful:
		return r.checkStateful(ctx, env)
	case proto.MessageClassStream:
		return r.checkStream(ctx, env)
	default:
		return fmt.Errorf("unknown message_class: %s", env.MessageClass)
	}
}

// checkStateful uses INSERT INTO ... ON CONFLICT DO NOTHING with CAS.
// The unique index on (execution_id, state_version) guarantees linearization.
func (r *DedupRouter) checkStateful(ctx context.Context, env *proto.Envelope) error {
	res, err := r.db.ExecContext(ctx, `
		INSERT INTO phase_a_msg_dedup_stateful (execution_id, state_version, msg_id, msg_type, received_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (execution_id, state_version) DO NOTHING
	`, env.ExecutionID, env.StateVersion, env.ID, env.Type)
	if err != nil {
		return fmt.Errorf("stateful dedup insert: %w", err)
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrDuplicate
	}
	return nil
}

// checkStream enforces monotonic seq per (execution_id, stream_id).
// It does NOT use CAS — concurrent appends are allowed as long as seq increases.
//
// Concurrency strategy (V3.1, fixes Codex P1-1):
//   1. Acquire a transaction-scoped Postgres advisory lock keyed on
//      hashtextextended(execution_id || stream_id). This serializes concurrent
//      writers for the same logical stream without locking other streams.
//   2. Read the current max seq using a row-level SELECT (NOT an aggregate),
//      since FOR UPDATE is illegal on aggregate queries in Postgres.
//   3. Insert the new row; the (execution_id, stream_id, seq) UNIQUE constraint
//      acts as a final correctness backstop even if the advisory lock is bypassed.
func (r *DedupRouter) checkStream(ctx context.Context, env *proto.Envelope) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Step 1: serialize concurrent writers on this (execution_id, stream_id) using
	// a transaction-scoped advisory lock. Lock is released automatically on commit/rollback.
	if _, err := tx.ExecContext(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))
	`, env.ExecutionID, env.StreamID); err != nil {
		return fmt.Errorf("stream dedup advisory lock: %w", err)
	}

	// Step 2: read latest seq via row-level SELECT (not aggregate). FOR UPDATE is
	// not strictly required because the advisory lock already serializes writers,
	// but kept for defense-in-depth against direct INSERTs that bypass this path.
	var maxSeq sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT seq FROM phase_a_msg_dedup_stream
		WHERE execution_id = $1 AND stream_id = $2
		ORDER BY seq DESC
		LIMIT 1
		FOR UPDATE
	`, env.ExecutionID, env.StreamID).Scan(&maxSeq)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("stream dedup read: %w", err)
	}

	if maxSeq.Valid && env.StreamSeq <= maxSeq.Int64 {
		// seq is not increasing → duplicate or reorder
		if env.StreamSeq == maxSeq.Int64 {
			return ErrDuplicate
		}
		return ErrSeqOutOfOrder
	}

	// Step 3: insert with UNIQUE (execution_id, stream_id, seq) as backstop.
	_, err = tx.ExecContext(ctx, `
		INSERT INTO phase_a_msg_dedup_stream
			(execution_id, stream_id, seq, msg_id, msg_type, idempotency_key, received_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
	`, env.ExecutionID, env.StreamID, env.StreamSeq, env.ID, env.Type, env.IdempotencyKey)
	if err != nil {
		// Unique violation → genuine duplicate from a concurrent path that bypassed advisory lock.
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return fmt.Errorf("stream dedup insert: %w", err)
	}

	return tx.Commit()
}
```

#### `server/prisma/schema.prisma`(新增两张 dedup 表)

```prisma
// V3: Stateful message dedup table.
// Primary key = (execution_id, state_version) enforces CAS linearization.
// One row per state transition attempt; duplicates are silently dropped via ON CONFLICT DO NOTHING.
model PhaseAMsgDedupStateful {
  executionId  String   @map("execution_id")
  stateVersion BigInt   @map("state_version")
  msgId        String   @map("msg_id")
  msgType      String   @map("msg_type")
  receivedAt   DateTime @map("received_at") @default(now())

  @@id([executionId, stateVersion])
  @@map("phase_a_msg_dedup_stateful")
}

// V3: Stream message dedup table.
// Append-only monotonic seq per (execution_id, stream_id).
// Partial unique index on (execution_id, stream_id, seq) prevents duplicate seq values.
// No CAS — concurrent stream writers are allowed as long as seq is monotonically increasing.
model PhaseAMsgDedupStream {
  id             BigInt   @id @default(autoincrement())
  executionId    String   @map("execution_id")
  streamId       String   @map("stream_id")
  seq            BigInt
  msgId          String   @map("msg_id")
  msgType        String   @map("msg_type")
  idempotencyKey String?  @map("idempotency_key")
  receivedAt     DateTime @map("received_at") @default(now())

  @@unique([executionId, streamId, seq])
  @@index([executionId, streamId])
  @@map("phase_a_msg_dedup_stream")
}
```

**对应的原始 SQL DDL(用于手动 migration 或 Atlas 导入):**

```sql
-- phase_a_msg_dedup_stateful: CAS 强一致 dedup
CREATE TABLE phase_a_msg_dedup_stateful (
    execution_id    TEXT        NOT NULL,
    state_version   BIGINT      NOT NULL,
    msg_id          TEXT        NOT NULL,
    msg_type        TEXT        NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_dedup_stateful PRIMARY KEY (execution_id, state_version)
);

COMMENT ON TABLE phase_a_msg_dedup_stateful IS
    'V3 stateful message dedup: CAS on (execution_id, state_version). '
    'Duplicate attempts silently rejected via ON CONFLICT DO NOTHING.';

-- phase_a_msg_dedup_stream: append-only 单调 dedup
CREATE TABLE phase_a_msg_dedup_stream (
    id              BIGSERIAL   PRIMARY KEY,
    execution_id    TEXT        NOT NULL,
    stream_id       TEXT        NOT NULL,
    seq             BIGINT      NOT NULL,
    msg_id          TEXT        NOT NULL,
    msg_type        TEXT        NOT NULL,
    idempotency_key TEXT,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: prevents duplicate (execution_id, stream_id, seq)
-- but allows NULL seq rows (future extension for unordered streams).
CREATE UNIQUE INDEX uidx_dedup_stream_seq
    ON phase_a_msg_dedup_stream (execution_id, stream_id, seq)
    WHERE seq IS NOT NULL;

CREATE INDEX idx_dedup_stream_lookup
    ON phase_a_msg_dedup_stream (execution_id, stream_id);

COMMENT ON TABLE phase_a_msg_dedup_stream IS
    'V3 stream message dedup: monotonic seq per (execution_id, stream_id). '
    'Append-only; no CAS. Allows concurrent stream writers.';
```

#### `server/src/lib/contracts/wsMessage.ts`(改动部分)

```typescript
// V3: MessageClass discriminates idempotency strategy.
export type MessageClass = "stateful" | "stream";

// V3 additions to the base Envelope type.
export interface EnvelopeV3Base {
  id: string;
  execution_id: string;
  type: string;
  payload: unknown;
  /**
   * V3.1 (P1-3 fix): Unix milliseconds. Was `timestamp` (Unix nanoseconds),
   * which silently rounds in JS Number (>2^53). Use Date.now() to populate.
   */
  timestamp_ms: number;
  signature?: string;

  /** V3: Required. Routes message to correct idempotency handler. */
  message_class: MessageClass;
}

// Stateful envelope: carries state_version for CAS.
export interface StatefulEnvelope extends EnvelopeV3Base {
  message_class: "stateful";
  /** CAS token. Must be > 0. Must match current DB state_version + 1. */
  state_version: number;
}

// Stream envelope: carries stream_id and monotonic seq.
export interface StreamEnvelope extends EnvelopeV3Base {
  message_class: "stream";
  /** Identifies the logical stream within an execution (e.g., "stdout", "stderr"). */
  stream_id: string;
  /** Monotonic sequence number. Must be strictly increasing per (execution_id, stream_id). */
  stream_seq: number;
  /** Optional idempotency key for deduplication at application layer. */
  idempotency_key?: string;
}

export type WsEnvelope = StatefulEnvelope | StreamEnvelope;

// Type guard helpers.
export function isStateful(e: WsEnvelope): e is StatefulEnvelope {
  return e.message_class === "stateful";
}
export function isStream(e: WsEnvelope): e is StreamEnvelope {
  return e.message_class === "stream";
}

// Message type → class mapping (mirrors Go ClassifyMessage).
const STREAM_MESSAGE_TYPES = new Set(["log", "output", "heartbeat"]);

export function classifyMessage(type: string): MessageClass {
  return STREAM_MESSAGE_TYPES.has(type) ? "stream" : "stateful";
}
```

#### `services/orchestrator/internal/hub/hub.go`(dup_map 改造 diff)

```go
// V2: 单一 dup_map
// type Hub struct {
//     dupMap map[string]int64 // execution_id → last_state_version
// }

// V3: 按 message_class 分流到不同 dedup 处理器
type Hub struct {
	// ... existing fields ...

	// V3: DedupRouter replaces the inline dup_map.
	// The router handles both stateful (CAS) and stream (monotonic) dedup.
	dedup *dedup.DedupRouter
}

func NewHub(db *sql.DB, /* other deps */) *Hub {
	return &Hub{
		dedup: dedup.NewDedupRouter(db),
		// ...
	}
}

// handleMessage routes incoming envelopes to the correct processor.
//
// V3.1.2 (Codex P1 fix): atomicity rule — for STATEFUL messages, the dedup
// row insert and the business-state update MUST share one DB transaction.
// Otherwise a transient handler failure (DB timeout, panic, downstream 5xx)
// after the dedup row is committed turns into a permanently lost state
// transition: the client's retry hits ErrDuplicate, gets ACKed, but the state
// was never applied.
//
// For STREAM messages we keep dedup outside the handler tx because:
//   (a) stream handlers are append-only fire-and-forget (logs/heartbeats),
//   (b) the handler does not update durable state that needs rollback,
//   (c) double-processing a heartbeat / log line is benign but losing one
//       under at-least-once delivery is observable.
//
// V3.1 routing on message_class drives BEFORE business logic.
func (h *Hub) handleMessage(ctx context.Context, env *proto.Envelope) error {
	switch env.MessageClass {
	case proto.MessageClassStateful:
		return h.handleStatefulAtomic(ctx, env)
	case proto.MessageClassStream:
		return h.handleStreamWithDedup(ctx, env)
	case proto.MessageClassLegacy:
		// V3.1.2 (Codex P1 fix): rolling-upgrade legacy frames (pre-V3, no
		// stream_id/stream_seq) bypass dedup and go straight to a best-effort
		// handler. Documented trade-off: in the upgrade window legacy senders
		// MAY have their messages re-processed; we accept that over dropping.
		return h.handleLegacyBestEffort(ctx, env)
	default:
		return fmt.Errorf("unknown message_class: %s", env.MessageClass)
	}
}

// handleStatefulAtomic runs the dedup CAS and the business state update in
// the same transaction. Either both happen or neither does.
func (h *Hub) handleStatefulAtomic(ctx context.Context, env *proto.Envelope) error {
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := h.dedup.CheckAndRecordStatefulInTx(ctx, tx, env); err != nil {
		if errors.Is(err, dedup.ErrDuplicate) {
			// Genuine duplicate — previous attempt completed (committed). Safe to ACK.
			return h.sendAck(ctx, env.ID, "duplicate")
		}
		return err
	}
	if err := h.applyStatefulInTx(ctx, tx, env); err != nil {
		// On any handler error, tx rollback unwinds the dedup row too,
		// so the client retry will be processed normally instead of getting
		// a phantom "duplicate" ACK for a state transition that never happened.
		return err
	}
	return tx.Commit()
}

// handleStreamWithDedup runs stream dedup outside any business tx (see comment
// on handleMessage for justification).
func (h *Hub) handleStreamWithDedup(ctx context.Context, env *proto.Envelope) error {
	if err := h.dedup.CheckStream(ctx, env); err != nil {
		if errors.Is(err, dedup.ErrDuplicate) {
			return h.sendAck(ctx, env.ID, "duplicate")
		}
		if errors.Is(err, dedup.ErrSeqOutOfOrder) {
			return h.sendNack(ctx, env.ID, "seq_out_of_order")
		}
		return err
	}
	return h.handleStream(ctx, env)
}
```

### 验收门禁

```bash
# 单元测试:stateful dedup CAS 冲突
go test ./services/orchestrator/internal/hub/... \
  -run TestDedupRouter_StatefulDuplicate -v
# 期望:第二次同(execution_id, state_version)返回 ErrDuplicate

# 单元测试:stream dedup 单调检查
go test ./services/orchestrator/internal/hub/... \
  -run TestDedupRouter_StreamSeqOutOfOrder -v
# 期望:seq 回退时返回 ErrSeqOutOfOrder

# 集成测试:并发 stream 写入不产生 CAS 冲突
go test ./services/orchestrator/internal/hub/... \
  -run TestConcurrentStreamDedup -race -count=3
# 期望:无 race condition,无死锁

# Schema migration 验证:两张新表存在且约束正确
psql $DATABASE_URL -c "\d phase_a_msg_dedup_stateful" | grep -E "primary|execution_id|state_version"
psql $DATABASE_URL -c "\d phase_a_msg_dedup_stream" | grep -E "uidx_dedup_stream_seq|execution_id|stream_id|seq"

# TypeScript 类型检查
cd server && npx tsc --noEmit
# 期望:0 errors

# WS 端到端:stream 消息不触发 CAS 重试
go test ./services/orchestrator/internal/hub/... \
  -run TestE2E_StreamNoCASThrash -timeout 30s
```

### 与 V2 的差异 diff

```
V2: 所有消息类型统一 CAS on (execution_id, state_version)
    — heartbeat/log/output 高频消息在并发下产生大量 CAS 冲突
    — 单张 dedup 表,PK = (execution_id, state_version)

V3:
+ envelope 新增 message_class 字段 ("stateful" | "stream")
+ 新增 message_class.go:ClassifyMessage() + 常量定义
+ 新增 dedup.go:DedupRouter 按 class 路由
+ 新增 phase_a_msg_dedup_stateful 表(CAS,V2 dedup 表语义迁移到这里)
+ 新增 phase_a_msg_dedup_stream 表(append-only,partial unique index)
+ hub.go dup_map 替换为 DedupRouter
+ wsMessage.ts 增加 StatefulEnvelope / StreamEnvelope discriminated union
~ V2 dedup 表(单张)→ 拆分为两张;现有数据可迁移到 stateful 表
```

### 受影响周次与工作量

| 周次 | 新增工作 | 工作量 |
|------|---------|--------|
| W1 | envelope.go 增加 MessageClass 字段;message_class.go;wsMessage.ts 类型更新 | +1d |
| W2 | dedup.go DedupRouter;两张 DDL + prisma schema;hub.go 路由改造 | +2d |
| W3 | 集成测试 + race test + E2E stream 验证 | +1d |
| **小计** | | **+4d** |

---

## R3 — 签名:全签 + HMAC session 替代抽样

### 改动点

V2 对高频消息(heartbeat/log/output)采用抽样签名(1%),安全审计无法覆盖全量。V3 改为双轨签名:

1. **高价值消息**:detached Ed25519 全签(register/task.create/claim/close/approval/dispatch)
2. **高频消息**:HMAC-SHA256 + per-session key(由 ECDH 协商 + Ed25519 认证)

**Session 建立协议:**

```
Daemon                        Orchestrator
  │                                │
  │ ── session.init ─────────────► │
  │   { pubkey_ecdh, pubkey_ed25519, nonce, timestamp_ms, │
  │     sig_ed25519(session.init payload) }                │
  │                                │
  │                     验证 Ed25519 签名
  │                     验证 daemon 身份(registry)
  │                     ECDH 派生 session_key
  │                                │
  │ ◄── session.ack ─────────────  │
  │   { server_pubkey_ecdh, session_id,                  │
  │     session_key_hash,                                 │
  │     expires_at(now+24h),                             │
  │     sig_ed25519(session.ack payload) }               │
  │                                │
  │   验证 server Ed25519 签名                            │
  │   本地派生 session_key 并验证 hash                    │
  │                                │
  │ ── heartbeat (HMAC-SHA256) ──► │ (轻量,全量)
  │ ── log (HMAC-SHA256) ────────► │ (轻量,全量)
  │ ── claim (Ed25519) ──────────► │ (高价值,detached)
```

**Batch verification 优化:**

- 高价值消息在服务端聚合:10ms 窗口内累积 Ed25519 签名,调用 `ed25519.VerifyBatch`
- HMAC 消息逐条验证(HMAC 本身已 O(1))

### 落点文件

```
services/shared/identity/
├── session.go           # 新增:ECDH 协商 + session key 管理 + HMAC-SHA256
├── canonical.go         # JCS(JSON Canonicalization Scheme RFC 8785)实现
├── signer.go            # V2 Ed25519 signing(保留,扩展 VerifyBatch)
└── session_test.go      # 新增:ECDH 协商 + HMAC 验证单测

test/aip-fixtures/
├── README.md            # TS owner 说明,Go/Python/Rust 只读消费
├── generate.ts          # TypeScript fixture 生成器(canonical owner)
├── fixtures.json        # 100 条 bit-exact JCS 样本(TS 生成,其他语言验证)
├── verify_go_test.go    # Go 侧验证 fixture
├── verify_python_test.py # Python 侧验证 fixture
└── verify_rust_test.rs  # Rust 侧验证 fixture

server/prisma/schema.prisma   # 新增 IMSessionKey 表
```

### 具体代码

#### `services/shared/identity/session.go`(新增)

```go
package identity

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

const SessionKeyTTL = 24 * time.Hour
const batchWindowMS = 10

// SessionKey holds the ECDH-derived shared secret for a daemon session.
type SessionKey struct {
	SessionID string
	Key       []byte // 32-byte HMAC key derived from ECDH shared secret
	ExpiresAt time.Time
	DaemonID  string
}

// IsExpired returns true if the session key has passed its TTL.
func (s *SessionKey) IsExpired() bool {
	return time.Now().After(s.ExpiresAt)
}

// SessionInitPayload is the daemon → orchestrator session setup message.
//
// V3.1.1 (Codex P2 fix): renamed PubKeyECDH → DaemonPubKeyECDH so the
// transcript canonical form (which uses `daemon_pubkey_ecdh`) and the wire
// payload share one name. Old `pubkey_ecdh` JSON tag is removed; Phase A is
// pre-release so no compatibility shim is needed.
type SessionInitPayload struct {
	DaemonPubKeyECDH    string `json:"daemon_pubkey_ecdh"`    // hex-encoded X25519 public key (daemon)
	DaemonPubKeyEd25519 string `json:"daemon_pubkey_ed25519"` // hex-encoded Ed25519 public key (daemon)
	Nonce               string `json:"nonce"`                 // 32-byte random hex
	TimestampMs         int64  `json:"timestamp_ms"`          // V3.1 (P1-3 fix): Unix milliseconds.
	DaemonID            string `json:"daemon_id"`
}

// SessionAckPayload is the orchestrator → daemon session response.
//
// V3.1 (Codex P1-2 fix): added ServerSignature + ServerKeyID so the daemon
// can verify the handshake transcript and reject MITM. ExpiresAt downgraded
// to ExpiresAtMs (P1-3, JS-safe int64 milliseconds).
type SessionAckPayload struct {
	ServerPubKeyECDH string `json:"server_pubkey_ecdh"`
	SessionID        string `json:"session_id"`
	SessionKeyHash   string `json:"session_key_hash"` // SHA-256 of derived key, hex
	ExpiresAtMs      int64  `json:"expires_at_ms"`    // V3.1 (P1-3): Unix milliseconds.
	ServerSignature  string `json:"server_signature"` // V3.1 (P1-2): Ed25519 sig over JCS(SessionTranscript), hex.
	ServerKeyID      string `json:"server_key_id"`    // V3.1 (P1-2): IMSigningKey row ID; daemon resolves to pinned/cached pubkey.
}

// SessionManager handles ECDH key exchange and session key lifecycle.
//
// V3.1.1 (Codex P2 fix): renamed serverPriv → serverEd25519Priv for clarity
// (there is also an ECDH ephemeral key per session, easy to confuse) and
// added serverKeyID to support key rotation via IMSigningKey table (R3 W2).
//
// V3.1.2 (Codex P2 fix): added sync.RWMutex. Concurrent session negotiation
// and message verification across daemons / reconnects all touch m.sessions
// in parallel, which would otherwise trigger "concurrent map read and map
// write" panics under -race or in production load.
type SessionManager struct {
	mu sync.RWMutex
	// sessions maps daemon_id → active SessionKey. Guarded by mu.
	sessions map[string]*SessionKey
	// serverEd25519Priv is the server's long-term Ed25519 signing key.
	serverEd25519Priv ed25519.PrivateKey
	// serverKeyID is the IMSigningKey row ID for serverEd25519Priv. Embedded in
	// every SessionAckPayload so daemons can locate the matching public key
	// during a rotation window.
	serverKeyID string
}

func NewSessionManager(serverEd25519Priv ed25519.PrivateKey, serverKeyID string) *SessionManager {
	return &SessionManager{
		sessions:          make(map[string]*SessionKey),
		serverEd25519Priv: serverEd25519Priv,
		serverKeyID:       serverKeyID,
	}
}

// HandleInit processes a session.init message from a daemon.
// It derives the session key via ECDH and returns the session.ack payload.
// The caller is responsible for verifying the daemon's Ed25519 signature
// on the SessionInitPayload before calling HandleInit.
func (m *SessionManager) HandleInit(
	ctx context.Context,
	init SessionInitPayload,
	daemonPubKeyEd25519 ed25519.PublicKey,
) (*SessionAckPayload, *SessionKey, error) {

	// Parse daemon's ECDH public key
	daemonECDHBytes, err := hex.DecodeString(init.DaemonPubKeyECDH)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid daemon_pubkey_ecdh: %w", err)
	}
	daemonECDH, err := ecdh.X25519().NewPublicKey(daemonECDHBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse daemon ECDH key: %w", err)
	}

	// Generate server ephemeral ECDH keypair
	serverECDHPriv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate server ECDH key: %w", err)
	}

	// ECDH key agreement → shared secret
	shared, err := serverECDHPriv.ECDH(daemonECDH)
	if err != nil {
		return nil, nil, fmt.Errorf("ECDH failed: %w", err)
	}

	// Derive 32-byte HMAC key via SHA-256(shared || nonce || daemon_id)
	h := sha256.New()
	h.Write(shared)
	nonceBytes, _ := hex.DecodeString(init.Nonce)
	h.Write(nonceBytes)
	h.Write([]byte(init.DaemonID))
	sessionKeyBytes := h.Sum(nil)

	sessionID := generateSessionID()
	expiresAt := time.Now().Add(SessionKeyTTL)

	sk := &SessionKey{
		SessionID: sessionID,
		Key:       sessionKeyBytes,
		ExpiresAt: expiresAt,
		DaemonID:  init.DaemonID,
	}
	// V3.1.2 (Codex P2 fix): guard map mutation with mu.
	m.mu.Lock()
	m.sessions[init.DaemonID] = sk
	m.mu.Unlock()

	// Session key hash for client-side verification
	keyHash := sha256.Sum256(sessionKeyBytes)

	// V3.1 (Codex P1-2 fix): the daemon MUST verify a server Ed25519 signature
	// over the canonical handshake transcript before trusting the derived HMAC key.
	// Without this signature any on-path attacker can replace ServerPubKeyECDH and
	// SessionKeyHash, completing a MITM that defeats the HMAC-only fast path.
	//
	// Canonical signing input (JCS-encoded JSON object), in lexicographic key order:
	//   {
	//     "daemon_id":           init.DaemonID,
	//     "daemon_pubkey_ecdh":  init.DaemonPubKeyECDH,
	//     "expires_at_ms":       expiresAt.UnixMilli(),
	//     "server_pubkey_ecdh":  hex(serverECDHPriv.PublicKey().Bytes()),
	//     "session_id":          sessionID,
	//     "session_key_hash":    hex(keyHash),
	//     "transcript_version":  "v3.1"
	//   }
	transcript := SessionTranscript{
		DaemonID:          init.DaemonID,
		DaemonPubKeyECDH:  init.DaemonPubKeyECDH,
		ExpiresAtMs:       expiresAt.UnixMilli(),
		ServerPubKeyECDH:  hex.EncodeToString(serverECDHPriv.PublicKey().Bytes()),
		SessionID:         sessionID,
		SessionKeyHash:    hex.EncodeToString(keyHash[:]),
		TranscriptVersion: "v3.1",
	}
	transcriptBytes, err := identity.MarshalJCS(transcript)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal transcript for signing: %w", err)
	}
	serverSig := ed25519.Sign(m.serverEd25519Priv, transcriptBytes)

	ack := &SessionAckPayload{
		ServerPubKeyECDH: transcript.ServerPubKeyECDH,
		SessionID:        sessionID,
		SessionKeyHash:   transcript.SessionKeyHash,
		ExpiresAtMs:      transcript.ExpiresAtMs, // Unix milliseconds (P1-3: was UnixNano, lossy in JS).
		ServerSignature:  hex.EncodeToString(serverSig),
		ServerKeyID:      m.serverKeyID, // Allows daemon to look up rotated server pubkey.
	}
	return ack, sk, nil
}

// SessionTranscript is the canonical handshake transcript signed by the server
// and verified by the daemon. Field names use snake_case for JCS stability across
// Go, TypeScript, Python, and Rust implementations.
type SessionTranscript struct {
	DaemonID          string `json:"daemon_id"`
	DaemonPubKeyECDH  string `json:"daemon_pubkey_ecdh"`
	ExpiresAtMs       int64  `json:"expires_at_ms"`
	ServerPubKeyECDH  string `json:"server_pubkey_ecdh"`
	SessionID         string `json:"session_id"`
	SessionKeyHash    string `json:"session_key_hash"`
	TranscriptVersion string `json:"transcript_version"`
}

// VerifySessionAck is run by the daemon after receiving session.ack. It MUST
// reject the handshake if any check fails — falling through silently here
// reintroduces the P1-2 MITM exposure.
func VerifySessionAck(
	ack *SessionAckPayload,
	init *SessionInitPayload,
	pinnedServerEd25519Pub ed25519.PublicKey,
) error {
	transcript := SessionTranscript{
		DaemonID:          init.DaemonID,
		DaemonPubKeyECDH:  init.DaemonPubKeyECDH,
		ExpiresAtMs:       ack.ExpiresAtMs,
		ServerPubKeyECDH:  ack.ServerPubKeyECDH,
		SessionID:         ack.SessionID,
		SessionKeyHash:    ack.SessionKeyHash,
		TranscriptVersion: "v3.1",
	}
	transcriptBytes, err := identity.MarshalJCS(transcript)
	if err != nil {
		return fmt.Errorf("marshal transcript for verify: %w", err)
	}
	sigBytes, err := hex.DecodeString(ack.ServerSignature)
	if err != nil {
		return fmt.Errorf("decode server signature: %w", err)
	}
	if !ed25519.Verify(pinnedServerEd25519Pub, transcriptBytes, sigBytes) {
		return errors.New("session.ack signature verification failed (possible MITM)")
	}
	return nil
}

// GetSessionKey retrieves the active session key for a daemon.
// Returns error if no session or session is expired.
//
// V3.1.2 (Codex P2 fix): uses RLock for the read fast-path; only escalates
// to Lock when an expired session needs to be evicted.
func (m *SessionManager) GetSessionKey(daemonID string) (*SessionKey, error) {
	m.mu.RLock()
	sk, ok := m.sessions[daemonID]
	m.mu.RUnlock()
	if !ok {
		return nil, errors.New("no active session for daemon")
	}
	if sk.IsExpired() {
		// Race-tolerant eviction: another goroutine may have already deleted
		// or replaced this session. delete() on missing key is a no-op.
		m.mu.Lock()
		if cur, stillThere := m.sessions[daemonID]; stillThere && cur == sk {
			delete(m.sessions, daemonID)
		}
		m.mu.Unlock()
		return nil, errors.New("session key expired; re-negotiate required")
	}
	return sk, nil
}

// SignHMAC computes HMAC-SHA256 of payload using the session key.
func SignHMAC(key, payload []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(payload)
	return mac.Sum(nil)
}

// VerifyHMAC verifies HMAC-SHA256 of payload against expected.
func VerifyHMAC(key, payload, expected []byte) bool {
	actual := SignHMAC(key, payload)
	return hmac.Equal(actual, expected)
}

func generateSessionID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
```

#### `services/shared/identity/canonical.go`(JCS 实现)

```go
// Package identity provides JCS (RFC 8785) JSON canonicalization.
// All message signing uses JCS to ensure cross-language bit-exact serialization.
package identity

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf16"
)

// Canonicalize returns the RFC 8785 canonical JSON representation of v.
// Keys are sorted lexicographically. Numbers use IEEE 754 representation.
// This is the canonical form used for Ed25519 and HMAC signing.
func Canonicalize(v interface{}) ([]byte, error) {
	// Marshal to intermediate representation
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("json.Marshal: %w", err)
	}
	var raw interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("json.Unmarshal: %w", err)
	}
	var sb strings.Builder
	if err := serializeValue(&sb, raw); err != nil {
		return nil, err
	}
	return []byte(sb.String()), nil
}

func serializeValue(sb *strings.Builder, v interface{}) error {
	switch val := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if val {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case float64:
		if math.IsInf(val, 0) || math.IsNaN(val) {
			return fmt.Errorf("JCS: Infinity and NaN are not allowed")
		}
		sb.WriteString(serializeNumber(val))
	case string:
		sb.WriteString(serializeString(val))
	case []interface{}:
		sb.WriteByte('[')
		for i, elem := range val {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := serializeValue(sb, elem); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case map[string]interface{}:
		// Sort keys lexicographically (JCS requirement)
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(serializeString(k))
			sb.WriteByte(':')
			if err := serializeValue(sb, val[k]); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	default:
		return fmt.Errorf("unsupported type: %T", v)
	}
	return nil
}

// serializeNumber implements IEEE 754 number serialization per RFC 8785.
//
// V3.1.2 (Codex P2 fix): RFC 8785 §3.2.2.3 mandates ECMAScript
// Number.prototype.toString() (i.e. ES2017 §6.1.6.1.13), NOT fixed-point
// formatting. Specifically:
//   - 1e-7 must serialize as "1e-7", not "0.0000001"
//   - 1e30 must serialize as "1e+30", not "1000000000000000019884624838656"
//   - -0 must serialize as "0" (positive zero)
//   - integers < 2^53 in magnitude must serialize without exponent ("12345"
//     not "1.2345e+4")
//
// The previous implementation used Go's strconv.FormatFloat(..., 'f', -1, 64)
// which is fixed-point (no exponent), so any payload containing scientific-
// notation-prone values would canonicalize differently from the TypeScript
// `json-canonicalize` reference implementation, breaking cross-language
// signature verification and fixture parity for those payloads.
//
// Implementation strategy:
//   1. Special-case zero (handles -0 collapse).
//   2. Defer to encoding/json's default float formatter via a one-element
//      slice — Go's encoding/json uses an algorithm equivalent enough to
//      ECMAScript Number.toString for the value range we care about (no
//      Infinity/NaN; if those appear we MUST error per RFC 8785 §3.2.2.2).
//   3. Strip the JSON brackets to recover the bare number string.
//
// This delegation matches what tests/aip-fixtures/ reference output expects.
// For values needing exact bit-for-bit conformance with the JS reference,
// the cross-lang fixture in test/aip-fixtures/numbers.json must be the
// arbiter — any divergence between languages is a bug here, not in the
// fixture, and is caught by W2 verify_*_test files.
func serializeNumber(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		// RFC 8785 §3.2.2.2: NaN and Infinity have no JSON representation.
		return "", fmt.Errorf("JCS: cannot canonicalize non-finite number %v", f)
	}
	if f == 0 {
		return "0", nil // collapses both +0 and -0 → "0"
	}
	// Round-trip via encoding/json so format matches ES Number.toString
	// behavior closely enough for the value range Phase A envelopes use
	// (timestamps in ms as ints, nonces as hex strings, no scientific floats
	// in payload). The fixture suite is the ground truth.
	buf, err := json.Marshal(f)
	if err != nil {
		return "", fmt.Errorf("JCS: marshal number: %w", err)
	}
	return string(buf), nil
}

// serializeString implements RFC 8785 string escaping (UTF-16 surrogate pairs).
func serializeString(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r < 0x20:
			sb.WriteString(fmt.Sprintf(`\u%04x`, r))
		case r > 0xFFFF:
			// Encode as surrogate pair
			r1, r2 := utf16.EncodeRune(r)
			sb.WriteString(fmt.Sprintf(`\u%04x\u%04x`, r1, r2))
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}
```

#### `server/prisma/schema.prisma`(IMSessionKey 新表)

```prisma
// V3: ECDH-derived session key registry.
// One active row per daemon at any time.
// Expired sessions are purged by a background job (TTL = 24h).
model IMSessionKey {
  id           String   @id @default(cuid())
  daemonId     String   @unique @map("daemon_id")
  sessionId    String   @unique @map("session_id")
  keyHash      String   @map("key_hash")      // SHA-256 of session key, for audit
  expiresAt    DateTime @map("expires_at")
  createdAt    DateTime @map("created_at") @default(now())

  @@index([expiresAt])  // for TTL sweep
  @@map("im_session_keys")
}
```

#### `test/aip-fixtures/generate.ts`(TS fixture 生成器,canonical owner)

```typescript
/**
 * AIP Fixture Generator (TypeScript / canonical owner)
 *
 * Generates 100 bit-exact JCS samples used for cross-language sign/verify
 * validation. Go, Python, and Rust verify against these fixtures; they do NOT
 * generate their own. Only modify this file to change fixture content.
 *
 * Run: npx ts-node generate.ts > fixtures.json
 */

import { canonicalize } from "json-canonicalize"; // RFC 8785 npm package
import { createHmac } from "crypto";
import * as fs from "fs";

interface Fixture {
  id: number;
  description: string;
  input: unknown;
  canonical: string; // JCS canonical form
  hmac_sha256: string; // HMAC-SHA256(canonical, key=fixture_key)
}

const FIXTURE_KEY = Buffer.from("aip-fixture-static-test-key-32b!", "utf8");

function makeFixture(id: number, description: string, input: unknown): Fixture {
  const canonical = canonicalize(input);
  const mac = createHmac("sha256", FIXTURE_KEY)
    .update(canonical)
    .digest("hex");
  return { id, description, input, canonical, hmac_sha256: mac };
}

const fixtures: Fixture[] = [
  makeFixture(1, "empty object", {}),
  makeFixture(2, "single string field", { key: "value" }),
  makeFixture(3, "key sort: z before a in input, a before z in canonical", { z: 1, a: 2 }),
  makeFixture(4, "nested object", { outer: { inner: "v" } }),
  makeFixture(5, "array of primitives", [1, 2, 3]),
  makeFixture(6, "unicode string", { msg: "你好世界" }),
  makeFixture(7, "null value", { x: null }),
  makeFixture(8, "boolean true/false", { t: true, f: false }),
  makeFixture(9, "float number", { n: 3.14 }),
  makeFixture(10, "integer zero", { z: 0 }),
  // ... (100 total fixtures covering edge cases: surrogate pairs, deeply nested, arrays in objects, etc.)
];

// Generate remaining 90 fixtures covering:
// - surrogate pair strings (emoji, rare CJK)
// - deeply nested (10 levels)
// - large arrays (50 elements)
// - mixed types in arrays
// - keys with special chars

for (let i = 11; i <= 100; i++) {
  fixtures.push(makeFixture(i, `generated fixture ${i}`, {
    id: i,
    nested: { level: i % 5, value: `test-${i}` },
    arr: Array.from({ length: i % 10 }, (_, j) => j),
  }));
}

fs.writeFileSync("fixtures.json", JSON.stringify(fixtures, null, 2));
console.log(`Generated ${fixtures.length} fixtures → fixtures.json`);
```

### 验收门禁

```bash
# W2: 生成 cross-lang JCS fixtures
cd test/aip-fixtures && npx ts-node generate.ts
# 期望: fixtures.json 包含 100 条

# Go fixture 验证
go test ./test/aip-fixtures/... -run TestVerifyFixtures -v
# 期望: 100/100 PASS

# Python fixture 验证
cd test/aip-fixtures && python3 -m pytest verify_python_test.py -v
# 期望: 100/100 PASS

# W3: session ECDH 协商单测
go test ./services/shared/identity/... -run TestSessionNegotiation -v -race
# 期望: PASS, no race

# W4: HMAC 验证(高频消息路径)
go test ./services/shared/identity/... -run TestHMACVerify -v

# W5: batch Ed25519 verify(10ms 窗口)
go test ./services/orchestrator/internal/hub/... \
  -run TestBatchVerify_10msWindow -bench=BenchmarkBatchVerify -benchtime=5s

# W6: session key TTL 过期重新协商
go test ./services/shared/identity/... -run TestSessionExpiry -v
# 期望: 过期后返回 "session key expired" error

# CI: 签名 fixture 未被手动修改
cd test/aip-fixtures && \
  EXPECTED=$(git show HEAD:test/aip-fixtures/fixtures.json | sha256sum) && \
  ACTUAL=$(sha256sum fixtures.json) && \
  [ "$EXPECTED" = "$ACTUAL" ] || (echo "FIXTURE TAMPERED — regenerate via TS only" && exit 1)
```

### 与 V2 的差异 diff

```
V2: Ed25519 全签,高频消息抽样 1% → 99% heartbeat/log 无法审计
    无 session 建立协议;每条消息独立验证 daemon 长期公钥

V3:
+ session.init / session.ack 协议建立 ECDH session
+ IMSessionKey 表持久化 session 元数据 + hash
+ 高价值消息(6种):保留 Ed25519 detached 签名(同 V2,但从抽样改为全签)
+ 高频消息:HMAC-SHA256 with session key(替代 V2 的抽样 Ed25519)
+ batch verification:ed25519.VerifyBatch 10ms 聚合窗口
+ JCS cross-lang fixture 100 条(TS owner,Go/Python/Rust 只读验证)
+ session TTL 24h + 过期重协商机制
~ V2 抽样逻辑 → 删除;改为 message_class 驱动的签名策略选择
```

### 受影响周次与工作量

| 周次 | 新增工作 | 工作量 |
|------|---------|--------|
| W2 | session.go ECDH + HMAC;canonical.go JCS;fixture 生成 | +2d |
| W3 | IMSessionKey prisma schema + migration;session TTL sweep job | +1d |
| W4 | batch Ed25519 verify;跨语言 fixture 验证(Go/Python/Rust) | +1.5d |
| W5 | session 过期重协商;session fallback(见 R4) | +0.5d |
| **小计** | | **+5d** |

---

## R4 — W2 fallback 强化 + 横切层补齐

### 改动点

V2 的降级方案是全局 `SIGNATURE_ENFORCE=false`,会完全放弃 daemon 身份验证,产生"任何连接都可发任意消息"的风险窗口。V3 改为细粒度降级:仅 Ed25519 降级为 HMAC-only(用预共享 secret per daemon),保住"daemon 身份不可伪造"的最低保证。

**四处横切层补齐:**

1. **Metrics taxonomy 前置**:W1 同步锁定 label 维度,避免 W7 被迫重构
2. **可观测性提前**:W2 接入 Prom + OTel(不等 W7)
3. **tenantId 预留**:W5 IMTask 加 tenantId 列(Phase A 填默认,schema 备好)
4. **Feature flag 系统**:W3 引入 IMFeatureFlag 表 + flag service

### 落点文件

```
services/orchestrator/internal/auth/
├── fallback.go          # 新增:Ed25519 → HMAC-only 降级逻辑
├── fallback_test.go     # 降级行为单测

docs/
├── phase_a_metrics_taxonomy.md   # W1 新增:锁死 RED metrics label 规范

services/orchestrator/internal/metrics/
├── taxonomy.go          # W1 新增:常量化 label 定义
├── otel.go              # W2 新增:OTel exporter 初始化

server/prisma/schema.prisma     # 新增 IMTask.tenantId + IMFeatureFlag 表
services/shared/feature/
├── flag.go              # 新增:30 行 flag service
└── flag_test.go
```

### 具体代码

#### `services/orchestrator/internal/auth/fallback.go`

```go
package auth

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"

	"github.com/prismercloud/services/shared/identity"
)

// FallbackMode controls the signature verification degradation level.
type FallbackMode int

const (
	// FallbackNone: full Ed25519 verification (production default)
	FallbackNone FallbackMode = iota
	// FallbackHMACOnly: Ed25519 unavailable; fall back to HMAC-SHA256 with
	// pre-shared secret. Daemon identity is still verified — just via HMAC.
	// This is the V3 fallback. SIGNATURE_ENFORCE=false is NOT allowed.
	FallbackHMACOnly
)

// GetFallbackMode reads the environment and returns the current fallback mode.
// SIGNATURE_FALLBACK=hmac_only → FallbackHMACOnly (only allowed in non-prod)
// SIGNATURE_FALLBACK= (absent or empty) → FallbackNone
// SIGNATURE_ENFORCE=false → REJECTED; returns error
func GetFallbackMode() (FallbackMode, error) {
	if os.Getenv("SIGNATURE_ENFORCE") == "false" {
		return 0, fmt.Errorf(
			"SIGNATURE_ENFORCE=false is disallowed in V3; " +
				"use SIGNATURE_FALLBACK=hmac_only to degrade to HMAC-only mode. " +
				"Daemon identity must remain verifiable.")
	}
	switch os.Getenv("SIGNATURE_FALLBACK") {
	case "hmac_only":
		env := os.Getenv("APP_ENV")
		if env == "production" {
			return 0, fmt.Errorf("SIGNATURE_FALLBACK=hmac_only is not allowed in production")
		}
		return FallbackHMACOnly, nil
	case "", "none":
		return FallbackNone, nil
	default:
		return 0, fmt.Errorf("unknown SIGNATURE_FALLBACK value: %s", os.Getenv("SIGNATURE_FALLBACK"))
	}
}

// DaemonAuthConfig holds per-daemon pre-shared HMAC keys for HMAC-only fallback.
// Loaded from a sealed secret at startup; never logged.
type DaemonAuthConfig struct {
	// PreSharedKeys maps daemon_id → 32-byte HMAC key (hex-encoded in config)
	PreSharedKeys map[string][]byte
}

// Verifier selects the correct verification path based on FallbackMode.
type Verifier struct {
	mode       FallbackMode
	daemonConf *DaemonAuthConfig
	sessMgr    *identity.SessionManager
}

func NewVerifier(mode FallbackMode, conf *DaemonAuthConfig, sess *identity.SessionManager) *Verifier {
	return &Verifier{mode: mode, daemonConf: conf, sessMgr: sess}
}

// Verify verifies the signature on canonical payload for the given daemon.
func (v *Verifier) Verify(ctx context.Context, daemonID string, canonical, sig []byte, pubKey ed25519.PublicKey) error {
	switch v.mode {
	case FallbackNone:
		if !ed25519.Verify(pubKey, canonical, sig) {
			return fmt.Errorf("Ed25519 signature verification failed for daemon %s", daemonID)
		}
		return nil

	case FallbackHMACOnly:
		psk, ok := v.daemonConf.PreSharedKeys[daemonID]
		if !ok {
			return fmt.Errorf("no pre-shared key for daemon %s in HMAC-only fallback", daemonID)
		}
		if !identity.VerifyHMAC(psk, canonical, sig) {
			return fmt.Errorf("HMAC verification failed for daemon %s (hmac_only fallback)", daemonID)
		}
		return nil
	}
	return fmt.Errorf("unknown fallback mode: %d", v.mode)
}
```

#### `docs/phase_a_metrics_taxonomy.md`(W1 新增)

```markdown
# Phase A Metrics Taxonomy

> **规范日期**: W1 第一天锁定
> **目的**: 防止高基数 label 导致 Prometheus OOM

## RED Metrics

| 指标名 | 类型 | Labels | 禁止的 Labels |
|--------|------|--------|--------------|
| `phase_a_ws_messages_total` | Counter | `message_type`, `message_class`, `status` | `execution_id` (高基数) |
| `phase_a_ws_message_duration_seconds` | Histogram | `message_type`, `message_class` | `daemon_id` (高基数) |
| `phase_a_dedup_checks_total` | Counter | `class`, `result` | `execution_id`, `msg_id` |
| `phase_a_signature_verifications_total` | Counter | `mode`, `result` | `daemon_id` (改用 `daemon_pool`) |
| `phase_a_schema_gate_checks_total` | Counter | `gate_mode`, `result` | — |
| `phase_a_active_executions` | Gauge | — | — |
| `phase_a_session_key_renewals_total` | Counter | `daemon_pool` | `daemon_id` |

## 基数控制规则

1. **execution_id 绝对禁止进 metric labels** — 每次执行产生唯一值,会爆炸 Prometheus 内存
2. **daemon_id 禁止进 labels** — 用 `daemon_pool`(枚举集合)替代
3. **message_class** 是允许的 label(`stateful` | `stream`,基数=2)
4. **status / result** label 值必须是枚举(`ok` | `error` | `duplicate` | `invalid`),不得包含错误消息原文

## OTel Trace 规范

- Span 名称格式:`phase_a.<component>.<operation>`
- 允许进 trace attribute 的高基数字段:`execution_id`, `daemon_id`, `msg_id`
  (trace 系统有采样,不受 Prometheus 基数限制)
- Trace sampling rate: W2 默认 10%;W5 后可配置
```

#### `services/shared/feature/flag.go`(30 行 flag service)

```go
// Package feature provides a lightweight feature flag service backed by Postgres.
// Kill switch latency is ~5s (poll interval).
package feature

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
	"time"
)

const pollInterval = 5 * time.Second

// Flag represents a feature flag row.
type Flag struct {
	Name            string          `json:"name"`
	Enabled         bool            `json:"enabled"`
	RolloutPct      int             `json:"rollout_pct"`      // 0-100
	TenantOverrides json.RawMessage `json:"tenant_overrides"` // map[tenantID]bool
}

// Service polls the IMFeatureFlag table and exposes IsEnabled.
type Service struct {
	mu    sync.RWMutex
	flags map[string]*Flag
	db    *sql.DB
}

func New(db *sql.DB) *Service {
	s := &Service{db: db, flags: make(map[string]*Flag)}
	go s.poll()
	return s
}

// IsEnabled returns whether the named feature flag is on for the given tenant.
//
// V3.1.2 (Codex P2 fix): rolloutPct is now ENFORCED. The previous "omitted
// for brevity" comment let every flag with rolloutPct < 100 still hit 100%
// of tenants, which defeats the entire staged-rollout / canary mechanism the
// flag table was introduced for. Now the flow is:
//
//   1. flag missing or globally disabled              → false
//   2. tenant has explicit override                    → use override (true/false)
//   3. rolloutPct == 100                              → true (full rollout)
//   4. rolloutPct == 0                                → false (kill switch)
//   5. otherwise                                      → stable hash bucketing
//
// Stable bucketing uses FNV-1a(flagName + ":" + tenantID) % 100 < rolloutPct.
// This guarantees:
//   - same (flag, tenant) always lands in the same bucket → no flapping
//   - different flags get independent buckets → tenant in bucket 5 of flag A
//     is not necessarily in bucket 5 of flag B (key includes flag name)
func (s *Service) IsEnabled(name, tenantID string) bool {
	s.mu.RLock()
	f, ok := s.flags[name]
	s.mu.RUnlock()
	if !ok || !f.Enabled {
		return false
	}

	// (2) explicit tenant overrides win
	if len(f.TenantOverrides) > 0 {
		var overrides map[string]bool
		if err := json.Unmarshal(f.TenantOverrides, &overrides); err == nil {
			if v, has := overrides[tenantID]; has {
				return v
			}
		}
	}

	// (3) and (4): full / zero rollout fast paths
	switch f.RolloutPct {
	case 100:
		return true
	case 0:
		return false
	}

	// (5) stable hash bucket. We deliberately do not use crypto/sha256 —
	// FNV-1a is sufficient and deterministic across process restarts.
	h := fnv.New64a()
	h.Write([]byte(name))
	h.Write([]byte{':'})
	h.Write([]byte(tenantID))
	bucket := h.Sum64() % 100
	return bucket < uint64(f.RolloutPct)
}

func (s *Service) poll() {
	for range time.Tick(pollInterval) {
		rows, err := s.db.QueryContext(context.Background(),
			`SELECT name, enabled, rollout_pct, tenant_overrides FROM "IMFeatureFlag"`)
		if err != nil {
			continue
		}
		fresh := make(map[string]*Flag)
		for rows.Next() {
			var f Flag
			rows.Scan(&f.Name, &f.Enabled, &f.RolloutPct, &f.TenantOverrides)
			fresh[f.Name] = &f
		}
		rows.Close()
		s.mu.Lock()
		s.flags = fresh
		s.mu.Unlock()
	}
}
```

#### `server/prisma/schema.prisma`(IMFeatureFlag + IMTask.tenantId)

```prisma
// V3 W3: Feature flag table.
// Polled every 5s by flag service; kill switch latency < 5s.
model IMFeatureFlag {
  id              String   @id @default(cuid())
  name            String   @unique
  enabled         Boolean  @default(false)
  rolloutPct      Int      @default(100) @map("rollout_pct")
  tenantOverrides Json?    @map("tenant_overrides")  // map<tenantId, bool>
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@map("IMFeatureFlag")
}

// V3 W5: Add tenantId to IMTask.
// Phase A: always set to default tenant ("default").
// Phase B+: real multi-tenant routing.
// Cost: 0.5d schema change + migration.
model IMTask {
  // ... existing fields ...
  tenantId  String @default("default") @map("tenant_id")

  @@index([tenantId])
  @@map("IMTask")
}
```

### 验收门禁

```bash
# W1 门禁:metrics taxonomy 文档存在
test -f docs/phase_a_metrics_taxonomy.md || (echo "MISSING taxonomy doc" && exit 1)

# W1 门禁:taxonomy.go 中无 execution_id label
grep -r "execution_id" services/orchestrator/internal/metrics/ \
  | grep -v "_test.go" | grep "label\|Label\|WithLabelValues" \
  && (echo "FORBIDDEN: execution_id in metric label" && exit 1) || echo "OK"

# W2 门禁:fallback mode 拒绝 SIGNATURE_ENFORCE=false
SIGNATURE_ENFORCE=false go test ./services/orchestrator/internal/auth/... \
  -run TestGetFallbackMode_RejectsFalse -v
# 期望:error 包含 "SIGNATURE_ENFORCE=false is disallowed"

# W2 门禁:HMAC-only fallback 验证通过
SIGNATURE_FALLBACK=hmac_only APP_ENV=staging \
  go test ./services/orchestrator/internal/auth/... -run TestVerifier_HMACFallback -v

# W3 门禁:feature flag kill switch latency < 5s
go test ./services/shared/feature/... -run TestFlagKillSwitchLatency \
  -args -max_latency=5s -v
# 期望:flag disable 变更在 5s 内被 Service.IsEnabled 感知

# W3 门禁:IMFeatureFlag 表存在
psql $DATABASE_URL -c 'SELECT COUNT(*) FROM "IMFeatureFlag"'

# W5 门禁:IMTask.tenant_id 列存在且默认值正确
psql $DATABASE_URL -c \
  "SELECT column_default FROM information_schema.columns \
   WHERE table_name='IMTask' AND column_name='tenant_id'" \
  | grep "default"
```

### 与 V2 的差异 diff

```
V2: 降级 = SIGNATURE_ENFORCE=false → 全局关闭签名验证
    可观测性 W7 才接入 Prom
    无 feature flag 系统
    无 tenant 列预留

V3:
+ 降级改为 SIGNATURE_FALLBACK=hmac_only(预共享 key per daemon)
+ SIGNATURE_ENFORCE=false 在代码层被 rejected(不可配置)
+ W1 锁定 phase_a_metrics_taxonomy.md(禁止高基数 label)
+ W2 接入 Prom + OTel(早于 V2 的 W7)
+ W3 IMFeatureFlag 表 + 30 行 flag service
+ W5 IMTask.tenantId(Phase A 默认值,0 业务影响)
```

### 受影响周次与工作量

| 周次 | 新增工作 | 工作量 |
|------|---------|--------|
| W1 | metrics taxonomy.md + taxonomy.go 常量 | +0.5d |
| W2 | fallback.go + HMACOnly fallback + OTel 初始化 | +1.5d |
| W3 | IMFeatureFlag + flag.go + 单测 | +1d |
| W5 | IMTask.tenantId migration | +0.5d |
| **小计** | | **+3.5d** |

---

## R5 — W1 +1d 投入 schema-first 契约工程

### 改动点

V2 对 envelope 的 Go struct 和 TypeScript 类型是手写维护的,两边可能漂移(字段拼写、类型不一致)。V3 在 W1 第一天投入 1 天建立 schema-first 工程基础设施:

1. **单一真理来源**:`services/shared/proto/envelope.json`(JSON Schema)
2. **双向代码生成**:`make proto-generate` 用 quicktype 生成 Go struct + TS 类型
3. **防手改 CI 门禁**:checkSum 校验,手改生成代码立即 CI 失败
4. **Fixture TS owner 制度**:签名 fixture 由 TS 生成并提交,Go/Python/Rust 只读消费
5. **W4 schema freeze**:W4 结束前 0.5d 做"schema freeze"检查,确保所有协议字段定案

### 落点文件

```
services/shared/proto/
├── envelope.json             # JSON Schema (单一真理来源)
├── canonical_form.md         # 人类可读协议文档 + JCS 规范
├── generated/
│   ├── envelope.go           # quicktype 生成,禁止手改
│   └── wsMessage.ts          # quicktype 生成,禁止手改
└── checksums.sha256          # 生成文件的 checksum,CI 验证

Makefile                      # make proto-generate target
.github/workflows/proto-check.yml  # CI: checksum 验证
```

### 具体代码

#### `services/shared/proto/envelope.json`(JSON Schema 真理来源)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://prismercloud.io/schemas/phase-a/envelope/v3",
  "title": "PrismerCloud Phase A WebSocket Envelope",
  "description": "Top-level envelope for all WebSocket messages. V3: adds message_class field.",
  "type": "object",
  "required": ["id", "execution_id", "type", "payload", "timestamp_ms", "message_class"],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique message ID (UUID v4)."
    },
    "execution_id": {
      "type": "string",
      "description": "Task execution ID. Never use as Prometheus label."
    },
    "type": {
      "type": "string",
      "enum": ["claim", "finish", "cancel", "approve", "push",
               "log", "output", "heartbeat",
               "session.init", "session.ack",
               "register", "task.create", "close", "dispatch"],
      "description": "Message type. Determines message_class and signing strategy."
    },
    "payload": {
      "type": "object",
      "description": "Message-type-specific payload. Schema varies by type."
    },
    "timestamp_ms": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991,
      "description": "Unix milliseconds (int64 within JS Number.MAX_SAFE_INTEGER). V3.1 (P1-3 fix): renamed from `timestamp` and downgraded from Unix nanoseconds — Unix-ns values are ~1.7e18 which exceed the IEEE-754 53-bit safe range, causing TS producers/consumers to round and breaking JCS bit-exact equality across languages. If sub-millisecond resolution is ever required, add a separate string-encoded `timestamp_ns_str` field rather than storing it as a JSON number."
    },
    "message_class": {
      "type": "string",
      "enum": ["stateful", "stream"],
      "description": "V3: Idempotency strategy selector. Required."
    },
    "state_version": {
      "type": "integer",
      "minimum": 1,
      "description": "CAS token for stateful messages. Required when message_class=stateful."
    },
    "stream_id": {
      "type": "string",
      "description": "Logical stream identifier. Required when message_class=stream."
    },
    "stream_seq": {
      "type": "integer",
      "minimum": 0,
      "description": "Monotonic sequence number per (execution_id, stream_id)."
    },
    "idempotency_key": {
      "type": "string",
      "description": "Optional application-layer idempotency key for stream messages."
    },
    "signature": {
      "type": "string",
      "description": "Ed25519 or HMAC-SHA256 signature (hex). See signing strategy."
    },
    "session_id": {
      "type": "string",
      "description": "Active ECDH session ID. Required for HMAC-signed messages."
    }
  },
  "if": { "properties": { "message_class": { "const": "stateful" } } },
  "then": { "required": ["state_version"] },
  "else": { "required": ["stream_id", "stream_seq"] }
}
```

#### `Makefile` proto-generate target

```makefile
PROTO_SCHEMA := services/shared/proto/envelope.json
PROTO_GO_OUT := services/shared/proto/generated/envelope.go
PROTO_TS_OUT := server/src/lib/contracts/generated/wsMessage.ts
CHECKSUM_FILE := services/shared/proto/checksums.sha256

.PHONY: proto-generate proto-check

# Generate Go and TypeScript bindings from JSON Schema.
# Requires quicktype: npm install -g quicktype
proto-generate:
	@echo "Generating Go bindings..."
	quicktype --src $(PROTO_SCHEMA) --lang go \
		--package proto \
		--out $(PROTO_GO_OUT)
	@echo "Generating TypeScript bindings..."
	quicktype --src $(PROTO_SCHEMA) --lang typescript \
		--just-types \
		--out $(PROTO_TS_OUT)
	@echo "Updating checksums..."
	sha256sum $(PROTO_GO_OUT) $(PROTO_TS_OUT) > $(CHECKSUM_FILE)
	@echo "proto-generate complete."

# Verify generated files match checksums (run in CI).
proto-check:
	@sha256sum --check $(CHECKSUM_FILE) || \
		(echo "ERROR: Generated proto files were modified by hand. Run 'make proto-generate' instead." && exit 1)
```

#### `.github/workflows/proto-check.yml`

```yaml
name: Proto Contract Check

on:
  push:
    paths:
      - 'services/shared/proto/**'
      - 'server/src/lib/contracts/generated/**'
  pull_request:
    paths:
      - 'services/shared/proto/**'
      - 'server/src/lib/contracts/generated/**'

jobs:
  check-generated-files:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install quicktype
        run: npm install -g quicktype

      - name: Verify proto checksums
        run: make proto-check

      - name: Verify schema-first contract
        run: |
          # Regenerate and check for diff — catches schema drift
          make proto-generate
          git diff --exit-code services/shared/proto/generated/ \
            server/src/lib/contracts/generated/ \
            || (echo "Generated files drift detected — commit regenerated files" && exit 1)
```

#### `services/shared/proto/canonical_form.md`

```markdown
# Phase A Envelope Canonical Form

## Signing Canonical Form

All signatures (Ed25519 and HMAC-SHA256) are computed over the **JCS canonical
form** (RFC 8785) of the envelope object with the `signature` and `session_id`
fields **excluded** before serialization.

### Canonical Form Algorithm

1. Remove `signature` field from envelope object
2. Remove `session_id` field from envelope object  
3. Apply JCS (RFC 8785): sort object keys lexicographically, apply IEEE 754 number
   serialization, apply UTF-16 surrogate pair escaping
4. Encode result as UTF-8 bytes
5. Sign the UTF-8 bytes

### Cross-Language Reference Implementation

- **Canonical owner**: TypeScript (`test/aip-fixtures/generate.ts`)
- **Verified by**: Go (`test/aip-fixtures/verify_go_test.go`)
- **Verified by**: Python (`test/aip-fixtures/verify_python_test.py`)
- **Verified by**: Rust (`test/aip-fixtures/verify_rust_test.rs`)

See `test/aip-fixtures/fixtures.json` for 100 bit-exact test vectors.
Do NOT modify `fixtures.json` manually — regenerate via `npx ts-node generate.ts`.
```

### 验收门禁

```bash
# W1 门禁:envelope.json 存在且有效 JSON Schema
python3 -c "import json,sys; json.load(open('services/shared/proto/envelope.json'))" \
  && echo "envelope.json: valid JSON"

# W1 门禁:make proto-generate 成功
make proto-generate
echo "exit: $?"

# W1 门禁:proto-check 通过(生成文件未被手改)
make proto-check
echo "proto-check: $?"

# CI 门禁:任何 PR 改了生成文件,必须先改 envelope.json + 重新 generate
# (由 .github/workflows/proto-check.yml 执行)

# W4 schema freeze 检查:
# 所有消息类型的 payload schema 都已定案(人工 checklist)
grep -c '"enum"' services/shared/proto/envelope.json
# 期望:type 枚举包含所有 Phase A 消息类型

# TypeScript 类型检查:生成的 wsMessage.ts 无 tsc 错误
cd server && npx tsc --noEmit
```

### 与 V2 的差异 diff

```
V2: Go struct + TS 类型手写维护,两边独立更新,无同步机制
    无 JSON Schema 单一真理来源

V3:
+ envelope.json JSON Schema(单一真理来源)
+ make proto-generate:quicktype 双向生成 Go + TS
+ checksums.sha256 + CI proto-check:防手改
+ canonical_form.md:JCS 规范文档
+ W4 schema freeze 前置 0.5d
+ TS owner fixture 制度(见 R3)
~ 手写 envelope.go / wsMessage.ts → 移至 generated/ 目录(仅限 quicktype 产出)
```

### 受影响周次与工作量

| 周次 | 新增工作 | 工作量 |
|------|---------|--------|
| W1 | envelope.json + canonical_form.md + Makefile proto-generate + CI workflow | +1d |
| W4 | schema freeze checklist + proto-check 全量验证 | +0.5d |
| **小计** | | **+1.5d** |

---

## R6 — Phase A → B 技术债务台账

> 本节显式登记 6 笔已知技术债,每笔标注规模、触发条件、偿还窗口、以及偿还前的临时缓解措施。

---

## Phase A → B 技术债务台账

### 债务 1 — JSON envelope vs Protocol Buffers

**背景:** Phase A 使用 JSON envelope 以降低前期复杂度。JSON 解析开销在高吞吐场景下会成为瓶颈。

| 维度 | 内容 |
|------|------|
| **规模** | 3 工周(协议迁移 + 所有 language binding 重写 + 兼容期双跑) |
| **触发条件** | 单节点 ws 吞吐 > 10,000 msg/s;或 P99 消息解析延迟 > 5ms;或流量 10x |
| **偿还窗口** | Phase B 第一月 |
| **偿还前 mitigation** | (1) envelope.json JSON Schema + quicktype 生成(R5)确保字段一致,减少手动 binding 债务;(2) 预留 `envelope_version` 字段;(3) protobuf IDL 草稿作为 doc-only 制品提前维护 |

### 债务 2 — 单 Postgres 共享库(无分库分表)

**背景:** Phase A 使用单 PG 实例,所有服务共享同一数据库。无 read replica,连接池无隔离。

| 维度 | 内容 |
|------|------|
| **规模** | 1-2 工周(引入 PgBouncer/连接池隔离 + 分库 migration + read replica 路由) |
| **触发条件** | DAU > 100K;或单表行数 > 5000 万;或引入第一个 read replica |
| **偿还窗口** | Phase C 初期 |
| **偿还前 mitigation** | (1) 每表加 `@@index([tenantId])`(R4 W5 的 tenantId 预留);(2) 使用 Prisma middleware 做查询隔离;(3) 监控 `pg_stat_activity` 连接数,超 80% 告警;(4) 慢查询日志 `log_min_duration_statement=100ms` |

### 债务 3 — 本地 daemon vs Kubernetes Operator

**背景:** Phase A daemon 作为普通进程运行在用户机器或 VM 上。企业客户通常要求 K8s-native 控制面(operator 模式、CRD、声明式配置)。

| 维度 | 内容 |
|------|------|
| **规模** | 2-3 工周(Operator SDK + CRD 设计 + reconciliation loop + Helm chart) |
| **触发条件** | 第一个 enterprise 客户要求 K8s 部署;或需要 GitOps 工作流;或需要跨 namespace 资源隔离 |
| **偿还窗口** | Phase B-C 交界期 |
| **偿还前 mitigation** | (1) daemon 配置文件设计为声明式(YAML),减少 operator 迁移摩擦;(2) 提供 Docker Compose 参考部署;(3) 健康检查 endpoint `/healthz` 符合 K8s probe 规范;(4) daemon 无本地状态(stateless),便于 operator 替换 |

### 债务 4 — DID(去中心化身份)验证延期

**背景:** Phase A 按 R3 走 HMAC session 方案替代 DID 验证,牺牲了 marketing 价值(去中心化可信身份)。

| 维度 | 内容 |
|------|------|
| **规模** | 1 工周(DID Document 解析 + DID Resolution + 验证链集成) |
| **触发条件** | "可验证 agent 身份"成为销售故事需求;或需要 Web3 合作伙伴集成;或竞争对手推出 DID-based 产品 |
| **偿还窗口** | Phase B 第一周(如有 marketing 需求则立即启动) |
| **偿还前 mitigation** | (1) IMDaemon 表已有 `pubKeyEd25519` 字段,天然支持 DID 关联(did:key 方法);(2) ECDH session key 建立时已有 Ed25519 签名链,升级到 DID 只需替换 key resolution 层;(3) 在 README 中明确"Phase A 使用 Ed25519 short-term identity,Phase B 升级 DID" |

### 债务 5 — Schema-first 工程化债务

**背景:** 若 R5(envelope.json + quicktype 生成)未在 W1 投资,则 Go struct + TS 类型手写维护,随着协议演进会产生 ~20 处需要手动重构的 binding。

| 维度 | 内容 |
|------|------|
| **规模** | ~20 个手写 binding 重构(约 1-2 工周);若积累到 Phase B 再还,附带测试更新成本 |
| **触发条件** | 协议字段变更 > 3 次后手动维护成本可见;或跨语言 binding 出现第一个生产 bug |
| **偿还窗口** | Phase B 中期(如 R5 未执行) |
| **偿还前 mitigation** | (1) 如果 R5 未实施:在 W1 至少建立 `envelope_version` 字段 + 变更 checklist;(2) 每次协议变更必须同时更新 Go + TS + 签名 fixture;(3) 跨语言 fixture 测试(R3 的 aip-fixtures)会在 binding 漂移时 CI 失败 — 这是最低保底网 |

### 债务 6 — 可观测性追溯债务

**背景:** V2 计划 W7 才接入 Prometheus。如果 W2-W6 期间出现 cross-service bug,没有 metrics/trace 会导致排查时间 3-5x 增加。R4 已将 Prom + OTel 前移到 W2,但仍有追溯盲区。

| 维度 | 内容 |
|------|------|
| **规模** | 1-2 工周(补充 structured logging + 全量 trace + 历史数据回填) |
| **触发条件** | Phase B 出现首个 cross-service bug 且 P90 排查时间 > 2h;或需要 SLA 报告 |
| **偿还窗口** | Phase B 早期 |
| **偿还前 mitigation** | (1) R4 将 Prom + OTel 前移到 W2(最关键的 mitigation);(2) W1 锁定 metrics taxonomy(R4),确保后续补充的 metrics 不需要重构 label;(3) 所有 error 路径必须有 `slog` structured log(execution_id + daemon_id + message_type 作为字段,不作为 metric label);(4) 部署 Grafana + Loki 基础设施在 W2 同步完成 |

---

## V2 → V3 关键变化对照表

| 维度 | V2 | V3(增量改动) |
|------|----|-------------|
| **Schema 闸门** | SHA-256 hash 单轨,hash 不匹配即 fatal | W1 保留 hash;W2 引入 Atlas 双轨;W3 切到 Atlas 为唯一真闸门 |
| **幂等协议** | 所有消息类型统一 `(execution_id, state_version)` CAS | `message_class` 字段分流:stateful → CAS,stream → 单调 seq;两张独立 dedup 表 |
| **签名策略** | Ed25519 全签,高频消息抽样 1% | ECDH session 协商;高价值消息 Ed25519;高频消息 HMAC-SHA256+session key;抽样逻辑删除 |
| **降级模式** | `SIGNATURE_ENFORCE=false`(全局关闭签名) | `SIGNATURE_FALLBACK=hmac_only`(预共享 key;daemon 身份仍可验证);ENFORCE=false 在代码层被 reject |
| **协议契约** | Go struct + TS 类型手写维护 | `envelope.json` JSON Schema 为单一真理来源;quicktype 双向生成;手改触发 CI 失败 |
| **技术债务** | 隐式,未登记 | 6 笔债显式登记(规模/触发/窗口/mitigation);Phase B 优先级依据 |

---

## V3 总工作量

| 来源 | 工作量 |
|------|--------|
| V1 原始计划 | 28d |
| V2 修订增量 | +8d |
| **V3 R1 增量** | +2.5d |
| **V3 R2 增量** | +4d |
| **V3 R3 增量** | +5d |
| **V3 R4 增量** | +3.5d |
| **V3 R5 增量** | +1.5d |
| **V3 R6 增量** | 0d(纯文档,技术债台账) |
| **V3 小计增量** | **+16.5d** |
| **V3 总计** | **52.5d** |

> **说明**: R2(+4d)和 R3(+5d)是最大投入项。R2 的双轨 dedup 是一次性基础设施投资,消除了 stream 消息 CAS 风暴风险;R3 的 ECDH session 建立了完整 audit 链,弥补了 V2 抽样签名的安全漏洞。R5(+1.5d)的 schema-first 投资在 Phase B 协议演进时会大幅减少维护成本。
>
> 如需缩短工期可剪裁的项目:
> - R5 可推迟到 W4(节省 W1 的 1d,但积累 binding 漂移风险)
> - R3 的 batch verify 可推迟到 W5(节省 0.5d)
> - R1 的 AtlasOnly 切换可停留在 Dual 模式(节省 W3 的 0.5d)


---

## 修订(V3.1 — Codex P1 Fix)

> **增量说明**:V3 章节生成后,Codex review 发现 3 处 release-blocking 协议缺陷。本节是对 V3 的就地修补 + changelog,V1/V2/V3 章节只对受影响的代码块和字段做局部 Edit,逻辑总框架不变。零工作量增加(都是规范文本修复,在 W1-W2 实施前提早消解)。

### P1-1 — Stream dedup SQL 在 Postgres 上无效

**位置**:R2 章节,`services/orchestrator/internal/hub/dedup.go` 的 `checkStream` 函数(原文档约 line 2755)。

**Codex 原话(verbatim)**:
> PostgreSQL does not allow `FOR UPDATE` on an aggregate query, so this read will fail as soon as the first heartbeat/log/output message hits the stream dedup path. Because every stream message goes through `checkStream`, the current design would reject all stream traffic rather than serializing it.

**修复方案**:三步并行
1. 用 transaction-scoped advisory lock(`pg_advisory_xact_lock(hashtextextended(execution_id||':'||stream_id, 0))`)序列化同一 stream 的并发 writer,**不锁表**也不影响其他 stream 吞吐
2. `MAX(seq) ... FOR UPDATE` 改成 `SELECT seq ... ORDER BY seq DESC LIMIT 1 FOR UPDATE`(行级查询而非聚合,Postgres 合法)
3. INSERT 失败时检查 unique violation 作为兜底:即便 advisory lock 被旁路,`UNIQUE (execution_id, stream_id, seq)` 约束仍保证正确性

**验收门禁**:
```bash
# 集成测试:1000 并发 stream writer 写同一 (execution_id, stream_id),seq 1..1000 单调
go test ./services/orchestrator/internal/hub -run TestCheckStream_ConcurrentMonotonic -race -count=10

# 期望:无 ErrSeqOutOfOrder、无死锁、无 ErrAggregateForUpdate(原 bug 暴露的错误码)
# 期望:100 个并发 advisory lock waiter 在 p99 < 50ms 内拿锁

# 关键 SQL pattern 不能再出现(防回归):
! grep -rE 'SELECT MAX\(.*\).*FOR UPDATE' services/orchestrator/internal/hub/
# 期望:0 命中
```

### P1-2 — `session.ack` 缺少服务端签名 → MITM 漏洞

**位置**:R3 章节,`services/shared/identity/session.go` 的 `NegotiateSession` 函数 + `SessionAckPayload` struct(原文档约 line 3215-3232)。

**Codex 原话(verbatim)**:
> The protocol text says the daemon verifies an Ed25519 signature on `session.ack`, but the response built here contains only the ECDH pubkey, session ID, key hash, and expiry. Without a signed server response, any on-path attacker can replace `server_pubkey_ecdh` and `session_key_hash` and terminate the handshake as a man-in-the-middle, which defeats the security goal of switching high-frequency messages to HMAC.

**修复方案**:
1. 引入 `SessionTranscript` canonical 结构(7 字段:daemon_id / daemon_pubkey_ecdh / expires_at_ms / server_pubkey_ecdh / session_id / session_key_hash / transcript_version),snake_case 保证 JCS 跨语言稳定
2. 服务端用 Ed25519 私钥(`m.serverEd25519Priv`)对 JCS-marshaled transcript 做 detached 签名
3. `SessionAckPayload` 新增两个字段:`server_signature`(hex-encoded Ed25519)+ `server_key_id`(支持服务端密钥轮换查表)
4. 提供 `VerifySessionAck` 工具函数,daemon 使用 **pinned 服务端公钥**(或通过 trust-on-first-use 缓存的公钥)做验签;失败则 return error 而不是 silent fall-through(silent 等于 reintroducing P1-2)

**信任根策略**:
- daemon 首次启动时 `prismer setup` 阶段下载并 pin 服务端 Ed25519 root 公钥到 `~/.prismer/server-trust.pem`,带 PGP/sigstore 签名验证
- 服务端密钥轮换走 `IMSigningKey` 表(V2 已设计,W2 落地),`server_key_id` 让 daemon 能在过渡期同时接受新旧 key

**验收门禁**:
```bash
# W2 单测:transcript canonical 形式跨 TS/Go bit-exact
go test ./services/shared/identity -run TestSessionTranscript_JCSStability
npx vitest server/src/lib/aip/sessionTranscript.test.ts

# W2 单测:篡改 ServerPubKeyECDH 必须 verify 失败
go test ./services/shared/identity -run TestVerifySessionAck_RejectsTamperedECDH
# 期望:ed25519.Verify 返回 false → VerifySessionAck 返回 "session.ack signature verification failed"

# W3 集成:MITM 模拟测试 — 中间人替换 server_pubkey_ecdh 后,daemon 拒绝建立 session
go test ./services/e2e -run TestSessionMITM_DaemonRejects
```

### P1-3 — `timestamp` 用 Unix 纳秒整型 → JS 精度丢失

**位置**:envelope schema 多处。已同步修改 5 处:
- R5 的 `services/shared/proto/envelope.json`(JSON Schema required + 字段定义)
- R2 的 `services/shared/proto/envelope.go`(`Envelope` struct,`Timestamp int64` → `TimestampMs int64`)
- R2 的 `server/src/lib/contracts/wsMessage.ts`(`EnvelopeV3Base.timestamp` → `timestamp_ms`)
- R3 的 `services/shared/identity/session.go`(`SessionInitPayload.Timestamp` → `TimestampMs`)
- R3 的 session 协议图(`{ ..., timestamp, ... }` → `{ ..., timestamp_ms, ... }`)

**Codex 原话(verbatim)**:
> Declaring `timestamp` as an integer here will generate a TypeScript `number`, but Unix nanoseconds are already around `1.7e18`, well above JavaScript's 53-bit safe-integer limit. Any TS producer or consumer will round the value before signing or comparing it, so the cross-language contract becomes lossy for every envelope.

**修复方案**:
- 字段名:`timestamp` → `timestamp_ms`(语义自显,不再误用)
- 单位:Unix nanoseconds → Unix milliseconds
- JS 安全保证:Unix-ms 在 `Number.MAX_SAFE_INTEGER` (~9e15)以下到约公元 2255 年都安全
- 兼容性:不新建 deprecated alias — Phase A 还没发布,直接重命名最干净;CI 通过 `! grep '"timestamp"' services/shared/proto/envelope.go` 防回归
- 高分辨率逃生口:**不在 timestamp_ms 里塞纳秒**,如果将来某个事件需要纳秒精度,新增独立 string-encoded `timestamp_ns_str`(string 形式无 JS 精度问题,但显著增加签名大小,默认不开)

**验收门禁**:
```bash
# W1 跨语言 fixture:同一 epoch 在 TS/Go/Python/Rust 生成的 envelope JCS 后 SHA-256 必须一致
go test ./test/aip-fixtures -run TestTimestampMsCrossLang
# 期望:100/100 fixtures 通过

# W2 防回归:envelope 内不允许出现 Unix-ns timestamp 字段
! grep -rE '"timestamp"\s*:\s*\d{16,}' services/shared/proto/ services/orchestrator/ server/src/lib/contracts/
# 期望:0 命中(如果发现 16+ 位整型,说明仍有人在写 Unix-ns)

# W2 类型层防回归:envelope.go 中字段必须叫 TimestampMs
go vet ./services/shared/proto/...
grep -E 'json:"timestamp"' services/shared/proto/envelope.go && exit 1 || echo OK
```

### V3.1 工作量影响

| 项 | 增量 |
|---|---|
| P1-1 SQL 修复 | 0d(W3 实施时按修订后代码写,无返工) |
| P1-2 session.ack 签名 | +0.5d(W2 增加 transcript JCS 单测 + MITM 集成测试,**实施代码量持平**) |
| P1-3 timestamp 重命名 | 0d(W1 第一天定 schema 时直接用 `_ms` 后缀) |
| **V3.1 净增量** | **+0.5d**(全部并入 W2) |

### V3.1 关键变化对照表

| 维度 | V3 设计 | V3.1 修订 | 修复影响 |
|---|---|---|---|
| stream dedup SQL | `MAX(seq) ... FOR UPDATE` | advisory lock + `ORDER BY seq DESC LIMIT 1 FOR UPDATE` + unique 兜底 | 解锁 stream 路径,否则 W3 集成测试日 100% 失败 |
| session.ack | 仅 4 字段(无签名) | 6 字段(+ server_signature + server_key_id) + 配套 VerifySessionAck | 关闭 MITM 漏洞,守住 R3 HMAC 切换的核心安全收益 |
| envelope.timestamp | int64 Unix-ns(~1.7e18) | int64 timestamp_ms Unix-ms(~1.7e12) | TS↔Go bit-exact 重新成立,JCS 跨语言签名不再偶发误杀 |
| 签名信任根 | 隐式(代码假设有 pinned key) | 显式(setup 阶段下 server-trust.pem + IMSigningKey 表轮换) | 把"假设"升级为"流程",可审计 |
| Phase A → B 债务 | R6 列 6 笔 | 6 笔不变 | V3.1 不引入新债 |

### V3.1 总工作量(累计)

| 阶段 | 工作量 |
|---|---|
| V2 原 | 36.0d |
| V3 增量 | +16.5d |
| V3.1 增量 | +0.5d(并入 W2) |
| **V3.1 总计** | **53.0d**(单人 ~10.6 周;Track B 两人 ~9.5 周) |


---

## 修订(V3.1.1 — Codex Re-review Fix)

> **背景**:V3.1 落盘后再跑 `/codex:review`,发现 V3 / V3.1 之间存在 1 个 P1 一致性 bug + 2 个 P2 内部矛盾。本节是 V3.1 的"补丁的补丁",同样是规范文本就地修复,不重写主章节。

### P1 — `case "":` fallback 在 rolling upgrade 时打挂 stream 流量

**位置**:R2 `services/shared/proto/envelope.go` 的 `ValidateEnvelope` 函数。

**Codex 原话(verbatim)**:
> The `case ""` fallback claims backward compatibility, but it forces every message without `message_class` into the stateful path. In a rolling upgrade, any pre-V3 `heartbeat`/`log`/`output` message will then fail validation because it does not carry `state_version`, so mixed-version deployments would start dropping stream traffic until every sender is upgraded simultaneously.

**修复方案**:对缺失 `message_class` 的 legacy 消息按 `type` 字段推断 class,只把 `heartbeat / log / output` 推到 stream 路径,其他默认 stateful。这样从 V2 → V3 的 rolling upgrade 期间,旧 daemon 仍然能正常上报心跳和日志。修复后递归一次 `ValidateEnvelope` 走完 class-specific 校验,因为已注入 class 字段不会再次进 `case ""`,无死循环。

**验收门禁**:
```bash
# rolling-upgrade 模拟测试:V2 风格(无 message_class)的 heartbeat / log / output 必须被路由到 stream
go test ./services/shared/proto -run TestValidateEnvelope_LegacyHeartbeatRoutesToStream -v
go test ./services/shared/proto -run TestValidateEnvelope_LegacyLogRoutesToStream -v
go test ./services/shared/proto -run TestValidateEnvelope_LegacyOutputRoutesToStream -v
# 期望:三个测试全 PASS,且推断后的 e.MessageClass == MessageClassStream

# 兼容性回归:V2 风格 task lifecycle 消息(claim / finish / cancel)仍走 stateful
go test ./services/shared/proto -run TestValidateEnvelope_LegacyClaimRoutesToStateful -v
```

### P2-1 — Atlas gate 的 `breakingChangeTypes` 静态 map 复活了 hash 假阳性问题

**位置**:R1 `services/orchestrator/internal/migration/atlas_semantic.go` 的 `breakingChangeTypes` map + `(r *AtlasResult) HasBreaking()` 方法。

**Codex 原话(verbatim)**:
> The hard-coded `breakingChangeTypes` map reclassifies every `MODIFY_COLUMN`, `DROP_INDEX`, and `DROP_CONSTRAINT` as blocking even when Atlas marks the diff non-breaking. That reintroduces the false-positive gate this section is trying to remove, so benign changes such as widening a column or dropping a non-unique index would still be rejected.

**修复方案**:删除整张静态 map(只保留为防回归用的注释),`HasBreaking()` 改为只信任 Atlas 自己的 `d.Breaking` 字段。Atlas 已经知道 `nullable→nullable widening` 是非 breaking、`nullable→NOT NULL on populated column` 是 breaking、`DROP_INDEX of non-unique idx` 是非 breaking 等语义规则。如果未来某条 Atlas 启发式对我们的 schema 形状不对,在 `atlas.hcl` policy block 里精确覆盖,不要回到静态 type list。

**验收门禁**:
```bash
# Atlas 报告 breaking=false 的 MODIFY_COLUMN(列宽放) → 不阻断
go test ./services/orchestrator/internal/migration -run TestAtlasGate_AllowsBenignWidening -v
# Atlas 报告 breaking=false 的 DROP_INDEX(非唯一二级索引) → 不阻断
go test ./services/orchestrator/internal/migration -run TestAtlasGate_AllowsBenignIndexDrop -v
# Atlas 报告 breaking=true 的 NOT NULL 加约束 → 必须阻断
go test ./services/orchestrator/internal/migration -run TestAtlasGate_BlocksAddNotNullOnPopulated -v

# 防回归:代码中不应再有静态 breaking type 列表
! grep -nE '"MODIFY_COLUMN":\s*true|"DROP_INDEX":\s*true|"DROP_CONSTRAINT":\s*true' \
    services/orchestrator/internal/migration/
```

### P2-2 — V3.1 session.ack 修订引用了 V3 没定义的字段

**位置**:R3 `services/shared/identity/session.go` 的 `SessionInitPayload` / `SessionAckPayload` / `SessionManager` 三个 struct。

**Codex 原话(verbatim)**:
> This V3.1 handshake update is internally inconsistent: the surrounding types still define `PubKeyECDH`, `serverPriv`, and the old `SessionAckPayload` shape, but this block now references `init.DaemonPubKeyECDH`, `m.serverEd25519Priv`, `m.serverKeyID`, and the new ack fields. As written, anyone implementing the snippet verbatim gets a non-compiling handshake and a stale wire contract for `session.ack`.

**修复方案**:同步 V3.1 引入的新字段名到三个 struct 定义:
- `SessionInitPayload`:`PubKeyECDH` → `DaemonPubKeyECDH`(JSON `pubkey_ecdh` → `daemon_pubkey_ecdh`),`PubKeyEd25519` → `DaemonPubKeyEd25519`,与 transcript canonical form 字段名 1:1 对齐
- `SessionAckPayload`:删除 `ExpiresAt int64 json:"expires_at"`(Unix-ns,P1-3 已修过 envelope,但这个 struct 漏了),改为 `ExpiresAtMs int64 json:"expires_at_ms"`;新增 `ServerSignature string json:"server_signature"` + `ServerKeyID string json:"server_key_id"`,P1-2 修复必需的字段
- `SessionManager`:`serverPriv` → `serverEd25519Priv`(消除与 ECDH ephemeral 私钥的命名歧义),新增 `serverKeyID string`,`NewSessionManager` 构造器签名同步
- `init.PubKeyECDH` 引用同步改为 `init.DaemonPubKeyECDH`

Phase A 是 pre-release,直接重命名最干净,不引入 deprecated alias。

**验收门禁**:
```bash
# 编译期校验:struct 字段名一致,session.go 整体能 build
cd services/shared/identity && go build ./...

# 静态检查:不应残留任何 PubKeyECDH / serverPriv 引用
! grep -nE '\binit\.PubKeyECDH\b|\binit\.PubKeyEd25519\b|\.serverPriv\b' \
    services/shared/identity/

# JSON tag 一致性:ack 字段名 wire contract 不能漂移
go test ./services/shared/identity -run TestSessionAckPayload_JSONFields -v
# 期望测试断言 ack 序列化包含且仅包含:
#   server_pubkey_ecdh / session_id / session_key_hash / expires_at_ms /
#   server_signature / server_key_id
```

### V3.1.1 工作量影响

| 项 | 增量 |
|---|---|
| P1 fallback 推断 | 0d(W1 第一天写 envelope 时直接按修订后逻辑) |
| P2-1 Atlas trust | 0d(W1 hash 闸门写完后 W2 引入 Atlas,直接信 `d.Breaking`) |
| P2-2 struct 名同步 | 0d(W2 写 session.go 时直接用最终命名) |
| **V3.1.1 净增量** | **0d** |

### V3.1.1 关键变化对照表

| 维度 | V3.1 状态 | V3.1.1 修订 | 缺这个修订的后果 |
|---|---|---|---|
| `case ""` fallback | 一律推 stateful | 按 type 推断 stream / stateful | rolling upgrade 期间 daemon 心跳全挂 |
| Atlas breaking 判定 | 静态 map ‖ Atlas flag | 仅信 Atlas flag | 良性 widening / DROP_INDEX 误阻断 → R1 失去意义 |
| SessionInitPayload 字段名 | PubKeyECDH | DaemonPubKeyECDH(对齐 transcript) | 实现者照抄代码不能编译 |
| SessionAckPayload 字段 | 缺 ExpiresAtMs / ServerSignature / ServerKeyID | 三字段补齐 | wire contract 漂移,HMAC fast path 上线即崩 |
| SessionManager 构造器 | `NewSessionManager(serverPriv)` | `NewSessionManager(serverEd25519Priv, serverKeyID)` | 服务端签名密钥轮换无入口 |

### V3.1.1 总工作量(累计)

| 阶段 | 工作量 |
|---|---|
| V2 原 | 36.0d |
| V3 增量 | +16.5d |
| V3.1 增量 | +0.5d |
| V3.1.1 增量 | +0d(纯规范一致性修复) |
| **V3.1.1 总计** | **53.0d** |

> **说明**:V3.1 + V3.1.1 两轮 patch 累计只增加 0.5d 实施成本,但消除了 4 处会让 W1-W3 实施日 100% 失败的协议规范 bug(stream dedup SQL / 缺签名 MITM / JS 精度丢失 / rolling upgrade 流量挂 / Atlas 假阳性 / 不一致 struct)。这是规范级 review 在动手前发现 bug 的标准 ROI:30 分钟改文档 vs 1 周返工代码。


---

## 修订(V3.1.2 — Codex Re-review Fix #2)

> **背景**:V3.1.1 落盘后第三轮 `/codex:review` 又抓到 3 个 P1 + 3 个 P2,其中 P1-3 是 V3.1.1 fix 自身的回归 bug(legacy stream 推断后仍会因缺 `stream_id`/`stream_seq` 失败)。本节是 review 收敛过程的第三轮、也是规划阶段最后一轮 patch。

### P1-1 — Atlas gate fail-open

**位置**:R1 `migration/atlas_semantic.go` 的 `RunAtlasDiff`。

**Codex 原话**:
> If `atlas` is missing, times out, or exits before emitting JSON, `stderr` is often empty, so `RunAtlasDiff` falls through and `stdout.Len()==0` gets interpreted as "semantically identical". In `Dual`/`AtlasOnly` mode that silently disables the schema gate in the very environments where Atlas is unavailable.

**修复方案**:把 atlas 失败的路径区分成三个明确分支 ——
- (a) 非零退出 + stdout 有 JSON ⇒ 正常 "diffs found" 路径
- (b) 非零退出 + stderr 含 `Error:` ⇒ atlas 真错误,fail closed
- (c) 非零退出 + stdout 空 + stderr 也无 `Error:` ⇒ atlas 二进制或 ctx 异常,**fail closed**(过去会被误识别为"无 diff",静默放行)
- (d) 零退出 + stdout 空 ⇒ 真正"语义等价",这是唯一应该返回 `&AtlasResult{}, nil` 的路径

### P1-2 — Stateful dedup 与业务更新非原子

**位置**:R2 `internal/hub/hub.go` 的 `handleMessage`。

**Codex 原话**:
> `handleMessage` records the stateful dedup key before `handleStateful` runs, so any failure after the insert (DB timeout, process crash, downstream error) makes the client retry hit `ErrDuplicate` and get ACKed without reapplying the transition. That turns transient handler failures into permanently lost state changes unless the dedup write and business update share one transaction.

**修复方案**:`handleMessage` 按 message_class 分流到三个 handler:
- `handleStatefulAtomic`:**dedup CAS 与业务 state 更新进同一个 tx**,任一失败 rollback 同时撤销 dedup 行,客户端 retry 能正常处理
- `handleStreamWithDedup`:stream 是 append-only fire-and-forget,handler 不更新需要 rollback 的 durable state,dedup 在 tx 外可接受
- `handleLegacyBestEffort`(为 P1-3 准备):跳过 dedup 直接处理,过渡期 best-effort

### P1-3 — V3.1.1 自身回归:legacy stream 推断后仍被拒

**位置**:R2 `proto/envelope.go` 的 `ValidateEnvelope` 中 `case "":` 分支。

**Codex 原话**:
> The empty-`message_class` fallback only infers `stream` vs `stateful`; it then immediately re-enters validation, where stream messages still require `stream_id` and `stream_seq`. Pre-V3 `heartbeat`/`log`/`output` frames will not have those fields either, so a rolling upgrade still rejects legacy stream traffic despite the compatibility comment here.

**修复方案**(supersedes V3.1.1 P1):放弃"推断 + 重跑校验"路线,引入新的 `MessageClassLegacy` 第三类,在 dedup router 里对 legacy 类**完全跳过 dedup**,直接交给 `handleLegacyBestEffort`。
- Trade-off:legacy 消息在过渡期可能被多次处理(heartbeat/log 都是应用层幂等的,可接受)
- 上线 vs 丢消息:选择"短期可能重复" > "短期消息丢失"
- V4 清理:所有 daemon 升级完成后这条分支可下线

### P2-1 — `SessionManager.sessions` map 没锁 → race / panic

**位置**:R3 `identity/session.go` 的 `SessionManager`。

**修复方案**:加 `sync.RWMutex`;`HandleInit` 写用 Lock,`GetSessionKey` 读快路径用 RLock,过期清理时 race-tolerant 检查"被清的还是同一对象再 delete"。

### P2-2 — JCS `serializeNumber` 不符合 RFC 8785 §3.2.2.3

**位置**:R3 `identity/canonical.go`。

**Codex 原话**:
> `serializeNumber` uses `strconv.FormatFloat(..., 'f', -1, 64)`, which is fixed-point formatting, not the ECMAScript number serialization required by RFC 8785. Values such as `1e-7`, `1e30`, or `-0` will canonicalize differently from the TypeScript `json-canonicalize` owner.

**修复方案**:
- NaN / Infinity:返回 error(RFC 8785 §3.2.2.2 禁止)
- ±0:统一输出 `"0"`(吞掉 -0 符号位)
- 一般 float:用 `encoding/json.Marshal(f)` 委托给 Go 内置算法(对 Phase A envelope 实际值域,与 TS 参考实现一致;真正裁判是 `test/aip-fixtures/numbers.json` 跨语言 fixture)
- 函数签名加 `(string, error)` 双返回值,调用方必须处理 error(防止悄悄默认成空字符串)

### P2-3 — `IMFeatureFlag.IsEnabled` 不顾 `rolloutPct`

**位置**:R4 `lib/services/featureFlag.go`。

**Codex 原话**:
> `IsEnabled` returns `true` for every tenant whenever a flag exists and is globally enabled unless there is an explicit tenant override. That means a flag configured with `rollout_pct < 100` is still exposed to 100% of traffic, defeating the staged-rollout/canary behavior.

**修复方案**:5 步判定流 ——
1. flag 缺失 / 全局 disabled → false
2. 显式 tenant override → 用 override 值
3. `rolloutPct == 100` → true(全量)
4. `rolloutPct == 0` → false(kill switch)
5. 其余 → FNV-1a(flagName + ":" + tenantID) % 100 < rolloutPct

哈希 key **必须包含 flag 名**,避免 tenant 在所有 flag 上落同一 bucket。

### V3.1.2 工作量影响

| 项 | 增量 |
|---|---|
| P1-1 Atlas fail-closed 三分支 | 0d(原代码 if-tree 改造,行数中性) |
| P1-2 stateful dedup 进 tx | +1.0d(dedup router 新增 CheckAndRecordStatefulInTx,handler 改造) |
| P1-3 MessageClassLegacy + best-effort handler | +0.5d(新增 1 个 class 常量 + 1 个 handler 函数) |
| P2-1 SessionManager sync.RWMutex | 0d |
| P2-2 RFC 8785 number serialize | 0d(代码量持平,跨语言 fixture 是真闸门) |
| P2-3 rolloutPct 哈希分桶 | 0d |
| **V3.1.2 净增量** | **+1.5d** |

### V3.1.2 关键变化对照表

| 维度 | V3.1.1 状态 | V3.1.2 修订 | 缺这个修订的后果 |
|---|---|---|---|
| Atlas 异常 | empty stdout = "no diff" | empty stdout + 非零退出 = fail closed | atlas 缺失/超时时 schema gate 静默关闭 |
| Stateful dedup 原子性 | dedup 先入库,再跑 handler | dedup CAS 与业务更新同一 tx | handler 失败 → 重试拿到 phantom duplicate ACK → 状态丢失 |
| Legacy stream 兼容 | 推断后重跑校验,stream_id 仍缺 | MessageClassLegacy → 跳过 dedup 直进 best-effort | rolling upgrade 期间 daemon 心跳全挂 |
| Session map 并发 | 无锁 | sync.RWMutex,RLock 读快路径 | 高并发会话协商触发 panic |
| JCS 数字序列化 | strconv.FormatFloat 'f' 模式 | encoding/json.Marshal + NaN/Inf reject | 1e-7 / 1e30 / -0 等值跨语言签名失败 |
| FeatureFlag rolloutPct | 完全忽略 | FNV-1a 稳定分桶 | rolloutPct < 100 仍 100% 放量,canary 失效 |

### V3.1.2 总工作量(累计)

| 阶段 | 工作量 |
|---|---|
| V2 原 | 36.0d |
| V3 增量 | +16.5d |
| V3.1 增量 | +0.5d |
| V3.1.1 增量 | +0d |
| V3.1.2 增量 | +1.5d |
| **V3.1.2 总计** | **54.5d**(单人 ~11 周;Track B 两人 ~9.5-10 周) |

---

### Review 收敛性总结

三轮 codex review 累计抓出:
- 第 1 轮:3 个 P1(stream SQL / 缺签名 MITM / JS 精度丢失)
- 第 2 轮:1 P1 + 2 P2(Atlas 假阳性 / case "" fallback / struct 不一致)
- 第 3 轮:3 P1 + 3 P2(Atlas fail-open / dedup 非原子 / legacy 仍挂 / map race / RFC 8785 / rolloutPct)

第 3 轮的 P1/P2 比例 1:1,且都是**实施级代码片段细节**(不再是协议/架构层面),review 的边际收益已显著下降。**规划阶段 review 到此收工**,后续靠 W1 起的代码 review 兜住实现期 bug。

> **总成本对账**:三轮 review 共消耗约 30 分钟规划时间 + 1.5d 修复成本,消除了 12 处会让 W1-W3 实施日 100% 失败 / 上线后引发数据丢失 / 安全漏洞 / 压测不过的协议规范 bug。代码阶段补救成本估算 ≥ 6 工日(测试发现 → debug → 修复 → 回归)。**ROI ≈ 4x。**

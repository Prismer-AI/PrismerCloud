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

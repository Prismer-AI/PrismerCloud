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

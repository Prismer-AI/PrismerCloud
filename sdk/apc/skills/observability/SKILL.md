---
name: observability
description: Periodic health sweep of the running system via the debug pipeline (cloud logs / k8s / daemon / DB slices). On a real anomaly, open a bug task (--kind work_item) carrying the evidence refs so it re-enters the bugfix loop. A healthy sweep opens NO task — never fabricate a bug.
license: MIT
scope: common
compatibility:
  - claude-code
  - prismer-sdk
allowed-tools:
  - Bash
metadata:
  category: observability
---

# observability

用 **debug pipeline** 巡检运行中的系统（cloud log / k8s / daemon / DB 切片），**异常时开一个 bug task** 把证据带回 bugfix 循环（`apc/05` S10 · 生命周期矩阵**行 11 监控→回流**）。**触发器 = product205 定时任务后端**（已建，缺前端）挂周期巡检——本 skill 是那次巡检真正干的活，不悬空。

**承重纪律**：
- **healthy 扫描不开 task。** 没有异常就报"绿"并停手——**绝不**为了"有产出"造一个假 bug。一个无论系统健不健康都会建 task 的巡检 = 噪声制造机。
- **异常 → bug task 必须带证据 ref。** bug task 的 description 要挂可追溯锚（pod / workspace / task id + debug 切片摘要，或把 bundle 产物 `cloud asset upload` 后引 `asset:<id>`）。空口"系统好像有问题"不是 bug task。
- **oracle 是真 task 行，不是聊天叙述。** "我建了 bug task" 不算数——`cloud task create` 返回的真 id + 回读的 task 行才算。

**什么时候用**：周期巡检（定时任务触发）或收到"系统是不是出问题了"时——先用 debug pipeline 取副作用切片核实，再决定是否回流。

## 工具契约（签名以此为准，先核后用）

| 命令 | 作用 | 输出/退出码 |
| --- | --- | --- |
| `npx tsx scripts/debug/admin-observability.ts capabilities [--env=local\|test\|prod]` | canonical Admin v1 discovery；读取 principal、capabilities、schema version 与 opaque contract digest | `0` 成功；不兼容/无权限非零 |
| `npx tsx scripts/debug/admin-observability.ts logs --target-kind=service --target-id=prismer-cloud --purpose=<reason> [--since=15m] [--cursor=<opaque>] [--completeness=require-complete\|allow-partial]` | canonical `POST /api/admin/v1/logs:query` 只读快照；命令内部必须先 discovery；cursor 只能原样回传 | 默认 `require-complete`；置信边界完整 `0`，不满足 `3`，请求/合同错误 `1`，用法错误 `2` |
| `cloud admin log-targets --kind <service\|sandbox\|daemon> --purpose <reason> [--workspace-id <id>] [--cursor <opaque>]` | daemon-held credential 下发现 DB-resolved logical targets；不接受 namespace/selector | `0` 完整成功；partial projection `2`；请求失败 `1` |
| `cloud admin logs --target-kind <kind> --target-id <id> --purpose <reason> [--attach-to-task [taskId]]` | credentialless loopback 查询 service/sandbox/daemon；可经既有 daemon task-attach 把 JSON 证据绑定到 task | `0` 完整成功；partial `2`；失败 `1`；attach 要求 daemon dispatch + `PRISMER_ARTIFACTS_DIR` |
| `npx tsx scripts/debug/inventory.ts [--env=local\|test\|prod] [--json]` | 全局索引：running pods / recent workspaces / recent tasks / **recent errors** | 人读 5 段 或 `--json` |
| `npx tsx scripts/debug/bundle.ts <workspace\|task\|pod> <id> [--sections=db,system,k8s,daemon] [--stdout] [--since=ISO]` | 复合切片（DB+system-log+k8s+daemon） | 默认写 `./debug-bundle-*.json`，`--stdout` 打屏 |
| `npx tsx scripts/debug/snapshot.ts <workspace\|task\|conversation\|container> <id> [--json\|--brief]` | DB 切片（task 终态行/runs/logs/approvals/assets） | 默认 compact，`--json` raw |
| `npx tsx scripts/debug/logs.ts [--contains=text] [--since=ISO\|10m\|1h] [--level=...] [--json]` | cloud 进程 pino ring buffer | 每行一条 或 `--json` |
| `cloud task create --title <t> --description <d> --kind work_item [--priority high] [--json]` | **开 bug task**（`--kind work_item` 是 board 投影） | 打印 `ID: <taskId>`（`--json` 出整行） |
| `cloud task list [--json]` | 回读 task 行确认落库 | 0 成功 |

- `--kind` 合法值**恰好两个**：`work_item`（默认，bug/工作项）/ `goal`。bug 巡检一律 `work_item`。
- **鉴权**：debug pipeline 走 admin RBAC（`--env=local` dev 短路免鉴权；`--env=test|prod` 需 `PRISMER_API_KEY_TEST`/`PRISMER_API_KEY`）。coding agent 的 workdir env **不注入高危凭据**——test/prod 巡检由平台方持凭发起，不在 agent 的 bash 里裸读（`apc/05` §3 凭据可见性边界）。
- **凭据边界**：canonical 命令没有 `--api-key` 参数，也不把 credential 写入 stdout、stderr 或产物；禁止 `env`、`printenv`、shell tracing（`set -x`）和把 Authorization header 拼进命令行。平台执行器在模型不可见边界注入 credential。
- **合同边界**：只调用 `/api/admin/v1/capabilities` 与 `/api/admin/v1/logs:query`，不猜 403、不回退 legacy route、不猜 digest 算法。若平台固定了本次发布 digest，可由执行器注入 `PRISMER_ADMIN_CONTRACT_DIGEST` 做 exact match。

## Workflow

### 1. 先落调用回执（见文末 ACK 块），再做 canonical discovery + Cloud 日志快照

APC 自动巡检默认要求完整结果。先调用 capabilities，再由同一命令进程完成 logs query：

```bash
mkdir -p .e2e-tmp/apc/observability
npx tsx scripts/debug/admin-observability.ts capabilities \
  > .e2e-tmp/apc/observability/admin-capabilities.json
npx tsx scripts/debug/admin-observability.ts logs \
  --target-kind=service --target-id=prismer-cloud --since=15m \
  --purpose="periodic APC observability sweep" \
  --completeness=require-complete \
  > .e2e-tmp/apc/observability/admin-service-logs.json
admin_logs_exit=$?
```

`admin_logs_exit=3` 表示所需置信边界不完整，**不得宣布 healthy**；读取 JSON 中的
`requestId`、`sources[]`、`partial`、`attemptedSourceTiers`、`availableSourceTiers`、
`confidenceBoundary.productionRetainedRequirement`、`contractDigest`、`evidenceHash` 后报告受限结论。
`attemptedSourceTiers` 只说明服务端尝试过某 tier；只有 `availableSourceTiers` 才代表可用证据，
retained source 为 `unavailable` 或 `error` 时严禁把它写成 retained evidence。
只有 human 明确做探索性查询时才可传 `allow-partial`，且逐 source outcome 仍必须保留。`1/2` 是请求或
用法失败，同样不能当作“没有 error”。canonical 输出可作为 task-bound evidence，但先确认其中不含凭据；
不要长期保存为 loose file。

生产环境的 `require-complete` 还有强 gate：必须同时看到
`availableSourceTiers` 包含 `retained`、
`confidenceBoundary.productionRetainedRequirement.satisfied=true`、稳定 ordering/continuity、
完整 coverage、`truncated=false`、`mayDuplicate=false`。任一不满足均按退出码 `3` 处理。
分页时只可把响应 `nextCursor` 原样作为下一次 `--cursor=<opaque>`；不得解析、修改或自行生成 cursor。
SLS 当前只提供 offset continuation，服务端会明确标记 `continuity=best-effort`、`mayDuplicate=true` 和
`partial=true`；即使 provider query 返回 Complete 也不得升级成完整证据。Sandbox/Daemon 查询前先用
`cloud admin log-targets` 发现 logical id，禁止把 Pod、namespace 或 label selector 当 target id 猜测。

### 2. 拉全局索引，覆盖其余信号面

```bash
mkdir -p .e2e-tmp/apc/observability
npx tsx scripts/debug/inventory.ts | tee .e2e-tmp/apc/observability/inventory.md; echo "inventory exit=$?"
npx tsx scripts/debug/inventory.ts --json > .e2e-tmp/apc/observability/inventory.json    # 机器形（可选）
```

**产物落 repo-relative 的 `.e2e-tmp/apc/observability/`（已在 `.gitignore`），不要落 `/tmp`**——判据要**读回**你引用的那一行，`/tmp` 从仓库根不可解析、跑完即毁的证据等于没有证据（同 test204「证据销毁反 pattern」）。**报告前不许删**这批产物。

读 5 段：`pods`（有没有 pending/crash）· `workspaces` · `recent tasks`（有没有卡在 pending/running 超时）· **`recent errors`**（`error`/`warn` 级别）。**先索引再下钻**——不要一上来 `logs.ts --since=30m | grep`（那是 v0 习惯）。

### 3. 锁定可疑目标 → 下钻取副作用切片

对索引里冒出的可疑目标（报错的 pod / 卡死的 task / 异常 workspace）一次拿全套：

```bash
# 已知某 task/workspace/pod 可疑 → 复合切片
npx tsx scripts/debug/bundle.ts task <taskId> --sections=db,system,k8s,daemon --stdout > .e2e-tmp/apc/observability/bundle.json
# 或单钻 DB
npx tsx scripts/debug/snapshot.ts task <taskId> --json > .e2e-tmp/apc/observability/snapshot.json
# 关键字检索 cloud log
npx tsx scripts/debug/logs.ts --contains=<taskId> --since=1h > .e2e-tmp/apc/observability/logs.md
```

### 4. 判异常（副作用为准，不猜）

| 观察到的副作用 | 判定 |
| --- | --- |
| `recent errors` 有 `level:error`（非预期的一次性 warn）· pod crash/pending 超时 · task 卡 `running` 超 reaper 阈值无心跳 · daemon `/healthz` 不应答 | **异常** → 第 4 步开 bug task |
| 全绿：无 error 级、pods running、tasks 正常流转、daemon 健康 | **healthy** → 报绿，**不开 task**，停手 |
| 单条 flaky/预期内 warn（如 `[K8sSandbox] pod-status: read failed` 这类已知噪声） | **非异常**——记一句备注，不开 task（造假 bug 比漏报危害大） |

canonical query 的服务端 `partial=false` 不等于生产证据 gate 已满足，更不等于“事实必然完整”；
`confidenceBoundary.partial=true`、`truncated=true` 或生产 retained gate 不满足时，结论置信边界必须显式
收窄，自动巡检不得据此判 healthy。

> 拿不准是不是真异常 → 单钻确认（`snapshot`/`logs`），**证据不足不开 task**。开一个假 bug 会污染 bugfix 循环。

### 5. 异常 → 开 bug task（带证据回流 1b）

```bash
cloud task create \
  --title "[observability] <一句话症状: pod X crash / task Y stuck>" \
  --description "Anomaly from periodic sweep.
Target: <pod|task|workspace>:<id>
Evidence: <recent-errors 摘要 / bundle 关键段 / asset:<id>>
Repro: npx tsx scripts/debug/bundle.ts <entity> <id> --stdout" \
  --kind work_item --priority high --json
```

抓返回的 `id`（`--json` 里 `data.id`，或人读 `ID:` 行）——这条真 task 行是本 skill 的产出 oracle。可选：`cloud asset upload .e2e-tmp/apc/observability/bundle.json` 拿 `asset:<id>` 挂进 description 作持久证据。

### 6. 回读确认落库

```bash
cloud task list --json | grep <newTaskId>   # 或 cloud task get <id>
```

确认 bug task 真行存在、`kind=work_item`、带证据。

## 输出契约（机器判据按这个复验，别自由发挥格式）

旧判据是「正文里出现过 `pod`/`task`/`error` 加个数字」的关键词匹配——**一篇没跑过任何命令的报告照样满分**，而且**只扫了 pods 就宣布全绿**也照绿（其余四面静默跳过，判据看不出来）。现在**五个信号面各占一行**、由 `dimension-coverage` 逐面复核：**某一面没写这行 = 判红**，正文里出现那个词**不算数**。

每行的答案二选一：① 指向**你这轮真落盘的巡检产物**里的那一行（repo-relative `path:line`，判据把该行读回磁盘，文件不存在 / 行号越界 / 空行 → 判红）；② 显式 `N/A — <理由 ≥20 非空白字符>`（这一面本轮**确实**扫不到，比如没有 daemon 可达）。

```
- SIGNAL-pods: .e2e-tmp/apc/observability/inventory.md:12
- SIGNAL-workspaces: .e2e-tmp/apc/observability/inventory.md:21
- SIGNAL-tasks: .e2e-tmp/apc/observability/inventory.md:34
- SIGNAL-errors: .e2e-tmp/apc/observability/inventory.md:47
- SIGNAL-daemon: N/A — 本轮 --env=local 无在跑的 sandbox pod，daemon /healthz 无可探测目标
```

**行号照抄 `cat -n` / `rg -n` 你自己那份产物的真实输出**，不许凭印象写。引用必须 **repo-root-relative**（`/tmp/...` 与绝对路径一律判红——这也是上面要求产物落 `.e2e-tmp/` 的原因）。**报告前不要删产物**：判据是在你跑完之后才读盘的。

> **产物存成可引用的扩展名**：引用解析器只认固定后缀集（`ts/tsx/js/jsx/mjs/cjs/prisma/sql/md/json/sh/py/yml/yaml`）——所以人读产物存 `.md`、机器产物存 `.json`。存成 `.txt` / `.log` **引用不会被解析**，那一面会被判成"没给可复核证据"。

> 这条判据管的是「**每一面都被显式判过**」，不替代下面的异常/healthy 判定——它挡的是**静默漏扫**（只看了一面就宣布全绿），不是替你判异常。

## 产出（副作用 oracle，报告里必须给）

1. **debug 切片真产物**：inventory/bundle/snapshot/logs 的结构化输出（含 recent errors / pod 状态 / task 终态字段）——不是"我看了一下感觉没事"。
2. **canonical Admin receipt**：capabilities + logs query 输出必须包含 contract digest、principal、requestId、`attemptedSourceTiers`、`availableSourceTiers`、逐 source outcome、coverage/partial/truncated、production retained gate、redaction ruleset 和 evidence hash；默认置信边界不完整的命令退出码必须为 `3`。
3. **异常路径**：`cloud task create --kind work_item` 返回的**真 task id** + 回读的 task 行（`kind=work_item`）+ description 里的证据 ref（target id / asset）。
4. **healthy 路径**：明确"无异常、未开 task"，附巡检覆盖了哪些目标（pods/tasks/errors 计数）作为扫过的证明。

**不许**：healthy 时凭空造 bug task（假阳）· bug task 无证据 ref（空口判红）· 断言聊天文本而非真 task 行 · 拿旧 bundle 当本轮证据 · 把已知噪声 warn 当异常刷 task · **把巡检产物写进 `/tmp` 或跑完就删**（证据必须留到判据读盘之后）· 只扫一两个信号面就宣布全绿（五面各自一行，缺一行判红）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack observability --task "$PRISMER_TASK_ID"
```

**按退出码分流**（这条命令的退出码是承重信息，禁止用 `||` 兜底、`; true`、
`set +e` 或重定向把它抹掉）：

| exit | 含义 | 你要做的 |
| --- | --- | --- |
| `0` | 回执已落库（`im_task_logs.action='skill_ack'`） | 继续执行本 skill |
| `3` | **无 task 上下文**——本次运行没有 task，产不出回执 | 继续执行本 skill；但本次运行**没有回执**，任何报告里都不得声称已 ack |
| `4` | 你不是该 task 的 assignee，服务端拒绝 | 停下并上报：回执只能由执行该 task 的 agent 产生 |
| `1` | 其它失败（网络 / 服务端） | 重试一次；仍失败则继续执行，并在结果里显式标注「回执缺失」 |

回执只证明本 skill **被调度**，不证明**执行正确**——效果证明由本 skill 自己的
acceptanceCriteria 副作用断言承担（apc/04 §2 层 1 诚实标注）。

<!-- /APC-ACK:v1 -->

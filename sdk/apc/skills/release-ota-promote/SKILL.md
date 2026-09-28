---
name: release-ota-promote
description: Publish signed Electron UI/daemon bundles to a local OTA feed with atomic manifest switch and digest readback, while dry-running the K8s drain_respawn rollout. Prod is refused before writes; feed publication is not client apply.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: release
---

# release-ota-promote

把一份 runtime OTA 沿**双通道**下发（`apc/01` §2 ota-promote，收口步 7/8/11）。这是**线 3 admin fleet 下发**，交付模式治 **doc01 #8**（"promote 用了线 1 kill1 而非线 3 drain_respawn"）：

- **K8s daemon 通道**：交付 **drain_respawn**（排空在飞 task → 优雅 `exit(0)` → supervisor respawn → boot-OTA 换版，用户**无感/无中断**）。正规落点 = admin fleet rollout endpoint `POST /api/admin/runtime-releases/rollout`（`src/im/api/admin.ts`）→ 给每个目标 daemon 下发 `runtime.update.apply` 帧 → daemon **arm drain_respawn**。本 verb **不再 spawn 线 1 `kill 1` 的 `runtime-ota.ts`**（那会打断在飞 task），而是**构造这条 drain_respawn rollout 请求**。本机替身**只 dry-run 出请求、不真 POST**（真 POST 需 approvalId + release row + 在线 daemon = M5）。
- **桌面 feed 通道**：本机替身**未接线**——诚实标 ⬜（铁律 4）。缺①桌面本地 feed 基座（`apc/05` §3，P0-4 未落）②本机禁写真 Nacos manifest（= M5）。

**什么时候用**：一个新 runtime 版本发布后，要让 fleet 里的 daemon 采用它。

## 承重纪律（发版 skill 的命根子，先记死）

- **prod OTA 必拒**（不变量 2）。`--env prod` **先于任何 OTA 动作硬拒**，不做任何下发。**别试 prod**：真 prod promote = M5。
- **交付模式 = `drain_respawn`，绝非 `kill1`**。线 3 fleet 下发必须排空在飞后再 respawn（`kill 1` 会打断用户在飞 task，那是线 1，仅 dev/紧急）。`k8s.directive` 必须是 `drain_respawn`。
- **不宣称 `drain_respawn` 已执行**。本机替身**只 dry-run 出 rollout 请求（`k8s.posted:false`），不真 POST**（= M5：approvalId + release row + 在线 daemon）。照实报"已构造 drain_respawn 请求，未真下发"，**绝不说"已 drain_respawn 下发"**。
- **桌面 feed 走真文件副作用**。传 `--desktop-feed-dir` 与 UI/daemon builder metadata；verb 先校验 size + SHA-512，复制版本化 bundle，最后原子切 `manifest.json`，再从磁盘回读摘要。只有 `desktop.status:'applied'` + `readback.verified:true` 才能宣称 feed 已发布。
- **feed 已发布 ≠ Electron 已应用**。客户端 `check → stage → apply` 需要另取运行态证据，不得从文件写入外推。

## Anti-pattern（直接判红）

- ❌ **`--env prod`** 想 promote prod。命中即 blocked，别绕。
- ❌ **把交付模式报成 `kill1` / 线 1 `kubectl exec kill 1`**。本 verb 是线 3，交付 `drain_respawn`；报 kill1 = 把在飞打断当成了正规下发。
- ❌ **把 `k8s.posted:false` 的 dry-run 说成"已 drain_respawn 下发/已 POST"**，或把本地 feed 已发布说成"Electron 已更新"。

## 工具契约（签名以此为准）

> `apc` **不在 PATH**——在仓库根用 `npx tsx sdk/apc/bin/apc.ts <sub>`。

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `npx tsx sdk/apc/bin/apc.ts release ota-promote [--env dev\|test\|prod] [--json]` | K8s 通道构造 drain_respawn rollout 请求（落点 admin fleet rollout endpoint，本机替身 dry-run 不 POST）+ 桌面通道 ⬜；prod 硬拒 | `0` green（真 rollout 完成，仅 M5）· `1` blocked（本机 dry-run 边界 / 桌面未接线 / prod 拒） |

`--json` 字段（**名以此为准**）：

- 顶层：`{ verb:'ota-promote', decision, env, deliveryMode, k8s, desktop, blockers:[], notes:[] }`
- `k8s`：`{ channel:'admin-fleet-rollout', endpoint, directive:'drain_respawn', frame:'runtime.update.apply', request:{channel,version,target}, posted:false, boundary }`（`directive` = 交付模式，**必须 drain_respawn**；`posted:false` = 本机替身未真 POST）
- `desktop`：成功时 `{ status:'applied', deliveryMode:'local-file-feed', plan:{manifestPath,...}, readback:{verified:true,...}, boundary }`；校验/写入/回读失败时 `{status:'blocked', blockers:[...]}`。
- `deliveryMode`：`'drain_respawn（线 3 admin fleet rollout · 本机替身 dry-run）'`——**不是** kill1

## Workflow

### 1. K8s 通道（构造 drain_respawn rollout 请求）

```bash
npx tsx sdk/apc/bin/apc.ts release ota-promote --env dev --json > /tmp/ota.json; O=$?
echo "ota-promote exit=$O"
```

- 读 `k8s.directive`——必须是 `drain_respawn`（线 3，排空在飞后 respawn），**不是** `kill1`。
- 读 `k8s.posted`——`false` = 本机替身**只 dry-run 出请求、未真 POST**（真 POST = M5）。
- 本机替身 → `decision:blocked`（exit 1）+ blocker 说明"真 admin rollout POST = M5"。**如实报**，这是本机替身边界（release-common.ts 本机替身边界），不冒充已下发。

### 2. 桌面通道（诚实 ⬜）

使用隔离目录与现有已签名 builder metadata 发布并回读：

```bash
npx tsx sdk/apc/bin/apc.ts release ota-promote --env dev \
  --desktop-feed-dir .e2e-tmp/apc-ota-feed \
  --desktop-ui-meta apps/desktop/dist-ui/ui.manifest.json \
  --desktop-daemon-meta apps/desktop/dist-ui/daemon.manifest.json --json
```

核验 `desktop.status=applied` 、`desktop.readback.verified=true`，并独立检查 `desktop.plan.manifestPath` 及版本化 bundle 存在。

### 3. prod 一律拒（验证人闸）

```bash
npx tsx sdk/apc/bin/apc.ts release ota-promote --env prod --json; echo "prod exit=$?"
# 预期：decision=blocked, exit 1, k8s.skipped=true, blockers 含 "prod 人闸"
```

## Failure / 边界

- 本机替身 → K8s 通道 dry-run 出 drain_respawn 请求但不真 POST → `blocked`。这是**预期的真行为**（本机替身边界），不是 skill 的红。
- 桌面通道 = ⬜（feed 基座未落 + 本机禁写真 Nacos）。
- 真 drain_respawn fleet 下发（真 POST admin rollout endpoint + approvalId + release row + 在线 daemon）= M5；本 verb 只把交付模式**纠正为 drain_respawn** 并 dry-run 出请求。

## 输出契约（机器判据按这个复算，别自由发挥格式）

本 skill 的判据**不是**「报告里出现了 `drain_respawn` 这个词」——旧判据正是一条 `match:"drain[\s_-]?respawn"`，一份宣称 `posted:true`、`decision:green`、"fleet 已换版"的**纯编造**报告在它下面满分。新判据**重解析你贴的两份 `--json` 产物**，把 `k8s.channel/directive/frame/posted` 逐字段钉死、从 `decision` 反推退出码、并把 rollout body 的 `version` 与磁盘上真 `/VERSION` 比对（`json-claim`）。

报告必须带这组行 + **两份原样 JSON**（`--env dev` 在前，`--env prod` 在后）：

```
DIRECTIVE: drain_respawn
POSTED: false
DESKTOP: applied
DESKTOP-VERIFIED: true
RUN-EXIT: 1
PROD-DECISION: blocked
PROD-K8S-SKIPPED: true
PROD-RUN-EXIT: 1
```

判据会判红的情况（任一）：

- 没有可解析的 fenced JSON；
- `k8s.directive` 不是 `drain_respawn`（写成 **`kill1`** 直接红——线 1 会打断在飞 task，把它当交付模式正是本 verb 存在的理由）、或 `k8s.channel != admin-fleet-rollout`、`k8s.frame != runtime.update.apply`；
- **`k8s.posted != false`**，或 `posted:false` 却 `decision:green`——**什么都没 POST，就不许把任何东西报成已下发**；
- `desktop.status != applied` 或 `desktop.readback.verified != true`，或把 feed 发布冒充为 Electron 客户端已 apply；
- `DIRECTIVE` / `POSTED` / `DESKTOP` 与产物字段不一致，或 `RUN-EXIT` 不是 `decision` 推出来的；
- rollout body 的 `k8s.request.version` **不等于磁盘上 `/VERSION`**；
- prod 产物不是 `blocked` + **`k8s.skipped:true`**（连 rollout 请求都没构造）+ `blockers` 非空。

**诚实边界**：桌面通道有真文件副作用与摘要回读；K8s 通道仍只构造请求、不 POST。因此顶层仍应 `blocked`，直到真 admin rollout 产生送达证据。

## 产出（副作用 oracle，报告里必须给）

1. **decision + 真退出码**：`green`/`blocked` ⇄ `0`/`1`。
2. **交付模式证据**：`k8s.directive:'drain_respawn'`（线 3，非 kill1）+ `k8s.frame:'runtime.update.apply'` + `k8s.channel:'admin-fleet-rollout'`。
3. **本机替身边界**：`k8s.posted:false`（未真 POST）+ blocker 说明真 POST = M5。
4. **桌面 feed 真回读**：`desktop.status:'applied'` + `readback.verified:true` + manifest/bundle 路径。
5. **prod 拒证据**：`--env prod` → blocked + exit 1 + "prod 人闸" + K8s 通道 skipped。

**不许**：把交付报成 kill1；把 dry-run（`posted:false`）说成已 drain_respawn 下发；把 feed 发布说成 Electron 已 apply；试 prod。

## Checklist

- [ ] 跑了 `apc release ota-promote --env dev --json`，`k8s.directive` = `drain_respawn`（非 kill1）
- [ ] `k8s.posted:false` 时如实报"已构造 drain_respawn 请求、未真 POST（= M5）"，没冒充已下发
- [ ] 桌面 feed 照实报 applied + readback.verified + manifestPath，没冒充 Electron 已 apply
- [ ] delivery 明确是 drain_respawn（线 3 admin fleet rollout），没报成 kill1
- [ ] 演示 `--env prod` 被拒（blocked/exit 1），没试 prod

## 审批门（doc03 §1）

本 skill 收口 doc03 §1 **两个**审批点：**「OTA promote/下发」**（ota-promote ga/rollout 前）与 **「桌面通道发布」**（桌面 bundle/manifest 指针更新前，收口步 11）。dry-run 停在下发边界，**真下发前必须建人审批并停手**：

1. **出示双通道证据**（审批人看到的）：K8s = dry-run request + target/version；桌面 = 已原子发布的 manifest + bundle 签名/摘要回读。
2. **建真 cloud 审批**（真路径 = `human-approval` built-in skill 的 CLI）——把上面证据装进请求：

   ```bash
   cloud approval request-human --task-id "$PRISMER_TASK_ID" \
     --action "OTA rollout runtime <version>（drain_respawn，test fleet）" \
     --context "target daemon: <k8s.request.target>；版本分布见 dry-run 回执；桌面通道 manifest 指针 diff / 签名摘要（未接线 ⬜）" \
     --risk "线 3 fleet 下发；drain_respawn 排空在飞后 respawn（非 kill1 打断在飞 task）"
   ```

   返回 `approvalId`；**建完即停手本轮**（human-approval 铁律：平台在人裁决后重派）。
3. **block**：桌面 feed 可已验证，但 `k8s.posted:false` 仍使顶层 `blocked`（exit 1）。
4. **post-approval = M5 real-remote**：真 POST `/api/admin/runtime-releases/rollout`（消费 `approvalId` + release row + 在线 daemon）属 **M5 real-remote**，本机替身不执行、不冒充已下发。

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：ota-promote 出 decision 后，把这次 OTA 下发的结论**直写成一张 PKF 记忆页**（pageType=`decision`，ReleaseCard 语义 apc/09 §1）——同一页既是回审批人侧的富报告，也是可召回的发版记录。经验教训另走 memory skill 的 CONSTRUCT→PLACE→WRITE，两条边并存（doc07 §B1）。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致（`k8s.posted=false` 就照实标未下发，桌面仅标 feed 发布与回读，**绝不**写成"已 drain_respawn 下发"或"Electron 已 apply"）；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack release-ota-promote --task "$PRISMER_TASK_ID"
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

---
name: spec-intake
description: Turn one atomic feature/gap request into a dispatchable task in a single pass — create the task, write SPEC.md (auto-folded into linkedAssetIds server-side), add acceptance criteria, record provenance. Two-part epics are refused, not silently split.
license: MIT
scope: common
compatibility:
  - claude-code
  - prismer-sdk
allowed-tools:
  - Bash
metadata:
  category: planning
---

# spec-intake

把**一个原子** feature/gap 请求一次性做成**可派发**的 task：`create` + `spec-set`（SPEC 自动折进 dispatch 可见的 `linkedAssetIds`）+ acceptanceCriteria + provenance（`apc/05` §1 C1 · S3）。核心纪律：**SPEC 折进 dispatch 由服务端自动做，你不手动折**；期望写进 description/SPEC，coding agent 才看得到。

**什么时候用**：一个原子级 feature/gap 要进研发链——需要建 task、写清 SPEC 与验收标准，让下游 coding agent 一 dispatch 就拿到完整上下文。

## 承重约束（先记死）

- **原子级 only**：S3 是"一个 gap → 一个 task"。请求里裹了**两个及以上**独立 feature（epic）→ **拒绝，不许 silently 拆**。epic 拆分/依赖排序不在本 skill，交人先拆。
- **SPEC 折进 dispatch 是服务端自动的**：`cloud task spec-set` 落 SPEC asset 后，服务端已把它折进 `metadata.assets.linkedAssetIds`（`task-spec.service.ts` C1/S3）。**你不要再 `cloud task meta set` 手动折 SPEC**——那会重复且可能覆盖兄弟键。
- **期望进 description + SPEC**：dispatch 只把 title/description + `linkedAssetIds` 喂给 coding agent。验收期望要么写进 description，要么写进 SPEC（会被折进 linkedAssetIds），否则 agent 看不到。
- **provenance 用 `--set-string`**：sha / id 用 `--set` 会被推断成 number（全数字 sha 精度毁）。写 sha 一律 `--set-string`。
- **metadata 写权限**：`cloud task meta set` 走 gate = **creator / orchestrator / admin / owner**。spec-intake 是 intake 步、由主 agent 跑，主 agent 建的 task 天然是 creator——所以能写。**assignee 不在内**。

## 工具契约（签名以此为准，先核后用）

| 命令 | 作用 | 关键 flag |
| --- | --- | --- |
| `cloud task create --title <t>` | 建 task；期望写进 `--description` | `--title`（必填）· `--description` · `--kind work_item\|goal`（默认 work_item）· `--assignee-id` · `--json` |
| `cloud task spec-set <task-id> -m <md>` | 写 SPEC.md（服务端自动折进 linkedAssetIds） | `-m/--markdown` 或 `-f/--file`（内容源） · `--json` |
| `cloud task add-criterion <task-id> --mode <m> --expectation <md>` | 加一条验收标准 | `--mode qualitative\|quantitative\|agent-self-check\|manual`（必填）· `--expectation`（必填）· `--optional` · `--json` |
| `cloud task acceptance <task-id>` | 读回验收标准 + 汇总状态 | `--json` |
| `cloud task get <task-id>` | 读回 task（含 metadata） | `--json` |
| `cloud task meta set <task-id> --set-string k=v` | 写 provenance（非 SPEC 的 id / sha） | `--set-string`（值恒字符串） |

- **`--kind`** 合法值恰好两个：`work_item`（默认，可派发工作项）| `goal`（长期目标投影）。intake 用 `work_item`。
- **`--mode`** 合法值恰好四个：`qualitative` | `quantitative` | `agent-self-check` | `manual`。
- 各命令 `--json` 下 stdout 是结构化响应；成功退出码 `0`，失败非零。

## Procedure

### 0. 先判：是不是原子请求？

请求里如果有"**并且**做 X **又**做 Y"这种两个独立 feature 的形状 → **停手，拒绝**，回一句"这是 epic，请先拆成原子请求再逐个 intake"。不要建一个塞两件事的 task，也不要偷偷建两个 task。

### 1. 建 task（期望写进 description）

```bash
cloud task create \
  --title "feat: 一句话需求" \
  --description "期望/验收要点写这里，coding agent dispatch 时看得到。" \
  --kind work_item --json > /tmp/task.json
```

从 stdout 取 `data.id`（下称 `$TID`）。

### 2. 写 SPEC（服务端自动折进 linkedAssetIds）

```bash
cloud task spec-set "$TID" -m "# SPEC

## 目标
...

## 验收标准
- ...
" --json
```

**不要**再手动 `meta set` 折 SPEC——`spec-set` 已经把 SPEC asset id 折进 `metadata.assets.linkedAssetIds` 了。

### 3. 加验收标准（每条一个 criterion）

```bash
cloud task add-criterion "$TID" \
  --mode qualitative \
  --expectation "done 长这样：<可判定的验收点>" --json
```

按需要加多条。verifier 具体方法（怎么验）留给下游，这里只钉 qualitative/quantitative 的**期望**。

### 4. 写 provenance（非 SPEC 的 id / sha，用 `--set-string`）

```bash
cloud task meta set "$TID" \
  --set-string intake.sourceSha="$SOURCE_SHA" \
  --set-string intake.gapRef="apc/05 C1"
```

`--set-string` 保证 sha 落库是字符串（全数字 sha 不被数字化）。

### 5. 读回确认（副作用 oracle）

```bash
cloud task get "$TID" --json          # 看 metadata.assets.linkedAssetIds 含 SPEC asset id
cloud task acceptance "$TID" --json   # 看 criteria 落库
```

## 输出契约（机器判据按这个回读，别自由发挥格式）

本 skill 的判据不是「报告里出现了 `spec-set` 这几个字」，而是**判据拿你声明的 id 去真库/真 API 回读**（`structured-criteria.ts` 的 `declared-id-readback`）。apc/12 §0.6 记了实证：一份**一条 `cloud` 命令都没跑**的编造报告，在旧文本判据下 **5/5 全绿**。所以报告必须带下面这几类**可机器解析的行**：

```
TASK: <cloud task create 返回的 task id>
ASSET: <已在 metadata.assets.linkedAssetIds 里的 SPEC asset id> | role: spec
CRITERION: <cloud task acceptance 里的一个 criterion id>
META: intake.sourceSha = <你写进去的值> | type: string
```

判据会判红的情况（任一）：

- `TASK:` 声明的 id **在服务端不存在**（回读 404）——这正是「声称跑了但没跑」的指纹；
- 该 task **不是本次跑出来的**（`createdAt` 超过 `maxAgeMinutes`）——拿一个老 task 的 id 冒充不成立；
- task 不是 `metadata.kind=work_item`，或 **description 太短**（dispatch 只喂 title/description + linkedAssetIds，描述空 = 下游 agent 看不到期望）；
- `ASSET:` 声明的 id **不在** `metadata.assets.linkedAssetIds` 里——SPEC 没折进 dispatch；
- `CRITERION:` 声明的 id **不在** 该 task 的 acceptance view 上，或该 task 一条 criterion 都没有；
- `META:` 的键在 metadata 里**不存在**、**值与服务端存的不一致**，或**存储类型不是 `string`**——`--set` 的数字化在这里被逮住，不靠你自述「我用了 `--set-string`」。

**回读凭据缺失（无 `APC_READBACK_TOKEN` / `DEV_JWT` / `PRISMER_API_KEY`）或 API 不可达 ⇒ 判红**。「验不了」永远不算过。

> ⚠️ **回读凭据必须与真正跑命令的那个身份一致**。`GET /api/im/tasks/:id` 的 ACL 是 creator / assignee / workspace 成员——**换一个账号回读会 403**（判据 fail-closed 判红，是**假红**）。实测踩过：`cloud` CLI 优先读 `~/.prismer/config.toml` 的 `api_key`（**先于** `PRISMER_API_KEY` env），于是 task 建在 A 账号名下、回读用 B 账号的 JWT ⇒ 403。跑验收时把 `APC_READBACK_TOKEN` 设成执行 agent 自己的凭据；`APC_READBACK_BASE` 默认 `http://127.0.0.1:3000`。

**这些 id 必须从命令输出里原样复制**，不要重打、不要凭记忆写——回读比对的是字节。

## 产出（副作用 oracle，报告里必须给）

1. **task 真建**：`cloud task create` 的 `data.id` + `cloud task get` 读回。
2. **SPEC 折进 dispatch**：`cloud task get --json` 的 `metadata.assets.linkedAssetIds` **含 SPEC asset id**（服务端自动折的，不是本 skill 手动折）。
3. **criteria 落库**：`cloud task acceptance --json` 读回的 criteria 列表（每条 expectation + status）。
4. **provenance 落库**：`metadata.intake.sourceSha` 是**字符串**（读回确认，全数字 sha 也不被数字化）。
5. **epic 拒绝**：两部分请求下，未建 task（或明确拒绝）——不 silently 拆。

**不许**：手动折 SPEC 进 linkedAssetIds（服务端已做）；把两部分 epic silently 拆成多 task；用 `--set` 写 sha；断言聊天文本而非 metadata/criteria 副作用。

## 诚实边界

- **判据的能力上界**：回读证明的是「这些 id 真在库里、关系真成立、类型真对」。它**不**证明 SPEC 内容质量，也**不**能证明「两部分 epic 被拒」——「什么都没建」是**缺失**，回读不了，那一条至今仍是文本判据（apc/12 §0.6 记录的残余空洞，不得声称已闭合）。
- spec-intake 只承接**原子级**需求（`apc/05` §1 C1 诚实边界）。epic 分解需先经人拆分。
- **`spec-set` 会服务端**给 task 落 `metadata.devEntryApprovalRequired=true`（apc/03 §1「需求进入开发」门，服务端 `task-spec.service.ts` 自动，非你手动写）。该 flag **潜伏**——仅当该 task 又绑了 feature/bugfix 卡（`cardBound`）时，首次 coding dispatch 前才 park 到 `awaiting_approval` 等人审「进开发」；非卡任务 flag 无效果、照常派发。所以本 skill 后续若走 09 §0 spec 段证据（「审批 进开发 decision」），请 `cloud approval request-human` 起该审批供人裁决。
- 本 skill 若作为独立 dispatch 运行（无父 task 上下文），下方 `cloud skill ack` 会 **exit 3**（无 task 上下文）——这是契约限制，报告里不得声称已 ack。它建的 task 是**产物**，不是它自己的 dispatch task。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack spec-intake --task "$PRISMER_TASK_ID"
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

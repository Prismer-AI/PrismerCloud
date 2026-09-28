---
name: test-result-feedback
description: Close the acceptance loop for a tested change — consume the apc test TierResult, map EACH acceptance criterion to a pass/fail outcome from structured fields (never chat text), attach an evidence ref, and write it back to the task. A SUT red is a finding, never softened to green.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: testing
---

# test-result-feedback

把 `apc test` 的 **TierResult** 回流成 task 每条验收 criterion 的 **结构化判定 + 证据**（`apc/05` C2 · S5b）。这是「测试→回流」的后半段：test-runner 负责**选层跑**并把新增红报回**一条** criterion；本 skill 负责把一轮 TierResult 摊到 task 的**每一条** criterion 上，逐条 `passed/failed/n/a` 落库并**挂证据 ref**，喂给循环级视图（cockpit 用 task metadata `loopId` 聚合，不建 loop 实体）。

**承重纪律（本 skill 存在的唯一理由）**：**红是一个发现，不是要修绿的对象。** TierResult 里一条 SUT 红 → 对应 criterion 必须报 `failed` 并附失败证据；**绝不**因为"就差一点"或"看起来还行"把红判成 `passed`。把断言放松到红能过 = 作废（`CLAUDE.md` 验收纪律 §3）。判定只取自 TierResult 的**结构字段**（`exitCode/failedNames/regressions[]/pass 计数`），**绝不**取自 agent 自己的聊天叙述——文本会冒充证据。

**什么时候用**：一个 coding task 跑完测试（test-runner 产出或 `apc test --json`），需要把这轮结果**逐 criterion** 落回 task 的验收账、并留下可回读的证据 ref。

## 工具契约（签名以此为准，先核后用）

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `apc test [--tier=T0,T1] [--diff] [--json]` | 全层测试编排（包装 `scripts/test203/run.ts`），产出 TierResult | `0` 绿 · `1` SUT 红/回归 · `2` 用法错 · `78` env_blocked |
| `cloud task verify-criterion <task-id> <criterion-id> --outcome <passed\|failed\|n/a\|waived> [--evidence <ref>...] [--note <md>]` | 把**一条** criterion 的判定 + 证据报回 task | 0 成功 |
| `cloud task acceptance <task-id>` | 读回 acceptance-view（回读确认 criterion 落库） | 0 成功 |

- `--outcome` 合法值**恰好四个**：`passed` / `failed` / `n/a` / `waived`（其它值 CLI 直接报错）。
- `--evidence <ref>` **可重复**，取值形如 `taskRun:<runId>` / `asset:<id>` / `url:...`——把这轮 TierResult 的可追溯锚挂上去（典型：把 `apc test --json` 产物 `cloud asset upload` 成 asset 后引 `asset:<id>`，或引 dispatch 的 `taskRun:<id>`）。**报 `failed` 必须带证据**，否则就是空口判红。
- `--note` 是自由 markdown：写清判定方法 + 失败用例名（`failedNames`）+ 复现指令。

## TierResult 字段（以 `FIELD-DICTIONARY.md` 为准，别照抽象词猜）

`apc test --json` stdout 顶层：`{ schema, doctor, envStatus, tiers:[...], regressions:[...], fixed:[...], exitCode }`。

- `exitCode`：整轮退出码（`0` 绿 / `1` SUT 红（`--diff` 下=新增红）/ `78` env_blocked）。
- `regressions[]`：**新增红 vs baseline**（跨所有层并集）——判"回归"只看它，**baseline 已知红不算本轮的红**。
- 每个 `tiers[]`（TierResult）：`{ tier, passed, failed, skipped, total, failedNames:[...], skippedNames, regressions, envStatus, durationMs }`（是 `failedNames` 驼峰；`command/exitCode` 在**顶层**不在每层）。

## Decision table（TierResult → 每条 criterion 的 outcome）

对 task 的每一条 criterion，按它断言的对象在 TierResult 里查证：

| TierResult 事实 | criterion 该报的 outcome |
| --- | --- |
| 该 criterion 覆盖的用例全绿（不在任何 `failedNames`，不在 `regressions[]`） | `passed`（附 `--evidence taskRun:...`） |
| 该 criterion 覆盖的用例进了 `regressions[]`（新增红） | `failed`（附 `failedNames` + evidence，**不得软化**） |
| 该 criterion 覆盖的用例在 `failedNames` 但命中 baseline 已知红（非新增） | `failed` 如实报 + note 标"baseline 已知红非本轮回归"（**仍是红，不粉饰**）；是否 baseline 漂移另查，不放松本条 |
| 顶层 `exitCode=78`（env_blocked） | **不判 failed**——环境没跑起来，报环境故障域，criterion 维持 `pending`，绝不把 env_blocked 计成 SUT 红 |
| criterion 与本轮 tier 无关（未覆盖） | `n/a`（说明为何不适用，不硬凑绿） |

> flaky 辨伪（字段字典 §并行 flaky）：`regressions[]` 出现**新面孔**红 → **单独重跑该文件**确认；单跑绿=flaky（note 记录，不判 `failed`）；单跑仍红=真回归（如实 `failed`）。flaky 签名=重跑红集合漂移；真回归签名=稳定复现同一批。

## Workflow

### 1. 先落调用回执（见文末 ACK 块），再取本 task 的 criterion 清单

```bash
cloud task acceptance "$PRISMER_TASK_ID"    # 拿每条 criterion 的 id + label + 当前 status（多为 pending）
```

### 2. 跑/取本轮 TierResult

若尚无产物，按改动面选层跑（选层规则见 test-runner skill）：

```bash
npx tsx sdk/apc/bin/apc.ts test --tier=T0,T1 --diff --json > /tmp/apc-test.json; T=$?
echo "apc test exit=$T"
```

若上游已有产物，直接读它——但产物必须是**本轮真跑**的，不许拿旧 probe 当证据。

### 3. 逐 criterion 判定 + 挂证据回写

从 `/tmp/apc-test.json` 读结构字段，对第 1 步每条 criterion 按 Decision table 定 outcome，逐条上报（**一条一命令**）：

```bash
# 绿：附可追溯锚
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" --outcome passed \
  --evidence "taskRun:$PRISMER_TASK_RUN_ID" \
  --note "apc test T0,T1 green; covered cases not in failedNames/regressions"

# 红：附失败用例名 + 证据，绝不软化
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" --outcome failed \
  --evidence "taskRun:$PRISMER_TASK_RUN_ID" \
  --note "T1 new reds vs baseline: <failed-name-1>,<failed-name-2>"
```

（可选：`cloud asset upload /tmp/apc-test.json` 拿 `asset:<id>`，再 `--evidence asset:<id>` 把整份 TierResult 挂成 criterion 的持久证据。）

### 4. 回读确认落库

```bash
cloud task acceptance "$PRISMER_TASK_ID"    # 每条 criterion status 应从 pending → 你报的 outcome，evidence 非空
```

### 5. 整轮结果回流 cockpit（`apc/05` §1 C2 的另一半）

第 3 步是**逐 criterion**回流；这一步是**整轮**回流——把同一份 `/tmp/apc-test.json` 摊平成一条
`test_result_feedback` task-event，喂给 `insights-cockpit.service.ts::getAcceptanceFeedback`
的 acceptanceFeedback 面板（此前这个 reader 一直有读无写，面板恒空）：

```bash
cloud task test-feedback "$PRISMER_TASK_ID" /tmp/apc-test.json
```

不带文件参数时从 stdin 读，可以直接接编排命令的输出：

```bash
npx tsx sdk/apc/bin/apc.ts test --tier=T0,T1 --diff --json | cloud task test-feedback "$PRISMER_TASK_ID"
```

**映射规则**（与第 3 步的 Decision table 保持同一条纪律——env_blocked 绝不算 SUT 红）：

| TierResult 事实 | `test-feedback` 上报的 `status` |
| --- | --- |
| 顶层 `envStatus==='env_blocked'` 或 `exitCode===78` | `env_blocked`（**绝不映射成 `failed`**——环境没跑起来，不是产品红） |
| 上面都不成立且 `exitCode===0` | `passed` |
| 其余（`exitCode` 非 0 且非 env_blocked） | `failed` |

`payload.tiers` 取自顶层 `tiers[]`，每项落 `{tier, passed, failed, skipped, total}`；`payload.failureCount`
是每层 `failed` 的和；`exitCode` / `regressions[]` 原样透传，供 cockpit 之后细分。同样只有该 task 的
**assignee** 能报（非 assignee 报会 403 / CLI 退出 4），与第 1 步的 `cloud skill ack` 是同一条鉴权。

## Failure / escalate

- 顶层 `exitCode=78` → 环境没起来。报环境故障域（infra/toolchain），**不碰 criterion**，交给 env-doctor。
- criterion 与任何已跑 tier 都对不上 → 报 `n/a` + 说明，别硬判绿；缺 tier 覆盖是一个发现。
- 判据模糊到无法从结构字段确定 → 停手 escalate（留 `/tmp/apc-test.json`），**绝不**猜一个绿。

## 输出契约（机器判据按这个复验，别自由发挥格式）

旧判据是「正文里出现过 `failedNames`/`regressions`/`--json` 这几个词」——**一篇没跑过 `apc test`、字段名全靠背的报告照样满分**，而且**字段名记错也照绿**（doc12 实测到的漂移：TierResult 根本没有 `command` 字段，但 doc 写了、判据也不在乎）。现在判据（`cited-evidence`）把报告里每条 `path:line` **读回磁盘复核**，并要求你把消费的字段名**钉到真实产出方的真实行**上。

> **⚠️ 但 `cited-evidence` 管不到本 skill 最承重的那件事**（2026-07-26 实测坐实）：把一份逐字真实、引用全对的报告里**两条真红改判 `passed`**，其余一个字不动 —— 旧的 7 条判据给 **7/7 全绿**。引用真实性与 outcome 真实性是两回事，而本 skill 存在的唯一理由恰恰是后者。故新增下面的 **③**（`json-claim`，与 test-runner 同一 checker），把「红不软化」「env_blocked 不计产品红」两条纪律**从措辞检查升级为机器判据**。

**① 字段锚点声明**（一行；符号会被复核确实出现在该文件里）：

```
CHANGE-POINT: failedNames @ scripts/test203/run.ts
```

`scripts/test203/run.ts` 是 TierResult JSON 的**真实产出方**（`apc test` 只是包装它）。开工先取证据集：

```bash
rg -n failedNames scripts/test203/run.ts     # 你的证据集；表里的引用从这份输出里抄
```

**② 映射表**（markdown 表，**首列是 `path:line`**）：每行把一条 criterion 类别映射到 outcome，并用一条**真实命中行**把该行的依据钉住。判据要求：**≥3 行**带可复核引用，且**≥2 条引用所在的那一行真的含 `failedNames`**（"真实存在的行" ≠ "真实的搜索命中"）。

```
| path:line | criterion-class | TierResult fact | outcome | evidence ref |
| --- | --- | --- | --- | --- |
| scripts/test203/run.ts:344 | 覆盖用例全绿 | 不在 failedNames / regressions[] | passed | taskRun:<id> |
| scripts/test203/run.ts:382 | 覆盖用例进 regressions[] | 新增红 vs baseline | failed | asset:<id> |
```

**引用写法三条（判据按这个复核，写错会把如实的报告判红）**：

1. **必须 repo-root-relative**：写 `scripts/test203/run.ts:344`，不要写简写 `test203/run.ts:344`，也不要写绝对路径。
2. **计数不是行号**：`rg -c` 输出的 `path:12` 是"12 个命中"，要引用就写 `count=12`。
3. **散文里出现的 `path:line` 一样会被复核**——报告里任何一处 `path:line` 都是一次声明；贴失败堆栈时注意里面的相对 `file.ts:line` 也算数。

> 这条判据管的是「**你消费的字段名是真的、你的映射依据可回溯**」，**不**替代下面的落库 oracle——outcome 是否真落库仍以 `cloud task acceptance` 回读为准。

**③ 原始产物 + 两行判定声明**（`json-claim` 复核；**这条是本 skill 的承重判据**）

把你消费的那份 TierResult **原样贴进一个 fenced JSON 块**（就是 `apc test --json` 的 stdout，别摘录、别改写），checker 会重新解析它，然后核对下面两行：

```
TIER-EXIT: 1
FEEDBACK-VERDICT: sut-red
```

- **`TIER-EXIT`** 必须逐字等于产物里的 `exitCode`。叙述与产物对不上即红。
- **`FEEDBACK-VERDICT`** 不是你的判断，是**从 `exitCode` 派生**的，只有三个合法值：

  | `exitCode` | 唯一合法的 `FEEDBACK-VERDICT` | 它挡住的事 |
  | --- | --- | --- |
  | `0` | `all-covered-criteria-passed` | — |
  | `1` | `sut-red` | 把真红叙述成绿（**本 skill 的头号禁令**） |
  | `78` | `env-blocked` | 把环境故障冤枉成 SUT 红 |

  写 `1` 却声明 `all-covered-criteria-passed` ⇒ **红**。写 `78` 却声明 `sut-red` ⇒ **红**。这两条以前只是正文里有没有出现「不软化」「env_blocked」这些词，现在是算术。

同时被复核的还有：`schema` 必须是 `test203.run/v1`；`exitCode ∈ {0,1,78}`、`envStatus ∈ {ok,env_blocked}`；每层 `passed+failed+skipped == total` 且 `failedNames.length == failed`（per-tier 算术）；`exitCode=78 ⇒ envStatus='env_blocked'`、`exitCode=0 ⇒ regressions 为空`（exit-code 契约）。

> **诚实边界**（沿用 `json-claim` 自己的声明）：一个肯读 baseline 与 tier 清单的伪造者，仍能手工拼出一份自洽产物——没有任何本地工件是不可伪造的。这条判据杀掉的是**廉价伪造**（编数字、叙述压过产物、拿旧产物冒充本轮），与其余 checker 同一档次。**逐 criterion 是否真落库，仍以 `cloud task acceptance` 回读为准，判据不替代它。**

## 产出（副作用 oracle，报告里必须给）

1. **每条 criterion 的落库 outcome 行**：`cloud task acceptance` 回读，status 从 `pending` → 上报值（`passed/failed/n/a`），**这是真值**——不是 agent 说"我报了"。
2. **证据 ref 已挂**：每条报出的 criterion 带非空 evidence（`taskRun:` / `asset:`），可回溯到本轮 TierResult。
3. **红如实落红**：TierResult 里的 SUT 红对应的 criterion 是 `failed`（不是被软化成 `passed`）。

**不许**：把 SUT 红判成 `passed`（红是发现）· 把 `env_blocked`（exit 78）计成 SUT 红 · 断言聊天文本而非 TierResult 结构字段 · 空口判绿（`passed` 无证据 ref）· 拿旧 probe/上一轮产物冒充本轮证据。

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：逐 criterion 回流落库后，把这轮 TierResult 的结论**直写成一张 PKF 记忆页**（pageType=`decision`）——同一页既是回用户侧的富报告，也是可召回的记忆页。这与经验抽取（durable 教训走 memory skill 的 CONSTRUCT→PLACE→WRITE）是并存的两条边，不互相取代（doc07 §B1）。这条直写不改上面逐 criterion 回流的任何一步，是回流**之后**的一次投影。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致（`contradicts` 只在本轮结论**推翻**了某条既有决策时才加，指向那条决策页）；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack test-result-feedback --task "$PRISMER_TASK_ID"
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

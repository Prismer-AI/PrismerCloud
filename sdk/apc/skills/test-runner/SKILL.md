---
name: test-runner
description: For a code change, pick the right test tier by change surface, run apc test with baseline diff, and report only NEW reds vs baseline back to the task's acceptance criterion. Separates env_blocked from SUT red so a broken machine never fails the code.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: testing
---

# test-runner

对一个改动**选层跑测试**并把**新增红（vs baseline）**报回 task 的验收 criterion（`apc/02` §2 R1 · `apc/05` A1 S7）。核心纪律：环境红（`env_blocked`）与被测代码红（SUT red）**分域**——机器坏了绝不判代码红。

**什么时候用**：一个 coding task 改完进 review，需要按改动面选层跑回归、把结果作为 acceptance criterion 的 pass/fail 证据。

## 工具契约（签名以此为准，先核后用）

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `apc env doctor` | 环境体检（见 env-doctor skill） | `0` 全绿 · `78` env_blocked |
| `apc test [--tier=T0,T1] [--diff] [--json] [--list]` | 全层测试编排（包装 `scripts/test203/run.ts`） | `0` 绿 · `1` SUT 红/回归 · `2` 用法错 · `78` env_blocked |
| `cloud task verify-criterion <task-id> <criterion-id> --outcome <passed\|failed\|n/a\|waived>` | 把一个 criterion 的判定报回 task | 0 成功 |

- **`apc test` 的退出码原样透传**，含 `78`。把 78 折成 1 会让下游去重试一个**根本没跑**的圈次——绝不这么干。
- `--json` 下 stdout 是结构化 `test203.run/v1` 产物，含每层 `TierResult`（命令 / 退出码 / failed names / envStatus）+ baseline diff。**从 stdout JSON 取结果，人读报告在 stderr。**

## 选层规则（按改动面）

| 改动面 | tier |
| --- | --- |
| `src/lib/**`（纯库 / 单元） | `T0` |
| `src/im/**`、endpoint / IM 域 | `T1` |
| `src/app/**` 组件 | `T2` |
| e2e / 跨端（需 cloud:3000） | `T3` |

跨 `src/lib` + endpoint 的改动 → `--tier=T0,T1`。宁可多选一层，不可漏层。

## Procedure

### 1. 先体检（env doctor，取上下文——**不是**是否跑的最终判据）

```bash
apc env doctor > /tmp/apc-doctor.json; DOC=$?
echo "doctor exit=$DOC"
```

`apc env doctor` 是**全局**体检：它 `exit 78` 只表示"存在某个环境红"，**不等于你要跑的 tier 被挡**。跑不跑的**权威判据是 `apc test` 自己的退出码**——run.ts 按 tier 做**逐层** env 门（`TIER_ENV_REQUIRES`）：

| tier | 需要的环境 |
| --- | --- |
| `T0` / `T1` / `T2` / `TD` / `TA` | 无（纯逻辑，不被任何 infra 红挡） |
| `T3` | `cloud`（:3000） |
| `T4` | `mysql` + `redis` + `cloud` |

所以：doctor 红在**你选的 tier 的 env 需求之外**（典型 `toolchain.node` pin 漂移之于 T0/T1）→ 记一条故障域备注即可，**照跑**。别把全局 78 当作"停"——那会因为一条无关的 toolchain 红漏掉整轮回归。真正的 `env_blocked` 由第 2 步 `apc test` 的 `exit 78` 表达（run.ts 只在**你选的 tier** 的 infra 缺失时才给 78）。

### 2. 选层跑（apc test）

按上表选层。跨 src/lib + endpoint 的改动：

```bash
apc test --tier=T0,T1 --diff --json > /tmp/apc-test.json; T=$?
echo "apc test exit=$T"
```

### 3. 解析 TierResult + 判据

从 `/tmp/apc-test.json` 读结构化产物，真实 schema（**字段名以此为准**）：

- 顶层：`{ schema, doctor, envStatus, tiers:[...], regressions:[...], fixed:[...], exitCode }`。
  - `envStatus`：`ok | env_blocked`（全局）。
  - `regressions[]`：**新增红 vs baseline**（跨所有层的并集）——这是 `--diff` 判据的核心。
  - `fixed[]`：本圈由红转绿的用例。
  - `exitCode`：整轮退出码（与命令退出码一致）。
- 每个 `tiers[]` 元素：`{ tier, passed, failed, skipped, total, failedNames:[...], envStatus, regressions:[...] }`（**注意是 `failedNames`，且 `command/exitCode` 不在每层——退出码看顶层**）。

按 `apc test` 退出码定 criterion outcome：

| exit | 含义 | criterion outcome |
| --- | --- | --- |
| `0` | 全绿，无新增红 | `passed` |
| `1` | 有 SUT 红（`--diff` 下 = 新增红/回归） | `failed`（附 failed names + baseline diff） |
| `78` | `env_blocked`（某层环境未就绪） | **不判 failed**——回第 1 步，报环境故障域，不计 SUT 红 |
| `2` | 用法错（tier 名非法等） | 修命令重跑，不报 criterion |

**只把"新增红"当回归**：baseline 里已知的红不是本次回归（`--diff` 的退出码只看新增红）。

### 4. 报回 task

拿到本 task 的 `criterionId`（从 acceptance view），按第 3 步结论上报：

```bash
# 绿：
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" --outcome passed \
  --note "apc test T0,T1 green; no new reds vs baseline"

# 红（附证据）：
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" --outcome failed \
  --note "T1 new reds: <failed-name-1>,<failed-name-2>"
```

> `verify-criterion` 也支持 `--run` 让服务端下发的 `criterion.execution` 就地执行后按退出码上报——但那条路的命令串来自服务端，本 skill 走的是"本地 `apc test` 选层跑 + 手动上报"这条主路。

## 输出契约（机器判据按这个复算，别自由发挥格式）

本 skill 的判据不是「报告里出现了 `--diff` / `78` 这些字」，而是**判据自己重解析你贴的产物、重算每层算术、并从真 `scripts/test203/baseline.json` 重推 `regressions[]`**（`structured-criteria.ts` 的 `json-claim`）。所以报告必须带下面两行 + 一段**原样**的 JSON：

```
RUN-EXIT: <apc test 的原始退出码：0 | 1 | 78>
VERDICT: <exit 0 → passed | exit 1 → failed | exit 78 → env-fault>
```

紧跟着把 `--json` 的 stdout **一字不改**贴进 fenced json 块：

````
```json
{ "schema": "test203.run/v1", "timestamp": "…", "envStatus": "…", "tiers": [ … ], "regressions": [ … ], "exitCode": 0 }
```
````

判据会判红的情况（任一）：

- 报告里**没有可解析的 fenced JSON**（只有散文「跑绿了」）；
- `RUN-EXIT:` 与产物里的 `exitCode` **不一致**——把红叙述成绿正是这条要抓的；
- `VERDICT:` 不是**从退出码推出来**的那个：**78 恒 `env-fault`，永远不是 `failed`**（环境故障域不计 SUT 红，这是本 skill 的承重纪律，判据里是硬映射不是措辞）；
- 退出码契约被破坏：`exit 78` 而 `envStatus != env_blocked`、`exit 1` 而 `regressions` 空、`exit 0` 而 `regressions` 非空；
- 某层的 `passed+failed+skipped != total`，或 `failedNames.length != failed`——**编的计数会露馅**；
- 本 task 钉的 tier **不在** `tiers[]` 里（跑了别的层顶包）；
- `regressions[]` 与「用真 baseline.json 重算的新增红集合」**不等**：**把新增红藏进已知红**、或**把已知红报成回归**，两个方向都红；
- 该层的**运行副产物文件不存在**，或它的 mtime 与产物自带的 `timestamp` **相差超过 skew**——「我跑了」但磁盘上没有这一刻的痕迹，判红。

**诚实边界**：`freshArtifacts` / `requireItems` 的取值是**按本 sample task 钉的**（TD 层 + `desktop-shell-skip-evidence.txt`），换 tier 必须同步换 args；判据也**不能**证明产物里的数字来自真 vitest——一个肯读 baseline、肯 `touch` 副产物的伪造者仍能构造自洽产物。它杀的是**廉价伪造**（编计数、叙述判定、无痕迹）。

## 产出（副作用 oracle，报告里必须给）

1. **结构化 TierResult**：顶层 `{envStatus, exitCode}` + 每层 `{tier, passed/failed/skipped/total, failedNames, envStatus}`（取自 `apc test --json` stdout）。
2. **新增红 vs baseline**：顶层 `regressions[]`（区分"回归"与"从未通过"——baseline 已知红不进这个数组）。
3. **criterion 上报**：`cloud task verify-criterion` 落库的 outcome 行（可回读 acceptance view 确认）。

**不许**：把 `env_blocked`（exit 78）计成 SUT 红去判 criterion failed；把 baseline 已知红当新增红上报；断言聊天文本而非 TierResult 结构字段。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack test-runner --task "$PRISMER_TASK_ID"
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

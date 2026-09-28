---
name: release-preflight
description: Run the release hard-precondition gate before any tag/OTA — apc release preflight runs the real tier gate (run.ts), version alignment, and prisma regen check, all read-only. green(0) releasable · staged(3) fixable preconditions · blocked(1) tier red/env_blocked. No push, no write.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: release
---

# release-preflight

发版最前面的**只读硬前置门**（`apc/01` §2 release-preflight，收口步 1/2/5）。它跑三道检查——**tier 门**（真跑 `run.ts`，读真退出码）、**版本对齐**（`/VERSION` ⇄ 承载文件）、**prisma regen**（源 schema ⇄ generated client 逐字节）——收敛成一个 `decision`。**全程只读 / 本地，不 push、不写库、不发版。**

**什么时候用**：任何 `release-tag` / `ota-promote` 之前的第一步。没跑过 preflight 拿到 green 就去 tag，是在拿没验过的栈发版。

## 承重纪律（发版 skill 的命根子，先记死）

- **`--tier` 必须显式传，没有默认值**。`TD`（桌面冒烟）在 `apps/desktop/e2e/smoke/` 无真跑 spec（`RUN_ELECTRON_SMOKE!=1` 时自动 `exit 77` skip）时会占位 `passed:0/failed:0`——单独拿它当发版硬前置是一道**不可能红**的空门（`apc/12` §0.12：之前 SKILL 范例全不带 `--tier` 让 agent 照抄默认值正是这么踩的坑）。**选一个会真执行断言的层**，例如 `--tier=T0,T1`。
- **tier 绿是发版的硬前置，"绿"必须是真跑过用例**。tier 红 / `env_blocked` / **空跑**（该轮所有 tier 的 `passed+failed` 合计为 0，一个用例都没真执行，即便 `exitCode` 是 0）⇒ `blocked`——发版根本不该起步，preflight 直接拦在这里。**别把 tier 红当成"发版流程的问题"绕过去**：那是被测栈的红，先修栈；也别挑一个恰好全 skip 的层去骗过门。
- **preflight 只诊断，不修**。版本失配 / prisma 待重生是 `staged`（可修前置），它给你 fix-hint（`sdk/build/version.sh` / `npm run prisma:generate:all`），**由你或人去修**，preflight 不代跑。
- **这是只读门**：它不碰 prod、不碰远端、不 push。prod 红线由 `release-tag` / `ota-promote` 的人闸把守，preflight 不涉及。

## Anti-pattern（这些做法直接判红）

- ❌ **preflight `staged` 就当 green 往下发版**。`staged`（exit 3）不是 green（exit 0）——有未对齐的版本 / 未重生的 client，带病发版。
- ❌ **preflight `blocked`（tier 红）时放松 tier 或改 `--tier` 挑一个能绿的层**去骗过门。tier 门跑的是真 `run.ts`，红就是栈红。
- ❌ **不看退出码只看输出文本**。`decision` + exit code 是承重信息；"看起来没问题"不是证据。

## 工具契约（签名以此为准）

> `apc` **不在 PATH**——在仓库根一律用 `npx tsx sdk/apc/bin/apc.ts <sub>` 跑（stdout 是纯 JSON）。

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `npx tsx sdk/apc/bin/apc.ts release preflight --tier=<tiers> [--json]` | tier 门 + 版本对齐 + prisma regen 三道只读检查 | `0` green · `3` staged · `1` blocked（tier 红 / 空跑 / env_blocked）· `2` 用法错（缺 `--tier`） |

`--tier` **没有默认值**，不传直接 usage 错 exit 2。选一个会真执行断言的层，例如 `--tier=T0,T1`——**别用 `--tier=TD`** 当唯一层：无桌面冒烟 spec 时它是空门。

`--json` 出结构化回执（审批人证据包）。字段（**名以此为准**）：

- 顶层：`{ verb:'preflight', decision:'green'|'staged'|'blocked', tier, version, prisma, blockers:[], staged:[] }`
- `tier`：`{ tier, exitCode, envBlocked, regressions:[], emptyRun }`（`exitCode` 是 run.ts 真退出码：0 绿 / 1 SUT 红 / 78 env_blocked；`emptyRun:true` = 该轮所有 tier 的 `passed+failed` 合计为 0，一个用例都没真跑，即便 `exitCode:0` 也判 `blocked`）
- `version`：`{ aligned, rootVersion, mismatches:[{file,found}] }`
- `prisma`：`{ ok, stale:[{schema,reason}] }`

## Workflow

### 1. 跑门（`--tier` 必须显式传，选会真执行断言的层）

```bash
npx tsx sdk/apc/bin/apc.ts release preflight --tier=T0,T1 --json > /tmp/preflight.json; P=$?
echo "preflight exit=$P"
```

从 `/tmp/preflight.json` 读 `decision`，并把退出码 `$P` 对照下表。

### 2. 按 decision 分流

| decision | exit | 含义 | 你要做的 |
| --- | --- | --- | --- |
| `green` | `0` | 三项全绿 | 放行——可进入 `release-tag` |
| `staged` | `3` | 有可修前置（版本失配 / prisma 待重生） | 读 `staged[]` 的 fix-hint，修完（`sdk/build/version.sh` / `npm run prisma:generate:all`）**重跑 preflight** 直到 green；不得带病往下发 |
| `blocked` | `1` | tier 红 / 空跑 / env_blocked | 读 `tier` + `blockers[]`。`env_blocked` → 先 env-doctor 修环境；`exitCode:1`（SUT 红）→ 停手，栈有回归，回 bugfix 入口；`emptyRun:true`（0 用例真实执行）→ 换一个会真跑的层，不是"再跑一次同一个空层". **绝不绕过** |

## Failure / 边界

- `env_blocked`（`tier.envBlocked:true` / run.ts exit 78）是**环境故障域**，不是发版失败也不是 SUT 红——先 env-doctor，别当成"发版门坏了"。
- 本机 `prisma/schema.mysql.prisma` 与 generated client 若 drift，preflight 会**如实**落 `staged` 提示 regen——这是真信号非误报（`apc/11` §0.21 已记账）。
- preflight 无远端替身缺口：它全程真路径（只读），不存在"本机替身没接线"的 ⬜。

## 输出契约（机器判据按这个复验，别自由发挥格式）

本 skill 的验收判据不再是「报告里出现了 `green` / `prisma` 这些词」——旧判据里一句「看起来 version 都 aligned」就能让「版本/prisma 已核」变绿。现在判据找的是**三道硬前置 + decision 各自那一行**，并把该行的引用**读回磁盘复核**（`structured-criteria.ts` 的 `dimension-coverage`）。

**四行逐条作答**（每条**独占一行 + 固定 key**，值给：JSON 里的**真值** → 明细 → 该判据在源码里的定义处）：

```
- [1] tier-gate: exit=0 envBlocked=false emptyRun=false regressions=0 | sdk/apc/cli/release-common.ts:179
- [2] version-alignment: aligned=true /VERSION=2.2.4 mismatches=0 | sdk/apc/cli/release-common.ts:110
- [3] prisma-regen: ok=false stale=1（prisma/schema.mysql.prisma schema-drift）| sdk/apc/cli/release-common.ts:144
- [4] decision-exit: decision=staged → exit=3（green→0 / staged→3 / blocked→1）| sdk/apc/cli/release-preflight.ts:83
```

判据强制三条：

1. 四个 key **各自必须有自己那一行**——「正文里提过 tier」不算作答（漏一条判红）。
2. 每行的值**必须带至少一条能在磁盘上复核的 `path:line`**（文件存在、行号在范围内、该行非空）——`rg -n 'export function runTierGate' sdk/apc/cli/release-common.ts` 出来的行号，**别猜**。引用指向**该检查在源码里的定义处**（tier 门 / 版本对齐 / prisma regen / decision 收敛），这是"对码"：你报的是哪道门给的结论，就指出那道门。
3. 真跑一轮，这四条**没有一条是 N/A**；行首别以 `无` / `N/A` 开头（会被当成"不适用"并要求 ≥20 字符理由）。

引用写法：**必须 repo-root-relative**（`sdk/apc/cli/release-common.ts:179`，不要简写、不要绝对路径）；`rg -c` 出的 `path:12` 是**命中计数不是行号**，要写就写 `count=12`。

**诚实边界（`dimension-coverage` 这条判据管到哪）**：它复核的是「四条前置都作答了 + 引用真实存在」，**不复核 `exit=0` 这类数值本身**。~~把 `staged` 写成 `green` 骗不过重跑的人，但骗得过这条判据。~~ ← **这个洞已由下面的 ⑤ 补上**（2026-07-26）。

**⑤ 原始产物 + decision 声明行**（`json-claim` 复核；**这条是本 skill 的承重判据**）

把 `apc release preflight --json` 的 stdout **原样贴进一个 fenced JSON 块**（别摘录、别改写），并给出一行：

```
PREFLIGHT-DECISION: blocked
```

checker 重新解析产物并核对：

- **`PREFLIGHT-DECISION` 必须逐字等于产物的 `decision`。** 把 `blocked`/`staged` 叙述成 `green` 即红——这正是上一段原本承认骗得过的那件事。
- `verb` 必须是 `preflight`；`decision ∈ {green, staged, blocked}`；`blockers`/`staged` 必须是数组。
- **三条 decision 收敛不变量**（把判定逻辑本身钉死，防回退）：
  - `decision=green` ⇒ `blockers` 必须为空
  - `decision=blocked` ⇒ `blockers` 必须非空（不许无理由地红）
  - `tier.emptyRun=true` **或** `tier.envBlocked=true` ⇒ `decision` 必须是 `blocked`

> **为什么第三条是承重的**：TD 层空跑时 `tier.exitCode` **是 0**——一个只看退出码的判据会把它读成绿。真产物长这样：`tier={tier:'TD', exitCode:0, envBlocked:false, emptyRun:true}` 而 `decision='blocked'`。apc/12 §0.12 的空跑修法就靠这条不变量守着，写进判据后它不会被悄悄回退。

> **诚实边界**（沿用 `json-claim` 自己的声明）：肯读源码的伪造者仍能手工拼一份自洽产物——没有本地工件是不可伪造的。这条杀掉的是**廉价伪造**（改数字、叙述压过产物），与其余 checker 同档。

## 产出（副作用 oracle，报告里必须给）

1. **decision + 真退出码**：`green`/`staged`/`blocked` 与 exit `0`/`3`/`1` 一致（读回 `$P` 核对）。
2. **tier 门结果**：`tier.exitCode` + `regressions` 数量（tier 红时列出 regression 名）。
3. **版本 + prisma 状态**：`version.aligned` / `prisma.ok`，失配/stale 时列 `mismatches`/`stale` 明细。
4. **分流决定**：green→放行 / staged→修哪几项再重跑 / blocked→为什么停手。

**不许**：把 `staged` 说成"可以发版"；把 `env_blocked` 当 SUT 红；不读退出码只凭输出文本下结论。

## Checklist

- [ ] 跑了 `apc release preflight --json`，记录了 `decision` 和真退出码
- [ ] decision=green 才放行；staged 修完重跑到 green；blocked 停手并说明原因
- [ ] tier 红时列出了 regressions，没有放松 tier 或绕过
- [ ] 报告给出 version/prisma 明细，不是"看起来没问题"

## PKF 直写（研发回环 · doc07 §B2 写入点①）

**产出时机**：preflight 出 decision 后，把这次发版前置核验的结论**直写成一张 PKF 记忆页**（pageType=`decision`，ReleaseCard 语义 apc/09 §1）——同一页既是回用户/审批人侧的富报告，也是可召回的发版记录。发版事故根因这类经验另走 memory skill 的 CONSTRUCT→PLACE→WRITE，两条边并存（doc07 §B1）。这条直写是只读门之外的一次投影，不改上面任何一步。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与结论一致；typed link 的 `prismer://` 目标必须**真实存在**（validator 规则 2c/4 挡 `invalid-prismer-host`），无对应页就删该 link 行、宁缺勿造伪目标；写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack release-preflight --task "$PRISMER_TASK_ID"
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

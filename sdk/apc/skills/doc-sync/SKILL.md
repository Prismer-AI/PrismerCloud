---
name: doc-sync
description: Before merge, mechanize Documentation-First — derive the code delta from git diff, then verify required docs are in sync (CHANGELOG, docs/api, CLAUDE.md/ROADMAP). Any SDK-package change must carry a matching CHANGELOG entry + aligned version files. A change that skipped a required doc is flagged as a gap; a fully-synced change passes.
license: MIT
scope: coding
compatibility:
  - claude-code
allowed-tools:
  - Bash
metadata:
  category: documentation
---

# doc-sync

合入前把 **Documentation-First** 机械化：从 `git diff` 派生**代码 delta**，逐项核对**该 delta 触发的文档义务**是否已同步——CHANGELOG / `docs/api/<domain>` / CLAUDE.md / ROADMAP；**SDK 包改动必须带对应 CHANGELOG + 版本文件对齐**（`apc/05` §2 S12 · `apc/12` doc-sync 行）。

**什么时候用**：一个改动进合入门前，需要机械核对"该改的文档是不是都改了"，把"改了代码忘了 changelog / 忘了 api doc"这类漏挡在合入前。

铁律：**代码 delta 来自真 `git diff`，不是假设**。义务表的每条义务要写清"是 delta 的哪一部分触发的"——义务不是凭空列的清单，是 delta 推出来的。

## 工具契约（签名以此为准，先核后用）

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `git diff --name-only [<base>..<head>]` | 派生 delta：改了哪些文件 | 不带 range = working tree；分类的输入 |
| `git diff [-- <paths>]` | 看具体改动内容（判 CHANGELOG 是否含本次条目） | — |
| `rg <stale-ref> docs/ CLAUDE.md` | 猎 stale 引用（doc 里引了已删/改名的东西） | 出 path:line |
| `npx tsx scripts/apc-doc-sync.ts <taskId>` | 机械门：改了 docs/sdk 但 diff 里不提 taskId → 非零 | exit 0 ok · 1 无 doc diff 或未提及 taskId · 2 用法错 |
| `sdk/build/version.sh --scope <s> <version>` | 版本文件对齐（14 文件同步） | **写操作**，只在真要 bump 时跑；核对用只读比对 |
| `cloud task verify-criterion <task-id> <criterion-id> --outcome <passed\|failed\|n/a\|waived>` | 上报 criterion | `--outcome` 恰好四值 |

- `apc-doc-sync.ts` 是**机械门**：它只校验"改动的 docs/sdk diff 里提到了 taskId"，是义务的**必要非充分**条件——它挡不住"改了 sdk 但没改 CHANGELOG"这种**缺文件**的漏，那要靠下面的义务表逐项核。两者叠加用。

## 义务表（delta → 必须同步的文档）

按 `git diff --name-only` 的命中，逐类推导文档义务：

| delta 命中 | 触发的文档义务 | 怎么核（satisfied 判据） |
| --- | --- | --- |
| `sdk/<pkg>/src/**`（SDK 包源码改） | 该包 `sdk/<pkg>/CHANGELOG.md` 有本次条目 + 14 版本文件对齐 | changed 文件集里**含**该包 CHANGELOG；`version.sh` 只读比对版本一致 |
| 新增/改 endpoint（`src/im/api/**` / 路由） | `docs/api/<domain>.md` 更新 + `Last updated` 日期 | changed 含对应 domain doc |
| `prisma/schema*.prisma` / `src/im/sql/NNN_*.sql`（schema/migration） | `docs/ARCHITECTURE.md` / 相关 design doc + migration 编号连续 | changed 含架构/design doc |
| 架构级行为变化（层/flag/大重构） | `CLAUDE.md` / `docs/ROADMAP.md` / `docs/TODO.md` | changed 含对应文件 |

**核心不变量（S12 唯一有意义的判据）**：**改了 SDK 包源码却没改该包 CHANGELOG = gap（缺义务）**。这正是 `apc/12` 的正控/负控——缺 CHANGELOG 必须判缺，同步完整必须放行。

## Procedure

### 1. 派生 delta（真 git diff，不假设）

```bash
git diff --name-only > /tmp/delta.txt      # 或 <base>..<head>
```

把 changed 文件分类：`sdk pkg src / endpoint / schema-migration / docs / other`。分类是义务推导的输入。

### 2. 逐类推导义务 + 核 satisfied

对每一类命中，按义务表列一行 `{ obligation, requiredBecause, satisfied }`：

```bash
# 例：SDK 包改了没改 CHANGELOG？
# 找 delta 里的 sdk 包源码目录
rg '^sdk/([^/]+/[^/]+)/src/' /tmp/delta.txt -or '$1' | sort -u   # 改了哪些包
# 对每个包，看 CHANGELOG 在不在 changed 集里：
grep -q 'sdk/<pkg>/CHANGELOG.md' /tmp/delta.txt && echo "CHANGELOG ✓" || echo "CHANGELOG ✗ GAP"
```

`satisfied` 判据是**副作用**（该 doc 文件在 changed 集里 / 版本号真对齐），不是"我觉得应该改了"。

### 3. 跑机械门（叠加，非替代）

```bash
npx tsx scripts/apc-doc-sync.ts "$PRISMER_TASK_ID"; echo "gate exit=$?"
```

exit 1 = 改了 docs/sdk 但 diff 不提 taskId（可追溯性缺失）。机械门过 ≠ 义务全满——义务表的缺文件项要另判。

### 4. 汇总 gap + 上报

- **有 gap**（任一义务 unsatisfied）→ `--outcome failed`，列出缺哪些。
- **无 gap**（义务全满 + 机械门 0）→ `--outcome passed`。

```bash
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" --outcome failed \
  --note "gap: sdk/prismer-cloud/typescript/src changed but CHANGELOG not updated"
```

## 输出契约（机器判据按这个复算，别自由发挥格式）

本 skill 的验收判据不是「报告里出现了 changelog 这个词」，而是**判据自己从 delta 重新推导义务集和 gap 集，再跟你报的比对**（`structured-criteria.ts` 的 `doc-sync-obligations`），并且**把每个声明的 delta 文件读回磁盘**。所以报告必须带下面三类**可机器解析的行**：

```
DELTA: <path> | class: <sdk-package-source|endpoint-doc|schema-migration|other>
OBLIGATION: <doc path> | required-because: <理由，指回 delta 的哪一部分> | satisfied: yes|no
GAP: <doc path>
```

判据会判红的情况（任一）：

- 声明的 delta 与本次真实 diff **不等**（漏报 / 多报），或声明的文件**在磁盘上不存在**；
- 义务集与判据从 delta 重算的结果**不等**——**漏一条**（比如不提该包 CHANGELOG）跟**编一条**（delta 推不出来的义务）都判红；
- `satisfied` 与事实不符（**义务满足 ⟺ 该 doc 文件本身在 delta 里**）；
- `required-because` 空或过短（去空白 <20 字符）——「凭空清单」正是本 skill 要挡的；
- `GAP` 集与重算出的 unsatisfied 集**不等**（漏报 gap / 虚报 gap 都红）。

写 `GAP: <path>` 是**结构化断言**，不是修辞——判据只认这些行，不认 "❌"、"missing" 之类的措辞。

## 产出（副作用 oracle，报告里必须给）

1. **delta 分类**：`git diff --name-only` 的真实命中，按类归组。
2. **义务表**：每行 `{obligation, requiredBecause, satisfied}`——`requiredBecause` 指回 delta 的哪一部分。
3. **gap 列表**：required 但 unsatisfied 的义务。
4.（挂 task 时）**criterion 上报行** + 机械门退出码。

**两个承重 oracle**：
- **正控**：改了 SDK 包源码但**没改** CHANGELOG → **必须判 gap**（`--outcome failed`）。
- **负控**：文档全同步的改动（CHANGELOG/api doc 都改了）→ **必须放行**（`--outcome passed`），不虚报缺失。

**不许**：把义务当凭空清单列而不指回 delta；只跑机械门就宣称"文档已同步"（机械门挡不住缺文件）；断言聊天文本而非 changed-file 集/退出码。

## 诚实边界

- 本 skill 核的是**"该改的文档改了没"（存在性 + 可追溯性）**，**不核文档内容是否正确**——CHANGELOG 写了一行但内容是错的，机械门和义务表都放行。内容正确性靠人/评审兜。
- 义务表覆盖的是可从 `git diff --name-only` 机械推导的类别；"架构级行为变化"这类需要语义判断的义务，本 skill 只能提示"delta 涉及 X，考虑是否要更 CLAUDE.md/ROADMAP"，不能机械断定必须改——这一维标注为需人工确认，不硬判 gap。
- `apc-doc-sync.ts` 机械门只看 taskId 出现性，是可追溯性的下限，不是文档完整性的证明。

## PKF 双投影（研发回环 · doc07 §B2 写入点③）

**产出时机**：义务全满、SPEC/docs/CHANGELOG 的 **markdown 真源落 git 之后**，把同内容**投影成一张 PKF 记忆页**（pageType=`reference`）——markdown 真源仍是 git diff/review/grep 的工程权威，PKF 是补了 typed link 的**可召回投影**。投影必带 typed link（`derived-from`/`supports`/`contradicts`），否则投影没有增量、白写（doc07 §B1）。这一步是义务核对**之后**的投影，不改 delta 派生 / 义务核对 / 机械门任何一步。

**语法照 `pkf-writing` skill**——本 skill 不再内嵌语法骨架（frontmatter / typed link / 数据块写法都在那边）。写入面**不新造**：code agent 走 `prismer memory write`（SS-14 §4.3 appendix；hermes 侧是 native `memory_write`）。

**声明**（doc10 §2.5 格式，报告末尾一行）：

```
PKF: prismer://workspace/<ws>/memory/<path>
```

写入面不可达时如实声明 `PKF: none — 写入面不可达（<哪一条>）`，**绝不允许**为了满足规则而假装写了。

**回读**：声明后必须回读该页（`pkf_read` / memory read），确认**真实存在、正文非空**且与 git 真源同内容；typed link 的 `prismer://` 目标必须**真实存在**，无对应页就删该 link 行、宁缺勿造伪目标；**先 git 落地再投影**，不倒过来。写入自动挂 INDEX 反孤儿锚（SS-14 §4.2），优先 edit 既有投影页而非 dump 新叶（PLACE 治理照走）。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack doc-sync --task "$PRISMER_TASK_ID"
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

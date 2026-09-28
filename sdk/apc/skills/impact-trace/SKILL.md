---
name: impact-trace
description: For a change point (function / type / endpoint / SQL column), enumerate its real blast radius across six dimensions with a grep citation per row, then derive the regression test scope. Every impact-table row must trace to a real search hit — never a self-asserted claim.
license: MIT
scope: common
compatibility:
  - claude-code
  - prismer-sdk
allowed-tools:
  - Bash
metadata:
  category: analysis
---

# impact-trace

给定一个**改动点**（函数 / 类型 / endpoint / SQL 列），产出它的**真实影响面**（受影响的调用方 / 契约消费者 / 持久化写入 / 双 Prisma schema / daemon-SDK 镜像 / skill-role 引用）+ 由此推导的**回归测试范围**（`apc/05` §2 S2 · `apc/12` impact-trace 行）。

**什么时候用**：一个 bugfix / feature 改完，进 review 前需要知道"改这一处会波及哪些地方、要回归哪些层"；或评审要判断改动的 blast radius。

铁律：**影响表的每一行都必须有 grep/search 证据（path+line）**。凭记忆或推理写"这里应该会用到"是开卷考试——本 skill 的产出只认真实搜索命中。你自己不是 ground truth，`rg` 的命中集才是。

## 工具契约（签名以此为准，先核后用）

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `rg <pattern> [path] -n` | 主力搜索：直接调用方 / 契约消费者 / 引用点 | `-n` 出行号（证据必须带行号）；`-l` 只列文件；`-t ts` 限类型 |
| `rg -c <pattern>` | 命中计数（核对"没漏"用） | 计数对不上就是漏搜 |
| `cloud code grep <pattern> --repo <abs> [--glob '*.ts']` | 白名单 repo 内搜索，输出 JSON `[{path,line,snippet,sha256}]` | 仅 `PRISMER_WORKSPACE_ROOT` 或 `~/.prismer/agents/<id>/scratch` 内；出带 sha 的可引用片段。`--glob` 只支持 `*.ext` 形态 |

- `rg` 是本机主力；`cloud code grep` 用于要产出**可引用证据片段**（带 sha256）时。两者的命中集应当一致——不一致就查是不是路径白名单/glob 把一部分挡在外面了。
- **不要**用单文件 grep 命中当全貌（memory `feedback_grep_full_range_for_seq_audit`）。搜完要核计数：`rg -c` 的总数 == 影响表行数（去掉 N/A 维度），对不上就是漏了。

## 六维影响面（逐维搜，缺一维要么有证据要么写 N/A 理由）

改动点波及面按六维穷举。**任一维标 N/A 必须写理由**；**双 Prisma 维度永远不许静默省略**（`apc/12` 负控：缺双 Prisma 维且无 N/A 理由 → 校验拒绝）。

| # | 维度 | 怎么搜（示例） | 找什么 |
| --- | --- | --- | --- |
| 1 | **直接调用方** | `rg '\b<name>\b' -n -t ts` | 谁 import / 调用了这个符号 |
| 2 | **契约消费者**（API/wire） | `rg '<endpoint-path>\|<event-code>\|<rpc-name>' -n` | HTTP 路由消费者、SDK 类型、wire 帧的两端 |
| 3 | **持久化写入** | `rg '<column>\|<model>\.(create\|update\|upsert)' -n` | 谁写这张表/这个字段 |
| 4 | **双 Prisma schema** | `rg '<field>' prisma/schema.prisma prisma/schema.mysql.prisma -n` | SQLite + MySQL 两份 schema 是否都要改（**不许省**） |
| 5 | **daemon-SDK 镜像** | `rg '<name>' sdk/prismer-cloud/runtime/src -n` | cloud 侧改了，daemon/SDK 侧有没有对称的一份要跟着改 |
| 6 | **skill / role 引用** | `rg '<name>' sdk/prismer-cloud/built-in-skills sdk/apc/skills -n` | SKILL.md / role template / prompt 里有没有引用它 |

## Procedure

### 1. 锚定改动点

明确改动点的**精确标识**（符号名 / endpoint 路径 / 列名）。一个改动可能有多个改动点——逐个搜，别只搜一个。

### 2. 逐维搜索，收集带行号的命中

```bash
# 维度 1：直接调用方（示例，把 <name> 换成真符号）
rg '\b<name>\b' -n -t ts > /tmp/impact-callers.txt
rg -c '\b<name>\b' -t ts    # 核对命中计数

# 维度 4：双 Prisma（两份 schema 都要看）
rg '<field>' prisma/schema.prisma prisma/schema.mysql.prisma -n
```

对每一维，把命中记成影响表的一行：`{ path, line, dimension, contract, risk }`。**没有命中的维度**：确认真的没有（不是搜错 pattern），然后写 `N/A + 理由`。

### 3. 组装影响表（副作用产出 1）

| path:line | 维度 | 契约 | 风险 | 回归 |
| --- | --- | --- | --- | --- |
| `src/foo.ts:42` | 直接调用方 | 传参 shape | 改签名会破 | T0 |

**每行必须能回指一条 `rg`/`cloud code grep` 命中**。行数（不含 N/A 维）应等于去重后的真实命中数——自查：`影响表行数 == Σ rg -c`。

### 4. 推导回归测试范围（副作用产出 2）

按影响表命中的**文件所在层**映射到 tier（对齐 test-runner 选层规则）：

| 命中落在 | 回归 tier |
| --- | --- |
| `src/lib/**` | T0 |
| `src/im/**` / endpoint | T1 |
| `src/app/**` | T2 |
| e2e / 跨端 | T3 |
| daemon `runtime/src/**` | daemon 测试（runtime vitest） |

产出："本改动需回归 {tiers}，因为影响面落在 {层}"。

### 5.（可选）上报 criterion

若本 impact-trace 挂在一个 task 的 acceptance criterion 上，把结论上报：

```bash
cloud task verify-criterion "$PRISMER_TASK_ID" "<criterion-id>" --outcome passed \
  --note "impact table: N rows, all grep-cited; regression scope: T0,T1"
```

`--outcome` 合法值恰好四个：`passed | failed | n/a | waived`。

## 输出契约（机器判据按这个复验，别自由发挥格式）

本 skill 的验收判据不是「报告里出现了某些词」，而是**把报告里的声明拿回文件系统复核**（`structured-criteria.ts` 的 `cited-evidence` / `dimension-coverage`）。所以报告必须带下面三样**可机器解析**的东西——形状对但内容假的报告会被当场判红。

**① 改动点声明**（一行，锚点必须是本次真实改动点，且会被复核确实存在于该文件）：

```
CHANGE-POINT: <symbol> @ <path>
```

**② 影响表**（markdown 表，首列是 `path:line`）：判据会**逐行把 `path:line` 读回磁盘**——文件不存在 / 行号越界 / 该行是空行，任意一条就判红；并且至少 3 条引用所在的**那一行必须真的含改动点符号**（"真实存在的行" ≠ "真实的搜索命中"），**且这些命中要落在 ≥3 个不同文件里**——把一条真命中抄满整张表是"单命中报告"，不是影响面（实证：一条真 `path:line` 复制 12 遍，加固前 5/5 全绿）。

```
| path:line | 维度 | 契约 | 风险 | 回归 |
| --- | --- | --- | --- | --- |
| src/foo.ts:42 | direct-callers | 传参 shape | 改签名会破 | T0 |
```

**③ 六维逐行作答**（每维**独占一行 + 固定 key**）。判据找的是**这一行**，报告别处出现同一个词（比如正文里出现 `npm run prisma:generate`）**不算答过**——这正是旧判据 `match:"prisma"` 被证伪的地方：

```
- [1] direct-callers: <path:line>
- [2] contract-consumers: <path:line>
- [3] persistence-writers: <path:line> | N/A — <理由 ≥20 字符>
- [4] dual-prisma: <path:line> | N/A — <理由 ≥20 字符>
- [5] daemon-sdk-mirror: <path:line>
- [6] skill-role-references: <path:line> | N/A — <理由 ≥20 字符>
```

**N/A 必须带理由**（去空白后 ≥20 字符）；只写 `N/A` 判红。**行号照抄 `rg -n` 的真实输出，不许凭印象写。**
**每一维要有自己的证据**：同一条 `path:line` 最多给 2 个维度当证据，第 3 个维度再引它就判红（N/A 维不受影响，它本来就没有引用）。

## 产出（副作用 oracle，报告里必须给）

1. **影响表**：每行 `{path:line, 维度, 契约, 风险}` + 找到它的那条搜索。**行的真实性 = grep 命中**，不是叙述。
2. **六维覆盖**：六维全答；N/A 维带理由（双 Prisma 维不许静默省）。
3. **回归范围**：由影响表的层映射推出的 tier 集。
4.（若有 task）**criterion 上报行**：`cloud task verify-criterion` 落库 outcome，可回读 acceptance view 确认。

**不许**：把没有搜索命中的行写进影响表；漏搜一个真实调用方（`rg -c` 计数不核）；把双 Prisma 维度静默省掉；断言聊天文本而非 path:line 证据。

## 诚实边界

- `rg` 命中集是"文本匹配"的 ground truth，不是"语义调用图"——动态派发 / 字符串拼出来的引用 / 反射，文本搜不到。影响表覆盖的是**可被文本搜索命中的**引用面；无法静态搜到的动态引用要显式标注为已知盲区，不得声称"影响面已穷举"。
- 回归范围是"应当回归哪些层"的推导，**不代替真跑**——真跑归 test-runner skill。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack impact-trace --task "$PRISMER_TASK_ID"
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
